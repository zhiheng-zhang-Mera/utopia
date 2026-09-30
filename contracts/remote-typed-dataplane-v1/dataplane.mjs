// Typed RPC / EVENT / STREAM + reliable commands (RF-008).
//
// Three separate data-plane semantics, never one ambiguous message channel:
//
//   COMMAND 鈥?a request/response call, addressed by capability and version, with a stable `command_id`
//             (the user action) kept apart from `attempt_id` (one transport try).
//   EVENT   鈥?a subscription-scoped notification with ordering and causal metadata, replayable after a
//             reconnect.
//   STREAM  鈥?a lifecycle of its own (setup/data/control) with backpressure and cancellation that are
//             independent of any one-shot RPC.
//
// Domain envelopes (Assistant, General-AI, Engineering) travel as *opaque references*: this module carries
// a domain envelope reference and never becomes the canonical domain event model, and it never holds City
// task truth 鈥?it references it. Delivery acknowledgement is never reported as execution success: a terminal
// success requires an execution result, so "transport 200" cannot masquerade as "the work was done".
//
// Retrying a side-effecting command with the same idempotency key reuses the cached result instead of
// repeating the external effect, while a new `command_id` is a new user action even if the arguments match.
//
// Pure module: the clock is injected; no network, storage or ambient state.
export const DATAPLANE_CONTRACT_VERSION = 1;

export const ENVELOPE_KINDS = Object.freeze(['COMMAND', 'EVENT', 'STREAM_SETUP', 'STREAM_DATA', 'STREAM_CONTROL']);
export const DOMAINS = Object.freeze(['BA', 'GAI', 'EM']);
export const COMMAND_STATES = Object.freeze([
  'ACCEPTED', 'QUEUED', 'RUNNING', 'WAITING_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'REFUSED', 'UNAVAILABLE',
  'CANCELLED', 'TIMEOUT', 'UNKNOWN',
]);
export const TERMINAL_COMMAND_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'REFUSED', 'UNAVAILABLE', 'CANCELLED', 'TIMEOUT']);
export const SUCCESS_STATES = Object.freeze(['SUCCEEDED']);
export const EVIDENCE_KINDS = Object.freeze(['DELIVERY_ACK', 'EXECUTION_RESULT', 'REFUSAL', 'TIMEOUT', 'TRANSPORT_ERROR']);
export const STREAM_STATES = Object.freeze(['IDLE', 'OPENING', 'OPEN', 'PAUSED', 'CLOSED', 'CANCELLED']);
export const STREAM_KINDS = Object.freeze(['AUDIO', 'VIDEO', 'SENSOR', 'TOKEN']);

export const DATAPLANE_CODES = Object.freeze([
  'INVALID_REQUEST', 'INVALID_ENVELOPE', 'INVALID_CLOCK', 'INVALID_TRANSITION', 'UNKNOWN_COMMAND',
  'UNKNOWN_STREAM', 'UNKNOWN_SUBSCRIPTION', 'DUPLICATE_ENVELOPE', 'DEADLINE_EXPIRED', 'FALSE_SUCCESS_REFUSED',
  'IDEMPOTENCY_KEY_REQUIRED', 'BACKPRESSURE', 'EVENT_OUT_OF_ORDER', 'SEQUENCE_GAP', 'STREAM_NOT_OPEN',
  'TERMINAL_COMMAND', 'NOT_OPAQUE_DOMAIN', 'COMMAND_ID_REUSED_WITH_DIFFERENT_ACTION',
]);

const CONFLICT_CODES = new Set(['DUPLICATE_ENVELOPE', 'DEADLINE_EXPIRED', 'FALSE_SUCCESS_REFUSED', 'TERMINAL_COMMAND', 'COMMAND_ID_REUSED_WITH_DIFFERENT_ACTION']);

export class DataplaneError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'DataplaneError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_COMMAND' || code === 'UNKNOWN_STREAM' || code === 'UNKNOWN_SUBSCRIPTION' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
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

const COMMAND_SPEC = Object.freeze({
  envelope_kind: { required: true, const: 'COMMAND' },
  envelope_version: { required: true, const: DATAPLANE_CONTRACT_VERSION },
  command_id: { required: true, text: true },
  attempt_id: { required: true, text: true },
  origin_ref: { required: true, text: true },
  target_ref: { required: true, text: true },
  capability_id: { required: true, text: true },
  capability_version: { required: true, int: true },
  task_ref: { required: false, nullable: true },
  action_ref: { required: false, nullable: true },
  idempotency_key: { required: false, nullable: true },
  side_effecting: { required: true, bool: true },
  deadline_at: { required: false, nullable: true },
  payload_ref: { required: false, nullable: true },
  domain: { required: true, domain: true },
  domain_envelope_ref: { required: true, text: true },
  at: { required: true, instant: true },
});

const EVENT_SPEC = Object.freeze({
  envelope_kind: { required: true, const: 'EVENT' },
  envelope_version: { required: true, const: DATAPLANE_CONTRACT_VERSION },
  event_id: { required: true, text: true },
  topic: { required: true, text: true },
  sequence: { required: true, int: true },
  caused_by: { required: false, nullable: true },
  correlation_ref: { required: true, text: true },
  payload_ref: { required: false, nullable: true },
  domain: { required: true, domain: true },
  domain_envelope_ref: { required: true, text: true },
  at: { required: true, instant: true },
});

const STREAM_SPEC = Object.freeze({
  envelope_kind: { required: true, const: 'STREAM_SETUP' },
  envelope_version: { required: true, const: DATAPLANE_CONTRACT_VERSION },
  stream_ref: { required: true, text: true },
  target_ref: { required: true, text: true },
  capability_id: { required: true, text: true },
  capability_version: { required: true, int: true },
  stream_kind: { required: true, stream_kind: true },
  direction: { required: true, direction: true },
  window: { required: true, int: true },
  domain: { required: true, domain: true },
  domain_envelope_ref: { required: true, text: true },
  at: { required: true, instant: true },
});

function checkShape(value, spec, errors) {
  if (!isPlainObject(value)) { errors.push('envelope must be an object'); return; }
  for (const key of Object.keys(value)) if (!(key in spec)) errors.push(`${key} is not part of the canonical envelope`);
  for (const [key, rule] of Object.entries(spec)) {
    const present = Object.hasOwn(value, key);
    if (!present) { if (rule.required) errors.push(`${key} is required`); continue; }
    const field = value[key];
    if (field === null || field === undefined) { if (!rule.nullable) errors.push(`${key} must not be null`); continue; }
    if (rule.const !== undefined && field !== rule.const) errors.push(`${key} must be ${rule.const}`);
    if (rule.text === true && !isText(field)) errors.push(`${key} must be nonempty text`);
    if (rule.int === true && (!Number.isSafeInteger(field) || field < 0)) errors.push(`${key} must be a non-negative integer`);
    if (rule.bool === true && typeof field !== 'boolean') errors.push(`${key} must be a boolean`);
    if (rule.instant === true && !isIsoInstant(field)) errors.push(`${key} must be an ISO-8601 UTC instant`);
    if (rule.domain === true && !DOMAINS.includes(field)) errors.push(`${key} must be one of ${DOMAINS.join(', ')}`);
    if (rule.stream_kind === true && !STREAM_KINDS.includes(field)) errors.push(`${key} must be one of ${STREAM_KINDS.join(', ')}`);
    if (rule.direction === true && !['SEND', 'RECEIVE'].includes(field)) errors.push(`${key} must be SEND or RECEIVE`);
  }
}

export const DEFAULT_DATAPLANE_POLICY = Object.freeze({
  policy_ref: 'policy:rf-dataplane-default',
  default_stream_window: 8,
  max_stream_window: 256,
  max_deadline_ms: 300000,
});

export function createDataplane({ clock = () => new Date().toISOString(), policy = {} } = {}) {
  if (typeof clock !== 'function') throw new DataplaneError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  const config = { ...DEFAULT_DATAPLANE_POLICY, ...(isPlainObject(policy) ? policy : {}) };
  const commands = new Map();
  const attempts = new Map();
  const idempotency = new Map();
  const streams = new Map();
  const subscriptions = new Map();
  const events = [];
  const journal = [];
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isIsoInstant(produced)) throw new DataplaneError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
    return produced;
  };

  const note = (event, at, detail = {}) => {
    journal.push(freeze({ event, at, ...detail }));
    return journal.length - 1;
  };

  const commandProjection = command => freeze({
    contract_version: DATAPLANE_CONTRACT_VERSION,
    envelope_kind: 'COMMAND',
    envelope_version: DATAPLANE_CONTRACT_VERSION,
    command_id: command.command_id,
    attempt_id: command.attempt_id,
    attempts: command.attempts,
    origin_ref: command.origin_ref,
    target_ref: command.target_ref,
    capability_id: command.capability_id,
    capability_version: command.capability_version,
    task_ref: command.task_ref,
    action_ref: command.action_ref,
    side_effecting: command.side_effecting,
    idempotency_key: command.idempotency_key,
    state: command.state,
    terminal: TERMINAL_COMMAND_STATES.includes(command.state),
    delivery_acknowledged: command.delivery_acknowledged,
    execution_result_ref: command.execution_result_ref,
    error: command.error === null ? null : clone(command.error),
    deadline_at: command.deadline_at,
    rf_envelope_is_canonical: false,
    domain_payload_canonical_source: 'DOMAIN',
    domain: command.domain,
    domain_envelope_ref: command.domain_envelope_ref,
    task_truth_in_transport: false,
    owns_task_ownership: false,
  });

  const api = {
    policy: () => freeze(clone(config)),
    envelopeKinds: () => clone([...ENVELOPE_KINDS]),

    /** Dispatch a COMMAND. `attempt_id` is a transport try; `command_id` is the user action. */
    dispatchCommand(envelope) {
      const errors = [];
      checkShape(envelope, COMMAND_SPEC, errors);
      if (errors.length) throw new DataplaneError('INVALID_ENVELOPE', errors.join('; '));
      if (envelope.side_effecting === true && !isText(envelope.idempotency_key)) {
        throw new DataplaneError('IDEMPOTENCY_KEY_REQUIRED', 'a side-effecting command needs an idempotency key so a retry cannot repeat the effect');
      }
      const at = envelope.at;
      if (envelope.deadline_at !== null && envelope.deadline_at !== undefined) {
        if (!isIsoInstant(envelope.deadline_at)) throw new DataplaneError('INVALID_ENVELOPE', 'deadline_at must be an ISO-8601 UTC instant');
        if (Date.parse(envelope.deadline_at) <= Date.parse(at)) {
          note('COMMAND_DEADLINE_EXPIRED', at, { command_id: envelope.command_id });
          throw new DataplaneError('DEADLINE_EXPIRED', `command ${envelope.command_id} is already past its deadline ${envelope.deadline_at} and must not execute`, {
            command_id: envelope.command_id,
            deadline_at: envelope.deadline_at,
            executed: false,
            external_effect: false,
          });
        }
      }

      const existing = commands.get(envelope.command_id) ?? null;
      const attemptKey = `${envelope.command_id}\u0000${envelope.attempt_id}`;
      if (existing !== null) {
        // Same command id, same attempt: a duplicated envelope.
        if (attempts.has(attemptKey)) {
          note('COMMAND_DUPLICATE_ENVELOPE', at, { command_id: envelope.command_id, attempt_id: envelope.attempt_id });
          return freeze({ ...commandProjection(existing), duplicate: true, new_user_action: false, executed: false, replayed: false });
        }
        if (existing.action_ref !== (envelope.action_ref ?? null)) {
          throw new DataplaneError('COMMAND_ID_REUSED_WITH_DIFFERENT_ACTION', `command ${envelope.command_id} already names action ${String(existing.action_ref)}`, { command_id: envelope.command_id });
        }
        // Same command id, new attempt: a transport retry, never a new user action.
        existing.attempt_id = envelope.attempt_id;
        existing.attempts += 1;
        attempts.set(attemptKey, at);
        note('COMMAND_RETRY_ATTEMPT', at, { command_id: envelope.command_id, attempt_id: envelope.attempt_id, attempts: existing.attempts });
        const cached = existing.side_effecting === true && existing.idempotency_key !== null ? idempotency.get(existing.idempotency_key) ?? null : null;
        if (cached !== null) {
          note('COMMAND_RESULT_REPLAYED', at, { command_id: envelope.command_id, idempotency_key: existing.idempotency_key });
          return freeze({
            ...commandProjection(existing),
            duplicate: false,
            new_user_action: false,
            retry: true,
            replayed: true,
            replayed_from_command_id: cached.command_id,
            executed: false,
            external_effect_repeated: false,
            replayed_result_ref: cached.result_ref,
            state: cached.state,
          });
        }
        return freeze({ ...commandProjection(existing), duplicate: false, new_user_action: false, retry: true, replayed: false, executed: false, external_effect_repeated: false });
      }

      const command = {
        command_id: envelope.command_id,
        attempt_id: envelope.attempt_id,
        attempts: 1,
        origin_ref: envelope.origin_ref,
        target_ref: envelope.target_ref,
        capability_id: envelope.capability_id,
        capability_version: envelope.capability_version,
        task_ref: envelope.task_ref ?? null,
        action_ref: envelope.action_ref ?? null,
        side_effecting: envelope.side_effecting,
        idempotency_key: envelope.idempotency_key ?? null,
        state: 'ACCEPTED',
        delivery_acknowledged: false,
        execution_result_ref: null,
        error: null,
        deadline_at: envelope.deadline_at ?? null,
        domain: envelope.domain,
        domain_envelope_ref: envelope.domain_envelope_ref,
        payload_ref: envelope.payload_ref ?? null,
        received_at: at,
      };
      commands.set(command.command_id, command);
      attempts.set(attemptKey, at);
      counter += 1;
      note('COMMAND_ACCEPTED', at, { command_id: command.command_id, attempt_id: command.attempt_id });
      return freeze({
        ...commandProjection(command),
        duplicate: false,
        new_user_action: true,
        retry: false,
        replayed: false,
        executed: false,
        delivery_ack_is_execution_success: false,
        accepted_at: at,
      });
    },

    /** Delivery acknowledgement is a transport fact, never execution success. */
    acknowledgeDelivery({ command_id, at: when } = {}) {
      const command = commands.get(command_id);
      if (!command) throw new DataplaneError('UNKNOWN_COMMAND', `no command ${String(command_id)}`);
      const at = when ?? now();
      command.delivery_acknowledged = true;
      if (command.state === 'ACCEPTED') command.state = 'QUEUED';
      note('DELIVERY_ACKNOWLEDGED', at, { command_id });
      return freeze({
        ...commandProjection(command),
        delivery_acknowledged: true,
        delivery_ack_is_execution_success: false,
        executed: false,
      });
    },

    transitionCommand({ command_id, state, at: when } = {}) {
      const command = commands.get(command_id);
      if (!command) throw new DataplaneError('UNKNOWN_COMMAND', `no command ${String(command_id)}`);
      if (!COMMAND_STATES.includes(state)) throw new DataplaneError('INVALID_TRANSITION', `state must be one of ${COMMAND_STATES.join(', ')}`);
      if (TERMINAL_COMMAND_STATES.includes(command.state)) throw new DataplaneError('TERMINAL_COMMAND', `command ${command_id} is ${command.state}`, { command_id, state: command.state });
      if (SUCCESS_STATES.includes(state)) {
        throw new DataplaneError('FALSE_SUCCESS_REFUSED', 'a command may only succeed through an execution result, not a state change', { command_id, delivered: command.delivery_acknowledged, executed: false });
      }
      const at = when ?? now();
      command.state = state;
      note('COMMAND_TRANSITION', at, { command_id, state });
      return commandProjection(command);
    },

    /** The only path to a terminal success: an execution result, from the target. */
    applyResult({ command_id, state, result_ref = null, error = null, at: when } = {}) {
      const command = commands.get(command_id);
      if (!command) throw new DataplaneError('UNKNOWN_COMMAND', `no command ${String(command_id)}`);
      if (!COMMAND_STATES.includes(state)) throw new DataplaneError('INVALID_TRANSITION', `state must be one of ${COMMAND_STATES.join(', ')}`);
      if (TERMINAL_COMMAND_STATES.includes(command.state)) {
        return freeze({ ...commandProjection(command), applied: false, duplicate: true, reason: 'ALREADY_TERMINAL' });
      }
      const at = when ?? now();
      command.state = state;
      if (SUCCESS_STATES.includes(state)) command.execution_result_ref = result_ref ?? `${command_id}:result`;
      if (state === 'FAILED' || state === 'REFUSED' || state === 'UNAVAILABLE' || state === 'TIMEOUT') {
        command.error = freeze({ code: isText(error?.code) ? error.code : state, detail: isText(error?.detail) ? error.detail : null, retryable: error?.retryable === true, at });
      }
      if (command.side_effecting === true && command.idempotency_key !== null && SUCCESS_STATES.includes(state)) {
        idempotency.set(command.idempotency_key, { command_id, state, result_ref: command.execution_result_ref, at });
      }
      note('COMMAND_RESULT', at, { command_id, state });
      return freeze({ ...commandProjection(command), applied: true, duplicate: false, executed: true, external_effect: command.side_effecting === true && SUCCESS_STATES.includes(state) });
    },

    /** A queued command that runs out of time becomes TIMEOUT; it never executes later. */
    sweepExpired({ at: when } = {}) {
      const at = when ?? now();
      const timedOut = [];
      for (const command of commands.values()) {
        if (command.deadline_at === null || TERMINAL_COMMAND_STATES.includes(command.state)) continue;
        if (Date.parse(command.deadline_at) <= Date.parse(at)) {
          command.state = 'TIMEOUT';
          command.error = freeze({ code: 'DEADLINE_EXPIRED', detail: `deadline ${command.deadline_at} passed`, retryable: false, at });
          timedOut.push(command.command_id);
        }
      }
      note('COMMANDS_SWEPT', at, { timed_out: timedOut.length });
      return freeze({ timed_out_commands: timedOut, timed_out_count: timedOut.length, executed_after_deadline: [] });
    },

    command: command_id => {
      const command = commands.get(command_id);
      return command ? commandProjection(command) : null;
    },

    /** EVENT subscriptions carry enough ordering/causal metadata to replay after a reconnect. */
    subscribe({ subscription_ref, topic, target_ref, from_sequence = 0, at: when } = {}) {
      if (!isText(subscription_ref) || !isText(topic) || !isText(target_ref)) throw new DataplaneError('INVALID_REQUEST', 'subscription_ref, topic and target_ref are required');
      if (!Number.isSafeInteger(from_sequence) || from_sequence < 0) throw new DataplaneError('INVALID_REQUEST', 'from_sequence must be a non-negative integer');
      const at = when ?? now();
      const subscription = {
        subscription_ref,
        topic,
        target_ref,
        resume_from_sequence: from_sequence,
        acked_sequence: from_sequence,
        created_at: at,
        reconnects: 0,
      };
      subscriptions.set(subscription_ref, subscription);
      note('SUBSCRIPTION_CREATED', at, { subscription_ref, topic, from_sequence });
      return freeze({
        contract_version: DATAPLANE_CONTRACT_VERSION,
        subscription_ref,
        topic,
        target_ref,
        resume_from_sequence: from_sequence,
        is_rpc: false,
        reconnectable: true,
        created_at: at,
      });
    },

    publishEvent(envelope) {
      const errors = [];
      checkShape(envelope, EVENT_SPEC, errors);
      if (errors.length) throw new DataplaneError('INVALID_ENVELOPE', errors.join('; '));
      const topicEvents = events.filter(event => event.topic === envelope.topic);
      if (topicEvents.some(event => event.event_id === envelope.event_id)) {
        note('EVENT_DUPLICATE', envelope.at, { event_id: envelope.event_id });
        return freeze({ contract_version: DATAPLANE_CONTRACT_VERSION, event_id: envelope.event_id, duplicate: true, applied: false, sequence: null, rf_envelope_is_canonical: false });
      }
      const expected = topicEvents.length === 0 ? 1 : topicEvents[topicEvents.length - 1].sequence + 1;
      if (envelope.sequence !== expected) {
        note('EVENT_OUT_OF_ORDER_REFUSED', envelope.at, { event_id: envelope.event_id, expected });
        throw new DataplaneError('EVENT_OUT_OF_ORDER', `event sequence ${envelope.sequence} is not the expected ${expected} for topic ${envelope.topic}`, {
          topic: envelope.topic,
          expected_sequence: expected,
          resume_from_sequence: expected,
        });
      }
      const event = freeze({
        contract_version: DATAPLANE_CONTRACT_VERSION,
        envelope_kind: 'EVENT',
        event_id: envelope.event_id,
        topic: envelope.topic,
        sequence: envelope.sequence,
        caused_by: envelope.caused_by ?? null,
        correlation_ref: envelope.correlation_ref,
        payload_ref: envelope.payload_ref ?? null,
        domain: envelope.domain,
        domain_envelope_ref: envelope.domain_envelope_ref,
        rf_envelope_is_canonical: false,
        domain_payload_canonical_source: 'DOMAIN',
        delivery_ack_is_execution_success: false,
        at: envelope.at,
      });
      events.push(event);
      note('EVENT_PUBLISHED', envelope.at, { event_id: event.event_id, topic: event.topic, sequence: event.sequence });
      return freeze({ ...clone(event), duplicate: false, applied: true });
    },

    /** Reconnect: replay from where the subscription left off, and report a gap honestly. */
    replayFrom({ subscription_ref, from_sequence = null, at: when } = {}) {
      const subscription = subscriptions.get(subscription_ref);
      if (!subscription) throw new DataplaneError('UNKNOWN_SUBSCRIPTION', `no subscription ${String(subscription_ref)}`);
      const at = when ?? now();
      const resume = from_sequence ?? subscription.resume_from_sequence;
      const topicEvents = events.filter(event => event.topic === subscription.topic).sort((left, right) => left.sequence - right.sequence);
      const replayed = topicEvents.filter(event => event.sequence >= resume);
      const highest = topicEvents.length === 0 ? 0 : topicEvents[topicEvents.length - 1].sequence;
      const contiguous = replayed.length === Math.max(0, highest - resume + 1);
      subscription.resume_from_sequence = highest + 1;
      subscription.acked_sequence = highest;
      subscription.reconnects += 1;
      note('SUBSCRIPTION_REPLAYED', at, { subscription_ref, from_sequence: resume, replayed: replayed.length, gap: !contiguous });
      return freeze({
        contract_version: DATAPLANE_CONTRACT_VERSION,
        subscription_ref,
        topic: subscription.topic,
        from_sequence: resume,
        events: freeze(replayed.map(event => clone(event))),
        replayed_count: replayed.length,
        next_sequence: subscription.resume_from_sequence,
        gap_detected: !contiguous,
        missing_sequences: contiguous ? freeze([]) : freeze(Array.from({ length: Math.max(0, highest - resume + 1) - replayed.length }, (_, index) => resume + index).filter(sequence => !replayed.some(event => event.sequence === sequence))),
        is_rpc: false,
        reconnects: subscription.reconnects,
      });
    },

    /** STREAM has its own lifecycle, backpressure and cancellation. */
    openStream(envelope) {
      const errors = [];
      checkShape(envelope, STREAM_SPEC, errors);
      if (errors.length) throw new DataplaneError('INVALID_ENVELOPE', errors.join('; '));
      if (!Number.isSafeInteger(envelope.window) || envelope.window <= 0 || envelope.window > config.max_stream_window) {
        throw new DataplaneError('INVALID_ENVELOPE', `window must be between 1 and ${config.max_stream_window}`);
      }
      const at = envelope.at;
      const stream = {
        stream_ref: envelope.stream_ref,
        target_ref: envelope.target_ref,
        capability_id: envelope.capability_id,
        capability_version: envelope.capability_version,
        stream_kind: envelope.stream_kind,
        direction: envelope.direction,
        state: 'OPEN',
        credit: envelope.window,
        window: envelope.window,
        frames_sent: 0,
        bytes: 0,
        closed_ref: null,
        cancellation: null,
        domain: envelope.domain,
        domain_envelope_ref: envelope.domain_envelope_ref,
        opened_at: at,
      };
      streams.set(stream.stream_ref, stream);
      note('STREAM_OPENED', at, { stream_ref: stream.stream_ref, kind: stream.stream_kind });
      return freeze({
        contract_version: DATAPLANE_CONTRACT_VERSION,
        stream_ref: stream.stream_ref,
        state: stream.state,
        stream_kind: stream.stream_kind,
        direction: stream.direction,
        credit: stream.credit,
        is_rpc: false,
        rf_envelope_is_canonical: false,
        opened_at: at,
      });
    },

    streamCredit({ stream_ref, credit, at: when } = {}) {
      const stream = streams.get(stream_ref);
      if (!stream) throw new DataplaneError('UNKNOWN_STREAM', `no stream ${String(stream_ref)}`);
      if (stream.state !== 'OPEN' && stream.state !== 'PAUSED') throw new DataplaneError('STREAM_NOT_OPEN', `stream ${stream_ref} is ${stream.state}`);
      if (!Number.isSafeInteger(credit) || credit <= 0) throw new DataplaneError('INVALID_REQUEST', 'credit must be a positive integer');
      const at = when ?? now();
      stream.credit += credit;
      if (stream.state === 'PAUSED') stream.state = 'OPEN';
      note('STREAM_CREDIT', at, { stream_ref, credit: stream.credit });
      return freeze({ stream_ref, credit: stream.credit, state: stream.state, backpressure: false });
    },

    sendStreamData({ stream_ref, sequence = null, payload_ref = null, bytes = 0, at: when } = {}) {
      const stream = streams.get(stream_ref);
      if (!stream) throw new DataplaneError('UNKNOWN_STREAM', `no stream ${String(stream_ref)}`);
      if (['CLOSED', 'CANCELLED'].includes(stream.state)) throw new DataplaneError('STREAM_NOT_OPEN', `stream ${stream_ref} is ${stream.state}`);
      const at = when ?? now();
      if (stream.credit <= 0) {
        stream.state = 'PAUSED';
        note('STREAM_BACKPRESSURE', at, { stream_ref });
        return freeze({
          stream_ref,
          accepted: false,
          state: 'PAUSED',
          backpressure: true,
          credit: 0,
          frames_sent: stream.frames_sent,
          is_rpc: false,
          reason: 'NO_CREDIT',
        });
      }
      if (sequence !== null && sequence !== stream.frames_sent + 1) {
        throw new DataplaneError('EVENT_OUT_OF_ORDER', `stream frame ${sequence} is not the expected ${stream.frames_sent + 1}`, { stream_ref, expected_sequence: stream.frames_sent + 1 });
      }
      stream.credit -= 1;
      stream.frames_sent += 1;
      stream.bytes += Number.isFinite(bytes) ? bytes : 0;
      note('STREAM_FRAME', at, { stream_ref, sequence: stream.frames_sent });
      return freeze({
        stream_ref,
        accepted: true,
        state: stream.state,
        backpressure: false,
        credit: stream.credit,
        frames_sent: stream.frames_sent,
        sequence: stream.frames_sent,
        payload_ref,
        bytes: stream.bytes,
        is_rpc: false,
      });
    },

    cancelStream({ stream_ref, by_ref, reason = 'USER_CANCELLED', at: when } = {}) {
      const stream = streams.get(stream_ref);
      if (!stream) throw new DataplaneError('UNKNOWN_STREAM', `no stream ${String(stream_ref)}`);
      if (stream.cancellation !== null) return freeze({ ...clone(stream.cancellation), duplicate: true, is_rpc: false });
      if (['CLOSED', 'CANCELLED'].includes(stream.state)) throw new DataplaneError('STREAM_NOT_OPEN', `stream ${stream_ref} is already ${stream.state}`);
      const at = when ?? now();
      const cancellation = freeze({
        contract_version: DATAPLANE_CONTRACT_VERSION,
        cancellation_ref: `stream-cancellation:${stream_ref}`,
        stream_ref,
        by_ref: by_ref ?? null,
        reason,
        state: 'CANCELLED',
        cancelled_at: at,
        is_rpc: false,
        affects_commands: false,
      });
      stream.cancellation = cancellation;
      stream.state = 'CANCELLED';
      note('STREAM_CANCELLED', at, { stream_ref });
      return freeze({ ...cancellation, duplicate: false });
    },

    closeStream({ stream_ref, reason = 'COMPLETED', at: when } = {}) {
      const stream = streams.get(stream_ref);
      if (!stream) throw new DataplaneError('UNKNOWN_STREAM', `no stream ${String(stream_ref)}`);
      if (['CLOSED', 'CANCELLED'].includes(stream.state)) throw new DataplaneError('STREAM_NOT_OPEN', `stream ${stream_ref} is already ${stream.state}`);
      const at = when ?? now();
      stream.state = 'CLOSED';
      stream.closed_ref = `stream-closed:${stream_ref}`;
      note('STREAM_CLOSED', at, { stream_ref, frames_sent: stream.frames_sent });
      return freeze({
        contract_version: DATAPLANE_CONTRACT_VERSION,
        stream_ref,
        state: 'CLOSED',
        closed_ref: stream.closed_ref,
        frames_sent: stream.frames_sent,
        bytes: stream.bytes,
        reason,
        is_rpc: false,
        terminal_truth: 'STREAM_LIFECYCLE',
        frames_are_not_command_results: true,
      });
    },

    stream: stream_ref => {
      const stream = streams.get(stream_ref);
      if (!stream) return null;
      return freeze({
        contract_version: DATAPLANE_CONTRACT_VERSION,
        stream_ref: stream.stream_ref,
        state: stream.state,
        stream_kind: stream.stream_kind,
        direction: stream.direction,
        credit: stream.credit,
        frames_sent: stream.frames_sent,
        bytes: stream.bytes,
        is_rpc: false,
        rf_envelope_is_canonical: false,
        task_truth_in_transport: false,
      });
    },

    /** Transport sessions own no task truth: this is the explicit separation statement. */
    separation() {
      return freeze({
        contract_version: DATAPLANE_CONTRACT_VERSION,
        task_truth_in_transport: false,
        owns_task_ownership: false,
        owns_domain_state: false,
        rf_envelope_is_canonical: false,
        domain_payload_canonical_source: 'DOMAIN',
        envelope_kinds: clone([...ENVELOPE_KINDS]),
        delivery_ack_is_execution_success: false,
      });
    },

    commands: () => clone([...commands.values()]).map(command => commandProjection(command)),
    streams: () => clone([...streams.values()]).map(stream => freeze({ stream_ref: stream.stream_ref, state: stream.state, frames_sent: stream.frames_sent })),
    events: ({ topic = null } = {}) => clone(topic === null ? events : events.filter(event => event.topic === topic)),
    journal: () => clone(journal),
  };
  return Object.freeze(api);
}
