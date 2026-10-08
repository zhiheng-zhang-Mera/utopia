package city.utopia.control
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test

class OwnerControlsTest {
 @Test fun askDraftStatusRequiresReviewAndHasNoAction(){
  val answer=parseAskResult(JSONObject("""{"status":"DRAFT_REQUIRED","draft":{"kind":"AGENT_JOB","job":{"title":"Review","instruction":"Inspect tests","purpose":"verify"}},"action":null}"""))
  assertTrue(answer.isKnownStatus);assertTrue(askNeedsUser(answer.status));assertFalse(askShowsAction(answer.status));assertNull(answer.action);assertEquals("Review",answer.ownerDraft?.title)
 }
 private fun operation()=OwnerControlDraft(kind="REMOTE_OPERATION",targetDeviceRef="dev-alien",executable="node",argvJson="[\"-e\",\"a; b\",\"\"]",cwd="D:/work",purpose="check literal arguments")
 @Test fun naturalDraftParsesWithoutInventingMissingFields(){
  val row=JSONObject("""{"kind":"REMOTE_OPERATION","targetDeviceRef":"dev-alien","requestText":"run node on Alien","operation":{"executable":"node","argv":["-e","a; b",""],"cwd":"","purpose":""}}""")
  val d=parseOwnerControlDraft(row);assertEquals("dev-alien",d.targetDeviceRef);assertEquals("",d.cwd);assertEquals("",d.purpose)
  assertEquals("",JSONArray(d.argvJson).getString(2));assertTrue(ownerControlValidation(d).contains("cwd"))
 }
 @Test fun actionPayloadCarriesTheExistingCanonicalContract(){
  val body=ownerControlAction(operation(),"one-request");assertEquals("CITY_TASK",body.getString("route"));assertEquals("OWNER_REMOTE_OPERATION",body.getString("operation"))
  val input=body.getJSONObject("input");assertEquals("dev-alien",input.getString("targetDeviceRef"));assertEquals("a; b",input.getJSONObject("operation").getJSONArray("argv").getString(1))
  assertEquals("",input.getJSONObject("operation").getJSONArray("argv").getString(2))
 }
 @Test fun invalidArgvAndBoundsAreRefusedLocally(){
  assertTrue(ownerControlValidation(operation().copy(argvJson="not JSON")).contains("argv"))
  assertTrue(ownerControlValidation(operation().copy(timeoutMs="1800001")).contains("timeoutMs"))
  assertTrue(ownerControlValidation(operation().copy(maxOutputBytes="4194305")).contains("maxOutputBytes"))
  assertTrue(ownerControlValidation(operation().copy(targetDeviceRef="")).contains("targetDeviceRef"))
 }
 @Test fun editingAndOfflineCannotRetainAuthorization(){
  val form=OwnerControlForm(operation(),"node");assertTrue(form.canDispatch(online=true,busy=false,enabled=true))
  val changed=form.edit(operation().copy(purpose="changed"));assertEquals("",changed.confirmation);assertFalse(changed.canDispatch(true,false,true))
  assertFalse(form.canDispatch(false,false,true));assertFalse(form.canDispatch(true,true,true));assertFalse(form.canDispatch(true,false,false))
 }
 @Test fun agentJobRefsAndDeadlineStayBounded(){
  val d=OwnerControlDraft(kind="AGENT_JOB",targetDeviceRef="dev-alien",title="Review tests",instruction="inspect artifacts",purpose="cross host review",refs="report=file:test-result",deadlineMinutes="30")
  assertTrue(ownerControlValidation(d).isEmpty());val job=ownerControlAction(d,"job-key").getJSONObject("input").getJSONObject("job")
  assertEquals(1800000L,job.getLong("deadlineMs"));assertEquals("file:test-result",job.getJSONArray("inputs").getJSONObject(0).getString("ref"))
  assertTrue(ownerControlValidation(d.copy(refs="nameless")).contains("refs"));assertTrue(ownerControlValidation(d.copy(deadlineMinutes="1441")).contains("deadlineMinutes"))
 }
 @Test fun ownerRefusalIsVisibleAndDoesNotBecomeEmptySuccessfulHistory(){
  val view=parseOwnerControls(JSONObject("""{"errorCode":"REMOTE_OPERATION_OWNER_REQUIRED","httpStatus":403,"error":"Owner required"}"""),"REMOTE_OPERATION")
  assertTrue(view.ownerRequired);assertFalse(view.enabled);assertNotNull(view.error)
 }
 @Test fun reportAndCollectionLabelsNeverClaimCityVerification(){
  val view=parseOwnerControls(JSONObject("""{"config":{"enabled":true},"jobs":[{"taskId":"Q-1","state":"COMPLETED","job":{"title":"Review"},"report":{"summary":"Observed tests"},"reportValidation":{"valid":true,"acceptanceAuthority":false},"consumptionState":"AWAITING_COLLECTION"}]}"""),"AGENT_JOB")
  assertEquals("COMPLETED",view.rows.single().state);assertTrue(view.rows.single().canCollect)
  assertTrue(view.authorityNotice.contains("Agent"));assertTrue(view.authorityNotice.contains("确认收取"));assertTrue(view.rows.single().result.contains("Observed tests"))
 }
 @Test fun completedRemoteRowShowsRealExitAndOutput(){
  val view=parseOwnerControls(JSONObject("""{"config":{"enabled":true,"allowlist":["node"],"workspaces":["D:/work"]},"operations":[{"taskId":"Q-2","state":"FAILED","executable":"node","result":{"stdout":"","stderr":"boom","exitCode":7,"timedOut":false,"truncated":false},"receipt":{"valid":true,"acceptanceAuthority":false}}]}"""),"REMOTE_OPERATION")
  assertEquals("FAILED",view.rows.single().state);assertTrue(view.rows.single().result.contains("7"));assertTrue(view.rows.single().result.contains("boom"));assertFalse(view.rows.single().canStop)
 }
}
