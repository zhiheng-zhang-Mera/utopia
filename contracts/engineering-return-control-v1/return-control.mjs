// Remote Sub-worker execution + automatic return/control (EM-007).
//
// CONTROL PLANE follows the user; EXECUTION PLANE may move to another device. Once a fallback is
// approved, the remote host becomes the current *executor*, never a new owner, and every normal artefact
// of the work — state, progress, logs, attention, result, artifacts — returns through canonical/shared
// state to the user's **current authorised interaction surface**, so normal work never requires walking
// to the remote host or watching remote-desktop video.
//
// The guards are the ones that make the invariant checkable rather than asserted: a dispatch needs an
// approved proposal and an eligible host; a return path may only be redirected onto a surface this module
// itself resolved for the same owner; every remote payload is validated before any sequence or ledger
// state moves; a duplicate dispatch is refused by the bridge rather than by whichever port it was handed;
// an explicit refusal from the execution port is never reported as success; a hardware-bound action makes
// the job observably blocked and a later SUCCEEDED result is refused rather than fabricated; and context
// staging is bounded by the number it advertises.
//
// This module owns Engineering semantics only: it consumes the Remote Fabric execution port and never
// implements trust, transport, presence or device identity. Pure module: no network, clock or storage.
export const RETURN_CONTROL_VERSION = 1;

export const RETURN_CHANNELS = Object.freeze(['STATE', 'STAGE', 'PROGRESS', 'EVENT', 'LOG', 'ATTENTION', 'RESULT', 'ARTIFACT']);
export const CONTROL_COMMANDS = Object.freeze(['PAUSE', 'RESUME', 'CANCEL', 'RESPOND']);
export const EXECUTOR_KINDS = Object.freeze(['LOCAL', 'REMOTE']);
export const RETURN_CONTROL_CODES = Object.freeze([
  'INVALID_REQUEST', 'PORT_REQUIRED', 'APPROVED_PROPOSAL_REQUIRED', 'INELIGIBLE_REMOTE_HOST',
  'UNAUTHORIZED_INTERACTION_DEVICE', 'STALE_EVENT', 'DUPLICATE_EXECUTION', 'UNKNOWN_JOB',
  'REMOTE_HOST_INTERACTION_REQUIRED', 'PHYSICAL_ACTION_CANNOT_SUCCEED', 'INVALID_ENVELOPE',
  'OWNER_CHANGE_FORBIDDEN', 'CONTROL_ALREADY_APPLIED',
]);

export class ReturnControlError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ReturnControlError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = 409;
  }
}

const isPlainObject = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
/** Account for the calendar: a well-shaped string can still be an impossible date, or not parse at all. */
export const isIsoInstant = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  && !Number.isNaN(Date.parse(value));

const INSTANT_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
/** Shape is not enough: the regex accepts a calendar-impossible date, so the components must round trip. */
const isRealInstant = value => {
  if (!isIsoInstant(value)) return false;
  const parts = INSTANT_PARTS.exec(value);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  return date.getUTCFullYear() === Number(parts[1])
    && date.getUTCMonth() + 1 === Number(parts[2])
    && date.getUTCDate() === Number(parts[3])
    && date.getUTCHours() === Number(parts[4])
    && date.getUTCMinutes() === Number(parts[5])
    && date.getUTCSeconds() === Number(parts[6]);
};
/** `null` means "no instant supplied" (the injected clock may legitimately be absent); junk is refused. */
const callerInstant = (value, label) => {
  if (value === undefined || value === null) return null;
  if (!isRealInstant(value)) throw new ReturnControlError('INVALID_REQUEST', `${label} must be a real ISO-8601 UTC instant, got ${String(value)}`);
  return value;
};

/** Context staging is bounded, and the bound is the number the result advertises. */
const MAX_STAGED_CONTEXT_ENTRIES = 64;
const CONTEXT_CLEANUP_POLICIES = Object.freeze(['AFTER_RESULT', 'AFTER_CANCEL']);

/**
 * Surfaces this module resolved itself. A delivery target is authority-bearing state, so it may not be a
 * caller-forged object: only the output of `resolveInteractionSurface` (which applies the authorised /
 * online / owner rules) can redirect a run's state, attention, result or artifacts.
 */
const RESOLVED_SURFACES = new WeakSet();

const digestPattern = /^sha256:[0-9a-f]{64}$/;

/** The Remote Fabric execution port this module adapts (never re-implements). */
export const ENGINEERING_REMOTE_EXECUTION_PORT = Object.freeze({
  interface: 'EngineeringRemoteExecutionPort',
  version: RETURN_CONTROL_VERSION,
  methods: Object.freeze(['listEligibleRemoteHosts', 'dispatch', 'subscribe', 'control', 'respond', 'collectArtifacts']),
  owns_node_trust: false,
  owns_transport: false,
  owns_device_identity: false,
  adapts_remote_fabric_public_api: true,
});

export function createRemoteExecutionPortDouble({ hosts = [], script = [] } = {}) {
  const dispatched = new Map();
  const controls = [];
  const responses = [];
  let cursor = 0;
  return Object.freeze({
    listEligibleRemoteHosts({ requiredCapabilities = [] } = {}) {
      return hosts.filter(host => requiredCapabilities.every(capability => (host.capability_refs ?? []).includes(capability))).map(host => ({ ...host }));
    },
    dispatch({ job_ref, execution_device_ref, execution_spec }) {
      if (dispatched.has(job_ref)) throw new ReturnControlError('DUPLICATE_EXECUTION', `job ${job_ref} is already dispatched`);
      dispatched.set(job_ref, { execution_device_ref, execution_spec: clone(execution_spec), steps: 0 });
      return { job_ref, dispatched: true, execution_device_ref };
    },
    subscribe({ job_ref }) {
      const entry = dispatched.get(job_ref);
      if (!entry) throw new ReturnControlError('UNKNOWN_JOB', String(job_ref));
      const step = script[cursor] ?? { channel: 'PROGRESS', progress_percent: 100, status: 'SUCCEEDED' };
      cursor += 1;
      entry.steps += 1;
      // Remote events carry their origin device so the return path can be checked, never assumed.
      return { job_ref, origin_device_ref: entry.execution_device_ref, sequence: entry.steps, ...step };
    },
    control({ job_ref, command }) { controls.push({ job_ref, command }); return { job_ref, command, accepted: true }; },
    respond({ job_ref, attention_id, response }) { responses.push({ job_ref, attention_id, response: clone(response) }); return { job_ref, attention_id, response, accepted: true }; },
    collectArtifacts({ job_ref }) { return { job_ref, artifacts: [] }; },
    __dispatched: dispatched,
    __controls: controls,
    __responses: responses,
  });
}

/** The control plane resolves to the user's *current* authorised surface, wherever execution runs. */
export function resolveInteractionSurface({ ownerRef, devices = [] } = {}) {
  if (!isText(ownerRef)) throw new ReturnControlError('INVALID_REQUEST', 'ownerRef is required');
  if (!Array.isArray(devices)) throw new ReturnControlError('INVALID_REQUEST', 'devices must be a list of interactive devices');
  // A device is only a candidate for *this* owner's surface: an authorised flag on a device belonging to
  // somebody else is not authority over this run. Each device is snapshotted once, so the fields that are
  // checked are the fields that are projected.
  const usable = devices.filter(isPlainObject).map(device => ({
    device_ref: device.device_ref,
    owner_ref: device.owner_ref,
    authorized: device.authorized,
    online: device.online,
    is_current: device.is_current,
    last_interacted_at: device.last_interacted_at,
  })).filter(device => isText(device.device_ref)
    && (device.owner_ref === undefined || device.owner_ref === ownerRef)
    && device.authorized === true
    && device.online === true);
  // Two devices claiming to be the current surface is an input error, not a tie to break: picking one
  // arbitrarily would decide where the user's control plane is.
  const claimedCurrent = usable.filter(device => device.is_current === true);
  if (claimedCurrent.length > 1) throw new ReturnControlError('INVALID_REQUEST', claimedCurrent.map(device => device.device_ref).join(', ') + ' all claim to be the current interaction surface');
  const current = claimedCurrent.sort((left, right) => left.device_ref.localeCompare(right.device_ref))[0]
    ?? usable.sort((left, right) => String(right.last_interacted_at ?? '').localeCompare(String(left.last_interacted_at ?? '')))[0]
    ?? null;
  const resolved = Object.freeze({
    owner_ref: ownerRef,
    interaction_device_ref: current?.device_ref ?? null,
    authorised_device_refs: Object.freeze(usable.map(device => device.device_ref).sort()),
    resolved_from: current?.is_current === true ? 'CURRENT_SURFACE' : (current ? 'MOST_RECENT_AUTHORISED' : 'NONE'),
  });
  RESOLVED_SURFACES.add(resolved);
  return resolved;
}

/**
 * Admit (or refuse) a surface for a run. Only a surface this module resolved, for the same owner and
 * naming a device that surface itself authorises, may become the destination of a run's returns.
 */
function admitInteractionSurface(ownerRef, surface) {
  if (surface === null || surface === undefined) return null;
  if (!isPlainObject(surface) || !RESOLVED_SURFACES.has(surface)) {
    throw new ReturnControlError('UNAUTHORIZED_INTERACTION_DEVICE', 'an interaction surface must be the result of resolveInteractionSurface');
  }
  if (surface.owner_ref !== ownerRef) {
    throw new ReturnControlError('OWNER_CHANGE_FORBIDDEN', `the resolved surface belongs to ${String(surface.owner_ref)}, not ${ownerRef}`);
  }
  const deviceRef = isText(surface.interaction_device_ref) ? surface.interaction_device_ref : null;
  if (deviceRef === null) {
    throw new ReturnControlError('UNAUTHORIZED_INTERACTION_DEVICE', 'the resolved surface is empty; a return cannot be delivered to nobody');
  }
  const authorised = Array.isArray(surface.authorised_device_refs) ? surface.authorised_device_refs.filter(isText) : [];
  if (!authorised.includes(deviceRef)) {
    throw new ReturnControlError('UNAUTHORIZED_INTERACTION_DEVICE', `${deviceRef} is not an authorised device of the surface it resolved from`);
  }
  return { device_ref: deviceRef, authorised_device_refs: authorised };
}

/** An explicit refusal from the port is a refusal, whether or not the port also returns a reason. */
const refusedByPort = (result, field) => isPlainObject(result) && result[field] === false;

export function createRemoteSubworkerBridge({ port, clock = () => null } = {}) {
  if (!port || typeof port.dispatch !== 'function') throw new ReturnControlError('PORT_REQUIRED', 'the Remote Fabric execution port is required');
  const jobs = new Map();

  const requireJob = jobRef => {
    const job = jobs.get(jobRef);
    if (!job) throw new ReturnControlError('UNKNOWN_JOB', String(jobRef));
    return job;
  };

  const bridge = {
    /**
     * Dispatch to a trusted remote host after an approved fallback. The job keeps its identity and owner;
     * the host becomes the current executor only. Nothing is dispatched until every input is admissible.
     */
    dispatch({ job, proposal, executionDeviceRef, interactionSurface = null, at: when = clock() } = {}) {
      if (!isPlainObject(job) || !isText(job.job_ref) || !isText(job.owner_ref)) throw new ReturnControlError('INVALID_REQUEST', 'a job with job_ref and owner_ref is required');
      // Each declared field is read once from here on, so the value that is validated is the value used.
      const jobRef = job.job_ref;
      const ownerRef = job.owner_ref;
      // V1: a remote dispatch always carries an approved proposal.
      if (!isPlainObject(proposal) || proposal.status !== 'APPROVED' || proposal.job_ref !== jobRef) {
        throw new ReturnControlError('APPROVED_PROPOSAL_REQUIRED', `job ${jobRef} needs an approved fallback proposal`);
      }
      const proposalOwnerRef = proposal.owner_ref;
      if (!isText(proposalOwnerRef)) {
        throw new ReturnControlError('APPROVED_PROPOSAL_REQUIRED', `the fallback proposal for ${jobRef} must name the owner it was approved for`);
      }
      if (proposalOwnerRef !== ownerRef) {
        throw new ReturnControlError('OWNER_CHANGE_FORBIDDEN', 'a fallback proposal may not change the logical owner');
      }
      // The bridge owns this invariant: a second dispatch would replace a live run's ledger, returns and
      // control history and reopen its sequence space.
      if (jobs.has(jobRef)) throw new ReturnControlError('DUPLICATE_EXECUTION', `job ${jobRef} is already dispatched; a second execution would reset its return ledger`);
      if (!isText(executionDeviceRef)) throw new ReturnControlError('INVALID_REQUEST', 'executionDeviceRef is required');
      const capabilities = job.required_capabilities ?? [];
      if (!Array.isArray(capabilities) || !capabilities.every(isText)) throw new ReturnControlError('INVALID_REQUEST', 'job.required_capabilities must be a list of capability refs');
      const admittedSurface = admitInteractionSurface(ownerRef, interactionSurface);
      const startedAt = callerInstant(when, 'at');
      const eligible = port.listEligibleRemoteHosts({ requiredCapabilities: capabilities });
      if (!eligible.some(host => host.host_ref === executionDeviceRef || host.device_ref === executionDeviceRef)) {
        throw new ReturnControlError('INELIGIBLE_REMOTE_HOST', `${String(executionDeviceRef)} does not satisfy the required capabilities`);
      }
      const acceptance = port.dispatch({ job_ref: jobRef, execution_device_ref: executionDeviceRef, execution_spec: { job_ref: jobRef, owner_ref: ownerRef } });
      if (refusedByPort(acceptance, 'dispatched')) {
        throw new ReturnControlError('DUPLICATE_EXECUTION', `the execution port refused to dispatch ${jobRef} (${String(acceptance.reason ?? 'refused')})`);
      }
      const record = {
        job_ref: jobRef,
        owner_ref: ownerRef,
        execution_device_ref: executionDeviceRef,
        interaction_device_ref: admittedSurface?.device_ref ?? null,
        authorised_device_refs: [...(admittedSurface?.authorised_device_refs ?? [])],
        executor_kind: 'REMOTE',
        owner_preserved: true,
        blocking_state: null,
        last_sequence: 0,
        ledger: [],
        returns: [],
        control_applied: [],
        started_at: startedAt,
      };
      jobs.set(jobRef, record);
      return clone(record);
    },

    /**
     * Return one remote envelope to the interaction surface. Every channel returns: whatever the remote
     * host produced is projected to the user's current surface, not to the execution device.
     */
    applyRemoteEvent(jobRef, event, { interactionSurface = null, at: when = clock() } = {}) {
      const job = requireJob(jobRef);
      if (!isPlainObject(event)) throw new ReturnControlError('INVALID_ENVELOPE', 'a remote event must be a canonical envelope object');
      // Each declared envelope field is read once: an own getter must not be able to pass validation as
      // the recorded executor and then project a foreign device, an unknown channel or another sequence.
      const originRef = event.origin_device_ref;
      const sequence = event.sequence;
      const channel = event.channel;
      const rawPayload = event.payload ?? null;
      if (!isText(originRef) || !Number.isSafeInteger(sequence)) {
        throw new ReturnControlError('INVALID_ENVELOPE', 'a remote event needs origin_device_ref and sequence');
      }
      if (originRef !== job.execution_device_ref) throw new ReturnControlError('INVALID_ENVELOPE', 'the event did not come from the recorded executor');
      if (!RETURN_CHANNELS.includes(channel)) throw new ReturnControlError('INVALID_ENVELOPE', `unknown return channel ${String(channel)}`);
      // Everything is validated before the ledger, the sequence or the delivery target move: an
      // uncloneable payload must not consume the sequence and silently lose the event.
      let payload;
      try {
        payload = clone(rawPayload);
      } catch (error) {
        throw new ReturnControlError('INVALID_ENVELOPE', `the return payload is not a transferable structure (${error?.message ?? 'uncloneable'})`);
      }
      const at = callerInstant(when, 'at');
      // A hardware-bound action stays blocked: reporting SUCCEEDED past it would be a fabricated success.
      if (job.blocking_state === 'PHYSICAL_ACTION_REQUIRED' && channel === 'RESULT' && isPlainObject(payload) && payload.status === 'SUCCEEDED') {
        throw new ReturnControlError('PHYSICAL_ACTION_CANNOT_SUCCEED', `job ${jobRef} is blocked on a physical action, so a SUCCEEDED result cannot be applied`);
      }
      // The user may have moved to another surface; the control plane follows them — onto a surface that
      // was resolved for this owner, never onto a device the caller merely names. It is admitted here and
      // adopted only for an event that is actually applied, so a refused replay moves nothing.
      const admittedSurface = admitInteractionSurface(job.owner_ref, interactionSurface);
      if (sequence <= job.last_sequence) {
        job.ledger.push({ sequence, channel, result: 'STALE_EVENT' });
        return { applied: false, reason: 'STALE_EVENT', delivered_to: job.interaction_device_ref };
      }
      if (job.ledger.some(entry => entry.sequence === sequence && entry.channel === channel)) {
        job.ledger.push({ sequence, channel, result: 'DUPLICATE_EVENT' });
        return { applied: false, reason: 'DUPLICATE_EVENT', delivered_to: job.interaction_device_ref };
      }
      if (admittedSurface !== null) {
        job.interaction_device_ref = admittedSurface.device_ref;
        job.authorised_device_refs = [...admittedSurface.authorised_device_refs];
      }
      job.last_sequence = sequence;
      const returned = {
        job_ref: jobRef,
        channel,
        sequence,
        // The two facts that make the invariant checkable.
        delivered_to_device_ref: job.interaction_device_ref,
        origin_device_ref: originRef,
        requires_remote_host_interaction: false,
        owner_ref: job.owner_ref,
        executor_device_ref: job.execution_device_ref,
        payload,
        at,
      };
      job.ledger.push({ sequence, channel, result: 'APPLIED' });
      job.returns.push(returned);
      return { applied: true, reason: 'APPLIED', returned: clone(returned) };
    },

    /**
     * Control from any authorised interaction device, applied once. A RESPOND carries the actual reply to
     * the originating worker through the port's respond path — the worker is the point of the reply.
     */
    applyControl(jobRef, { command, fromDeviceRef, commandId, attentionId = null, response = undefined, at: when = clock() } = {}) {
      const job = requireJob(jobRef);
      if (!CONTROL_COMMANDS.includes(command)) throw new ReturnControlError('INVALID_REQUEST', `unknown control command ${String(command)}`);
      // Without an idempotency key two different commands are indistinguishable, and the second would be
      // reported as an already-applied duplicate of the first.
      if (!isText(commandId)) throw new ReturnControlError('INVALID_REQUEST', 'a control command needs a commandId so a retry is distinguishable from a new command');
      if (!job.authorised_device_refs.includes(fromDeviceRef)) throw new ReturnControlError('UNAUTHORIZED_INTERACTION_DEVICE', `${String(fromDeviceRef)} is not an authorised interaction device for ${jobRef}`);
      const at = callerInstant(when, 'at');
      if (job.control_applied.includes(commandId)) return { applied: false, idempotent: true, command, command_id: commandId, delivered_to_executor: job.execution_device_ref };
      let replyPayload = null;
      if (command === 'RESPOND') {
        if (!isText(attentionId)) throw new ReturnControlError('INVALID_REQUEST', 'a RESPOND control needs the attention_id it answers');
        if (response === undefined || response === null) throw new ReturnControlError('INVALID_REQUEST', 'a RESPOND control needs the response it carries back to the originating worker');
        if (typeof port.respond !== 'function') throw new ReturnControlError('INVALID_REQUEST', 'the execution port cannot deliver an attention reply');
        const delivered = port.respond({ job_ref: jobRef, attention_id: attentionId, response: clone(response) });
        if (refusedByPort(delivered, 'accepted')) {
          throw new ReturnControlError('CONTROL_ALREADY_APPLIED', `the executor did not accept the reply to ${attentionId} (${String(delivered.reason ?? 'refused')})`);
        }
        replyPayload = { control: command, command_id: commandId, attention_id: attentionId, response: clone(response) };
      } else {
        const accepted = port.control({ job_ref: jobRef, command });
        if (refusedByPort(accepted, 'accepted')) {
          throw new ReturnControlError('CONTROL_ALREADY_APPLIED', `the executor did not accept ${command} (${String(accepted.reason ?? 'refused')})`);
        }
        replyPayload = { control: command, command_id: commandId };
      }
      job.control_applied.push(commandId);
      job.returns.push({
        job_ref: jobRef, channel: 'EVENT', sequence: job.last_sequence, delivered_to_device_ref: job.interaction_device_ref,
        origin_device_ref: job.execution_device_ref, requires_remote_host_interaction: false, owner_ref: job.owner_ref,
        executor_device_ref: job.execution_device_ref, payload: replyPayload, at,
      });
      return { applied: true, idempotent: false, command, command_id: commandId, delivered_to_executor: job.execution_device_ref, owner_preserved: true };
    },

    /**
     * The invariant as an assertion: a flow that would need the user to operate the remote host is refused.
     * The check is bound to the execution host and to a real delivery target, so it neither goes stale when
     * the user moves surface nor passes a return that reached nobody.
     */
    assertNoRemoteHostInteraction(jobRef) {
      const job = requireJob(jobRef);
      const offenders = job.returns.filter(entry => entry.requires_remote_host_interaction === true
        || (entry.channel === 'ATTENTION' && (!isText(entry.delivered_to_device_ref) || entry.delivered_to_device_ref === job.execution_device_ref)));
      if (offenders.length) {
        throw new ReturnControlError('REMOTE_HOST_INTERACTION_REQUIRED', `${offenders.length} return(s) would require operating ${job.execution_device_ref}`);
      }
      return { job_ref: jobRef, normal_operation_remote_free: true, returns_checked: job.returns.length, remote_desktop_video_required: false };
    },

    /** A hardware-bound action is a typed blocker, never a success — and the job stays observably blocked. */
    recordPhysicalActionRequired(jobRef, { detail, at: when = clock() } = {}) {
      const job = requireJob(jobRef);
      const at = callerInstant(when, 'at');
      job.blocking_state = 'PHYSICAL_ACTION_REQUIRED';
      const returned = {
        job_ref: jobRef, channel: 'ATTENTION', sequence: job.last_sequence, delivered_to_device_ref: job.interaction_device_ref,
        origin_device_ref: job.execution_device_ref, requires_remote_host_interaction: false, owner_ref: job.owner_ref,
        executor_device_ref: job.execution_device_ref,
        payload: { blocking_state: 'PHYSICAL_ACTION_REQUIRED', detail: isText(detail) ? detail : null, fabricated_success: false },
        at,
      };
      job.returns.push(returned);
      return clone(returned);
    },

    /** Stage context semantically: digests and references, never opaque bulk bytes, within the stated bound. */
    stageContext(jobRef, { entries = [] } = {}) {
      requireJob(jobRef);
      if (!Array.isArray(entries) || entries.length > MAX_STAGED_CONTEXT_ENTRIES) {
        throw new ReturnControlError('INVALID_REQUEST', `context staging is bounded to ${MAX_STAGED_CONTEXT_ENTRIES} entries, got ${Array.isArray(entries) ? entries.length : String(entries)}`);
      }
      const staged = entries.map((entry, index) => {
        if (!isPlainObject(entry)) throw new ReturnControlError('INVALID_REQUEST', `staged entry ${index} must be an object`);
        // Read each staged field once: an accessor must not be able to pass the digest check and then be
        // stored as something else.
        const ref = entry.ref;
        const digest = entry.digest;
        const cleanup = entry.cleanup ?? 'AFTER_RESULT';
        if (!isText(ref) || !digestPattern.test(String(digest))) {
          throw new ReturnControlError('INVALID_REQUEST', `staged entry ${index} needs a ref and a sha256 digest`);
        }
        if (!CONTEXT_CLEANUP_POLICIES.includes(cleanup)) {
          throw new ReturnControlError('INVALID_REQUEST', `staged entry ${index} declares ${String(cleanup)} as its cleanup policy; expected one of ${CONTEXT_CLEANUP_POLICIES.join(', ')}`);
        }
        return { ref, digest, cleanup, bounded: true };
      });
      return Object.freeze({ job_ref: jobRef, staged: Object.freeze(staged.map(Object.freeze)), opaque_bulk_transfer: false, max_entries: MAX_STAGED_CONTEXT_ENTRIES });
    },

    status(jobRef) {
      const job = requireJob(jobRef);
      return Object.freeze({
        job_ref: jobRef,
        owner_ref: job.owner_ref,
        execution_device_ref: job.execution_device_ref,
        interaction_device_ref: job.interaction_device_ref,
        executor_kind: job.executor_kind,
        owner_preserved: job.owner_preserved,
        blocking_state: job.blocking_state ?? null,
        applied_returns: job.returns.length,
        stale_or_duplicate: job.ledger.filter(entry => entry.result !== 'APPLIED').length,
        control_applied: job.control_applied.length,
      });
    },
  };

  return Object.freeze(bridge);
}
