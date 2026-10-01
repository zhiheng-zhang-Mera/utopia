// Foreman queue / DAG / resource scheduling / worker pool (EM-010).
//
// The execution machinery above connectors: an ordered Engineering queue, DAG nodes with depends_on and a
// write scope, isolated writers, resource ceilings with adaptive worker counts and hysteresis, a worker pool
// with bounded retry/reassignment, and inspectable metrics/evidence.
//
// Three guarantees shape the design:
//
//   ORDER/DEPENDENCY  a node runs only when every dependency has SUCCEEDED, and independent nodes may run
//                     concurrently 闁?the scheduler never invents an order it was not given.
//   ISOLATED WRITES   two nodes with overlapping exclusive write scopes may not run at once; the conflict is
//                     *reported* and the second node is deferred, never auto-merged.
//   HONEST OUTCOMES   resource pressure pauses new work and scales workers down without failing completed
//                     work, a restart marks interrupted work INTERRUPTED (not failed, not succeeded), and a
//                     terminal result or an already-applied external side effect is never produced twice.
//
// Connector selection is capability/readiness/auth/placement based through an injected port; this module holds
// no provider-name conditionals, and it references Shared Task Core truth without owning or overriding it.
//
// Pure module: ports and the clock are injected; no network, storage or ambient state.
export const FOREMAN_CONTRACT_VERSION = 1;

export const NODE_STATES = Object.freeze(['PENDING', 'BLOCKED_ON_DEPS', 'READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'INTERRUPTED', 'CANCELLED']);
export const TERMINAL_NODE_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'CANCELLED']);
export const ATTEMPT_STATES = Object.freeze(['RUNNING', 'SUCCEEDED', 'FAILED', 'STALLED', 'CRASHED', 'REASSIGNED', 'INTERRUPTED']);
export const PLACEMENTS = Object.freeze(['LOCAL_FIRST', 'REMOTE_ALLOWED']);
export const RUN_MODES = Object.freeze(['SERIAL', 'PARALLEL']);
export const STALL_KINDS = Object.freeze(['STALL', 'CRASH']);
export const DEPENDENCY_OUTCOMES = Object.freeze(['SATISFIED', 'UNSATISFIED', 'FAILED_DEPENDENCY']);

export const FOREMAN_CODES = Object.freeze([
  'INVALID_REQUEST', 'INVALID_CLOCK', 'INVALID_GRAPH', 'DUPLICATE_NODE', 'UNKNOWN_DEPENDENCY', 'DAG_CYCLE',
  'UNKNOWN_NODE', 'WRITE_CONFLICT', 'NO_CAPABLE_WORKER', 'NO_WORKER_AVAILABLE', 'PAUSED_BY_RESOURCE_PRESSURE',
  'ACCEPTANCE_NOT_RUN', 'ACCEPTANCE_EVIDENCE_REQUIRED', 'TERMINAL_RESULT_IMMUTABLE',
  'DUPLICATE_TERMINAL_RESULT', 'DUPLICATE_SIDE_EFFECT', 'REASSIGNMENT_EXHAUSTED', 'DEPENDENCY_NOT_SATISFIED',
  'INTERRUPTED_REQUIRES_REVALIDATION', 'GRAPH_ALREADY_LOADED',
  'UNKNOWN_ATTEMPT', 'INVALID_TRANSITION',
]);

const CONFLICT_CODES = new Set(['WRITE_CONFLICT', 'DUPLICATE_TERMINAL_RESULT', 'DUPLICATE_SIDE_EFFECT', 'TERMINAL_RESULT_IMMUTABLE', 'PAUSED_BY_RESOURCE_PRESSURE', 'REASSIGNMENT_EXHAUSTED', 'DEPENDENCY_NOT_SATISFIED']);

export class ForemanError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ForemanError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_NODE' || code === 'UNKNOWN_ATTEMPT' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
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
/** Cycle-safe: a caller-supplied structure must not be able to blow the stack. */
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
export const isIsoInstant = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  && !Number.isNaN(Date.parse(value));

const INSTANT_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
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
const callerInstant = (value, label) => {
  if (!isRealInstant(value)) throw new ForemanError('INVALID_REQUEST', `${label} must be a real ISO-8601 UTC instant, got ${String(value)}`);
  return value;
};

const NODE_FIELDS = Object.freeze(['node_id', 'job_ref', 'depends_on', 'write_scope', 'acceptance', 'capability_required', 'exclusive_writes', 'max_attempts', 'task_ref', 'action_key']);
const nullableText = value => value === null || value === undefined || isText(value);

/** A ceiling that can be switched off is not a ceiling: every policy bound is checked, not trusted. */
function validateForemanPolicy(policy) {
  const errors = [];
  const allowed = ['policy_ref', 'max_workers', 'min_workers', 'scale_up_after_ticks', 'scale_down_immediately', 'pressure_pause_threshold', 'max_attempts', 'placement'];
  for (const key of Reflect.ownKeys(policy)) {
    if (typeof key !== 'string' || !allowed.includes(key)) errors.push(`policy.${String(key)} is not part of the foreman policy`);
  }
  for (const key of ['max_workers', 'min_workers', 'scale_up_after_ticks', 'max_attempts']) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1) errors.push(`policy.${key} must be a positive integer, got ${String(policy[key])}`);
  }
  if (Number.isSafeInteger(policy.min_workers) && Number.isSafeInteger(policy.max_workers) && policy.min_workers > policy.max_workers) {
    errors.push('policy.min_workers may not exceed policy.max_workers');
  }
  if (typeof policy.pressure_pause_threshold !== 'number' || !Number.isFinite(policy.pressure_pause_threshold) || policy.pressure_pause_threshold <= 0 || policy.pressure_pause_threshold > 1) {
    errors.push(`policy.pressure_pause_threshold must be a number in (0, 1], got ${String(policy.pressure_pause_threshold)}`);
  }
  if (typeof policy.scale_down_immediately !== 'boolean') errors.push('policy.scale_down_immediately must be a boolean');
  if (!PLACEMENTS.includes(policy.placement)) errors.push(`policy.placement must be one of ${PLACEMENTS.join(', ')}`);
  if (!isText(policy.policy_ref)) errors.push('policy.policy_ref must be nonempty text');
  if (errors.length) throw new ForemanError('INVALID_REQUEST', errors.join('; '));
  return policy;
}

/** Overlap is equality or containment, so `scope:src/` protects everything beneath it. */
export function scopesOverlap(left, right) {
  if (!isText(left) || !isText(right)) return false;
  if (left === right) return true;
  const [leftKind, leftPath = ''] = left.split(':');
  const [rightKind, rightPath = ''] = [right.split(':')[0], right.split(':').slice(1).join(':')];
  if (leftKind !== rightKind) return false;
  const normalize = path => (path.endsWith('/') ? path : `${path}/`);
  return normalize(leftPath).startsWith(normalize(rightPath)) || normalize(rightPath).startsWith(normalize(leftPath));
}

export const DEFAULT_FOREMAN_POLICY = Object.freeze({
  policy_ref: 'policy:em-foreman-default',
  max_workers: 4,
  min_workers: 1,
  scale_up_after_ticks: 2,
  scale_down_immediately: true,
  pressure_pause_threshold: 0.9,
  max_attempts: 3,
  placement: 'LOCAL_FIRST',
});

export function createForemanScheduler({ connectorPort = null, localDeviceRef = null, clock = () => new Date().toISOString(), policy = {} } = {}) {
  if (typeof clock !== 'function') throw new ForemanError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  if (policy !== undefined && policy !== null && !isPlainObject(policy)) throw new ForemanError('INVALID_REQUEST', 'policy must be a plain object');
  const config = validateForemanPolicy({ ...DEFAULT_FOREMAN_POLICY, ...(isPlainObject(policy) ? policy : {}) });
  const nodes = new Map();
  const attempts = new Map();
  const workers = new Map();
  const completedEffects = new Map();
  const journal = [];
  let graph = null;
  let workerTarget = config.max_workers;
  let paused = false;
  let reliefTicks = 0;
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isRealInstant(produced)) throw new ForemanError('INVALID_CLOCK', 'clock() must return a real ISO-8601 UTC instant');
    return produced;
  };

  /** A caller-supplied instant is validated: a recorded timestamp is evidence, including its reality. */
  const atFrom = when => (when === undefined || when === null ? now() : callerInstant(when, 'at'));

  /** One worker's eligibility for one node: the same rule for selection and for an explicit choice. */
  const workerAdmissible = (worker, node) => {
    if (!isPlainObject(worker)) return false;
    if (node.capability_required !== null && !(worker.capabilities ?? []).includes(node.capability_required)) return false;
    if (worker.auth_ready !== true && worker.ready !== true) return false;
    if (worker.busy === true) return false;
    const running = Number.isFinite(worker.running) ? worker.running : 0;
    const max_concurrent = Number.isFinite(worker.max_concurrent) ? worker.max_concurrent : 1;
    return running < max_concurrent;
  };

  const note = (event, at, detail = {}) => {
    journal.push(freeze({ event, at, ...detail }));
    return journal.length - 1;
  };

  const requireNode = node_id => {
    const node = nodes.get(node_id);
    if (!node) throw new ForemanError('UNKNOWN_NODE', `no DAG node ${String(node_id)}`);
    return node;
  };

  const runMode = () => (workerTarget <= 1 ? 'SERIAL' : 'PARALLEL');
  const effectiveWorkers = () => (paused ? 0 : Math.max(config.min_workers, Math.min(config.max_workers, workerTarget)));

  const runningNodes = () => [...nodes.values()].filter(node => node.state === 'RUNNING');

  const dependencyOutcome = node => {
    for (const dependency of node.depends_on) {
      const candidate = nodes.get(dependency);
      if (!candidate) return { outcome: 'UNSATISFIED', reason: 'UNKNOWN_DEPENDENCY', dependency };
      if (candidate.state === 'FAILED' || candidate.state === 'CANCELLED') return { outcome: 'FAILED_DEPENDENCY', reason: `DEPENDENCY_${candidate.state}`, dependency };
      if (candidate.state !== 'SUCCEEDED') return { outcome: 'UNSATISFIED', reason: `DEPENDENCY_${candidate.state}`, dependency };
    }
    return { outcome: 'SATISFIED', reason: null, dependency: null };
  };

  const writeConflicts = (candidate, at) => {
    if (candidate.exclusive_writes !== true) return [];
    return runningNodes()
      .filter(node => node.node_id !== candidate.node_id && node.exclusive_writes === true && scopesOverlap(node.write_scope, candidate.write_scope))
      .map(node => freeze({ node_id: node.node_id, write_scope: node.write_scope, attempt_ref: node.attempt_ref }));
  };

  const api = {
    policy: () => freeze(clone(config)),
    runMode,
    workerTarget: () => effectiveWorkers(),
    isPaused: () => paused,

    /** Validate and load a DAG. Only dependency-satisfied work is ever runnable. */
    submitGraph({ graph_ref, task_ref = null, nodes: definitions = [], replace = false, at: when } = {}) {
      if (!isText(graph_ref)) throw new ForemanError('INVALID_GRAPH', 'graph_ref is required');
      if (!Array.isArray(definitions) || definitions.length === 0) throw new ForemanError('INVALID_GRAPH', 'a graph needs at least one node');
      const at = atFrom(when);
      const staged = new Map();
      for (const definition of definitions) {
        if (!isPlainObject(definition) || !isText(definition.node_id)) throw new ForemanError('INVALID_GRAPH', 'each node needs a node_id');
        if (staged.has(definition.node_id)) throw new ForemanError('DUPLICATE_NODE', `node ${definition.node_id} is declared twice`);
        // Own keys, not enumerable keys: a hidden own field would ride along with a canonical node.
        for (const key of Reflect.ownKeys(definition)) {
          if (typeof key !== 'string' || !NODE_FIELDS.includes(key)) {
            throw new ForemanError('INVALID_GRAPH', `node field ${String(key)} is not part of the canonical node`);
          }
        }
        // A dependency list that cannot be read is not an absent dependency: silently treating a string or
        // a Set as "no dependencies" would run a dependent before its upstream.
        if (definition.depends_on !== undefined && !Array.isArray(definition.depends_on)) {
          throw new ForemanError('INVALID_GRAPH', `node ${definition.node_id} has a depends_on that is not a list`);
        }
        const depends_on = definition.depends_on ?? [];
        if (depends_on.some(entry => !isText(entry))) throw new ForemanError('INVALID_GRAPH', `node ${definition.node_id} has a malformed dependency`);
        // An exclusive writer with a truthy-but-not-true flag would silently stop being exclusive, and a
        // non-text action key would silently drop the duplicate-effect guard.
        if (definition.exclusive_writes !== undefined && typeof definition.exclusive_writes !== 'boolean') {
          throw new ForemanError('INVALID_GRAPH', `node ${definition.node_id} has a non-boolean exclusive_writes; two writers must not be admitted by accident`);
        }
        if (definition.action_key !== undefined && !nullableText(definition.action_key)) {
          throw new ForemanError('INVALID_GRAPH', `node ${definition.node_id} has a non-text action_key; an external effect needs a usable idempotency key`);
        }
        if (definition.max_attempts !== undefined && (!Number.isSafeInteger(definition.max_attempts) || definition.max_attempts < 1)) {
          throw new ForemanError('INVALID_GRAPH', `node ${definition.node_id} has a max_attempts that is not a positive integer`);
        }
        if (!nullableText(definition.write_scope) || !nullableText(definition.capability_required) || !nullableText(definition.job_ref)) {
          throw new ForemanError('INVALID_GRAPH', `node ${definition.node_id} has a non-text reference field`);
        }
        if (definition.acceptance !== undefined && (!Array.isArray(definition.acceptance) || definition.acceptance.some(entry => !isText(entry)))) {
          throw new ForemanError('INVALID_GRAPH', `node ${definition.node_id} has a malformed acceptance list`);
        }
        staged.set(definition.node_id, {
          node_id: definition.node_id,
          job_ref: definition.job_ref ?? null,
          task_ref: definition.task_ref ?? task_ref,
          depends_on,
          write_scope: definition.write_scope ?? null,
          exclusive_writes: definition.exclusive_writes === true,
          acceptance: Array.isArray(definition.acceptance) ? definition.acceptance : [],
          capability_required: definition.capability_required ?? null,
          max_attempts: Number.isSafeInteger(definition.max_attempts) ? definition.max_attempts : config.max_attempts,
          action_key: isText(definition.action_key) ? definition.action_key : null,
        });
      }
      for (const node of staged.values()) {
        for (const dependency of node.depends_on) {
          if (!staged.has(dependency)) throw new ForemanError('UNKNOWN_DEPENDENCY', `node ${node.node_id} depends on unknown node ${dependency}`);
          if (dependency === node.node_id) throw new ForemanError('DAG_CYCLE', `node ${node.node_id} depends on itself`);
        }
      }
      // Cycle detection: iterative topological sort.
      const remaining = new Map([...staged].map(([node_id, node]) => [node_id, new Set(node.depends_on)]));
      const resolved = new Set();
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const [node_id, dependencies] of remaining) {
          if (resolved.has(node_id)) continue;
          if ([...dependencies].every(dependency => resolved.has(dependency))) {
            resolved.add(node_id);
            progressed = true;
          }
        }
      }
      if (resolved.size !== remaining.size) {
        const cyclic = [...remaining.keys()].filter(node_id => !resolved.has(node_id));
        throw new ForemanError('DAG_CYCLE', `the graph contains a dependency cycle: ${cyclic.join(' -> ')}`, { cyclic_nodes: freeze(cyclic) });
      }
      if (graph !== null && replace !== true) {
        // Silently reloading would discard queue state and the completed-effect memory.
        throw new ForemanError('GRAPH_ALREADY_LOADED', `graph ${graph.graph_ref} is already loaded; pass replace: true to discard it deliberately`, { graph_ref: graph.graph_ref, replaced: false });
      }
      nodes.clear();
      attempts.clear();
      // Completed external effects outlive one graph: the duplicate guard must survive a reload.
      graph = { graph_ref, task_ref, created_at: at, node_ids: freeze([...staged.keys()]) };
      for (const node of staged.values()) {
        nodes.set(node.node_id, {
          ...node,
          state: node.depends_on.length === 0 ? 'READY' : 'BLOCKED_ON_DEPS',
          attempts: 0,
          attempt_ref: null,
          worker_ref: null,
          result_ref: null,
          acceptance_ref: null,
          blocker: null,
          checkpoint_ref: null,
          created_at: at,
        });
      }
      note('GRAPH_SUBMITTED', at, { graph_ref, nodes: nodes.size });
      return freeze({
        contract_version: FOREMAN_CONTRACT_VERSION,
        graph_ref,
        task_ref,
        node_count: nodes.size,
        ordered: true,
        dependency_satisfied_only: true,
        owns_task_truth: false,
        overrides_task_core_authority: false,
        created_at: at,
      });
    },

    registerWorker({ worker_ref, device_ref, capabilities = [], auth_ready = true, max_concurrent = 1, at: when } = {}) {
      if (!isText(worker_ref) || !isText(device_ref)) throw new ForemanError('INVALID_REQUEST', 'worker_ref and device_ref are required');
      if (!Array.isArray(capabilities) || capabilities.some(entry => !isText(entry))) throw new ForemanError('INVALID_REQUEST', 'capabilities must be a list of capability refs');
      // A concurrency ceiling that is NaN/zero/negative is not a ceiling.
      if (!Number.isSafeInteger(max_concurrent) || max_concurrent < 1) throw new ForemanError('INVALID_REQUEST', `max_concurrent must be a positive integer, got ${String(max_concurrent)}`);
      const at = atFrom(when);
      const existing = workers.get(worker_ref);
      if (existing && existing.running > 0) {
        // Re-registering a busy worker would reset its capacity accounting and admit a second node beyond
        // the ceiling while the first attempt is still running.
        throw new ForemanError('INVALID_REQUEST', `worker ${worker_ref} has ${existing.running} running attempt(s) and cannot be re-registered`);
      }
      const worker = { worker_ref, device_ref, capabilities: freeze([...capabilities]), auth_ready: auth_ready === true, max_concurrent, running: 0, registered_at: at };
      workers.set(worker_ref, worker);
      note('WORKER_REGISTERED', at, { worker_ref, device_ref });
      return freeze(clone(worker));
    },

    /** Capability/readiness/auth/placement based selection. No provider-name conditionals exist here. */
    selectWorker({ node_id, connectors = null, at: when } = {}) {
      const node = requireNode(node_id);
      const at = atFrom(when);
      const candidates = connectors === null
        ? [...workers.values()].map(worker => ({ connector_ref: worker.worker_ref, device_ref: worker.device_ref, capabilities: worker.capabilities, ready: worker.auth_ready, busy: worker.running >= worker.max_concurrent }))
        : (typeof connectorPort?.listConnectors === 'function' ? connectorPort.listConnectors() : connectors);
      const eligible = candidates.filter(candidate => {
        if (node.capability_required !== null && !(candidate.capabilities ?? []).includes(node.capability_required)) return false;
        if (candidate.ready !== true) return false;
        if (candidate.busy === true) return false;
        return true;
      });
      if (eligible.length === 0) {
        return freeze({
          contract_version: FOREMAN_CONTRACT_VERSION,
          node_id,
          selected: false,
          reason: 'NO_CAPABLE_WORKER',
          capability_required: node.capability_required,
          provider_name_branching: false,
          capability_based: true,
          at,
        });
      }
      const local = eligible.filter(candidate => candidate.device_ref === localDeviceRef);
      const pool = config.placement === 'LOCAL_FIRST' && local.length > 0 ? local : eligible;
      pool.sort((left, right) => (left.connector_ref < right.connector_ref ? -1 : left.connector_ref > right.connector_ref ? 1 : 0));
      const chosen = pool[0];
      return freeze({
        contract_version: FOREMAN_CONTRACT_VERSION,
        node_id,
        selected: true,
        worker_ref: chosen.connector_ref,
        device_ref: chosen.device_ref,
        placement: config.placement,
        local_first_satisfied: chosen.device_ref === localDeviceRef,
        capability_based: true,
        capability_required: node.capability_required,
        provider_name_branching: false,
        candidate_count: eligible.length,
        at,
      });
    },

    /** Resource view drives adaptive worker count with hysteresis, and pauses new work under pressure. */
    observeResources({ pressure = 0, queue_depth = 0, at: when } = {}) {
      if (!Number.isFinite(pressure) || pressure < 0 || pressure > 1) throw new ForemanError('INVALID_REQUEST', 'pressure must be a number between 0 and 1');
      const at = atFrom(when);
      const wasPaused = paused;
      const previousTarget = workerTarget;
      if (pressure >= config.pressure_pause_threshold) {
        workerTarget = config.min_workers;
        paused = true;
        reliefTicks = 0;
      } else if (pressure >= config.pressure_pause_threshold / 2) {
        workerTarget = Math.max(config.min_workers, Math.floor((config.max_workers + config.min_workers) / 2));
        paused = false;
        reliefTicks = 0;
      } else {
        // Scale up only after sustained relief: hysteresis prevents oscillation.
        reliefTicks += 1;
        paused = false;
        if (reliefTicks >= config.scale_up_after_ticks) workerTarget = config.max_workers;
      }
      note('RESOURCES_OBSERVED', at, { pressure, worker_target: workerTarget, paused });
      return freeze({
        contract_version: FOREMAN_CONTRACT_VERSION,
        pressure,
        queue_depth,
        worker_target: effectiveWorkers(),
        raw_target: workerTarget,
        run_mode: runMode(),
        paused,
        paused_changed: wasPaused !== paused,
        target_changed: previousTarget !== workerTarget,
        scales_down_immediately: config.scale_down_immediately,
        scale_up_after_ticks: config.scale_up_after_ticks,
        relief_ticks: reliefTicks,
        completed_work_failed_by_pressure: freeze([]),
        new_work_admitted: !paused,
        at,
      });
    },

    /** The runnable set, honouring dependencies, write scopes, worker capacity and pressure. */
    schedule({ at: when } = {}) {
      const at = atFrom(when);
      const running = runningNodes();
      const capacity = Math.max(0, effectiveWorkers() - running.length);
      const runnable = [];
      const blocked = [];
      for (const node of nodes.values()) {
        if (node.state === 'SUCCEEDED' || node.state === 'FAILED' || node.state === 'CANCELLED' || node.state === 'RUNNING') continue;
        // An exhausted node stays blocked: re-admitting it would restart an unbounded retry loop.
        if (node.state === 'BLOCKED' && node.blocker === 'REASSIGNMENT_EXHAUSTED') {
          blocked.push({ node_id: node.node_id, reason: 'REASSIGNMENT_EXHAUSTED' });
          continue;
        }
        const dependency = dependencyOutcome(node);
        if (dependency.outcome !== 'SATISFIED') {
          node.state = dependency.outcome === 'FAILED_DEPENDENCY' ? 'BLOCKED' : 'BLOCKED_ON_DEPS';
          node.blocker = dependency.reason;
          blocked.push({ node_id: node.node_id, reason: dependency.reason, dependency: dependency.dependency });
          continue;
        }
        node.state = node.state === 'INTERRUPTED' ? 'INTERRUPTED' : 'READY';
        if (node.state === 'INTERRUPTED') { blocked.push({ node_id: node.node_id, reason: 'INTERRUPTED_REQUIRES_REVALIDATION' }); continue; }
        const conflicts = writeConflicts(node, at);
        if (conflicts.length > 0) {
          node.state = 'READY';
          node.blocker = 'WRITE_CONFLICT';
          blocked.push({ node_id: node.node_id, reason: 'WRITE_CONFLICT', conflicts: freeze(conflicts) });
          continue;
        }
        if (paused) { blocked.push({ node_id: node.node_id, reason: 'PAUSED_BY_RESOURCE_PRESSURE' }); continue; }
        if (runnable.length >= capacity) { blocked.push({ node_id: node.node_id, reason: 'NO_WORKER_CAPACITY' }); continue; }
        runnable.push(node.node_id);
      }
      // A node that is dependency-ready but unstaffable must not disappear from both lists: invisible
      // starvation looks exactly like an empty queue.
      const unstaffable = [];
      const admitted = paused ? [] : runnable.filter(node_id => {
        const selection = api.selectWorker({ node_id, at });
        if (selection.selected !== true) {
          unstaffable.push({ node_id, reason: 'NO_CAPABLE_WORKER', capability_required: nodes.get(node_id)?.capability_required ?? null });
          return false;
        }
        return true;
      });
      return freeze({
        contract_version: FOREMAN_CONTRACT_VERSION,
        graph_ref: graph?.graph_ref ?? null,
        run_mode: runMode(),
        worker_target: effectiveWorkers(),
        paused,
        running: freeze(running.map(node => node.node_id)),
        runnable: freeze(admitted),
        blocked: freeze(blocked),
        unstaffable: freeze(unstaffable),
        dependency_satisfied_only: true,
        write_conflicts_auto_merged: 0,
        at,
      });
    },

    dispatch({ node_id, worker_ref = null, action_key = null, checkpoint_ref = null, at: when } = {}) {
      const node = requireNode(node_id);
      const at = atFrom(when);
      if (TERMINAL_NODE_STATES.includes(node.state)) throw new ForemanError('TERMINAL_RESULT_IMMUTABLE', `node ${node_id} is ${node.state}`, { node_id, state: node.state });
      if (node.state === 'INTERRUPTED') {
        // Work interrupted by a restart is not authority to run again: it must be revalidated first.
        throw new ForemanError('INTERRUPTED_REQUIRES_REVALIDATION', `node ${node_id} was interrupted by a restart and must be revalidated before it can run`, {
          node_id, state: node.state, revalidated: false, dispatched: false,
        });
      }
      // A second dispatch of a running node would create two concurrent attempts of the same work.
      if (node.state === 'RUNNING') {
        throw new ForemanError('INVALID_TRANSITION', `node ${node_id} is already RUNNING as ${String(node.attempt_ref)}`, { node_id, state: node.state, attempt_ref: node.attempt_ref, dispatched: false });
      }
      // The attempt budget is a bound at dispatch, not only in the stall path.
      if (node.attempts >= node.max_attempts) {
        node.state = 'BLOCKED';
        node.blocker = 'REASSIGNMENT_EXHAUSTED';
        throw new ForemanError('REASSIGNMENT_EXHAUSTED', `node ${node_id} exhausted ${node.max_attempts} attempt(s)`, { node_id, attempts: node.attempts, max_attempts: node.max_attempts, requires_attention: true, dispatched: false });
      }
      const dependency = dependencyOutcome(node);
      if (dependency.outcome !== 'SATISFIED') throw new ForemanError('DEPENDENCY_NOT_SATISFIED', `node ${node_id} is waiting on ${dependency.dependency}`, { node_id, dependency: dependency.dependency, reason: dependency.reason });
      if (paused) throw new ForemanError('PAUSED_BY_RESOURCE_PRESSURE', 'new work is paused while resource pressure is high', { node_id, paused: true, executed: false });
      if (node.action_key !== null && completedEffects.has(node.action_key)) {
        throw new ForemanError('DUPLICATE_SIDE_EFFECT', `the external effect for ${node.action_key} already completed; it is not repeated`, {
          node_id, action_key: node.action_key, completed: clone(completedEffects.get(node.action_key)), repeated: false,
        });
      }
      // A node's external effect has one identity: re-keying it at dispatch would launder a repeated effect.
      if (node.action_key !== null && action_key !== null && action_key !== node.action_key) {
        throw new ForemanError('INVALID_REQUEST', `node ${node_id} is bound to action key ${node.action_key}; it cannot be dispatched under ${action_key}`, { node_id, action_key: node.action_key, dispatched: false });
      }
      const conflicts = writeConflicts(node, at);
      if (conflicts.length > 0) {
        note('WRITE_CONFLICT_REPORTED', at, { node_id, conflicts: conflicts.length });
        throw new ForemanError('WRITE_CONFLICT', `node ${node_id} writes ${node.write_scope}, which an active node already owns`, {
          node_id, write_scope: node.write_scope, conflicts: freeze(clone(conflicts)), auto_merged: false, deferred: true,
        });
      }
      let selection;
      if (worker_ref === null) {
        selection = api.selectWorker({ node_id, at });
      } else {
        // A named worker is a choice, not a bypass: it passes the same capability/readiness/capacity rules.
        const chosen = workers.get(worker_ref);
        if (!workerAdmissible(chosen, node)) {
          throw new ForemanError('NO_CAPABLE_WORKER', `${String(worker_ref)} cannot take ${node_id}: unknown, unauthenticated, incapable or at its concurrency ceiling`, { node_id, worker_ref, capability_required: node.capability_required, dispatched: false });
        }
        selection = { selected: true, worker_ref, device_ref: chosen.device_ref };
      }
      if (selection.selected !== true) throw new ForemanError('NO_CAPABLE_WORKER', `no worker satisfies ${node.capability_required ?? 'the node'}`, { node_id, capability_required: node.capability_required });
      counter += 1;
      const attempt = {
        attempt_ref: `attempt:${node_id}:${node.attempts + 1}`,
        node_id,
        worker_ref: selection.worker_ref,
        state: 'RUNNING',
        started_at: at,
      };
      attempts.set(attempt.attempt_ref, attempt);
      node.attempts += 1;
      node.attempt_ref = attempt.attempt_ref;
      node.worker_ref = selection.worker_ref;
      node.state = 'RUNNING';
      node.blocker = null;
      if (action_key !== null) node.action_key = action_key;
      if (checkpoint_ref !== null) node.checkpoint_ref = checkpoint_ref;
      const worker = workers.get(selection.worker_ref);
      if (worker) worker.running += 1;
      note('NODE_DISPATCHED', at, { node_id, attempt_ref: attempt.attempt_ref, worker_ref: selection.worker_ref });
      return freeze({
        contract_version: FOREMAN_CONTRACT_VERSION,
        node_id,
        attempt_ref: attempt.attempt_ref,
        attempt_number: node.attempts,
        worker_ref: selection.worker_ref,
        state: node.state,
        run_mode: runMode(),
        dependency_satisfied: true,
        capability_based_selection: true,
        at,
      });
    },

    /** Completion requires the node's acceptance evidence when it declared any. */
    completeAttempt({ attempt_ref, outcome, result_ref = null, acceptance_ref = null, error = null, at: when } = {}) {
      const attempt = attempts.get(attempt_ref);
      if (!attempt) throw new ForemanError('UNKNOWN_ATTEMPT', `no attempt ${String(attempt_ref)}`);
      if (!['SUCCEEDED', 'FAILED'].includes(outcome)) throw new ForemanError('INVALID_REQUEST', 'outcome must be SUCCEEDED or FAILED');
      const node = requireNode(attempt.node_id);
      const at = atFrom(when);
      if (outcome === 'SUCCEEDED' && node.acceptance.length > 0 && !isText(acceptance_ref)) {
        throw new ForemanError('ACCEPTANCE_NOT_RUN', `node ${node.node_id} declares acceptance tests, so a success needs acceptance evidence`, { node_id: node.node_id, acceptance: clone(node.acceptance), executed: false });
      }
      if (outcome === 'SUCCEEDED' && node.result_ref !== null) {
        throw new ForemanError('DUPLICATE_TERMINAL_RESULT', `node ${node.node_id} already has a terminal result`, { node_id: node.node_id, existing_result_ref: node.result_ref, executed: false });
      }
      // A late failure must not overwrite a completed result, and a late success must not resurrect a
      // failed or cancelled node.
      if (TERMINAL_NODE_STATES.includes(node.state)) {
        throw new ForemanError('TERMINAL_RESULT_IMMUTABLE', `node ${node.node_id} is already ${node.state}`, { node_id: node.node_id, state: node.state, executed: false });
      }
      // Only the node's current attempt may complete it: a superseded attempt is not authority.
      if (node.attempt_ref !== attempt.attempt_ref) {
        throw new ForemanError('INVALID_TRANSITION', `attempt ${attempt_ref} was superseded by ${String(node.attempt_ref)}`, { node_id: node.node_id, attempt_ref, current_attempt_ref: node.attempt_ref, executed: false });
      }
      attempt.state = outcome;
      attempt.ended_at = at;
      const worker = workers.get(attempt.worker_ref);
      if (worker && worker.running > 0) worker.running -= 1;
      if (outcome === 'SUCCEEDED') {
        node.state = 'SUCCEEDED';
        node.result_ref = result_ref ?? `${node.node_id}:result`;
        node.acceptance_ref = acceptance_ref;
        if (node.action_key !== null) completedEffects.set(node.action_key, freeze({ action_key: node.action_key, node_id: node.node_id, result_ref: node.result_ref, at }));
      } else {
        node.state = 'FAILED';
        node.error = freeze({ code: isText(error?.code) ? error.code : 'WORKER_FAILURE', detail: isText(error?.detail) ? error.detail : null, at });
      }
      note('ATTEMPT_COMPLETED', at, { node_id: node.node_id, outcome });
      return freeze({
        contract_version: FOREMAN_CONTRACT_VERSION,
        node_id: node.node_id,
        attempt_ref,
        state: node.state,
        result_ref: node.result_ref,
        acceptance_ref: node.acceptance_ref,
        acceptance_evidence_present: node.acceptance_ref !== null,
        terminal: TERMINAL_NODE_STATES.includes(node.state),
        at,
      });
    },

    /** Stall/crash handling: bounded retry, then reassignment, then an honest BLOCKED node. */
    reportSignal({ node_id, kind, at: when } = {}) {
      const node = requireNode(node_id);
      if (!STALL_KINDS.includes(kind)) throw new ForemanError('INVALID_REQUEST', `kind must be one of ${STALL_KINDS.join(', ')}`);
      const at = atFrom(when);
      if (TERMINAL_NODE_STATES.includes(node.state)) {
        throw new ForemanError('TERMINAL_RESULT_IMMUTABLE', `node ${node_id} is ${node.state}; a ${kind} signal cannot re-open it`, { node_id, state: node.state, retry_allowed: false, reassigned: false });
      }
      const attempt = node.attempt_ref === null ? null : attempts.get(node.attempt_ref);
      if (attempt) {
        attempt.state = kind === 'CRASH' ? 'CRASHED' : 'STALLED';
        const worker = workers.get(attempt.worker_ref);
        if (worker && worker.running > 0) worker.running -= 1;
      }
      if (node.attempts >= node.max_attempts) {
        node.state = 'BLOCKED';
        node.blocker = 'REASSIGNMENT_EXHAUSTED';
        note('REASSIGNMENT_EXHAUSTED', at, { node_id, attempts: node.attempts });
        return freeze({
          contract_version: FOREMAN_CONTRACT_VERSION,
          node_id,
          kind,
          retry_allowed: false,
          reassigned: false,
          state: node.state,
          reason: 'REASSIGNMENT_EXHAUSTED',
          attempts: node.attempts,
          max_attempts: node.max_attempts,
          requires_attention: true,
          falsely_failed: false,
          at,
        });
      }
      node.state = 'READY';
      node.blocker = null;
      note('RETRY_SCHEDULED', at, { node_id, kind, attempts: node.attempts });
      return freeze({
        contract_version: FOREMAN_CONTRACT_VERSION,
        node_id,
        kind,
        retry_allowed: true,
        reassigned: false,
        state: node.state,
        attempts: node.attempts,
        attempts_remaining: node.max_attempts - node.attempts,
        bounded: true,
        at,
      });
    },

    /** Reassignment picks another capable worker; the terminal result and effect guards still hold. */
    reassign({ node_id, reason = 'WORKER_LOST', at: when } = {}) {
      const node = requireNode(node_id);
      const at = atFrom(when);
      if (TERMINAL_NODE_STATES.includes(node.state)) throw new ForemanError('TERMINAL_RESULT_IMMUTABLE', `node ${node_id} is ${node.state}`, { node_id, state: node.state });
      if (node.attempts >= node.max_attempts) {
        node.state = 'BLOCKED';
        node.blocker = 'REASSIGNMENT_EXHAUSTED';
        throw new ForemanError('REASSIGNMENT_EXHAUSTED', `node ${node_id} exhausted ${node.max_attempts} attempts`, { node_id, attempts: node.attempts, requires_attention: true });
      }
      if (node.action_key !== null && completedEffects.has(node.action_key)) {
        throw new ForemanError('DUPLICATE_SIDE_EFFECT', `the external effect for ${node.action_key} already completed`, {
          node_id, action_key: node.action_key, completed: clone(completedEffects.get(node.action_key)), repeated: false,
        });
      }
      const previousWorker = node.worker_ref;
      const abandoned = node.attempt_ref === null ? null : attempts.get(node.attempt_ref) ?? null;
      const abandonedWorker = abandoned === null ? null : workers.get(abandoned.worker_ref) ?? null;
      // The abandoned attempt stops being live and gives its slot back, so a handover can reuse the same
      // worker instead of leaking a slot (which wedges a one-worker pool).
      const releasedSlot = abandoned !== null && abandoned.state === 'RUNNING';
      if (releasedSlot) {
        abandoned.state = 'REASSIGNED';
        abandoned.ended_at = at;
        if (abandonedWorker && abandonedWorker.running > 0) abandonedWorker.running -= 1;
      }
      const selection = api.selectWorker({ node_id, at });
      if (selection.selected !== true) {
        // No successor: the handover did not happen, so the run is left exactly as it was.
        if (releasedSlot) {
          abandoned.state = 'RUNNING';
          abandoned.ended_at = null;
          if (abandonedWorker) abandonedWorker.running += 1;
        }
        throw new ForemanError('NO_CAPABLE_WORKER', `no worker can take over ${node_id}`, { node_id, previous_worker_ref: previousWorker, reassigned: false });
      }
      node.worker_ref = null;
      node.state = 'READY';
      const outcome = api.dispatch({ node_id, worker_ref: selection.worker_ref, action_key: node.action_key, at });
      note('NODE_REASSIGNED', at, { node_id, from: previousWorker, to: outcome.worker_ref, reason });
      return freeze({ ...outcome, reassigned: true, previous_worker_ref: previousWorker, reason });
    },

    /** Controlled restart: completed work stays completed, running work becomes INTERRUPTED. */
    snapshot() {
      return freeze({
        contract_version: FOREMAN_CONTRACT_VERSION,
        graph: graph === null ? null : clone(graph),
        nodes: freeze([...nodes.values()].map(node => freeze({
          node_id: node.node_id, job_ref: node.job_ref, task_ref: node.task_ref, depends_on: clone(node.depends_on),
          write_scope: node.write_scope, exclusive_writes: node.exclusive_writes, acceptance: clone(node.acceptance),
          capability_required: node.capability_required, max_attempts: node.max_attempts, state: node.state,
          attempts: node.attempts, result_ref: node.result_ref, acceptance_ref: node.acceptance_ref,
          checkpoint_ref: node.checkpoint_ref, action_key: node.action_key,
        }))),
        // The duplicate-side-effect guard must survive a restart: a snapshot without it would let an
        // already-applied external effect run again after recovery.
        completed_effects: freeze([...completedEffects.values()]),
        taken_at: now(),
      });
    },

    resumeFrom({ snapshot, at: when } = {}) {
      if (!isPlainObject(snapshot) || !Array.isArray(snapshot.nodes) || !isPlainObject(snapshot.graph)) throw new ForemanError('INVALID_REQUEST', 'a snapshot with a graph and nodes is required');
      if (!isText(snapshot.graph.graph_ref)) throw new ForemanError('INVALID_REQUEST', 'the snapshot graph needs a graph_ref');
      const at = atFrom(when);
      // Nothing is cleared until the whole snapshot is admissible: a refused resume used to wipe the live
      // queue and then throw.
      const stagedEntries = [];
      snapshot.nodes.forEach((entry, index) => {
        const where = `snapshot.nodes[${index}]`;
        if (!isPlainObject(entry)) throw new ForemanError('INVALID_REQUEST', `${where} is not a node record`);
        if (!isText(entry.node_id)) throw new ForemanError('INVALID_REQUEST', `${where} has no node_id`);
        if (!NODE_STATES.includes(entry.state)) throw new ForemanError('INVALID_REQUEST', `${where} has unknown state ${String(entry.state)}`);
        if (!Array.isArray(entry.depends_on) || entry.depends_on.some(dependency => !isText(dependency))) throw new ForemanError('INVALID_REQUEST', `${where} has a malformed depends_on`);
        if (!nullableText(entry.write_scope) || !nullableText(entry.result_ref) || !nullableText(entry.acceptance_ref) || !nullableText(entry.checkpoint_ref) || !nullableText(entry.action_key)) {
          throw new ForemanError('INVALID_REQUEST', `${where} has a malformed reference field`);
        }
        if (typeof entry.exclusive_writes !== 'boolean') throw new ForemanError('INVALID_REQUEST', `${where} has a non-boolean exclusive_writes`);
        if (!Number.isSafeInteger(entry.max_attempts) || entry.max_attempts < 1) throw new ForemanError('INVALID_REQUEST', `${where} has a malformed max_attempts`);
        if (!Number.isSafeInteger(entry.attempts) || entry.attempts < 0) throw new ForemanError('INVALID_REQUEST', `${where} has a malformed attempts counter`);
        if (!Array.isArray(entry.acceptance) || entry.acceptance.some(item => !isText(item))) throw new ForemanError('INVALID_REQUEST', `${where} has a malformed acceptance list`);
        stagedEntries.push(entry);
      });
      const seenNodes = new Set();
      for (const entry of stagedEntries) {
        if (seenNodes.has(entry.node_id)) throw new ForemanError('DUPLICATE_NODE', `snapshot node ${entry.node_id} appears twice`);
        seenNodes.add(entry.node_id);
      }
      for (const entry of stagedEntries) {
        for (const dependency of entry.depends_on) {
          if (!seenNodes.has(dependency)) throw new ForemanError('UNKNOWN_DEPENDENCY', `snapshot node ${entry.node_id} depends on unknown node ${dependency}`);
        }
      }
      const stagedEffects = [];
      for (const effect of Array.isArray(snapshot.completed_effects) ? snapshot.completed_effects : []) {
        if (!isPlainObject(effect) || !isText(effect.action_key)) throw new ForemanError('INVALID_REQUEST', 'the snapshot carries an effect record without an action_key');
        stagedEffects.push(effect);
      }
      const resumed = [];
      const interrupted = [];
      const preserved = [];
      nodes.clear();
      attempts.clear();
      graph = { ...clone(snapshot.graph) };
      // Effects outlive one graph, so a resume merges them rather than replacing them.
      for (const effect of stagedEffects) completedEffects.set(effect.action_key, freeze(clone(effect)));
      for (const entry of stagedEntries) {
        const node = { ...clone(entry), attempt_ref: null, worker_ref: null, blocker: null, acceptance_ref: entry.acceptance_ref ?? null, result_ref: entry.result_ref ?? null, checkpoint_ref: entry.checkpoint_ref ?? null, created_at: at };
        if (TERMINAL_NODE_STATES.includes(entry.state)) {
          node.state = entry.state;
          preserved.push(node.node_id);
        } else if (entry.state === 'RUNNING') {
          node.state = 'INTERRUPTED';
          node.blocker = 'INTERRUPTED_BY_RESTART';
          interrupted.push(node.node_id);
        } else {
          node.state = node.depends_on.length === 0 ? 'READY' : 'BLOCKED_ON_DEPS';
          resumed.push(node.node_id);
        }
        nodes.set(node.node_id, node);
      }
      note('QUEUE_RESUMED', at, { resumed: resumed.length, interrupted: interrupted.length, preserved: preserved.length });
      return freeze({
        contract_version: FOREMAN_CONTRACT_VERSION,
        graph_ref: snapshot.graph.graph_ref,
        resumed_nodes: freeze(resumed),
        interrupted_nodes: freeze(interrupted),
        preserved_terminal_nodes: freeze(preserved),
        completed_work_failed_by_restart: freeze([]),
        stale_local_state_used_as_authority: false,
        resume_is_not_success: true,
        at,
      });
    },

    /** Interrupted work resumes only after an explicit revalidation. */
    revalidateInterrupted({ node_id, revalidated, at: when } = {}) {
      const node = requireNode(node_id);
      if (node.state !== 'INTERRUPTED') throw new ForemanError('INVALID_TRANSITION', `node ${node_id} is ${node.state}, not INTERRUPTED`, { node_id, state: node.state });
      const at = atFrom(when);
      if (revalidated !== true) {
        return freeze({ contract_version: FOREMAN_CONTRACT_VERSION, node_id, revalidated: false, state: node.state, reason: 'REVALIDATION_REFUSED', resumed: false });
      }
      node.state = node.depends_on.length === 0 ? 'READY' : 'BLOCKED_ON_DEPS';
      node.blocker = null;
      note('INTERRUPTED_REVALIDATED', at, { node_id });
      return freeze({ contract_version: FOREMAN_CONTRACT_VERSION, node_id, revalidated: true, state: node.state, resumed: true });
    },

    cancelNode({ node_id, reason = 'CANCELLED', at: when } = {}) {
      const node = requireNode(node_id);
      if (TERMINAL_NODE_STATES.includes(node.state)) throw new ForemanError('TERMINAL_RESULT_IMMUTABLE', `node ${node_id} is ${node.state}`, { node_id, state: node.state });
      const at = atFrom(when);
      // Cancelling an active run must actually stop it: the attempt is closed and its worker slot released,
      // otherwise the node keeps an attempt it no longer owns and a one-worker pool wedges.
      const cancelledAttempt = node.attempt_ref === null ? null : attempts.get(node.attempt_ref) ?? null;
      if (cancelledAttempt !== null && cancelledAttempt.state === 'RUNNING') {
        cancelledAttempt.state = 'INTERRUPTED';
        cancelledAttempt.ended_at = at;
        const worker = workers.get(cancelledAttempt.worker_ref);
        if (worker && worker.running > 0) worker.running -= 1;
      }
      node.state = 'CANCELLED';
      node.worker_ref = null;
      node.blocker = reason;
      note('NODE_CANCELLED', at, { node_id, reason, attempt_ref: cancelledAttempt?.attempt_ref ?? null });
      return freeze({ contract_version: FOREMAN_CONTRACT_VERSION, node_id, state: node.state, reason, attempt_ref: cancelledAttempt?.attempt_ref ?? null, at });
    },

    node: node_id => {
      const node = nodes.get(node_id);
      return node ? freeze(clone({ ...node, terminal: TERMINAL_NODE_STATES.includes(node.state) })) : null;
    },

    nodes: () => freeze([...nodes.values()].map(node => freeze(clone(node)))),

    /** Inspectable metrics and evidence for the queue, tasks and workers. */
    metrics() {
      const byState = {};
      for (const state of NODE_STATES) byState[state] = 0;
      for (const node of nodes.values()) byState[node.state] += 1;
      const at = now();
      return freeze({
        contract_version: FOREMAN_CONTRACT_VERSION,
        graph_ref: graph?.graph_ref ?? null,
        node_count: nodes.size,
        by_state: freeze(byState),
        run_mode: runMode(),
        worker_target: effectiveWorkers(),
        paused,
        workers: freeze([...workers.values()].map(worker => freeze({ worker_ref: worker.worker_ref, device_ref: worker.device_ref, running: worker.running, max_concurrent: worker.max_concurrent, auth_ready: worker.auth_ready }))),
        blocked_reasons: freeze([...nodes.values()].filter(node => node.blocker !== null || node.state === 'BLOCKED_ON_DEPS').map(node => freeze({ node_id: node.node_id, state: node.state, reason: node.blocker ?? 'BLOCKED_ON_DEPS' }))),
        completed_work_falsely_failed: freeze([]),
        write_conflicts_auto_merged: 0,
        owns_task_truth: false,
        at,
      });
    },

    evidence: () => freeze({
      contract_version: FOREMAN_CONTRACT_VERSION,
      graph_ref: graph?.graph_ref ?? null,
      evidence_refs: freeze([...nodes.values()].filter(node => node.result_ref !== null || node.acceptance_ref !== null).map(node => freeze({ node_id: node.node_id, result_ref: node.result_ref, acceptance_ref: node.acceptance_ref, checkpoint_ref: node.checkpoint_ref }))),
      completed_effects: freeze([...completedEffects.values()]),
      journal_events: journal.length,
    }),

    journal: () => clone(journal),
  };
  return Object.freeze(api);
}
