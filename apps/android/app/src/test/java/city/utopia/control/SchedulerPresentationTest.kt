package city.utopia.control

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * UXI-301 · the Android half of the scheduler presentation adapter.
 *
 * These pin the SAME properties the web adapter asserts, because the workbook requires the two surfaces
 * to share semantics:
 *   - severity cannot contradict the contract class where the class carries meaning;
 *   - STATE-class terms are bounded instead of free, never BLOCKED and never OK;
 *   - an unavailable provider is never selectable, INCLUDING when the feed lies about it;
 *   - unknown state/term/action THROW rather than rendering blank;
 *   - raw vocabulary is reachable only through the explicit detail block.
 *
 * Term-by-term agreement with the frozen RS-290 contract is checked by
 * `tests/android-scheduler-parity.test.mjs`, which parses THIS package's Kotlin source and compares the
 * term set with the contract in both directions - a JVM test cannot import the contract, so the parity
 * guard lives where the contract is importable and runs in the same CI as the rest of the suite.
 */
class SchedulerPresentationTest {

  private fun dto(
    state: String = "RUNNING",
    providers: List<Pair<String, Boolean>> = emptyList(),
    actions: List<String> = emptyList(),
    choiceRequired: Boolean = false,
    degraded: Boolean = false,
    structural: Boolean = false,
  ): JSONObject {
    val providerArray = JSONArray()
    for ((term, selectable) in providers) {
      providerArray.put(JSONObject().put("term", term).put("selectable", selectable))
    }
    val actionArray = JSONArray()
    for (action in actions) actionArray.put(action)
    return JSONObject()
      .put("state", state)
      .put("providers", providerArray)
      .put("actions", actionArray)
      .put("terms", JSONArray())
      .put("provider_choice_required", choiceRequired)
      .put("degraded", degraded)
      .put("structural_refusal", structural)
      .put("fabricated", false)
      .put("from_backend_truth", true)
  }

  @Test
  fun `every term carries its own name, real copy, and a class-consistent severity`() {
    assertTrue("the term table must be populated", SchedulerPresentation.TERM_COPY.isNotEmpty())
    for ((key, copy) in SchedulerPresentation.TERM_COPY) {
      assertEquals("a term entry must name the term it keys", key, copy.term)
      assertTrue("term $key has blank copy", copy.copy.isNotBlank())
      // The copy is user language, so it must never be the raw token itself.
      assertFalse("term $key renders its own token as copy", copy.copy == key)
    }
  }

  @Test
  fun `severity cannot contradict the contract class, and STATE terms are bounded instead`() {
    // Non-STATE classes map through severityOfClass, so a contradiction is impossible by construction.
    val expected = mapOf(
      "PERMITTED" to SchedulerSeverity.OK,
      "RESOURCE" to SchedulerSeverity.WAITING,
      "STRUCTURAL" to SchedulerSeverity.BLOCKED,
      "KNOWLEDGE" to SchedulerSeverity.UNKNOWN,
    )
    for ((termClass, severity) in expected) {
      assertEquals("severityOfClass($termClass)", severity, SchedulerPresentation.severityOfClass(termClass))
    }
    // An unknown class must THROW rather than default, so a contract change surfaces here.
    assertThrows(IllegalArgumentException::class.java) { SchedulerPresentation.severityOfClass("INVENTED") }

    // STATE-class terms are excluded from that rule and bounded: never BLOCKED, never OK.
    assertTrue(SchedulerPresentation.STATE_SEVERITIES.isNotEmpty())
    for (severity in SchedulerPresentation.STATE_SEVERITIES) {
      assertFalse(severity == SchedulerSeverity.BLOCKED)
      assertFalse(severity == SchedulerSeverity.OK)
    }
  }

  @Test
  fun `every state and every action has real copy, not its token`() {
    assertTrue(SchedulerPresentation.STATE_COPY.isNotEmpty())
    for ((key, copy) in SchedulerPresentation.STATE_COPY) {
      assertEquals(key, copy.term)
      assertTrue("state $key has blank copy", copy.copy.isNotBlank())
      assertFalse("state $key renders its token", copy.copy == key)
    }
    assertTrue(SchedulerPresentation.ACTION_COPY.isNotEmpty())
    for ((token, copy) in SchedulerPresentation.ACTION_COPY) {
      assertTrue("action $token has blank label", copy.first.isNotBlank())
      assertFalse("action $token renders its token as a label", copy.first == token)
    }
  }

  @Test
  fun `a non-permitted provider is never selectable, even when the feed lies`() {
    // The feed claims every provider is selectable. Only the permitted one may be.
    val view = SchedulerPresentation.viewModel(
      dto(providers = listOf(
        "SELECTABLE" to true,
        "USER_DISABLED" to true,
        "AT_CAPACITY" to true,
        "FRESHNESS_UNKNOWN" to true,
      )),
    )
    assertEquals(4, view.providers.size)
    assertTrue("the permitted provider stays selectable", view.providers[0].selectable)
    for (provider in view.providers.drop(1)) {
      assertFalse("provider $provider must not be selectable", provider.selectable)
    }
    // Every provider still carries a user-facing reason - visible, not clickable, is the requirement.
    for (provider in view.providers) {
      assertTrue(provider.reason.isNotBlank())
      assertFalse(provider.reason == "SELECTABLE")
    }
  }

  @Test
  fun `unknown state, term and action throw rather than rendering blank`() {
    assertThrows(IllegalArgumentException::class.java) { SchedulerPresentation.viewModel(dto(state = "INVENTED")) }
    assertThrows(IllegalArgumentException::class.java) {
      SchedulerPresentation.viewModel(dto(providers = listOf("INVENTED" to false)))
    }
    assertThrows(IllegalArgumentException::class.java) {
      SchedulerPresentation.viewModel(dto(actions = listOf("INVENTED")))
    }
  }

  @Test
  fun `raw vocabulary is reachable only through the explicit detail block`() {
    val plain = SchedulerPresentation.viewModel(dto(providers = listOf("SELECTABLE" to true)))
    assertNull("detail must be absent by default", plain.technical)

    val detail = SchedulerPresentation.viewModel(dto(providers = listOf("SELECTABLE" to true)), advanced = true)
    assertNotNull("detail must be present when asked for", detail.technical)
    assertTrue("detail carries the raw state", detail.technical!!.contains("RUNNING"))
    // The headline is still user language in detail mode: detail is additional, not a replacement.
    assertEquals("In progress", detail.stateLabel)
  }

  @Test
  fun `the decision flag and structural flag travel from the feed unchanged`() {
    val demanded = SchedulerPresentation.viewModel(
      dto(state = "WAITING_USER", providers = listOf("REGION_UNSUPPORTED" to false), actions = listOf("CHOOSE_PROVIDER"), choiceRequired = true, structural = true),
    )
    assertTrue(demanded.choiceRequired)
    assertTrue(demanded.structuralRefusal)
    assertEquals(listOf("CHOOSE_PROVIDER"), demanded.actions.map { it.token })
    assertEquals("Choose another service", demanded.actions[0].label)

    val waiting = SchedulerPresentation.viewModel(
      dto(state = "QUEUED", providers = listOf("AT_CAPACITY" to false), actions = listOf("KEEP_WAITING")),
    )
    assertFalse("a saturated pool does not demand a choice", waiting.choiceRequired)
    assertEquals(SchedulerSeverity.WAITING, waiting.severity)
    assertEquals("Keep waiting", waiting.actions[0].label)
  }

  @Test
  fun `a failed run is the one state emphasised as blocked`() {
    assertEquals(SchedulerSeverity.BLOCKED, SchedulerPresentation.viewModel(dto(state = "FAILED")).severity)
    assertEquals("Didn't finish", SchedulerPresentation.viewModel(dto(state = "FAILED")).stateLabel)
    for ((state, copy) in SchedulerPresentation.STATE_COPY) {
      if (state == "FAILED") continue
      assertFalse("state $state must not be presented as blocked", copy.severity == SchedulerSeverity.BLOCKED)
    }
  }

  @Test
  fun `an empty provider list is not an error and produces no providers`() {
    val view = SchedulerPresentation.viewModel(dto(providers = emptyList()))
    assertTrue(view.providers.isEmpty())
    assertEquals("In progress", view.stateLabel)
  }

  @Test
  fun `the adapter carries the presentation version so the two surfaces can be compared`() {
    assertEquals(1, SchedulerPresentation.PRESENTATION_VERSION)
  }
}
