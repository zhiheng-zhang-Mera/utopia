package city.utopia.control

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * JOIN-590 · regression guard for the identity-reading defect this task shipped and then fixed.
 *
 * THE DEFECT: `JSONObject.optString("cityId")` on a value that is JSON `null` returns the four-character string
 * `"null"`, not `""`. The first relay-join implementation used `optString(...).takeIf { it.isNotEmpty() }`, so a
 * City whose join record legitimately reported `cityId: null` was adopted as the identity `"null"`, and the device
 * then refused its OWN City with `City identity conflict` — the check working correctly against a value this client
 * had corrupted. Measured on the physical device, then reproduced over the relay with the same wire shape.
 *
 * The guard is a unit test because the rule is pure: absence must stay absent, whatever JSON spells it as.
 */
class RelayPairingIdentityTest {

  @Test
  fun `a JSON null is absent, never the text null`() {
    val payload = JSONObject().put("cityId", JSONObject.NULL).put("credential", "sess:abc")
    assertNull("JSON null must read as absent", RelayPairing.declaredText(payload, "cityId"))
  }

  @Test
  fun `a missing field is absent and an empty string is absent`() {
    assertNull(RelayPairing.declaredText(JSONObject(), "cityId"))
    assertNull(RelayPairing.declaredText(JSONObject().put("cityId", ""), "cityId"))
    assertNull(RelayPairing.declaredText(null, "cityId"))
  }

  @Test
  fun `a real identity is returned unchanged`() {
    val cityId = "031fdba6-e94c-4298-a095-6ff04a65481d"
    assertEquals(cityId, RelayPairing.declaredText(JSONObject().put("cityId", cityId), "cityId"))
    assertEquals("sess:abc", RelayPairing.declaredText(JSONObject().put("credential", "sess:abc"), "credential"))
  }

  @Test
  fun `the literal text null from a string payload is not treated as absent`() {
    // A string that HAPPENS to be "null" is still a string. Refusing to guess here is the point: the rule is about
    // the JSON type, not about the letters, so a caller cannot be silently rescued from a wrong write.
    assertEquals("null", RelayPairing.declaredText(JSONObject().put("cityId", "null"), "cityId"))
  }

  @Test
  fun `a claim is long, unique and hex`() {
    val first = RelayPairing.newClaim()
    val second = RelayPairing.newClaim()
    assertEquals(36, first.length)
    assertEquals(true, first.matches(Regex("[0-9a-f]{36}")))
    assertEquals("two claims must not collide", false, first == second)
  }
}
