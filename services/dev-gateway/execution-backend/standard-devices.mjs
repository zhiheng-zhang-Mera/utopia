/**
 * UTOPIA · Execution Backend — STANDARD_DEVICES.
 *
 * The compatibility backend. It does not add a scheduling rule, a resource model or a state machine: it is the
 * *existing* Windows Alien/Mech execution path, moved behind the `execution-backend-v1` port so that a future
 * backend can be added beside it without touching the business layer.
 *
 * THE ONE RULE THAT MAKES THIS A COMPATIBILITY TASK RATHER THAN A REWRITE: behaviour must be identical to the
 * path it replaces, for every input the path could previously receive. That is why the code below is a
 * relocation and not a redesign:
 *
 *   * readiness is the migrated fleet-routing `acceptsWork` verdict, with the gateway's own policy travelling
 *     as data (`REQUIRED_TASK_CAPABILITIES`), exactly as `cityAvailability()` and `/node/claim` already ask it;
 *   * the claim candidates are the *same* predicates in the *same* order — strict target first, then the
 *     handoff reservation, then the shared-work flag — evaluated by the same functions the route called;
 *   * the withheld set is the same `withheldTasks` projection, so "there is work but it is not yours" stays a
 *     stated fact rather than becoming a silent empty answer;
 *   * the report transitions are the same allowed-edge test, the same monotonic-progress guard and the same
 *     event names.
 *
 * WHAT IT ADDS (all of it observational): a backend identity, a readiness word, and a candidate-endpoint list.
 * A caller that ignores those three still sees byte-identical dispatch, claim and report results.
 *
 * ABSENT WORKBENCH IS NOT A DEGRADED STATE: this backend never consults a Workbench, a Linux server or any
 * pool, and its readiness therefore cannot depend on one.
 */

import {
  BACKEND_KINDS,
  EXECUTION_BACKEND_CONTRACT_VERSION,
  ExecutionBackendError,
  describeReadiness,
  executionEndpoint,
} from '../../../contracts/execution-backend-v1/execution-backend.mjs';
import { acceptsWork } from '../../../city/00-foundation/01-city-core/fleet-routing/index.mjs';

/** The backend id, as a stable machine-readable name. */
export const STANDARD_DEVICES_BACKEND_ID = 'standard-devices';

/**
 * Utopia's placement policy, unchanged. It is a parameter rather than a re-declared constant because the
 * gateway already exports it for its own tests; duplicating the list here is exactly how two copies of a
 * policy drift apart.
 */
export const STANDARD_DEVICES_DEFAULT_CAPABILITIES = Object.freeze(['task.execute.safe', 'filesystem.temp']);

/**
 * `STANDARD_DEVICES` refuses a report that is not on the canonical lifecycle edge, exactly like the route it
 * replaces. Kept as a named predicate so the two call sites cannot disagree.
 */
export function reportTransitionAllowed(currentState, reportedState) {
  return (currentState === 'ASSIGNED' && ['RUNNING', 'FAILED'].includes(reportedState))
    || (currentState === 'RUNNING' && ['RUNNING', 'COMPLETED', 'FAILED'].includes(reportedState));
}

/** The event a report of this transition emits. Identical to the pre-seam route. */
export function reportEventName(currentState, reportedState) {
  return reportedState === 'RUNNING'
    ? (currentState === 'ASSIGNED' ? 'TASK_STARTED' : 'TASK_CHECKPOINTED')
    : `TASK_${reportedState}`;
}

/**
 * Build the STANDARD_DEVICES port over live gateway facts.
 *
 * Every dependency is injected; this module owns no state, no clock and no storage. A caller that supplies a
 * stub `store` gets the real decision procedure over stub data, which is what makes the equivalence test in
 * `tests/wbc601-execution-backend.test.mjs` a measurement rather than a restatement.
 *
 * @param {object} deps
 * @param {object} deps.store                    canonical store: `list('nodes')`, `list('tasks')`, `get`, `atomic`
 * @param {string[]} deps.terminal               the terminal task states, supplied by the caller
 * @param {(node:object)=>object} deps.claimNodeFor        the Core's node shape for this liveness truth
 * @param {string[]} deps.requiredCapabilities   the placement policy
 * @param {(task:object, deviceRef:string)=>boolean} deps.claimAllowedByTarget   the strict-target guard
 * @param {(args:object)=>boolean} deps.handoffClaimAllowed                     the reservation guard
 * @param {(args:object)=>void} deps.noteAssignment                             reservation bookkeeping
 * @param {(args:object)=>object[]} deps.withheldTasks                          the withheld-set projection
 * @param {(task:object)=>boolean} deps.isStrictTarget                          strict-target test
 * @param {(task:object, state:string, patch:object, event:string)=>object} deps.changeTask   canonical transition
 * @param {(table:string, id:string)=>object} deps.requireRecord                 typed not-found
 * @param {(status:number, message:string)=>never} deps.fail                     typed refusal
 */
export function createStandardDevicesBackend({
  store,
  terminal,
  claimNodeFor,
  requiredCapabilities = STANDARD_DEVICES_DEFAULT_CAPABILITIES,
  claimAllowedByTarget,
  handoffClaimAllowed,
  noteAssignment,
  withheldTasks,
  changeTask,
  requireRecord,
  fail,
} = {}) {
  for (const [name, value] of Object.entries({ store, claimNodeFor, claimAllowedByTarget, handoffClaimAllowed, noteAssignment, withheldTasks, changeTask, requireRecord, fail })) {
    if (value === undefined || value === null) throw new ExecutionBackendError('INVALID_BACKEND', `STANDARD_DEVICES needs ${name}`);
  }
  if (!Array.isArray(terminal)) throw new ExecutionBackendError('INVALID_BACKEND', 'STANDARD_DEVICES needs the terminal state list');
  if (!Array.isArray(requiredCapabilities)) throw new ExecutionBackendError('INVALID_BACKEND', 'STANDARD_DEVICES needs the required-capability policy');

  const nodes = () => store.list('nodes');
  const tasks = () => store.list('tasks');
  const isTerminal = task => terminal.includes(task.state);

  /** The Core's verdict for one node record, over this gateway's liveness truth. */
  const nodeAcceptsWork = node => acceptsWork(claimNodeFor(node), { requiredCapabilities }) === true;

  /**
   * A node's readiness as a *reason*, not a boolean: a surface has to be able to say why a device is not
   * taking work, and "offline", "capability not advertised", "sharing switched off by its owner" and "already
   * holding a run" are different facts that a single false would flatten.
   *
   * The busy case is decided here rather than only in `claim`, because a claim is not the only way work reaches
   * an endpoint: `dispatch` places a task too, and if readiness said READY for an endpoint that already holds
   * unfinished work then dispatch would be a documented way around the one-task-per-device rule.
   */
  function endpointReadinessReason(node) {
    if (node.online !== true) return 'ENDPOINT_OFFLINE';
    if (node.sharingEnabled === false) return 'SHARING_DISABLED_BY_OWNER';
    const missing = requiredCapabilities.filter(capability => !(Array.isArray(node.capabilities) ? node.capabilities : []).includes(capability));
    if (missing.length > 0) return `MISSING_CAPABILITY:${missing.join(',')}`;
    if (!nodeAcceptsWork(node)) return 'ENDPOINT_NOT_ACCEPTING_WORK';
    if (tasks().some(task => task.assignedNodeId === node.id && !isTerminal(task))) return 'ENDPOINT_BUSY';
    return null;
  }

  function endpoints() {
    return nodes().map(node => executionEndpoint({
      endpointRef: node.id,
      displayName: node.displayName ?? node.id,
      platform: node.metadata?.platform ?? null,
      ready: endpointReadinessReason(node) === null,
      online: node.online === true,
      sharingEnabled: node.sharingEnabled !== false,
      capabilities: node.capabilities,
      readinessReason: endpointReadinessReason(node),
      lastHeartbeatAt: node.lastHeartbeatAt ?? null,
      kind: 'DEVICE',
      // A City node is a real execution resource. Control surfaces (Web/Android) are not registered here at
      // all, and this flag exists so that a future backend cannot quietly list one as a worker.
      isWorker: true,
      isControlSurface: false,
    })).sort((left, right) => (left.endpointRef < right.endpointRef ? -1 : left.endpointRef > right.endpointRef ? 1 : 0));
  }

  /**
   * Readiness of the fleet as a whole. It never throws: this value is read on health and status surfaces, and
   * a status read that can crash is worse than a status read that says UNKNOWN.
   */
  function readiness() {
    try {
      const rows = endpoints();
      const ready = rows.filter(row => row.ready);
      if (ready.length > 0) {
        return describeReadiness({ state: 'READY', endpointCount: rows.length, readyEndpointCount: ready.length });
      }
      if (rows.length === 0) {
        return describeReadiness({ state: 'UNAVAILABLE', reason: 'NO_EXECUTION_ENDPOINT_REGISTERED', detail: 'no device has registered with this City', endpointCount: 0, readyEndpointCount: 0 });
      }
      // Every endpoint present, none able to take work: the fleet exists and is unavailable. The reasons are
      // aggregated so one unhealthy device cannot be mistaken for the state of the fleet.
      const reasons = [...new Set(rows.map(row => row.readinessReason))].sort();
      // A fleet that is only busy is DEGRADED rather than UNAVAILABLE: the endpoints are healthy and will take
      // the next task as soon as the current run finishes, and saying "unavailable" there would make an ordinary
      // in-flight run look like a broken City.
      const onlyBusy = reasons.length > 0 && reasons.every(reason => reason === 'ENDPOINT_BUSY');
      return describeReadiness({
        state: onlyBusy ? 'DEGRADED' : 'UNAVAILABLE',
        reason: onlyBusy ? 'ALL_ENDPOINTS_BUSY' : 'NO_ENDPOINT_ACCEPTS_WORK',
        detail: reasons.join('; '),
        endpointCount: rows.length,
        readyEndpointCount: 0,
      });
    } catch (error) {
      return describeReadiness({ state: 'UNKNOWN', reason: 'READINESS_PROBE_FAILED', detail: String(error?.message ?? error), endpointCount: 0, readyEndpointCount: 0 });
    }
  }

  /**
   * Dispatch one already-decided task. In STANDARD_DEVICES the decision was made by whoever created the task,
   * so this is the placement step only: it refuses when the named endpoint is not a real, ready execution
   * endpoint, and otherwise performs the same assignment transition the claim path performs.
   */
  function dispatch({ taskId, endpointRef } = {}) {
    if (typeof taskId !== 'string' || taskId.length === 0) throw new ExecutionBackendError('INVALID_REQUEST', 'taskId is required');
    const row = endpoints().find(candidate => candidate.endpointRef === endpointRef);
    if (!row) throw new ExecutionBackendError('UNKNOWN_ENDPOINT', `no execution endpoint ${String(endpointRef)} is registered with this City`, { endpointRef: endpointRef ?? null });
    if (!row.ready) throw new ExecutionBackendError('ENDPOINT_NOT_READY', `execution endpoint ${row.endpointRef} cannot accept work (${row.readinessReason})`, { endpointRef: row.endpointRef, readinessReason: row.readinessReason });
    const task = requireRecord('tasks', taskId);
    if(task.executionBackendId==='pcf-v1')throw new ExecutionBackendError('TASK_NOT_CLAIMABLE','PCF attempts require capsule and epoch validation at their own backend');
    if (task.state !== 'QUEUED') throw new ExecutionBackendError('INVALID_TRANSITION', `task ${taskId} is already ${task.state}`, { taskId, state: task.state });
    if(!claimAllowedByTarget(task,row.endpointRef)||!handoffClaimAllowed({subjectRef:task.id,deviceRef:row.endpointRef,reservedFor:typeof task.handoffTargetRef==='string'&&task.handoffTargetRef.length>0?task.handoffTargetRef:null}))throw new ExecutionBackendError('TASK_NOT_CLAIMABLE','task target or reservation does not permit this endpoint',{taskId,endpointRef:row.endpointRef});
    noteAssignment({ subjectRef: task.id, deviceRef: row.endpointRef });
    return { task: changeTask(task, 'ASSIGNED', { assignedNodeId: row.endpointRef }), endpointRef: row.endpointRef };
  }

  /**
   * Hand the next allowed task to one endpoint.
   *
   * The predicates are applied in the order the frozen path applied them, because the order is observable: a
   * strict task for an away device must be *withheld* rather than skipped, and a busy endpoint must be refused
   * before the queue is scanned so that two tasks cannot land on one device.
   */
  function claim({ nodeId, endpointRef = nodeId } = {}) {
    const target = requireRecord('nodes', endpointRef);
    const rows = endpoints();
    const ready = nodeAcceptsWork(target);
    const busy = tasks().some(task => task.assignedNodeId === target.id && !isTerminal(task));
    const claimable = task => task.executionBackendId !== 'pcf-v1' && task.state === 'QUEUED'
      && claimAllowedByTarget(task, target.id)
      && handoffClaimAllowed({
        subjectRef: task.id,
        deviceRef: target.id,
        reservedFor: typeof task.handoffTargetRef === 'string' && task.handoffTargetRef.length > 0 ? task.handoffTargetRef : null,
      });
    const claimed = ready && !busy && target.sharingEnabled !== false
      ? tasks().find(claimable)
      : null;
    if (claimed) noteAssignment({ subjectRef: claimed.id, deviceRef: target.id });
    const withheld = withheldTasks({ tasks: tasks(), deviceRef: target.id, terminal });
    return {
      task: claimed ? changeTask(claimed, 'ASSIGNED', { assignedNodeId: target.id }) : null,
      endpointRef: target.id,
      backendId: STANDARD_DEVICES_BACKEND_ID,
      readiness: describeReadiness({
        state: ready && !busy && target.sharingEnabled !== false ? 'READY' : 'UNAVAILABLE',
        reason: ready && !busy && target.sharingEnabled !== false ? null : endpointReadinessReason(target) ?? 'ENDPOINT_NOT_ACCEPTING_WORK',
        endpointCount: rows.length,
        readyEndpointCount: rows.filter(row => row.ready).length,
      }),
      busy,
      ...(withheld.length > 0 ? { withheld } : {}),
    };
  }

  /**
   * Accept one report from the endpoint holding a task. The refusal conditions are the route's conditions:
   * another node's task is a 403-shaped refusal, a non-edge transition is a 409-shaped one, and non-monotonic
   * progress is a 400-shaped one. A report for an already-terminal task is NOT a failure — it returns the
   * terminal task unchanged, because the endpoint is describing work that really finished.
   */
  function report({ taskId, nodeId, endpointRef = nodeId, state, progress, lastCheckpoint, result, error } = {}) {
    const task = requireRecord('tasks', taskId);
    if(task.executionBackendId==='pcf-v1')throw new ExecutionBackendError('TASK_NOT_CLAIMABLE','PCF attempts require capsule and epoch validation at their own backend');
    if (task.assignedNodeId !== endpointRef) fail(403, 'Task belongs to another node');
    if (isTerminal(task)) return task;
    if (!reportTransitionAllowed(task.state, state)) fail(409, 'Invalid task transition');
    if (!Number.isFinite(progress) || progress < task.progress || progress > 100) fail(400, 'Invalid progress');
    const patch = { progress };
    for (const key of ['lastCheckpoint', 'result', 'error']) {
      const value = key === 'lastCheckpoint' ? lastCheckpoint : key === 'result' ? result : error;
      if (value !== undefined) patch[key] = value;
    }
    return changeTask(task, state, patch, reportEventName(task.state, state));
  }

  /**
   * Cancel/steer an already-out task. Cancellation is a user decision, so it is refused for a finished task
   * with the same 409 the route produced; an unknown task is a typed not-found.
   */
  function control({ taskId, action = 'cancel' } = {}) {
    if (action !== 'cancel') throw new ExecutionBackendError('INVALID_REQUEST', `STANDARD_DEVICES supports the control action "cancel", got ${String(action)}`);
    const task = requireRecord('tasks', taskId);
    if(task.executionBackendId==='pcf-v1')throw new ExecutionBackendError('TASK_NOT_CLAIMABLE','PCF attempts require capsule and epoch validation at their own backend');
    if (isTerminal(task)) fail(409, 'Task already finished');
    return { task: changeTask(task, 'CANCELLED'), action, endpointRef: task.assignedNodeId ?? null };
  }

  return Object.freeze({
    contractVersion: EXECUTION_BACKEND_CONTRACT_VERSION,
    backendId: STANDARD_DEVICES_BACKEND_ID,
    kind: BACKEND_KINDS[0],
    profile: 'STANDARD_DEVICES',
    // Enabled by definition: this is the path the product already runs on, and a compatibility migration that
    // could switch its own baseline off would be able to fail the NO_WORKBENCH_REGRESSION invariant by config.
    mode: 'enabled',
    readiness,
    endpoints,
    dispatch,
    claim,
    report,
    control,
    // Exposed for diagnostics and for the equivalence test, which compares these verdicts against the Core
    // directly rather than re-deriving them.
    endpointReadinessReason,
    requiredCapabilities: Object.freeze([...requiredCapabilities]),
  });
}
