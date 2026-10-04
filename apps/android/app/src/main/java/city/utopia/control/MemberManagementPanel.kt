package city.utopia.control

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import city.utopia.control.ui.TechnicalDetails
import kotlinx.coroutines.delay
import org.json.JSONObject

class MemberManagementState(val cityId:String) {
 val fence=CallbackFence()
 val pending=mutableStateMapOf<String,Boolean>()
 var loading by mutableStateOf(false)
 var readReady by mutableStateOf(false)
 var installationEnvelope by mutableStateOf<JSONObject?>(null)
 var messages by mutableStateOf<List<MemberMessage>?>(null)
 var readError by mutableStateOf("")
 var actionError by mutableStateOf("")
 var notice by mutableStateOf("")
 var nameDraft by mutableStateOf("")
 var nameDirty by mutableStateOf(false)
 var revokeId by mutableStateOf<String?>(null)
 var messageTarget by mutableStateOf<String?>(null)
 var messageText by mutableStateOf("")
 fun connectivityChanged() { fence.invalidate();loading=false;readReady=false;pending.clear() }
 fun view(snapshot:JSONObject?):MemberManagementProjection?=snapshot?.let { runCatching { MemberManagementProjection.from(it,installationEnvelope ?: JSONObject()) }.getOrNull() }
 fun refresh(client:CityClient,snapshot:JSONObject) {
  if(loading || snapshot.optString("cityId")!=cityId) return
  val ticket=fence.ticket() ?: return
  loading=true
  client.memberManagement { response -> if(fence.accepts(ticket)) {
   loading=false
   val envelope=response.optJSONObject("installations")
   installationEnvelope=envelope
   val projection=envelope?.let { runCatching { MemberManagementProjection.from(snapshot,it) }.getOrNull() }
   readError=when { envelope?.has("error")==true->envelope.optString("error");projection?.scope==null || projection.scope==ManagementScope.UNKNOWN->"身份权限未报告或与城市不一致，请刷新。";else->"" }
   readReady=readError.isBlank()
   val messageEnvelope=response.optJSONObject("messages")
   val array=messageEnvelope?.optJSONArray("messages")
   val parsed=runCatching {
    require(messageEnvelope!=null && !messageEnvelope.has("error") && array!=null && projection?.actorRef!=null) { messageEnvelope?.optString("error")?.takeIf { it.isNotBlank() } ?: "消息状态未报告。" }
    val result=(0 until array.length()).map { MemberMessage.from(array.getJSONObject(it)) }
    require(result.map { it.id }.distinct().size==result.size && result.all { it.senderDeviceId==projection.actorRef || it.targetDeviceId==projection.actorRef }) { "消息权限范围不一致。" }
    result
   }
   messages=parsed.getOrNull()
   if(parsed.isFailure) readError=listOf(readError,parsed.exceptionOrNull()?.message.orEmpty()).filter { it.isNotBlank() }.joinToString(" · ")
  } }
 }
 fun act(key:String,submit:((JSONObject)->Unit)->Unit,done:(JSONObject)->Unit={}) {
  if(pending[key]==true || !readReady) return
  val ticket=fence.ticket() ?: return
  pending[key]=true;actionError="";notice=""
  submit { result -> if(fence.accepts(ticket)) {
   pending.remove(key)
   if(result.has("error")) {
    actionError=result.optString("error")
    if(key=="send" && result.isNull("httpStatus")) actionError+=" · 请求结果未确认，请刷新核对；再次发送可能产生第二条消息。"
   } else done(result)
  } }
 }
}

@Composable fun MemberManagementRefresh(state:MemberManagementState,client:CityClient?,snapshot:JSONObject?,online:Boolean) {
 val lifecycle=LocalLifecycleOwner.current.lifecycle
 LaunchedEffect(state,client,online,snapshot?.optString("updatedAt")) {
  if(online && client!=null && snapshot!=null) state.refresh(client,snapshot)
 }
 LaunchedEffect(state,client,online) {
  if(online && client!=null && snapshot!=null) while(true) { state.refresh(client,snapshot);delay(3000) }
 }
 DisposableEffect(state,client,online,snapshot,lifecycle) {
  val observer=LifecycleEventObserver { _,event -> if(event==Lifecycle.Event.ON_RESUME && online && client!=null && snapshot!=null) state.refresh(client,snapshot) }
  lifecycle.addObserver(observer);onDispose { lifecycle.removeObserver(observer) }
 }
}

@Composable private fun ManagementFeedback(state:MemberManagementState,online:Boolean) {
 if(!online) Text("离线缓存 · 连接城市后才能进行操作。")
 if(state.readError.isNotBlank()) Text(state.readError)
 if(state.actionError.isNotBlank()) Text(state.actionError)
 if(state.notice.isNotBlank()) Text(state.notice)
}

@Composable fun CityManagementSettings(state:MemberManagementState,client:CityClient?,snapshot:JSONObject?,online:Boolean,onSelfRevoked:()->Unit) {
 MemberManagementRefresh(state,client,snapshot,online)
 val view=state.view(snapshot)
 val live=online && client!=null && state.readReady
 LaunchedEffect(view?.cityName) { if(!state.nameDirty) state.nameDraft=view?.cityName.orEmpty() }
 Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
  Text("城市与设备身份",style=MaterialTheme.typography.titleMedium)
  ManagementFeedback(state,online)
  Text(when(view?.scope) { ManagementScope.OWNER->"城市管理员控制 · 操作代表城市主机，不代表这部手机的入网身份";ManagementScope.SESSION->"已入网设备 · 只能管理本机安装";else->"权限尚未核实" })
  OutlinedButton(onClick={if(client!=null && snapshot!=null)state.refresh(client,snapshot)},enabled=online && client!=null && !state.loading) { Text("刷新身份与消息") }
  OutlinedTextField(state.nameDraft,{state.nameDraft=it;state.nameDirty=true},label={Text("城市名称")},enabled=live && view?.canRename==true && state.pending["rename"]!=true,modifier=Modifier.fillMaxWidth())
  if(view?.scope==ManagementScope.SESSION) Text("入网会话不能重命名城市，请由城市管理员修改。")
  Button(onClick={
   val name=state.nameDraft.trim()
   if(name.isBlank() || name.length>64) { state.actionError="请输入 1–64 字的城市名称。";return@Button }
   if(client!=null)state.act("rename",{done->client.renameCity(name,done)}) { state.nameDirty=false;state.notice="城市名称已更新。" }
  },enabled=live && view?.canRename==true && state.pending["rename"]!=true) { Text("保存城市名称") }
  if(view?.scope==ManagementScope.UNKNOWN) Text("安装列表尚未取得合法权限范围。")
  else if(view?.installations?.isEmpty()==true) Text("暂无已入网安装。")
  view?.installations?.forEach { installation ->
   Text(installation.displayName+(if(installation.installationId==view.currentInstallationId) " · 本机安装" else ""))
   Text(when(installation.state) { "BOUND"->"已绑定";"UNBOUND"->"未绑定";"RETIRED"->"已撤销";"QUARANTINED"->"已隔离";else->"安装状态未报告" })
   OutlinedButton(onClick={state.revokeId=installation.installationId},enabled=live && view.canRevoke(installation.installationId) && state.pending["revoke"]!=true) { Text(if(installation.installationId==view.currentInstallationId) "离开城市并撤销本机安装" else "撤销此安装") }
   TechnicalDetails(listOf("安装" to installation.installationId,"设备" to installation.deviceId.orEmpty()),title="身份详情")
  }
 } }
 state.revokeId?.let { id ->
  val target=view?.installations?.firstOrNull { it.installationId==id }
  AlertDialog(onDismissRequest={if(state.pending["revoke"]!=true)state.revokeId=null},title={Text("撤销设备入网？")},text={Text("${target?.displayName ?: "该设备"} 的安装凭据和会话将失效，需要重新入网。")},confirmButton={
   TextButton(onClick={
    val self=view?.scope==ManagementScope.SESSION && id==view.currentInstallationId
    if(client!=null)state.act("revoke",{done->client.revokeInstallation(id,done)}) {
     state.revokeId=null;state.readReady=false;state.notice="安装已撤销。"
     if(self)onSelfRevoked() else if(snapshot!=null)state.refresh(client,snapshot)
    }
   },enabled=live && view?.canRevoke(id)==true && state.pending["revoke"]!=true) { Text("确认撤销") }
  },dismissButton={TextButton(onClick={state.revokeId=null},enabled=state.pending["revoke"]!=true) { Text("取消") }})
 }
}

private fun reported(flag:Boolean?,yes:String,no:String)=when(flag) { true->yes;false->no;null->"未报告" }
private fun roleLabel(role:String?)=when(role) { "PRIMARY"->"城市承载主机";"MEMBER"->"入网成员主机";"CONTROL_ONLY"->"控制端";"COMPUTE_NODE"->"计算设备";else->"角色未报告" }

@Composable fun CityMembersPanel(state:MemberManagementState,client:CityClient?,snapshot:JSONObject?,online:Boolean,onComputeDetail:(String)->Unit) {
 MemberManagementRefresh(state,client,snapshot,online)
 val view=state.view(snapshot)
 val live=online && client!=null && state.readReady
 Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
  Text("同城所有设备",style=MaterialTheme.typography.titleMedium)
  ManagementFeedback(state,online)
  if(view?.scope==ManagementScope.OWNER) Text("管理员操作代表城市主机；这部手机没有独立入网身份。")
  if(view?.membersReported!=true) Text("成员列表尚未报告。")
  else if(view.members.isEmpty()) Text("此城市未报告成员。")
  view?.members?.forEach { member ->
   HorizontalDivider()
   Text(member.displayName+(if(member.deviceId==view.localDeviceRef) " · 本机" else ""),style=MaterialTheme.typography.titleMedium)
   Text(roleLabel(member.role))
   Text("设备连接："+reported(member.online,"在线","离线")+" · 计算代理："+reported(member.computeOnline,"在线","离线"))
   Text("资源共享："+reported(member.sharingEnabled,"已开启","已暂停"))
   if(view.canToggleSharing(member)) OutlinedButton(onClick={
    if(client!=null)state.act("sharing",{done->client.setSharing(member.nodeId!!,member.sharingEnabled!=true,done)}) { state.notice="共享设置已提交，以城市最新状态为准。" }
   },enabled=live && state.pending["sharing"]!=true) { Text(if(member.sharingEnabled==true) { if(view.localDeviceRef==member.deviceId) "停止共享本机资源" else "停止共享城市主机资源" } else { if(view.localDeviceRef==member.deviceId) "开启本机资源共享" else "开启城市主机资源共享" }) }
   if(member.nodeId!=null) OutlinedButton(onClick={onComputeDetail(member.nodeId)}) { Text("查看计算设备详情") }
   if(member.deviceId!=view.actorRef) OutlinedButton(onClick={state.messageTarget=member.deviceId;state.messageText=""},enabled=live && view.actorRef!=null && state.pending["send"]!=true) { Text("向此设备发消息") }
   TechnicalDetails(listOf("设备" to member.deviceId,"计算节点" to member.nodeId.orEmpty()),title="设备身份详情")
  }
  Text("设备消息与回执",style=MaterialTheme.typography.titleMedium)
  if(state.messages==null) Text("消息记录尚未报告。")
  else if(state.messages!!.isEmpty()) Text("暂无本身份的设备消息。")
  state.messages?.forEach { message ->
   val sender=view?.members?.firstOrNull { it.deviceId==message.senderDeviceId }?.displayName ?: "城市设备"
   val target=view?.members?.firstOrNull { it.deviceId==message.targetDeviceId }?.displayName ?: "城市设备"
   Text("$sender → $target")
   Text(message.text)
   Text(when(message.state) { "PENDING"->"等待接收回执";"RECEIVED"->"已确认接收";else->"回执状态未报告" })
   if(view?.canReceipt(message)==true) OutlinedButton(onClick={
    if(client!=null)state.act("receipt:"+message.id,{done->client.receiveMemberMessage(message.id,done)}) { response ->
     val changed=response.optJSONObject("message")?.let { runCatching { MemberMessage.from(it) }.getOrNull() }
     if(changed!=null)state.messages=state.messages?.map { if(it.id==changed.id)changed else it }
    }
   },enabled=live && state.pending["receipt:"+message.id]!=true) { Text("确认收到") }
  }
 } }
 state.messageTarget?.let { targetRef ->
  val target=view?.members?.firstOrNull { it.deviceId==targetRef }
  AlertDialog(onDismissRequest={if(state.pending["send"]!=true)state.messageTarget=null},title={Text("发送到 ${target?.displayName ?: "城市设备"}")},text={Column {
   if(target?.online==false)Text("设备当前离线，提交后等待上线与回执。")
   OutlinedTextField(state.messageText,{state.messageText=it},label={Text("设备消息")},enabled=state.pending["send"]!=true)
   if(state.actionError.isNotBlank())Text(state.actionError)
  }},confirmButton={TextButton(onClick={
   val text=state.messageText.trim()
   if(text.isBlank() || text.length>4096) { state.actionError="请输入 1–4096 字的消息。";return@TextButton }
   if(client!=null)state.act("send",{done->client.sendMemberMessage(targetRef,text,done)}) { response ->
    val sent=response.optJSONObject("message")?.let { runCatching { MemberMessage.from(it) }.getOrNull() }
    if(sent!=null)state.messages=(state.messages.orEmpty().filter { it.id!=sent.id }+sent)
    state.messageTarget=null;state.messageText="";state.notice="消息已提交，等待设备接收回执。"
   }
  },enabled=live && target!=null && state.pending["send"]!=true) { Text("发送") }},dismissButton={TextButton(onClick={state.messageTarget=null},enabled=state.pending["send"]!=true) { Text("取消") }})
 }
}
