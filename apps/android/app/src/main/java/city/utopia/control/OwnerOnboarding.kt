package city.utopia.control

import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder
import java.time.Instant

data class OwnerPairingMaterial(val sessionId:String,val shortCode:String,val expiresAt:Instant,val qrPayload:String,val inviteUrl:String) {
 fun json():JSONObject=JSONObject().put("pairingSessionId",sessionId).put("shortCode",shortCode).put("expiresAt",expiresAt.toString()).put("qrPayload",qrPayload).put("inviteUrl",inviteUrl)
 companion object {
  fun parse(raw:JSONObject,cityId:String,host:String,now:Instant):OwnerPairingMaterial {
   val qr=raw.optString("qrPayload")
   require(qr.length in 1..4096) { "Invalid pairing material" }
   val qrFields=(URI(qr).rawQuery ?: "").split('&').map { it.substringBefore('=') }
   require(qrFields.toSet()==setOf("v","host","city","session","expires","secret") && qrFields.size==6) { "Unexpected pairing fields" }
   val parsed=parseQr(qr,now)
   val origin=endpoint(host)
   require(parsed.cityId==cityId && parsed.endpoint==origin) { "Pairing identity changed" }
   val session=raw.optString("pairingSessionId")
   val code=raw.optString("shortCode")
   val expiry=Instant.parse(raw.getString("expiresAt"))
   require(session==parsed.session && code.matches(Regex("[0-9]{6}")) && expiry==Instant.parse(parsed.expires)) { "Pairing material mismatch" }
   val link=raw.optString("inviteUrl")
   require(link.length in 1..8192) { "Invalid invitation link" }
   val uri=URI(link)
   require(uri.fragment==null && uri.userInfo==null && uri.path=="/") { "Invalid invitation link" }
   require(endpoint("${uri.scheme}://${uri.rawAuthority}")==origin) { "Invitation endpoint changed" }
   val entries=(uri.rawQuery ?: "").split('&').map { it.split('=',limit=2) }
   require(entries.size==1 && entries[0].size==2 && entries[0][0]=="pair") { "Invalid invitation link" }
   val payload="utopia://pair?"+URLDecoder.decode(entries[0][1],"UTF-8")
   require(payload==qr && parseQr(payload,now)==parsed) { "Invitation material changed" }
   return OwnerPairingMaterial(session,code,expiry,qr,link)
  }
 }
}

/** Holds temporary material; every restored secret needs a current canonical match. */
class OwnerPairingLifecycle(private val cityId:String,private val host:String) {
 private var material:OwnerPairingMaterial?=null
 private var canonicalState:String?=null
 private var canonicalSession:String?=null
 var busy:Boolean=false
  private set
 fun unknown() { canonicalState=null;canonicalSession=null }
 fun restore(raw:JSONObject,now:Instant) { material=runCatching { OwnerPairingMaterial.parse(raw,cityId,host,now) }.getOrNull();unknown() }
 fun reconcile(info:JSONObject,now:Instant) {
  unknown()
  val descriptor=info.optJSONObject("descriptor") ?: throw IllegalArgumentException("Pairing status not reported")
  require(descriptor.optString("cityId")==cityId) { "Pairing City changed" }
  val ep=descriptor.optJSONObject("endpoint") ?: throw IllegalArgumentException("Pairing endpoint not reported")
  require(endpoint("${ep.optString("scheme")}://${if(ep.optString("host").contains(':')) "[${ep.optString("host").trim('[',']')}]" else ep.optString("host")}:${ep.optInt("port")}")==endpoint(host)) { "Pairing endpoint changed" }
  val state=info.optString("sessionState")
  require(state in setOf("IDLE","ACTIVE","USED","EXPIRED","LOCKED")) { "Pairing state not reported" }
  require(info.opt("activeSession")== (state=="ACTIVE")) { "Pairing status mismatch" }
  val session=descriptor.opt("pairingSessionId") as? String
  require(state!="ACTIVE" || !session.isNullOrBlank()) { "Active pairing session not reported" }
  canonicalState=state;canonicalSession=session
  if(material?.let { !it.expiresAt.isAfter(now) || state!="ACTIVE" || it.sessionId!=session }==true) material=null
 }
 fun visibleMaterial(now:Instant):OwnerPairingMaterial?=material?.takeIf { canonicalState=="ACTIVE" && canonicalSession==it.sessionId && it.expiresAt.isAfter(now) }
 fun beginGenerate(now:Instant):String? {
  val state=generationState(now) ?: return null
  busy=true
  return state
 }
 fun generationState(now:Instant):String?=canonicalState?.takeIf { !busy && visibleMaterial(now)==null && it in setOf("IDLE","USED","EXPIRED","LOCKED") }
 fun generated(raw:JSONObject,now:Instant) {
  busy=false
  material=OwnerPairingMaterial.parse(raw,cityId,host,now)
  canonicalState="ACTIVE";canonicalSession=material!!.sessionId
 }
 fun failedGeneration() { busy=false;unknown() }
 fun persisted(now:Instant):JSONObject?=material?.takeIf { it.expiresAt.isAfter(now) }?.json()
}
