// Shared Task Core + Utopia engineering control surface (EM-013).
//
// Engineering Manager appears as ONE Utopia capability over canonical shared tasks/actions. The binding is
// strict in both directions:
//
//   BINDING   an Engineering job binds to a Shared Task Core task/action; the manager obtains execution
//             responsibility and a lease, and creates no competing canonical truth of its own.
//   SURFACE   submit/status/progress/stage/attention/control/result/artifact are projections over that
//             canonical state, so Web and Android observe the same job without a duplicate execution.
//
// The user stays where they are: the interaction device may differ from the execution device, remote fallback
// requires explicit approval (a faster remote machine is never auto-selected), local work that is allowed or
// throttled remains local, and job control, progress, attention and results all appear on the interaction
// surface rather than sending the user to the execution host.
//
// Attention is projected from canonical shared Attention state — the first acknowledgement reconciles every
// device projection — and there is no second Engineering-global attention database. User-visible success comes
// only from a terminal accepted EngineeringResult, never from a dispatch or a progress event.
//
// Pure module: the clock is injected; no storage, network, UI framework or ambient state.
export const CONTROL_SURFACE_CONTRACT_VERSION = 1;

// Canonical refs are minted from one process-wide sequence so two surfaces never publish the same ref.
let REF_SEQ = 0;

export const SURFACE_VIEWS = Object.freeze(['SUBMIT', 'STATUS', 'PROGRESS', 'STAGE', 'ATTENTION', 'CONTROL', 'RESULT', 'ARTIFACT']);
export const JOB_STATES = Object.freeze(['SUBMITTED', 'QUEUED', 'RUNNING', 'WAITING_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED', 'UNKNOWN']);
export const TERMINAL_JOB_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED']);
export const ELIGIBILITY = Object.freeze(['LOCAL_ALLOWED', 'LOCAL_THROTTLED', 'LOCAL_BLOCKED', 'REMOTE_REQUIRED']);
export const ATTENTION_STATES = Object.freeze(['PENDING', 'ACKNOWLEDGED', 'EXPIRED', 'WITHDRAWN']);
export const PROVENANCE_FIELDS = Object.freeze(['connector_ref', 'backend_run_ref', 'device_ref', 'branch_ref', 'commit_ref', 'test_ref', 'error_ref']);
export const SECRET_KEY_SHAPE = /(secret|token|password|api_?key|private_?key|session_key|credential_value|authorization|cookie|bearer|x-api-key|refresh_token|^value$)/i;

export const CONTROL_SURFACE_CODES = Object.freeze([
  'INVALID_REQUEST', 'INVALID_CLOCK', 'UNKNOWN_JOB', 'DUPLICATE_JOB', 'CANONICAL_TASK_REQUIRED',
  'FALSE_SUCCESS_REFUSED', 'REMOTE_FALLBACK_REQUIRES_APPROVAL', 'LOCAL_WORK_MUST_STAY_LOCAL',
  'UNKNOWN_ATTENTION', 'ALREADY_ACKNOWLEDGED', 'SECOND_ATTENTION_STORE_REFUSED', 'NOT_TERMINAL_ACCEPTED',
  'SECRET_MATERIAL_REFUSED', 'EXECUTOR_NOT_SEPARATED', 'NOT_AUTHORIZED_TO_CONTROL', 'ATTENTION_REQUIRED',
]);

const CONFLICT_CODES = new Set(['DUPLICATE_JOB', 'FALSE_SUCCESS_REFUSED', 'REMOTE_FALLBACK_REQUIRES_APPROVAL', 'LOCAL_WORK_MUST_STAY_LOCAL', 'ALREADY_ACKNOWLEDGED', 'SECOND_ATTENTION_STORE_REFUSED', 'NOT_TERMINAL_ACCEPTED', 'NOT_AUTHORIZED_TO_CONTROL', 'ATTENTION_REQUIRED']);

export class ControlSurfaceError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ControlSurfaceError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_JOB' || code === 'UNKNOWN_ATTENTION' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
    Object.assign(this, extra);
  }
}

const isPlainObject = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const isText = value => typeof value === 'string' && value.trim().length > 0;

/** A timestamp is evidence only when it is a real instant, not merely a shape. */
const isRealInstant = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString() === value || parsed.toISOString() === value.replace('Z', '.000Z');
};
const clone = value => (value === undefined ? undefined : structuredClone(value));
const freeze = (value, seen = new WeakSet()) => {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) continue;
    freeze(descriptor.value, seen);
  }
  return Object.freeze(value);
};
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && isRealInstant(value);

export function findSecretFields(value, path = 'record', found = [], seen = new WeakSet()) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSecretFields(item, `${path}[${index}]`, found, seen));
    return found;
  }
  if (value instanceof Map) {
    if (seen.has(value)) return found;
    seen.add(value);
    for (const [key, child] of value.entries()) {
      const childPath = `${path}.${String(key)}`;
      if (SECRET_KEY_SHAPE.test(String(key)) && !/_ref$/.test(String(key)) && typeof child !== 'boolean') {
        if (!found.includes(childPath)) found.push(childPath);
        continue;
      }
      findSecretFields(child, childPath, found, seen);
    }
    return found;
  }
  if (value instanceof Set) {
    if (seen.has(value)) return found;
    seen.add(value);
    let index = 0;
    for (const item of value.values()) { findSecretFields(item, `${path}[${index}]`, found, seen); index += 1; }
    return found;
  }
  if (typeof value === 'boolean' || value === null || value === undefined) return found;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') return found;
  if (typeof value === 'function' || typeof value === 'symbol') return found;
  if (!isPlainObject(value)) {
    // A record the scanner cannot read is reported rather than certified secret-free.
    const opaquePath = `${path}.<unreadable:${value?.constructor?.name ?? 'object'}>`;
    if (!found.includes(opaquePath)) found.push(opaquePath);
    return found;
  }
  if (seen.has(value)) return found;
  seen.add(value);
  // Own keys, enumerable or not, string or symbol: a hidden secret field is still a secret field, and a
  // getter is never invoked while scanning.
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    const child = 'value' in descriptor ? descriptor.value : undefined;
    const name = typeof key === 'symbol' ? `[${String(key.description ?? 'symbol')}]` : key;
    const childPath = `${path}.${name}`;
    const keyIsSecret = SECRET_KEY_SHAPE.test(String(name)) && !/_ref$/.test(String(name)) && typeof child !== 'boolean';
    if (keyIsSecret) {
      if (!found.includes(childPath)) found.push(childPath);
      continue;
    }
    findSecretFields(child, childPath, found, seen);
  }
  return found;
}

export const DEFAULT_SURFACE_POLICY = Object.freeze({
  policy_ref: 'policy:em-control-surface-default',
  require_canonical_task: true,
  local_first: true,
  attention_projection_sources: Object.freeze(['SHARED_CORE_ATTENTION']),
});

export function createEngineeringControlSurface({ clock = () => new Date().toISOString(), policy = {}, taskCore = null } = {}) {
  if (typeof clock !== 'function') throw new ControlSurfaceError('INVALID_CLOCK', 'clock must be a function returning a real ISO-8601 UTC instant');
  if (!isPlainObject(policy)) throw new ControlSurfaceError('INVALID_REQUEST', 'policy must be a plain object');
  const unknownPolicyKeys = Object.keys(policy).filter(key => !Object.hasOwn(DEFAULT_SURFACE_POLICY, key));
  if (unknownPolicyKeys.length > 0) throw new ControlSurfaceError('INVALID_REQUEST', unknownPolicyKeys.join(', ') + ' is not part of the control surface policy');
  // The canonical binding is the contract, not a deployment switch a caller may turn off.
  if (policy.require_canonical_task !== undefined && policy.require_canonical_task !== true) {
    throw new ControlSurfaceError('CANONICAL_TASK_REQUIRED', 'require_canonical_task may not be disabled: every engineering job binds to canonical shared task state', { require_canonical_task: policy.require_canonical_task });
  }
  if (policy.local_first !== undefined && typeof policy.local_first !== 'boolean') throw new ControlSurfaceError('INVALID_REQUEST', 'policy.local_first must be a boolean');
  if (policy.attention_projection_sources !== undefined) {
    const sources = policy.attention_projection_sources;
    if (!Array.isArray(sources) || sources.length === 0 || sources.some(source => source !== 'SHARED_CORE_ATTENTION')) {
      throw new ControlSurfaceError('SECOND_ATTENTION_STORE_REFUSED', 'attention may only be projected from SHARED_CORE_ATTENTION', { sources: sources ?? null, created: false });
    }
  }
  if (policy.policy_ref !== undefined && !isText(policy.policy_ref)) throw new ControlSurfaceError('INVALID_REQUEST', 'policy.policy_ref must be nonempty text');
  const config = { ...DEFAULT_SURFACE_POLICY, ...policy };
  const jobs = new Map();
  const attention = new Map();
  const acknowledgements = [];
  const journal = [];
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isRealInstant(produced)) throw new ControlSurfaceError('INVALID_CLOCK', 'clock() must return a real ISO-8601 UTC instant');
    return produced;
  };

  const atFrom = when => {
    if (when === undefined || when === null) return now();
    if (!isRealInstant(when)) throw new ControlSurfaceError('INVALID_REQUEST', 'at must be a real ISO-8601 UTC instant, got ' + String(when));
    return when;
  };

  const cloneOrRefuse = (value, what) => {
    try {
      return clone(value);
    } catch (error) {
      throw new ControlSurfaceError('INVALID_REQUEST', what + ' must be cloneable: ' + String(error?.message ?? error));
    }
  };

  /**
   * The optional Shared Task Core seam: when a core is wired in, it confirms the canonical binding and the
   * lease before a job exists. Without one the surface keeps working and says the binding is caller-declared.
   */
  const confirmBinding = (canonical_task_ref, lease_ref, executor_connector_ref) => {
    if (taskCore === null) return { confirmed: false, checked_here: false };
    if (typeof taskCore.confirmBinding !== 'function') throw new ControlSurfaceError('INVALID_REQUEST', 'taskCore must expose confirmBinding');
    let verdict = null;
    try {
      verdict = taskCore.confirmBinding({ canonical_task_ref, lease_ref, executor_connector_ref });
    } catch (error) {
      throw new ControlSurfaceError('CANONICAL_TASK_REQUIRED', 'the shared task core failed to confirm the binding: ' + String(error?.message ?? error), { canonical_task_ref, confirmed_by_core: false });
    }
    if (!isPlainObject(verdict) || verdict.confirmed !== true) {
      throw new ControlSurfaceError('CANONICAL_TASK_REQUIRED', 'the shared task core did not confirm ' + String(canonical_task_ref), { canonical_task_ref, lease_ref: lease_ref ?? null, confirmed_by_core: false });
    }
    return { confirmed: true, checked_here: true };
  };

  const note = (event, at, detail = {}) => {
    journal.push(freeze({ event, at, ...detail }));
    return journal.length - 1;
  };

  const requireJob = job_ref => {
    const job = jobs.get(job_ref);
    if (!job) throw new ControlSurfaceError('UNKNOWN_JOB', `no engineering job ${String(job_ref)}`);
    return job;
  };

  const projectJob = job => freeze({
    contract_version: CONTROL_SURFACE_CONTRACT_VERSION,
    job_ref: job.job_ref,
    canonical_task_ref: job.canonical_task_ref,
    canonical_action_ref: job.canonical_action_ref,
    task_truth_source: 'SHARED_TASK_CORE',
    manager_creates_canonical_truth: false,
    execution_responsibility: job.execution_responsibility,
    execution_responsibility_source: job.binding_confirmed_by_core === true ? 'SHARED_TASK_CORE_CONFIRMED' : 'CALLER_DECLARED_CANONICAL_TASK_BINDING',
    canonical_binding_confirmed_by_core: job.binding_confirmed_by_core === true,
    task_truth_verified_here: job.binding_confirmed_by_core === true,
    lease_verified_here: job.binding_confirmed_by_core === true,
    lease_ref: job.lease_ref,
    state: job.state,
    terminal: TERMINAL_JOB_STATES.includes(job.state),
    logical_owner_ref: job.logical_owner_ref,
    executor_connector_ref: job.executor_connector_ref,
    executor_device_ref: job.executor_device_ref,
    // Separation is between the logical owner/coordinator and the executor connector: comparing an owner
    // reference with a device reference would report separation between two different namespaces.
    owner_and_executor_separated: job.logical_owner_ref !== job.executor_connector_ref,
    executor_connector_is_logical_owner: job.logical_owner_ref === job.executor_connector_ref,
    interaction_device_ref: job.interaction_device_ref,
    interaction_device_is_execution_device: job.interaction_device_ref === job.executor_device_ref,
    stage: job.stage,
    progress_events: job.progress.length,
    artifacts: clone(job.artifacts),
    result: job.result === null ? null : clone(job.result),
    eligibility: job.eligibility,
    remote_fallback: job.remote_fallback === null ? null : clone(job.remote_fallback),
    attention_refs: freeze(clone(job.attention_refs)),
    // Derived from the canonical attention ledger, never asserted: a pending projection is attention-required.
    attention_required: job.attention_refs.some(ref => attention.get(ref)?.state === 'PENDING'),
    // Success is published only for a job that reached a terminal accepted result.
    shows_success: job.state === 'SUCCEEDED' && job.result !== null && job.result.accepted === true,
    at: job.updated_at,
  });

  const api = {
    policy: () => freeze(clone(config)),
    views: () => freeze([...SURFACE_VIEWS]),

    /** Bind an Engineering job to canonical shared task/action state. */
    submit({ job_ref, canonical_task_ref, canonical_action_ref = null, logical_owner_ref, executor_connector_ref, executor_device_ref = null, interaction_device_ref, lease_ref = null, eligibility = 'LOCAL_ALLOWED', authorized_devices = null, at: when } = {}) {
      if (!isText(job_ref)) throw new ControlSurfaceError('INVALID_REQUEST', 'job_ref is required');
      if (jobs.has(job_ref)) throw new ControlSurfaceError('DUPLICATE_JOB', `job ${job_ref} is already bound`, { job_ref });
      if (config.require_canonical_task === true && !isText(canonical_task_ref)) {
        throw new ControlSurfaceError('CANONICAL_TASK_REQUIRED', 'an engineering job must bind to a canonical shared task; it may not invent its own truth', {
          job_ref, canonical_task_ref: null, manager_creates_canonical_truth: false,
        });
      }
      // One lease drives one job: a lease claimed twice would be two executions of the same responsibility.
      if (isText(lease_ref) && [...jobs.values()].some(job => job.lease_ref === lease_ref)) {
        throw new ControlSurfaceError('DUPLICATE_JOB', 'lease ' + lease_ref + ' is already claimed by another engineering job', { job_ref, lease_ref, duplicate_execution_prevented: true });
      }
      if (!isText(logical_owner_ref) || !isText(executor_connector_ref) || !isText(interaction_device_ref)) {
        throw new ControlSurfaceError('INVALID_REQUEST', 'logical_owner_ref, executor_connector_ref and interaction_device_ref are required');
      }
      if (!ELIGIBILITY.includes(eligibility)) throw new ControlSurfaceError('INVALID_REQUEST', `eligibility must be one of ${ELIGIBILITY.join(', ')}`);
      const binding = confirmBinding(canonical_task_ref, lease_ref, executor_connector_ref);
      const at = atFrom(when);
      counter += 1;
      const authorized = [...new Set([interaction_device_ref, ...(Array.isArray(authorized_devices) ? authorized_devices.filter(isText) : [])])];
      const job = {
        job_ref,
        canonical_task_ref,
        canonical_action_ref,
        // The responsibility label is the author's contract; whether a core confirmed it is stated separately.
        execution_responsibility: 'OBTAINED_FROM_SHARED_TASK_CORE',
        binding_confirmed_by_core: binding.confirmed === true,
        lease_ref,
        state: 'SUBMITTED',
        logical_owner_ref,
        executor_connector_ref,
        // A connector reference is not a device reference: an unreported execution device stays unknown.
        executor_device_ref: isText(executor_device_ref) ? executor_device_ref : null,
        authorized_devices: freeze(authorized),
        interaction_device_ref,
        stage: 'SUBMITTED',
        progress: [],
        artifacts: [],
        result: null,
        eligibility,
        remote_fallback: null,
        attention_refs: [],
        created_at: at,
        updated_at: at,
      };
      jobs.set(job_ref, job);
      note('JOB_SUBMITTED', at, { job_ref, canonical_task_ref });
      return projectJob(job);
    },

    /** The one canonical view Web and Android both render; no per-device job copy exists. */
    status({ job_ref, at: when } = {}) {
      const job = requireJob(job_ref);
      const at = atFrom(when);
      return freeze({
        ...projectJob(job),
        surface_view: 'STATUS',
        same_job_for_every_surface: true,
        duplicate_execution: false,
        per_device_job_copy: false,
        at,
      });
    },

    progress({ job_ref, kind = 'PROGRESS', stage = null, detail_ref = null, at: when } = {}) {
      const job = requireJob(job_ref);
      // Terminal is a state fact, not a result fact: a cancelled job carries no result and is still finished.
      if (TERMINAL_JOB_STATES.includes(job.state)) {
        throw new ControlSurfaceError('FALSE_SUCCESS_REFUSED', 'job ' + job_ref + ' is already ' + job.state, { job_ref, state: job.state, progress_recorded: false });
      }
      // A blocking canonical question means the backend is waiting on the user, not progressing.
      if (job.attention_refs.some(ref => attention.get(ref)?.state === 'PENDING' && attention.get(ref)?.blocking === true)) {
        throw new ControlSurfaceError('ATTENTION_REQUIRED', 'job ' + job_ref + ' is attention-required; progress cannot be reported while it waits on the user', { job_ref, attention_required: true, progress_recorded: false });
      }
      const at = atFrom(when);
      counter += 1;
      const event = freeze({
        contract_version: CONTROL_SURFACE_CONTRACT_VERSION,
        event_ref: `${job_ref}:event:${(REF_SEQ += 1)}`,
        job_ref,
        canonical_task_ref: job.canonical_task_ref,
        kind,
        stage: stage ?? job.stage,
        detail_ref,
        terminal: false,
        progress_is_not_success: true,
        at,
      });
      job.progress.push(event);
      if (stage !== null) job.stage = stage;
      if (job.state === 'SUBMITTED' || job.state === 'QUEUED') job.state = 'RUNNING';
      job.updated_at = at;
      note('JOB_PROGRESS', at, { job_ref, kind });
      return freeze({ ...clone(event), state: job.state });
    },

    /**
     * Remote fallback is offered and requires explicit approval: a faster remote machine is never auto-picked,
     * and work that is allowed (or throttled) locally stays local.
     */
    proposeRemoteFallback({ job_ref, remote_device_ref, reason = 'LOCAL_THROTTLED', at: when } = {}) {
      const job = requireJob(job_ref);
      if (!isText(remote_device_ref)) throw new ControlSurfaceError('INVALID_REQUEST', 'remote_device_ref is required');
      const at = atFrom(when);
      if (job.eligibility === 'LOCAL_ALLOWED') {
        throw new ControlSurfaceError('LOCAL_WORK_MUST_STAY_LOCAL', `job ${job_ref} is allowed to run locally and must not be moved for speed`, {
          job_ref, eligibility: job.eligibility, auto_selected_faster_machine: false,
        });
      }
      const proposal = freeze({
        contract_version: CONTROL_SURFACE_CONTRACT_VERSION,
        proposal_ref: `${job_ref}:fallback:${(REF_SEQ += 1)}`,
        job_ref,
        canonical_task_ref: job.canonical_task_ref,
        remote_device_ref,
        reason,
        requires_explicit_approval: true,
        approved: false,
        auto_selected: false,
        local_first_respected: config.local_first === true,
        interaction_device_ref: job.interaction_device_ref,
        execution_device_ref: job.executor_device_ref,
        user_navigated_to_execution_host: false,
        at,
      });
      job.remote_fallback = proposal;
      note('REMOTE_FALLBACK_PROPOSED', at, { job_ref, remote_device_ref });
      return proposal;
    },

    approveRemoteFallback({ job_ref, proposal_ref, approved = false, approved_by = null, at: when } = {}) {
      const job = requireJob(job_ref);
      const proposal = job.remote_fallback;
      if (proposal === null || proposal.proposal_ref !== proposal_ref) throw new ControlSurfaceError('INVALID_REQUEST', 'no fallback proposal ' + String(proposal_ref) + ' for ' + job_ref);
      // An approval is tied to a device connected to the job when one is named.
      const connectedDevices = [...job.authorized_devices, ...(isText(job.executor_device_ref) ? [job.executor_device_ref] : [])];
      if (approved_by !== null && !connectedDevices.includes(approved_by)) {
        throw new ControlSurfaceError('NOT_AUTHORIZED_TO_CONTROL', String(approved_by) + ' is not connected to ' + job_ref + ' and may not approve a fallback', { job_ref, approved_by, authorized_devices: freeze(clone(connectedDevices)), applied: false });
      }
      const at = atFrom(when);
      if (approved !== true) {
        return freeze({ ...clone(proposal), approved: false, applied: false, work_stays_local: job.eligibility !== 'REMOTE_REQUIRED', reason: 'USER_DECLINED' });
      }
      const alreadyApproved = proposal.approved === true;
      // The local eligibility verdict is a fact about the work: approving remote execution records where the
      // job will actually run instead of rewriting the verdict that was computed for it.
      job.remote_fallback = freeze({ ...proposal, approved: true, approved_by, approved_at: at, applied: true, local_eligibility_verdict: job.eligibility, effective_execution_target: 'REMOTE' });
      job.executor_device_ref = proposal.remote_device_ref;
      job.updated_at = at;
      note('REMOTE_FALLBACK_APPROVED', at, { job_ref, remote_device_ref: proposal.remote_device_ref });
      return freeze({
        ...clone(job.remote_fallback),
        duplicate: alreadyApproved,
        local_eligibility_verdict: job.eligibility,
        effective_execution_target: 'REMOTE',
        interaction_device_ref: job.interaction_device_ref,
        executor_device_ref: job.executor_device_ref,
        interaction_device_is_execution_device: job.interaction_device_ref === job.executor_device_ref,
        user_navigated_to_execution_host: false,
        control_stays_on_interaction_surface: true,
      });
    },

    /** A second Engineering-global attention store is refused: attention is projected from shared state. */
    registerAttentionStore({ store_ref } = {}) {
      throw new ControlSurfaceError('SECOND_ATTENTION_STORE_REFUSED', 'attention is projected from canonical shared Attention state; Engineering holds no second global store', {
        store_ref: store_ref ?? null, projection_sources: freeze([...config.attention_projection_sources]), created: false,
      });
    },

    /** Attention is projected from shared state and acknowledged once, reconciling every device view. */
    projectAttention({ job_ref, attention_ref, question, blocking = true, source = 'SHARED_CORE_ATTENTION', at: when } = {}) {
      const job = requireJob(job_ref);
      if (!isText(attention_ref) || !isText(question)) throw new ControlSurfaceError('INVALID_REQUEST', 'attention_ref and question are required');
      if (typeof blocking !== 'boolean') throw new ControlSurfaceError('INVALID_REQUEST', 'blocking must be a boolean');
      // A finished job is not re-opened for attention, and a canonical attention reference is written once.
      if (TERMINAL_JOB_STATES.includes(job.state)) {
        throw new ControlSurfaceError('FALSE_SUCCESS_REFUSED', 'job ' + job_ref + ' is ' + job.state + '; a finished job cannot be re-opened for attention', { job_ref, state: job.state, re_opened: false });
      }
      const existing = attention.get(attention_ref);
      if (existing !== undefined) {
        if (existing.state === 'ACKNOWLEDGED') {
          throw new ControlSurfaceError('ALREADY_ACKNOWLEDGED', 'attention ' + attention_ref + ' was already acknowledged and is not re-opened', { attention_ref, job_ref, state: existing.state, re_opened: false });
        }
        throw new ControlSurfaceError('DUPLICATE_JOB', 'attention ' + attention_ref + ' is already pending for ' + String(existing.job_ref), { attention_ref, job_ref: existing.job_ref, state: existing.state });
      }
      if (!config.attention_projection_sources.includes(source)) throw new ControlSurfaceError('SECOND_ATTENTION_STORE_REFUSED', 'attention must come from ' + config.attention_projection_sources.join(', '), { source });
      const at = atFrom(when);
      const entry = freeze({
        contract_version: CONTROL_SURFACE_CONTRACT_VERSION,
        attention_ref,
        job_ref,
        canonical_task_ref: job.canonical_task_ref,
        question,
        blocking,
        state: 'PENDING',
        source,
        projection_of_shared_state: true,
        engineering_global_store: false,
        delivered_to_interaction_device: job.interaction_device_ref,
        created_at: at,
      });
      attention.set(attention_ref, entry);
      job.attention_refs.push(attention_ref);
      job.state = 'WAITING_CONFIRMATION';
      job.updated_at = at;
      note('ATTENTION_PROJECTED', at, { job_ref, attention_ref });
      return freeze({ ...clone(entry), acknowledged_by: [] });
    },

    acknowledgeAttention({ attention_ref, device_ref, at: when } = {}) {
      const entry = attention.get(attention_ref);
      if (!entry) throw new ControlSurfaceError('UNKNOWN_ATTENTION', 'no attention ' + String(attention_ref));
      if (!isText(device_ref)) throw new ControlSurfaceError('INVALID_REQUEST', 'device_ref is required to acknowledge attention');
      // Only a device connected to the job may answer its canonical question.
      const subject = jobs.get(entry.job_ref);
      const connected = subject === undefined ? [] : [...subject.authorized_devices, ...(isText(subject.executor_device_ref) ? [subject.executor_device_ref] : [])];
      if (!connected.includes(device_ref)) {
        throw new ControlSurfaceError('NOT_AUTHORIZED_TO_CONTROL', String(device_ref) + ' is not connected to the job that raised ' + String(attention_ref), { attention_ref, job_ref: entry.job_ref ?? null, device_ref, applied: false });
      }
      const at = atFrom(when);
      if (entry.state === 'ACKNOWLEDGED') {
        return freeze({ ...clone(entry), acknowledged_by: freeze(acknowledgements.filter(entryRef => entryRef.attention_ref === attention_ref).map(entryRef => entryRef.device_ref)), duplicate: true, reconciles_all_projections: true, second_acknowledgement_needed: false });
      }
      // The acknowledgement is bound to the subject it answers, not only to the device that acted.
      const acknowledgement = freeze({ attention_ref, device_ref, job_ref: entry.job_ref, subject_ref: entry.job_ref, at, reconciles_all_projections: true, second_acknowledgement_needed: false });
      acknowledgements.push(acknowledgement);
      const updated = freeze({ ...entry, state: 'ACKNOWLEDGED', acknowledged_at: at, acknowledged_by_device_ref: device_ref });
      attention.set(attention_ref, updated);
      note('ATTENTION_ACKNOWLEDGED', at, { attention_ref, device_ref });
      return freeze({ ...clone(updated), acknowledged_by: freeze([device_ref]), duplicate: false, reconciles_all_projections: true, other_devices_reconciled: true, second_acknowledgement_needed: false });
    },

    attentionFor({ job_ref, at: when } = {}) {
      const job = requireJob(job_ref);
      const at = atFrom(when);
      return freeze({
        contract_version: CONTROL_SURFACE_CONTRACT_VERSION,
        job_ref,
        attention: freeze(job.attention_refs.map(ref => clone(attention.get(ref))).filter(Boolean)),
        pending_count: job.attention_refs.filter(ref => attention.get(ref)?.state === 'PENDING').length,
        // Derived from the entries themselves: true only while every projection came from the shared source.
        from_shared_state: job.attention_refs.every(ref => attention.get(ref)?.projection_of_shared_state === true),
        engineering_global_store: false,
        delivered_to_interaction_device: job.interaction_device_ref,
        at,
      });
    },

    /** Only a terminal accepted result may be shown as success. */
    applyResult({ job_ref, state, result_ref = null, artifacts = [], at: when } = {}) {
      const job = requireJob(job_ref);
      if (!JOB_STATES.includes(state)) throw new ControlSurfaceError('INVALID_REQUEST', `state must be one of ${JOB_STATES.join(', ')}`);
      if (!TERMINAL_JOB_STATES.includes(state)) {
        throw new ControlSurfaceError('NOT_TERMINAL_ACCEPTED', 'a user-visible success may only come from a terminal accepted result', {
          job_ref, requested_state: state, terminal: false, dispatch_is_not_success: true,
        });
      }
      const at = atFrom(when);
      // The first terminal result is the job truth: a later report may not rewrite it.
      if (TERMINAL_JOB_STATES.includes(job.state)) {
        throw new ControlSurfaceError('FALSE_SUCCESS_REFUSED', 'job ' + job_ref + ' is already ' + job.state + '; its canonical result is not rewritten', { job_ref, existing_state: job.state, requested_state: state, rewritten: false });
      }
      // Validate before mutating: a refused result must leave no partial state behind.
      if (state === 'SUCCEEDED' && !isText(result_ref)) {
        throw new ControlSurfaceError('NOT_TERMINAL_ACCEPTED', 'a success needs an accepted result reference', { job_ref, result_ref: null });
      }
      // A backend that is waiting on the user is attention-required, not successful.
      if (state === 'SUCCEEDED' && job.attention_refs.some(ref => attention.get(ref)?.state === 'PENDING')) {
        throw new ControlSurfaceError('FALSE_SUCCESS_REFUSED', 'job ' + job_ref + ' has pending canonical attention and cannot be shown as success', { job_ref, attention_refs: freeze(clone(job.attention_refs)), backend_attention_required: true });
      }
      if (artifacts !== undefined && artifacts !== null && !Array.isArray(artifacts)) throw new ControlSurfaceError('INVALID_REQUEST', 'artifacts must be an array');
      const artifactList = Array.isArray(artifacts) ? artifacts : [];
      const malformedArtifacts = artifactList.filter(artifact => !isPlainObject(artifact) || !isText(artifact.artifact_ref));
      // A malformed artifact is refused rather than silently dropped from the accepted result.
      if (malformedArtifacts.length > 0) throw new ControlSurfaceError('INVALID_REQUEST', 'every artifact needs a canonical artifact_ref', { job_ref, malformed_count: malformedArtifacts.length });
      const acceptedArtifacts = artifactList.map(artifact => freeze(cloneOrRefuse(artifact, 'an artifact')));
      job.state = state;
      job.updated_at = at;
      job.artifacts = freeze([...clone(job.artifacts), ...acceptedArtifacts]);
      if (state === 'SUCCEEDED') {
        if (!isText(result_ref)) throw new ControlSurfaceError('NOT_TERMINAL_ACCEPTED', 'a success needs an accepted result reference', { job_ref, result_ref: null });
        job.result = freeze({
          contract_version: CONTROL_SURFACE_CONTRACT_VERSION,
          result_ref,
          accepted: true,
          accepted_as_truth: true,
          terminal_state: state,
          canonical_task_ref: job.canonical_task_ref,
          artifacts: freeze(clone(acceptedArtifacts)),
          accepted_at: at,
        });
      } else {
        // A failure, refusal or cancellation is accepted as the truth of the job, never as a success.
        job.result = freeze({ contract_version: CONTROL_SURFACE_CONTRACT_VERSION, result_ref, accepted: state === 'SUCCEEDED', accepted_as_truth: true, terminal_state: state, canonical_task_ref: job.canonical_task_ref, artifacts: freeze(clone(acceptedArtifacts)), accepted_at: at });
      }
      job.stage = state;
      note('JOB_RESULT', at, { job_ref, state });
      return freeze({
        ...projectJob(job),
        surface_view: 'RESULT',
        user_visible_success: state === 'SUCCEEDED',
        success_source: state === 'SUCCEEDED' ? 'TERMINAL_ACCEPTED_ENGINEERING_RESULT' : null,
        dispatch_is_not_success: true,
      });
    },

    /** Advanced/debug provenance: identifiers only, never secret material. */
    provenance({ job_ref, provenance = {}, at: when } = {}) {
      const job = requireJob(job_ref);
      if (!isPlainObject(provenance)) throw new ControlSurfaceError('INVALID_REQUEST', 'provenance must be a plain record of canonical fields', { stored: false });
      const at = atFrom(when);
      // A secret-shaped key is reported as such rather than as a generic unknown field.
      const secrets = findSecretFields(provenance);
      if (secrets.length > 0) throw new ControlSurfaceError('SECRET_MATERIAL_REFUSED', `provenance carries secret-shaped material at ${secrets.join(', ')}`, { job_ref, fields: freeze(secrets), stored: false });
      const unknown = Object.keys(provenance).filter(key => !PROVENANCE_FIELDS.includes(key));
      if (unknown.length > 0) throw new ControlSurfaceError('INVALID_REQUEST', unknown.join(', ') + ' is not a canonical provenance field', { allowed: freeze([...PROVENANCE_FIELDS]) });
      // A provenance field is a reference or nothing: an object here could carry secret material past the
      // key-name scan while the surface reports that provenance is secret-free.
      const notReferences = Object.keys(provenance).filter(key => provenance[key] !== null && !isText(provenance[key]));
      if (notReferences.length > 0) throw new ControlSurfaceError('INVALID_REQUEST', notReferences.join(', ') + ' must be a reference or null', { job_ref, fields: freeze(notReferences), references_only: true });
      job.provenance = freeze(cloneOrRefuse(provenance, 'provenance'));
      note('PROVENANCE_VIEWED', at, { job_ref });
      return freeze({
        contract_version: CONTROL_SURFACE_CONTRACT_VERSION,
        job_ref,
        canonical_task_ref: job.canonical_task_ref,
        provenance: clone(job.provenance),
        advanced_view: true,
        contains_secret_material: false,
        references_only: true,
        at,
      });
    },

    /** Control is available on the interaction surface, not by sending the user elsewhere. */
    control({ job_ref, operation, by_device_ref = null, at: when } = {}) {
      const job = requireJob(job_ref);
      if (!['CANCEL', 'RETRY', 'PAUSE', 'RESUME'].includes(operation)) throw new ControlSurfaceError('INVALID_REQUEST', 'operation must be CANCEL, RETRY, PAUSE or RESUME');
      const controlDevice = by_device_ref ?? job.interaction_device_ref;
      // Authority is bound to the job: a device the job never authorized may not control it.
      if (!job.authorized_devices.includes(controlDevice)) {
        throw new ControlSurfaceError('NOT_AUTHORIZED_TO_CONTROL', String(controlDevice) + ' is not authorized to control ' + job_ref, { job_ref, by_device_ref: controlDevice, authorized_devices: freeze(clone(job.authorized_devices)), applied: false });
      }
      if (TERMINAL_JOB_STATES.includes(job.state) && operation !== 'RETRY') {
        throw new ControlSurfaceError('FALSE_SUCCESS_REFUSED', 'job ' + job_ref + ' is ' + job.state, { job_ref, state: job.state, applied: false });
      }
      // A retry re-queues failed work only: retrying a success, a cancellation or a live job would duplicate
      // execution of the same canonical task.
      if (operation === 'RETRY' && job.state !== 'FAILED') {
        const revival = TERMINAL_JOB_STATES.includes(job.state);
        throw new ControlSurfaceError(revival ? 'FALSE_SUCCESS_REFUSED' : 'DUPLICATE_JOB', 'a retry is only valid for a failed job; ' + job_ref + ' is ' + job.state, { job_ref, state: job.state, retry_allowed_from: freeze(['FAILED']), duplicate_execution_prevented: !revival, applied: false });
      }
      if (operation === 'RESUME' && job.attention_refs.some(ref => attention.get(ref)?.state === 'PENDING' && attention.get(ref)?.blocking === true)) {
        throw new ControlSurfaceError('ATTENTION_REQUIRED', 'job ' + job_ref + ' is attention-required; it cannot resume while it waits on the user', { job_ref, attention_required: true, resumed: false });
      }
      const at = atFrom(when);
      if (operation === 'CANCEL') { job.state = 'CANCELLED'; job.stage = 'CANCELLED'; }
      if (operation === 'PAUSE') { job.state = 'WAITING_CONFIRMATION'; job.stage = 'PAUSED'; }
      if (operation === 'RESUME') { job.state = 'RUNNING'; job.stage = 'RUNNING'; }
      if (operation === 'RETRY') { job.state = 'QUEUED'; job.stage = 'RETRY_QUEUED'; }
      job.updated_at = at;
      note('JOB_CONTROLLED', at, { job_ref, operation, by_device_ref: controlDevice });
      return freeze({
        contract_version: CONTROL_SURFACE_CONTRACT_VERSION,
        job_ref,
        operation,
        applied: true,
        state: job.state,
        controlled_from: controlDevice,
        controlled_from_execution_device: isText(job.executor_device_ref) && controlDevice === job.executor_device_ref,
        interaction_device_ref: job.interaction_device_ref,
        execution_device_ref: job.executor_device_ref,
        user_navigated_to_execution_host: false,
        control_on_shared_surface: true,
        at,
      });
    },

    /** The surface statement a Web/Android client can assert against. */
    surfaceContract() {
      return freeze({
        contract_version: CONTROL_SURFACE_CONTRACT_VERSION,
        views: freeze([...SURFACE_VIEWS]),
        one_canonical_job_per_web_and_android: true,
        duplicate_execution: false,
        foreground_may_differ_from_execution: true,
        remote_fallback_requires_approval: true,
        auto_selects_faster_remote_machine: false,
        local_allowed_work_stays_local: true,
        attention_from_shared_state: true,
        engineering_global_attention_store: false,
        control_stays_on_interaction_surface: true,
        user_navigated_to_execution_host: false,
        success_source: 'TERMINAL_ACCEPTED_ENGINEERING_RESULT',
        dispatch_is_not_success: true,
        progress_is_not_success: true,
        provenance_is_secret_free: true,
        task_truth_source: 'SHARED_TASK_CORE',
        // Structural statements about this surface, not facts verified against a task core here.
        claims_scope: 'SURFACE_STRUCTURE',
        claims_verified_here: false,
        task_truth_verified_here: false,
      });
    },

    jobs: () => freeze(clone([...jobs.values()]).map(job => projectJob(job))),
    job: job_ref => {
      const job = jobs.get(job_ref);
      return job ? projectJob(job) : null;
    },
    attentionEntries: () => freeze(clone([...attention.values()])),
    acknowledgements: () => freeze(clone(acknowledgements)),
    journal: () => freeze(clone(journal)),
  };
  return Object.freeze(api);
}
