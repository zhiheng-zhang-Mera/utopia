package city.utopia.control

import org.json.JSONObject

/**
 * UTOPIA · Android Control Surface — scheduler presentation adapter (UXI-301 step 2).
 *
 * The Android half of the SAME semantics as `apps/web/scheduler-adapter.js`. The workbook requires the
 * two surfaces to share semantics, not pixels, so this mirrors the web adapter's rules exactly:
 *
 *   - one user-facing line per presentation TERM, and a headline per presentation STATE;
 *   - severity for the four meaning-bearing classes is a FUNCTION of the contract class
 *     (PERMITTED/RESOURCE/STRUCTURAL/KNOWLEDGE), so the emphasis cannot contradict the meaning;
 *   - STATE-class terms are excluded from that rule and BOUNDED instead, never BLOCKED and never OK,
 *     because the contract calls them STATE precisely because they are neither permission nor refusal;
 *   - a provider is selectable ONLY when the feed says so AND its severity is OK. The second half is
 *     what makes "unavailable providers are visible but not selectable" structural rather than a
 *     rendering convention a future edit could break;
 *   - an unknown term, state or action THROWS rather than rendering blank, because a blank status for a
 *     real condition is the failure the whole contract exists to prevent.
 *
 * The copy is inline because this application has no `res/` string resources - the existing convention
 * here is Kotlin literals, as `Devices.kt` shows. Parity of WORDING across the two surfaces is checked
 * rather than assumed: `tests/android-scheduler-parity.test.mjs` parses this file and asserts the term
 * set equals the frozen contract exactly, in both directions.
 */
internal enum class SchedulerSeverity { OK, WAITING, BLOCKED, UNKNOWN, NEUTRAL, ATTENTION }

internal data class SchedulerTermCopy(val term: String, val copy: String, val severity: SchedulerSeverity)

internal data class SchedulerProvider(
  val index: Int,
  val reason: String,
  val severity: SchedulerSeverity,
  val selectable: Boolean,
)

internal data class SchedulerAction(val token: String, val label: String, val primary: Boolean)

internal data class SchedulerView(
  val stateLabel: String,
  val severity: SchedulerSeverity,
  val providers: List<SchedulerProvider>,
  val actions: List<SchedulerAction>,
  val choiceRequired: Boolean,
  val degraded: Boolean,
  val structuralRefusal: Boolean,
  /** Raw vocabulary, and the ONLY place it may appear. Null unless the caller asked for detail. */
  val technical: String?,
)

internal object SchedulerPresentation {
  const val PRESENTATION_VERSION = 1

  /**
   * Severity for the classes that carry meaning. Throws on an unknown class rather than defaulting,
   * so a contract change surfaces here instead of silently mis-emphasising a status.
   */
  fun severityOfClass(termClass: String): SchedulerSeverity = when (termClass) {
    "PERMITTED" -> SchedulerSeverity.OK
    "RESOURCE" -> SchedulerSeverity.WAITING
    "STRUCTURAL" -> SchedulerSeverity.BLOCKED
    "KNOWLEDGE" -> SchedulerSeverity.UNKNOWN
    else -> throw IllegalArgumentException("unknown term class $termClass; the adapter table has drifted from the contract")
  }

  /** Severities a STATE-class term may carry: bounded, never BLOCKED, never OK. */
  val STATE_SEVERITIES = setOf(SchedulerSeverity.NEUTRAL, SchedulerSeverity.WAITING, SchedulerSeverity.ATTENTION)

  /**
   * One entry per presentation term. The formatting of these lines is load-bearing: the parity test
   * parses them, so each entry stays on its own line as `"TERM" to SchedulerTermCopy(`.
   */
  val TERM_COPY: Map<String, SchedulerTermCopy> = mapOf(
    "SELECTABLE" to SchedulerTermCopy("SELECTABLE", "Available now", SchedulerSeverity.OK),
    "DEVICE_ONLINE" to SchedulerTermCopy("DEVICE_ONLINE", "Device is online", SchedulerSeverity.OK),
    "REMOTE_ONLINE" to SchedulerTermCopy("REMOTE_ONLINE", "Remote side is back online", SchedulerSeverity.OK),
    "USER_DISABLED" to SchedulerTermCopy("USER_DISABLED", "You turned this off", SchedulerSeverity.BLOCKED),
    "ABSENT" to SchedulerTermCopy("ABSENT", "Not set up yet", SchedulerSeverity.BLOCKED),
    "REMOVED" to SchedulerTermCopy("REMOVED", "You removed this", SchedulerSeverity.BLOCKED),
    "REGION_UNSUPPORTED" to SchedulerTermCopy("REGION_UNSUPPORTED", "Not available in your region", SchedulerSeverity.BLOCKED),
    "DEVICE_UNREACHABLE" to SchedulerTermCopy("DEVICE_UNREACHABLE", "This device can't be reached right now", SchedulerSeverity.BLOCKED),
    "DEVICE_REFUSING" to SchedulerTermCopy("DEVICE_REFUSING", "This device isn't taking new work", SchedulerSeverity.BLOCKED),
    "DEVICE_DISABLED" to SchedulerTermCopy("DEVICE_DISABLED", "This device is turned off", SchedulerSeverity.BLOCKED),
    "POLICY_EXCLUDED" to SchedulerTermCopy("POLICY_EXCLUDED", "Your own rules keep this out of the pool", SchedulerSeverity.BLOCKED),
    "CREDENTIALS_MISSING" to SchedulerTermCopy("CREDENTIALS_MISSING", "Needs a sign-in before it can be used", SchedulerSeverity.WAITING),
    "SESSION_ENDED" to SchedulerTermCopy("SESSION_ENDED", "Your session ended; signing in again brings this back", SchedulerSeverity.WAITING),
    "SERVICE_FAULT" to SchedulerTermCopy("SERVICE_FAULT", "The service is having trouble", SchedulerSeverity.WAITING),
    "AT_CAPACITY" to SchedulerTermCopy("AT_CAPACITY", "Busy at the moment", SchedulerSeverity.WAITING),
    "SESSION_CONGESTED" to SchedulerTermCopy("SESSION_CONGESTED", "Congested right now", SchedulerSeverity.WAITING),
    "PRESSURE_PAUSED" to SchedulerTermCopy("PRESSURE_PAUSED", "Paused while it catches up", SchedulerSeverity.WAITING),
    "LOAD_UNMEASURED" to SchedulerTermCopy("LOAD_UNMEASURED", "Still measuring how busy it is", SchedulerSeverity.WAITING),
    "AVAILABILITY_UNKNOWN" to SchedulerTermCopy("AVAILABILITY_UNKNOWN", "We haven't checked whether this is available", SchedulerSeverity.UNKNOWN),
    "CHANNEL_READINESS_UNKNOWN" to SchedulerTermCopy("CHANNEL_READINESS_UNKNOWN", "We haven't checked whether this channel is ready", SchedulerSeverity.UNKNOWN),
    "FRESHNESS_UNKNOWN" to SchedulerTermCopy("FRESHNESS_UNKNOWN", "No recent reading for this yet", SchedulerSeverity.UNKNOWN),
    "FRESHNESS_STALE" to SchedulerTermCopy("FRESHNESS_STALE", "Our last reading is out of date", SchedulerSeverity.UNKNOWN),
    "REMOTE_STATE_UNKNOWN" to SchedulerTermCopy("REMOTE_STATE_UNKNOWN", "We can't see the remote side right now", SchedulerSeverity.UNKNOWN),
    "DEGRADED" to SchedulerTermCopy("DEGRADED", "Running in a reduced state", SchedulerSeverity.ATTENTION),
    "QUEUED" to SchedulerTermCopy("QUEUED", "Waiting its turn", SchedulerSeverity.WAITING),
    "WAITING_USER" to SchedulerTermCopy("WAITING_USER", "Waiting for you", SchedulerSeverity.ATTENTION),
    "REMOTE_HANDOFF" to SchedulerTermCopy("REMOTE_HANDOFF", "Handed to another device", SchedulerSeverity.NEUTRAL),
  )

  val STATE_COPY: Map<String, SchedulerTermCopy> = mapOf(
    "QUEUED" to SchedulerTermCopy("QUEUED", "Waiting for an available slot", SchedulerSeverity.WAITING),
    "RUNNING" to SchedulerTermCopy("RUNNING", "In progress", SchedulerSeverity.OK),
    "REMOTE_HANDOFF" to SchedulerTermCopy("REMOTE_HANDOFF", "Running on another device — you can stay right here", SchedulerSeverity.NEUTRAL),
    "WAITING_USER" to SchedulerTermCopy("WAITING_USER", "Waiting for your decision", SchedulerSeverity.ATTENTION),
    "DEGRADED" to SchedulerTermCopy("DEGRADED", "Running in a reduced state", SchedulerSeverity.ATTENTION),
    "COMPLETED" to SchedulerTermCopy("COMPLETED", "Finished", SchedulerSeverity.OK),
    "FAILED" to SchedulerTermCopy("FAILED", "Didn't finish", SchedulerSeverity.BLOCKED),
    "CANCELLED" to SchedulerTermCopy("CANCELLED", "Cancelled", SchedulerSeverity.NEUTRAL),
  )

  val ACTION_COPY: Map<String, Pair<String, Boolean>> = mapOf(
    "CANCEL" to ("Cancel" to false),
    "RETRY" to ("Try again" to true),
    "KEEP_WAITING" to ("Keep waiting" to true),
    "CHOOSE_PROVIDER" to ("Choose another service" to true),
    "CONFIRM" to ("Confirm" to true),
  )

  /**
   * Build the user-facing view. `dto` is the feed's per-task DTO as delivered by
   * `GET /api/v0/presentation`; nothing else is accepted, because the contract has already refused raw
   * component words upstream.
   */
  fun viewModel(dto: JSONObject, advanced: Boolean = false): SchedulerView {
    val state = dto.optString("state")
    val stateCopy = STATE_COPY[state]
      ?: throw IllegalArgumentException("unknown presentation state $state; the adapter table has drifted from the contract")

    val providerArray = dto.optJSONArray("providers")
    val providers = ArrayList<SchedulerProvider>()
    if (providerArray != null) {
      for (i in 0 until providerArray.length()) {
        val entry = providerArray.optJSONObject(i) ?: continue
        val term = entry.optString("term")
        val copy = TERM_COPY[term]
          ?: throw IllegalArgumentException("unknown presentation term $term; the adapter table has drifted from the contract")
        // Selectable ONLY when the feed says so AND the term is permitted. A feed that lies with
        // selectable=true on a refusal still cannot make it selectable here.
        val selectable = entry.optBoolean("selectable", false) && copy.severity == SchedulerSeverity.OK
        providers.add(SchedulerProvider(i, copy.copy, copy.severity, selectable))
      }
    }

    val actionArray = dto.optJSONArray("actions")
    val actions = ArrayList<SchedulerAction>()
    if (actionArray != null) {
      for (i in 0 until actionArray.length()) {
        val token = actionArray.optString(i)
        val copy = ACTION_COPY[token]
          ?: throw IllegalArgumentException("unknown action $token; the adapter table has drifted from the contract")
        actions.add(SchedulerAction(token, copy.first, copy.second))
      }
    }

    val technical = if (!advanced) null else JSONObject()
      .put("state", state)
      .put("terms", dto.optJSONArray("terms") ?: org.json.JSONArray())
      .put("provider_choice_required", dto.optBoolean("provider_choice_required", false))
      .put("fabricated", dto.optBoolean("fabricated", false))
      .put("from_backend_truth", dto.optBoolean("from_backend_truth", false))
      .toString()

    return SchedulerView(
      stateLabel = stateCopy.copy,
      severity = stateCopy.severity,
      providers = providers,
      actions = actions,
      choiceRequired = dto.optBoolean("provider_choice_required", false),
      degraded = dto.optBoolean("degraded", false),
      structuralRefusal = dto.optBoolean("structural_refusal", false),
      technical = technical,
    )
  }
}
