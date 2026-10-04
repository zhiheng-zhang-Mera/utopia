package city.utopia.control

import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.time.Instant
import java.security.MessageDigest

/** Hoisted above navigation. Stores only bounded, expiring invitation material. */
class OwnerOnboardingState(cityId:String,host:String,credential:String,private val prefs:SharedPreferences) {
 val pairing=OwnerPairingLifecycle(cityId,host)
 val fence=CallbackFence()
 var revision by mutableIntStateOf(0)
 var loading by mutableStateOf(false)
 var error by mutableStateOf("")
 var generationError by mutableStateOf("")
 var joinsError by mutableStateOf("")
 var decisionError by mutableStateOf("")
 var requests by mutableStateOf<List<JSONObject>?>(null)
 val pending=mutableStateMapOf<String,Boolean>()
 val scope=MessageDigest.getInstance("SHA-256").digest((cityId+"\n"+host+"\n"+credential).toByteArray()).joinToString("") { "%02x".format(it) }
 init {
  val stored=runCatching { JSONObject(prefs.getString("temporary-material",null) ?: "{}") }.getOrNull()
  if(stored?.optString("scope")==scope) stored.optJSONObject("material")?.let { pairing.restore(it,Instant.now()) }
  else prefs.edit().remove("temporary-material").apply()
 }
 fun persist() {
  val value=pairing.persisted(Instant.now())
  if(value==null) prefs.edit().remove("temporary-material").apply()
  else prefs.edit().putString("temporary-material",JSONObject().put("scope",scope).put("material",value).toString()).apply()
  revision++
 }
 fun connectivityChanged() {
  fence.invalidate();loading=false;pending.clear();requests=null
  pairing.failedGeneration();revision++
 }
 fun refresh(client:CityClient) {
  if(loading) return
  val ticket=fence.ticket() ?: return
  loading=true
  client.ownerOnboarding { result -> if(fence.accepts(ticket)) {
   loading=false
   val info=result.optJSONObject("pairing")
   error=runCatching {
    require(info!=null && !info.has("error")) { info?.optString("error") ?: "Pairing status not reported" }
    pairing.reconcile(info,Instant.now())
   }.exceptionOrNull()?.message ?: ""
   if(error.isNotBlank()) pairing.unknown()
   val joins=result.optJSONObject("joins")
   val array=joins?.optJSONArray("requests")
   joinsError=if(joins==null || joins.has("error") || array==null) joins?.optString("error")?.takeIf { it.isNotBlank() } ?: "Incoming requests not reported" else ""
   requests=if(array==null || joinsError.isNotBlank()) null else (0 until array.length()).mapNotNull { array.optJSONObject(it) }
   persist()
  } }
 }
 fun generate(client:CityClient) {
  val state=pairing.beginGenerate(Instant.now()) ?: return
  val ticket=fence.ticket() ?: return
  generationError="";revision++
  client.generateOwnerPairing(state) { response -> if(fence.accepts(ticket)) {
   generationError=runCatching {
    require(!response.has("error")) { response.optString("error") }
    pairing.generated(response,Instant.now())
   }.exceptionOrNull()?.message ?: ""
   if(generationError.isNotBlank()) pairing.failedGeneration()
   persist();refresh(client)
  } }
 }
 fun decide(client:CityClient,id:String,approve:Boolean) {
  if(pending[id]==true || requests?.any { it.optString("id")==id && it.optString("state")=="PENDING" }!=true) return
  val ticket=fence.ticket() ?: return
  pending[id]=true;decisionError=""
  client.decideJoin(id,approve) { response -> if(fence.accepts(ticket)) {
   if(response.has("error")) decisionError=response.optString("error")
   else if(response.optString("id")==id) requests=requests?.map { if(it.optString("id")==id) response else it }
   pending.remove(id)
   refresh(client)
  } }
 }
}

@Composable fun OwnerOnboardingPanel(state:OwnerOnboardingState,client:CityClient?,online:Boolean,displayName:String,now:Instant) {
 val context=LocalContext.current
 val lifecycle=LocalLifecycleOwner.current.lifecycle
 // Revision makes non-Compose pure lifecycle mutations visible without teaching it UI state.
 val revision=state.revision
 val material=state.pairing.visibleMaterial(now)
 LaunchedEffect(state,client,online) {
  if(!online) return@LaunchedEffect
  if(client!=null) while(true) { state.refresh(client);delay(2000) }
 }
 DisposableEffect(state,client,online,lifecycle) {
  val observer=LifecycleEventObserver { _,event -> if(event==Lifecycle.Event.ON_RESUME && online && client!=null) state.refresh(client) }
  lifecycle.addObserver(observer)
  onDispose { lifecycle.removeObserver(observer) }
 }
 Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
  Text("邀请设备加入 · $displayName",style=MaterialTheme.typography.titleMedium)
  if(!online || client==null) Text("连接城市后可生成配对码并审批入网。")
  else {
   if(state.error.isNotBlank()) Text(state.error)
   if(state.generationError.isNotBlank()) Text(state.generationError)
   OutlinedButton(onClick={state.refresh(client)},enabled=!state.loading) { Text("刷新入网状态") }
   Button(onClick={state.generate(client)},enabled=state.pairing.generationState(now)!=null && !state.loading) { Text(if(state.pairing.busy) "正在生成…" else "生成配对码") }
   if(material==null) Text("有效会话期间不会自动更换配对码。若其他设备已生成，请在那里分享，或等待过期后刷新。")
   else {
    Text("配对码：${material.shortCode}",style=MaterialTheme.typography.headlineSmall)
    Text("剩余 ${java.time.Duration.between(now,material.expiresAt).seconds.coerceAtLeast(0)} 秒 · 使用一次")
    val bitmap=remember(material.qrPayload) { runCatching {
     val matrix=MultiFormatWriter().encode(material.qrPayload,BarcodeFormat.QR_CODE,360,360)
     Bitmap.createBitmap(360,360,Bitmap.Config.ARGB_8888).also { bmp ->
      val pixels=IntArray(360*360) { index -> if(matrix[index%360,index/360]) android.graphics.Color.BLACK else android.graphics.Color.WHITE }
      bmp.setPixels(pixels,0,360,0,0,360,360)
     }
    } }
    bitmap.onSuccess { Image(it.asImageBitmap(),contentDescription="临时入网二维码",modifier=Modifier.size(240.dp)) }
    if(bitmap.isFailure) Text("二维码无法显示；可使用短码或分享邀请链接。")
    OutlinedButton(onClick={
     val fresh=state.pairing.visibleMaterial(Instant.now())
     if(fresh==null) { state.error="配对会话已失效，请刷新。";return@OutlinedButton }
     runCatching { context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type="text/plain";putExtra(Intent.EXTRA_TEXT,fresh.inviteUrl) },"分享临时城市邀请")) }.onFailure { state.error="无法打开分享面板，请使用短码。" }
    }) { Text("分享邀请链接") }
   }
   Text("入网申请",style=MaterialTheme.typography.titleMedium)
   if(state.joinsError.isNotBlank()) Text(state.joinsError)
   if(state.decisionError.isNotBlank()) Text(state.decisionError)
   when {
    state.requests==null -> Text("尚未读取入网申请。")
    state.requests!!.isEmpty() -> Text("暂无入网申请。")
    else -> state.requests!!.forEach { request ->
     val id=request.optString("id")
     Text(request.optString("displayName","未命名设备"))
     Text(when(request.optString("state")) { "PENDING"->"待审批";"APPROVED"->"已批准，等待设备完成加入";"REJECTED"->"已拒绝";"EXPIRED"->"已过期";"CONSUMED"->"已完成加入";else->"状态未报告" })
     if(request.optString("state")=="PENDING" && id.isNotBlank()) Row {
      Button(onClick={state.decide(client,id,true)},enabled=state.pending[id]!=true) { Text("批准") }
      OutlinedButton(onClick={state.decide(client,id,false)},enabled=state.pending[id]!=true) { Text("拒绝") }
     }
    }
   }
   Text("邀请只含临时配对材料。跨地区连接仍需可达网络或已有中继；此入口不保证远程连通。",style=MaterialTheme.typography.bodySmall)
  }
 } }
}
