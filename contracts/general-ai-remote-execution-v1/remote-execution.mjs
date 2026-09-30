// Device-aware remote execution + result return (GAI-007).
//
// The core invariant, enforced as data on every result:
//
//   REMOTE DEVICE = EXECUTION RESOURCE, NOT A REQUIRED USER TERMINAL
//   interaction_device_ref may differ from execution_device_ref, and switching the execution host must not
//   require the user to walk to or operate that host — so the interaction device is never changed here and
//   every result says so.
//
// Remote Fabric is consumed through one injected `RemoteExecutionPort` facade; this module implements no
// trust, transport, presence or device identity of its own. Ranking reads endpoint metadata only: it never
// launches an AI request as a probe, and it refuses to treat a stale or offline endpoint as healthy.
//
// V1 requires an explicit user confirmation (DeviceSwitchProposal) before any dispatch to another device.
// Exactly one canonical action id is dispatched, so the execution host never grows a duplicate Action, and
// status/progress/partial/final/error all correlate to that same id. Cancellation is allowed from any
// authorized device viewing the Action, is idempotent, and late or duplicate events after a terminal state
// are reconciled rather than applied.
//
// Hardware-bound authentication is a first-class outcome: it returns ATTENTION_REQUIRED to the interaction
// device instead of a false success, and normal mode carries semantic RPC/event/stream data rather than
// mandatory remote-desktop video.
//
// Pure module: the execution port and the clock are injected; no network, storage or ambient state.
export const REMOTE_EXECUTION_CONTRACT_VERSION = 1;

export const EXECUTION_ROUTES = Object.freeze(['LOCAL_WEB', 'REMOTE_DEVICE']);
export const PRESENCE_STATES = Object.freeze(['ONLINE', 'DEGRADED', 'OFFLINE', 'UNKNOWN']);
export const ACTION_STATES = Object.freeze(['DISPATCHED', 'RUNNING', 'AWAITING_USER', 'CANCELLED', 'SUCCEEDED', 'FAILED']);
export const TERMINAL_ACTION_STATES = Object.freeze(['CANCELLED', 'SUCCEEDED', 'FAILED']);
export const EVENT_KINDS = Object.freeze(['STATUS', 'PROGRESS', 'PARTIAL', 'ERROR', 'FINAL', 'CANCELLED']);
export const EXCLUSION_REASONS = Object.freeze(['OFFLINE', 'STALE_ENDPOINT', 'NOT_WEB_READY', 'OVERLOADED', 'NO_SESSION', 'INPUT_NOT_LOCAL', 'UNKNOWN_PRESENCE']);
export const STAGING_POLICIES = Object.freeze(['NO_STAGING', 'DELETE_AFTER_USE', 'RETAIN']);

export const REMOTE_EXECUTION_PORT = Object.freeze({
  interface: 'RemoteExecutionPort',
  version: 1,
  methods: Object.freeze(['listEndpoints', 'dispatch', 'cancel']),
  facade_over: 'REMOTE_FABRIC_PUBLIC_API',
  implements_trust_or_transport: false,
  implements_presence_or_identity: false,
});

export const REMOTE_EXECUTION_CODES = Object.freeze([
  'INVALID_REQUEST', 'INVALID_PORT', 'INVALID_CLOCK', 'INVALID_PROPOSAL', 'UNKNOWN_PROPOSAL',
  'UNKNOWN_ACTION', 'NO_HEALTHY_ENDPOINT', 'CONFIRMATION_REQUIRED', 'PROPOSAL_NOT_CONFIRMED',
  'ENDPOINT_NOT_APPROVED', 'DUPLICATE_DISPATCH', 'STAGING_POLICY_REQUIRED', 'EVENT_OUT_OF_ORDER',
  'LATE_EVENT_AFTER_TERMINAL', 'NOT_AUTHORIZED_TO_CANCEL', 'ATTENTION_REQUIRED', 'UNKNOWN_ENDPOINT',
]);

const CONFLICT_CODES = new Set(['CONFIRMATION_REQUIRED', 'PROPOSAL_NOT_CONFIRMED', 'DUPLICATE_DISPATCH', 'LATE_EVENT_AFTER_TERMINAL', 'NO_HEALTHY_ENDPOINT', 'ATTENTION_REQUIRED']);

export class RemoteExecutionError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RemoteExecutionError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_ACTION' || code === 'UNKNOWN_PROPOSAL' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
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

export const DEFAULT_REMOTE_POLICY = Object.freeze({
  policy_ref: 'policy:gai-remote-default',
  v1_confirmation_required: true,
  max_freshness_ms: 30000,
  max_load: 0.9,
  weights: Object.freeze({ presence: 3, web_ready: 3, session_available: 2, input_locality: 2, load: 2, freshness: 1 }),
  cancel_authorized_states: Object.freeze(['DISPATCHED', 'RUNNING', 'AWAITING_USER']),
});

export function createRemoteExecutionRouter({ executionPort, clock = () => new Date().toISOString(), policy = {} } = {}) {
  if (!isPlainObject(executionPort) || typeof executionPort.listEndpoints !== 'function' || typeof executionPort.dispatch !== 'function') {
    throw new RemoteExecutionError('INVALID_PORT', 'the RemoteExecutionPort facade is required (listEndpoints and dispatch)');
  }
  if (typeof clock !== 'function') throw new RemoteExecutionError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  const config = { ...DEFAULT_REMOTE_POLICY, ...(isPlainObject(policy) ? policy : {}), weights: { ...DEFAULT_REMOTE_POLICY.weights, ...(isPlainObject(policy?.weights) ? policy.weights : {}) } };
  const proposals = new Map();
  const actions = new Map();
  const portCalls = { listEndpoints: 0, dispatch: 0, cancel: 0 };
  const journal = [];
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isIsoInstant(produced)) throw new RemoteExecutionError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
    return produced;
  };

  const note = (event, at, detail = {}) => {
    journal.push(freeze({ event, at, ...detail }));
    return journal.length - 1;
  };

  const listEndpoints = () => {
    portCalls.listEndpoints += 1;
    const endpoints = executionPort.listEndpoints();
    if (!Array.isArray(endpoints)) throw new RemoteExecutionError('INVALID_PORT', 'the port must return an array of endpoints');
    return endpoints;
  };

  /** Ranking reads metadata only: no dispatch, no probe request, no AI call. */
  const scoreEndpoint = (endpoint, requirements, at) => {
    const reasons = [];
    const presence = PRESENCE_STATES.includes(endpoint.presence) ? endpoint.presence : 'UNKNOWN';
    if (presence === 'OFFLINE') reasons.push('OFFLINE');
    if (presence === 'UNKNOWN') reasons.push('UNKNOWN_PRESENCE');
    const freshness = Number.isFinite(endpoint.freshness_ms) ? endpoint.freshness_ms : null;
    if (freshness === null || freshness > config.max_freshness_ms) reasons.push('STALE_ENDPOINT');
    if (presence !== 'OFFLINE' && endpoint.web_ready !== true) reasons.push('NOT_WEB_READY');
    if (presence !== 'OFFLINE' && endpoint.load !== undefined && (!Number.isFinite(endpoint.load) || endpoint.load > config.max_load)) reasons.push('OVERLOADED');
    if (requirements.requires_session === true && endpoint.session_available !== true) reasons.push('NO_SESSION');
    if (requirements.requires_local_input === true && endpoint.input_locality_ok !== true) reasons.push('INPUT_NOT_LOCAL');
    const values = {
      presence: presence === 'ONLINE' ? 1 : presence === 'DEGRADED' ? 0.5 : 0,
      web_ready: endpoint.web_ready === true ? 1 : 0,
      session_available: endpoint.session_available === true ? 1 : 0,
      input_locality: endpoint.input_locality_ok === true ? 1 : 0,
      load: Number.isFinite(endpoint.load) ? Math.max(0, 1 - endpoint.load) : 0.5,
      freshness: freshness === null ? 0 : Math.max(0, 1 - freshness / config.max_freshness_ms),
    };
    const breakdown = {};
    let score = 0;
    for (const [factor, value] of Object.entries(values)) {
      breakdown[factor] = freeze({ value, weight: config.weights[factor] ?? 0, contribution: (config.weights[factor] ?? 0) * value });
      score += (config.weights[factor] ?? 0) * value;
    }
    return freeze({
      endpoint_ref: endpoint.endpoint_ref,
      device_ref: endpoint.device_ref,
      provider_ready: endpoint.provider_ready !== false,
      presence,
      load: Number.isFinite(endpoint.load) ? endpoint.load : null,
      freshness_ms: freshness,
      eligible: reasons.length === 0 && endpoint.provider_ready !== false,
      exclusion_reasons: freeze([...reasons, ...(endpoint.provider_ready === false ? ['NOT_WEB_READY'] : [])]),
      score: Math.round(score * 1000) / 1000,
      score_breakdown: freeze(breakdown),
    });
  };

  const api = {
    policy: () => freeze(clone(config)),
    executionPort: () => REMOTE_EXECUTION_PORT,
    portCalls: () => freeze(clone(portCalls)),

    /**
     * Rank endpoints and, when the work must move, produce a DeviceSwitchProposal. Metadata only: this
     * never dispatches, so discovery cannot create duplicate AI requests.
     */
    proposeDeviceSwitch({ action_ref, interaction_device_ref, requirements = {}, at: when } = {}) {
      if (!isText(action_ref)) throw new RemoteExecutionError('INVALID_REQUEST', 'action_ref is required');
      if (!isText(interaction_device_ref)) throw new RemoteExecutionError('INVALID_REQUEST', 'interaction_device_ref is required');
      const at = when ?? now();
      const endpoints = listEndpoints();
      const ranked = endpoints
        .filter(endpoint => isPlainObject(endpoint) && isText(endpoint.endpoint_ref) && isText(endpoint.device_ref))
        .map(endpoint => scoreEndpoint(endpoint, requirements, at))
        .sort((left, right) => {
          if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
          if (right.score !== left.score) return right.score - left.score;
          return left.device_ref < right.device_ref ? -1 : left.device_ref > right.device_ref ? 1 : 0;
        });
      const local = ranked.find(entry => entry.device_ref === interaction_device_ref) ?? null;
      const localHealthy = local !== null && local.eligible === true;

      // Prefer the current device's Web when it is healthy: no proposal, no user interruption.
      if (localHealthy) {
        counter += 1;
        const proposal = freeze({
          contract_version: REMOTE_EXECUTION_CONTRACT_VERSION,
          proposal_ref: `proposal:${counter}`,
          action_ref,
          route: 'LOCAL_WEB',
          interaction_device_ref,
          execution_device_ref: interaction_device_ref,
          requires_confirmation: false,
          confirmed: true,
          granted_execution_authority: false,
          interaction_device_unchanged: true,
          ranked,
          excluded: freeze(ranked.filter(entry => entry.eligible !== true).map(entry => freeze({ device_ref: entry.device_ref, reasons: entry.exclusion_reasons }))),
          ai_requests_launched: 0,
          probes_sent: 0,
          dispatch_performed: false,
          created_at: at,
        });
        proposals.set(proposal.proposal_ref, { ...proposal, endpoint_ref: local.endpoint_ref, confirmation: null });
        note('LOCAL_WEB_PREFERRED', at, { action_ref, device_ref: interaction_device_ref });
        return freeze({ ...proposal, selection_reason: 'CURRENT_DEVICE_HEALTHY', attention: null });
      }

      const best = ranked.find(entry => entry.eligible === true) ?? null;
      if (best === null) {
        note('NO_HEALTHY_ENDPOINT', at, { action_ref });
        throw new RemoteExecutionError('NO_HEALTHY_ENDPOINT', 'no healthy, fresh remote endpoint is available to execute this action', {
          action_ref,
          ranked: freeze(clone(ranked)),
          stale_or_offline_excluded: freeze(ranked.filter(entry => entry.exclusion_reasons.some(reason => reason === 'STALE_ENDPOINT' || reason === 'OFFLINE')).map(entry => entry.device_ref)),
          ai_requests_launched: 0,
        });
      }
      counter += 1;
      const proposal = freeze({
        contract_version: REMOTE_EXECUTION_CONTRACT_VERSION,
        proposal_ref: `proposal:${counter}`,
        action_ref,
        route: 'REMOTE_DEVICE',
        interaction_device_ref,
        execution_device_ref: best.device_ref,
        endpoint_ref: best.endpoint_ref,
        requires_confirmation: config.v1_confirmation_required === true,
        confirmed: false,
        granted_execution_authority: false,
        interaction_device_unchanged: true,
        selection_reason: local === null ? 'NO_LOCAL_WEB_ENDPOINT' : 'LOCAL_WEB_NOT_HEALTHY',
        local_exclusion_reasons: local === null ? freeze(['NO_LOCAL_ENDPOINT']) : local.exclusion_reasons,
        ranked,
        excluded: freeze(ranked.filter(entry => entry.eligible !== true).map(entry => freeze({ device_ref: entry.device_ref, reasons: entry.exclusion_reasons }))),
        score: best.score,
        ai_requests_launched: 0,
        probes_sent: 0,
        dispatch_performed: false,
        created_at: at,
      });
      proposals.set(proposal.proposal_ref, { ...proposal, endpoint_ref: best.endpoint_ref, confirmation: null });
      note('DEVICE_SWITCH_PROPOSED', at, { action_ref, execution_device_ref: best.device_ref, score: best.score });
      return freeze(proposal);
    },

    confirmProposal({ proposal_ref, confirmed = false, user_ref = null, at: when } = {}) {
      const proposal = proposals.get(proposal_ref);
      if (!proposal) throw new RemoteExecutionError('UNKNOWN_PROPOSAL', `no proposal ${String(proposal_ref)}`);
      const at = when ?? now();
      if (proposal.confirmation !== null) {
        return freeze({ ...clone(proposal.confirmation), duplicate: true });
      }
      const confirmation = freeze({
        contract_version: REMOTE_EXECUTION_CONTRACT_VERSION,
        confirmation_ref: `confirmation:${proposal_ref}:${confirmed === true ? 'APPROVED' : 'DENIED'}`,
        proposal_ref,
        action_ref: proposal.action_ref,
        confirmed: confirmed === true,
        user_ref,
        execution_device_ref: proposal.execution_device_ref,
        interaction_device_ref: proposal.interaction_device_ref,
        grants_execution_authority: false,
        dispatch_may_proceed: confirmed === true,
        confirmed_at: at,
      });
      proposal.confirmation = confirmation;
      proposal.confirmed = confirmed === true;
      note(confirmed === true ? 'PROPOSAL_CONFIRMED' : 'PROPOSAL_DENIED', at, { proposal_ref });
      return freeze({ ...confirmation, duplicate: false });
    },

    /**
     * Dispatch exactly one canonical action id to the chosen host. The interaction device is untouched.
     */
    dispatch({ proposal_ref, action_id, action_ref = null, input_bundle_refs = [], at: when } = {}) {
      const proposal = proposals.get(proposal_ref);
      if (!proposal) throw new RemoteExecutionError('UNKNOWN_PROPOSAL', `no proposal ${String(proposal_ref)}`);
      if (!isText(action_id)) throw new RemoteExecutionError('INVALID_REQUEST', 'the canonical action_id is required');
      const at = when ?? now();

      // Duplicate dispatch is absorbed: the execution host must never grow a second Action.
      const existing = [...actions.values()].find(action => action.action_id === action_id) ?? null;
      if (existing !== null) {
        note('DISPATCH_DUPLICATE_SUPPRESSED', at, { action_id });
        return freeze({ ...api.statusFor({ action_id }), dispatched: false, duplicate: true, actions_created_on_execution_host: 1, at });
      }

      if (proposal.route === 'REMOTE_DEVICE' && proposal.confirmation !== null && proposal.confirmation.confirmed !== true) {
        throw new RemoteExecutionError('PROPOSAL_NOT_CONFIRMED', 'the device switch proposal was denied', { action_id, proposal_ref, dispatch_performed: false });
      }
      if (proposal.route === 'REMOTE_DEVICE' && config.v1_confirmation_required === true && proposal.confirmed !== true) {
        throw new RemoteExecutionError('CONFIRMATION_REQUIRED', 'V1 requires explicit user confirmation before dispatching to another device', {
          action_id,
          proposal_ref,
          execution_device_ref: proposal.execution_device_ref,
          interaction_device_unchanged: true,
          dispatch_performed: false,
        });
      }

      // Semantic input staging: every staged reference carries its own cleanup policy.
      const staged = [];
      for (const [index, reference] of input_bundle_refs.entries()) {
        if (!isPlainObject(reference) || !isText(reference.bundle_ref) || !STAGING_POLICIES.includes(reference.staging_policy)) {
          throw new RemoteExecutionError('STAGING_POLICY_REQUIRED', `input_bundle_refs[${index}] needs a bundle_ref and an explicit staging policy`);
        }
        staged.push(freeze({
          bundle_ref: reference.bundle_ref,
          staging_policy: reference.staging_policy,
          cleanup_by: isIsoInstant(reference.cleanup_by) ? reference.cleanup_by : null,
          cleanup_required: reference.staging_policy === 'DELETE_AFTER_USE',
          canonical_local_path: null,
        }));
      }

      const endpoint = listEndpoints().find(entry => entry.endpoint_ref === proposal.endpoint_ref) ?? null;
      if (endpoint === null) throw new RemoteExecutionError('UNKNOWN_ENDPOINT', `the approved endpoint ${String(proposal.endpoint_ref)} is no longer advertised`);
      if (endpoint.device_ref !== proposal.execution_device_ref) throw new RemoteExecutionError('ENDPOINT_NOT_APPROVED', 'the endpoint no longer belongs to the approved execution device');

      // Hardware-bound authentication is surfaced honestly, never as a false success.
      if (endpoint.hardware_auth_required === true) {
        counter += 1;
        const attention = freeze({
          contract_version: REMOTE_EXECUTION_CONTRACT_VERSION,
          attention_ref: `attention:${counter}`,
          kind: 'DEVICE_ACTION',
          blocking: true,
          question: `${proposal.execution_device_ref} needs a physical confirmation before it can execute this action`,
          action_id,
          execution_device_ref: proposal.execution_device_ref,
          delivered_to: proposal.interaction_device_ref,
          delivered_remotely: true,
          user_must_operate_execution_host: false,
          created_at: at,
        });
        note('ATTENTION_REQUIRED', at, { action_id, execution_device_ref: proposal.execution_device_ref });
        return freeze({
          ...clone(proposal),
          dispatched: false,
          attention_required: true,
          attention,
          execution_started: false,
          actions_created_on_execution_host: 0,
          interaction_device_unchanged: true,
          delivered_to_interaction_device: true,
          at,
        });
      }

      portCalls.dispatch += 1;
      const receipt = executionPort.dispatch({
        action_id,
        endpoint_ref: proposal.endpoint_ref,
        execution_device_ref: proposal.execution_device_ref,
        interaction_device_ref: proposal.interaction_device_ref,
        input_bundle_refs: staged.map(entry => entry.bundle_ref),
        semantic_rpc: true,
      });
      const action = {
        action_id,
        action_ref: action_ref ?? proposal.action_ref,
        proposal_ref,
        interaction_device_ref: proposal.interaction_device_ref,
        execution_device_ref: proposal.execution_device_ref,
        endpoint_ref: proposal.endpoint_ref,
        state: 'DISPATCHED',
        events: [],
        seq: 0,
        partial_refs: [],
        final_ref: null,
        error: null,
        cancellation: null,
        reconciled_events: [],
        attention: null,
        staged_inputs: staged,
        viewers: [proposal.interaction_device_ref, proposal.execution_device_ref],
        dispatched_at: at,
        receipt_ref: isPlainObject(receipt) && isText(receipt.receipt_ref) ? receipt.receipt_ref : null,
      };
      actions.set(action_id, action);
      note('ACTION_DISPATCHED', at, { action_id, execution_device_ref: action.execution_device_ref });
      return freeze({
        contract_version: REMOTE_EXECUTION_CONTRACT_VERSION,
        action_id,
        dispatched: true,
        duplicate: false,
        interaction_device_ref: action.interaction_device_ref,
        execution_device_ref: action.execution_device_ref,
        interaction_device_unchanged: true,
        action_created_on_interaction_device: false,
        actions_created_on_execution_host: 1,
        canonical_action_id: action_id,
        remote_desktop_stream: false,
        semantic_transport: true,
        staged_inputs: freeze(clone(staged)),
        receipt_ref: action.receipt_ref,
        state: action.state,
        at,
      });
    },

    /** Every remote event correlates to the one canonical action id, in order, until a terminal state. */
    recordEvent({ action_id, kind, seq = null, payload_ref = null, text = null, error = null, at: when } = {}) {
      const action = actions.get(action_id);
      if (!action) throw new RemoteExecutionError('UNKNOWN_ACTION', `no action ${String(action_id)}`);
      if (!EVENT_KINDS.includes(kind)) throw new RemoteExecutionError('INVALID_REQUEST', `kind must be one of ${EVENT_KINDS.join(', ')}`);
      const at = when ?? now();
      const nextSeq = action.seq + 1;
      if (TERMINAL_ACTION_STATES.includes(action.state)) {
        action.reconciled_events.push(freeze({ kind, seq, at, reason: 'LATE_EVENT_AFTER_TERMINAL' }));
        note('LATE_EVENT_RECONCILED', at, { action_id, kind });
        return freeze({
          contract_version: REMOTE_EXECUTION_CONTRACT_VERSION,
          action_id,
          applied: false,
          reconciled: true,
          reason: 'LATE_EVENT_AFTER_TERMINAL',
          state: action.state,
          correlated_action_id: action_id,
          at,
        });
      }
      if (seq !== null && seq !== nextSeq) {
        throw new RemoteExecutionError('EVENT_OUT_OF_ORDER', `event seq ${seq} is not the expected ${nextSeq}`, { action_id, expected_seq: nextSeq });
      }
      action.seq = nextSeq;
      const event = freeze({
        contract_version: REMOTE_EXECUTION_CONTRACT_VERSION,
        event_ref: `${action_id}:event:${nextSeq}`,
        action_id,
        correlated_action_id: action_id,
        kind,
        seq: nextSeq,
        payload_ref,
        text,
        terminal: kind === 'FINAL',
        at,
      });
      action.events.push(event);
      if (kind === 'PROGRESS' || kind === 'STATUS') action.state = 'RUNNING';
      if (kind === 'PARTIAL') { action.state = 'RUNNING'; action.partial_refs.push(event.event_ref); }
      if (kind === 'ERROR') { action.error = freeze({ code: isText(error?.code) ? error.code : 'REMOTE_ERROR', detail: isText(error?.detail) ? error.detail : null, at }); action.state = 'FAILED'; }
      if (kind === 'FINAL') { action.final_ref = payload_ref ?? event.event_ref; action.state = 'SUCCEEDED'; }
      if (kind === 'CANCELLED') action.state = 'CANCELLED';
      note('ACTION_EVENT', at, { action_id, kind: event.kind, seq: event.seq });
      return freeze({ ...clone(event), applied: true, reconciled: false, state: action.state });
    },

    /** Cancellation is allowed from any authorized device viewing the action, and is idempotent. */
    cancel({ action_id, by_device_ref, reason = 'USER_CANCELLED', at: when } = {}) {
      const action = actions.get(action_id);
      if (!action) throw new RemoteExecutionError('UNKNOWN_ACTION', `no action ${String(action_id)}`);
      if (!isText(by_device_ref)) throw new RemoteExecutionError('INVALID_REQUEST', 'by_device_ref is required');
      const at = when ?? now();
      if (action.cancellation !== null) {
        return freeze({ ...clone(action.cancellation), duplicate: true, cancellation_idempotent: true, state: action.state });
      }
      if (TERMINAL_ACTION_STATES.includes(action.state)) {
        throw new RemoteExecutionError('LATE_EVENT_AFTER_TERMINAL', `action ${action_id} is already ${action.state}`, { action_id, state: action.state });
      }
      if (!action.viewers.includes(by_device_ref)) {
        throw new RemoteExecutionError('NOT_AUTHORIZED_TO_CANCEL', `${by_device_ref} is not an authorized viewer of ${action_id}`, { action_id, viewers: freeze(clone(action.viewers)) });
      }
      portCalls.cancel += 1;
      const receipt = typeof executionPort.cancel === 'function' ? executionPort.cancel({ action_id, endpoint_ref: action.endpoint_ref, by_device_ref }) : null;
      const cancellation = freeze({
        contract_version: REMOTE_EXECUTION_CONTRACT_VERSION,
        cancellation_ref: `cancellation:${action_id}`,
        action_id,
        by_device_ref,
        reason,
        state: 'CANCELLED',
        cancelled_from: by_device_ref === action.interaction_device_ref ? 'INTERACTION_DEVICE' : 'OTHER_AUTHORIZED_DEVICE',
        interaction_device_is_only_cancel_authority: false,
        remote_cancel_receipt_ref: isPlainObject(receipt) && isText(receipt.receipt_ref) ? receipt.receipt_ref : null,
        cancelled_at: at,
      });
      action.cancellation = cancellation;
      action.state = 'CANCELLED';
      action.events.push(freeze({ contract_version: REMOTE_EXECUTION_CONTRACT_VERSION, event_ref: `${action_id}:event:${action.seq + 1}`, action_id, correlated_action_id: action_id, kind: 'CANCELLED', seq: action.seq + 1, terminal: false, at }));
      action.seq += 1;
      note('ACTION_CANCELLED', at, { action_id, by_device_ref });
      return freeze({ ...cancellation, duplicate: false, cancellation_idempotent: true });
    },

    /** One projection for the Action surface: everything correlated to the same canonical action id. */
    statusFor({ action_id } = {}) {
      const action = actions.get(action_id);
      if (!action) throw new RemoteExecutionError('UNKNOWN_ACTION', `no action ${String(action_id)}`);
      return freeze({
        contract_version: REMOTE_EXECUTION_CONTRACT_VERSION,
        action_id,
        action_ref: action.action_ref,
        state: action.state,
        terminal: TERMINAL_ACTION_STATES.includes(action.state),
        interaction_device_ref: action.interaction_device_ref,
        execution_device_ref: action.execution_device_ref,
        interaction_device_unchanged: true,
        endpoint_ref: action.endpoint_ref,
        progress_events: action.events.filter(event => event.kind === 'PROGRESS' || event.kind === 'STATUS').length,
        partial_refs: freeze(clone(action.partial_refs)),
        final_ref: action.final_ref,
        error: action.error,
        attention: action.attention,
        cancelled: action.cancellation !== null,
        reconciliation_ref: action.cancellation?.cancellation_ref ?? null,
        reconciled_event_count: action.reconciled_events.length,
        correlated_action_ids: freeze([action_id]),
        event_count: action.events.length,
        semantic_transport: true,
        remote_desktop_stream: false,
        permission_granted_by_router: false,
      });
    },

    /** An AttentionRequest is always delivered back to the interaction device, never to the user's feet. */
    raiseAttention({ action_id, question, kind = 'DEVICE_ACTION', blocking = true, at: when } = {}) {
      const action = actions.get(action_id);
      if (!action) throw new RemoteExecutionError('UNKNOWN_ACTION', `no action ${String(action_id)}`);
      if (!isText(question)) throw new RemoteExecutionError('INVALID_REQUEST', 'an attention request needs a question');
      const at = when ?? now();
      counter += 1;
      const attention = freeze({
        contract_version: REMOTE_EXECUTION_CONTRACT_VERSION,
        attention_ref: `attention:${counter}`,
        kind,
        blocking,
        question,
        action_id,
        execution_device_ref: action.execution_device_ref,
        delivered_to: action.interaction_device_ref,
        delivered_remotely: true,
        user_must_operate_execution_host: false,
        created_at: at,
      });
      action.attention = attention;
      action.state = 'AWAITING_USER';
      note('ATTENTION_RAISED', at, { action_id, kind });
      return attention;
    },

    proposals: () => clone([...proposals.values()]).map(entry => freeze(entry)),
    actions: () => clone([...actions.values()]).map(entry => freeze(entry)),
    journal: () => clone(journal),
  };
  return Object.freeze(api);
}
