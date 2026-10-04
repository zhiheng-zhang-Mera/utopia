package city.utopia.control

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.Locale

@Composable
fun DeviceRecoveryPanel(client: CityClient?, host: String, connectionMessage: String, onFindCity: () -> Unit) {
 val context=LocalContext.current
 val chinese=Locale.getDefault().language=="zh"
 var state by remember(client) { mutableStateOf<DeviceRecoveryState?>(null) }
 var loading by remember(client) { mutableStateOf(false) }
 var launchError by remember { mutableStateOf("") }
 var technical by remember { mutableStateOf(false) }
 val load = { if(!loading) { loading=true; client?.installations { result -> state=parseRecoveryState(result); loading=false } ?: run { loading=false } } }
 LaunchedEffect(client) { load() }
 val current=state ?: DeviceRecoveryState(false,emptyList(),emptyList(),null,connectionMessage.takeIf { it.contains("UNBOUND",true) || it.contains("CLONE",true) })
 val url=ownerSettingsUrl(host)
 Panel {
  Text(if(chinese) "设备恢复" else "Device recovery",fontWeight=FontWeight.Bold)
  Text(recoveryMessage(current,chinese),fontSize=13.sp)
  if(loading) Text(if(chinese) "正在读取安装状态…" else "Reading installation state…")
  if(current.cloneReasons.isNotEmpty()) Text(if(chinese) "安全提示：请核对设备身份冲突。" else "Security warning: verify conflicting device identities.")
  current.installations.forEach { installation ->
   Text((installation.name.ifBlank { if(chinese) "安装实例" else "Installation" })+" · "+installation.state,fontSize=12.sp)
  }
  if(current.error!=null) Text(current.error.orEmpty(),fontSize=12.sp)
  OutlinedButton(onClick={load()},enabled=client!=null&&!loading) { Text(if(chinese) "刷新安装状态" else "Refresh installation state") }
  OutlinedButton(onClick={launchError="";runCatching { context.startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(url))) }.onFailure { launchError=if(chinese) "无法打开浏览器，请在城市所有者主机上打开 Web 设置。" else "Browser could not open. Open Web Settings on the City owner's computer." }},enabled=url!=null) { Text(if(chinese) "打开所有者 Web 设置" else "Open owner Web Settings") }
  if(url==null) Text(if(chinese) "请先连接有效的城市地址。" else "Connect a valid City URL first.",fontSize=12.sp)
  if(launchError.isNotBlank()) Text(launchError,fontSize=12.sp)
  if(current.needsRecovery||current.error!=null) OutlinedButton(onClick=onFindCity) { Text(if(chinese) "返回寻找城市 / 重新连接" else "Find City / reconnect") }
  TextButton(onClick={technical=!technical}) { Text(if(chinese) "身份详情" else "Identity details") }
  if(technical) {
   current.installations.forEach { Text(it.id+" · "+it.deviceId.orEmpty(),fontSize=11.sp) }
   current.cloneReasons.forEach { Text(it,fontSize=11.sp) }
   current.errorCode?.let { Text(it,fontSize=11.sp) }
  }
 }
}
