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

export const SURFACE_VIEWS = Object.freeze(['SUBMIT', 'STATUS', 'PROGRESS', 'STAGE', 'ATTENTION', 'CONTROL', 'RESULT', 'ARTIFACT']);
export const JOB_STATES = Object.freeze(['SUBMITTED', 'QUEUED', 'RUNNING', 'WAITING_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED', 'UNKNOWN']);
export const TERMINAL_JOB_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED']);
export const ELIGIBILITY = Object.freeze(['LOCAL_ALLOWED', 'LOCAL_THROTTLED', 'LOCAL_BLOCKED', 'REMOTE_REQUIRED']);
export const ATTENTION_STATES = Object.freeze(['PENDING', 'ACKNOWLEDGED', 'EXPIRED', 'WITHDRAWN']);
export const PROVENANCE_FIELDS = Object.freeze(['connector_ref', 'backend_run_ref', 'device_ref', 'branch_ref', 'commit_ref', 'test_ref', 'error_ref']);
export const SECRET_KEY_SHAPE = /(secret|token|password|api_?key|private_?key|session_key|credential_value|^value$)/i;

export const CONTROL_SURFACE_CODES = Object.freeze([
  'INVALID_REQUEST', 'INVALID_CLOCK', 'UNKNOWN_JOB', 'DUPLICATE_JOB', 'CANONICAL_TASK_REQUIRED',
  'FALSE_SUCCESS_REFUSED', 'REMOTE_FALLBACK_REQUIRES_APPROVAL', 'LOCAL_WORK_MUST_STAY_LOCAL',
  'UNKNOWN_ATTENTION', 'ALREADY_ACKNOWLEDGED', 'SECOND_ATTENTION_STORE_REFUSED', 'NOT_TERMINAL_ACCEPTED',
  'SECRET_MATERIAL_REFUSED', 'EXECUTOR_NOT_SEPARATED',
]);

const CONFLICT_CODES = new Set(['DUPLICATE_JOB', 'FALSE_SUCCESS_REFUSED', 'REMOTE_FALLBACK_REQUIRES_APPROVAL', 'LOCAL_WORK_MUST_STAY_LOCAL', 'ALREADY_ACKNOWLEDGED', 'SECOND_ATTENTION_STORE_REFUSED', 'NOT_TERMINAL_ACCEPTED']);

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

export const DEFAULT_SURFACE_POLICY = Object.freeze({
  policy_ref: 'policy:em-control-surface-default',
  require_canonical_task: true,
  local_first: true,
  attention_projection_sources: Object.freeze(['SHARED_CORE_ATTENTION']),
});

export function createEngineeringControlSurface({ clock = () => new Date().toISOString(), policy = {} } = {}) {
  if (typeof clock !== 'function') throw new ControlSurfaceError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  const config = { ...DEFAULT_SURFACE_POLICY, ...(isPlainObject(policy) ? policy : {}) };
  const jobs = new Map();
  const attention = new Map();
  const acknowledgements = [];
  const journal = [];
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isIsoInstant(produced)) throw new ControlSurfaceError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
    return produced;
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
    lease_ref: job.lease_ref,
    state: job.state,
    terminal: TERMINAL_JOB_STATES.includes(job.state),
    logical_owner_ref: job.logical_owner_ref,
    executor_connector_ref: job.executor_connector_ref,
    executor_device_ref: job.executor_device_ref,
    owner_and_executor_separated: job.logical_owner_ref !== job.executor_device_ref,
    interaction_device_ref: job.interaction_device_ref,
    interaction_device_is_execution_device: job.interaction_device_ref === job.executor_device_ref,
    stage: job.stage,
    progress_events: job.progress.length,
    artifacts: clone(job.artifacts),
    result: job.result === null ? null : clone(job.result),
    eligibility: job.eligibility,
    remote_fallback: job.remote_fallback === null ? null : clone(job.remote_fallback),
    attention_refs: freeze(clone(job.attention_refs)),
    at: job.updated_at,
  });

  const api = {
    policy: () => freeze(clone(config)),
    views: () => freeze([...SURFACE_VIEWS]),

    /** Bind an Engineering job to canonical shared task/action state. */
    submit({ job_ref, canonical_task_ref, canonical_action_ref = null, logical_owner_ref, executor_connector_ref, executor_device_ref = null, interaction_device_ref, lease_ref = null, eligibility = 'LOCAL_ALLOWED', at: when } = {}) {
      if (!isText(job_ref)) throw new ControlSurfaceError('INVALID_REQUEST', 'job_ref is required');
      if (jobs.has(job_ref)) throw new ControlSurfaceError('DUPLICATE_JOB', `job ${job_ref} is already bound`, { job_ref });
      if (config.require_canonical_task === true && !isText(canonical_task_ref)) {
        throw new ControlSurfaceError('CANONICAL_TASK_REQUIRED', 'an engineering job must bind to a canonical shared task; it may not invent its own truth', {
          job_ref, canonical_task_ref: null, manager_creates_canonical_truth: false,
        });
      }
      if (!isText(logical_owner_ref) || !isText(executor_connector_ref) || !isText(interaction_device_ref)) {
        throw new ControlSurfaceError('INVALID_REQUEST', 'logical_owner_ref, executor_connector_ref and interaction_device_ref are required');
      }
      if (!ELIGIBILITY.includes(eligibility)) throw new ControlSurfaceError('INVALID_REQUEST', `eligibility must be one of ${ELIGIBILITY.join(', ')}`);
      const at = when ?? now();
      counter += 1;
      const job = {
        job_ref,
        canonical_task_ref,
        canonical_action_ref,
        execution_responsibility: 'OBTAINED_FROM_SHARED_TASK_CORE',
        lease_ref,
        state: 'SUBMITTED',
        logical_owner_ref,
        executor_connector_ref,
        executor_device_ref: executor_device_ref ?? executor_connector_ref,
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
      const at = when ?? now();
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
      if (job.result !== null) throw new ControlSurfaceError('FALSE_SUCCESS_REFUSED', `job ${job_ref} is already terminal`, { job_ref, state: job.state });
      const at = when ?? now();
      counter += 1;
      const event = freeze({
        contract_version: CONTROL_SURFACE_CONTRACT_VERSION,
        event_ref: `${job_ref}:event:${job.progress.length + 1}`,
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
      const at = when ?? now();
      if (job.eligibility === 'LOCAL_ALLOWED') {
        throw new ControlSurfaceError('LOCAL_WORK_MUST_STAY_LOCAL', `job ${job_ref} is allowed to run locally and must not be moved for speed`, {
          job_ref, eligibility: job.eligibility, auto_selected_faster_machine: false,
        });
      }
      const proposal = freeze({
        contract_version: CONTROL_SURFACE_CONTRACT_VERSION,
        proposal_ref: `${job_ref}:fallback:${counter + 1}`,
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

    approveRemoteFallback({ job_ref, proposal_ref, approved = false, at: when } = {}) {
      const job = requireJob(job_ref);
      const proposal = job.remote_fallback;
      if (proposal === null || proposal.proposal_ref !== proposal_ref) throw new ControlSurfaceError('INVALID_REQUEST', `no fallback proposal ${String(proposal_ref)} for ${job_ref}`);
      const at = when ?? now();
      if (approved !== true) {
        return freeze({ ...clone(proposal), approved: false, applied: false, work_stays_local: job.eligibility !== 'REMOTE_REQUIRED', reason: 'USER_DECLINED' });
      }
      job.remote_fallback = freeze({ ...proposal, approved: true, approved_at: at, applied: true });
      job.executor_device_ref = proposal.remote_device_ref;
      job.eligibility = 'REMOTE_REQUIRED';
      job.updated_at = at;
      note('REMOTE_FALLBACK_APPROVED', at, { job_ref, remote_device_ref: proposal.remote_device_ref });
      return freeze({
        ...clone(job.remote_fallback),
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
      if (!config.attention_projection_sources.includes(source)) throw new ControlSurfaceError('SECOND_ATTENTION_STORE_REFUSED', `attention must come from ${config.attention_projection_sources.join(', ')}`, { source });
      const at = when ?? now();
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
      if (!entry) throw new ControlSurfaceError('UNKNOWN_ATTENTION', `no attention ${String(attention_ref)}`);
      const at = when ?? now();
      if (entry.state === 'ACKNOWLEDGED') {
        return freeze({ ...clone(entry), acknowledged_by: freeze(acknowledgements.filter(entryRef => entryRef.attention_ref === attention_ref).map(entryRef => entryRef.device_ref)), duplicate: true, reconciles_all_projections: true, second_acknowledgement_needed: false });
      }
      const acknowledgement = freeze({ attention_ref, device_ref, at, reconciles_all_projections: true, second_acknowledgement_needed: false });
      acknowledgements.push(acknowledgement);
      const updated = freeze({ ...entry, state: 'ACKNOWLEDGED', acknowledged_at: at, acknowledged_by_device_ref: device_ref });
      attention.set(attention_ref, updated);
      note('ATTENTION_ACKNOWLEDGED', at, { attention_ref, device_ref });
      return freeze({ ...clone(updated), acknowledged_by: freeze([device_ref]), duplicate: false, reconciles_all_projections: true, other_devices_reconciled: true, second_acknowledgement_needed: false });
    },

    attentionFor({ job_ref, at: when } = {}) {
      const job = requireJob(job_ref);
      const at = when ?? now();
      return freeze({
        contract_version: CONTROL_SURFACE_CONTRACT_VERSION,
        job_ref,
        attention: freeze(job.attention_refs.map(ref => clone(attention.get(ref))).filter(Boolean)),
        pending_count: job.attention_refs.filter(ref => attention.get(ref)?.state === 'PENDING').length,
        from_shared_state: true,
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
      const at = when ?? now();
      // Validate before mutating: a refused result must leave no partial state behind.
      if (state === 'SUCCEEDED' && !isText(result_ref)) {
        throw new ControlSurfaceError('NOT_TERMINAL_ACCEPTED', 'a success needs an accepted result reference', { job_ref, result_ref: null });
      }
      const acceptedArtifacts = (Array.isArray(artifacts) ? artifacts : [])
        .filter(artifact => isPlainObject(artifact) && isText(artifact.artifact_ref))
        .map(artifact => freeze(clone(artifact)));
      job.state = state;
      job.updated_at = at;
      job.artifacts = freeze([...clone(job.artifacts), ...acceptedArtifacts]);
      if (state === 'SUCCEEDED') {
        if (!isText(result_ref)) throw new ControlSurfaceError('NOT_TERMINAL_ACCEPTED', 'a success needs an accepted result reference', { job_ref, result_ref: null });
        job.result = freeze({
          contract_version: CONTROL_SURFACE_CONTRACT_VERSION,
          result_ref,
          accepted: true,
          terminal_state: state,
          canonical_task_ref: job.canonical_task_ref,
          artifacts: freeze(clone(artifacts)),
          accepted_at: at,
        });
      } else {
        job.result = freeze({ contract_version: CONTROL_SURFACE_CONTRACT_VERSION, result_ref, accepted: true, terminal_state: state, canonical_task_ref: job.canonical_task_ref, artifacts: freeze(clone(artifacts)), accepted_at: at });
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
      const at = when ?? now();
      // A secret-shaped key is reported as such rather than as a generic unknown field.
      const secrets = findSecretFields(provenance);
      if (secrets.length > 0) throw new ControlSurfaceError('SECRET_MATERIAL_REFUSED', `provenance carries secret-shaped material at ${secrets.join(', ')}`, { job_ref, fields: freeze(secrets), stored: false });
      const unknown = Object.keys(provenance).filter(key => !PROVENANCE_FIELDS.includes(key));
      if (unknown.length > 0) throw new ControlSurfaceError('INVALID_REQUEST', `${unknown.join(', ')} is not a canonical provenance field`, { allowed: freeze([...PROVENANCE_FIELDS]) });
      job.provenance = freeze({ ...clone(provenance) });
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
      if (TERMINAL_JOB_STATES.includes(job.state) && operation !== 'RETRY') {
        throw new ControlSurfaceError('FALSE_SUCCESS_REFUSED', `job ${job_ref} is ${job.state}`, { job_ref, state: job.state });
      }
      const at = when ?? now();
      if (operation === 'CANCEL') { job.state = 'CANCELLED'; job.stage = 'CANCELLED'; }
      if (operation === 'PAUSE') { job.state = 'WAITING_CONFIRMATION'; job.stage = 'PAUSED'; }
      if (operation === 'RESUME') { job.state = 'RUNNING'; job.stage = 'RUNNING'; }
      if (operation === 'RETRY') { job.state = 'QUEUED'; job.stage = 'RETRY_QUEUED'; }
      job.updated_at = at;
      note('JOB_CONTROLLED', at, { job_ref, operation });
      return freeze({
        contract_version: CONTROL_SURFACE_CONTRACT_VERSION,
        job_ref,
        operation,
        applied: true,
        state: job.state,
        controlled_from: by_device_ref ?? job.interaction_device_ref,
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
      });
    },

    jobs: () => clone([...jobs.values()]).map(job => projectJob(job)),
    job: job_ref => {
      const job = jobs.get(job_ref);
      return job ? projectJob(job) : null;
    },
    attentionEntries: () => clone([...attention.values()]),
    acknowledgements: () => clone(acknowledgements),
    journal: () => clone(journal),
  };
  return Object.freeze(api);
}
