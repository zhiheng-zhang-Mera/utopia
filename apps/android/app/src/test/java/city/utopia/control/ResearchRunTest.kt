package city.utopia.control
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

// REX-807 Android observation guards. Each test is a way the phone surface usually misleads: an empty page instead of
// "owner required", a bounded list presented as complete history, a hidden unfinished campaign, an incomplete run
// shown as done, an unavailable store shown as "no runs", and a raw identifier leaking into a user-facing word.
class ResearchRunTest {
 @Test fun gatewayBooleanUnfinishedIsVisible() {
  val view=parseResearchRun(JSONObject("""{"live":null,"unfinished":true,"storeState":"READY"}"""))
  assertEquals("UNFINISHED_CAMPAIGN",view.attention.single().kind)
  assertTrue(view.attention.single().summary.contains("PARTIAL"))
 }

 @Test fun gatewayBooleanFinishedAddsNoAttention() {
  val view=parseResearchRun(JSONObject("""{"live":null,"unfinished":false,"storeState":"READY"}"""))
  assertTrue(view.attention.isEmpty())
 }

 private fun payload(overrides:String=""):JSONObject {
  val base="""{"scenarios":[],"topology":{},"live":null,"unfinished":[],"receipts":[],"storeState":"READY"}"""
  if(overrides.isBlank())return JSONObject(base)
  return JSONObject(overrides)
 }

 @Test fun ownerRefusalIsNotAnEmptyPage() {
  val view=parseResearchRun(JSONObject("""{"errorCode":"RESEARCH_OWNER_REQUIRED","httpStatus":403,"error":"Research artifact export requires the City owner"}"""))
  assertTrue(view.ownerRequired)
  assertNull(view.run)
  assertTrue(view.attention.isEmpty())
  assertEquals(OWNER_NOTICE,view.coverage)
 }

 @Test fun aNonOwnerFailureThatIsNotOwnerShapedSaysUnavailable() {
  val view=parseResearchRun(JSONObject("""{"errorCode":"INTERNAL","httpStatus":500}"""))
  assertFalse(view.ownerRequired)
  assertEquals(UNAVAILABLE_NOTICE,view.coverage)
  assertTrue("unavailable observation must not clear all attention",view.attention.any { it.kind=="OBSERVATION_UNAVAILABLE" })
 }

 @Test fun theBoundedWindowIsStatedInsteadOfPassingAsHistory() {
  val receipts=(0 until 50).joinToString(","){ """{"campaignId":"campaign-00000000-0000-4000-8000-${"%012d".format(it)}","state":"COMPLETED"}""" }
  val view=parseResearchRun(payload("""{"live":null,"unfinished":[],"storeState":"READY","receiptWindow":{"total":51,"limit":50,"truncated":true,"receipts":[$receipts]}}"""))
  val window=view.attention.singleOrNull { it.kind=="RECEIPT_WINDOW_TRUNCATED" }
  assertNotNull("a truncated window must be stated",window)
  assertTrue(window!!.summary.contains("51"))
  assertTrue(window.summary.contains("50"))
  assertTrue(window.summary.contains("PARTIAL"))
 }

 @Test fun aCompleteWindowAddsNoAttention() {
  val view=parseResearchRun(payload("""{"live":null,"unfinished":[],"storeState":"READY","receiptWindow":{"total":2,"limit":50,"truncated":false,"receipts":[{"campaignId":"campaign-a","state":"COMPLETED"}]}}"""))
  assertTrue(view.attention.isEmpty())
  assertEquals(IDLE_NOTICE,view.coverage)
 }

 @Test fun anIncompleteRunIsNotShownAsDone() {
  val view=parseResearchRun(payload("""{"live":{"campaignId":"campaign-4f1c2b7e-9a3d-4e5f-8b21-0c7d6e5f4a3b","scenarioId":"WAIT","state":"RUNNING","summary":{"planned":3,"measured":1,"failed":0}},"unfinished":[],"storeState":"READY"}"""))
  assertEquals("WAIT",view.run!!.scenario)
  assertEquals(1,view.run!!.measured ?: -1)
  assertEquals(3,view.run!!.planned ?: -1)
  assertTrue(view.run!!.note.contains("2"))
  assertEquals("RUN_INCOMPLETE",view.attention.single().kind)
  assertTrue(view.coverage.contains("1/3"))
 }

 @Test fun anUnfinishedCampaignAndAnUnavailableStoreAreVisible() {
  val view=parseResearchRun(payload("""{"live":null,"unfinished":[{"campaignId":"campaign-x","state":"INTERRUPTED"}],"storeState":"UNAVAILABLE","storeReason":"ENOTDIR","receiptWindow":{"total":0,"limit":50,"truncated":false,"receipts":[]}}"""))
  assertEquals(setOf("UNFINISHED_CAMPAIGN","STORE_UNAVAILABLE"),view.attention.map { it.kind }.toSet())
  assertTrue(view.attention.first { it.kind=="STORE_UNAVAILABLE" }.summary.contains("ENOTDIR"))
  assertTrue(view.attention.first { it.kind=="STORE_UNAVAILABLE" }.summary.contains("普通城市任务"))
  assertEquals("an unavailable store cannot establish idle",UNAVAILABLE_NOTICE,view.coverage)
 }

 @Test fun noRawIdentifierLeaksIntoAUserFacingWordButTheTechnicalLayerKeepsIt() {
  val identifier="campaign-4f1c2b7e-9a3d-4e5f-8b21-0c7d6e5f4a3b"
  val view=parseResearchRun(payload("""{"live":{"campaignId":"$identifier","scenarioId":"WAIT","state":"RUNNING","summary":{"planned":2,"measured":2}},"unfinished":[],"storeState":"READY"}"""))
  assertFalse("the coverage sentence must not carry an identifier",view.coverage.contains(identifier))
  assertTrue(view.attention.none { it.summary.contains(identifier) })
  assertTrue("the collapsed technical layer keeps the exact record",view.technical.contains(identifier))
 }

 @Test fun observationOnlyExposesNoControl() {
  // The intent is "no field a panel could turn into a mutation". Exact set equality was my first version and it failed
  // in CI for a compiler-synthesised reason, not a product one: with the Compose compiler plugin enabled, a class it
  // treats as stable gains a synthetic `$stable` field, so declaredFields has six entries. The assertion now checks the
  // five observation fields ARE present and that nothing control-shaped appeared - which is the property that matters.
  val names=ResearchRunView::class.java.declaredFields.map { it.name }.toSet()
  assertTrue("the observation fields must all be present, found $names",names.containsAll(setOf("ownerRequired","run","coverage","attention","technical")))
  val controlLike=names.filter { it.contains(Regex("create|start|stop|inject|fault|confirm|submit|mutat",RegexOption.IGNORE_CASE)) }
  assertTrue("the view model must expose no control, found $controlLike",controlLike.isEmpty())
 }
}
