package city.utopia.control

import org.json.JSONObject
import java.time.Instant

data class SchedulerChoice(val allowed:Boolean,val revision:String?,val reason:String?) {
 companion object {
  fun fromEntry(entry:JSONObject):SchedulerChoice? {
   val choices=entry.optJSONObject("userChoices") ?: return null
   if(choices.optInt("version")!=1 || choices.opt("decisionRequired")!=true) return null
   val alternate=choices.optJSONObject("alternateDevice")
   val revision=alternate?.opt("expectedUpdatedAt") as? String
   val valid=revision!=null && runCatching { Instant.parse(revision) }.isSuccess
   return SchedulerChoice(alternate?.opt("allowed")==true && valid,revision,alternate?.opt("reason") as? String)
  }
 }
}
