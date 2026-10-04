package city.utopia.control

import java.net.URI
import org.json.JSONObject

data class RecoveryInstallation(val id: String, val name: String, val deviceId: String?, val state: String, val required: Boolean)
data class DeviceRecoveryState(val owner: Boolean, val installations: List<RecoveryInstallation>, val cloneReasons: List<String>, val errorCode: String?, val error: String?) {
 val needsRecovery: Boolean get() = installations.any { it.state == "UNBOUND" || it.required } || (errorCode.orEmpty()+" "+error.orEmpty()).contains("UNBOUND",ignoreCase=true)
}
fun parseRecoveryState(body: JSONObject): DeviceRecoveryState {
 val rows=body.optJSONArray("installations")
 val installations=(0 until (rows?.length() ?: 0)).mapNotNull { index -> rows?.optJSONObject(index)?.let { row ->
  RecoveryInstallation(row.optString("installationId"),row.optString("displayName").takeUnless { it=="null" }.orEmpty(),row.optString("deviceId").takeUnless { it.isBlank() || it=="null" },row.optString("state"),row.optBoolean("rebindRequired"))
 } }
 val findings=body.optJSONArray("cloneFindings")
 val reasons=(0 until (findings?.length() ?: 0)).mapNotNull { findings?.optJSONObject(it)?.optString("reason")?.takeIf { reason -> reason.isNotBlank() } }.distinct()
 return DeviceRecoveryState(body.optString("scope")=="CITY",installations,reasons,body.optString("errorCode").takeIf { it.isNotBlank() },body.optString("error").takeIf { it.isNotBlank() })
}
fun recoveryMessage(state: DeviceRecoveryState, chinese: Boolean=false): String = when {
 state.needsRecovery -> if(chinese) "此安装需要恢复绑定。请由城市所有者在 Web 设置中选择原有设备并批准，然后回来重新连接。" else "This installation needs recovery. Ask the City owner to choose the original device and approve recovery in Web Settings, then reconnect here."
 state.cloneReasons.isNotEmpty() -> if(chinese) "发现设备身份冲突。请城市所有者在 Web 设置中核对安装实例；不会自动删除设备。" else "An identity conflict was reported. Ask the City owner to verify installations in Web Settings. No device is removed automatically."
 state.error != null -> if(chinese) "无法读取安装状态。请检查连接；若需要恢复，请城市所有者使用 Web 设置。" else "Installation state could not be read. Check the connection; ask the City owner to use Web Settings if recovery is needed."
 else -> if(chinese) "重新安装或设备身份冲突需要城市所有者批准。可打开 Web 设置处理；此应用不会分享连接凭据。" else "Reinstall or identity recovery requires the City owner. Open Web Settings to approve it; this app does not share connection credentials."
}
fun ownerSettingsUrl(host: String): String? = runCatching {
 val uri=URI(host.trim())
 require(uri.scheme in listOf("http","https") && !uri.host.isNullOrBlank() && uri.userInfo==null && uri.query==null && uri.fragment==null && (uri.path.isNullOrBlank() || uri.path=="/") && (uri.port==-1 || uri.port in 1..65535))
 uri.scheme+"://"+uri.rawAuthority+"/#page=Settings"
}.getOrNull()
