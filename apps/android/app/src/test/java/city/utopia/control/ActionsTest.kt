package city.utopia.control
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class ActionsTest {
 private val actionRow = JSONObject(
  """{"actionId":"A-1","requestedIntent":"add buy milk to my checklist","route":"ROOM",
   "backendRef":{"kind":"ROOM","id":"checklist","roomId":"checklist","operationId":"add-item"},
   "target":{"id":"checklist","label":"Checklist Room","operation":"add-item"},
   "status":"SUCCEEDED","progress":100,
   "resultRef":{"kind":"ROOM_RECORD","id":"rec-9","digest":null,"summary":"Added buy milk."},
   "error":null,
   "provenance":{"source":"utopia.dev-gateway","host":"MERA-ALIANWARE","roomId":"checklist","capabilityId":null,"taskId":null,"invocationId":null,
    "history":[{"at":"2026-09-30T10:00:00Z","status":"QUEUED","note":"accepted"},{"at":"2026-09-30T10:00:01Z","status":"SUCCEEDED","note":"done"}]},
   "createdAt":"2026-09-30T10:00:00Z","updatedAt":"2026-09-30T10:00:01Z"}"""
 )
 @Test fun canonicalActionKeepsGatewayTruth() {
  val summary=parseActionSummary(actionRow)
  assertEquals("A-1",summary.actionId)
  assertEquals("add buy milk to my checklist",summary.requestedIntent)
  assertEquals("ROOM",summary.route)
  assertEquals("SUCCEEDED",summary.status)
  assertEquals("SUCCEEDED",summary.statusLabel)
  assertEquals(100,summary.progress)
  assertEquals(1f,summary.progressFraction,0f)
  assertEquals("Checklist Room · add-item",summary.targetLabel)
  assertEquals("Added buy milk.",summary.resultText)
  assertNull(summary.errorCode)
 }
 @Test fun fullRecordCarriesProvenanceAndBackendIds() {
  val detail=parseActionDetail(actionRow)
  assertEquals("ROOM",detail.backendRef?.kind)
  assertEquals("checklist",detail.backendRef?.roomId)
  assertEquals("add-item",detail.backendRef?.operationId)
  assertEquals("add-item",detail.target?.operation)
  assertEquals("rec-9",detail.resultRef?.id)
  assertEquals("utopia.dev-gateway",detail.provenance?.source)
  assertEquals("MERA-ALIANWARE",detail.provenance?.host)
  assertEquals(listOf("QUEUED","SUCCEEDED"),detail.provenance?.history?.map { it.status })
  assertNull(detail.provenance?.capabilityId)
 }
 @Test fun failedActionFallsBackToErrorMessageAndKeepsBackendCode() {
  val row=JSONObject("""{"actionId":"A-2","requestedIntent":"hash a file","route":"CAPABILITY","status":"FAILED","progress":40,
   "target":{"id":"hash","label":"Hash Room","operation":"hash-file"},
   "resultRef":null,
   "error":{"code":"ROOM_UNAVAILABLE","message":"The hub is not reachable."}}""")
  val summary=parseActionSummary(row)
  assertEquals("ROOM_UNAVAILABLE",summary.errorCode)
  assertEquals("The hub is not reachable.",summary.resultText)
  assertNull(parseActionDetail(row).resultRef)
 }
 @Test fun refusedIsNeverReportedAsFailedOrSucceeded() {
  val summary=parseActionSummary(JSONObject("""{"actionId":"A-3","status":"REFUSED","route":"CAPABILITY","progress":0}"""))
  assertEquals("REFUSED",summary.status)
  assertEquals("REFUSED · not allowed by policy",summary.statusLabel)
  assertNotEquals("FAILED",summary.statusLabel)
  assertNotEquals("SUCCEEDED",summary.statusLabel)
 }
 @Test fun unavailableIsATruthfulStateNotSuccess() {
  val summary=parseActionSummary(JSONObject("""{"actionId":"A-4","status":"UNAVAILABLE","route":"ROOM","progress":0}"""))
  assertEquals("UNAVAILABLE · cannot run right now",summary.statusLabel)
  assertNull(summary.errorCode)
 }
 @Test fun unknownStatusIsShownVerbatimInsteadOfGuessed() {
  val summary=parseActionSummary(JSONObject("""{"actionId":"A-5","status":"SOMETHING_NEW","route":"ROOM","progress":5}"""))
  assertEquals("SOMETHING_NEW",summary.statusLabel)
  assertFalse(isActionStatus(summary.status))
 }
 @Test fun routeVocabularyIsExactlyTheThreeAllowedValues() {
  assertEquals(setOf("ROOM","CAPABILITY","CITY_TASK"),ACTION_ROUTES)
  assertTrue(isActionRoute("ROOM"));assertTrue(isActionRoute("CAPABILITY"));assertTrue(isActionRoute("CITY_TASK"))
  assertFalse(isActionRoute("BOSS"));assertFalse(isActionRoute("HNS"));assertFalse(isActionRoute(""))
 }
 @Test fun statusVocabularyIsExhaustiveAndFollowsTheContract() {
  assertEquals(setOf("QUEUED","RUNNING","WAITING_CONFIRMATION","SUCCEEDED","FAILED","REFUSED","CANCELLED","UNAVAILABLE"),ACTION_STATUSES)
  assertTrue(ACTION_STATUSES.all { isActionStatus(it) })
 }
 @Test fun actionListParsingKeepsGatewayOrder() {
  val rows=arrayObjects(JSONObject("""{"actions":[
   {"actionId":"A-new","status":"RUNNING","route":"ROOM","progress":30},
   {"actionId":"A-old","status":"SUCCEEDED","route":"CITY_TASK","progress":100}]}""").getJSONArray("actions"))
  val parsed=parseActions(rows)
  assertEquals(listOf("A-new","A-old"),parsed.map { it.actionId })
  assertTrue(parsed.first().hasProgress)
 }
}
