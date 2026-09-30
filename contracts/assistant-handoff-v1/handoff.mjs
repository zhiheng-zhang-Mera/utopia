// Assistant switching + explicit task handoff (BA-004).
//
// Two operations that are easy to confuse and must never be:
//   SWITCH  — the foreground interaction assistant on ONE device changes. It touches no task.
//   HANDOFF — logical ownership/coordinator responsibility actually moves. It is explicit, carries a
//             checkpoint/evidence package, requires recipient acceptance, and transfers **no**
//             authority: the recipient recomputes its own permission and capability.
// Pure module: no clock, storage, network or ambient state.
export const HANDOFF_CONTRACT_VERSION = 1;

export const HANDOFF_KINDS = Object.freeze(['RESPONSIBILITY_TRANSFER', 'CONSULTATION']);
export const HANDOFF_STATES = Object.freeze(['PROPOSED', 'ACCEPTED', 'REJECTED', 'EXPIRED']);
export const HANDOFF_OUTCOMES = Object.freeze(['ACCEPTED', 'REJECTED', 'EXPIRED']);
export const TERMINAL_TASK_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUSED']);
export const HANDOFF_CODES = Object.freeze([
  'INVALID_HANDOFF', 'UNKNOWN_HANDOFF', 'UNKNOWN_TASK', 'TASK_TERMINAL', 'RECIPIENT_REQUIRED',
  'HANDOFF_TRANSFERS_NO_AUTHORITY', 'AUTHORITY_FIELD_FORBIDDEN', 'RECIPIENT_NOT_ACCEPTED',
  'DUPLICATE_HANDOFF', 'HANDOFF_REJECTED', 'HANDOFF_EXPIRED', 'CHECKPOINT_REQUIRED',
  'SCOPE_WIDENING_FORBIDDEN', 'CONSULTATION_TRANSFERS_NOTHING', 'NOT_THE_RECIPIENT',
]);

export class HandoffError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'HandoffError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = 409;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

/** Fields that would make a handoff an authority transfer. It never is one. */
export const AUTHORITY_FIELDS = Object.freeze([
  'grants', 'permissions', 'permission_grants', 'capabilities', 'capability_grants', 'lease',
  'execution_lease', 'action_key', 'action_keys', 'authority', 'policy', 'policy_grants', 'scopes', 'access_token',
]);

export function findAuthorityFields(value, path = 'handoff', found = []) {
  if (Array.isArray(value)) { value.forEach((item, index) => findAuthorityFields(item, `${path}[${index}]`, found)); return found; }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (AUTHORITY_FIELDS.includes(key)) found.push(childPath);
    findAuthorityFields(child, childPath, found);
  }
  return found;
}

const PARTY_SPEC = { assistant_ref: { required: true, type: 'text' }, device_ref: { required: true, type: 'text', nullable: true } };

export const HANDOFF_SPEC = Object.freeze({
  contract_version: { required: true, type: 'int', constant: HANDOFF_CONTRACT_VERSION },
  handoff_id: { required: true, type: 'text' },
  task_ref: { required: true, type: 'text' },
  task_version: { required: true, type: 'int', min: 1 },
  kind: { required: true, type: 'enum', values: HANDOFF_KINDS },
  from: { required: true, type: 'object' },
  to: { required: true, type: 'object' },
  reason: { required: true, type: 'text' },
  checkpoint_ref: { required: true, type: 'text', nullable: true },
  evidence_refs: { required: true, type: 'array' },
  commitments: { required: true, type: 'array' },
  blocker_refs: { required: true, type: 'array' },
  executor_ref: { required: true, type: 'text', nullable: true },
  lease_ref: { required: true, type: 'text', nullable: true },
  required_capabilities: { required: true, type: 'array' },
  audience_scope: { required: true, type: 'text' },
  created_at: { required: true, type: 'instant' },
});

function checkShape(value, path, spec, errors) {
  if (!isPlainObject(value)) { errors.push(`${path} must be an object`); return; }
  for (const key of Object.keys(value)) if (!(key in spec)) errors.push(`${path}.${key} is not part of the canonical contract`);
  for (const [key, rule] of Object.entries(spec)) {
    const present = Object.hasOwn(value, key);
    if (!present) { if (rule.required) errors.push(`${path}.${key} is required`); continue; }
    const field = value[key];
    const fieldPath = `${path}.${key}`;
    if (field === null || field === undefined) { if (!rule.nullable) errors.push(`${fieldPath} must not be null`); continue; }
    if (rule.type === 'text' && !isText(field)) errors.push(`${fieldPath} must be nonempty text`);
    if (rule.type === 'instant' && !isIsoInstant(field)) errors.push(`${fieldPath} must be an ISO-8601 UTC instant`);
    if (rule.type === 'int' && (!Number.isSafeInteger(field) || field < (rule.min ?? 0))) errors.push(`${fieldPath} must be an integer >= ${rule.min ?? 0}`);
    if (rule.type === 'object' && !isPlainObject(field)) errors.push(`${fieldPath} must be an object`);
    if (rule.type === 'array' && !Array.isArray(field)) errors.push(`${fieldPath} must be an array`);
    if (rule.type === 'enum' && !rule.values.includes(field)) errors.push(`${fieldPath} must be one of ${rule.values.join(', ')}`);
    if (rule.constant !== undefined && field !== rule.constant) errors.push(`${fieldPath} must be ${JSON.stringify(rule.constant)}`);
  }
}

const textArray = (value, path, errors) => {
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => { if (!isText(entry)) errors.push(`${path}[${index}] must be nonempty text`); });
};

export function validateHandoff(handoff) {
  const errors = [];
  checkShape(handoff, 'handoff', HANDOFF_SPEC, errors);
  if (isPlainObject(handoff)) {
    if (isPlainObject(handoff.from)) checkShape(handoff.from, 'handoff.from', PARTY_SPEC, errors);
    if (isPlainObject(handoff.to)) checkShape(handoff.to, 'handoff.to', PARTY_SPEC, errors);
    for (const field of ['evidence_refs', 'commitments', 'blocker_refs', 'required_capabilities']) textArray(handoff[field], `handoff.${field}`, errors);
    if (isPlainObject(handoff.from) && isPlainObject(handoff.to) && handoff.from.assistant_ref === handoff.to.assistant_ref) {
      errors.push('handoff.to.assistant_ref must differ from handoff.from.assistant_ref');
    }
    // The single most important rule: a handoff carries responsibility, never authority.
    for (const found of findAuthorityFields(handoff)) errors.push(`${found} would make this handoff an authority transfer; a handoff transfers responsibility only`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function assertHandoff(handoff) {
  const verdict = validateHandoff(handoff);
  if (!verdict.ok) {
    const code = verdict.errors.some(error => error.includes('authority transfer')) ? 'HANDOFF_TRANSFERS_NO_AUTHORITY' : 'INVALID_HANDOFF';
    throw new HandoffError(code, verdict.errors.slice(0, 3).join('; '));
  }
  return handoff;
}

export function createHandoffPackage(overrides = {}) {
  return {
    contract_version: HANDOFF_CONTRACT_VERSION,
    handoff_id: 'handoff-1',
    task_ref: 'task-1',
    task_version: 4,
    kind: 'RESPONSIBILITY_TRANSFER',
    from: { assistant_ref: 'assistant-butler', device_ref: 'device-phone' },
    to: { assistant_ref: 'assistant-companion', device_ref: 'device-tablet' },
    reason: 'the owner is switching to the companion for this task',
    checkpoint_ref: 'checkpoint-9',
    evidence_refs: ['evidence-1'],
    commitments: ['commitment-1'],
    blocker_refs: [],
    executor_ref: 'device-desktop',
    lease_ref: 'lease-7',
    required_capabilities: ['FILESYSTEM'],
    audience_scope: 'OWNER_PRIVATE',
    created_at: '2026-09-30T12:00:00.000Z',
    ...overrides,
  };
}

/**
 * Recompute the recipient's effective authority. A handoff contributes nothing: the recipient gets the
 * intersection of what the task needs and what policy grants, and a capability the recipient lacks is a
 * refusal rather than a silent downgrade.
 */
export function recomputeRecipientAuthority({ policy, recipientRef, requiredCapabilities = [] }) {
  if (!isPlainObject(policy) || !isPlainObject(policy.grantsByAssistant)) throw new HandoffError('INVALID_HANDOFF', 'policy.grantsByAssistant is required');
  const granted = new Set(policy.grantsByAssistant[recipientRef] ?? []);
  const grantedCapabilities = requiredCapabilities.filter(capability => granted.has(capability));
  const missing = requiredCapabilities.filter(capability => !granted.has(capability));
  return Object.freeze({
    recipient_ref: recipientRef,
    recomputed: true,
    transferred_grants: Object.freeze([]),
    effective_grants: Object.freeze([...granted].sort()),
    granted_capabilities: Object.freeze(grantedCapabilities.sort()),
    missing_capabilities: Object.freeze(missing.sort()),
    can_take_over: missing.length === 0,
  });
}

/** Replaceable seam for the canonical task store; the coordinator never writes task truth itself. */
export const TASK_STORE_PORT = Object.freeze({
  interface: 'CanonicalTaskStorePort',
  version: 1,
  methods: Object.freeze(['getTask', 'setOwner', 'setExecutor', 'recordCheckpoint']),
  handoff_writes_task_truth_directly: false,
});

export function createTaskStoreDouble({ tasks = [] } = {}) {
  const table = new Map(tasks.map(task => [task.task_ref, { ...task }]));
  const writes = [];
  return Object.freeze({
    getTask(taskRef) { const task = table.get(taskRef); return task ? { ...task } : null; },
    setOwner(taskRef, ownerRef) { const task = table.get(taskRef); if (!task) throw new HandoffError('UNKNOWN_TASK', taskRef); writes.push({ op: 'setOwner', taskRef }); task.owner_ref = ownerRef; return { ...task }; },
    setExecutor(taskRef, executorRef) { const task = table.get(taskRef); if (!task) throw new HandoffError('UNKNOWN_TASK', taskRef); writes.push({ op: 'setExecutor', taskRef }); task.executor_ref = executorRef; return { ...task }; },
    recordCheckpoint(taskRef, checkpointRef) { const task = table.get(taskRef); if (!task) throw new HandoffError('UNKNOWN_TASK', taskRef); writes.push({ op: 'recordCheckpoint', taskRef }); task.checkpoint_ref = checkpointRef; return { ...task }; },
    __writes: writes, __table: table,
  });
}

export function createHandoffCoordinator({ taskStore, policy, clock = () => null } = {}) {
  if (!taskStore || typeof taskStore.getTask !== 'function') throw new HandoffError('INVALID_HANDOFF', 'a canonical task store port is required');
  const handoffs = new Map();

  const coordinator = {
    /** Propose a handoff. Nothing changes until the recipient accepts. */
    propose(handoff) {
      assertHandoff(handoff);
      if (handoffs.has(handoff.handoff_id)) {
        return { handoff: clone(handoffs.get(handoff.handoff_id)), proposed: false, reason: 'DUPLICATE_HANDOFF' };
      }
      const task = taskStore.getTask(handoff.task_ref);
      if (!task) throw new HandoffError('UNKNOWN_TASK', handoff.task_ref);
      if (TERMINAL_TASK_STATES.includes(task.state)) throw new HandoffError('TASK_TERMINAL', `task ${handoff.task_ref} is ${task.state}`);
      if (task.owner_ref !== handoff.from.assistant_ref) {
        throw new HandoffError('INVALID_HANDOFF', `task ${handoff.task_ref} is owned by ${task.owner_ref}, not ${handoff.from.assistant_ref}`);
      }
      if (handoff.kind === 'RESPONSIBILITY_TRANSFER' && (handoff.checkpoint_ref === null || handoff.checkpoint_ref === undefined)) {
        throw new HandoffError('CHECKPOINT_REQUIRED', 'a responsibility transfer must carry a checkpoint so the recipient can continue');
      }
      const record = {
        handoff: clone(handoff),
        state: 'PROPOSED',
        proposed_at: clock() ?? null,
        authority: recomputeRecipientAuthority({ policy, recipientRef: handoff.to.assistant_ref, requiredCapabilities: handoff.required_capabilities }),
      };
      handoffs.set(handoff.handoff_id, record);
      return { handoff: clone(record), proposed: true, reason: null };
    },

    /** Recipient acceptance is what makes a takeover authoritative. */
    accept(handoffId, { acceptedBy, at = clock() } = {}) {
      const record = handoffs.get(handoffId);
      if (!record) throw new HandoffError('UNKNOWN_HANDOFF', String(handoffId));
      if (record.state !== 'PROPOSED') return { accepted: false, state: record.state, reason: record.state };
      if (acceptedBy !== record.handoff.to.assistant_ref) throw new HandoffError('NOT_THE_RECIPIENT', `only ${record.handoff.to.assistant_ref} may accept ${handoffId}`);
      if (!record.authority.can_take_over) throw new HandoffError('SCOPE_WIDENING_FORBIDDEN', `the recipient lacks ${record.authority.missing_capabilities.join(', ') || 'a required capability'}`);
      if (record.handoff.kind === 'CONSULTATION') {
        // A consultation transfers nothing, so acceptance changes no ownership.
        record.state = 'ACCEPTED';
        return { accepted: true, kind: 'CONSULTATION', ownership_changed: false, authority: record.authority, reason: 'CONSULTATION_TRANSFERS_NOTHING' };
      }
      const task = taskStore.getTask(record.handoff.task_ref);
      if (TERMINAL_TASK_STATES.includes(task.state)) throw new HandoffError('TASK_TERMINAL', `task ${record.handoff.task_ref} is ${task.state}`);
      // One authoritative new owner; the executor is untouched unless the handoff explicitly moves it.
      const updated = taskStore.setOwner(record.handoff.task_ref, record.handoff.to.assistant_ref);
      taskStore.recordCheckpoint(record.handoff.task_ref, record.handoff.checkpoint_ref);
      let executorMoved = false;
      if (record.handoff.executor_ref !== null && record.handoff.executor_ref !== updated.executor_ref) {
        // Moving the executor is a separate, explicit decision carried by the same package.
        taskStore.setExecutor(record.handoff.task_ref, record.handoff.executor_ref);
        executorMoved = true;
      }
      record.state = 'ACCEPTED';
      record.accepted_by = acceptedBy;
      record.accepted_at = at ?? null;
      return {
        accepted: true,
        kind: record.handoff.kind,
        ownership_changed: true,
        owner_ref: record.handoff.to.assistant_ref,
        previous_owner_ref: record.handoff.from.assistant_ref,
        executor_ref: record.handoff.executor_ref,
        executor_moved: executorMoved,
        checkpoint_ref: record.handoff.checkpoint_ref,
        authority: record.authority,
        transferred_grants: Object.freeze([]),
      };
    },

    /** A refusal or expiry leaves the old authoritative owner untouched. */
    reject(handoffId, { reason = 'REJECTED', at = clock() } = {}) {
      const record = handoffs.get(handoffId);
      if (!record) throw new HandoffError('UNKNOWN_HANDOFF', String(handoffId));
      if (record.state !== 'PROPOSED') return { rejected: false, state: record.state };
      record.state = 'REJECTED';
      record.rejected_at = at ?? null;
      record.rejection_reason = reason;
      return { rejected: true, state: record.state, ownership_changed: false, owner_ref: taskStore.getTask(record.handoff.task_ref).owner_ref };
    },

    expire(handoffId, { at = clock() } = {}) {
      const record = handoffs.get(handoffId);
      if (!record) throw new HandoffError('UNKNOWN_HANDOFF', String(handoffId));
      if (record.state !== 'PROPOSED') return { expired: false, state: record.state };
      record.state = 'EXPIRED';
      record.expired_at = at ?? null;
      return { expired: true, state: record.state, ownership_changed: false, owner_ref: taskStore.getTask(record.handoff.task_ref).owner_ref };
    },

    get(handoffId) { const record = handoffs.get(handoffId); if (!record) throw new HandoffError('UNKNOWN_HANDOFF', String(handoffId)); return clone(record); },
    listOpen() { return [...handoffs.values()].filter(record => record.state === 'PROPOSED').map(record => ({ handoff_id: record.handoff.handoff_id, task_ref: record.handoff.task_ref, to: record.handoff.to.assistant_ref, kind: record.handoff.kind })); },
  };

  return Object.freeze(coordinator);
}

/**
 * Foreground switching. This is deliberately a *separate* operation from handoff: it changes which
 * assistant answers on one device and touches no task, so an unrelated background task owned by the
 * outgoing assistant keeps running.
 */
export function switchForegroundAssistant({ deviceRef, assistants = [], from = null, to, onlineAssistants = [] } = {}) {
  if (!isText(deviceRef) || !isText(to)) throw new HandoffError('INVALID_HANDOFF', 'deviceRef and to are required');
  const attached = new Set(assistants.map(entry => (isPlainObject(entry) ? entry.assistant_ref : entry)));
  if (!attached.has(to)) throw new HandoffError('RECIPIENT_REQUIRED', `${to} is not present on ${deviceRef}`);
  if (from !== null && !attached.has(from)) throw new HandoffError('INVALID_HANDOFF', `${from} is not present on ${deviceRef}`);
  const switched = from !== to;
  return Object.freeze({
    device_ref: deviceRef,
    foreground_before: from,
    foreground_after: to,
    switched,
    // The two facts that keep switching and handoff apart.
    tasks_touched: 0,
    task_ownership_changed: false,
    outgoing_assistant_still_online: onlineAssistants.includes(from) || (from !== null && onlineAssistants.length === 0),
    is_a_handoff: false,
    handoff_required_for_ownership_change: true,
  });
}
