// Authoritative task graph + ownership/executor separation (BA-006).
//
// Task truth lives OUTSIDE any device session. The graph is the authority; every device (embodiment)
// only ever sees a projection of it. Four roles are strictly distinct and never conflated:
//
//   REQUESTER — who asked for the work (a user or an assistant), not the owner of it.
//   OWNER     — the logical owner/coordinator: an assistant identity. Never a session, never a device.
//   EXECUTOR  — the physical device/worker currently allowed to perform the side effect, guarded by a
//               lease + idempotency/action key. Ownership is not execution.
//   WATCHERS  — observers with no mutation right.
//
// Foreground binding (which assistant answers on one device) is NOT ownership: binding and releasing a
// device touches no role. Only an explicit BA-004 accepted handoff moves logical ownership, and only an
// explicit executor change moves execution — it cannot leave two simultaneous valid executors for one
// exclusive side effect.
//
// Pure module: no ambient state, clock injected.
export const TASK_GRAPH_CONTRACT_VERSION = 1;

export const TASK_STATES = Object.freeze(['PENDING', 'RUNNING', 'BLOCKED', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUSED']);
export const TERMINAL_TASK_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUSED']);
export const TASK_SCOPES = Object.freeze(['GLOBAL', 'ASSISTANT', 'WORKSPACE', 'DEVICE']);
export const SIDE_EFFECT_KINDS = Object.freeze(['NONE', 'EXCLUSIVE']);
export const MUTATION_ROLES = Object.freeze(['OWNER', 'SYSTEM']);
export const CAUSAL_KINDS = Object.freeze([
  'TASK_CREATED', 'TASK_UPDATED', 'OWNERSHIP_TRANSFERRED', 'EXECUTOR_ASSIGNED', 'EXECUTOR_SUPERSEDED',
  'LEASE_SUSPENDED_BY_DEVICE_RELEASE', 'LEASE_REVALIDATED', 'EXECUTION_RESULT_APPLIED',
]);

/** Keys that only an explicit, audited operation may change — never a generic patch. */
export const EXPLICIT_ONLY_FIELDS = Object.freeze([
  'owner_ref', 'executor_ref', 'lease', 'lease_ref', 'lease_epoch', 'action_key', 'scope', 'scope_ref',
  'requester_ref', 'task_id', 'task_version', 'causal_log', 'consumed_action_keys',
]);

/** A handoff may carry responsibility and evidence. These fields would make it an authority transfer. */
export const AUTHORITY_FIELDS = Object.freeze([
  'grants', 'permissions', 'permission_grants', 'capabilities', 'capability_grants', 'authority', 'policy',
  'policy_grants', 'scopes', 'access_token', 'lease', 'execution_lease', 'action_key', 'action_keys',
]);

export const TASK_GRAPH_CODES = Object.freeze([
  'INVALID_TASK', 'INVALID_CLOCK', 'UNKNOWN_TASK', 'DUPLICATE_TASK', 'SESSION_IS_NOT_OWNER',
  'DEVICE_IS_NOT_OWNER', 'EXECUTOR_IS_NOT_A_DEVICE', 'SESSION_IS_NOT_EXECUTOR', 'TASK_VERSION_CONFLICT',
  'TASK_TERMINAL', 'ROLE_NOT_PERMITTED', 'EXPLICIT_OPERATION_REQUIRED', 'HANDOFF_TASK_MISMATCH',
  'HANDOFF_STALE_VERSION', 'HANDOFF_NOT_ACCEPTED', 'HANDOFF_TRANSFERS_NO_AUTHORITY',
  'CONSULTATION_TRANSFERS_NOTHING', 'EXECUTOR_ALREADY_BOUND', 'LEASE_REQUIRED',
  'EXPECTED_LEASE_MISMATCH', 'STALE_LEASE', 'LEASE_SUSPENDED', 'NOT_THE_EXECUTOR', 'ACTION_KEY_REQUIRED',
  'ACTION_KEY_MISMATCH', 'DUPLICATE_ACTION_KEY', 'INVALID_OUTCOME',
]);

const CONFLICT_CODES = new Set(['TASK_VERSION_CONFLICT', 'STALE_LEASE', 'LEASE_SUSPENDED', 'DUPLICATE_ACTION_KEY', 'EXECUTOR_ALREADY_BOUND', 'HANDOFF_STALE_VERSION', 'TASK_TERMINAL', 'HANDOFF_NOT_ACCEPTED']);
const NOT_FOUND_CODES = new Set(['UNKNOWN_TASK']);

export class TaskGraphError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'TaskGraphError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = NOT_FOUND_CODES.has(code) ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
    Object.assign(this, extra);
  }
}

const isPlainObject = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
const freeze = value => {
  const seen = new WeakSet();
  const walk = node => {
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) return node;
    seen.add(node);
    for (const child of Object.values(node)) walk(child);
    return Object.freeze(node);
  };
  return walk(value);
};
const snapshot = record => freeze(clone(record));
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

const INSTANT_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
/** Shape is not enough: the regex accepts a calendar-impossible date, so components must round trip. */
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

const SESSION_SHAPE = /^(session|sessions|ui|ui_session|foreground|foreground_session|chat|conversation)[:/]/i;
const DEVICE_SHAPE = /^(device|dev|node|worker|executor|machine)[:/]/i;
const OWNER_SHAPE = /^assistant[:/]/i;

export const isSessionShapedRef = ref => isText(ref) && SESSION_SHAPE.test(ref);
export const isDeviceShapedRef = ref => isText(ref) && DEVICE_SHAPE.test(ref);

/** Recursive scan for authority-bearing fields anywhere in a handoff package. */
export function findAuthorityFields(value, path = 'handoff', found = [], seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return found;
    seen.add(value);
    value.forEach((item, index) => findAuthorityFields(item, `${path}[${index}]`, found, seen));
    return found;
  }
  if (!isPlainObject(value)) return found;
  if (seen.has(value)) return found;
  seen.add(value);
  // Every own key is inspected: a non-enumerable or symbol-keyed authority field is still authority.
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') { found.push(`${path}.${String(key)}`); continue; }
    const childPath = `${path}.${key}`;
    if (AUTHORITY_FIELDS.includes(key)) found.push(childPath);
    findAuthorityFields(value[key], childPath, found, seen);
  }
  return found;
}

const CREATE_SPEC = Object.freeze({
  task_id: { required: true, type: 'text' },
  scope: { required: true, type: 'enum', values: TASK_SCOPES },
  scope_ref: { required: false, type: 'text', nullable: true },
  state: { required: false, type: 'enum', values: TASK_STATES },
  requester_ref: { required: true, type: 'text' },
  owner_ref: { required: true, type: 'text' },
  watchers: { required: false, type: 'array' },
  checkpoint_ref: { required: false, type: 'text', nullable: true },
  side_effect: { required: false, type: 'enum', values: SIDE_EFFECT_KINDS },
  at: { required: false, type: 'instant' },
});

const UPDATE_SPEC = Object.freeze({
  state: { required: false, type: 'enum', values: TASK_STATES },
  checkpoint_ref: { required: false, type: 'text', nullable: true },
  watchers: { required: false, type: 'array' },
});

function checkShape(value, path, spec, errors) {
  if (!isPlainObject(value)) { errors.push(`${path} must be an object`); return; }
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !Object.hasOwn(spec, key)) errors.push(`${path}.${String(key)} is not part of the canonical contract`);
  for (const [key, rule] of Object.entries(spec)) {
    const present = Object.hasOwn(value, key);
    if (!present) { if (rule.required) errors.push(`${path}.${key} is required`); continue; }
    const field = value[key];
    const fieldPath = `${path}.${key}`;
    if (field === null || field === undefined) { if (!rule.nullable) errors.push(`${fieldPath} must not be null`); continue; }
    if (rule.type === 'text' && !isText(field)) errors.push(`${fieldPath} must be nonempty text`);
    if (rule.type === 'instant' && !isIsoInstant(field)) errors.push(`${fieldPath} must be an ISO-8601 UTC instant`);
    if (rule.type === 'enum' && !rule.values.includes(field)) errors.push(`${fieldPath} must be one of ${rule.values.join(', ')}`);
    if (rule.type === 'array' && (!Array.isArray(field) || field.some(item => !isText(item)))) errors.push(`${fieldPath} must be an array of nonempty text`);
  }
}

export function createTaskGraph({ now = () => new Date().toISOString() } = {}) {
  if (typeof now !== 'function') throw new TaskGraphError('INVALID_CLOCK', 'now must be a function returning an ISO-8601 UTC instant');
  const tasks = new Map();
  const foreground = new Map();

  const at = value => {
    if (value === undefined) {
      const produced = now();
      if (!isRealInstant(produced)) throw new TaskGraphError('INVALID_CLOCK', 'now() must return an ISO-8601 UTC instant');
      return produced;
    }
    if (!isRealInstant(value)) throw new TaskGraphError('INVALID_TASK', 'at must be a real ISO-8601 UTC instant');
    return value;
  };

  const requireTask = task_id => {
    const record = tasks.get(task_id);
    if (!record) throw new TaskGraphError('UNKNOWN_TASK', `no authoritative task ${task_id}`);
    return record;
  };

  const assertMutable = (record, expected_version) => {
    if (!Number.isSafeInteger(expected_version)) throw new TaskGraphError('TASK_VERSION_CONFLICT', 'expected_version is required for every mutation', { task_id: record.task_id, current_version: record.task_version, current_state: record.state });
    if (expected_version !== record.task_version) throw new TaskGraphError('TASK_VERSION_CONFLICT', `task ${record.task_id} is at version ${record.task_version}, update assumed ${expected_version}`, { task_id: record.task_id, current_version: record.task_version, current_state: record.state });
    if (TERMINAL_TASK_STATES.includes(record.state)) throw new TaskGraphError('TASK_TERMINAL', `task ${record.task_id} is ${record.state}`, { task_id: record.task_id, current_version: record.task_version, current_state: record.state });
  };

  const audit = (record, entry) => {
    record.task_version += 1;
    record.updated_at = entry.at;
    record.causal_log.push({ seq: record.causal_log.length + 1, from_version: record.task_version - 1, to_version: record.task_version, ...entry });
  };

  const visibleTo = (record, device_ref) => {
    const reasons = [];
    const binding = foreground.get(device_ref) ?? null;
    if (record.scope === 'GLOBAL') reasons.push('GLOBAL_SCOPE');
    if (record.scope === 'DEVICE' && record.scope_ref === device_ref) reasons.push('DEVICE_SCOPE');
    if (record.scope === 'ASSISTANT' && binding && binding.assistant_ref === record.scope_ref) reasons.push('ASSISTANT_SCOPE');
    if (record.scope === 'WORKSPACE' && binding && binding.workspace_refs.includes(record.scope_ref)) reasons.push('WORKSPACE_SCOPE');
    if (record.executor_ref === device_ref) reasons.push('CURRENT_EXECUTOR');
    if (record.watchers.includes(device_ref)) reasons.push('WATCHER');
    if (record.requester_ref === device_ref) reasons.push('REQUESTER');
    return reasons;
  };

  const projection = (record, device_ref, cached_version) => {
    const reasons = visibleTo(record, device_ref);
    if (reasons.length === 0) return null;
    const binding = foreground.get(device_ref) ?? null;
    const role_of_device = record.executor_ref === device_ref ? 'EXECUTOR'
      : record.watchers.includes(device_ref) ? 'WATCHER'
      : record.requester_ref === device_ref ? 'REQUESTER' : 'OBSERVER';
    return freeze({
      task_id: record.task_id,
      task_version: record.task_version,
      state: record.state,
      scope: record.scope,
      scope_ref: record.scope_ref,
      requester_ref: record.requester_ref,
      owner_ref: record.owner_ref,
      executor_ref: record.executor_ref,
      watchers: clone(record.watchers),
      checkpoint_ref: record.checkpoint_ref,
      side_effect: record.side_effect,
      lease_ref: record.lease?.lease_ref ?? null,
      lease_epoch: record.lease?.lease_epoch ?? 0,
      lease_suspended: record.lease?.suspended ?? false,
      visible_because: reasons,
      role_of_device,
      foreground_assistant_ref: binding?.assistant_ref ?? null,
      session_is_owner: false,
      projection_of_authority: true,
      stale: Number.isSafeInteger(cached_version) ? cached_version !== record.task_version : null,
    });
  };

  return {
    createTask(input) {
      const errors = [];
      checkShape(input, 'task', CREATE_SPEC, errors);
      if (!isPlainObject(input)) throw new TaskGraphError('INVALID_TASK', errors.join('; '));
      if (errors.length) throw new TaskGraphError('INVALID_TASK', errors.join('; '));
      if (tasks.has(input.task_id)) {
        throw new TaskGraphError('DUPLICATE_TASK', `task ${input.task_id} already exists in the authoritative graph; embodiments do not get their own copy`, { task_id: input.task_id, current_version: tasks.get(input.task_id).task_version });
      }
      if (isSessionShapedRef(input.owner_ref)) throw new TaskGraphError('SESSION_IS_NOT_OWNER', 'a UI/foreground session is not the logical owner of a task');
      if (isDeviceShapedRef(input.owner_ref)) throw new TaskGraphError('DEVICE_IS_NOT_OWNER', 'a device embodiment is not the logical owner of a task');
      if (!OWNER_SHAPE.test(input.owner_ref)) throw new TaskGraphError('DEVICE_IS_NOT_OWNER', `owner_ref must be a logical assistant identity (assistant:<id>), got ${input.owner_ref}`);
      if (isSessionShapedRef(input.requester_ref)) throw new TaskGraphError('SESSION_IS_NOT_OWNER', 'a UI/foreground session is not a durable requester identity');
      const scope_ref = input.scope_ref ?? null;
      if (input.scope === 'GLOBAL' && scope_ref !== null) throw new TaskGraphError('INVALID_TASK', 'GLOBAL scope takes no scope_ref');
      if (input.scope === 'DEVICE' && !isDeviceShapedRef(scope_ref)) throw new TaskGraphError('INVALID_TASK', 'DEVICE scope requires a device-shaped scope_ref');
      if ((input.scope === 'ASSISTANT' || input.scope === 'WORKSPACE') && !isText(scope_ref)) throw new TaskGraphError('INVALID_TASK', `${input.scope} scope requires a scope_ref`);
      const timestamp = at(input.at);
      const watchers = clone(input.watchers ?? []);
      for (const watcher of watchers) if (isSessionShapedRef(watcher)) throw new TaskGraphError('SESSION_IS_NOT_OWNER', `watcher ${watcher} is a session, not a durable watcher identity`);
      // An exclusive side effect has no lease and no action key yet, so it cannot be born complete.
      if ((input.side_effect ?? 'NONE') === 'EXCLUSIVE' && TERMINAL_TASK_STATES.includes(input.state ?? 'PENDING')) {
        throw new TaskGraphError('EXPLICIT_OPERATION_REQUIRED', 'an exclusive side effect cannot be created in a terminal state; it must complete through submitExecutorResult', { task_id: input.task_id, side_effect: 'EXCLUSIVE' });
      }
      const record = {
        contract_version: TASK_GRAPH_CONTRACT_VERSION,
        task_id: input.task_id,
        task_version: 0,
        scope: input.scope,
        scope_ref,
        state: input.state ?? 'PENDING',
        requester_ref: input.requester_ref,
        owner_ref: input.owner_ref,
        watchers,
        executor_ref: null,
        lease: null,
        action_key: null,
        consumed_action_keys: [],
        checkpoint_ref: input.checkpoint_ref ?? null,
        side_effect: input.side_effect ?? 'NONE',
        created_at: timestamp,
        updated_at: timestamp,
        causal_log: [],
      };
      tasks.set(record.task_id, record);
      audit(record, { kind: 'TASK_CREATED', at: timestamp, actor_ref: input.requester_ref, caused_by: null });
      return snapshot(record);
    },

    /** Typed absence: an unknown task is null, not a thrown error. */
    getTask(task_id) {
      const record = tasks.get(task_id);
      return record ? snapshot(record) : null;
    },

    updateTask({ task_id, expected_version, role, actor_ref, patch, at: when } = {}) {
      const record = requireTask(task_id);
      if (!MUTATION_ROLES.includes(role)) throw new TaskGraphError('ROLE_NOT_PERMITTED', `${role} may not mutate authoritative task state (${MUTATION_ROLES.join(', ')} only)`, { task_id });
      if (!isText(actor_ref)) throw new TaskGraphError('ROLE_NOT_PERMITTED', 'actor_ref is required for an audited mutation', { task_id });
      assertMutable(record, expected_version);
      const errors = [];
      checkShape(patch, 'patch', UPDATE_SPEC, errors);
      if (errors.length) {
        const explicit = Object.keys(patch ?? {}).filter(key => EXPLICIT_ONLY_FIELDS.includes(key));
        if (explicit.length) throw new TaskGraphError('EXPLICIT_OPERATION_REQUIRED', `${explicit.join(', ')} may only change through an explicit audited operation (transferOwnership / changeExecutor)`, { task_id, fields: explicit });
        throw new TaskGraphError('INVALID_TASK', errors.join('; '), { task_id });
      }
      if (!isPlainObject(patch) || Object.keys(patch).length === 0) throw new TaskGraphError('INVALID_TASK', 'patch must change at least one field', { task_id });
      if (patch.state !== undefined && TERMINAL_TASK_STATES.includes(patch.state) && record.side_effect === 'EXCLUSIVE') {
        throw new TaskGraphError('EXPLICIT_OPERATION_REQUIRED', 'a terminal state for an exclusive side effect must be applied by the leased executor through submitExecutorResult', { task_id });
      }
      // Validate the whole patch before touching the record: a refused patch must change nothing.
      if (patch.watchers !== undefined) {
        for (const watcher of patch.watchers) if (isSessionShapedRef(watcher)) throw new TaskGraphError('SESSION_IS_NOT_OWNER', `watcher ${watcher} is a session, not a durable watcher identity`, { task_id });
      }
      const timestamp = at(when);
      if (patch.state !== undefined) record.state = patch.state;
      if (patch.checkpoint_ref !== undefined) record.checkpoint_ref = patch.checkpoint_ref;
      if (patch.watchers !== undefined) record.watchers = clone(patch.watchers);
      audit(record, { kind: 'TASK_UPDATED', at: timestamp, actor_ref, caused_by: null });
      return snapshot(record);
    },

    /**
     * Logical ownership moves only through an explicit accepted BA-004 handoff that names this exact task
     * at this exact version, and that carries no authority at all. The executor is not restarted.
     */
    transferOwnership({ task_id, expected_version, handoff, at: when } = {}) {
      const record = requireTask(task_id);
      assertMutable(record, expected_version);
      if (!isPlainObject(handoff)) throw new TaskGraphError('HANDOFF_NOT_ACCEPTED', 'an accepted handoff package is required to move ownership', { task_id });
      if (handoff.kind !== 'RESPONSIBILITY_TRANSFER') throw new TaskGraphError('CONSULTATION_TRANSFERS_NOTHING', `handoff kind ${handoff.kind} transfers nothing`, { task_id });
      const authority = findAuthorityFields(handoff);
      if (authority.length) throw new TaskGraphError('HANDOFF_TRANSFERS_NO_AUTHORITY', `handoff carries authority fields: ${authority.join(', ')}`, { task_id, fields: authority });
      if (handoff.state !== 'ACCEPTED') throw new TaskGraphError('HANDOFF_NOT_ACCEPTED', `handoff state is ${handoff.state}`, { task_id });
      if (handoff.task_ref !== task_id) throw new TaskGraphError('HANDOFF_TASK_MISMATCH', `handoff names ${handoff.task_ref}, not ${task_id}`, { task_id });
      if (handoff.task_version !== record.task_version) throw new TaskGraphError('HANDOFF_STALE_VERSION', `handoff was prepared at version ${handoff.task_version}, task is at ${record.task_version}`, { task_id, current_version: record.task_version });
      const to = handoff.to?.assistant_ref;
      if (isSessionShapedRef(to)) throw new TaskGraphError('SESSION_IS_NOT_OWNER', 'a session cannot receive logical ownership', { task_id });
      if (isDeviceShapedRef(to)) throw new TaskGraphError('DEVICE_IS_NOT_OWNER', 'a device cannot receive logical ownership', { task_id });
      if (!OWNER_SHAPE.test(to ?? '')) throw new TaskGraphError('DEVICE_IS_NOT_OWNER', `handoff recipient ${to} is not a logical assistant identity`, { task_id });
      if (isText(handoff.from?.assistant_ref) && handoff.from.assistant_ref !== record.owner_ref) {
        throw new TaskGraphError('HANDOFF_TASK_MISMATCH', `handoff was sent by ${handoff.from.assistant_ref}, but the authoritative owner is ${record.owner_ref}`, { task_id });
      }
      if (handoff.checkpoint_ref !== undefined && handoff.checkpoint_ref !== null && !isText(handoff.checkpoint_ref)) {
        throw new TaskGraphError('HANDOFF_NOT_ACCEPTED', 'handoff.checkpoint_ref must be nonempty text when present', { task_id });
      }
      const previous_owner = record.owner_ref;
      const previous_executor = record.executor_ref;
      const timestamp = at(when);
      record.owner_ref = to;
      if (handoff.checkpoint_ref !== undefined && handoff.checkpoint_ref !== null) record.checkpoint_ref = handoff.checkpoint_ref;
      const entry = { kind: 'OWNERSHIP_TRANSFERRED', at: timestamp, actor_ref: handoff.from?.assistant_ref ?? previous_owner, caused_by: handoff.handoff_id ?? null };
      audit(record, entry);
      return freeze({
        task: snapshot(record),
        previous_owner_ref: previous_owner,
        owner_ref: record.owner_ref,
        executor_ref: record.executor_ref,
        executor_restarted: previous_executor !== record.executor_ref,
        authority_transferred: false,
        task_version: record.task_version,
      });
    },

    /**
     * Execution moves only explicitly. An exclusive side effect holds at most one live lease, so there can
     * never be two simultaneous valid executors: a second executor is refused unless it takes over the
     * exact lease it names, which supersedes the old one and bumps the epoch.
     */
    changeExecutor({ task_id, expected_version, executor_ref, actor_ref, action_key, take_over = false, expected_lease_ref, at: when } = {}) {
      const record = requireTask(task_id);
      assertMutable(record, expected_version);
      if (isSessionShapedRef(executor_ref)) throw new TaskGraphError('SESSION_IS_NOT_EXECUTOR', 'a UI/foreground session can never be an executor', { task_id });
      if (!isDeviceShapedRef(executor_ref)) throw new TaskGraphError('EXECUTOR_IS_NOT_A_DEVICE', `executor_ref must be a physical device/worker identity, got ${executor_ref}`, { task_id });
      if (!isText(actor_ref)) throw new TaskGraphError('ROLE_NOT_PERMITTED', 'actor_ref is required for an audited executor change', { task_id });
      if (record.side_effect === 'EXCLUSIVE' && !isText(action_key)) throw new TaskGraphError('ACTION_KEY_REQUIRED', 'an exclusive side effect requires an idempotency/action key', { task_id });
      // A suspended lease (its device was released) is not live: the executor must revalidate it, not
      // re-issue it, so a released device cannot resume a side effect on its own authority.
      if (record.lease && !record.lease.superseded && record.lease.suspended === true) {
        throw new TaskGraphError('LEASE_SUSPENDED', `the lease on ${task_id} is suspended; revalidate it before resuming`, { task_id, current_lease_ref: record.lease.lease_ref });
      }
      const live = record.lease && !record.lease.superseded;
      if (live && record.executor_ref !== executor_ref) {
        if (take_over !== true) {
          throw new TaskGraphError('EXECUTOR_ALREADY_BOUND', `task ${task_id} already has a live executor ${record.executor_ref} on ${record.lease.lease_ref}; use an explicit take-over of that exact lease`, { task_id, current_executor_ref: record.executor_ref, current_lease_ref: record.lease.lease_ref });
        }
        if (expected_lease_ref !== record.lease.lease_ref) {
          throw new TaskGraphError('EXPECTED_LEASE_MISMATCH', `take-over named ${expected_lease_ref}, current lease is ${record.lease.lease_ref}`, { task_id, current_lease_ref: record.lease.lease_ref });
        }
      }
      const timestamp = at(when);
      const epoch = (record.lease?.lease_epoch ?? 0) + 1;
      const superseded_lease_refs = [...(record.lease?.superseded_lease_refs ?? [])];
      if (record.lease) superseded_lease_refs.push(record.lease.lease_ref);
      const lease_ref = `lease:${task_id}#${epoch}`;
      const superseded = record.lease?.lease_ref ?? null;
      record.executor_ref = executor_ref;
      record.action_key = isText(action_key) ? action_key : null;
      record.consumed_action_keys = [];
      record.lease = { lease_ref, lease_epoch: epoch, executor_ref, suspended: false, superseded: false, superseded_lease_refs };
      audit(record, { kind: superseded ? 'EXECUTOR_SUPERSEDED' : 'EXECUTOR_ASSIGNED', at: timestamp, actor_ref, caused_by: superseded });
      return freeze({
        task: snapshot(record),
        lease: freeze({ lease_ref, lease_epoch: epoch, executor_ref, exclusive: record.side_effect === 'EXCLUSIVE' }),
        superseded_lease_ref: superseded,
        previous_lease_revoked: superseded !== null,
        concurrent_valid_executors: 1,
      });
    },

    /** An executor whose device was released must revalidate the lease before resuming a side effect. */
    revalidateLease({ task_id, lease_ref, lease_epoch, executor_ref } = {}) {
      const record = requireTask(task_id);
      assertMutable(record, record.task_version);
      if (!record.lease || record.lease.lease_ref !== lease_ref || record.lease.lease_epoch !== lease_epoch) {
        throw new TaskGraphError('STALE_LEASE', `lease ${lease_ref}#${lease_epoch} is not the current lease ${record.lease?.lease_ref ?? 'none'}#${record.lease?.lease_epoch ?? 0}`, { task_id, current_lease_ref: record.lease?.lease_ref ?? null, current_lease_epoch: record.lease?.lease_epoch ?? 0 });
      }
      if (record.executor_ref !== executor_ref) throw new TaskGraphError('NOT_THE_EXECUTOR', `${executor_ref} is not the executor ${record.executor_ref}`, { task_id });
      const timestamp = at(undefined);
      record.lease.suspended = false;
      audit(record, { kind: 'LEASE_REVALIDATED', at: timestamp, actor_ref: executor_ref, caused_by: lease_ref });
      return freeze({ task: snapshot(record), revalidated: true, lease_ref, lease_epoch });
    },

    /** The single guarded path for an externally visible side effect's result. */
    submitExecutorResult({ task_id, expected_version, actor_ref, lease_ref, lease_epoch, action_key, outcome, checkpoint_ref, at: when } = {}) {
      const record = requireTask(task_id);
      if (!TERMINAL_TASK_STATES.includes(outcome)) throw new TaskGraphError('INVALID_OUTCOME', `outcome must be one of ${TERMINAL_TASK_STATES.join(', ')}`, { task_id });
      if (record.side_effect === 'EXCLUSIVE') {
        if (!isText(action_key)) throw new TaskGraphError('ACTION_KEY_REQUIRED', 'an exclusive side effect requires the idempotency/action key', { task_id });
        if (record.consumed_action_keys.includes(action_key)) throw new TaskGraphError('DUPLICATE_ACTION_KEY', `action key ${action_key} was already applied; the side effect is not repeated`, { task_id });
        if (action_key !== record.action_key) throw new TaskGraphError('ACTION_KEY_MISMATCH', `action key ${action_key} does not match the assigned ${record.action_key}`, { task_id });
      }
      assertMutable(record, expected_version);
      if (record.executor_ref !== actor_ref) throw new TaskGraphError('NOT_THE_EXECUTOR', `${actor_ref} is not the executor ${record.executor_ref}`, { task_id });
      if (!record.lease || record.lease.lease_ref !== lease_ref || record.lease.lease_epoch !== lease_epoch) {
        throw new TaskGraphError('STALE_LEASE', `lease ${lease_ref}#${lease_epoch} is not the current lease ${record.lease?.lease_ref ?? 'none'}#${record.lease?.lease_epoch ?? 0}`, { task_id, current_lease_ref: record.lease?.lease_ref ?? null, current_lease_epoch: record.lease?.lease_epoch ?? 0 });
      }
      if (record.lease.suspended) throw new TaskGraphError('LEASE_SUSPENDED', 'the executor device was released; revalidate the lease before resuming', { task_id, current_lease_ref: record.lease.lease_ref });
      const timestamp = at(when);
      record.state = outcome;
      if (isText(checkpoint_ref)) record.checkpoint_ref = checkpoint_ref;
      if (isText(action_key)) record.consumed_action_keys.push(action_key);
      audit(record, { kind: 'EXECUTION_RESULT_APPLIED', at: timestamp, actor_ref, caused_by: lease_ref });
      return freeze({ task: snapshot(record), applied_outcome: outcome, action_key_applied: isText(action_key) ? action_key : null, duplicate_side_effect: false });
    },

    /** Foreground binding changes who answers on a device. It touches no task role, ever. */
    bindForeground({ device_ref, assistant_ref, workspace_refs = [], at: when } = {}) {
      if (!isDeviceShapedRef(device_ref)) throw new TaskGraphError('EXECUTOR_IS_NOT_A_DEVICE', `device_ref must be device-shaped, got ${device_ref}`);
      if (!isText(assistant_ref)) throw new TaskGraphError('INVALID_TASK', 'assistant_ref is required');
      if (!Array.isArray(workspace_refs) || workspace_refs.some(entry => !isText(entry))) {
        throw new TaskGraphError('INVALID_TASK', 'workspace_refs must be an array of nonempty text');
      }
      const timestamp = at(when);
      const previous = foreground.get(device_ref)?.assistant_ref ?? null;
      foreground.set(device_ref, { assistant_ref, workspace_refs: clone(workspace_refs) });
      return freeze({
        device_ref,
        previous_foreground_assistant_ref: previous,
        foreground_assistant_ref: assistant_ref,
        switched: previous !== null && previous !== assistant_ref,
        tasks_touched: [],
        role_changes: [],
        ownership_changed: false,
        executor_changed: false,
        at: timestamp,
      });
    },

    /** Releasing a device (shutdown, disconnect) never orphans a task or moves ownership. */
    releaseDevice({ device_ref, at: when } = {}) {
      if (!isDeviceShapedRef(device_ref)) throw new TaskGraphError('EXECUTOR_IS_NOT_A_DEVICE', `device_ref must be device-shaped, got ${device_ref}`);
      const timestamp = at(when);
      const binding = foreground.get(device_ref) ?? null;
      foreground.delete(device_ref);
      const suspended = [];
      const retained = [];
      for (const record of tasks.values()) {
        if (record.scope === 'DEVICE' && record.scope_ref === device_ref) retained.push(record.task_id);
        // A terminal task's version and causal log are immutable: a device release never rewrites them.
        if (TERMINAL_TASK_STATES.includes(record.state)) continue;
        if (record.lease && !record.lease.superseded && record.executor_ref === device_ref && !record.lease.suspended) {
          record.lease.suspended = true;
          audit(record, { kind: 'LEASE_SUSPENDED_BY_DEVICE_RELEASE', at: timestamp, actor_ref: device_ref, caused_by: record.lease.lease_ref });
          suspended.push(record.lease.lease_ref);
        }
      }
      return freeze({
        device_ref,
        released_foreground_assistant_ref: binding?.assistant_ref ?? null,
        orphaned_tasks: [],
        retained_device_scoped_tasks: retained,
        suspended_lease_refs: suspended,
        ownership_changes: [],
      });
    },

    /** Authoritative, revision-stamped projections for one embodiment of the same assistant core. */
    projectFor({ device_ref, cached_version } = {}) {
      if (!isDeviceShapedRef(device_ref)) throw new TaskGraphError('EXECUTOR_IS_NOT_A_DEVICE', `device_ref must be device-shaped, got ${device_ref}`);
      const projections = [];
      for (const record of tasks.values()) {
        const view = projection(record, device_ref, cached_version);
        if (view) projections.push(view);
      }
      projections.sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
      return freeze({
        device_ref,
        foreground_assistant_ref: foreground.get(device_ref)?.assistant_ref ?? null,
        projections,
        projection_count: projections.length,
        authoritative_task_count: tasks.size,
        local_copy_is_cache: true,
      });
    },

    taskCount() { return tasks.size; },
  };
}
