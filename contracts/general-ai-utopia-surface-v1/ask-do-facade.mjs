// Utopia Ask/Do + Action + Web/Android integration (GAI-009).
//
// General AI appears inside the existing Utopia product model rather than as a parallel AI application shell.
// The facade adds one Action kind (`GENERAL_AI`) beside the deterministic-local and engineering kinds, and the
// routing order is fixed:
//
//   deterministic/local  →  (unmatched, AI-intended)  →  GAI routing  →  admission (consent + budget)
//
// Ask/Do therefore behaves exactly as before for known commands — proven byte-for-byte by the suite — while an
// ordinary AI request becomes a GENERAL_AI Action. Provider, channel and device are *provenance* shown in the
// advanced view, never a choice the user is forced to make up front.
//
// The current interaction device stays the UI endpoint: a device-switch proposal or an API proposal is rendered
// for confirmation and never navigates the user away, remote results and partial output land on the
// originating shared Action, and attention is projected into canonical shared Attention state rather than a
// GAI-only database. Cancel/control works from both Web and Android for the same Action where authorized, and
// the same canonical Action/history truth is shared — this is a facade, not a second truth store.
//
// No UI path claims success while the backend is unavailable, attention-required or failed.
//
// Pure module: routers, channels, the shared attention port and the clock are injected; no network or ambient state.
export const GAI_SURFACE_CONTRACT_VERSION = 1;

export const ACTION_KINDS = Object.freeze(['DETERMINISTIC_LOCAL', 'GENERAL_AI', 'ENGINEERING']);
export const ROUTES = Object.freeze(['DETERMINISTIC_LOCAL', 'GENERAL_AI', 'ENGINEERING', 'MANUAL_PICKER', 'CONFIRMATION_REQUIRED']);
export const GAI_ACTION_STATES = Object.freeze(['ACCEPTED', 'RUNNING', 'WAITING_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED', 'UNAVAILABLE', 'UNKNOWN']);
export const TERMINAL_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED']);
export const PROVENANCE_FIELDS = Object.freeze(['provider_ref', 'model_ref', 'channel_ref', 'device_ref', 'backend_run_ref', 'protocol_ref', 'error_ref']);
export const SURFACE_SECTIONS = Object.freeze(['ASK_DO', 'ACTION_VIEW', 'PROGRESS', 'ATTENTION', 'CONTROL', 'RESULT', 'ADVANCED']);
export const LEGACY_ROUTES = Object.freeze(['BOSS', 'HNS', 'CODEX_BOSS']);
export const SHARED_ATTENTION_SOURCE = 'SHARED_CORE_ATTENTION';
export const SECRET_KEY_SHAPE = /(secret|token|password|api_?key|private_?key|session_key|credential_value|^value$)/i;

export const GAI_SURFACE_CODES = Object.freeze([
  'INVALID_REQUEST', 'INVALID_CLOCK', 'UNKNOWN_ACTION', 'DETERMINISTIC_MUST_STAY_LOCAL',
  'CONFIRMATION_REQUIRED', 'BUDGET_MUST_PRECEDE_EXECUTION', 'ATTENTION_FROM_SHARED_STATE_ONLY',
  'LEGACY_ROUTE_NOT_EXPOSED', 'FALSE_SUCCESS_REFUSED', 'NOT_AUTHORIZED_TO_CONTROL',
  'ACTION_TRUTH_IS_SHARED', 'SECRET_MATERIAL_REFUSED', 'BACKEND_NOT_READY',
]);

const CONFLICT_CODES = new Set(['CONFIRMATION_REQUIRED', 'BUDGET_MUST_PRECEDE_EXECUTION', 'FALSE_SUCCESS_REFUSED', 'LEGACY_ROUTE_NOT_EXPOSED', 'BACKEND_NOT_READY', 'NOT_AUTHORIZED_TO_CONTROL']);

export class GaiSurfaceError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'GaiSurfaceError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_ACTION' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
    Object.assign(this, extra);
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
const freeze = value => {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

export function findSecretFields(value, path = 'record', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSecretFields(item, `${path}[${index}]`, found));
    return found;
  }
  if (typeof value === 'boolean' || value === null) return found;
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const keyIsSecret = SECRET_KEY_SHAPE.test(key) && !/_ref$/.test(key) && typeof child !== 'boolean';
    if (keyIsSecret) {
      if (!found.includes(childPath)) found.push(childPath);
      continue;
    }
    findSecretFields(child, childPath, found);
  }
  return found;
}

export const DEFAULT_GAI_SURFACE_POLICY = Object.freeze({
  policy_ref: 'policy:gai-surface-default',
  deterministic_first: true,
  web_first: true,
  attention_sources: Object.freeze([SHARED_ATTENTION_SOURCE]),
});

/**
 * @param deterministicMatcher  the existing local router (unchanged behaviour)
 * @param routePort             the GAI triage port (GAI-005 shape): route({ text }) → { chosen }
 * @param admissionPort         the consent/budget gate (GAI-004 shape)
 * @param executionPort         the channel execution port (GAI-004/GAI-007 shape)
 * @param sharedAttention       the canonical shared Attention port: project(...) / acknowledge(...)
 */
export function createAskDoFacade({
  deterministicMatcher = () => null,
  routePort = null,
  admissionPort = null,
  executionPort = null,
  sharedAttention = null,
  clock = () => new Date().toISOString(),
  policy = {},
} = {}) {
  if (typeof deterministicMatcher !== 'function') throw new GaiSurfaceError('INVALID_REQUEST', 'deterministicMatcher must be a function');
  if (typeof clock !== 'function') throw new GaiSurfaceError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  const config = { ...DEFAULT_GAI_SURFACE_POLICY, ...(isPlainObject(policy) ? policy : {}) };
  const actions = new Map();
  const history = [];
  const journal = [];
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isIsoInstant(produced)) throw new GaiSurfaceError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
    return produced;
  };

  const note = (event, at, detail = {}) => {
    journal.push(freeze({ event, at, ...detail }));
    return journal.length - 1;
  };

  const requireAction = action_ref => {
    const action = actions.get(action_ref);
    if (!action) throw new GaiSurfaceError('UNKNOWN_ACTION', `no action ${String(action_ref)}`);
    return action;
  };

  const projectAction = action => freeze({
    contract_version: GAI_SURFACE_CONTRACT_VERSION,
    action_ref: action.action_ref,
    action_kind: action.action_kind,
    canonical_history_ref: action.canonical_history_ref,
    interaction_device_ref: action.interaction_device_ref,
    execution_device_ref: action.execution_device_ref,
    device_switch_required: action.execution_device_ref !== action.interaction_device_ref,
    state: action.state,
    terminal: TERMINAL_STATES.includes(action.state),
    partial_refs: clone(action.partial_refs),
    result: action.result === null ? null : clone(action.result),
    attention_refs: clone(action.attention_refs),
    proposals: freeze({ device_switch: action.device_switch_proposal === null ? null : clone(action.device_switch_proposal), api_switch: action.api_switch_proposal === null ? null : clone(action.api_switch_proposal) }),
    budget_verdict: action.budget_verdict === null ? null : clone(action.budget_verdict),
    provenance: clone(action.provenance),
    cancelled: action.cancellation !== null,
    user_navigated_away: false,
    action_truth_is_shared: true,
    per_device_copy: false,
    at: action.updated_at,
  });

  const api = {
    policy: () => freeze(clone(config)),
    sections: () => freeze([...SURFACE_SECTIONS]),

    /**
     * Ask/Do. Deterministic local routing happens first and is unchanged; only an unmatched AI-intended
     * request enters GAI routing.
     */
    ask({ text, interaction_device_ref, request_ref = null, at: when } = {}) {
      if (!isText(text)) throw new GaiSurfaceError('INVALID_REQUEST', 'text is required');
      if (!isText(interaction_device_ref)) throw new GaiSurfaceError('INVALID_REQUEST', 'interaction_device_ref is required');
      const at = when ?? now();
      const deterministic = deterministicMatcher(text);
      if (deterministic !== null && deterministic !== undefined) {
        note('DETERMINISTIC_ROUTED', at, { request_ref });
        return freeze({
          contract_version: GAI_SURFACE_CONTRACT_VERSION,
          request_ref,
          route: 'DETERMINISTIC_LOCAL',
          action_kind: 'DETERMINISTIC_LOCAL',
          action_ref: null,
          deterministic_result: clone(deterministic),
          deterministic_unchanged: true,
          routed_through_gai: false,
          general_ai_action_created: false,
          provider_choice_requested_from_user: false,
          at,
        });
      }
      if (routePort === null || typeof routePort.route !== 'function') {
        throw new GaiSurfaceError('BACKEND_NOT_READY', 'no GAI routing port is configured', { routed_to_api: false });
      }
      const routed = routePort.route({ text, context: { interaction_device_ref } });
      const chosen = routed?.chosen?.route ?? 'MANUAL_PICKER';
      if (chosen === 'ENGINEERING') {
        note('ENGINEERING_ROUTED', at, { request_ref });
        return freeze({
          contract_version: GAI_SURFACE_CONTRACT_VERSION,
          request_ref,
          route: 'ENGINEERING',
          action_kind: 'ENGINEERING',
          action_ref: null,
          general_ai_action_created: false,
          engineering_handoff: clone(routed.engineering ?? null),
          provider_choice_requested_from_user: false,
          at,
        });
      }
      if (chosen !== 'GENERAL_AI') {
        note('GAI_NOT_ROUTED', at, { request_ref, chosen });
        return freeze({
          contract_version: GAI_SURFACE_CONTRACT_VERSION,
          request_ref,
          route: chosen,
          action_kind: null,
          action_ref: null,
          general_ai_action_created: false,
          recommendation: clone(routed?.recommendation ?? null),
          provider_choice_requested_from_user: false,
          at,
        });
      }
      counter += 1;
      const action = {
        action_ref: `action:gai:${counter}`,
        action_kind: 'GENERAL_AI',
        canonical_history_ref: `history:gai:${counter}`,
        interaction_device_ref,
        execution_device_ref: interaction_device_ref,
        state: 'ACCEPTED',
        partial_refs: [],
        result: null,
        attention_refs: [],
        device_switch_proposal: null,
        api_switch_proposal: null,
        budget_verdict: null,
        provenance: freeze({ channel_ref: 'WEB', provider_ref: null, model_ref: null, device_ref: interaction_device_ref, backend_run_ref: null, protocol_ref: null, error_ref: null }),
        cancellation: null,
        authorized_devices: freeze([interaction_device_ref]),
        consent_ref: null,
        created_at: at,
        updated_at: at,
      };
      actions.set(action.action_ref, action);
      history.push(freeze({ history_ref: action.canonical_history_ref, action_ref: action.action_ref, event: 'ASK_ACCEPTED', at }));
      note('GENERAL_AI_ACTION_CREATED', at, { action_ref: action.action_ref });
      return freeze({
        contract_version: GAI_SURFACE_CONTRACT_VERSION,
        request_ref,
        route: 'GENERAL_AI',
        action_kind: 'GENERAL_AI',
        action_ref: action.action_ref,
        canonical_history_ref: action.canonical_history_ref,
        general_ai_action_created: true,
        web_first_default_path: true,
        interaction_device_ref,
        execution_device_ref: interaction_device_ref,
        provider_choice_requested_from_user: false,
        provenance_available_in_advanced_view: true,
        recommendation: clone(routed?.recommendation ?? null),
        at,
      });
    },

    /** The Action view a Web or Android client renders; both read the same action. */
    render({ action_ref, at: when } = {}) {
      const action = requireAction(action_ref);
      const at = when ?? now();
      const backendUnavailable = action.state === 'UNAVAILABLE' || action.state === 'UNKNOWN' || action.state === 'WAITING_CONFIRMATION';
      return freeze({
        ...projectAction(action),
        surface_section: 'ACTION_VIEW',
        sections: freeze([...SURFACE_SECTIONS]),
        shows_success: action.state === 'SUCCEEDED',
        success_claimed_while_not_succeeded: false,
        backend_unavailable: backendUnavailable,
        attention_required: action.attention_refs.length > 0,
        at,
      });
    },

    /** Partial output is never a terminal success. */
    addPartial({ action_ref, partial_ref, text = null, at: when } = {}) {
      const action = requireAction(action_ref);
      if (TERMINAL_STATES.includes(action.state)) throw new GaiSurfaceError('FALSE_SUCCESS_REFUSED', `action ${action_ref} is ${action.state}`, { action_ref, state: action.state });
      if (!isText(partial_ref)) throw new GaiSurfaceError('INVALID_REQUEST', 'partial_ref is required');
      const at = when ?? now();
      action.partial_refs.push(freeze({ partial_ref, text, terminal: false, partial_is_not_success: true, at }));
      if (action.state === 'ACCEPTED') action.state = 'RUNNING';
      action.updated_at = at;
      note('PARTIAL_RENDERED', at, { action_ref });
      return freeze({ action_ref, partial_ref, state: action.state, terminal: false, partial_is_not_success: true, rendered_on: action.interaction_device_ref, at });
    },

    /** A device-switch proposal is rendered for confirmation; the user is not navigated away. */
    proposeDeviceSwitch({ action_ref, remote_device_ref, reason = 'LOCAL_WEB_THROTTLED', at: when } = {}) {
      const action = requireAction(action_ref);
      if (!isText(remote_device_ref)) throw new GaiSurfaceError('INVALID_REQUEST', 'remote_device_ref is required');
      const at = when ?? now();
      action.device_switch_proposal = freeze({
        contract_version: GAI_SURFACE_CONTRACT_VERSION,
        proposal_ref: `${action_ref}:device-switch`,
        action_ref,
        remote_device_ref,
        reason,
        requires_explicit_confirmation: true,
        confirmed: false,
        auto_selected: false,
        interaction_device_ref: action.interaction_device_ref,
        user_navigated_away: false,
        at,
      });
      action.state = 'WAITING_CONFIRMATION';
      action.updated_at = at;
      note('DEVICE_SWITCH_PROPOSED', at, { action_ref });
      return freeze({ ...clone(action.device_switch_proposal), action_truth_is_shared: true });
    },

    confirmDeviceSwitch({ action_ref, confirmed = false, at: when } = {}) {
      const action = requireAction(action_ref);
      const proposal = action.device_switch_proposal;
      if (proposal === null) throw new GaiSurfaceError('INVALID_REQUEST', `no device-switch proposal for ${action_ref}`);
      const at = when ?? now();
      if (confirmed !== true) return freeze({ ...clone(proposal), confirmed: false, applied: false, stays_on_interaction_device: true });
      action.device_switch_proposal = freeze({ ...proposal, confirmed: true, applied: true, confirmed_at: at });
      action.execution_device_ref = proposal.remote_device_ref;
      action.authorized_devices = freeze([...new Set([...action.authorized_devices, proposal.remote_device_ref])]);
      action.state = 'RUNNING';
      action.updated_at = at;
      note('DEVICE_SWITCH_CONFIRMED', at, { action_ref, remote_device_ref: proposal.remote_device_ref });
      return freeze({
        ...clone(action.device_switch_proposal),
        interaction_device_ref: action.interaction_device_ref,
        execution_device_ref: action.execution_device_ref,
        user_navigated_away: false,
        remote_result_returns_to_originating_action: true,
      });
    },

    /**
     * An API proposal requires explicit confirmation and shows the budget verdict before execution.
     */
    proposeApiSwitch({ action_ref, reason = 'WEB_UNAVAILABLE', at: when } = {}) {
      const action = requireAction(action_ref);
      const at = when ?? now();
      if (admissionPort === null) throw new GaiSurfaceError('BACKEND_NOT_READY', 'no admission port is configured', { api_execution_permitted: false });
      const budget = admissionPort.checkBudget?.({ action_ref }) ?? null;
      action.api_switch_proposal = freeze({
        contract_version: GAI_SURFACE_CONTRACT_VERSION,
        proposal_ref: `${action_ref}:api-switch`,
        action_ref,
        reason,
        requires_explicit_confirmation: true,
        confirmed: false,
        budget_verdict: budget === null ? null : clone(budget),
        budget_shown_before_execution: true,
        api_triggered_automatically: false,
        user_navigated_away: false,
        at,
      });
      action.budget_verdict = budget === null ? null : freeze(clone(budget));
      action.state = 'WAITING_CONFIRMATION';
      action.updated_at = at;
      note('API_SWITCH_PROPOSED', at, { action_ref });
      return clone(action.api_switch_proposal);
    },

    /** Execution requires an approved consent record and a budget verdict; otherwise nothing runs. */
    executeApi({ action_ref, consent = null, at: when } = {}) {
      const action = requireAction(action_ref);
      const at = when ?? now();
      if (action.api_switch_proposal === null) throw new GaiSurfaceError('CONFIRMATION_REQUIRED', 'an API proposal is required before API execution', { action_ref, executed: false });
      if (admissionPort === null || typeof admissionPort.admit !== 'function') throw new GaiSurfaceError('BACKEND_NOT_READY', 'no admission port is configured', { executed: false });
      const admission = admissionPort.admit({ action_ref, consent, request: {}, protocol: action.api_switch_proposal.protocol ?? null });
      if (admission.admitted !== true) {
        action.budget_verdict = admission.budget === null ? action.budget_verdict : freeze(clone(admission.budget));
        note('API_EXECUTION_REFUSED', at, { action_ref, verdict: admission.verdict });
        return freeze({
          contract_version: GAI_SURFACE_CONTRACT_VERSION,
          action_ref,
          executed: false,
          admission_verdict: admission.verdict,
          budget_verdict: action.budget_verdict,
          budget_shown_before_execution: true,
          reason: admission.reason ?? admission.verdict,
          api_triggered_automatically: false,
        });
      }
      const execution = executionPort !== null && typeof executionPort.execute === 'function' ? executionPort.execute({ action_ref, consent }) : null;
      action.budget_verdict = freeze(clone(admission.budget));
      action.consent_ref = admission.consent?.consent_id ?? null;
      action.execution_device_ref = action.interaction_device_ref;
      action.state = 'RUNNING';
      action.updated_at = at;
      history.push(freeze({ history_ref: action.canonical_history_ref, action_ref, event: 'API_EXECUTED', at }));
      note('API_EXECUTED', at, { action_ref });
      return freeze({
        contract_version: GAI_SURFACE_CONTRACT_VERSION,
        action_ref,
        executed: true,
        admission_verdict: admission.verdict,
        budget_verdict: action.budget_verdict,
        budget_shown_before_execution: true,
        consent_ref: action.consent_ref,
        channel_ref: 'API',
        execution: execution === null ? null : freeze(clone(execution)),
        interaction_device_ref: action.interaction_device_ref,
        user_navigated_away: false,
        result_returns_to_originating_action: true,
      });
    },

    /** Attention is projected into canonical shared state; a GAI-only store is refused. */
    registerGaiAttentionStore() {
      throw new GaiSurfaceError('ATTENTION_FROM_SHARED_STATE_ONLY', 'GAI projects attention into canonical shared Attention state and creates no GAI-only database', {
        created: false, sources: freeze([...config.attention_sources]),
      });
    },

    projectAttention({ action_ref, attention_ref, question, blocking = true, at: when } = {}) {
      const action = requireAction(action_ref);
      if (!isText(attention_ref) || !isText(question)) throw new GaiSurfaceError('INVALID_REQUEST', 'attention_ref and question are required');
      if (sharedAttention === null || typeof sharedAttention.project !== 'function') throw new GaiSurfaceError('ATTENTION_FROM_SHARED_STATE_ONLY', 'the canonical shared Attention port is required');
      const at = when ?? now();
      const projected = sharedAttention.project({ attention_ref, source: SHARED_ATTENTION_SOURCE, question, blocking, subject_ref: action_ref, delivered_to: action.interaction_device_ref, at });
      action.attention_refs.push(attention_ref);
      action.state = 'WAITING_CONFIRMATION';
      action.updated_at = at;
      note('ATTENTION_PROJECTED', at, { action_ref, attention_ref });
      return freeze({ ...clone(projected), action_ref, from_shared_state: true, gai_only_store: false, delivered_to: action.interaction_device_ref });
    },

    /** Control works from Web and Android for the same action where authorized. */
    control({ action_ref, operation, by_device_ref, at: when } = {}) {
      const action = requireAction(action_ref);
      if (!['CANCEL', 'PAUSE', 'RESUME'].includes(operation)) throw new GaiSurfaceError('INVALID_REQUEST', 'operation must be CANCEL, PAUSE or RESUME');
      if (!action.authorized_devices.includes(by_device_ref)) {
        throw new GaiSurfaceError('NOT_AUTHORIZED_TO_CONTROL', `${String(by_device_ref)} may not control ${action_ref}`, { action_ref, authorized_devices: clone(action.authorized_devices) });
      }
      const at = when ?? now();
      if (TERMINAL_STATES.includes(action.state) && operation !== 'RESUME') throw new GaiSurfaceError('FALSE_SUCCESS_REFUSED', `action ${action_ref} is ${action.state}`, { action_ref, state: action.state });
      if (operation === 'CANCEL') {
        action.cancellation = freeze({ cancellation_ref: `cancellation:${action_ref}`, action_ref, by_device_ref, at });
        action.state = 'CANCELLED';
      }
      if (operation === 'PAUSE') action.state = 'WAITING_CONFIRMATION';
      if (operation === 'RESUME') action.state = 'RUNNING';
      action.updated_at = at;
      history.push(freeze({ history_ref: action.canonical_history_ref, action_ref, event: `CONTROL_${operation}`, at }));
      note('ACTION_CONTROLLED', at, { action_ref, operation, by_device_ref });
      return freeze({
        contract_version: GAI_SURFACE_CONTRACT_VERSION,
        action_ref,
        operation,
        applied: true,
        state: action.state,
        by_device_ref,
        controlled_from_interaction_device: by_device_ref === action.interaction_device_ref,
        controlled_from_other_android_device: by_device_ref !== action.interaction_device_ref,
        canonical_history_ref: action.canonical_history_ref,
        per_device_history_copy: false,
        at,
      });
    },

    /** Only a terminal accepted result is success; unavailable/attention/failed states never are. */
    applyResult({ action_ref, state, result_ref = null, error = null, at: when } = {}) {
      const action = requireAction(action_ref);
      if (!GAI_ACTION_STATES.includes(state)) throw new GaiSurfaceError('INVALID_REQUEST', `state must be one of ${GAI_ACTION_STATES.join(', ')}`);
      if (!TERMINAL_STATES.includes(state)) {
        throw new GaiSurfaceError('FALSE_SUCCESS_REFUSED', 'a rendered result must be terminal', { action_ref, requested_state: state, terminal: false, dispatch_is_not_success: true });
      }
      if (state === 'SUCCEEDED' && !isText(result_ref)) throw new GaiSurfaceError('FALSE_SUCCESS_REFUSED', 'a success needs an accepted result reference', { action_ref, result_ref: null });
      if (state === 'SUCCEEDED' && (action.state === 'UNAVAILABLE' || action.state === 'WAITING_CONFIRMATION')) {
        throw new GaiSurfaceError('FALSE_SUCCESS_REFUSED', `action ${action_ref} cannot succeed while the backend is ${action.state}`, { action_ref, state: action.state, backend_unavailable: true });
      }
      const at = when ?? now();
      action.state = state;
      action.result = freeze({
        contract_version: GAI_SURFACE_CONTRACT_VERSION,
        result_ref,
        terminal_state: state,
        accepted: true,
        success: state === 'SUCCEEDED',
        error: error === null ? null : freeze(clone(error)),
        returned_to_interaction_device: action.interaction_device_ref,
        at,
      });
      action.updated_at = at;
      history.push(freeze({ history_ref: action.canonical_history_ref, action_ref, event: `RESULT_${state}`, at }));
      note('ACTION_RESULT', at, { action_ref, state });
      return freeze({
        ...projectAction(action),
        surface_section: 'RESULT',
        user_visible_success: state === 'SUCCEEDED',
        success_source: state === 'SUCCEEDED' ? 'TERMINAL_ACCEPTED_RESULT' : null,
        dispatch_is_not_success: true,
        partial_is_not_success: true,
        at,
      });
    },

    /** Advanced/debug view: real provider/channel/device/backend identifiers, no secrets. */
    advanced({ action_ref, provenance = null, at: when } = {}) {
      const action = requireAction(action_ref);
      const at = when ?? now();
      if (provenance !== null) {
        const secrets = findSecretFields(provenance);
        if (secrets.length > 0) throw new GaiSurfaceError('SECRET_MATERIAL_REFUSED', `provenance carries secret-shaped material at ${secrets.join(', ')}`, { fields: freeze(secrets), stored: false });
        const unknown = Object.keys(provenance).filter(key => !PROVENANCE_FIELDS.includes(key));
        if (unknown.length > 0) throw new GaiSurfaceError('INVALID_REQUEST', `${unknown.join(', ')} is not a canonical provenance field`, { allowed: freeze([...PROVENANCE_FIELDS]) });
        action.provenance = freeze({ ...clone(action.provenance), ...clone(provenance) });
      }
      return freeze({
        contract_version: GAI_SURFACE_CONTRACT_VERSION,
        action_ref,
        action_kind: action.action_kind,
        provenance: clone(action.provenance),
        advanced_view: true,
        provider_and_channel_visible: true,
        real_identifiers_preserved: true,
        contains_secret_material: false,
        references_only: true,
        provider_choice_required_up_front: false,
        at,
      });
    },

    /** Boss/Hns routes are not part of the product surface. */
    exposeLegacyRoute({ route } = {}) {
      throw new GaiSurfaceError('LEGACY_ROUTE_NOT_EXPOSED', `${String(route)} is not a Utopia semantic route; use GENERAL_AI or ENGINEERING`, {
        route: route ?? null, exposed: false, semantic_routes: freeze(['GENERAL_AI', 'ENGINEERING']),
      });
    },

    /** One canonical Action/history truth shared by Web, Android and Rooms. */
    history({ action_ref = null, at: when } = {}) {
      const at = when ?? now();
      const scoped = action_ref === null ? history : history.filter(entry => entry.action_ref === action_ref);
      return freeze({
        contract_version: GAI_SURFACE_CONTRACT_VERSION,
        entries: freeze(scoped.map(entry => clone(entry))),
        canonical_action_truth_shared: true,
        per_device_history_copy: false,
        second_history_store: false,
        at,
      });
    },

    surfaceContract() {
      return freeze({
        contract_version: GAI_SURFACE_CONTRACT_VERSION,
        action_kinds: freeze([...ACTION_KINDS]),
        sections: freeze([...SURFACE_SECTIONS]),
        deterministic_first: config.deterministic_first === true,
        web_first_default_path: config.web_first === true,
        provider_choice_required_up_front: false,
        device_switch_requires_confirmation: true,
        api_switch_requires_explicit_confirmation: true,
        budget_shown_before_execution: true,
        api_triggered_automatically: false,
        user_navigated_away_on_remote: false,
        remote_result_on_originating_action: true,
        attention_from_shared_state: true,
        gai_only_attention_store: false,
        shared_action_history: true,
        tasks_services_rooms_truths_separate: true,
        legacy_routes_exposed: false,
        success_source: 'TERMINAL_ACCEPTED_RESULT',
        partial_is_not_success: true,
        dispatch_is_not_success: true,
      });
    },

    action: action_ref => {
      const action = actions.get(action_ref);
      return action ? projectAction(action) : null;
    },
    actions: () => clone([...actions.values()]).map(action => projectAction(action)),
    journal: () => clone(journal),
  };
  return Object.freeze(api);
}
