package city.utopia.control

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class OwnerOnboardingTest {
 private val now=Instant.parse("2026-10-05T00:00:00Z")
 private fun material():JSONObject {
  val params="v=1&host=http%3A%2F%2F127.0.0.1%3A4391&city=city-a&session=session-a&expires=2026-10-05T00%3A05%3A00Z&secret=temporary-secret"
  return JSONObject().put("pairingSessionId","session-a").put("shortCode","123456").put("expiresAt","2026-10-05T00:05:00Z").put("qrPayload","utopia://pair?$params").put("inviteUrl","http://127.0.0.1:4391/?pair="+java.net.URLEncoder.encode(params,"UTF-8"))
 }
 private fun info(state:String,session:String?=null)=JSONObject().put("sessionState",state).put("activeSession",state=="ACTIVE").put("descriptor",JSONObject().put("cityId","city-a").put("pairingSessionId",session ?: JSONObject.NULL).put("endpoint",JSONObject().put("scheme","http").put("host","127.0.0.1").put("port",4391)))
 @Test fun unknownDoesNotGenerateAndActiveNeverRotates() {
  val state=OwnerPairingLifecycle("city-a","http://127.0.0.1:4391")
  assertNull(state.beginGenerate(now))
  state.reconcile(info("IDLE"),now)
  assertEquals("IDLE",state.beginGenerate(now))
  assertNull(state.beginGenerate(now))
  state.generated(material(),now)
  assertEquals("123456",state.visibleMaterial(now)?.shortCode)
  state.reconcile(info("ACTIVE","session-a"),now)
  assertNull(state.beginGenerate(now))
  assertEquals("session-a",state.visibleMaterial(now)?.sessionId)
  state.reconcile(info("USED"),now)
  assertNull(state.visibleMaterial(now))
  assertEquals("USED",state.beginGenerate(now))
 }
 @Test fun restoreNeedsCanonicalMatchAndExpiresWithoutRotation() {
  val state=OwnerPairingLifecycle("city-a","http://127.0.0.1:4391")
  state.restore(material(),now)
  assertNull(state.visibleMaterial(now))
  state.reconcile(info("ACTIVE","session-a"),now)
  assertNotNull(state.visibleMaterial(now))
  assertNull(state.visibleMaterial(now.plusSeconds(301)))
  assertNull(state.beginGenerate(now.plusSeconds(301)))
  state.reconcile(info("EXPIRED"),now.plusSeconds(301))
  assertEquals("EXPIRED",state.beginGenerate(now.plusSeconds(301)))
 }
 @Test fun rejectsCityEndpointLinkAndReplacementMismatch() {
  val state=OwnerPairingLifecycle("city-a","http://127.0.0.1:4391")
  assertThrows(IllegalArgumentException::class.java) { OwnerPairingMaterial.parse(material().put("inviteUrl","http://evil.invalid/?pair=wrong"),"city-a","http://127.0.0.1:4391",now) }
  assertThrows(IllegalArgumentException::class.java) { OwnerPairingMaterial.parse(material(),"city-b","http://127.0.0.1:4391",now) }
  state.restore(material(),now)
  state.reconcile(info("ACTIVE","other-session"),now)
  assertNull(state.visibleMaterial(now))
  assertThrows(IllegalArgumentException::class.java) { state.reconcile(info("ACTIVE","session-a").apply {getJSONObject("descriptor").put("cityId","wrong-city")},now) }
 }
 @Test fun shareRejectsUnexpectedSecretBearingFields() {
  val unsafe=material()
  unsafe.put("qrPayload",unsafe.getString("qrPayload")+"&credential=must-not-share")
  assertThrows(IllegalArgumentException::class.java) { OwnerPairingMaterial.parse(unsafe,"city-a","http://127.0.0.1:4391",now) }
 }
}
