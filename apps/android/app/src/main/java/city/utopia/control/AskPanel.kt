package city.utopia.control

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import city.utopia.control.theme.Space
import city.utopia.control.ui.StatusChip
import city.utopia.control.ui.TechnicalDetails
import city.utopia.control.ui.UtEmptyState
import city.utopia.control.ui.UtFeedback
import city.utopia.control.ui.UtLabel
import city.utopia.control.ui.UtPanel
import org.json.JSONObject

// T3 — one Ask / Do entry. Routing is deterministic and done by the gateway; this screen
// renders the returned ask.status truthfully and never implies a model chose the route.
//
// UI-102: every state the gateway can return still has its own branch — working,
// needs-confirmation, ambiguous, unmatched, unavailable, success, failure. What changed is
// the reading path: the user sees the outcome in their own words and the technical routing
// facts (router, route/target/operation, candidate coordinates) are folded into 运行详情
// rather than printed inline. They are folded, not removed.

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
 var pendingKey by remember { mutableStateOf<String?>(null) }
 var pendingFor by remember { mutableStateOf<String?>(null) }
 fun send(selection: JSONObject?, confirm: Boolean) {
  if (client == null || busy || text.isBlank()) return
  askFence.invalidate();val ticket = askFence.ticket() ?: return
  busy = true;failure = null
  // One key per user action: a retry of the same action replays at the gateway instead of
  // executing twice, while a changed action gets a new key.
  val signature = text.trim() + "|" + (selection?.toString() ?: "") + "|" + confirm
  if (pendingFor != signature) { pendingFor = signature; pendingKey = newIdempotencyKey() }
  client.ask(text.trim(), selection, confirm, pendingKey) { response ->
   if (!askFence.accepts(ticket)) return@ask
   busy = false
   if (response.has("errorCode")) failure = response.optString("error") else {
    val parsed = runCatching { parseAskResult(payload(response, "ask")) }.getOrElse { null }
    if (parsed == null) failure = "The gateway returned an unreadable Ask response." else { result = parsed; pendingFor = null; pendingKey = null }
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
   if (response.has("errorCode")) targetsFailure = response.optString("error") else targets = runCatching { parseTargetList(response) }.getOrElse { null }.also { if (it == null) targetsFailure = "The gateway returned an unreadable target list." }
  }
 }
 Column(verticalArrangement = Arrangement.spacedBy(Space.md), modifier = Modifier.fillMaxWidth()) {
  UtLabel("对话 · 执行")
  Text("Ask / Do", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground)
  Text(
   "用你自己的话说想做什么。Gateway 用固定规则找到对应的本地工具、City 能力或 City 任务——没有任何模型参与决定去向。",
   style = MaterialTheme.typography.bodySmall,
   color = MaterialTheme.colorScheme.onSurfaceVariant,
  )
  OutlinedTextField(text, { text = it }, label = { Text("你想做什么？") }, enabled = !busy, minLines = 2, modifier = Modifier.fillMaxWidth())
  Button(
   onClick = { send(null, false) },
   enabled = online && !busy && text.isNotBlank() && client != null,
   modifier = Modifier.fillMaxWidth(),
  ) { Text(if (busy) "正在执行…" else "去做") }
  if (!online) UtEmptyState("离线", "连接恢复前「去做」不可用，也不会排队。")
  if (busy) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
  failure?.let { UtFeedback(it, kind = "error") }
  result?.let { answer ->
   UtPanel(accent = answer.status == ASK_COMPLETED) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
     Text("你刚才说的", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
     StatusChip(answer.status)
    }
    Text(answer.text.ifBlank { text }, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
    if (answer.message.isNotBlank()) Text(answer.message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
    if (!answer.isKnownStatus) UtFeedback("Gateway 返回了未识别的状态，这里按原样显示。", kind = "warn")
    // router label, route/target/operation: folded, still reachable
    TechnicalDetails(listOf(
     "status" to answer.status,
     "statusLabel" to answer.statusLabel,
     "router" to answer.routerLabel,
     "route" to (answer.route ?: ""),
     "target" to (answer.target ?: ""),
     "operation" to (answer.operation ?: ""),
    ))
   }
   if (answer.status == ASK_AWAITING_CONFIRMATION) {
    val confirmation = answer.confirmation
    UtPanel(accent = true) {
     UtLabel("需要你确认", color = MaterialTheme.colorScheme.secondary)
     Text(confirmation?.label ?: (answer.target ?: "确认这次执行"), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
     if (!confirmation?.description.isNullOrBlank()) Text(confirmation.description, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
     ConfirmationText(answer, text)
     UtFeedback("还没有执行任何东西。确认会用 confirm = true 重发你的原话。", kind = "warn")
     Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
      Button(onClick = { send(answer.matchedSelection, true) }, enabled = online && !busy) { Text("确认并执行") }
      OutlinedButton(onClick = { result = null }, enabled = !busy) { Text("取消") }
     }
    }
   }
   if (answer.status == ASK_AMBIGUOUS) {
    UtPanel {
     UtLabel("有多个规则匹配", color = MaterialTheme.colorScheme.secondary)
     Text("选一个继续。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
     if (answer.candidates.isEmpty()) UtEmptyState("Gateway 没有给出候选")
     answer.candidates.forEach { candidate -> TargetChoice(candidate, busy || !online) { send(candidate.choice, false) } }
    }
   }
   if (answer.status == ASK_UNMATCHED) {
    UtPanel {
     UtLabel("没有规则匹配你的话", color = MaterialTheme.colorScheme.secondary)
     Text("什么都没有执行，也没有猜测。你可以自己挑一个目标，或者换句话再说一次。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
     OutlinedButton(onClick = { loadTargets() }, enabled = online && !targetsBusy && client != null) { Text(if (targetsBusy) "正在载入…" else "显示全部目标") }
     targetsFailure?.let { UtFeedback(it, kind = "error") }
     val manual = targets
     if (manual != null) {
      if (manual.isEmpty()) UtEmptyState("Gateway 没有提供目标") else {
       UtLabel("手动选择")
       manual.forEach { candidate -> TargetChoice(candidate, busy || !online) { send(candidate.choice, false) } }
      }
     }
    }
   }
   if (askShowsAction(answer.status)) answer.action?.let { action -> UtPanel { UtLabel("执行结果"); ActionRecord(action) } }
   else if (askShowsAction(answer.status) && answer.action == null && answer.status != ASK_UNAVAILABLE && answer.status != ASK_REFUSED) {
    UtEmptyState("这个状态没有附带执行记录", "Gateway 只返回了状态本身。")
   }
  }
 }
}

@Composable private fun ConfirmationText(answer: AskResult, typed: String) {
 Text(
  "将会做什么：" + (answer.confirmation?.description?.takeIf { it.isNotBlank() } ?: answer.message.ifBlank { "执行 " + (answer.target ?: "匹配到的目标") }),
  style = MaterialTheme.typography.bodyMedium,
  color = MaterialTheme.colorScheme.onSurface,
 )
 Text(
  "发送的原话：\"" + answer.text.ifBlank { typed } + "\"",
  style = MaterialTheme.typography.bodySmall,
  color = MaterialTheme.colorScheme.onSurfaceVariant,
 )
}

@Composable private fun TargetChoice(candidate: TargetOption, disabled: Boolean, choose: () -> Unit) {
 UtPanel {
  Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
   Text(candidate.label, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
   StatusChip(candidate.stateLabel)
  }
  if (candidate.description.isNotBlank()) Text(candidate.description, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
  if (candidate.sideEffect) UtFeedback("这个目标会产生真实的外部副作用。", kind = "warn")
  if (candidate.mutating) UtFeedback("会写入本地产品数据。", kind = "warn")
  // route/target/operation and the example stay reachable but folded
  TechnicalDetails(listOf(
   "route" to candidate.route,
   "target" to candidate.target,
   "operation" to (candidate.operation ?: ""),
   "available" to candidate.available.toString(),
   "example" to candidate.example,
  ))
  OutlinedButton(onClick = choose, enabled = !disabled && candidate.available) { Text("选择") }
 }
}
