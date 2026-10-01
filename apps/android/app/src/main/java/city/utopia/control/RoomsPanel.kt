package city.utopia.control

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import city.utopia.control.ui.UtFeedback

// T1 — Rooms on Android. Availability and the ten-Room catalog only.
// Android never receives or uses the loopback hubUrl and never opens a Room Hub port;
// it reads the authenticated gateway and nothing else. No Room is executed here in this stage.

@Composable fun RoomsPanel(state: CityState, client: CityClient?) {
 val online = state.connection == "ONLINE"
 val fence = remember(client) { CallbackFence() }
 DisposableEffect(fence) { onDispose { fence.close() } }
 var busy by remember { mutableStateOf(false) }
 var failure by remember { mutableStateOf<String?>(null) }
 var hub by remember { mutableStateOf<RoomAvailability?>(null) }
 fun load() {
  if (client == null || busy) return
  fence.invalidate();val ticket = fence.ticket() ?: return
  busy = true;failure = null
  client.rooms { response ->
   if (!fence.accepts(ticket)) return@rooms
   busy = false
   failure = if (response.has("errorCode")) response.optString("error") else null
   if (failure == null) hub = runCatching { parseRoomAvailability(payload(response, "rooms")) }.getOrElse { null }.also { if (it == null) failure = "The gateway returned an unreadable Rooms response." }
  }
 }
 Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
  Text("Local Rooms", fontWeight = FontWeight.Bold)
  Text("Ten local personal tools on your Utopia host. Android observes them through the authenticated gateway; it never talks to the Room Hub directly and never opens its loopback port.", fontSize = 12.sp)
  Button(onClick = { load() }, enabled = canLoadRooms(state.connection, busy), modifier = Modifier.fillMaxWidth()) { Text(if (busy) "Checking…" else if (hub == null) "Check Room availability" else "Refresh") }
  if (!online) Text("Offline · Room availability is unknown until the gateway reconnects. Nothing below is live.", fontSize = 12.sp)
  if (busy) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
  failure?.let { UtFeedback(it, kind = "error") }
  if (hub == null) Text("Room availability has not been read yet.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) else {
   val status = hub!!
   Panel {
    Text(status.stateLabel, style = MaterialTheme.typography.titleMedium, color = if (status.available) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error)
    Text(status.stateDetail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface)
    Text("Last checked by the host: " + status.checkedAt.ifBlank { "Unavailable" }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Text("Rooms in catalog: " + status.count, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
   }
   if (!status.available) Text("This is the hub's real state, not an error and not an empty catalog. The Rooms below are listed from the gateway catalog and cannot run right now.", fontSize = 12.sp)
   Text(if (status.available) "ROOMS" else "ROOMS · UNAVAILABLE", fontSize = 11.sp, letterSpacing = 2.sp, color = Color.Gray)
   if (status.rooms.isEmpty()) Text("The gateway reported no Rooms.") else status.rooms.forEach { room ->
    Panel {
     Text(room.number + "  " + room.label, fontWeight = FontWeight.Bold)
     if (room.zh.isNotBlank()) Text(room.zh, fontSize = 13.sp)
     if (room.summary.isNotBlank()) Text(room.summary, fontSize = 12.sp)
     Text("id: " + room.id + " · " + (if (room.persistent) "keeps your data" else "does not keep your data"), fontSize = 11.sp, color = Color.Gray)
    }
   }
  }
 }
}
