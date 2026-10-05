package city.utopia.control
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class ResearchTraceTest {
 @Test fun missingAndMeasuredZeroRemainDifferent() {
  val view=parseResearchTrace(JSONObject("""{"trace":{"schemaVersion":1,"runId":"trace-fixture","recording":true,"storageState":"READY","completeness":"PARTIAL","recordedTypes":["RESOURCE_OBSERVATION"],"failures":[],"metricsAvailability":{"cpuPercent":{"available":true,"reason":null},"memoryBytes":{"available":false,"reason":"NOT_OBSERVABLE: no retained measurement"}},"records":[{"metrics":{"cpuPercent":{"value":0,"reason":null}}}],"experimentRunRef":null,"experimentRunReason":"NOT_OBSERVABLE: recording only"}}"""))
  assertEquals(true,view.recording);assertEquals(true,view.metrics.first { it.name=="cpuPercent" }.available)
  assertEquals(false,view.metrics.first { it.name=="memoryBytes" }.available)
  assertEquals("NOT_OBSERVABLE: recording only",view.experimentRun)
  assertTrue(view.technical.contains("\"value\": 0"))
 }
 @Test fun incompleteMetricAvailabilityIsUnknown() {
  val view=parseResearchTrace(JSONObject("""{"trace":{"schemaVersion":1,"runId":"trace-fixture","metricsAvailability":{"cpuPercent":{}},"records":[]}}"""))
  assertNull(view.recording);assertNull(view.metrics.single().available)
  assertTrue(view.metrics.single().reason!!.startsWith("NOT_OBSERVABLE"))
 }
 @Test fun missingTraceIsNotAnEmptySuccess() {try{parseResearchTrace(JSONObject("{}"));fail("Missing trace must fail")}catch(expected:IllegalArgumentException){}}
}
