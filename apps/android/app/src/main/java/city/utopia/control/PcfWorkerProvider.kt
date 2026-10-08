package city.utopia.control

/** References an externally provisioned limited worker grant; never issues credentials or device IDs. */
data class PcfWorkerBinding(val cityId:String, val deviceId:String, val controlInstallationId:String,
 val workerInstallationId:String, val workerPrincipalId:String, val credentialHandle:String) {
 init {
  require(listOf(cityId,deviceId,controlInstallationId,workerInstallationId,workerPrincipalId,credentialHandle).all { it.isNotBlank() })
  require(controlInstallationId != workerInstallationId) { "Control installation cannot execute" }
 }
 override fun toString()="PcfWorkerBinding(city=$cityId, device=$deviceId, credentials=REDACTED)"
}
data class PcfWorkerConditions(val foreground:Boolean=true, val batteryPercent:Int=100, val thermalStatus:Int=0,
 val metered:Boolean=false, val online:Boolean=true, val powerSaving:Boolean=false, val permissionGranted:Boolean=true)
class PcfWorkerTicket internal constructor(val generation:Long, val binding:PcfWorkerBinding)

/** A short foreground service activation never persists across process death or reboot. */
class PcfWorkerLease {
 private var started:Long?=null
 fun activate(now:Long) { require(now>=0);started=now }
 fun active(now:Long):Boolean=started?.let { now>=it && now-it<120000 } ?: false
 fun stop() { started=null }
}

/** Synchronous bounded CPU adapter. No network, sensor, shell, dynamic code, or task persistence. */
class PcfWorkerProvider {
 private var binding:PcfWorkerBinding?=null
 private var generation=0L
 private var backgroundApproved=false
 @Synchronized fun optIn(grant:PcfWorkerBinding, ownerApproved:Boolean, backgroundApproved:Boolean=false) {
  require(ownerApproved) { "Explicit owner activation required" }
  generation++;binding=grant;this.backgroundApproved=backgroundApproved
 }
 @Synchronized fun availability(state:PcfWorkerConditions):String?=when {
  binding==null -> "NOT_OPTED_IN"
  !state.permissionGranted -> "PERMISSION_REVOKED"
  !state.foreground && !backgroundApproved -> "BACKGROUND_NOT_APPROVED"
  state.batteryPercent !in 20..100 -> "LOW_BATTERY"
  state.thermalStatus !in 0..1 -> "THERMAL_LIMIT"
  state.powerSaving -> "POWER_SAVING"
  !state.online -> "OFFLINE"
  state.metered -> "METERED_NETWORK"
  else -> null
 }
 @Synchronized fun ticket(state:PcfWorkerConditions):PcfWorkerTicket {
  check(availability(state)==null) { availability(state) ?: "Unavailable" }
  return PcfWorkerTicket(generation,binding!!)
 }
 @Synchronized fun accepts(ticket:PcfWorkerTicket,state:PcfWorkerConditions)=
  availability(state)==null && ticket.generation==generation && ticket.binding==binding
 @Synchronized fun execute(executor:String,input:String,state:PcfWorkerConditions):String {
  ticket(state)
  require(executor=="text.normalize.v1") { "Executor not allowlisted" }
  require(input.length<=16384) { "Input budget exceeded" }
  return input.trim().replace(Regex("\\s+")," ")
 }
 @Synchronized fun stop() { generation++;binding=null;backgroundApproved=false }
 fun revoke()=stop()
 fun onOsReclaimed()=stop()
}
