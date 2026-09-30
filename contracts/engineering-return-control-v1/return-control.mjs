// Remote Sub-worker execution + automatic return/control (EM-007).
//
// CONTROL PLANE follows the user; EXECUTION PLANE may move to another device. Once a fallback is
// approved, the remote host becomes the current *executor*, never a new owner, and every normal artefact
// of the work — state, progress, logs, attention, result, artifacts — returns through canonical/shared
// state to the user's **current authorised interaction surface**, so normal work never requires walking
// to the remote host or watching remote-desktop video.
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

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

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
    respond({ job_ref, attention_id, response }) { return { job_ref, attention_id, response, accepted: true }; },
    collectArtifacts({ job_ref }) { return { job_ref, artifacts: [] }; },
    __dispatched: dispatched,
    __controls: controls,
  });
}

/** The control plane resolves to the user's *current* authorised surface, wherever execution runs. */
export function resolveInteractionSurface({ ownerRef, devices = [] } = {}) {
  if (!isText(ownerRef)) throw new ReturnControlError('INVALID_REQUEST', 'ownerRef is required');
  const usable = devices.filter(device => isPlainObject(device) && isText(device.device_ref) && device.authorized === true && device.online === true);
  // Two devices claiming to be the current surface is an input error, not a tie to break: picking one
  // arbitrarily would decide where the user's control plane is.
  const claimedCurrent = usable.filter(device => device.is_current === true);
  if (claimedCurrent.length > 1) throw new ReturnControlError('INVALID_REQUEST', claimedCurrent.map(device => device.device_ref).join(', ') + ' all claim to be the current interaction surface');
  const current = usable.filter(device => device.is_current === true).sort((left, right) => left.device_ref.localeCompare(right.device_ref))[0]
    ?? usable.sort((left, right) => String(right.last_interacted_at ?? '').localeCompare(String(left.last_interacted_at ?? '')))[0]
    ?? null;
  return Object.freeze({
    owner_ref: ownerRef,
    interaction_device_ref: current?.device_ref ?? null,
    authorised_device_refs: Object.freeze(usable.map(device => device.device_ref).sort()),
    resolved_from: current?.is_current === true ? 'CURRENT_SURFACE' : (current ? 'MOST_RECENT_AUTHORISED' : 'NONE'),
  });
}

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
     * the host becomes the current executor only.
     */
    dispatch({ job, proposal, executionDeviceRef, interactionSurface, at = clock() } = {}) {
      if (!isPlainObject(job) || !isText(job.job_ref) || !isText(job.owner_ref)) throw new ReturnControlError('INVALID_REQUEST', 'a job with job_ref and owner_ref is required');
      // V1: a remote dispatch always carries an approved proposal.
      if (!isPlainObject(proposal) || proposal.status !== 'APPROVED' || proposal.job_ref !== job.job_ref) {
        throw new ReturnControlError('APPROVED_PROPOSAL_REQUIRED', `job ${job.job_ref} needs an approved fallback proposal`);
      }
      if (proposal.owner_ref !== undefined && proposal.owner_ref !== job.owner_ref) {
        throw new ReturnControlError('OWNER_CHANGE_FORBIDDEN', 'a fallback proposal may not change the logical owner');
      }
      const eligible = port.listEligibleRemoteHosts({ requiredCapabilities: job.required_capabilities ?? [] });
      if (!eligible.some(host => host.host_ref === executionDeviceRef || host.device_ref === executionDeviceRef)) {
        throw new ReturnControlError('INELIGIBLE_REMOTE_HOST', `${String(executionDeviceRef)} does not satisfy the required capabilities`);
      }
      port.dispatch({ job_ref: job.job_ref, execution_device_ref: executionDeviceRef, execution_spec: { job_ref: job.job_ref, owner_ref: job.owner_ref } });
      const record = {
        job_ref: job.job_ref,
        owner_ref: job.owner_ref,
        execution_device_ref: executionDeviceRef,
        interaction_device_ref: interactionSurface?.interaction_device_ref ?? null,
        authorised_device_refs: [...(interactionSurface?.authorised_device_refs ?? [])],
        executor_kind: 'REMOTE',
        owner_preserved: true,
        last_sequence: 0,
        ledger: [],
        returns: [],
        control_applied: [],
        started_at: at ?? null,
      };
      jobs.set(job.job_ref, record);
      return clone(record);
    },

    /**
     * Return one remote envelope to the interaction surface. Every channel returns: whatever the remote
     * host produced is projected to the user's current surface, not to the execution device.
     */
    applyRemoteEvent(jobRef, event, { interactionSurface = null, at = clock() } = {}) {
      const job = requireJob(jobRef);
      if (!isPlainObject(event) || !isText(event.origin_device_ref) || !Number.isSafeInteger(event.sequence)) {
        throw new ReturnControlError('INVALID_ENVELOPE', 'a remote event needs origin_device_ref and sequence');
      }
      if (event.origin_device_ref !== job.execution_device_ref) throw new ReturnControlError('INVALID_ENVELOPE', 'the event did not come from the recorded executor');
      if (!RETURN_CHANNELS.includes(event.channel)) throw new ReturnControlError('INVALID_ENVELOPE', `unknown return channel ${String(event.channel)}`);
      // The user may have moved to another surface; the control plane follows them.
      if (interactionSurface?.interaction_device_ref) job.interaction_device_ref = interactionSurface.interaction_device_ref;
      if (event.sequence <= job.last_sequence) {
        job.ledger.push({ sequence: event.sequence, channel: event.channel, result: 'STALE_EVENT' });
        return { applied: false, reason: 'STALE_EVENT', delivered_to: job.interaction_device_ref };
      }
      if (job.ledger.some(entry => entry.sequence === event.sequence && entry.channel === event.channel)) {
        job.ledger.push({ sequence: event.sequence, channel: event.channel, result: 'DUPLICATE_EVENT' });
        return { applied: false, reason: 'DUPLICATE_EVENT', delivered_to: job.interaction_device_ref };
      }
      job.last_sequence = event.sequence;
      const returned = {
        job_ref: jobRef,
        channel: event.channel,
        sequence: event.sequence,
        // The two facts that make the invariant checkable.
        delivered_to_device_ref: job.interaction_device_ref,
        origin_device_ref: event.origin_device_ref,
        requires_remote_host_interaction: false,
        owner_ref: job.owner_ref,
        executor_device_ref: job.execution_device_ref,
        payload: clone(event.payload ?? null),
        at: at ?? null,
      };
      job.ledger.push({ sequence: event.sequence, channel: event.channel, result: 'APPLIED' });
      job.returns.push(returned);
      return { applied: true, reason: 'APPLIED', returned: clone(returned) };
    },

    /** Control from any authorised interaction device, applied once. */
    applyControl(jobRef, { command, fromDeviceRef, commandId, at = clock() } = {}) {
      const job = requireJob(jobRef);
      if (!CONTROL_COMMANDS.includes(command)) throw new ReturnControlError('INVALID_REQUEST', `unknown control command ${String(command)}`);
      if (!job.authorised_device_refs.includes(fromDeviceRef)) throw new ReturnControlError('UNAUTHORIZED_INTERACTION_DEVICE', `${String(fromDeviceRef)} is not an authorised interaction device for ${jobRef}`);
      if (job.control_applied.includes(commandId)) return { applied: false, idempotent: true, command, delivered_to_executor: job.execution_device_ref };
      port.control({ job_ref: jobRef, command });
      job.control_applied.push(commandId);
      job.returns.push({
        job_ref: jobRef, channel: 'EVENT', sequence: job.last_sequence, delivered_to_device_ref: job.interaction_device_ref,
        origin_device_ref: job.execution_device_ref, requires_remote_host_interaction: false, owner_ref: job.owner_ref,
        executor_device_ref: job.execution_device_ref, payload: { control: command, command_id: commandId }, at: at ?? null,
      });
      return { applied: true, idempotent: false, command, delivered_to_executor: job.execution_device_ref, owner_preserved: true };
    },

    /**
     * The invariant as an assertion: a flow that would need the user to operate the remote host is refused.
     */
    assertNoRemoteHostInteraction(jobRef) {
      const job = requireJob(jobRef);
      const offenders = job.returns.filter(entry => entry.requires_remote_host_interaction === true || (entry.channel === 'ATTENTION' && entry.delivered_to_device_ref !== job.interaction_device_ref));
      if (offenders.length) {
        throw new ReturnControlError('REMOTE_HOST_INTERACTION_REQUIRED', `${offenders.length} return(s) would require operating ${job.execution_device_ref}`);
      }
      return { job_ref: jobRef, normal_operation_remote_free: true, returns_checked: job.returns.length, remote_desktop_video_required: false };
    },

    /** A hardware-bound action is a typed blocker, never a success. */
    recordPhysicalActionRequired(jobRef, { detail, at = clock() } = {}) {
      const job = requireJob(jobRef);
      const returned = {
        job_ref: jobRef, channel: 'ATTENTION', sequence: job.last_sequence, delivered_to_device_ref: job.interaction_device_ref,
        origin_device_ref: job.execution_device_ref, requires_remote_host_interaction: false, owner_ref: job.owner_ref,
        executor_device_ref: job.execution_device_ref,
        payload: { blocking_state: 'PHYSICAL_ACTION_REQUIRED', detail: isText(detail) ? detail : null, fabricated_success: false },
        at: at ?? null,
      };
      job.returns.push(returned);
      return clone(returned);
    },

    /** Stage context semantically: digests and references, never opaque bulk bytes. */
    stageContext(jobRef, { entries = [] } = {}) {
      requireJob(jobRef);
      const staged = entries.map((entry, index) => {
        if (!isPlainObject(entry) || !isText(entry.ref) || !/^sha256:[0-9a-f]{64}$/.test(String(entry.digest))) {
          throw new ReturnControlError('INVALID_REQUEST', `staged entry ${index} needs a ref and a sha256 digest`);
        }
        return { ref: entry.ref, digest: entry.digest, bounded: true, cleanup: entry.cleanup ?? 'AFTER_RESULT' };
      });
      return Object.freeze({ job_ref: jobRef, staged: Object.freeze(staged.map(Object.freeze)), opaque_bulk_transfer: false, max_entries: 64 });
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
        applied_returns: job.returns.length,
        stale_or_duplicate: job.ledger.filter(entry => entry.result !== 'APPLIED').length,
        control_applied: job.control_applied.length,
      });
    },
  };

  return Object.freeze(bridge);
}
