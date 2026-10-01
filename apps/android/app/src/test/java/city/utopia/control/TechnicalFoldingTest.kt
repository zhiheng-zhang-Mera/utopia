package city.utopia.control

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * UI-102 · "folded, not deleted" as a test rather than a code-reading claim.
 *
 * The hard rule is that internal identifiers leave the default reading path but stay
 * reachable. The reading path half is a property of one shared component
 * (`TechnicalDetails`, collapsed by default); the reachability half is the data these
 * builders produce, and THAT is what this test pins. If someone later "tidies" a screen
 * by dropping a field instead of folding it, these assertions fail.
 *
 * Why a JVM test and not a Compose UI test: `ui-test-junit4` and `androidx.test` are not
 * present in this machine's offline Gradle cache, so an `androidTest` cannot be built or
 * run here. This is the strongest instrument available offline, and the limitation is
 * recorded in the UI-102 report rather than glossed over.
 */
class TechnicalFoldingTest {

  private fun summary() = ActionSummary(
    actionId = "act-77c1",
    requestedIntent = "hash a file",
    route = "ROOM",
    targetLabel = "Hash Room",
    status = "FAILED",
    statusLabel = "Failed",
    progress = 100,
    resultText = "",
    errorCode = "FILE_NOT_FOUND",
  )

  private fun fullDetail() = ActionDetail(
    summary = summary(),
    actionId = "act-77c1",
    backendRef = BackendRef(kind = "ROOM", id = "hash", roomId = "hash", operationId = "hash.hash-file"),
    target = ActionTarget(id = "hash", label = "Hash Room", operation = "hash.hash-file"),
    resultRef = ActionResultRef(kind = "ROOM_RESULT", id = "res-1", digest = "sha256:6a1f", summary = "computed"),
    error = ActionError(code = "FILE_NOT_FOUND", message = "no such file"),
    provenance = ActionProvenance(
      source = "gateway",
      host = "Alien-PC",
      roomId = "hash",
      capabilityId = null,
      taskId = "tsk-9c41",
      invocationId = "inv-2f10",
      history = listOf(ActionHistoryEntry(at = "2026-10-01T00:00:00Z", status = "FAILED", note = "refused")),
    ),
    createdAt = "2026-10-01T00:00:00Z",
    updatedAt = "2026-10-01T00:01:00Z",
  )

  /** Sparse on purpose: the folding must not invent values, nor drop the ones present. */
  private fun sparseDetail() = ActionDetail(
    summary = summary(),
    actionId = "act-77c1",
    backendRef = null,
    target = null,
    resultRef = null,
    error = null,
    provenance = null,
    createdAt = "",
    updatedAt = "",
  )

  @Test
  fun `a fully populated action keeps every internal value reachable`() {
    val rows = actionTechnicalRows(fullDetail()).toMap()
    val expected = listOf(
      "actionId", "status", "route", "progress",
      "targetId", "operation",
      "backendRef.kind", "backendRef.id", "backendRef.roomId", "backendRef.operationId",
      "resultRef.kind", "resultRef.id", "resultRef.digest",
      "error.code", "error.message",
      "provenance.source", "provenance.host", "provenance.roomId",
      "provenance.capabilityId", "provenance.taskId", "provenance.invocationId",
      "history[0]",
      "createdAt", "updatedAt",
    )
    for (key in expected) {
      assertTrue("folded rows dropped the internal value '$key'", rows.containsKey(key))
    }
    assertEquals("act-77c1", rows["actionId"])
    assertEquals("sha256:6a1f", rows["resultRef.digest"])
    assertEquals("inv-2f10", rows["provenance.invocationId"])
    assertEquals("100%", rows["progress"])
  }

  @Test
  fun `a sparse action still folds its identifiers and states what is missing`() {
    val rows = actionTechnicalRows(sparseDetail()).toMap()
    assertEquals("act-77c1", rows["actionId"])
    assertEquals("ROOM", rows["route"])
    // absent optional blocks contribute nothing rather than fabricated placeholders
    assertTrue(!rows.containsKey("backendRef.id"))
    assertTrue(!rows.containsKey("provenance.taskId"))
    // but the record still says the timestamps were unavailable
    assertEquals("Unavailable", rows["createdAt"])
    assertEquals("Unavailable", rows["updatedAt"])
  }

  @Test
  fun `the gateway's own status label wins over the local fallback`() {
    // UI-102 truth-parity: Web renders the gateway's label. If Android re-derived its own,
    // the two surfaces could disagree about the same gateway truth.
    val fromGateway = parseActionSummary(
      org.json.JSONObject().put("actionId", "act-1").put("status", "FAILED").put("statusLabel", "Failed — gateway wording"),
    )
    assertEquals("Failed — gateway wording", fromGateway.statusLabel)

    val fromAsk = parseAskResult(
      org.json.JSONObject().put("status", ASK_AMBIGUOUS).put("statusLabel", "请选择目标"),
    )
    assertEquals("请选择目标", fromAsk.statusLabel)

    // and the local mapping still covers a status the gateway labelled nothing for
    val unlabelled = parseActionSummary(org.json.JSONObject().put("actionId", "act-2").put("status", "REFUSED"))
    assertEquals("REFUSED · not allowed by policy", unlabelled.statusLabel)
  }

  @Test
  fun `the list row folds its own identifiers`() {
    val rows = actionSummaryTechnicalRows(summary()).toMap()
    assertEquals("act-77c1", rows["actionId"])
    assertEquals("ROOM", rows["route"])
    assertEquals("Hash Room", rows["target"])
    assertEquals("100%", rows["progress"])
  }

  @Test
  fun `an ask result folds its routing facts`() {
    val answer = AskResult(
      text = "search for utopia",
      status = ASK_AMBIGUOUS,
      statusLabel = "请选择目标",
      route = "ROOM",
      target = "knowledge",
      operation = "knowledge.search",
      candidates = emptyList(),
      confirmation = null,
      action = null,
      message = "",
      router = "deterministic",
      routerLabel = "Routed by deterministic rules",
      deterministic = true,
      llm = false,
    )
    val rows = askTechnicalRows(answer).toMap()
    assertEquals(ASK_AMBIGUOUS, rows["status"])
    assertEquals("deterministic", rows["router"])
    assertEquals("Routed by deterministic rules", rows["routerLabel"])
    assertEquals("ROOM", rows["route"])
    assertEquals("knowledge", rows["target"])
    assertEquals("knowledge.search", rows["operation"])
  }

  @Test
  fun `a selectable target folds its coordinates including availability`() {
    val candidate = TargetOption(
      route = "CITY_TASK",
      target = "city.task",
      operation = "CHECKPOINT_DEMO",
      label = "City task — CHECKPOINT_DEMO",
      description = "",
      mutating = false,
      sideEffect = true,
      available = true,
      unavailableReason = null,
      example = "run a safe task of type CHECKPOINT_DEMO",
    )
    val rows = targetTechnicalRows(candidate).toMap()
    assertEquals("CITY_TASK", rows["route"])
    assertEquals("city.task", rows["target"])
    assertEquals("CHECKPOINT_DEMO", rows["operation"])
    assertEquals("true", rows["available"])
    assertEquals("run a safe task of type CHECKPOINT_DEMO", rows["example"])
  }
}
