package city.utopia.control
import org.json.JSONObject

data class TraceMetricAvailability(val name:String,val available:Boolean?,val reason:String?)
data class ResearchTraceView(val recording:Boolean?,val storageState:String,val completeness:String,val types:List<String>,val failures:List<String>,val metrics:List<TraceMetricAvailability>,val experimentRun:String,val technical:String)
fun parseResearchTrace(response:JSONObject):ResearchTraceView {
 val trace=response.optJSONObject("trace")?:throw IllegalArgumentException("Research trace missing")
 require(trace.optInt("schemaVersion",-1)==1){"Unsupported research trace version"}
 fun list(key:String)=trace.optJSONArray(key)?.let { array->(0 until array.length()).map { array.optString(it) } }?:emptyList()
 val availability=trace.optJSONObject("metricsAvailability")?:JSONObject()
 val metrics=availability.keys().asSequence().map { name->
  val row=availability.optJSONObject(name)
  val measured=row?.opt("available") as? Boolean
  TraceMetricAvailability(name,measured,if(measured==true)null else row?.optString("reason")?.takeUnless { it.isBlank()||it=="null" }?:"NOT_OBSERVABLE: availability not provided")
 }.toList()
 val failures=trace.optJSONArray("failures")?.let { array->(0 until array.length()).mapNotNull { array.optJSONObject(it)?.optString("code") } }?:emptyList()
 val experiment=trace.optString("experimentRunRef").takeUnless { it.isBlank()||it=="null" }?:trace.optString("experimentRunReason").takeUnless { it.isBlank()||it=="null" }?:"NOT_OBSERVABLE: no experiment execution binding"
 return ResearchTraceView(trace.opt("recording") as? Boolean,trace.optString("storageState","NOT_OBSERVABLE"),trace.optString("completeness","NOT_OBSERVABLE"),list("recordedTypes"),failures,metrics,experiment,trace.toString(2))
}
