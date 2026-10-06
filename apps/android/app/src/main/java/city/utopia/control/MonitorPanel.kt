package city.utopia.control

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.json.JSONObject

private fun monitorState(state:String)=mapOf("QUEUED" to "排队中","RUNNING" to "正在运行","PAUSED" to "已暂停","COMPLETED" to "已完成","FAILED" to "失败","CANCELLED" to "已取消","WAITING_CONFIRMATION" to "等待确认","ONLINE" to "在线","OFFLINE" to "离线","PARTIAL" to "观测不完整","COMPLETE" to "观测完整","UNAVAILABLE" to "观测不可用","DISCONNECTED" to "观测已断开","STALE" to "观测已过期")[state] ?: "状态未报告"
private fun monitorRisk(code:String)=mapOf("TASK_FAILED" to "任务失败，请查看失败证据","TASK_REFUSED" to "任务被拒绝","TASK_UNAVAILABLE" to "任务不可用","OWNER_CONFIRMATION_REQUIRED" to "任务等待所有者确认","DEVICE_ROUTE_WAITING" to "正在等待目标设备","PATH_REPEATED" to "工作路线重复","RETRY_HISTORY_NOT_OBSERVABLE" to "重试历史无法观测","DEVICE_OFFLINE" to "设备离线","DEVICE_OFFLINE_HOLDING_WORK" to "设备离线且有工作等待","DEVICE_STATE_UNKNOWN" to "设备状态未报告","WINDOW_INCOMPLETE" to "观测窗口不完整","HISTORY_GAP" to "历史窗口有缺口","EDGE_CAUSALITY_MISSING" to "路线依据不完整","MONITOR_PARTIAL" to "观测不完整","MONITOR_UNAVAILABLE" to "监控源不可用","MONITOR_DISCONNECTED" to "监控源断开","MONITOR_STALE" to "监控源过期")[code] ?: "风险类型未报告，请查看证据"
private fun monitorNodeLabel(node:JSONObject)=when(node.optString("kind")){"OBSERVATION"->"观测窗口";"TASK"->when(node.optString("label")){"WAIT"->"等待任务";"CREATE_TEMP_ARTIFACT"->"创建临时文件任务";else->node.optString("label","任务")};else->node.optString("label","设备")}
private fun measured(obj:JSONObject,key:String):String=if(!obj.has(key)||obj.isNull(key))"未观测" else obj.opt(key).toString()

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun MonitorPanel(state:CityState,client:CityClient?) {
 val online=state.connection=="ONLINE"
 val cityId=state.snapshot?.optString("cityId").orEmpty()
 var filter by remember(client,cityId){mutableStateOf("ALL")}
 // A new scope disposes/fences callbacks and immediately clears cached observation on connectivity change.
 val fence=remember(client,cityId,online,filter){CallbackFence()}
 DisposableEffect(fence){onDispose{fence.close()}}
 var graph by remember(fence){mutableStateOf<MonitorGraphView?>(null)}
 var decisions by remember(fence){mutableStateOf<JSONObject?>(null)}
 var graphFailure by remember(fence){mutableStateOf<String?>(null)}
 var decisionFailure by remember(fence){mutableStateOf<String?>(null)}
 var busy by remember(fence){mutableStateOf(false)}
 var expanded by remember(client,cityId){mutableStateOf(emptySet<String>())}
 var selected by remember(fence){mutableStateOf<Pair<String,String>?>(null)}
 var decisionMode by remember(client,cityId){mutableStateOf(false)}
 var technical by remember(fence){mutableStateOf(false)}
 fun load(){
  if(client==null||!online||cityId.isBlank()||busy)return
  val ticket=fence.ticket() ?: return;busy=true
  client.monitorProjection(filter){response->
   if(!fence.accepts(ticket))return@monitorProjection
   busy=false
   val parsed=runCatching{parseMonitorGraph(response.getJSONObject("graphResponse"),cityId)}
   graph=parsed.getOrNull();graphFailure=if(parsed.isFailure)"监控图暂不可用；工作状态未知。其他城市操作仍可继续。" else null
   val d=runCatching{parseMonitorDecisions(response.getJSONObject("decisionResponse"),cityId)}
   decisions=d.getOrNull();decisionFailure=if(d.isFailure)"决定收据暂不可用；不能判断是否需要所有者。" else null
  }
 }
 LaunchedEffect(fence){if(online){load();while(true){delay(2000);load()}}}
 Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(10.dp)){
  Text("同一城市的只读工作视图；监控不会执行建议或审批任务。")
  Text("城市："+cityId.ifBlank{"未报告"},style=MaterialTheme.typography.bodySmall)
  Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
   OutlinedButton(onClick={load()},enabled=online&&!busy&&client!=null){Text(if(busy)"读取中…" else "刷新")}
   Button(onClick={decisionMode=!decisionMode}){Text(if(decisionMode)"工作总览" else "决定来源")}
  }
  if(!online)Text("连接已断开；缓存不是当前工作状态。重新连接后读取同一城市。",color=MaterialTheme.colorScheme.error)
  if(busy&&graph==null)LinearProgressIndicator(Modifier.fillMaxWidth())
  if(!decisionMode){
   graphFailure?.let{Text(it,color=MaterialTheme.colorScheme.error)}
   graph?.let{view->
    val summary=view.raw.getJSONObject("summary")
    Text("观测："+monitorState(view.health),style=MaterialTheme.typography.titleMedium)
    if(view.health!="COMPLETE")Text("当前观测不完整，不能据此判断全城平稳。",color=MaterialTheme.colorScheme.error)
    Text("任务状态、设备分配和风险来自 Gateway；模型、提供者和评审路线未报告。")
    val unobserved=summary.optJSONObject("unobserved") ?: JSONObject()
    Text("窗口外任务："+measured(unobserved,"tasks")+" · 历史缺口："+measured(unobserved,"historyGap"))
    Text("需关注风险："+measured(summary,"activeRiskCount")+"；所有者状态仅覆盖规范任务中的等待确认。")
    Row(horizontalArrangement=Arrangement.spacedBy(6.dp)){
     listOf("ALL" to "全部路线","ASSIGNED_TO" to "设备分配","NONE" to "隐藏路线").forEach{(value,label)->FilterChip(selected=filter==value,onClick={filter=value},label={Text(label)})}
    }
    view.clusters.forEach{c->val id=c.getString("id");OutlinedButton(onClick={expanded=if(id in expanded)expanded-id else expanded+id},modifier=Modifier.fillMaxWidth()) {Text((if(id in expanded)"收起" else "展开")+" "+monitorState(c.optString("state"))+" · "+measured(c,"count")+" 项任务")}}
    view.visibleNodes(expanded).forEach{node->
     Card(Modifier.fillMaxWidth().clickable{selected="node" to node.getString("id")}){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(5.dp)){
      Text(monitorNodeLabel(node)+" · "+monitorState(node.optString("state")),style=MaterialTheme.typography.titleMedium)
      monitorObjects(node.optJSONArray("riskReasons")).forEach{r->Text(monitorRisk(r.optString("code")),color=if(r.optString("level")=="ACTIVE")MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)}
      Text("查看任务 / 设备和依据",style=MaterialTheme.typography.bodySmall)
     }}
    }
    if(view.nodes.isEmpty())Text("窗口中没有节点；这不代表全城没有工作。")
   }
  }else{
   decisionFailure?.let{Text(it,color=MaterialTheme.colorScheme.error)}
   decisions?.let{data->
    val window=data.getJSONObject("window");val metrics=data.getJSONObject("metrics")
    Text("收据是建议记录；没有任何建议由监控执行。")
    Text("保留窗口："+measured(metrics,"decisions")+" · 标记需所有者："+measured(metrics,"ownerRequired")+" · 自动建议："+measured(metrics,"autoResolved"))
    if(metrics.optBoolean("retentionTruncated"))Text("窗口已截断；以上数量和比率只描述保留的样本。")
    if(window.optString("persistence")!="READY")Text("收据存储不可用；内存记录可能在重启时丢失。",color=MaterialTheme.colorScheme.error)
    Text("以下需所有者标记来自历史收据窗口，不能据此判断当前待办。");Text("真实模型 / 提供者身份未观测；隐藏推理未采集。")
    monitorObjects(window.optJSONArray("decisions")).forEach{d->Card(Modifier.fillMaxWidth().clickable{selected="decision" to d.getString("decisionId")}){Column(Modifier.padding(12.dp)){
     Text(if(d.getBoolean("ownerRequired"))"收据标记需所有者" else "自动建议收据",style=MaterialTheme.typography.titleMedium)
     Text("决定延迟："+measured(d,"decisionLatencyMs")+" ms · 排队："+measured(d,"queueWaitMs")+" ms")
     Text("未执行 · 查看决定来源与依据")
    }}}
    if(monitorObjects(window.optJSONArray("decisions")).isEmpty())Text("此窗口没有决定收据；无法据此判断是否需要所有者。")
   }
  }
  TextButton(onClick={technical=!technical}){Text(if(technical)"收起技术详情" else "技术详情")}
  if(technical){Text(graph?.raw?.toString(2) ?: "NOT_OBSERVABLE: 图不可用",style=MaterialTheme.typography.bodySmall);Text(decisions?.optJSONObject("metrics")?.toString(2) ?: "NOT_OBSERVABLE: 指标不可用",style=MaterialTheme.typography.bodySmall)}
 }
 selected?.let{(kind,id)->
  ModalBottomSheet(onDismissRequest={selected=null}){
   Column(Modifier.fillMaxWidth().heightIn(max=560.dp).verticalScroll(rememberScrollState()).padding(20.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
    Text(when(kind){"node"->"任务 / 设备详情";"edge"->"工作路线";"decision"->"决定来源";else->"规范证据"},style=MaterialTheme.typography.titleLarge)
    when(kind){
     "node"->{val node=graph?.nodes?.find{it.optString("id")==id};if(node==null)Text("此节点已不在当前窗口；状态未知。") else {
      Text(monitorNodeLabel(node)+" · "+monitorState(node.optString("state")))
      Text("设备引用："+node.optString("hostRef").takeIf{it.isNotBlank()&&it!="null"}.orEmpty().ifBlank{"未报告"})
      Text("模型 / 提供者 / 所有者元数据：未报告")
      monitorObjects(node.optJSONArray("riskReasons")).forEach{r->Text(monitorRisk(r.optString("code")));r.optString("evidenceRef").takeIf{it.isNotBlank()&&it!="null"}?.let{ref->Button(onClick={selected="evidence" to ref}){Text("查看风险证据")}}}
      graph?.edges?.filter{it.optString("from")==id||it.optString("to")==id}?.forEach{edge->OutlinedButton(onClick={selected="edge" to edge.getString("id")}){Text("查看设备分配路线")}}
      OutlinedButton(onClick={selected="evidence" to id}){Text("查看节点投影")}
     }}
     "edge"->{val edge=graph?.edges?.find{it.optString("id")==id};if(edge==null)Text("此路线已不在当前窗口；状态未知。") else {
      Text("依据：规范任务中记录的设备分配。");Text("开始时间："+measured(edge,"timestamp")+" · 持续时间："+measured(edge,"durationMs"))
      Text("相关事件仅表示同一任务的已观测事件，不推断它们是分配原因。")
      val refs=edge.optJSONArray("evidenceRefs");if(refs==null||refs.length()==0)Text("未报告相关事件证据。") else for(i in 0 until refs.length()){val ref=refs.getString(i);OutlinedButton(onClick={selected="evidence" to ref}){Text("查看相关事件 "+(i+1))}}
      Text(edge.toString(2),style=MaterialTheme.typography.bodySmall)
     }}
     "decision"->{val d=monitorObjects(decisions?.optJSONObject("window")?.optJSONArray("decisions")).find{it.optString("decisionId")==id};if(d==null)Text("此收据已不在当前窗口。") else {
      Text("来源："+mapOf("RULE" to "确定性规则","FAST_MODEL" to "快速模型","CRITIC" to "审查模型","OWNER" to "所有者边界")[d.optString("source")].orEmpty().ifBlank{"未报告"})
      Text("规范状态前："+monitorState(d.optString("preState"))+" · 后："+monitorState(d.optString("postState")))
      Text("应用状态：仅记录，未执行。需所有者标记是历史建议，不是当前审批队列。")
      if(monitorObjects(d.optJSONArray("evidenceRefs")).isEmpty())Text("没有收据内事件引用；未虚构证据。提交触发可用规范事件中的 decisionId 反向关联。")
      Text(d.toString(2),style=MaterialTheme.typography.bodySmall)
     }}
     else->Text(graph?.evidence(id)?.toString(2) ?: "NOT_OBSERVABLE: 当前证据不可用",style=MaterialTheme.typography.bodySmall)
    }
    OutlinedButton(onClick={selected=null}){Text("返回总览")}
   }
  }
 }
}
