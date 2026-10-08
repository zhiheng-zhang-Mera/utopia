package city.utopia.control
import org.json.JSONArray
import org.json.JSONObject

data class OwnerControlDraft(
 val kind:String, val targetDeviceRef:String="", val requestText:String="",
 val executable:String="", val argvJson:String="[]", val cwd:String="", val purpose:String="",
 val timeoutMs:String="120000", val maxOutputBytes:String="262144",
 val title:String="", val instruction:String="", val refs:String="", val deadlineMinutes:String="30",
)
data class OwnerControlForm(val draft:OwnerControlDraft,val confirmation:String="") {
 fun edit(next:OwnerControlDraft)=copy(draft=next,confirmation="")
 fun canDispatch(online:Boolean,busy:Boolean,enabled:Boolean)=online&&!busy&&enabled&&ownerControlValidation(draft).isEmpty()&&confirmation.isNotBlank()&&confirmation==(if(draft.kind=="REMOTE_OPERATION")draft.executable.trim() else draft.title.trim())
}
private fun JSONObject.field(key:String)=optString(key).takeUnless { it=="null" }.orEmpty()
fun parseOwnerControlDraft(row:JSONObject):OwnerControlDraft {
 val kind=row.field("kind");require(kind in setOf("REMOTE_OPERATION","AGENT_JOB")) { "Unknown owner control draft" }
 val operation=row.optJSONObject("operation");val job=row.optJSONObject("job")
 return OwnerControlDraft(kind=kind,targetDeviceRef=row.field("targetDeviceRef"),requestText=row.field("requestText"),executable=operation?.field("executable").orEmpty(),argvJson=(operation?.optJSONArray("argv")?:JSONArray()).toString(),cwd=operation?.field("cwd").orEmpty(),purpose=(if(kind=="REMOTE_OPERATION")operation else job)?.field("purpose").orEmpty(),title=job?.field("title").orEmpty(),instruction=job?.field("instruction").orEmpty(),refs=arrayObjects(job?.optJSONArray("inputs")).joinToString("\n") { it.field("name")+"="+it.field("ref") })
}
private fun argv(draft:OwnerControlDraft):JSONArray {
 val result=JSONArray(draft.argvJson);require(result.length()<=512) { "Too many argv entries" }
 for(i in 0 until result.length()){val value=result.get(i);require(value is String&&value.length<=8192&&!value.contains('\u0000')) { "argv must contain bounded strings" }}
 return result
}
private fun refs(draft:OwnerControlDraft):JSONArray {
 val out=JSONArray()
 for(line in draft.refs.lines().filter { it.isNotBlank() }){val at=line.indexOf('=');require(at>0&&line.substring(at+1).isNotBlank()){ "Each reference must be name=ref" };out.put(JSONObject().put("name",line.substring(0,at).trim()).put("ref",line.substring(at+1).trim()))}
 require(out.length()<=64){"Too many references"};return out
}
fun ownerControlValidation(d:OwnerControlDraft):List<String> {
 val missing=mutableListOf<String>();if(d.targetDeviceRef.isBlank())missing+="targetDeviceRef";if(d.purpose.isBlank())missing+="purpose"
 if(d.kind=="REMOTE_OPERATION"){
  if(d.executable.isBlank()||!Regex("[A-Za-z0-9_.-]+").matches(d.executable.trim()))missing+="executable"
  if(d.cwd.isBlank())missing+="cwd"
  if(runCatching { argv(d) }.isFailure)missing+="argv"
  if(d.timeoutMs.toLongOrNull()?.let { it in 1..1800000 }!=true)missing+="timeoutMs"
  if(d.maxOutputBytes.toLongOrNull()?.let { it in 1..4194304 }!=true)missing+="maxOutputBytes"
 }else if(d.kind=="AGENT_JOB"){
  if(d.title.isBlank())missing+="title";if(d.instruction.isBlank())missing+="instruction"
  if(d.deadlineMinutes.toLongOrNull()?.let { it in 1..1440 }!=true)missing+="deadlineMinutes"
  if(runCatching { refs(d) }.isFailure)missing+="refs"
 }else missing+="kind"
 return missing
}
fun ownerControlAction(d:OwnerControlDraft,idempotencyKey:String):JSONObject {
 require(ownerControlValidation(d).isEmpty()) { "Missing/invalid: "+ownerControlValidation(d).joinToString() }
 val input=JSONObject().put("targetDeviceRef",d.targetDeviceRef)
 if(d.kind=="REMOTE_OPERATION")input.put("operation",JSONObject().put("executable",d.executable.trim()).put("argv",argv(d)).put("cwd",d.cwd.trim()).put("purpose",d.purpose.trim()).put("timeoutMs",d.timeoutMs.toLong()).put("maxOutputBytes",d.maxOutputBytes.toLong()))
 else input.put("job",JSONObject().put("title",d.title.trim()).put("instruction",d.instruction.trim()).put("purpose",d.purpose.trim()).put("inputs",refs(d)).put("deadlineMs",d.deadlineMinutes.toLong()*60000))
 return JSONObject().put("intent",d.requestText.ifBlank { "Android owner control" }).put("route","CITY_TASK").put("target","city.task").put("operation",if(d.kind=="REMOTE_OPERATION")"OWNER_REMOTE_OPERATION" else "AGENT_JOB").put("input",input).put("idempotencyKey",idempotencyKey)
}
data class OwnerControlRow(val taskId:String,val state:String,val title:String,val summary:String,val result:String,val error:String,val receipt:String,val collection:String,val canStop:Boolean,val canCollect:Boolean)
data class OwnerControlView(val enabled:Boolean,val ownerRequired:Boolean,val error:String?,val allowlist:List<String>,val workspaces:List<String>,val rows:List<OwnerControlRow>,val authorityNotice:String)
fun parseOwnerControls(response:JSONObject,kind:String):OwnerControlView {
 val notice=if(kind=="AGENT_JOB")"Agent 的自述 / AGENT_OBSERVATION_NOT_CITY_VERIFICATION；确认收取 / ACKNOWLEDGEMENT_NOT_VERIFICATION。" else "程序实际结果与 City 校验回执；acceptanceAuthority=false 不代表最终验收。"
 if(response.has("errorCode"))return OwnerControlView(false,response.optInt("httpStatus")==403,response.field("errorCode")+": "+response.field("error"),emptyList(),emptyList(),emptyList(),notice)
 val config=response.optJSONObject("config")?:error("Missing owner control configuration")
 val name=if(kind=="REMOTE_OPERATION")"operations" else "jobs";val rows=response.optJSONArray(name)?:error("Missing owner control rows")
 val parsed=arrayObjects(rows).map { row ->
  val state=row.field("state");val report=row.optJSONObject(if(kind=="REMOTE_OPERATION")"result" else "report")
  val collection=row.field("consumptionState")
  OwnerControlRow(row.field("taskId"),state,if(kind=="REMOTE_OPERATION")row.field("executable") else row.optJSONObject("job")?.field("title").orEmpty(),"目标: "+row.field("assignedNodeId")+" · "+row.field("targetStateAtCreation"),report?.toString(2).orEmpty(),row.field("error"),(row.optJSONObject(if(kind=="REMOTE_OPERATION")"receipt" else "reportValidation")?.toString(2)).orEmpty(),collection,state in setOf("QUEUED","ASSIGNED","RUNNING"),kind=="AGENT_JOB"&&report!=null&&collection=="AWAITING_COLLECTION")
 }
 fun strings(key:String):List<String>{val a=config.optJSONArray(key)?:return emptyList();return (0 until a.length()).map { a.getString(it) }}
 return OwnerControlView(config.optBoolean("enabled"),false,null,strings("allowlist"),strings("workspaces"),parsed,notice)
}
