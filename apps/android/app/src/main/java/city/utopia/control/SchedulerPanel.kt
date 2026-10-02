package city.utopia.control

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import city.utopia.control.theme.Space
import city.utopia.control.ui.TechnicalDetails
import city.utopia.control.ui.UtLabel
import city.utopia.control.ui.UtPanel
import org.json.JSONObject

/**
 * UTOPIA · Android Control Surface — scheduler status surface (UXI-301 steps 2/3/5/6).
 *
 * The Android counterpart of `apps/web/scheduler.js`, rendering the same semantics through
 * `SchedulerPresentation` so the two surfaces explain scheduling in the same words.
 *
 * THREE RULES THIS FILE KEEPS, all of them acceptance items rather than preferences:
 *
 *   1. An unavailable provider is SHOWN with its reason and carries NO click modifier. It is text, not
 *      a control, so it cannot become clickable by a later edit that forgets a guard.
 *   2. Raw vocabulary is reachable only through the shared `TechnicalDetails` fold, which is collapsed
 *      by default. The gate is that component's own behaviour, not a condition here - the same
 *      "folded, not deleted" discipline the module's own TechnicalFoldingTest pins, reused rather than
 *      reimplemented.
 *   3. A missing feed is reported as NOT REPORTED. It must never fall through to an empty or healthy
 *      looking surface, because "we could not ask" and "nothing is waiting" are different facts.
 */
@Composable
fun SchedulerStatusPanel(
  feed: JSONObject?,
  online: Boolean,
  supportedActions: Set<String> = emptySet(),
  onAction: ((taskId: String, token: String, providerRef: String?) -> Unit)? = null,
) {
  UtPanel {
    Column(Modifier.fillMaxWidth().padding(Space.md), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
      UtLabel("Why things are waiting")
      when {
        !online -> Text("Reconnect to see why this is waiting.", style = MaterialTheme.typography.bodyMedium)
        feed == null -> Text("Scheduling status is not being reported right now.", style = MaterialTheme.typography.bodyMedium)
        else -> {
          val tasks = feed.optJSONArray("tasks")
          if (tasks == null || tasks.length() == 0) {
            Text("Nothing is waiting to run.", style = MaterialTheme.typography.bodyMedium)
          } else {
            for (i in 0 until tasks.length()) {
              val entry = tasks.optJSONObject(i) ?: continue
              SchedulerTaskCard(entry, supportedActions, onAction)
            }
          }
        }
      }
    }
  }
}

@Composable
private fun SchedulerTaskCard(entry: JSONObject, supportedActions: Set<String>, onAction: ((String, String, String?) -> Unit)?) {
  val taskId = entry.optString("taskId")
  val dto = entry.optJSONObject("dto")
  // A malformed or drifted DTO must not crash the surface. It is rendered as an honest "not reported"
  // line instead: a blank or invented status would be worse than an explicit gap, and a crash would be
  // worst of all for the person holding the device.
  val view = dto?.let { runCatching { SchedulerPresentation.viewModel(it) }.getOrNull() }
  if (view == null) {
    Text("This task's status is not being reported right now.", style = MaterialTheme.typography.bodyMedium)
    return
  }

  Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
      Text(view.stateLabel, style = MaterialTheme.typography.titleMedium)
      Text(taskId, style = MaterialTheme.typography.labelSmall)
    }
    if (view.choiceRequired) {
      Text(
        "The current service is responding slowly. Use another available one?",
        style = MaterialTheme.typography.bodyMedium,
      )
    }
    if (view.degraded) {
      Text(
        "Some of what this depends on is not fully known right now.",
        style = MaterialTheme.typography.bodyMedium,
      )
    }
    if (view.providers.isEmpty()) {
      Text("No device is being considered for this yet.", style = MaterialTheme.typography.bodyMedium)
    }
    for (provider in view.providers) {
      // Text only: no clickable, no button. An unavailable provider must not become interactive.
      Text(
        (if (provider.selectable) "Available · " else "Not available · ") + provider.reason,
        style = MaterialTheme.typography.bodyMedium,
      )
    }
    if (view.actions.isNotEmpty()) {
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
        for (action in view.actions) {
          // An action with no backend route must NOT be presented as a live control. The web surface
          // renders exactly these as a DISABLED button carrying the label and `data-scheduler-unwired`;
          // Android used to render every action as an enabled TextButton, so CONFIRM -- which the web says
          // has "NO ROUTE EXISTS YET" -- read as available and silently did nothing when tapped. A disabled
          // button is the same affordance the web chosen, and it says "not available" without inventing a
          // route the backend does not have.
          // TWO independent reasons an action must not be offered as live, and BOTH are now checked:
          //   1. it has no backend ROUTE -- the web's wiring map marks CONFIRM 'unwired'; and
          //   2. NO HANDLER was wired by the caller at all. MainActivity passes no onAction, so before this
          //      fix EVERY action on this surface was enabled, clickable and inert -- CANCEL included, not
          //      just CONFIRM. That is the honesty fault exactly as Mech diagnosed it: "a control that looks
          //      functional and does nothing teaches the user their choice was received, which is worse than
          //      an honest gap." The route map alone would have fixed only the unrouted action and left the
          //      rest looking live, so the handler check is the load-bearing half.
          val handler = onAction
          // Live only if a handler EXISTS, the surface SUPPORTS the action, and the action is ROUTED.
          // Three independent reasons a control must not be offered as available, all checked.
          val live = handler != null && action.token in supportedActions && action.token !in SchedulerPresentation.UNWIRED_ACTIONS
          // A provider choice must NAME a service, and THE UI MUST NOT NAME IT. The web is explicit about
          // this: its CHOOSE_PROVIDER is "deliberately NOT a submitting control", because "a button here
          // that sent the first available ref would be the UI making the choice" -- and the workbook
          // forbids the UI recomputing the provider choice. So no ref is resolved here at all; a real
          // choice must come from a control ON the provider row that carries that provider's own ref.
          // Sending null is the honest state until that per-row control exists: the client refuses a blank
          // ref, so this can never transmit a choice the user did not make.
          val chosenRef: String? = null
          TextButton(onClick = { handler?.invoke(taskId, action.token, chosenRef) }, enabled = live) { Text(action.label) }
        }
      }
    }
    // The Advanced gate: collapsed by default, so raw vocabulary is present but not on the reading
    // path. Rows are built only from the DTO, never invented.
    val rows = listOf(
      "state" to (dto?.optString("state") ?: ""),
      "provider terms" to (dto?.optJSONArray("providers")?.let { array ->
        (0 until array.length()).mapNotNull { array.optJSONObject(it)?.optString("term") }.joinToString(", ")
      } ?: ""),
      "provider choice required" to dto?.optBoolean("provider_choice_required", false).toString(),
      "from backend truth" to dto?.optBoolean("from_backend_truth", false).toString(),
      "fabricated" to dto?.optBoolean("fabricated", false).toString(),
    )
    TechnicalDetails(rows, title = "Scheduling detail")
  }
}
