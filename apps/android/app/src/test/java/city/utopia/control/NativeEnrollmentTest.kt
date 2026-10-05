package city.utopia.control

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativeEnrollmentTest {
 @Test fun `new identities follow canonical server contracts`() {
  assertTrue(newNativeIdentity("dev-").matches(Regex("dev-[a-f0-9]{32}")))
  assertTrue(newNativeIdentity("inst-").matches(Regex("inst-[a-f0-9]{32}")))
 }
 private fun reply() = JSONObject("""{"cityId":"city-a","credential":"sess:first","enrollment":{"installationId":"install-a","instanceId":"instance-a","deviceId":"device-a","credentialId":"key-a","credentialSecret":"private-test-secret","displayName":"Phone A"}}""")
 @Test fun `approval reply requires durable enrollment and member session`() {
  val record = parseNativeEnrollment(reply(), "city-a", "instance-a")
  assertEquals("install-a", record.installationId)
  assertEquals("sess:first", record.sessionCredential)
  assertEquals("private-test-secret", record.sessionBody().getString("credentialSecret"))
  assertEquals("instance-a", record.sessionBody().getString("instanceId"))
  assertFalse(record.installationPayload().has("credentialSecret"))
  assertTrue(runCatching { parseNativeEnrollment(reply().put("credential", "owner-token"), "city-a", "instance-a") }.isFailure)
  assertTrue(runCatching { parseNativeEnrollment(reply().remove("enrollment").let { JSONObject().put("cityId","city-a").put("credential","sess:x") }, "city-a", "instance-a") }.isFailure)
 }
 @Test fun `foreign identities and incomplete secrets cannot be persisted`() {
  assertTrue(runCatching { parseNativeEnrollment(reply(), "city-b", "instance-a") }.isFailure)
  assertTrue(runCatching { parseNativeEnrollment(reply(), "city-a", "instance-b") }.isFailure)
  val broken=reply(); broken.getJSONObject("enrollment").put("credentialSecret", JSONObject.NULL)
  assertTrue(runCatching { parseNativeEnrollment(broken, "city-a", "instance-a") }.isFailure)
 }
 @Test fun `direct exchange uses enrolled session instead of legacy owner credential`() {
  val direct=reply().put("credential","legacy-owner")
  direct.getJSONObject("enrollment").put("session",JSONObject().put("credential","sess:direct"))
  assertEquals("sess:direct",parseNativeEnrollment(direct,"city-a","instance-a").sessionCredential)
 }
 @Test fun `secure destination stays secure and invalid URL parts are refused`() {
  val target = RelayDial.target("https://example.test:443")!!
  assertTrue(target.secure)
  assertEquals("https://example.test:443", target.origin)
  assertTrue(RelayDial.socketUrl(target.host,target.port,target.secure).startsWith("wss://"))
  assertTrue(RelayDial.target("wss://example.test")!!.secure)
  assertNull(RelayDial.target("https://user:pass@example.test"))
  assertNull(RelayDial.target("https://example.test/path"))
  assertNull(RelayDial.target("https://example.test?token=x"))
  assertEquals("https://example.test:443", endpoint("https://example.test:443"))
 }
 @Test fun `approval needs a name and address but no unused code`() {
  assertTrue(joinInputReady(true,"https://example.test","","My phone",false))
  assertFalse(joinInputReady(false,"http://example.test","","My phone",false))
  assertTrue(joinInputReady(false,"http://example.test","123456","My phone",false))
  assertFalse(joinInputReady(true,"http://example.test",""," ",false))
  assertFalse(joinInputReady(true,"http://example.test","","My phone",true))
 }
}
