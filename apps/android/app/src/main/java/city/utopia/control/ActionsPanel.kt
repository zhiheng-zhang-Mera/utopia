package city.utopia.control

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// T2 — the canonical Action facade. Every field shown here is the gateway's own value:
// Android never re-derives status, so the actionId and status match what Web shows.

@Composable fun ActionsPanel(state: CityState, client: CityClient?) {
 // One fence per in-flight request, so opening a record cannot strand the list's busy state.
 val listFence = remember(client) { CallbackFence() }
 val detailFence = remember(client) { CallbackFence() }
 DisposableEffect(listFence, detailFence) { onDispose { listFence.close(); detailFence.close() } }
 var limit by remember { mutableStateOf("50") }
 var busy by remember { mutableStateOf(false) }
 var failure by remember { mutableStateOf<String?>(null) }
 var actions by remember { mutableStateOf<List<ActionSummary>?>(null) }
 var selectedId by remember { mutableStateOf<String?>(null) }
 var detail by remember { mutableStateOf<ActionDetail?>(null) }
 var detailBusy by remember { mutableStateOf(false) }
 var detailFailure by remember { mutableStateOf<String?>(null) }
 fun load() {
  if (client == null || busy) return
  listFence.invalidate();val ticket = listFence.ticket() ?: return
  busy = true;failure = null
  client.actions(limit.toIntOrNull() ?: 50) { response ->
   if (!listFence.accepts(ticket)) return@actions
   busy = false
   if (response.has("errorCode")) failure = response.optString("error") else {
    val parsed = runCatching { arrayObjects(payload(response, "actions").optJSONArray("actions")).map { parseActionSummary(it) } }.getOrElse { null }
    if (parsed == null) failure = "The gateway returned an unreadable Action list." else actions = parsed
   }
  }
 }
 fun open(id: String) {
  if (client == null) return
  selectedId = id;detail = null;detailFailure = null;detailBusy = true
  detailFence.invalidate();val ticket = detailFence.ticket() ?: return
  client.actionDetail(id) { response ->
   if (!detailFence.accepts(ticket)) return@actionDetail
   detailBusy = false
   if (response.has("errorCode")) detailFailure = response.optString("error") else detail = runCatching { parseActionDetail(payload(response, "action")) }.getOrElse { null }.also { if (it == null) detailFailure = "The gateway returned an unreadable Action record." }
  }
 }
 LaunchedEffect(state.connection) { if (state.connection == "ONLINE" && actions == null && !busy) load() }
 Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
  Text("Action history", fontWeight = FontWeight.Bold)
  Text("One Action model over Rooms, City services and City tasks. This list is the gateway's own record, newest first — the same actionId you see in Web.", fontSize = 12.sp)
  Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
   OutlinedTextField(limit, { limit = it.filter { c -> c.isDigit() }.take(3) }, label = { Text("Limit") }, singleLine = true, enabled = !busy, modifier = Modifier.weight(1f))
   OutlinedButton(onClick = { load() }, enabled = !busy && client != null) { Text("Refresh") }
  }
  if (client == null) Text("Not connected to a City yet.", fontSize = 12.sp)
  if (busy) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
  failure?.let { Text(it, color = Color(0xFFA15C38), fontSize = 12.sp) }
  val rows = actions
  if (rows == null) Text("No Action list loaded yet. Refresh to read the gateway record.", fontSize = 12.sp, color = Color.Gray)
  else if (rows.isEmpty()) Text("No Actions yet. Start one from Ask / Do.", color = Color.Gray)
  else {
   Text("ACTIONS (" + rows.size + ")", fontSize = 11.sp, letterSpacing = 2.sp, color = Color.Gray)
   rows.forEach { row -> Panel(Modifier.clickable { open(row.actionId) }) {
    Text(row.statusLabel, fontWeight = FontWeight.Bold, color = actionStatusColor(row.status))
    Text(row.requestedIntent.ifBlank { "(no intent recorded)" }, fontSize = 13.sp)
    Text(row.route + " · " + row.targetLabel.ifBlank { "unknown target" }, fontSize = 12.sp)
    if (row.hasProgress && row.status == "RUNNING") LinearProgressIndicator(progress = { row.progressFraction }, modifier = Modifier.fillMaxWidth())
    Text("Progress: " + row.progress + "%", fontSize = 11.sp, color = Color.Gray)
    if (row.resultText.isNotBlank()) Text(row.resultText, fontSize = 12.sp)
    row.errorCode?.let { Text("Error code: " + it, fontSize = 11.sp) }
    Text("actionId: " + row.actionId, fontSize = 10.sp, color = Color.Gray)
   } }
  }
  selectedId?.let { id ->
   Panel {
    Text("SELECTED ACTION", fontSize = 11.sp, letterSpacing = 2.sp, color = Color.Gray)
    Text("actionId: " + id, fontSize = 11.sp)
    OutlinedButton(onClick = { selectedId = null; detail = null; detailFailure = null }) { Text("Close details") }
    if (detailBusy) { Text("Loading the full record…", fontSize = 12.sp); LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) }
    detailFailure?.let { Text(it, color = Color(0xFFA15C38), fontSize = 12.sp) }
    detail?.let { ActionRecord(it) }
   }
  }
 }
}

private fun actionStatusColor(status: String): Color = when (status) {
 "SUCCEEDED" -> Color(0xFF456B29)
 "FAILED", "REFUSED" -> Color(0xFFA15C38)
 "UNAVAILABLE", "CANCELLED" -> Color(0xFF6B6B6B)
 else -> Color(0xFF19382F)
}

/** The full Action record, verbatim, including provenance. */
@Composable fun ActionRecord(detail: ActionDetail) {
 val row = detail.summary
 Text(row.statusLabel, fontWeight = FontWeight.Bold, color = actionStatusColor(row.status))
 Text("Intent (your words): " + row.requestedIntent.ifBlank { "(none recorded)" }, fontSize = 12.sp)
 Text("Route: " + row.route.ifBlank { "unknown" }, fontSize = 12.sp)
 detail.target?.let { Text("Target: " + it.label.ifBlank { it.id } + (it.operation?.let { operation -> " · " + operation } ?: ""), fontSize = 12.sp) }
 Text("Progress: " + row.progress + "%", fontSize = 12.sp)
 detail.backendRef?.let { Text("Backend: " + it.kind + " · " + it.id + (it.roomId?.let { room -> " · room " + room } ?: "") + (it.operationId?.let { operation -> " · " + operation } ?: ""), fontSize = 12.sp) }
 detail.resultRef?.let { ref ->
  Text("Result: " + ref.kind + " · " + ref.id, fontSize = 12.sp)
  Text(ref.summary, fontSize = 12.sp)
  ref.digest?.let { digest -> Text("Digest: " + digest, fontSize = 11.sp, color = Color.Gray) }
 }
 detail.error?.let { Text("Error: " + it.code + " · " + it.message, fontSize = 12.sp) }
 detail.provenance?.let { provenance ->
  Text("Provenance", fontWeight = FontWeight.Bold, fontSize = 12.sp)
  Text("source: " + provenance.source.ifBlank { "unknown" } + " · host: " + provenance.host.ifBlank { "unknown" }, fontSize = 11.sp)
  Text("roomId: " + (provenance.roomId ?: "—") + " · capabilityId: " + (provenance.capabilityId ?: "—"), fontSize = 11.sp, color = Color.Gray)
  Text("taskId: " + (provenance.taskId ?: "—") + " · invocationId: " + (provenance.invocationId ?: "—"), fontSize = 11.sp, color = Color.Gray)
  provenance.history.forEach { entry -> Text(entry.status + " · " + entry.at + (if (entry.note.isBlank()) "" else " · " + entry.note), fontSize = 11.sp) }
  if (provenance.history.isEmpty()) Text("No history entries reported.", fontSize = 11.sp, color = Color.Gray)
 }
 Text("Created: " + detail.createdAt.ifBlank { "Unavailable" } + " · Updated: " + detail.updatedAt.ifBlank { "Unavailable" }, fontSize = 10.sp, color = Color.Gray)
}
