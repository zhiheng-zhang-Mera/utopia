// Embodiment registry and foreground binding (BA-003).
//
// One logical assistant may inhabit many devices, and one device may hold **at most one
// foreground interaction assistant**. Foreground binding is a device-interaction fact: it is not
// task ownership, not an execution lease, and not a background-worker state. Switching it
// releases device-local context and moves nothing else.
//
// The registry never mutates task ownership. It reaches tasks only through an external port, so
// "switching foreground does not create a handoff" is structural rather than a promise.
import {
  EMBODIMENT_CONTRACT_VERSION, EmbodimentError, assertEmbodimentDescriptor, isIsoInstant
} from './descriptors.mjs';

/** Types of device-local context. All of them are caches, none of them is authoritative. */
export const LOCAL_STATE_KINDS = Object.freeze(['SENSORY_CONTEXT', 'UI_TRANSIENT', 'LOCAL_SCRATCH']);
/** Where a foreground binding came from, so a recovered binding is distinguishable from a live one. */
export const BINDING_SOURCES = Object.freeze(['LIVE_SESSION', 'RESTORED_FROM_AUTHORITY']);

/**
 * The task-facing seam. Butler does not own task truth, so the registry can only *observe*
 * ownership and executor/lease validity through this port. There is deliberately no method that
 * could move ownership, cancel work or reassign an executor.
 */
export const TASK_OBSERVATION_PORT = Object.freeze({
  interface: 'TaskObservationPort',
  version: 1,
  methods: Object.freeze(['listTasksOwnedBy', 'describeExecutor', 'isLeaseValid', 'isCapabilityAvailable']),
  may_mutate_ownership: false,
  may_cancel: false,
  may_reassign_executor: false,
});

export function createDeterministicTaskObservationDouble({ tasks = [] } = {}) {
  const calls = [];
  const record = (method, args) => { calls.push({ method, args }); };
  const table = new Map(tasks.map(task => [task.task_ref, { ...task }]));
  return Object.freeze({
    listTasksOwnedBy(assistantRef) {
      record('listTasksOwnedBy', { assistantRef });
      return [...table.values()].filter(task => task.owner_ref === assistantRef).map(task => ({ ...task }));
    },
    describeExecutor(taskRef) {
      record('describeExecutor', { taskRef });
      const task = table.get(taskRef);
      if (!task) throw new EmbodimentError('UNKNOWN_TASK', String(taskRef));
      return { task_ref: taskRef, executor_ref: task.executor_ref, lease_ref: task.lease_ref ?? null, capability_ref: task.capability_ref ?? null };
    },
    isLeaseValid(taskRef) { record('isLeaseValid', { taskRef }); return table.get(taskRef)?.lease_valid === true; },
    isCapabilityAvailable(taskRef) { record('isCapabilityAvailable', { taskRef }); return table.get(taskRef)?.capability_available === true; },
    /** Observation log, so a test can prove no ownership-mutating call was ever made. */
    __calls: calls,
    __setTask(taskRef, patch) { const task = table.get(taskRef); if (!task) throw new EmbodimentError('UNKNOWN_TASK', String(taskRef)); Object.assign(task, patch); },
  });
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));

export function createEmbodimentRegistry({ clock = () => null, taskObservation = createDeterministicTaskObservationDouble() } = {}) {
  const embodiments = new Map();
  const attachments = new Map();
  const foreground = new Map();
  const localState = new Map();
  let bindingCounter = 0;

  const requireEmbodiment = embodimentRef => {
    const entry = embodiments.get(embodimentRef);
    if (!entry) throw new EmbodimentError('UNKNOWN_EMBODIMENT', String(embodimentRef));
    return entry;
  };
  const attachmentKey = (assistantRef, embodimentRef) => `${assistantRef}\u0000${embodimentRef}`;
  const requireAttachment = (assistantRef, embodimentRef) => {
    if (!attachments.has(attachmentKey(assistantRef, embodimentRef))) {
      throw new EmbodimentError('ASSISTANT_NOT_ATTACHED', `${assistantRef} is not attached to ${embodimentRef}`);
    }
  };
  const localKey = embodimentRef => `local\u0000${embodimentRef}`;

  /**
   * Write a foreground binding. Switching releases device-local context: it belonged to the
   * outgoing interaction session and must not be inherited by the incoming assistant.
   */
  const setForegroundInternal = (embodimentRef, assistantRef, at) => {
    bindingCounter += 1;
    localState.delete(localKey(embodimentRef));
    const binding = {
      binding_ref: `foreground-${bindingCounter}`,
      embodiment_ref: embodimentRef,
      assistant_ref: assistantRef,
      bound_at: at ?? null,
      source: 'LIVE_SESSION',
      is_task_ownership: false,
      is_execution_lease: false,
    };
    foreground.set(embodimentRef, binding);
    return binding;
  };

  const registry = {
    get contractVersion() { return EMBODIMENT_CONTRACT_VERSION; },

    // ---- embodiment descriptors ------------------------------------------
    registerEmbodiment(descriptor) {
      assertEmbodimentDescriptor(descriptor);
      const existing = embodiments.get(descriptor.embodiment_ref);
      if (existing) {
        if (existing.descriptor.device_identity_ref?.device_id
          && descriptor.device_identity_ref?.device_id
          && existing.descriptor.device_identity_ref.device_id !== descriptor.device_identity_ref.device_id) {
          throw new EmbodimentError('EMBODIMENT_DEVICE_MISMATCH', `${descriptor.embodiment_ref} is already bound to another device identity`);
        }
        // Re-registration is idempotent: a device may refresh its descriptor without losing bindings.
        existing.descriptor = clone(descriptor);
        return { embodiment_ref: descriptor.embodiment_ref, registered: true, refreshed: true };
      }
      if (descriptor.device_identity_ref?.device_id) {
        for (const entry of embodiments.values()) {
          if (entry.descriptor.device_identity_ref?.device_id === descriptor.device_identity_ref.device_id) {
            throw new EmbodimentError('DUPLICATE_DEVICE_IDENTITY', `device ${descriptor.device_identity_ref.device_id} is already the embodiment ${entry.descriptor.embodiment_ref}`);
          }
        }
      }
      embodiments.set(descriptor.embodiment_ref, { descriptor: clone(descriptor), registeredAt: descriptor.registered_at, revision: 1 });
      return { embodiment_ref: descriptor.embodiment_ref, registered: true, refreshed: false };
    },

    getDescriptor(embodimentRef) { return clone(requireEmbodiment(embodimentRef).descriptor); },
    listEmbodiments() { return [...embodiments.values()].map(entry => clone(entry.descriptor)).sort((a, b) => a.embodiment_ref.localeCompare(b.embodiment_ref)); },

    // ---- assistant ↔ device attachment (many-to-many) ---------------------
    // Several assistants may be present on one device, and one assistant may inhabit many
    // devices. Attachment is presence, not foreground authority and not task ownership.
    attachAssistant(assistantRef, embodimentRef, { sessionRef = null } = {}) {
      requireEmbodiment(embodimentRef);
      if (!isText(assistantRef)) throw new EmbodimentError('INVALID_ASSISTANT_REF', String(assistantRef));
      const key = attachmentKey(assistantRef, embodimentRef);
      const existing = attachments.get(key);
      if (existing) return { ...clone(existing), idempotent: true };
      const attachment = { assistant_ref: assistantRef, embodiment_ref: embodimentRef, session_ref: sessionRef ?? null, attached_at: clock() ?? null };
      attachments.set(key, attachment);
      return { ...clone(attachment), idempotent: false };
    },

    detachAssistant(assistantRef, embodimentRef) {
      requireEmbodiment(embodimentRef);
      const key = attachmentKey(assistantRef, embodimentRef);
      const existed = attachments.delete(key);
      if (foreground.get(embodimentRef)?.assistant_ref === assistantRef) {
        // Detaching the foreground assistant releases the binding: a device must not keep a
        // foreground assistant it is no longer attached to.
        foreground.delete(embodimentRef);
        localState.delete(localKey(embodimentRef));
      }
      return { assistant_ref: assistantRef, embodiment_ref: embodimentRef, detached: existed };
    },

    listDevicesForAssistant(assistantRef) {
      return [...attachments.values()].filter(entry => entry.assistant_ref === assistantRef)
        .map(entry => entry.embodiment_ref).sort();
    },
    listAssistantsForDevice(embodimentRef) {
      requireEmbodiment(embodimentRef);
      return [...attachments.values()].filter(entry => entry.embodiment_ref === embodimentRef)
        .map(entry => entry.assistant_ref).sort();
    },

    // ---- foreground binding ----------------------------------------------
    // At most one foreground assistant per device. Two ways to change it: `bindForeground`
    // refuses when the device already has one, `switchForeground` performs an explicit handover.
    bindForeground(embodimentRef, { assistantRef, at = clock() } = {}) {
      requireEmbodiment(embodimentRef);
      requireAttachment(assistantRef, embodimentRef);
      const current = foreground.get(embodimentRef);
      if (current) {
        throw new EmbodimentError('FOREGROUND_ALREADY_BOUND', `${embodimentRef} already has foreground assistant ${current.assistant_ref}; switch explicitly instead`);
      }
      return clone(setForegroundInternal(embodimentRef, assistantRef, at));
    },

    switchForeground(embodimentRef, { assistantRef, expectedForegroundRef = undefined, at = clock() } = {}) {
      requireEmbodiment(embodimentRef);
      requireAttachment(assistantRef, embodimentRef);
      const current = foreground.get(embodimentRef) ?? null;
      if (expectedForegroundRef !== undefined && (current?.assistant_ref ?? null) !== expectedForegroundRef) {
        // A caller acting on a stale view must not silently take the device over.
        throw new EmbodimentError('FOREGROUND_MISMATCH', `device ${embodimentRef} foreground is ${current?.assistant_ref ?? 'none'}, not ${expectedForegroundRef}`);
      }
      if (current?.assistant_ref === assistantRef) {
        return { ...clone(current), switched: false, idempotent: true, released_local_state_for: null };
      }
      const previous = current?.assistant_ref ?? null;
      const binding = setForegroundInternal(embodimentRef, assistantRef, at);
      return { ...clone(binding), switched: true, idempotent: false, released_local_state_for: previous };
    },


    releaseForeground(embodimentRef, { assistantRef = undefined } = {}) {
      requireEmbodiment(embodimentRef);
      const current = foreground.get(embodimentRef);
      if (!current) return { embodiment_ref: embodimentRef, released: false };
      if (assistantRef !== undefined && current.assistant_ref !== assistantRef) {
        throw new EmbodimentError('FOREGROUND_MISMATCH', `${embodimentRef} foreground is ${current.assistant_ref}, not ${assistantRef}`);
      }
      foreground.delete(embodimentRef);
      localState.delete(localKey(embodimentRef));
      return { embodiment_ref: embodimentRef, released: true, released_assistant_ref: current.assistant_ref };
    },

    getForeground(embodimentRef) {
      requireEmbodiment(embodimentRef);
      return clone(foreground.get(embodimentRef) ?? null);
    },

    /** The invariant, checked across every device at once. */
    assertSingleForegroundPerDevice() {
      const counts = new Map();
      for (const binding of foreground.values()) counts.set(binding.embodiment_ref, (counts.get(binding.embodiment_ref) ?? 0) + 1);
      for (const [embodimentRef, count] of counts) {
        if (count > 1) throw new EmbodimentError('FOREGROUND_INVARIANT_VIOLATED', `${embodimentRef} has ${count} foreground assistants`);
      }
      return { devices: counts.size, ok: true };
    },

    // ---- device-local context (never authoritative) ----------------------
    setLocalState(embodimentRef, { kind, value, at = clock() } = {}) {
      requireEmbodiment(embodimentRef);
      if (!LOCAL_STATE_KINDS.includes(kind)) throw new EmbodimentError('UNKNOWN_LOCAL_STATE_KIND', String(kind));
      const key = localKey(embodimentRef);
      const bucket = localState.get(key) ?? {};
      bucket[kind] = { value: clone(value), at: at ?? null };
      localState.set(key, bucket);
      return { embodiment_ref: embodimentRef, kind, at: at ?? null, authoritative: false };
    },

    getLocalState(embodimentRef) {
      requireEmbodiment(embodimentRef);
      return clone(localState.get(localKey(embodimentRef)) ?? {});
    },

    clearLocalState(embodimentRef) {
      requireEmbodiment(embodimentRef);
      const existed = localState.delete(localKey(embodimentRef));
      return { embodiment_ref: embodimentRef, cleared: existed };
    },

    // ---- background continuity -------------------------------------------
    // Foreground is a device-interaction fact; background work continues when its executor,
    // lease and capability remain valid. Nothing here can move or cancel it.
    backgroundContinuity(assistantRef) {
      if (!isText(assistantRef)) throw new EmbodimentError('INVALID_ASSISTANT_REF', String(assistantRef));
      const tasks = taskObservation.listTasksOwnedBy(assistantRef);
      return tasks.map(task => {
        const leaseValid = taskObservation.isLeaseValid(task.task_ref) === true;
        const capabilityAvailable = taskObservation.isCapabilityAvailable(task.task_ref) === true;
        const executor = taskObservation.describeExecutor(task.task_ref);
        const continues = leaseValid && capabilityAvailable;
        return Object.freeze({
          task_ref: task.task_ref,
          owner_ref: task.owner_ref,
          executor_ref: executor.executor_ref,
          continues,
          reason: continues ? 'EXECUTOR_LEASE_CAPABILITY_VALID' : 'CONTINUITY_PRECONDITION_FAILED',
          cancelled_by_foreground_switch: false,
          ownership_changed_by_foreground_switch: false,
        });
      }).sort((a, b) => a.task_ref.localeCompare(b.task_ref));
    },

    // ---- restart / recovery ----------------------------------------------
    // Durable binding state only. Device-local context is absent by construction, so recovery
    // cannot resurrect a previous session's local assumptions.
    snapshot() {
      return {
        embodiment_contract_version: EMBODIMENT_CONTRACT_VERSION,
        embodiments: [...embodiments.values()].map(entry => ({ descriptor: clone(entry.descriptor), revision: entry.revision })).sort((a, b) => a.descriptor.embodiment_ref.localeCompare(b.descriptor.embodiment_ref)),
        attachments: [...attachments.values()].map(clone).sort((a, b) => (a.assistant_ref + a.embodiment_ref).localeCompare(b.assistant_ref + b.embodiment_ref)),
        foreground: [...foreground.values()].map(clone).sort((a, b) => a.embodiment_ref.localeCompare(b.embodiment_ref)),
      };
    },

    /**
     * A device that reconnects must revalidate against authoritative binding state. Its own
     * belief about who is foreground is a cache; when it disagrees with authority the local
     * belief is refused and the authoritative binding is returned instead.
     */
    revalidateEmbodiment(embodimentRef, { assistantRef = null, localBindingRef = null, at = clock() } = {}) {
      requireEmbodiment(embodimentRef);
      const authoritative = foreground.get(embodimentRef) ?? null;
      const agreed = authoritative !== null && assistantRef !== null && authoritative.assistant_ref === assistantRef;
      let reason;
      if (authoritative === null) reason = 'AUTHORITATIVE_NO_FOREGROUND';
      else if (assistantRef === null) reason = 'LOCAL_SESSION_HAS_NO_FOREGROUND';
      else if (!agreed) reason = 'STALE_LOCAL_BINDING';
      else if (localBindingRef !== null && localBindingRef !== authoritative.binding_ref) reason = 'STALE_LOCAL_BINDING';
      else reason = 'AUTHORITATIVE_AGREEMENT';
      if (!agreed || (localBindingRef !== null && localBindingRef !== authoritative.binding_ref)) {
        // Clear the stale local context: it belonged to a session authority no longer recognises.
        localState.delete(localKey(embodimentRef));
        return { ok: false, reason, authoritative_binding: clone(authoritative), revalidated_at: at ?? null };
      }
      return { ok: true, reason, authoritative_binding: clone(authoritative), revalidated_at: at ?? null };
    },
  };

  return Object.freeze(registry);
}

/**
 * Rebuild a registry from authoritative binding state. Foreground bindings come back as
 * `RESTORED_FROM_AUTHORITY` and every device must revalidate before it may act, so a restarted
 * host never continues from its own stale local assumptions.
 */
export function restoreEmbodimentRegistry(snapshot, { clock = () => null, taskObservation = createDeterministicTaskObservationDouble() } = {}) {
  if (!isPlainObject(snapshot) || snapshot.embodiment_contract_version !== EMBODIMENT_CONTRACT_VERSION
    || !Array.isArray(snapshot.embodiments) || !Array.isArray(snapshot.attachments) || !Array.isArray(snapshot.foreground)) {
    throw new EmbodimentError('INCOMPATIBLE_EMBODIMENT_SNAPSHOT', 'embodiment_contract_version, embodiments, attachments and foreground are required');
  }
  for (const entry of snapshot.embodiments) if (!isPlainObject(entry?.descriptor)) throw new EmbodimentError('INCOMPATIBLE_EMBODIMENT_SNAPSHOT', 'every embodiment entry needs a descriptor');
  for (const binding of snapshot.foreground) if (!isIsoInstant(binding.bound_at ?? '') && binding.bound_at !== null) throw new EmbodimentError('INCOMPATIBLE_EMBODIMENT_SNAPSHOT', 'foreground bound_at must be an instant or null');
  const registry = createEmbodimentRegistry({ clock, taskObservation });
  for (const entry of snapshot.embodiments) registry.registerEmbodiment(entry.descriptor);
  for (const attachment of snapshot.attachments) registry.attachAssistant(attachment.assistant_ref, attachment.embodiment_ref, { sessionRef: attachment.session_ref });
  const restored = [];
  for (const binding of snapshot.foreground) {
    // Restore through the same exclusivity gate, then mark provenance as restored.
    registry.bindForeground(binding.embodiment_ref, { assistantRef: binding.assistant_ref, at: binding.bound_at });
    restored.push({ embodiment_ref: binding.embodiment_ref, assistant_ref: binding.assistant_ref, source: 'RESTORED_FROM_AUTHORITY' });
  }
  return Object.freeze({
    registry,
    restored_foreground: Object.freeze(restored),
    revalidation_required_for: Object.freeze(restored.map(entry => entry.embodiment_ref).sort()),
  });
}
