package city.utopia.control

import org.json.JSONObject

private fun JSONObject.text(key:String,limit:Int=256):String?=(opt(key) as? String)?.takeIf { it.isNotBlank() && it!="null" && it.length<=limit }
private fun JSONObject.flag(key:String):Boolean?=opt(key) as? Boolean

enum class ManagementScope { OWNER,SESSION,UNKNOWN }
data class CityMember(val deviceId:String,val displayName:String,val role:String?,val nodeId:String?,val online:Boolean?,val computeOnline:Boolean?,val sharingEnabled:Boolean?)
data class InstallationSummary(val installationId:String,val deviceId:String?,val displayName:String,val state:String?,val rebindRequired:Boolean?)
data class MemberMessage(val id:String,val senderDeviceId:String,val targetDeviceId:String,val text:String,val state:String?,val createdAt:String?,val receivedAt:String?) {
 companion object {
  fun from(raw:JSONObject):MemberMessage=MemberMessage(
   requireNotNull(raw.text("id")),requireNotNull(raw.text("senderDeviceId")),requireNotNull(raw.text("targetDeviceId")),requireNotNull(raw.text("text",4096)),raw.text("state"),raw.text("createdAt"),raw.text("receivedAt")
  )
 }
}

/** Whitelisted display projection. Backend scope remains authority; names never identify self. */
data class MemberManagementProjection(val cityId:String?,val cityName:String?,val scope:ManagementScope,val actorRef:String?,val localDeviceRef:String?,val currentInstallationId:String?,val members:List<CityMember>,val membersReported:Boolean,val installations:List<InstallationSummary>) {
 val canRename:Boolean get()=scope==ManagementScope.OWNER
 fun canRevoke(id:String):Boolean=installations.any { it.installationId==id && it.state in setOf("BOUND","UNBOUND","QUARANTINED") } && (scope==ManagementScope.OWNER || scope==ManagementScope.SESSION && id==currentInstallationId)
 fun canToggleSharing(member:CityMember):Boolean=actorRef!=null && member.deviceId==actorRef && member.nodeId==actorRef && member.sharingEnabled!=null && scope!=ManagementScope.UNKNOWN
 fun canReceipt(message:MemberMessage):Boolean=scope!=ManagementScope.UNKNOWN && actorRef!=null && message.targetDeviceId==actorRef && message.state=="PENDING"
 companion object {
  fun from(snapshot:JSONObject,installationEnvelope:JSONObject):MemberManagementProjection {
   val enrolled=snapshot.optJSONObject("enrolledDevice")
   val ownInstallation=enrolled?.text("installationId")
   val boundRef=enrolled?.text("deviceId")?.takeIf { snapshot.text("currentMemberRef")==it }
   val array=installationEnvelope.optJSONArray("installations")
   val summaries=if(array==null) emptyList() else (0 until array.length()).mapNotNull { i ->
    val row=array.optJSONObject(i) ?: return@mapNotNull null
    val id=row.text("installationId") ?: return@mapNotNull null
    InstallationSummary(id,row.text("deviceId"),row.text("displayName",128) ?: "未命名设备",row.text("state"),row.flag("rebindRequired"))
   }
   val cityMatches=snapshot.text("cityId")!=null && snapshot.text("cityId")==installationEnvelope.text("cityId") && !installationEnvelope.has("error")
   val scope=when {
    cityMatches && installationEnvelope.text("scope")=="CITY" && snapshot.has("enrolledDevice") && snapshot.isNull("enrolledDevice") && array!=null && summaries.size==array.length() && summaries.map { it.installationId }.distinct().size==summaries.size -> ManagementScope.OWNER
    cityMatches && installationEnvelope.text("scope")=="OWN_INSTALLATION" && ownInstallation!=null && boundRef!=null && array?.length()==1 && summaries.size==1 && summaries[0].installationId==ownInstallation && summaries[0].deviceId==boundRef -> ManagementScope.SESSION
    else -> ManagementScope.UNKNOWN
   }
   val actor=when(scope) { ManagementScope.OWNER->snapshot.text("hostDeviceId");ManagementScope.SESSION->boundRef;else->null }
   val memberArray=snapshot.optJSONArray("members")
   val members=if(memberArray==null) emptyList() else (0 until memberArray.length()).mapNotNull { i ->
    val row=memberArray.optJSONObject(i) ?: return@mapNotNull null
    val id=row.text("deviceId") ?: return@mapNotNull null
    CityMember(id,row.text("displayName",128) ?: "未命名设备",row.text("role"),row.text("nodeId"),row.flag("online"),row.flag("computeOnline"),row.flag("sharingEnabled"))
   }
   require(memberArray==null || memberArray.length()==members.size) { "成员列表包含未报告的设备身份" }
   require(members.map { it.deviceId }.distinct().size==members.size) { "重复设备身份，需刷新城市状态" }
   return MemberManagementProjection(snapshot.text("cityId"),snapshot.text("displayName",128),scope,actor,boundRef,ownInstallation,members.sortedWith(compareBy<CityMember> { it.deviceId!=boundRef }.thenBy { it.displayName.lowercase() }.thenBy { it.deviceId }),memberArray!=null,if(scope==ManagementScope.UNKNOWN) emptyList() else summaries)
  }
 }
}
