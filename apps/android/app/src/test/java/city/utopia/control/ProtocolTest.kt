package city.utopia.control
import org.junit.Assert.*
import org.junit.Test
class ProtocolTest {
 @Test fun incompatibleVersionsFail() { assertTrue(compatible(0,0)); assertFalse(compatible(1,0)); assertFalse(compatible(0,1)) }
 @Test fun onlyActiveTasksCanCancel() { assertTrue(canCancel("RUNNING")); assertTrue(canCancel("QUEUED")); assertFalse(canCancel("COMPLETED")); assertFalse(canCancel("FAILED")); assertFalse(canCancel("CANCELLED")) }
}
