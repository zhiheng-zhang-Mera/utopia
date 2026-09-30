package city.utopia.control

import org.json.JSONObject

// T1 — Room catalog as the gateway reports it.
// `hubUrl` is deliberately NOT modelled: it is a loopback-only address for a browser on the
// Utopia host, so Android must never be handed it and must never open a Room Hub port.
// Android observes availability and the catalog through the authenticated gateway only.

data class RoomEntry(
 val id: String,
 val number: String,
 val label: String,
 val zh: String,
 val summary: String,
 val persistent: Boolean,
)

/** `available` is a truthful product state, not an error: false means the UI shows UNAVAILABLE. */
data class RoomAvailability(
 val available: Boolean,
 val reason: String?,
 val checkedAt: String,
 val count: Int,
 val rooms: List<RoomEntry>,
) {
 val stateLabel: String get() = if (available) "AVAILABLE" else "UNAVAILABLE"
 /** Why the hub is down, without dressing it up as a failure of the gateway. */
 val stateDetail: String get() = if (available) "The Room Hub answered the gateway on the Utopia host." else reason?.let { "The Room Hub is not reachable from the Utopia host right now: $it" } ?: "The Room Hub is not reachable from the Utopia host right now."
 val catalogLabel: String get() = if (available) "Ten Rooms, ready to use" else "The ten Rooms cannot run until the hub is back"
}

fun parseRoom(row: JSONObject): RoomEntry = RoomEntry(
 id = row.textOrEmpty("id"),
 number = row.textOrEmpty("number"),
 label = row.textOrEmpty("label"),
 zh = row.textOrEmpty("zh"),
 summary = row.textOrEmpty("summary"),
 persistent = row.optBoolean("persistent", false),
)

fun parseRoomAvailability(payload: JSONObject): RoomAvailability {
 val rooms = arrayObjects(payload.optJSONArray("rooms")).map { parseRoom(it) }
 return RoomAvailability(
  available = payload.optBoolean("available", false),
  reason = payload.textOrNull("reason"),
  checkedAt = payload.textOrEmpty("checkedAt"),
  count = payload.optInt("count", rooms.size),
  rooms = rooms,
 )
}

/** Room availability, like capability invocation, is only freshly knowable while connected. */
fun canLoadRooms(connection: String, busy: Boolean): Boolean = connection == "ONLINE" && !busy

/**
 * Reads one required payload object out of the flat v0 envelope, i.e. a sibling of
 * `apiVersion` / `schemaVersion`. There is no `data` wrapper in this contract.
 */
fun payload(envelope: JSONObject, name: String): JSONObject =
 envelope.optJSONObject(name) ?: throw IllegalStateException("Missing $name in the gateway response")
