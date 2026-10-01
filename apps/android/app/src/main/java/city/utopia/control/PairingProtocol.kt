package city.utopia.control

import java.net.URI
import java.net.URLDecoder
import java.time.Instant

data class PairDescriptor(val cityId: String, val endpoint: String, val session: String, val expires: String, val secret: String? = null, val displayName: String = cityId)
fun endpoint(value: String): String {
 val u = URI(value)
 require(u.scheme == "http" && !u.host.isNullOrBlank() && u.userInfo == null && u.query == null && u.fragment == null && (u.path.isNullOrEmpty() || u.path == "/") && (u.port == -1 || u.port in 1..65535)) { "Invalid LAN endpoint" }
 return "http://${if (u.host.contains(':')) "[${u.host.trim('[', ']')}]" else u.host}:${if(u.port == -1) 80 else u.port}"
}
fun parseQr(value: String, now: Instant = Instant.now()): PairDescriptor {
 val u = URI(value); require(u.scheme == "utopia" && u.host == "pair" && u.fragment == null) { "Invalid pairing QR" }
 val entries = (u.rawQuery ?: "").split('&').map { it.split('=', limit=2) }
 require(entries.all { it.size == 2 } && entries.map { it[0] }.distinct().size == entries.size) { "Malformed QR" }
 val q = entries.associate { it[0] to URLDecoder.decode(it[1], "UTF-8") }
 require(q["v"] == "1") { "Unsupported descriptor version" }
 fun field(key: String) = q[key]?.takeIf { it.isNotBlank() } ?: error("Missing $key")
 val expires = field("expires"); require(Instant.parse(expires).isAfter(now)) { "Pairing session expired" }
 return PairDescriptor(field("city"), endpoint(field("host")), field("session"), expires, field("secret"))
}
fun mergeCity(cities: Map<String, PairDescriptor>, candidate: PairDescriptor): Map<String, PairDescriptor> {
 require(cities[candidate.cityId]?.endpoint.let { it == null || it == candidate.endpoint }) { "City endpoint conflict; clear discovery and verify the host" }
 return cities + (candidate.cityId to candidate)
}
fun telemetryStatus(connected: Boolean, nodeOnline: Boolean, observedAt: String?, now: Instant = Instant.now()): String = when {
 !connected -> "UNKNOWN · Cached"
 !nodeOnline -> "OFFLINE · Cached"
 observedAt == null || runCatching { java.time.Duration.between(Instant.parse(observedAt), now).seconds !in 0..10 }.getOrDefault(true) -> "UNKNOWN · Cached"
 else -> "ONLINE"
}
fun discoveryPermission(granted: Boolean, enabled: Boolean, available: Boolean) = when { !granted -> "Permission denied"; !enabled -> "Bluetooth disabled"; !available -> "Scanner unavailable"; else -> "Scanning" }
fun pairingTransition(state: String, event: String) = when(event) { "start" -> "DISCOVERING"; "submit" -> "PAIRING"; "authenticated" -> "AUTHENTICATED"; "error" -> "ERROR"; "clear" -> "UNPAIRED"; else -> state }
/**
 * Web truth-parity for an absolute timestamp. Mirrors `formatTime()` in apps/web/i18n:
 * a locale-aware LOCAL clock time, falling back to the raw value when it does not parse
 * (`String(iso ?? '')`), and to "" when the value is absent. A browser and the JVM do not
 * agree on exact typography, so this matches the SEMANTICS - local, locale-aware, human
 * clock time rather than a machine ISO string - not the byte-for-byte output.
 *
 * The relative-age half of the same parity work lives in `relativeAge` (Devices.kt), which
 * the review host authored for repair R-1. There is deliberately only one such helper.
 */
fun clockLabel(value: String?): String {
 if (value.isNullOrBlank()) return ""
 val instant = parseIsoInstant(value) ?: return value
 return java.time.format.DateTimeFormatter.ofLocalizedTime(java.time.format.FormatStyle.MEDIUM)
  .withLocale(java.util.Locale.getDefault())
  .withZone(java.time.ZoneId.systemDefault())
  .format(instant)
}
/** Accepts the strict `Instant` form the Gateway sends and the offset-bearing form, so an
 *  offset timestamp parses here as it does under JavaScript's more lenient Date.parse.
 *  Shared by `clockLabel` and `relativeAge` so both accept exactly the same inputs. */
internal fun parseIsoInstant(value: String?): Instant? {
 if (value.isNullOrBlank()) return null
 return runCatching { Instant.parse(value) }.getOrNull()
  ?: runCatching { java.time.OffsetDateTime.parse(value).toInstant() }.getOrNull()
}
fun bleEndpoint(data: ByteArray): String { require(data.size == 7 && data[0].toInt() == 1) { "Unsupported BLE locator" }; val port = ((data[5].toInt() and 255) shl 8) or (data[6].toInt() and 255); require(port > 0); return endpoint("http://${data.slice(1..4).joinToString(".") { (it.toInt() and 255).toString() }}:$port") }
val BLE_PREFIX = byteArrayOf(0x6f,0x9a.toByte(),0x00,0x01,0x6c,0x53,0x4b,0x92.toByte(),0xa3.toByte(),0x19,0x75,0x74,0x6f,0x70,0x69,0x61)
fun bleAdvertisementEndpoint(data: ByteArray): String { require(data.size==23 && data.copyOfRange(0,16).contentEquals(BLE_PREFIX)) { "Unknown BLE advertisement" }; return bleEndpoint(data.copyOfRange(16,23)) }
fun exchangeDescriptor(original: PairDescriptor, current: PairDescriptor, mode: String, now: Instant=Instant.now()): PairDescriptor {
 require(original.cityId==current.cityId && original.endpoint==current.endpoint) { "City or endpoint identity conflict" }
 val selected=if(mode=="qr") { require(original.session==current.session) { "QR session changed; scan a new QR" }; original } else current
 require(selected.session.isNotBlank() && selected.session!="null" && selected.expires.isNotBlank() && selected.expires!="null") { "No active pairing session. Create a pairing code on the City host, then try Connect again." }
 require(runCatching { Instant.parse(selected.expires).isAfter(now) }.getOrDefault(false)) { "Pairing session expired. Create a new session on the City host." }
 return selected
}
fun discoveryFresh(lastTransportSighting:Long?, now:Long):Boolean = lastTransportSighting != null && now-lastTransportSighting in 0..15000
