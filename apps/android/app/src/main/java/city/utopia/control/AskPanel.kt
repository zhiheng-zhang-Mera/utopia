package city.utopia.control

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject

// T3 — one Ask / Do entry. Routing is deterministic and done by the gateway; this screen
// renders the returned ask.status truthfully and never implies a model chose the route.

@Composable fun AskPanel(state: CityState, client: CityClient?) {
 val online = state.connection == "ONLINE"
 // One fence per in-flight request, so loading the manual picker cannot strand an Ask in flight.
 val askFence = remember(client) { CallbackFence() }
 val targetFence = remember(client) { CallbackFence() }
 DisposableEffect(askFence, targetFence) { onDispose { askFence.close(); targetFence.close() } }
 var text by remember { mutableStateOf("") }
 var busy by remember { mutableStateOf(false) }
 var failure by remember { mutableStateOf<String?>(null) }
 var result by remember { mutableStateOf<AskResult?>(null) }
 var targets by remember { mutableStateOf<List<TargetOption>?>(null) }
 var targetsBusy by remember { mutableStateOf(false) }
 var targetsFailure by remember { mutableStateOf<String?>(null) }
 fun send(selection: JSONObject?, confirm: Boolean) {
  if (client == null || busy || text.isBlank()) return
  askFence.invalidate();val ticket = askFence.ticket() ?: return
  busy = true;failure = null
  client.ask(text.trim(), selection, confirm) { response ->
   if (!askFence.accepts(ticket)) return@ask
   busy = false
   if (response.has("errorCode")) failure = response.optString("error") else {
    val parsed = runCatching { parseAskResult(payload(response, "ask")) }.getOrElse { null }
    if (parsed == null) failure = "The gateway returned an unreadable Ask response." else result = parsed
   }
  }
 }
 fun loadTargets() {
  if (client == null || targetsBusy) return
  targetFence.invalidate();val ticket = targetFence.ticket() ?: return
  targetsBusy = true;targetsFailure = null
  client.askTargets { response ->
   if (!targetFence.accepts(ticket)) return@askTargets
   targetsBusy = false
   if (response.has("errorCode")) targetsFailure = response.optString("error") else targets = runCatching { parseTargets(arrayObjects(payload(response, "targets").optJSONArray("targets"))) }.getOrElse { null }.also { if (it == null) targetsFailure = "The gateway returned an unreadable target list." }
  }
 }
 Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
  Text("Ask / Do", fontWeight = FontWeight.Bold)
  Text("Say what you want in your own words. Deterministic rules on the gateway find the right local tool, City service or City task — no model is used to route.", fontSize = 12.sp)
  OutlinedTextField(text, { text = it }, label = { Text("What do you want to do?") }, enabled = !busy, minLines = 2, modifier = Modifier.fillMaxWidth())
  Button(onClick = { send(null, false) }, enabled = online && !busy && text.isNotBlank() && client != null, modifier = Modifier.fillMaxWidth()) { Text(if (busy) "Working…" else "Ask / Do") }
  if (!online) Text("Offline · Ask / Do stays disabled until the gateway reconnects. Nothing is queued.", fontSize = 12.sp)
  if (busy) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
  failure?.let { Text(it, color = Color(0xFFA15C38), fontSize = 12.sp) }
  result?.let { answer ->
   Panel {
    Text(answer.statusLabel, fontWeight = FontWeight.Bold, color = askStatusColor(answer.status))
    Text(answer.routerLabel, fontSize = 11.sp, color = Color.Gray)
    if (!answer.isKnownStatus) Text("Unrecognised status from the gateway; shown exactly as returned.", fontSize = 11.sp)
    Text("You asked: " + answer.text.ifBlank { text }, fontSize = 12.sp)
    if (answer.message.isNotBlank()) Text(answer.message, fontSize = 12.sp)
    (answer.route ?: answer.target)?.let { Text("Matched: " + (answer.route ?: "—") + " / " + (answer.target ?: "—") + (answer.operation?.let { operation -> " · " + operation } ?: ""), fontSize = 12.sp) }
   }
   if (answer.status == ASK_AWAITING_CONFIRMATION) {
    val confirmation = answer.confirmation
    Panel {
     Text("This needs your confirmation", fontWeight = FontWeight.Bold)
     Text(confirmation?.label ?: (answer.target ?: "Confirm this action"), fontSize = 13.sp)
     if (!confirmation?.description.isNullOrBlank()) Text(confirmation.description, fontSize = 12.sp)
     ConfirmationText(answer, text)
     Text("Nothing has run yet. Confirming repeats your words with confirm = true.", fontSize = 11.sp, color = Color.Gray)
     Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      Button(onClick = { send(answer.matchedSelection, true) }, enabled = online && !busy) { Text("Confirm and run") }
      OutlinedButton(onClick = { result = null }, enabled = !busy) { Text("Cancel") }
     }
    }
   }
   if (answer.status == ASK_AMBIGUOUS) {
    Panel {
     Text("Several rules matched — choose one", fontWeight = FontWeight.Bold)
     if (answer.candidates.isEmpty()) Text("The gateway reported no candidates.", fontSize = 12.sp)
     answer.candidates.forEach { candidate -> TargetChoice(candidate, busy || !online) { send(candidate.choice, false) } }
    }
   }
   if (answer.status == ASK_UNMATCHED) {
    Panel {
     Text("No rule matched your words", fontWeight = FontWeight.Bold)
     Text("Nothing ran and nothing was guessed. Pick a target yourself, or rephrase and ask again.", fontSize = 12.sp)
     OutlinedButton(onClick = { loadTargets() }, enabled = online && !targetsBusy && client != null) { Text(if (targetsBusy) "Loading targets…" else "Show all targets") }
     targetsFailure?.let { Text(it, color = Color(0xFFA15C38), fontSize = 12.sp) }
     val manual = targets
     if (manual != null) {
      if (manual.isEmpty()) Text("The gateway offered no targets.", fontSize = 12.sp) else {
       Text("MANUAL TARGETS", fontSize = 11.sp, letterSpacing = 2.sp, color = Color.Gray)
       manual.forEach { candidate -> TargetChoice(candidate, busy || !online) { send(candidate.choice, false) } }
      }
     }
    }
   }
   if (askShowsAction(answer.status)) answer.action?.let { action -> Panel { Text("Action", fontWeight = FontWeight.Bold); ActionRecord(action) } }
   else if (askShowsAction(answer.status) && answer.action == null && answer.status != ASK_UNAVAILABLE && answer.status != ASK_REFUSED) Text("The gateway reported this status without an Action record.", fontSize = 12.sp, color = Color.Gray)
  }
 }
}

@Composable private fun ConfirmationText(answer: AskResult, typed: String) {
 Text("What it will do: " + (answer.confirmation?.description?.takeIf { it.isNotBlank() } ?: answer.message.ifBlank { "run " + (answer.target ?: "the matched target") }), fontSize = 12.sp)
 Text("Your words sent: \"" + answer.text.ifBlank { typed } + "\"", fontSize = 11.sp, color = Color.Gray)
}

@Composable private fun TargetChoice(candidate: TargetOption, disabled: Boolean, choose: () -> Unit) {
 Panel {
  Text(candidate.label, fontWeight = FontWeight.Bold, fontSize = 13.sp)
  if (candidate.description.isNotBlank()) Text(candidate.description, fontSize = 12.sp)
  Text(candidate.route + " / " + candidate.target + (candidate.operation?.let { operation -> " · " + operation } ?: ""), fontSize = 11.sp, color = Color.Gray)
  Text(candidate.stateLabel, fontSize = 11.sp, color = if (candidate.sideEffect) Color(0xFFA15C38) else Color(0xFF456B29))
  if (candidate.mutating) Text("Writes local product data.", fontSize = 11.sp, color = Color.Gray)
  if (candidate.example.isNotBlank()) Text("Example: " + candidate.example, fontSize = 11.sp, color = Color.Gray)
  OutlinedButton(onClick = choose, enabled = !disabled && candidate.available) { Text("Choose") }
 }
}

private fun askStatusColor(status: String): Color = when (status) {
 ASK_COMPLETED -> Color(0xFF456B29)
 ASK_FAILED, ASK_REFUSED -> Color(0xFFA15C38)
 ASK_UNAVAILABLE -> Color(0xFF6B6B6B)
 ASK_UNMATCHED -> Color(0xFF6B6B6B)
 else -> Color(0xFF19382F)
}
