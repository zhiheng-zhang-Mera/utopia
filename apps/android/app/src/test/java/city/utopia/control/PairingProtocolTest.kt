package city.utopia.control
import org.junit.Test
import org.junit.Assert.*
import java.time.Instant
class PairingProtocolTest {
 private val qr = "utopia://pair?v=1&host=http%3A%2F%2F192.168.1.2%3A4310&city=city-full-id&session=s&expires=2099-01-01T00%3A00%3A00Z&secret=x"
 @Test fun lateHostSessionRefreshesDiscoveryOnly() { val current=parseQr(qr).copy(session="new"); val empty=current.copy(session="",expires=""); assertEquals("new",exchangeDescriptor(empty,current,"mdns").session); assertEquals("new",exchangeDescriptor(empty,current,"ble").session); assertTrue(runCatching { exchangeDescriptor(empty,current,"qr") }.isFailure); assertTrue(runCatching { exchangeDescriptor(current,current.copy(cityId="other"),"mdns") }.isFailure); assertTrue(runCatching { exchangeDescriptor(current,current.copy(endpoint="http://other:4310"),"ble") }.isFailure); assertTrue(runCatching { exchangeDescriptor(empty,empty,"mdns") }.exceptionOrNull()!!.message!!.contains("No active pairing session")) }
 @Test fun valid() { assertEquals("city-full-id", parseQr(qr).cityId) }
 @Test fun rejectsInvalidDescriptors() { listOf(qr.replace("v=1", "v=2"), qr.replace("host=", "missing="), qr.replace("4310", "99999"), qr.replace("2099", "2000"), "%%%", qr.replace("utopia:", "https:")).forEach { assertTrue(runCatching { parseQr(it) }.isFailure) } }
 @Test fun dedupRejectsConflict() { val d = parseQr(qr); assertEquals(1, mergeCity(mergeCity(emptyMap(), d), d).size); assertTrue(runCatching { mergeCity(mapOf(d.cityId to d), d.copy(endpoint="http://other:4310")) }.isFailure) }
 @Test fun staleNeverGreen() { val now=Instant.parse("2026-01-01T00:00:20Z"); assertEquals("UNKNOWN · Cached", telemetryStatus(true,true,"2026-01-01T00:00:00Z",now)); assertEquals("UNKNOWN · Cached",telemetryStatus(false,true,now.toString(),now)); assertEquals("OFFLINE · Cached",telemetryStatus(true,false,now.toString(),now)) }
 @Test fun permissionAndReducer() { assertEquals("Permission denied",discoveryPermission(false,true,true)); assertEquals("Bluetooth disabled",discoveryPermission(true,false,true)); assertEquals("PAIRING",pairingTransition("DISCOVERING","submit")); assertFalse(compatible(1,0)) }
 @Test fun manufacturerFrame() { val data=BLE_PREFIX + byteArrayOf(1,192.toByte(),168.toByte(),1,2,16,214.toByte()); assertEquals("http://192.168.1.2:4310",bleAdvertisementEndpoint(data)); data[0]=0; assertTrue(runCatching { bleAdvertisementEndpoint(data) }.isFailure) }
 @Test fun bleLocator() { assertEquals("http://192.168.1.2:4310",bleEndpoint(byteArrayOf(1,192.toByte(),168.toByte(),1,2,16,214.toByte()))) }
}
