package city.utopia.control
import org.json.JSONObject

// REX-807, Android half: OBSERVATION ONLY.
//
// The workbook requires Android to observe the current run, its status and the critical attention items, while full
// authoring parity is allowed to stay on the Web. So this module deliberately exposes NO control: no create, no
// start/stop, no fault injection. What it does expose is exactly what a person holding the phone needs in order to
// know what the City is doing:
//
//   * the current run (scenario, state, measured/planned) in plain language;
//   * the receipt window's own bound, so "three campaigns" cannot be read as "all history";
//   * a visible list of critical attention: an unfinished campaign, an incomplete run, an unavailable store;
//   * identifiers and the raw payload only inside `technical`, which the panel keeps collapsed.
//
// A refusal is not an empty page: an owner-required answer sets ownerRequired and says so.
data class ResearchAttention(val kind:String,val summary:String)
data class ResearchRunProgress(val scenario:String,val state:String,val measured:Int?,val planned:Int?,val note:String)
data class ResearchReceiptWindow(val total:Int,val returned:Int,val limit:Int,val truncated:Boolean)
data class ResearchRunView(val ownerRequired:Boolean,val run:ResearchRunProgress?,val coverage:String,val attention:List<ResearchAttention>,val technical:String)

internal const val OWNER_NOTICE="仅城市所有者可查看研究记录，请由所有者打开此页面。"
internal const val UNAVAILABLE_NOTICE="研究记录暂不可用，请刷新或重新连接。"
internal const val IDLE_NOTICE="当前没有运行中的 experiment。"

fun parseResearchRun(response:JSONObject):ResearchRunView {
 val failure=response.optString("errorCode").takeUnless { it.isBlank()||it=="null" }
 if(failure!=null){
  val owner=response.optInt("httpStatus",0)==403||failure.contains("OWNER")
  return ResearchRunView(owner,null,if(owner)OWNER_NOTICE else UNAVAILABLE_NOTICE,emptyList(),response.toString(2))
 }
 val attention=mutableListOf<ResearchAttention>()
 val window=response.optJSONObject("receiptWindow")
 val receiptWindow=window?.let { ResearchReceiptWindow(it.optInt("total",0),it.optJSONArray("receipts")?.length()?:0,it.optInt("limit",0),it.optBoolean("truncated",false)) }
 if(receiptWindow?.truncated==true)attention.add(ResearchAttention("RECEIPT_WINDOW_TRUNCATED","本城持有 ${receiptWindow.total} 次 campaign，列表只列最新 ${receiptWindow.returned} 条（上限 ${receiptWindow.limit}）：较早历史未被读出，覆盖为 PARTIAL。"))
 val storeState=response.optString("storeState","").takeUnless { it.isBlank()||it=="null" }
 if(storeState=="UNAVAILABLE"){
  val reason=response.optString("storeReason").takeUnless { it.isBlank()||it=="null" }
  attention.add(ResearchAttention("STORE_UNAVAILABLE","研究存储不可用"+(if(reason!=null)"：$reason" else "")+"。故障注入不可用；普通城市任务不受影响。"))
 }
 val unfinishedCount=response.optJSONArray("unfinished")?.length()
 if(response.optBoolean("unfinished",false)||unfinishedCount!=null&&unfinishedCount>0)
  attention.add(ResearchAttention("UNFINISHED_CAMPAIGN",if(unfinishedCount!=null)"有 $unfinishedCount 次 campaign 未正常结束，其覆盖为 PARTIAL。" else "有 campaign 未正常结束，其覆盖为 PARTIAL；本次响应未提供数量。"))
 val live=response.optJSONObject("live")
 var run:ResearchRunProgress?=null
 if(live!=null&&!live.optString("campaignId").isBlank()&&live.optString("campaignId")!="null"){
  val summary=live.optJSONObject("summary")?:JSONObject()
  fun number(source:JSONObject,key:String):Int?=if(source.has(key)&&!source.isNull(key))source.optInt(key) else null
  val measured=number(summary,"measured")?:number(live,"measured")
  val planned=number(summary,"planned")?:number(live,"planned")
  val note=if(measured!=null&&planned!=null&&measured<planned)"还有 ${planned-measured} 次计划重复尚未结清。" else ""
  run=ResearchRunProgress(live.optString("scenarioId","UNKNOWN"),live.optString("state","UNKNOWN"),measured,planned,note)
  if(note.isNotBlank())attention.add(ResearchAttention("RUN_INCOMPLETE",note))
 }
 val coverage=if(run!=null)"当前运行：${run.scenario} · ${run.state} · ${run.measured ?: "?"}/${run.planned ?: "?"}（已测量/计划）" else IDLE_NOTICE
 // No campaign identifier appears in any summary above; the raw payload is carried only here, for the collapsed
 // technical section, which is the same folding rule the Web view model applies.
 return ResearchRunView(false,run,coverage,attention,response.toString(2))
}
