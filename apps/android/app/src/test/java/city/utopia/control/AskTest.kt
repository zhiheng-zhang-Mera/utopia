package city.utopia.control
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class AskTest {
 private val askResponse = JSONObject(
  """{"text":"hash C:\\tmp\\a.txt","status":"COMPLETED","route":"ROOM","target":"hash","operation":"hash-file",
   "candidates":[],"confirmation":null,
   "action":{"actionId":"A-7","requestedIntent":"hash C:\\tmp\\a.txt","route":"ROOM",
    "backendRef":{"kind":"ROOM","id":"hash","roomId":"hash","operationId":"hash-file"},
    "target":{"id":"hash","label":"Hash Room","operation":"hash-file"},
    "status":"SUCCEEDED","progress":100,
    "resultRef":{"kind":"ROOM_RECORD","id":"rec-1","digest":"sha256:abc","summary":"SHA-256 abc123"},
    "error":null,
    "provenance":{"source":"utopia.dev-gateway","host":"host","roomId":"hash","capabilityId":null,"taskId":null,"invocationId":null,
     "history":[{"at":"2026-09-30T10:00:00Z","status":"SUCCEEDED","note":"ran"}]},
    "createdAt":"2026-09-30T10:00:00Z","updatedAt":"2026-09-30T10:00:00Z"},
   "message":"Ran Hash Room on C:\\tmp\\a.txt.","router":"DETERMINISTIC_RULES","deterministic":true,"llm":false}"""
 )
 @Test fun completedAskRendersTheActionAndItsRouter() {
  val ask=parseAskResult(askResponse)
  assertEquals("COMPLETED",ask.status)
  assertEquals("COMPLETED",ask.statusLabel)
  assertTrue(askShowsAction(ask.status));assertFalse(askNeedsUser(ask.status))
  assertEquals("A-7",ask.action?.actionId)
  assertEquals("SUCCEEDED",ask.action?.summary?.status)
  assertEquals("SHA-256 abc123",ask.action?.resultRef?.summary)
  assertEquals("DETERMINISTIC_RULES",ask.router)
  assertEquals("Routed by DETERMINISTIC_RULES · deterministic rules",ask.routerLabel)
  assertTrue(ask.deterministic);assertFalse(ask.llm)
  assertEquals(JSONObject().put("route","ROOM").put("target","hash").put("operation","hash-file").toString(),ask.matchedSelection.toString())
 }
 @Test fun awaitingConfirmationShowsWhatItWillDoAndNothingRan() {
  val ask=parseAskResult(JSONObject("""{"text":"send the report","status":"AWAITING_CONFIRMATION","route":"CAPABILITY","target":"planning.document.intake","operation":"read",
   "confirmation":{"label":"Send the report","description":"Emails the report to the team.","sideEffect":true},
   "router":"DETERMINISTIC_RULES","deterministic":true,"llm":false}"""))
  assertEquals("NEEDS CONFIRMATION",ask.statusLabel)
  assertTrue(askNeedsUser(ask.status));assertFalse(askShowsAction(ask.status))
  assertNull(ask.action)
  assertEquals("Send the report",ask.confirmation?.label)
  assertEquals("Emails the report to the team.",ask.confirmation?.description)
  assertTrue(ask.confirmation!!.sideEffect)
 }
 @Test fun ambiguousOffersConcreteCandidatesWithSideEffectFlag() {
  val ask=parseAskResult(JSONObject("""{"text":"hash it","status":"AMBIGUOUS","candidates":[
   {"route":"ROOM","target":"hash","operation":"hash-file","label":"Hash Room — hash a file","description":"SHA-256 of a local file.","mutating":false,"sideEffect":false,"available":true,"unavailableReason":null,"example":"hash C:\\tmp\\a.txt"},
   {"route":"ROOM","target":"knowledge","operation":"hash-record","label":"Knowledge Room — hash a note","description":"Digest of a stored note.","mutating":true,"sideEffect":true,"available":false,"unavailableReason":"hub down","example":null}],
   "router":"DETERMINISTIC_RULES","deterministic":true,"llm":false}"""))
  assertEquals("SEVERAL MATCHES · CHOOSE ONE",ask.statusLabel)
  assertTrue(askNeedsUser(ask.status))
  assertEquals(2,ask.candidates.size)
  assertEquals("Hash Room — hash a file",ask.candidates.first().label)
  assertFalse(ask.candidates.first().sideEffect)
  assertTrue(ask.candidates.first().available)
  assertTrue(ask.candidates[1].mutating);assertTrue(ask.candidates[1].sideEffect);assertFalse(ask.candidates[1].available)
  assertEquals("UNAVAILABLE · hub down",ask.candidates[1].stateLabel)
  assertEquals(JSONObject().put("route","ROOM").put("target","knowledge").put("operation","hash-record").toString(),ask.candidates[1].choice.toString())
 }
 @Test fun unmatchedSaysNoRuleMatchedAndOffersTheManualList() {
  val ask=parseAskResult(JSONObject("""{"text":"do the thing","status":"UNMATCHED","candidates":[
   {"route":"ROOM","target":"checklist","operation":"add-item","label":"Checklist Room — add an item"}],
   "router":"DETERMINISTIC_RULES","deterministic":true,"llm":false}"""))
  assertEquals("NO RULE MATCHED",ask.statusLabel)
  assertTrue(askNeedsUser(ask.status));assertFalse(askShowsAction(ask.status))
  assertEquals(1,ask.candidates.size)
  assertEquals("",ask.candidates.first().description)
  assertFalse(ask.candidates.first().available)
 }
 @Test fun unavailableAskIsATruthfulStateNotAnError() {
  val ask=parseAskResult(JSONObject("""{"text":"hash a file","status":"UNAVAILABLE","route":"ROOM","target":"hash",
   "message":"The Room Hub is not reachable.","router":"DETERMINISTIC_RULES","deterministic":true,"llm":false}"""))
  assertEquals("UNAVAILABLE · the target cannot run right now",ask.statusLabel)
  assertTrue(askShowsAction(ask.status));assertFalse(askNeedsUser(ask.status))
  assertNull(ask.action)
  assertNull(ask.confirmation)
 }
 @Test fun askStatusVocabularyIsExhaustiveAndClassifiedOnce() {
  assertEquals(setOf("RESOLVED","AWAITING_CONFIRMATION","AMBIGUOUS","UNMATCHED","COMPLETED","FAILED","REFUSED","UNAVAILABLE","DRAFT_REQUIRED"),ASK_STATUSES)
  ASK_STATUSES.forEach { assertTrue(isAskStatus(it));assertNotEquals(askShowsAction(it),askNeedsUser(it)) }
  assertFalse(isAskStatus("PENDING"))
  assertEquals("PENDING",askStatusLabel("PENDING"))
 }
 @Test fun aModelRoutedAnswerIsNeverImpliedAsDeterministic() {
  assertEquals("Routed by UNKNOWN · client cannot tell",askRouterLabel("",false,false))
  assertEquals("Routed by DETERMINISTIC_RULES · deterministic rules · model",askRouterLabel("DETERMINISTIC_RULES",true,true))
  assertTrue(parseAskResult(JSONObject("""{"text":"x","status":"UNMATCHED","router":"DETERMINISTIC_RULES","deterministic":true,"llm":false}""")).deterministic)
 }
 @Test fun targetParsingOfTheManualPicker() {
  val targets=parseTargets(arrayObjects(JSONObject("""{"targets":[
   {"route":"CITY_TASK","target":"city.task","operation":null,"label":"City task","description":"Run a safe task on a node.","mutating":false,"sideEffect":true,"available":true,"unavailableReason":null,"example":"run this safe task on Alien"}]}""").getJSONArray("targets")))
  assertEquals(1,targets.size)
  assertEquals("CITY_TASK",targets.first().route)
  assertNull(targets.first().operation)
  assertEquals("SIDE EFFECT · asks to confirm",targets.first().stateLabel)
  assertEquals("City task",targets.first().label)
 }
}
