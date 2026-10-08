package city.utopia.control

import org.junit.Assert.*
import org.junit.Test

class PcfWorkerTest {
 private val binding = PcfWorkerBinding("city-1", "device-1", "control-install", "worker-install", "worker-1", "handle-1")
 private val ready = PcfWorkerConditions()
 @Test fun disabledByDefaultAndExplicitConsentRequired() {
  val worker=PcfWorkerProvider()
  assertEquals("NOT_OPTED_IN", worker.availability(ready))
  assertThrows(IllegalArgumentException::class.java) { worker.optIn(binding, false) }
  worker.optIn(binding, true)
  assertNull(worker.availability(ready))
 }
 @Test fun controlInstallationCannotBecomeWorker() {
  assertThrows(IllegalArgumentException::class.java) { PcfWorkerBinding("city", "device", "same", "same", "principal", "handle") }
  assertThrows(IllegalArgumentException::class.java) { binding.copy(deviceId="") }
 }
 @Test fun eachResourceConstraintRefusesExecution() {
  val worker=PcfWorkerProvider(); worker.optIn(binding,true)
  listOf(ready.copy(foreground=false) to "BACKGROUND_NOT_APPROVED", ready.copy(batteryPercent=19) to "LOW_BATTERY",
   ready.copy(thermalStatus=2) to "THERMAL_LIMIT", ready.copy(metered=true) to "METERED_NETWORK",
   ready.copy(online=false) to "OFFLINE", ready.copy(powerSaving=true) to "POWER_SAVING",
   ready.copy(permissionGranted=false) to "PERMISSION_REVOKED").forEach { (conditions, reason) ->
    assertEquals(reason,worker.availability(conditions))
    assertThrows(IllegalStateException::class.java) { worker.execute("text.normalize.v1", "a", conditions) }
   }
 }
 @Test fun onlyBoundedTextPreprocessingIsAllowed() {
  val worker=PcfWorkerProvider();worker.optIn(binding,true)
  assertEquals("a b",worker.execute("text.normalize.v1"," a\n\t b ",ready))
  assertThrows(IllegalArgumentException::class.java) { worker.execute("shell","echo secret",ready) }
  assertThrows(IllegalArgumentException::class.java) { worker.execute("text.normalize.v1","x".repeat(16385),ready) }
 }
 @Test fun stopRevokeAndOsReclaimInvalidateOldWork() {
  val worker=PcfWorkerProvider();worker.optIn(binding,true);val old=worker.ticket(ready)
  worker.stop();assertFalse(worker.accepts(old,ready));assertEquals("NOT_OPTED_IN",worker.availability(ready))
  worker.optIn(binding,true);assertFalse(worker.accepts(old,ready));val current=worker.ticket(ready)
  worker.onOsReclaimed();assertFalse(worker.accepts(current,ready));assertEquals("NOT_OPTED_IN",worker.availability(ready))
  worker.optIn(binding,true);worker.revoke();assertEquals("NOT_OPTED_IN",worker.availability(ready))
 }
 @Test fun completionIsFencedWhenConditionsChange() {
  val worker=PcfWorkerProvider();worker.optIn(binding,true);val ticket=worker.ticket(ready)
  assertTrue(worker.accepts(ticket,ready));assertFalse(worker.accepts(ticket,ready.copy(foreground=false)))
  worker.optIn(binding.copy(workerInstallationId="other"),true);assertFalse(worker.accepts(ticket,ready))
 }
 @Test fun backgroundBudgetRequiresSeparateApproval() {
  val worker=PcfWorkerProvider();worker.optIn(binding,true)
  assertEquals("BACKGROUND_NOT_APPROVED",worker.availability(ready.copy(foreground=false)))
  worker.optIn(binding,true,backgroundApproved=true)
  assertNull(worker.availability(ready.copy(foreground=false)))
 }
 @Test fun serviceActivationLeaseExpiresAndCannotRestartSilently() {
  val lease=PcfWorkerLease()
  assertFalse(lease.active(0));lease.activate(100)
  assertTrue(lease.active(101));assertFalse(lease.active(120100))
  lease.stop();assertFalse(lease.active(102))
 }
}
