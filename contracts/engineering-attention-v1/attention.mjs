// Engineering attention bridge: current + recent-device delivery (EM-005).
//
// A blocking Engineering question must follow the user instead of trapping work on the execution host,
// without producing notification storms or duplicate answers. One `attention_id` is ONE logical
// question with several projections; the canonical Attention state stays shared (this module never
// builds an Engineering-only notification database). Pure module: no clock, transport, filesystem.
export const ATTENTION_CONTRACT_VERSION = 1;

export const ATTENTION_KINDS = Object.freeze(['PERMISSION', 'QUESTION', 'AUTHENTICATION', 'CONFIRMATION', 'DEVICE_ACTION']);
export const PROJECTION_KINDS = Object.freeze(['ACTIONABLE', 'NOTIFY', 'RING']);
export const ATTENTION_STATUSES = Object.freeze(['PENDING', 'ACKNOWLEDGED', 'EXPIRED', 'WITHDRAWN']);
/** 2–3 auxiliary devices, per the programme invariant. */
export const MIN_RECENT_DEVICES = 2;
export const MAX_RECENT_DEVICES = 3;
export const ATTENTION_CODES = Object.freeze([
  'INVALID_ATTENTION', 'UNKNOWN_ATTENTION', 'UNKNOWN_KIND', 'UNKNOWN_DEVICE', 'DEVICE_NOT_ELIGIBLE',
  'CURRENT_DEVICE_NOT_ELIGIBLE', 'ALREADY_ANSWERED', 'NOT_PROJECTED_TO_DEVICE', 'RECENT_DEVICE_LIMIT',
  'INVALID_POLICY', 'RESPONSE_ALREADY_ROUTED', 'NOT_BLOCKING', 'WITHDRAWN',
]);

export class AttentionError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'AttentionError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = 409;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

/** Callers may hand in either a millisecond instant or an ISO string; the record always stores ISO. */
const atOf = value => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (isIsoInstant(value)) return value;
  throw new AttentionError('INVALID_ATTENTION', 'instant ' + String(value) + ' is not an ISO-8601 UTC instant');
};

export const ATTENTION_ENVELOPE_SPEC = Object.freeze({
  contract_version: { required: true, type: 'int', constant: ATTENTION_CONTRACT_VERSION },
  attention_id: { required: true, type: 'text' },
  job_ref: { required: true, type: 'text' },
  connector_ref: { required: true, type: 'text' },
  kind: { required: true, type: 'enum', values: ATTENTION_KINDS },
  question: { required: true, type: 'text' },
  blocking: { required: true, type: 'bool' },
  created_at: { required: true, type: 'instant' },
});

export function validateAttentionEnvelope(envelope) {
  const errors = [];
  if (!isPlainObject(envelope)) return { ok: false, errors: ['attention must be an object'] };
  for (const key of Object.keys(envelope)) if (!(key in ATTENTION_ENVELOPE_SPEC)) errors.push(`attention.${key} is not part of the canonical contract`);
  for (const [key, rule] of Object.entries(ATTENTION_ENVELOPE_SPEC)) {
    const present = Object.hasOwn(envelope, key);
    if (!present) { if (rule.required) errors.push(`attention.${key} is required`); continue; }
    const field = envelope[key];
    if (rule.type === 'int' && field !== rule.constant) errors.push(`attention.${key} must be ${rule.constant}`);
    if (rule.type === 'text' && !isText(field)) errors.push(`attention.${key} must be nonempty text`);
    if (rule.type === 'bool' && typeof field !== 'boolean') errors.push(`attention.${key} must be a boolean`);
    if (rule.type === 'instant' && !isIsoInstant(field)) errors.push(`attention.${key} must be an ISO-8601 UTC instant`);
    if (rule.type === 'enum' && !rule.values.includes(field)) errors.push(`attention.${key} must be one of ${rule.values.join(', ')}`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function assertAttentionEnvelope(envelope) {
  const verdict = validateAttentionEnvelope(envelope);
  if (!verdict.ok) throw new AttentionError('INVALID_ATTENTION', verdict.errors.slice(0, 3).join(', '));
  return envelope;
}

/**
 * Rank devices for *auxiliary* alerts by real user interaction recency.
 *
 * Uptime, heartbeat age and device power are deliberately ignored: a server that has been up for a
 * month is not "recently operated", and the invariant exists so the alert reaches the devices the user
 * actually touches.
 */
export function rankRecentDevices(devices = [], { currentDeviceRef = null, count = MAX_RECENT_DEVICES } = {}) {
  if (!Array.isArray(devices)) throw new AttentionError('INVALID_POLICY', 'devices must be an array');
  if (!Number.isSafeInteger(count) || count < MIN_RECENT_DEVICES || count > MAX_RECENT_DEVICES) {
    throw new AttentionError('RECENT_DEVICE_LIMIT', `recent device count must be between ${MIN_RECENT_DEVICES} and ${MAX_RECENT_DEVICES}`);
  }
  const ranked = devices
    .filter(device => isPlainObject(device) && isText(device.device_ref))
    .filter(device => device.device_ref !== currentDeviceRef)
    .filter(device => device.online === true && device.eligible === true)
    .filter(device => isIsoInstant(device.last_interacted_at))
    .sort((left, right) => {
      const byRecency = Date.parse(right.last_interacted_at) - Date.parse(left.last_interacted_at);
      return byRecency !== 0 ? byRecency : left.device_ref.localeCompare(right.device_ref);
    });
  return Object.freeze(ranked.slice(0, count).map(device => device.device_ref));
}

/** Sound policy: quiet, full-screen or protected use suppresses sound, never the notification. */
export function soundAllowed(device = {}, { ringInformational = false, blocking = true } = {}) {
  if (device.quiet === true || device.full_screen === true || device.protected_use === true) return false;
  if (blocking !== true && ringInformational !== true) return false;
  return true;
}

export function createAttentionBridge({ clock = () => null, policy = {} } = {}) {
  const settings = {
    recentDeviceCount: policy.recentDeviceCount ?? MAX_RECENT_DEVICES,
    ringInformational: policy.ringInformational === true,
  };
  if (!Number.isSafeInteger(settings.recentDeviceCount) || settings.recentDeviceCount < MIN_RECENT_DEVICES || settings.recentDeviceCount > MAX_RECENT_DEVICES) {
    throw new AttentionError('INVALID_POLICY', `recentDeviceCount must be between ${MIN_RECENT_DEVICES} and ${MAX_RECENT_DEVICES}`);
  }
  const events = new Map();
  const delivered = new Map();

  const requireEvent = attentionId => {
    const event = events.get(attentionId);
    if (!event) throw new AttentionError('UNKNOWN_ATTENTION', String(attentionId));
    return event;
  };

  const bridge = {
    /**
     * Open one logical question and project it. The actionable copy goes to the current interaction
     * device; notification/ring copies go to the ranked recent devices.
     */
    open(attention, { currentDeviceRef, devices = [], at = clock() } = {}) {
      assertAttentionEnvelope(attention);
      if (events.has(attention.attention_id)) {
        // Re-opening the same attention id is a re-delivery, not a second question.
        return { event: clone(events.get(attention.attention_id)), opened: false, reason: 'ALREADY_OPEN' };
      }
      const current = devices.find(device => device.device_ref === currentDeviceRef);
      if (!current || current.online !== true || current.eligible !== true) {
        throw new AttentionError('CURRENT_DEVICE_NOT_ELIGIBLE', `the current interaction device ${String(currentDeviceRef)} is not online and eligible`);
      }
      const recent = rankRecentDevices(devices, { currentDeviceRef, count: settings.recentDeviceCount });
      const projections = [];
      const currentIsQuiet = soundAllowed(current, { ringInformational: settings.ringInformational, blocking: attention.blocking }) === false;
      projections.push({
        device_ref: currentDeviceRef,
        projection: 'ACTIONABLE',
        actionable: true,
        notification_visible: true,
        ringing: false,
        sound_suppressed: currentIsQuiet,
        delivery_epoch: 0,
      });
      recent.forEach(deviceRef => {
        const device = devices.find(entry => entry.device_ref === deviceRef);
        const ring = soundAllowed(device, { ringInformational: settings.ringInformational, blocking: attention.blocking });
        projections.push({
          device_ref: deviceRef,
          projection: ring ? 'RING' : 'NOTIFY',
          actionable: false,
          notification_visible: true,
          // A suppressed device still receives the visible notification; only sound is withheld.
          ringing: ring,
          sound_suppressed: !ring,
          delivery_epoch: 0,
        });
      });
      const record = {
        attention_id: attention.attention_id,
        contract_version: ATTENTION_CONTRACT_VERSION,
        job_ref: attention.job_ref,
        connector_ref: attention.connector_ref,
        kind: attention.kind,
        question: attention.question,
        blocking: attention.blocking,
        created_at: attention.created_at,
        status: 'PENDING',
        acknowledgement: { status: 'PENDING', acknowledged_by: null, at: null },
        projections,
        recent_device_count: recent.length,
        opened_at: atOf(at),
      };
      events.set(attention.attention_id, record);
      // of the same epoch (reconnect, refresh, retry) is suppressed. Pre-marking would make the first
      // delivery indistinguishable from a duplicate.
      delivered.set(attention.attention_id, new Set());
      return { event: clone(record), opened: true, reason: null };
    },

    /**
     * Deliver (or re-deliver) one projection. Reconnect, page refresh, repeated connector delivery and
     * retry all funnel through here, and an already-delivered epoch never rings again.
     */
    deliver(attentionId, { deviceRef, at = clock(), reason = 'DELIVERY' } = {}) {
      const event = requireEvent(attentionId);
      const projection = event.projections.find(entry => entry.device_ref === deviceRef);
      if (!projection) throw new AttentionError('NOT_PROJECTED_TO_DEVICE', `${attentionId} is not projected to ${String(deviceRef)}`);
      if (event.status !== 'PENDING') return { delivered: false, ringing: false, actionable: false, suppressed: true, reason: event.status };
      const already = delivered.get(attentionId).has(`${deviceRef}:${projection.delivery_epoch}`);
      if (already) return { delivered: false, ringing: false, actionable: false, suppressed: true, reason: 'ALREADY_DELIVERED' };
      delivered.get(attentionId).add(`${deviceRef}:${projection.delivery_epoch}`);
      return { delivered: true, ringing: projection.ringing, actionable: projection.actionable, suppressed: false, reason };
    },

    /** First valid acknowledgement wins and closes the question globally. */
    acknowledge(attentionId, { deviceRef, at = clock() } = {}) {
      const event = requireEvent(attentionId);
      const projection = event.projections.find(entry => entry.device_ref === deviceRef);
      if (!projection) throw new AttentionError('NOT_PROJECTED_TO_DEVICE', `${attentionId} is not projected to ${String(deviceRef)}`);
      if (event.status !== 'PENDING') {
        return { acknowledged: false, duplicate: true, rangAgain: false, answeredBy: event.acknowledgement.acknowledged_by };
      }
      // Acknowledging from a non-actionable projection is allowed only if that device was projected;
      // the actionable device is not privileged, because any projected device may answer.
      event.status = 'ACKNOWLEDGED';
      event.acknowledgement = { status: 'ACKNOWLEDGED', acknowledged_by: deviceRef, at: atOf(at) };
      for (const entry of event.projections) {
        // Remaining projections stop ringing and stop being actionable; the audit keeps them.
        if (entry.device_ref !== deviceRef) {
          entry.ringing = false;
          entry.actionable = false;
          entry.notification_visible = false;
          entry.withdrawn_reason = 'ANSWERED_ELSEWHERE';
        } else {
          entry.ringing = false;
          entry.actionable = false;
        }
      }
      return { acknowledged: true, duplicate: false, rangAgain: false, answeredBy: deviceRef, at: atOf(at) };
    },

    /** Withdraw the whole question (for example because the job reached a terminal state). */
    withdraw(attentionId, { reason = 'WITHDRAWN', at = clock() } = {}) {
      const event = requireEvent(attentionId);
      if (event.status !== 'PENDING') return { withdrawn: false, status: event.status };
      event.status = 'WITHDRAWN';
      event.withdrawal_reason = reason;
      for (const entry of event.projections) {
        entry.ringing = false;
        entry.actionable = false;
        entry.notification_visible = false;
        entry.withdrawn_reason = reason;
      }
      return { withdrawn: true, status: event.status, at: atOf(at) };
    },

    /**
     * Route an answer back to the originating connector/job, whichever authorized device answered.
     */
    respond(attentionId, { deviceRef, response = null, at = clock() } = {}) {
      const event = requireEvent(attentionId);
      const projection = event.projections.find(entry => entry.device_ref === deviceRef);
      if (!projection) throw new AttentionError('NOT_PROJECTED_TO_DEVICE', `${attentionId} is not projected to ${String(deviceRef)}`);
      if (event.status !== 'ACKNOWLEDGED') throw new AttentionError('ALREADY_ANSWERED', `${attentionId} is ${event.status}; only an acknowledged question can carry a response`);
      if (event.acknowledgement.acknowledged_by !== deviceRef && event.response_routed) {
        throw new AttentionError('ALREADY_ANSWERED', `the response was already routed by ${event.acknowledgement.acknowledged_by}`);
      }
      event.response_routed = true;
      event.response = clone(response);
      return {
        attention_id: attentionId,
        job_ref: event.job_ref,
        connector_ref: event.connector_ref,
        answered_by_device_ref: deviceRef,
        // The interaction device is not the route target: the originating connector is.
        routed_to_connector: true,
        at: atOf(at),
      };
    },

    get(attentionId) { return clone(requireEvent(attentionId)); },
    listOpen() { return [...events.values()].filter(event => event.status === 'PENDING').map(event => clone(event)); },
    /** One logical question per attention id, however many projections it carries. */
    logicalQuestions() {
      return [...events.values()].map(event => ({ attention_id: event.attention_id, question: event.question, projections: event.projections.length, status: event.status }));
    },
    projectionsFor(deviceRef) {
      return [...events.values()].flatMap(event => event.projections
        .filter(entry => entry.device_ref === deviceRef)
        .map(entry => ({ attention_id: event.attention_id, status: event.status, ...clone(entry) })));
    },
    policy() { return Object.freeze({ ...settings }); },
  };

  return Object.freeze(bridge);
}