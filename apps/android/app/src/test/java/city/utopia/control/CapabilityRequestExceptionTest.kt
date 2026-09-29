package city.utopia.control

import java.io.IOException
import org.junit.Assert.*
import org.junit.Test

class CapabilityRequestExceptionTest {
 @Test fun businessRefusalsPreserveCodeStatusAndMessageEvenIfSocketWentOffline() {
  for((code,status) in listOf("INPUT_TOO_LARGE" to 413,"OPERATION_BLOCKED" to 400,"BRIDGE_PENDING" to 409,"CAPABILITY_NOT_FOUND" to 404,"INVALID_INPUT" to 400)) {
   val failure=capabilityFailure(CapabilityRequestException(code,status,"Readable refusal"),false)
   assertEquals(code,failure.code);assertEquals(status,failure.status);assertEquals("Readable refusal",failure.message)
  }
 }
 @Test fun networkFailureIsOfflineEvenWhenWebSocketStateIsStale() {
  val failure=capabilityFailure(IOException("Connection reset"),true)
  assertEquals("OFFLINE",failure.code);assertNull(failure.status)
 }
 @Test fun unexpectedLocalFailureIsNotReportedAsBusinessRefusal() {
  assertEquals("INVOCATION_UNAVAILABLE",capabilityFailure(IllegalStateException("bad response"),true).code)
 }
 @Test fun staleRunningSnapshotCannotDiscardCompletedPayload() {
  assertFalse(acceptInvocationSummary("COMPLETED","RUNNING"))
  assertFalse(acceptInvocationSummary("FAILED","RUNNING"))
  assertFalse(acceptInvocationSummary("INTERRUPTED","RUNNING"))
  assertTrue(acceptInvocationSummary("RUNNING","COMPLETED"))
  assertTrue(acceptInvocationSummary("COMPLETED","COMPLETED"))
 }
}
