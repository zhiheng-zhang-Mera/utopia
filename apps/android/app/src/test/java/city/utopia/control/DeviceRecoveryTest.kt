package city.utopia.control
import org.junit.Test
import org.junit.Assert.*
import org.json.JSONObject
class DeviceRecoveryTest {
 @Test fun ownerGuidanceAndUnboundAreActionable() {
  val state=parseRecoveryState(JSONObject("""{"scope":"CITY","installations":[{"installationId":"ins-a","state":"UNBOUND","rebindRequired":true}],"cloneFindings":[]}"""))
  assertTrue(state.needsRecovery); assertTrue(state.owner); assertEquals(1,state.installations.size)
  assertTrue(recoveryMessage(state).contains("owner",ignoreCase=true))
 }
 @Test fun memberScopeDoesNotBecomeOwner() {
  val state=parseRecoveryState(JSONObject("""{"scope":"OWN_INSTALLATION","installations":[{"installationId":"mine","state":"BOUND"}],"cloneFindings":[]}"""))
  assertFalse(state.owner); assertFalse(state.needsRecovery)
  assertTrue(recoveryMessage(state).contains("owner",ignoreCase=true))
 }
 @Test fun conflictAndRefusalRemainVisible() {
  val clone=parseRecoveryState(JSONObject("""{"scope":"CITY","installations":[],"cloneFindings":[{"reason":"REUSED_CREDENTIAL","credentialFingerprint":"must-not-display"}]}"""))
  assertEquals(listOf("REUSED_CREDENTIAL"),clone.cloneReasons)
  assertFalse(recoveryMessage(clone).contains("must-not-display"))
  val refused=parseRecoveryState(JSONObject("""{"errorCode":"INSTALLATION_UNBOUND","error":"Recovery needed"}"""))
  assertTrue(refused.needsRecovery); assertTrue(recoveryMessage(refused).contains("owner",ignoreCase=true))
 }
 @Test fun ownerWebLinkNeverSharesCredentialsOrUnsafeUrls() {
  assertEquals("https://city.example:443/#page=Settings",ownerSettingsUrl("https://city.example:443"))
  assertEquals("http://192.168.1.2:4391/#page=Settings",ownerSettingsUrl("http://192.168.1.2:4391/"))
  for(url in listOf("javascript:alert(1)","http://owner:secret@host","http://host/?token=secret","http://host/#session=secret","http://host/path","http://host:99999"))assertNull(url,ownerSettingsUrl(url))
 }
}
