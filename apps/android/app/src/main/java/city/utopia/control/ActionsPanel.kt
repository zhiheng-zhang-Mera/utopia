package city.utopia.control

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import city.utopia.control.theme.Space
import city.utopia.control.ui.StatusChip
import city.utopia.control.ui.TechnicalDetails
import city.utopia.control.ui.ToolRow
import city.utopia.control.ui.UtEmptyState
import city.utopia.control.ui.UtFeedback
import city.utopia.control.ui.UtLabel
import city.utopia.control.ui.UtPanel

// T2 — the canonical Action facade. Every field shown here is the gateway's own value:
// Android never re-derives status, so the actionId and status match what Web shows.
//
// UI-102: the default reading path now shows what HAPPENED (status, your words, the
// outcome). The internal identifiers that used to be printed inline — actionId, route,
// target id, error code, backendRef/resultRef, digests, provenance, timestamps — are
// folded into a collapsed 运行详情. They are folded, not deleted: expanding shows every
// value verbatim, and this remains the gateway's record rather than a client summary.

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
    val parsed = runCatching { parseActionList(response) }.getOrElse { null }
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
 Column(verticalArrangement = Arrangement.spacedBy(Space.md), modifier = Modifier.fillMaxWidth()) {
  UtLabel("操作记录")
  Text("Actions", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground)
  Text(
   "每一次执行过的动作。这里显示发生了什么；内部标识符收在运行详情里。",
   style = MaterialTheme.typography.bodySmall,
   color = MaterialTheme.colorScheme.onSurfaceVariant,
  )
  Row(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
   OutlinedTextField(limit, { limit = it.filter { c -> c.isDigit() }.take(3) }, label = { Text("条数") }, singleLine = true, enabled = !busy, modifier = Modifier.weight(1f))
   OutlinedButton(onClick = { load() }, enabled = !busy && client != null) { Text("刷新") }
  }
  if (client == null) UtEmptyState("还没有连接到城市", "连接后这里会显示真实的执行记录。")
  if (busy) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
  failure?.let { UtFeedback(it, kind = "error") }
  val rows = actions
  if (rows == null) UtEmptyState("还没有载入记录", "刷新以读取 Gateway 的执行记录。")
  else if (rows.isEmpty()) UtEmptyState("还没有任何操作", "可以从「对话 · 执行」开始一件。")
  else {
   UtLabel("最近 ${rows.size} 条")
   rows.forEach { row -> UtPanel(Modifier.clickable { open(row.actionId) }, accent = row.status == "RUNNING") {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
     Text(row.requestedIntent.ifBlank { "(没有记录意图)" }, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
     Spacer(Modifier.width(Space.sm))
     StatusChip(row.status)
    }
    if (row.hasProgress && row.status == "RUNNING") {
     LinearProgressIndicator(progress = { row.progressFraction }, modifier = Modifier.fillMaxWidth())
    }
    if (row.resultText.isNotBlank()) Text(row.resultText, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    row.errorCode?.let { UtFeedback(it, kind = "error") }
    // folded: identifiers, route/target and exact progress
    TechnicalDetails(listOf(
     "actionId" to row.actionId,
     "route" to row.route,
     "target" to row.targetLabel.ifBlank { "unknown target" },
     "progress" to (row.progress.toString() + "%"),
     "errorCode" to (row.errorCode ?: ""),
    ))
   } }
  }
  selectedId?.let { id ->
   UtPanel {
    UtLabel("选中的操作")
    OutlinedButton(onClick = { selectedId = null; detail = null; detailFailure = null }) { Text("关闭详情") }
    if (detailBusy) { Text("正在载入完整记录…", style = MaterialTheme.typography.bodySmall); LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) }
    detailFailure?.let { UtFeedback(it, kind = "error") }
    detail?.let { ActionRecord(it) } ?: TechnicalDetails(listOf("actionId" to id))
   }
  }
 }
}

/** What happened, in the user's terms. Identifiers live in the folded block below. */
@Composable fun ActionRecord(detail: ActionDetail) {
 val row = detail.summary
 Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
  Text(row.requestedIntent.ifBlank { "(没有记录意图)" }, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
  Spacer(Modifier.width(Space.sm))
  StatusChip(row.status)
 }
 detail.target?.let {
  ToolRow("目标", it.label.ifBlank { it.id } + (it.operation?.let { op -> " · " + op } ?: ""))
 }
 detail.resultRef?.let { ref ->
  if (ref.summary.isNotBlank()) Text(ref.summary, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
 }
 detail.error?.let { UtFeedback(it.code + " · " + it.message, kind = "error") }
 // Everything internal, verbatim and reachable, but folded by default.
 val technical = buildList {
  add("actionId" to row.actionId)
  add("status" to row.status)
  add("route" to row.route)
  add("progress" to (row.progress.toString() + "%"))
  detail.target?.let { add("targetId" to it.id); add("operation" to (it.operation ?: "")) }
  detail.backendRef?.let { ref ->
   add("backendRef.kind" to ref.kind)
   add("backendRef.id" to ref.id)
   add("backendRef.roomId" to (ref.roomId ?: ""))
   add("backendRef.operationId" to (ref.operationId ?: ""))
  }
  detail.resultRef?.let { ref ->
   add("resultRef.kind" to ref.kind)
   add("resultRef.id" to ref.id)
   add("resultRef.digest" to (ref.digest ?: ""))
  }
  detail.error?.let { add("error.code" to it.code); add("error.message" to it.message) }
  detail.provenance?.let { p ->
   add("provenance.source" to p.source)
   add("provenance.host" to p.host)
   add("provenance.roomId" to (p.roomId ?: "—"))
   add("provenance.capabilityId" to (p.capabilityId ?: "—"))
   add("provenance.taskId" to (p.taskId ?: "—"))
   add("provenance.invocationId" to (p.invocationId ?: "—"))
   p.history.forEachIndexed { index, entry ->
    add("history[$index]" to (entry.status + " · " + entry.at + (if (entry.note.isBlank()) "" else " · " + entry.note)))
   }
  }
  add("createdAt" to detail.createdAt.ifBlank { "Unavailable" })
  add("updatedAt" to detail.updatedAt.ifBlank { "Unavailable" })
 }
 TechnicalDetails(technical)
}
