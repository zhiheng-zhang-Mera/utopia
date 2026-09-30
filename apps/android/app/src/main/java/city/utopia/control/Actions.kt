package city.utopia.control

import org.json.JSONArray
import org.json.JSONObject

// Canonical Action facade (T2) and Ask / Do (T3) shapes from the frozen contract.
// Every value here is read verbatim from the gateway: nothing is re-derived locally,
// because Web and Android must show the same actionId, status and result truth.

val ACTION_ROUTES = setOf("ROOM", "CAPABILITY", "CITY_TASK")

/** Null-or-blank-safe readers for the flat envelope. `JSONObject.NULL` counts as absent. */
fun JSONObject.textOrNull(name: String): String? = if (!has(name) || isNull(name)) null else optString(name).takeIf { it.isNotBlank() }
fun JSONObject.textOrEmpty(name: String): String = textOrNull(name) ?: ""

// The exhaustive Action status vocabulary. No client may invent a status.
val ACTION_STATUSES = setOf("QUEUED", "RUNNING", "WAITING_CONFIRMATION", "SUCCEEDED", "FAILED", "REFUSED", "CANCELLED", "UNAVAILABLE")

fun isActionRoute(route: String) = route in ACTION_ROUTES
fun isActionStatus(status: String) = status in ACTION_STATUSES

/** What a status means for the person reading the screen. Purely presentational. */
fun actionStatusLabel(status: String) = when (status) {
 "QUEUED" -> "QUEUED · waiting to start"
 "RUNNING" -> "RUNNING · in progress"
 "WAITING_CONFIRMATION" -> "WAITING FOR CONFIRMATION"
 "SUCCEEDED" -> "SUCCEEDED"
 "FAILED" -> "FAILED"
 "REFUSED" -> "REFUSED · not allowed by policy"
 "CANCELLED" -> "CANCELLED"
 "UNAVAILABLE" -> "UNAVAILABLE · cannot run right now"
 else -> if (status.isBlank()) "UNKNOWN" else status
}

/** Reference to the backend that really owns the execution; the facade never rewrites it. */
data class BackendRef(val kind: String, val id: String, val roomId: String?, val operationId: String?)
data class ActionTarget(val id: String, val label: String, val operation: String?)
data class ActionResultRef(val kind: String, val id: String, val digest: String?, val summary: String)
data class ActionError(val code: String, val message: String)
data class ActionHistoryEntry(val at: String, val status: String, val note: String)
data class ActionProvenance(
 val source: String,
 val host: String,
 val roomId: String?,
 val capabilityId: String?,
 val taskId: String?,
 val invocationId: String?,
 val history: List<ActionHistoryEntry>,
)

/** The compact row shown in the newest-first Action list. */
data class ActionSummary(
 val actionId: String,
 val requestedIntent: String,
 val route: String,
 val targetLabel: String,
 val status: String,
 val statusLabel: String,
 val progress: Int,
 val resultText: String,
 val errorCode: String?,
) {
 val progressFraction: Float get() = (progress.coerceIn(0, 100)) / 100f
 val hasProgress: Boolean get() = progress in 0..100
}

/** The full record, including provenance, shown after GET /api/v0/actions/<actionId>. */
data class ActionDetail(
 val summary: ActionSummary,
 val actionId: String,
 val backendRef: BackendRef?,
 val target: ActionTarget?,
 val resultRef: ActionResultRef?,
 val error: ActionError?,
 val provenance: ActionProvenance?,
 val createdAt: String,
 val updatedAt: String,
)

fun parseBackendRef(row: JSONObject?): BackendRef? = row?.let { BackendRef(it.textOrEmpty("kind"), it.textOrEmpty("id"), it.textOrNull("roomId"), it.textOrNull("operationId")) }

fun parseActionError(row: JSONObject?): ActionError? = row?.let { ActionError(it.textOrEmpty("code"), it.textOrEmpty("message")) }

fun parseActionSummary(row: JSONObject): ActionSummary {
 val status = row.textOrEmpty("status")
 val error = parseActionError(row.optJSONObject("error"))
 val resultRef = row.optJSONObject("resultRef")
 val backendRef = row.optJSONObject("backendRef")
 val target = row.optJSONObject("target")
 val label = target?.textOrEmpty("label").orEmpty().ifBlank { backendRef?.textOrEmpty("id").orEmpty() }
 return ActionSummary(
  actionId = row.textOrEmpty("actionId"),
  requestedIntent = row.textOrEmpty("requestedIntent"),
  route = row.textOrEmpty("route"),
  targetLabel = target?.textOrEmpty("operation").orEmpty().let { if (label.isBlank()) it else if (it.isBlank()) label else "$label · $it" },
  status = status,
  statusLabel = actionStatusLabel(status),
  progress = row.optInt("progress", 0),
  resultText = resultRef?.textOrEmpty("summary").orEmpty().ifBlank { error?.message.orEmpty() },
  errorCode = error?.code?.takeIf { it.isNotBlank() },
 )
}

fun parseActionDetail(row: JSONObject): ActionDetail {
 val history = mutableListOf<ActionHistoryEntry>()
 row.optJSONObject("provenance")?.optJSONArray("history")?.let { array ->
  for (index in 0 until array.length()) {
   val entry = array.optJSONObject(index) ?: continue
   history += ActionHistoryEntry(entry.textOrEmpty("at"), entry.textOrEmpty("status"), entry.textOrEmpty("note"))
  }
 }
 val provenance = row.optJSONObject("provenance")?.let {
  ActionProvenance(
   source = it.textOrEmpty("source"),
   host = it.textOrEmpty("host"),
   roomId = it.textOrNull("roomId"),
   capabilityId = it.textOrNull("capabilityId"),
   taskId = it.textOrNull("taskId"),
   invocationId = it.textOrNull("invocationId"),
   history = history,
  )
 }
 val target = row.optJSONObject("target")
 val resultRef = row.optJSONObject("resultRef")
 return ActionDetail(
  summary = parseActionSummary(row),
  actionId = row.textOrEmpty("actionId"),
  backendRef = parseBackendRef(row.optJSONObject("backendRef")),
  target = target?.let { ActionTarget(it.textOrEmpty("id"), it.textOrEmpty("label"), it.textOrNull("operation")) },
  resultRef = resultRef?.let { ActionResultRef(it.textOrEmpty("kind"), it.textOrEmpty("id"), it.textOrNull("digest"), it.textOrEmpty("summary")) },
  error = parseActionError(row.optJSONObject("error")),
  provenance = provenance,
  createdAt = row.textOrEmpty("createdAt"),
  updatedAt = row.textOrEmpty("updatedAt"),
 )
}

fun parseActions(rows: List<JSONObject>): List<ActionSummary> = rows.map { parseActionSummary(it) }

/** A route target, and the shape of every Ask candidate (contract §3). */
data class TargetOption(
 val route: String,
 val target: String,
 val operation: String?,
 val label: String,
 val description: String,
 val mutating: Boolean,
 val sideEffect: Boolean,
 val available: Boolean,
 val unavailableReason: String?,
 val example: String,
) {
 val stateLabel: String get() = if (!available) "UNAVAILABLE" + (unavailableReason?.let { " · $it" } ?: "") else if (sideEffect) "SIDE EFFECT · asks to confirm" else "SAFE"
 val choice: JSONObject get() = JSONObject().put("route", route).put("target", target).put("operation", operation ?: JSONObject.NULL)
}

fun parseTarget(row: JSONObject): TargetOption = TargetOption(
 route = row.textOrEmpty("route"),
 target = row.textOrEmpty("target"),
 operation = row.textOrNull("operation"),
 label = row.textOrEmpty("label").ifBlank { row.textOrEmpty("target") },
 description = row.textOrEmpty("description"),
 mutating = row.optBoolean("mutating", false),
 sideEffect = row.optBoolean("sideEffect", false),
 available = row.optBoolean("available", false),
 unavailableReason = row.textOrNull("unavailableReason"),
 example = row.textOrEmpty("example"),
)

fun parseTargets(rows: List<JSONObject>): List<TargetOption> = rows.map { parseTarget(it) }

// AskResult.status vocabulary (contract §3). Exhaustive; anything else is surfaced verbatim.
val ASK_RESOLVED = "RESOLVED"
val ASK_AWAITING_CONFIRMATION = "AWAITING_CONFIRMATION"
val ASK_AMBIGUOUS = "AMBIGUOUS"
val ASK_UNMATCHED = "UNMATCHED"
val ASK_COMPLETED = "COMPLETED"
val ASK_FAILED = "FAILED"
val ASK_REFUSED = "REFUSED"
val ASK_UNAVAILABLE = "UNAVAILABLE"

val ASK_STATUSES = setOf(ASK_RESOLVED, ASK_AWAITING_CONFIRMATION, ASK_AMBIGUOUS, ASK_UNMATCHED, ASK_COMPLETED, ASK_FAILED, ASK_REFUSED, ASK_UNAVAILABLE)

fun isAskStatus(status: String) = status in ASK_STATUSES

/** An Action ran (or was resolved into one): the UI shows the Action record. */
fun askShowsAction(status: String) = status in setOf(ASK_RESOLVED, ASK_COMPLETED, ASK_FAILED, ASK_REFUSED, ASK_UNAVAILABLE)

/** The request needs something from the user before anything executes. */
fun askNeedsUser(status: String) = status in setOf(ASK_AWAITING_CONFIRMATION, ASK_AMBIGUOUS, ASK_UNMATCHED)

/** Truthful, non-alarming description of why nothing ran. UNAVAILABLE/UNMATCHED are product states, not errors. */
fun askStatusLabel(status: String) = when (status) {
 ASK_RESOLVED -> "MATCHED A RULE"
 ASK_AWAITING_CONFIRMATION -> "NEEDS CONFIRMATION"
 ASK_AMBIGUOUS -> "SEVERAL MATCHES · CHOOSE ONE"
 ASK_UNMATCHED -> "NO RULE MATCHED"
 ASK_COMPLETED -> "COMPLETED"
 ASK_FAILED -> "FAILED"
 ASK_REFUSED -> "REFUSED · not allowed by policy"
 ASK_UNAVAILABLE -> "UNAVAILABLE · the target cannot run right now"
 else -> if (status.isBlank()) "UNKNOWN" else status
}

/** Provenance of the routing decision, so the screen never implies a model chose the route. */
fun askRouterLabel(router: String, deterministic: Boolean, llm: Boolean): String {
 val name = router.ifBlank { "UNKNOWN" }
 val parts = mutableListOf(name)
 if (deterministic) parts += "deterministic rules"
 if (llm) parts += "model"
 if (!deterministic && !llm) parts += "client cannot tell"
 return "Routed by " + parts.joinToString(" · ")
}

data class AskConfirmation(val label: String, val description: String, val sideEffect: Boolean)

data class AskResult(
 val text: String,
 val status: String,
 val statusLabel: String,
 val route: String?,
 val target: String?,
 val operation: String?,
 val candidates: List<TargetOption>,
 val confirmation: AskConfirmation?,
 val action: ActionDetail?,
 val message: String,
 val router: String,
 val routerLabel: String,
 val deterministic: Boolean,
 val llm: Boolean,
) {
 val isKnownStatus: Boolean get() = isAskStatus(status)
 /** A rule matched, so Confirm may be offered with the matched route/target/operation. */
 val matchedSelection: JSONObject? get() = if (route.isNullOrBlank() || target.isNullOrBlank()) null else JSONObject().put("route", route).put("target", target).put("operation", operation ?: JSONObject.NULL)
}

fun parseAskConfirmation(row: JSONObject?): AskConfirmation? = row?.let {
 AskConfirmation(
  label = it.textOrEmpty("label").ifBlank { "Confirm" },
  description = it.textOrEmpty("description"),
  sideEffect = it.optBoolean("sideEffect", true),
 )
}

fun parseAskResult(row: JSONObject): AskResult {
 val status = row.textOrEmpty("status")
 val router = row.textOrEmpty("router")
 val deterministic = row.optBoolean("deterministic", false)
 val llm = row.optBoolean("llm", false)
 return AskResult(
  text = row.textOrEmpty("text"),
  status = status,
  statusLabel = askStatusLabel(status),
  route = row.textOrNull("route"),
  target = row.textOrNull("target"),
  operation = row.textOrNull("operation"),
  candidates = parseTargets(arrayObjects(row.optJSONArray("candidates"))),
  confirmation = parseAskConfirmation(row.optJSONObject("confirmation")),
  action = row.optJSONObject("action")?.let { parseActionDetail(it) },
  message = row.textOrEmpty("message"),
  router = router,
  routerLabel = askRouterLabel(router, deterministic, llm),
  deterministic = deterministic,
  llm = llm,
 )
}

/** Shared array reader; mirrors the `objects()`/`values()` helpers used elsewhere in the module. */
fun arrayObjects(array: JSONArray?): List<JSONObject> = if (array == null) emptyList() else (0 until array.length()).mapNotNull { array.optJSONObject(it) }
