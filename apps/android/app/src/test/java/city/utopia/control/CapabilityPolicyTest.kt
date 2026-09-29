package city.utopia.control
import org.junit.Assert.*
import org.junit.Test
class CapabilityPolicyTest {
 @Test fun cachedOfflineAndPendingServicesCannotInvoke() {
  assertTrue(canInvokeCapability("ONLINE", "AVAILABLE", false))
  assertFalse(canInvokeCapability("OFFLINE", "AVAILABLE", false))
  assertFalse(canInvokeCapability("RECONNECTING", "AVAILABLE", false))
  assertFalse(canInvokeCapability("ONLINE", "BRIDGE_PENDING", false))
  assertFalse(canInvokeCapability("ONLINE", "AVAILABLE", true))
 }
}
