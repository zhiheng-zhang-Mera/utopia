package city.utopia.control

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MemberManagementTest {
 private fun snapshot(enrolled:Boolean=true):JSONObject=JSONObject("""{"cityId":"city-a","displayName":"City A","hostDeviceId":"host-a","currentMemberRef":"member-b","enrolledDevice":null,"members":[{"deviceId":"host-a","displayName":"Same name","role":"PRIMARY","nodeId":"host-a","online":true,"computeOnline":true,"sharingEnabled":true},{"deviceId":"member-b","displayName":"Same name","role":"MEMBER","nodeId":"member-b","online":true,"computeOnline":false,"sharingEnabled":false},{"deviceId":"control-c","displayName":"Tablet","role":"CONTROL_ONLY"}]}""").apply { if(enrolled)put("enrolledDevice",JSONObject().put("installationId","install-b").put("deviceId","member-b")) }
 private fun scope(own:Boolean=true)=JSONObject().put("cityId","city-a").put("scope",if(own)"OWN_INSTALLATION" else "CITY").put("installations",org.json.JSONArray().put(JSONObject().put("installationId","install-b").put("deviceId","member-b").put("displayName","Same name").put("state","BOUND").put("credentialSecret","must-not-project").put("credentialFingerprint","must-not-project")))
 @Test fun sessionSelfPinnedAndAuthorityNotInferredFromNames() {
  val view=MemberManagementProjection.from(snapshot(),scope())
  assertEquals(ManagementScope.SESSION,view.scope)
  assertEquals("member-b",view.members.first().deviceId)
  assertEquals("member-b",view.localDeviceRef)
  assertFalse(view.canRename)
  assertTrue(view.canRevoke("install-b"))
  assertFalse(view.canRevoke("install-other"))
  assertTrue(view.canToggleSharing(view.members.first()))
  assertFalse(view.canToggleSharing(view.members.first { it.deviceId=="host-a" }))
  assertFalse(view.installations.toString().contains("must-not-project"))
 }
 @Test fun ownerActorIsCityHostWithoutClaimingPhysicalPhoneIdentity() {
  val view=MemberManagementProjection.from(snapshot(false),scope(false))
  assertEquals(ManagementScope.OWNER,view.scope)
  assertEquals("host-a",view.actorRef)
  assertNull(view.localDeviceRef)
  assertTrue(view.canRename)
  val tablet=view.members.first { it.deviceId=="control-c" }
  assertNull(tablet.online)
  assertNull(tablet.computeOnline)
  assertNull(tablet.sharingEnabled)
  assertFalse(view.canToggleSharing(tablet))
 }
 @Test fun mismatchedOrUnknownScopeNeverInventsOwnerAuthority() {
  val view=MemberManagementProjection.from(snapshot(),scope(false))
  assertEquals(ManagementScope.UNKNOWN,view.scope)
  assertFalse(view.canRename)
  assertFalse(view.canRevoke("install-b"))
  assertNull(view.actorRef)
  assertEquals(ManagementScope.UNKNOWN,MemberManagementProjection.from(snapshot(false),JSONObject()).scope)
 }
 @Test fun receiptOnlyForCanonicalRecipientAndPendingMessage() {
  val own=MemberManagementProjection.from(snapshot(),scope())
  val message=MemberMessage.from(JSONObject("""{"id":"msg-a","senderDeviceId":"host-a","targetDeviceId":"member-b","text":"hello","state":"PENDING"}"""))
  assertTrue(own.canReceipt(message))
  assertFalse(own.canReceipt(message.copy(targetDeviceId="control-c")))
  assertFalse(own.canReceipt(message.copy(state="RECEIVED")))
 }
 @Test fun otherCityAndMalformedEnrollmentCannotAuthorizeOwner() {
  assertEquals(ManagementScope.UNKNOWN,MemberManagementProjection.from(snapshot(false),scope(false).put("cityId","city-other")).scope)
  assertEquals(ManagementScope.UNKNOWN,MemberManagementProjection.from(snapshot(false).put("enrolledDevice","malformed"),scope(false)).scope)
 }
 @Test fun malformedPopulationCannotLookLikeEmptyHealthyList() {
  assertEquals(ManagementScope.UNKNOWN,MemberManagementProjection.from(snapshot(false),scope(false).put("installations",org.json.JSONArray().put(JSONObject()))).scope)
  assertThrows(IllegalArgumentException::class.java) { MemberManagementProjection.from(snapshot(false).put("members",org.json.JSONArray().put(JSONObject())),scope(false)) }
 }
 @Test fun installationMustMatchBoundDeviceIdentity() {
  val envelope=scope()
  envelope.getJSONArray("installations").getJSONObject(0).put("deviceId","other-device")
  val view=MemberManagementProjection.from(snapshot(),envelope)
  assertEquals(ManagementScope.UNKNOWN,view.scope)
  assertNull(view.actorRef)
  assertFalse(view.canRevoke("install-b"))
 }
}
