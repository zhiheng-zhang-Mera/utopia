package city.utopia.control
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import city.utopia.control.ui.UtFeedback
import city.utopia.control.ui.UtPanel
import kotlinx.coroutines.delay
import org.json.JSONObject

@Composable fun OwnerControlsPanel(state:CityState,client:CityClient?,kind:String,initialDraft:OwnerControlDraft?=null){
 val online=state.connection=="ONLINE"
 val fence=remember(client,kind){CallbackFence()};DisposableEffect(fence){onDispose{fence.close()}}
 var form by remember(client,kind,initialDraft){mutableStateOf(OwnerControlForm(initialDraft?:OwnerControlDraft(kind)))}
 var view by remember(client,kind){mutableStateOf<OwnerControlView?>(null)}
 var failure by remember(client,kind){mutableStateOf<String?>(null)}
 var busy by remember(client,kind){mutableStateOf(false)}
 var fetching by remember(client,kind){mutableStateOf(false)}
 var nodeMenu by remember(client,kind){mutableStateOf(false)}
 var pendingKey by remember(client,kind){mutableStateOf<String?>(null)}
 var pendingPayload by remember(client,kind){mutableStateOf<String?>(null)}
 val nodes=arrayObjects(state.snapshot?.optJSONArray("nodes"))
 fun load(){if(client==null||!online||fetching||busy)return;val ticket=fence.ticket()?:return;fetching=true
  client.ownerControls(kind){response->if(fence.accepts(ticket)){fetching=false;runCatching{parseOwnerControls(response,kind)}.onSuccess{view=it;failure=it.error}.onFailure{failure=it.message;view=null}}}
 }
 fun mutate(send:((JSONObject)->Unit)->Unit){if(client==null||!online||busy)return;val ticket=fence.ticket()?:return;busy=true;failure=null
  send { response->if(fence.accepts(ticket)){busy=false;form=form.copy(confirmation="");failure=if(response.has("errorCode"))response.optString("errorCode")+": "+response.optString("error") else response.optJSONObject("action")?.takeIf{it.optString("status") in setOf("REFUSED","FAILED","UNAVAILABLE")}?.let { it.optJSONObject("error")?.toString()?:it.optString("status") };load()} }
 }
 LaunchedEffect(client,kind,online){if(!online){fence.invalidate();fetching=false;busy=false;form=form.copy(confirmation="")};while(online){load();delay(2000)}}
 fun edit(next:OwnerControlDraft){form=form.edit(next);pendingKey=null;pendingPayload=null}
 val d=form.draft
 Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(12.dp)){
  Text(if(kind=="REMOTE_OPERATION")"远程执行 / Remote operation" else "Agent 作业 / Agent jobs",style=MaterialTheme.typography.headlineSmall)
  Text("Owner 控制 · DIRECT_CONTROL · Advanced")
  Text(if(view==null)"启用状态未知，请连接并刷新。" else if(view!!.enabled)"本城已启用 / Enabled" else "本城未启用 / Disabled")
  if(!online)UtFeedback("离线时不会派发；恢复连接后请重新确认。",kind="warn")
  failure?.let{UtFeedback(it,kind="error")}
  OutlinedButton(onClick={load()},enabled=online&&!busy&&!fetching&&client!=null){Text(if(fetching)"正在刷新…" else "刷新记录")}
  if(view?.ownerRequired==true)UtFeedback("需要 City Owner 凭据。成员权限不能派发这些任务。",kind="warn")
  view?.let{Text(it.authorityNotice);if(kind=="REMOTE_OPERATION")Text("允许程序: "+it.allowlist.joinToString()+"\n工作区: "+it.workspaces.joinToString())}
  if(d.requestText.isNotBlank())Text("原始请求: "+d.requestText)
  Box{
   OutlinedButton(onClick={nodeMenu=true},enabled=online&&!busy){Text("目标设备: "+(nodes.firstOrNull{it.optString("id")==d.targetDeviceRef}?.optString("displayName")?:d.targetDeviceRef.ifBlank{"请选择"}))}
   DropdownMenu(expanded=nodeMenu,onDismissRequest={nodeMenu=false}){nodes.forEach{node->DropdownMenuItem(text={Text(node.optString("displayName")+if(node.optBoolean("online"))"" else " (离线，任务将等待)")},onClick={edit(d.copy(targetDeviceRef=node.optString("id")));nodeMenu=false})}}
  }
  @Composable fun field(value:String,label:String,multiline:Boolean=false,changed:(String)->Unit){OutlinedTextField(value=value,onValueChange=changed,label={Text(label)},enabled=online&&!busy,singleLine=!multiline,minLines=if(multiline)2 else 1,modifier=Modifier.fillMaxWidth())}
  if(kind=="REMOTE_OPERATION"){
   field(d.executable,"程序 / executable"){edit(d.copy(executable=it))}
   field(d.argvJson,"参数 JSON 数组 / argv",true){edit(d.copy(argvJson=it))}
   field(d.cwd,"工作目录 / cwd"){edit(d.copy(cwd=it))}
   field(d.timeoutMs,"超时毫秒 / timeoutMs"){edit(d.copy(timeoutMs=it))}
   field(d.maxOutputBytes,"输出字节上限 / maxOutputBytes"){edit(d.copy(maxOutputBytes=it))}
  }else{
   field(d.title,"标题 / title"){edit(d.copy(title=it))}
   field(d.instruction,"请求内容 / instruction",true){edit(d.copy(instruction=it))}
   field(d.refs,"输入引用 name=ref（可选）",true){edit(d.copy(refs=it))}
   field(d.deadlineMinutes,"期限分钟 / deadlineMinutes"){edit(d.copy(deadlineMinutes=it))}
  }
  field(d.purpose,"目的 / purpose",true){edit(d.copy(purpose=it))}
  val invalid=ownerControlValidation(d);if(invalid.isNotEmpty())Text("待补齐或修正: "+invalid.joinToString())
  UtPanel{
   Text("确认派发",style=MaterialTheme.typography.titleMedium)
   Text(if(kind=="REMOTE_OPERATION")"这会在所选机器运行真实程序。检查程序、参数、工作目录及目的。" else "这会向所选机器的 Agent 发出真实请求；答复是 Agent 自述。")
   Text("目标: "+d.targetDeviceRef+"\n"+if(kind=="REMOTE_OPERATION")d.executable+" "+d.argvJson+"\n"+d.cwd else d.title+"\n"+d.instruction)
   field(form.confirmation,if(kind=="REMOTE_OPERATION")"输入程序名以确认" else "输入标题以确认"){form=form.copy(confirmation=it)}
   Button(onClick={
    if(form.canDispatch(online,busy,view?.enabled==true)){
     val probe=ownerControlAction(d,"preview").toString()
     if(pendingPayload!=probe){pendingPayload=probe;pendingKey=newIdempotencyKey()}
     val body=ownerControlAction(d,pendingKey?:newIdempotencyKey())
     mutate{done->client?.dispatchOwnerControl(body){response->if(ownerDispatchAnswered(response)){pendingKey=null;pendingPayload=null};done(response)}}
    }
   },enabled=client!=null&&form.canDispatch(online,busy,view?.enabled==true),modifier=Modifier.fillMaxWidth()){Text(if(busy)"正在发送…" else "确认并派发")}
  }
  Text("真实任务记录",style=MaterialTheme.typography.titleMedium)
  view?.rows?.forEach{row->UtPanel{
   Text(row.title+" · "+row.state);Text(row.summary);Text(row.taskId,style=MaterialTheme.typography.bodySmall)
   if(row.error.isNotBlank())UtFeedback(row.error,kind="error")
   if(row.result.isNotBlank())Text("实际返回\n"+row.result)
   if(row.receipt.isNotBlank())Text("回执校验\n"+row.receipt,style=MaterialTheme.typography.bodySmall)
   if(row.collection.isNotBlank())Text("收取状态: "+row.collection)
   if(row.canStop)OutlinedButton(onClick={mutate{done->client?.cancelOwnerControl(row.taskId,done)}},enabled=online&&!busy){Text("停止 / 撤回")}
   if(row.canCollect)OutlinedButton(onClick={mutate{done->client?.collectAgentJob(row.taskId,done)}},enabled=online&&!busy){Text("确认收取 / Collect")}
  }}
 }
}
