package city.utopia.control

import android.content.Context
import org.json.JSONObject
import java.util.UUID

data class NativeEnrollment(val cityId:String, val installationId:String, val instanceId:String, val deviceId:String,
 val credentialId:String, val credentialSecret:String, val displayName:String, val sessionCredential:String) {
 fun sessionBody()=JSONObject().put("installationId",installationId).put("instanceId",instanceId).put("credentialId",credentialId).put("credentialSecret",credentialSecret)
 fun installationPayload()=JSONObject().put("deviceId",deviceId).put("instanceId",instanceId).put("displayName",displayName).put("platform","android")
 override fun toString()="NativeEnrollment(city=$cityId, installation=$installationId, secrets=REDACTED)"
}

private fun requiredNativeText(value:JSONObject,key:String):String {
 require(!value.isNull(key)) { "Enrollment missing $key" }
 val text=value.getString(key); require(text.isNotBlank() && text!="null") { "Enrollment missing $key" }; return text
}
fun parseNativeEnrollment(reply:JSONObject,expectedCity:String,expectedInstance:String):NativeEnrollment {
 require(requiredNativeText(reply,"cityId")==expectedCity) { "City identity conflict" }
 val e=reply.getJSONObject("enrollment")
 val session=requiredNativeText(e.optJSONObject("session") ?: reply,"credential");require(session.startsWith("sess:") && session.length>5) { "Member session required; owner-token fallback refused" }
 require(requiredNativeText(e,"instanceId")==expectedInstance) { "Installation instance conflict" }
 return NativeEnrollment(expectedCity,requiredNativeText(e,"installationId"),expectedInstance,requiredNativeText(e,"deviceId"),requiredNativeText(e,"credentialId"),requiredNativeText(e,"credentialSecret"),requiredNativeText(e,"displayName"),session)
}
fun joinInputReady(relay:Boolean,address:String,code:String,name:String,busy:Boolean)=!busy && name.trim().length in 1..64 && !name.any { it.code<32 || it.code==127 } && RelayDial.target(address)!=null && (relay || code.matches(Regex("[0-9]{6}")))
fun newNativeIdentity(prefix:String)=prefix+UUID.randomUUID().toString().replace("-","")

/** Durable secrets stay in app-private preferences and are bound to the exact City and origin. */
class NativeEnrollmentStore(context:Context) {
 private val prefs=context.getSharedPreferences("city-connection",Context.MODE_PRIVATE)
 fun pendingIdentity():Pair<String,String> {
  val device=prefs.getString("pendingDeviceId",null)?.takeIf { it.matches(Regex("dev-[a-f0-9]{32}")) } ?: newNativeIdentity("dev-")
  val instance=prefs.getString("pendingInstanceId",null)?.takeIf { it.matches(Regex("inst-[a-f0-9]{32}")) } ?: newNativeIdentity("inst-")
  check(prefs.edit().putString("pendingDeviceId",device).putString("pendingInstanceId",instance).commit())
  return device to instance
 }
 fun save(origin:String,record:NativeEnrollment) {
  check(prefs.edit().putString("host",endpoint(origin)).putString("enrollmentEndpoint",endpoint(origin)).putString("cityId",record.cityId)
   .putString("installationId",record.installationId).putString("instanceId",record.instanceId).putString("deviceId",record.deviceId)
   .putString("credentialId",record.credentialId).putString("credentialSecret",record.credentialSecret).putString("deviceName",record.displayName)
   .putString("clientRef",record.deviceId).putString("token",record.sessionCredential).putBoolean("installationRetired",false).commit())
 }
 fun read(origin:String,cityId:String?):NativeEnrollment? {
  if(prefs.getString("enrollmentEndpoint",null)!=origin || prefs.getString("cityId",null)!=cityId)return null
  return runCatching {
   fun field(k:String)=prefs.getString(k,null)?.takeIf { it.isNotBlank() } ?: error("Missing native enrollment")
   NativeEnrollment(field("cityId"),field("installationId"),field("instanceId"),field("deviceId"),field("credentialId"),field("credentialSecret"),field("deviceName"),prefs.getString("token","")?:"")
  }.getOrNull()
 }
 fun retired()=prefs.getBoolean("installationRetired",false)
 fun saveSession(session:String) { require(session.startsWith("sess:"));check(prefs.edit().putString("token",session).commit()) }
 fun markRetired() { check(prefs.edit().putBoolean("installationRetired",true).putString("token","").remove("pendingDeviceId").remove("pendingInstanceId").commit()) }
 fun clear() { val edit=prefs.edit();listOf("enrollmentEndpoint","installationId","instanceId","deviceId","credentialId","credentialSecret","deviceName","installationRetired").forEach { edit.remove(it) };check(edit.commit()) }
}
