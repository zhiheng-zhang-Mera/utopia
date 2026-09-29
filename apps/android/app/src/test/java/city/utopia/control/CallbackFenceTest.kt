package city.utopia.control
import org.junit.Assert.*
import org.junit.Test
class CallbackFenceTest {
 @Test fun transportSightingsExpireWithoutAdvertisements() { assertTrue(discoveryFresh(1000,15000)); assertFalse(discoveryFresh(1000,16001)); assertFalse(discoveryFresh(null,1000)) }
 @Test fun stoppedGenerationCannotDeliverAfterRestart() { val fence=CallbackFence(); val old=fence.ticket()!!; fence.invalidate(); val fresh=fence.ticket()!!; assertFalse(fence.accepts(old)); assertTrue(fence.accepts(fresh)) }
 @Test fun disposedGenerationCannotDeliverOrSubmit() { val fence=CallbackFence(); val queued=fence.ticket()!!; fence.close(); assertFalse(fence.accepts(queued)); assertNull(fence.ticket()); fence.invalidate(); assertNull(fence.ticket()) }
}
