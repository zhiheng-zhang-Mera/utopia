/**
 * UTOPIA · Web Control Surface — scheduler presentation adapter (UXI-301 step 1).
 *
 * PURPOSE: turn the frozen RS-290 presentation DTO into USER LANGUAGE and the actions a user may
 * take, so that no scheduler vocabulary reaches the default UI.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO, because the workbook forbids each one:
 *   - it does not recompute provider or device selection. Every decision arrives already made in the
 *     DTO; this module only chooses words and marks what is clickable;
 *   - it does not modify the RS-290 contract, and it does not even IMPORT it. `serveWeb` serves only
 *     `apps/web` with containment checking, so a browser module cannot reach `contracts/`. The
 *     vocabulary below is therefore a copy, and `tests/web-scheduler-adapter.test.mjs` asserts it
 *     agrees with the contract EXACTLY in both directions, so it cannot drift silently;
 *   - it does not translate protocol tokens. The i18n pack's own rule is that apiVersion,
 *     schemaVersion, Task.type, Event.type, node ids and the QUEUED/RUNNING/COMPLETED family are
 *     never translated; scheduler terms are a DIFFERENT vocabulary at a different layer and are
 *     translated here, into copy rather than into another token.
 *
 * LEAK RULE, and it is the acceptance item this file exists to satisfy: with `advanced: false` the
 * returned view model contains NO raw scheduler term, class, or state token anywhere, including in
 * nested objects. Raw values are reachable only through the explicit `technical` block, which is
 * absent unless the caller asked for it. A test proves this by serialising the whole view model and
 * searching it for every term the contract declares.
 */

/**
 * Severity for the four classes that carry a refusal or a permission.
 *
 * THE RULE, stated precisely because the first version of this file overstated it: severity is NOT
 * freely chosen per term. For PERMITTED, RESOURCE, STRUCTURAL and KNOWLEDGE it is a FUNCTION of the
 * contract's own class, so a second, contradicting classification cannot appear - structural means
 * waiting will not help, resource means it will, knowledge means we do not know, and the UI's emphasis
 * has to agree with that or it lies to the user about which of those situations they are in.
 *
 * The STATE class is deliberately excluded. `TERM_CLASS` calls those terms 'STATE' precisely because
 * they are neither a permission nor a refusal, so their emphasis is a presentational choice rather
 * than something derivable - which is why `STATE_SEVERITIES` bounds it instead of fixing it.
 */
export const SEVERITY_OF_CLASS = Object.freeze({
  PERMITTED: 'ok',
  RESOURCE: 'waiting',
  STRUCTURAL: 'blocked',
  KNOWLEDGE: 'unknown',
});

/**
 * The severities a STATE-class term may carry. Bounded rather than free: never 'blocked', because a
 * settled state is not a refusal, and never 'ok', because a STATE-class term is not a permission.
 */
export const STATE_SEVERITIES = Object.freeze(['neutral', 'waiting', 'attention']);

/**
 * One user-facing entry per presentation term: an i18n key and the advisory severity.
 * Keys are the contract's terms lowercased so the correspondence is mechanical and greppable.
 * A term with no entry here fails the agreement test rather than rendering blank.
 */
export const TERM_COPY = Object.freeze({
  // permitted
  SELECTABLE: {key: 'scheduler.term.selectable', severity: 'ok'},
  DEVICE_ONLINE: {key: 'scheduler.term.device_online', severity: 'ok'},
  REMOTE_ONLINE: {key: 'scheduler.term.remote_online', severity: 'ok'},
  // structural: waiting will not help, someone must act
  USER_DISABLED: {key: 'scheduler.term.user_disabled', severity: 'blocked'},
  ABSENT: {key: 'scheduler.term.absent', severity: 'blocked'},
  REMOVED: {key: 'scheduler.term.removed', severity: 'blocked'},
  REGION_UNSUPPORTED: {key: 'scheduler.term.region_unsupported', severity: 'blocked'},
  DEVICE_UNREACHABLE: {key: 'scheduler.term.device_unreachable', severity: 'blocked'},
  DEVICE_REFUSING: {key: 'scheduler.term.device_refusing', severity: 'blocked'},
  DEVICE_DISABLED: {key: 'scheduler.term.device_disabled', severity: 'blocked'},
  POLICY_EXCLUDED: {key: 'scheduler.term.policy_excluded', severity: 'blocked'},
  // resource: resolves on its own, so waiting is meaningful and the copy stays calm
  CREDENTIALS_MISSING: {key: 'scheduler.term.credentials_missing', severity: 'waiting'},
  SESSION_ENDED: {key: 'scheduler.term.session_ended', severity: 'waiting'},
  SERVICE_FAULT: {key: 'scheduler.term.service_fault', severity: 'waiting'},
  AT_CAPACITY: {key: 'scheduler.term.at_capacity', severity: 'waiting'},
  SESSION_CONGESTED: {key: 'scheduler.term.session_congested', severity: 'waiting'},
  PRESSURE_PAUSED: {key: 'scheduler.term.pressure_paused', severity: 'waiting'},
  LOAD_UNMEASURED: {key: 'scheduler.term.load_unmeasured', severity: 'waiting'},
  // knowledge: "we do not know", which is never phrased as a failure and never as reassurance
  AVAILABILITY_UNKNOWN: {key: 'scheduler.term.availability_unknown', severity: 'unknown'},
  CHANNEL_READINESS_UNKNOWN: {key: 'scheduler.term.channel_readiness_unknown', severity: 'unknown'},
  FRESHNESS_UNKNOWN: {key: 'scheduler.term.freshness_unknown', severity: 'unknown'},
  FRESHNESS_STALE: {key: 'scheduler.term.freshness_stale', severity: 'unknown'},
  REMOTE_STATE_UNKNOWN: {key: 'scheduler.term.remote_state_unknown', severity: 'unknown'},
  // settled states
  DEGRADED: {key: 'scheduler.term.degraded', severity: 'attention'},
  QUEUED: {key: 'scheduler.term.queued', severity: 'waiting'},
  WAITING_USER: {key: 'scheduler.term.waiting_user', severity: 'neutral'},
  REMOTE_HANDOFF: {key: 'scheduler.term.remote_handoff', severity: 'neutral'},
});

/** One headline per presentation state. */
export const STATE_COPY = Object.freeze({
  QUEUED: {key: 'scheduler.state.queued', severity: 'waiting'},
  RUNNING: {key: 'scheduler.state.running', severity: 'ok'},
  REMOTE_HANDOFF: {key: 'scheduler.state.remote_handoff', severity: 'neutral'},
  WAITING_USER: {key: 'scheduler.state.waiting_user', severity: 'attention'},
  DEGRADED: {key: 'scheduler.state.degraded', severity: 'attention'},
  COMPLETED: {key: 'scheduler.state.completed', severity: 'ok'},
  FAILED: {key: 'scheduler.state.failed', severity: 'blocked'},
  CANCELLED: {key: 'scheduler.state.cancelled', severity: 'neutral'},
});

/** Action tokens are kept verbatim so the caller can wire them; only the LABEL is translated. */
export const ACTION_COPY = Object.freeze({
  CANCEL: {key: 'scheduler.action.cancel', primary: false},
  RETRY: {key: 'scheduler.action.retry', primary: true},
  KEEP_WAITING: {key: 'scheduler.action.keep_waiting', primary: true},
  CHOOSE_PROVIDER: {key: 'scheduler.action.choose_provider', primary: true},
  CONFIRM: {key: 'scheduler.action.confirm', primary: true},
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Build the user-facing view model.
 *
 * @param dto       the frozen contract's `projectStatus` output. Nothing else is accepted; a raw
 *                  component word cannot be passed because the contract already refused those.
 * @param options.t translator, defaults to the i18n runtime's `t`. Injected for tests.
 * @param options.advanced when false (the default) the technical block is ABSENT rather than empty,
 *                  so "no raw field leaks by default" is a structural property and not a convention.
 */
export function toSchedulerViewModel(dto, {t, advanced = false, locale} = {}) {
  if (!isPlainObject(dto)) throw new Error('toSchedulerViewModel expects the contract DTO object');
  if (typeof t !== 'function') throw new Error('toSchedulerViewModel requires a translator: pass {t}');

  const state = STATE_COPY[dto.state];
  if (!state) throw new Error(`unknown presentation state ${String(dto.state)}; the adapter table has drifted from the contract`);

  const providerEntries = Array.isArray(dto.providers) ? dto.providers : [];
  const providers = providerEntries.map((entry, index) => {
    const copy = TERM_COPY[entry.term];
    if (!copy) throw new Error(`unknown presentation term ${String(entry.term)}; the adapter table has drifted from the contract`);
    // A provider is selectable ONLY when the contract says so AND the term is permitted. The second
    // half is the acceptance item "unavailable providers are visible but not selectable" made
    // structural: a UI cannot mark an unavailable provider clickable even if it ignores `selectable`.
    const selectable = entry.selectable === true && copy.severity === 'ok';
    return Object.freeze({
      index,
      label: t(copy.key),
      reason: t(copy.key),
      severity: copy.severity,
      selectable,
      /** The only field a renderer may use to decide interactivity. */
      interactive: selectable,
    });
  });

  const actions = (Array.isArray(dto.actions) ? dto.actions : []).map((token) => {
    const copy = ACTION_COPY[token];
    if (!copy) throw new Error(`unknown action ${String(token)}; the adapter table has drifted from the contract`);
    return Object.freeze({token, label: t(copy.key), primary: copy.primary});
  });

  const view = {
    headline: t(state.key),
    stateLabel: t(state.key),
    severity: state.severity,
    providers: Object.freeze(providers),
    actions: Object.freeze(actions),
    choiceRequired: dto.provider_choice_required === true,
    degraded: dto.degraded === true,
    structuralRefusal: dto.structural_refusal === true,
    /** True only when every provider is unselectable and the user is not being asked to decide. */
    waitingOnResources: providers.length > 0 && !providers.some((p) => p.selectable) && dto.provider_choice_required !== true,
  };

  if (advanced) {
    // The ONLY route to raw vocabulary. Present only on request, so the default view is clean by
    // construction rather than by remembering to filter.
    view.technical = Object.freeze({
      state: dto.state,
      terms: Object.freeze((Array.isArray(dto.terms) ? dto.terms : []).slice()),
      providerTerms: Object.freeze(providerEntries.map((p) => p.term)),
      providerClasses: Object.freeze(providerEntries.map((p) => p.class ?? null)),
      providerChoiceRequired: dto.provider_choice_required === true,
      providerChoiceTaken: dto.provider_choice_taken === true,
      fromBackendTruth: dto.from_backend_truth === true,
      fabricated: dto.fabricated === true,
      presentationVersion: dto.presentation_version ?? null,
    });
  }

  return Object.freeze(view);
}

export default {TERM_COPY, STATE_COPY, ACTION_COPY, toSchedulerViewModel};
