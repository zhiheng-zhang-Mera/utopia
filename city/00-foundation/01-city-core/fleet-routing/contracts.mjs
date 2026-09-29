/**
 * UTOPIA · City Core — fleet routing contracts.
 *
 * The plain value shapes fleet routing is built from, expressed as data plus small
 * factories and validators. Nothing here is a runtime: there is no node agent, no
 * heartbeat worker, no provider automation, no persistence and no scheduler loop,
 * because a routing decision must be readable and reproducible on its own.
 *
 * Ported from the Codex-Boss donor `src/shared/fleet.ts`,
 * `src/shared/capability-router.ts`, `src/shared/node-capabilities.ts` and
 * `src/shared/adaptive-routing.ts` @
 * 8df428eaa437a409368401e95194e40266b83080, with the donor's TypeScript interfaces
 * turned into documented value shapes and validators.
 *
 * Vocabulary:
 *   FleetNodeState     READY / DEGRADED / OFFLINE / FAILED / DISABLED, heartbeat-derived
 *   FleetNode          one worker node: id, observed state, capabilities, last heartbeat
 *   FleetTask          what must be done, and which capabilities it requires
 *   FleetAssignment    a task placed (or not placed) on a node, with its history
 *   NodeProbeData      concrete observed facts a node reports about itself
 *   CapabilityVerdict  one capability's status, derived from those facts
 *   ProbeNodeState     the node state and reason derived from its verdicts
 *   RouterCandidate    a candidate id and the capabilities it actually exposes
 *   RoutedResult       selected / excluded / degraded / blocked, never silent
 *   Adaptive*          soft-ranking shapes that may only reorder hard-eligible work
 *
 * Two donor functions share the name `nodeStateFor`. They are never merged here:
 *   - `fleetNodeStateFor` (in `./fleet.mjs`) derives a `FleetNodeState` from a
 *     heartbeat age window;
 *   - `probeNodeStateFor` (in `./capability-routing.mjs`) derives a `ProbeNodeState`
 *     from node self-inspection verdicts.
 */

/**
 * Node lifecycle states, in the order they are reported.
 *
 * Heartbeat-derived states are READY / DEGRADED / OFFLINE. FAILED and DISABLED are
 * declared states that never accept work.
 */
export const FLEET_NODE_STATES = Object.freeze(['READY', 'DEGRADED', 'OFFLINE', 'FAILED', 'DISABLED']);

/**
 * States a node is never routed work in, whatever capabilities it lists.
 *
 * The donor's `acceptsWork` refuses exactly these three. RECOVERING is checked in
 * `eligibleCandidates`, whose candidate vocabulary also carries a module-state
 * notion, and is therefore not a fleet node state.
 */
export const FLEET_NODE_STATES_REFUSING_WORK = Object.freeze(['FAILED', 'DISABLED', 'OFFLINE']);

/** Assignment lifecycle states, in the order they are reported. */
export const ASSIGNMENT_STATES = Object.freeze([
  'QUEUED',
  'ASSIGNED',
  'RUNNING',
  'CHECKPOINTED',
  'COMPLETED',
  'FAILED',
]);

/**
 * The state of a node's work that a dropout can move.
 *
 * `CHECKPOINTED` work goes back to QUEUED with its checkpoint intact.
 */
export const ASSIGNMENT_STATES_TRANSFERABLE_ON_DROPOUT = Object.freeze(['QUEUED', 'ASSIGNED', 'RUNNING', 'CHECKPOINTED']);

/** Module states a routing candidate may be observed in. */
export const MODULE_STATES = Object.freeze([
  'UNINITIALIZED',
  'CHECKING',
  'READY',
  'DEGRADED',
  'FAILED',
  'DISABLED',
  'RECOVERING',
  'UNKNOWN',
]);

/** Candidate states excluded before capabilities are even considered. */
export const CANDIDATE_STATES_EXCLUDED = Object.freeze(['FAILED', 'DISABLED', 'RECOVERING']);

/** The state used for a candidate that was never observed. Never an assumed READY. */
export const UNOBSERVED_MODULE_STATE = 'UNKNOWN';

/**
 * The exclusion reason a state exclusion starts with.
 *
 * `RoutedResult.blocked` is the ids of the exclusions whose reason starts with this
 * exact prefix, because a missing capability is not a state exclusion. The donor
 * computes it with the same prefix test.
 */
export const STATE_EXCLUSION_PREFIX = 'state ';

/** Per-capability verdict statuses, in the order they are reported. */
export const CAPABILITY_STATUSES = Object.freeze(['READY', 'DEGRADED', 'FAILED', 'DISABLED', 'UNKNOWN']);

/**
 * The capability ids node self-inspection reports, in the order the donor pushes them.
 *
 * GPU and browser are optional extras: absent, they are UNKNOWN and do NOT block the
 * node.
 */
export const CAPABILITY_IDS = Object.freeze([
  'compute',
  'memory',
  'runtime',
  'gpu',
  'web-ai',
  'browser',
  'native-tools',
  'network',
]);

/** The capability whose FAILED verdict fails the whole node. */
export const COMPUTE_CAPABILITY_ID = 'compute';

/** Node states derived from self-inspection. */
export const PROBE_NODE_STATES = Object.freeze([
  'UNINITIALIZED',
  'CHECKING',
  'READY',
  'DEGRADED',
  'FAILED',
  'DISABLED',
  'RECOVERING',
]);

/** The reason reported for a node that passed every self-inspection check. */
export const PROBE_NODE_READY_REASON = 'node self-inspection complete';

/**
 * Heartbeat windows, in milliseconds.
 *
 * The donor fixes the interval at 5 s: a node is DEGRADED at 2 intervals (10 s) and
 * OFFLINE at 6 intervals (30 s).
 */
export const FLEET_HEARTBEAT_INTERVAL_MS = 5 * 1000;
export const DEGRADED_AFTER_MS = 2 * FLEET_HEARTBEAT_INTERVAL_MS;
export const OFFLINE_AFTER_MS = 6 * FLEET_HEARTBEAT_INTERVAL_MS;

/** The adaptive routing policy version this module implements. */
export const ADAPTIVE_POLICY_VERSION = 'adaptive-policy-1.0.0';

/** Priors used for a candidate with no learned profile (honest, not a penalty). */
export const NEUTRAL_PRIOR = Object.freeze({
  completion: 0.5,
  quality: 0.5,
  goalFidelity: 0.5,
  restrictionImpact: 0.15,
  runtimeReliability: 0.8,
});

/** Expected-utility weights and the latency that maps to a full latency cost. */
export const UTILITY_WEIGHTS = Object.freeze({
  pipelineBlockingRisk: 0.5,
  latencyCost: 0.2,
  resourceCost: 0.1,
  latencyScaleMs: 10_000,
});

/** Queue-history reasons, kept verbatim from the donor so records stay comparable. */
export const ROUTE_QUEUED_HISTORY = 'queued: no eligible node';
export const ROUTE_QUEUED_NOTE = 'no eligible node';
export const DROPOUT_TRANSFERRED_PREFIX = 'checkpointed:';
export const DROPOUT_TRANSFERRED_SUFFIX = ' transferred';
export const DROPOUT_REASSIGN_PREFIX = 'reassign-after-dropout:';
export const DROPOUT_FAILED_PREFIX = 'failed:';
export const DROPOUT_FAILED_SUFFIX = ' dropped without checkpoint';

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function requireFiniteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${field} must be a finite number`);
  return value;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function requireObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw new TypeError(`${field} must be one of ${allowed.join(', ')}`);
  return value;
}

function uniqueTextArray(values, field) {
  const list = requireArray(values ?? [], field).map((value) => requireText(value, `${field}[]`));
  if (new Set(list).size !== list.length) throw new TypeError(`${field} must be unique`);
  return list;
}

/** Validate a heartbeat-derived fleet node state. */
export function fleetNodeState(state) {
  return requireEnum(state, FLEET_NODE_STATES, 'node.state');
}

/** Validate an assignment state. */
export function assignmentState(state) {
  return requireEnum(state, ASSIGNMENT_STATES, 'assignment.state');
}

/** Validate a candidate module state. */
export function moduleState(state) {
  return requireEnum(state, MODULE_STATES, 'candidate state');
}

/** Validate a capability verdict status. */
export function capabilityStatus(status) {
  return requireEnum(status, CAPABILITY_STATUSES, 'verdict.status');
}

/** Validate a capability id. */
export function capabilityId(id) {
  return requireEnum(id, CAPABILITY_IDS, 'verdict.id');
}

/**
 * Validate a fleet node.
 *
 * `lastHeartbeatAt` and `seq` are carried as observed; they are never derived from a
 * clock inside this module.
 *
 * @param {{nodeId: string, state: string, capabilities?: string[], lastHeartbeatAt: number, seq?: number}} node
 */
export function fleetNode(node) {
  requireObject(node, 'node');
  return {
    nodeId: requireText(node.nodeId, 'node.nodeId'),
    state: fleetNodeState(node.state),
    capabilities: uniqueTextArray(node.capabilities ?? [], 'node.capabilities'),
    lastHeartbeatAt: requireFiniteNumber(node.lastHeartbeatAt, 'node.lastHeartbeatAt'),
    seq: node.seq === undefined ? 0 : requireFiniteNumber(node.seq, 'node.seq'),
  };
}

/**
 * Validate a fleet task: what must be done and which capabilities it requires.
 *
 * `checkpoint` is opaque and JSON-serializable; `replaySafe` omitted means the donor's
 * `replaySafe !== false`, so work is assumed replay-safe unless it is denied.
 *
 * @param {{taskId: string, requiredCapabilities?: string[], checkpoint?: unknown, replaySafe?: boolean}} task
 */
export function fleetTask(task) {
  requireObject(task, 'task');
  const validated = {
    taskId: requireText(task.taskId, 'task.taskId'),
    requiredCapabilities: uniqueTextArray(task.requiredCapabilities ?? [], 'task.requiredCapabilities'),
  };
  if (task.checkpoint !== undefined) validated.checkpoint = task.checkpoint;
  if (task.replaySafe !== undefined) validated.replaySafe = task.replaySafe === true;
  return validated;
}

/**
 * Validate a fleet assignment: a task with a placement, an attempt count and history.
 *
 * A cleared placement is `nodeId: undefined`, exactly as the donor writes it, so
 * `JSON.stringify` drops the key and `deepEqual` sees the same shape.
 *
 * @param {object} assignment
 */
export function fleetAssignment(assignment) {
  requireObject(assignment, 'assignment');
  const validated = { ...fleetTask(assignment) };
  validated.state = assignmentState(assignment.state);
  // A cleared placement is carried as an explicit `nodeId: undefined`, exactly as the
  // donor writes it: the key exists on the object but disappears from JSON. Always
  // writing it keeps a validated assignment deep-equal to the one the router produced.
  validated.nodeId = assignment.nodeId === undefined ? undefined : requireText(assignment.nodeId, 'assignment.nodeId');
  validated.attempts = requireFiniteNumber(assignment.attempts ?? 0, 'assignment.attempts');
  if (validated.attempts < 0) throw new TypeError('assignment.attempts must not be negative');
  validated.history = requireArray(assignment.history ?? [], 'assignment.history').map((entry) =>
    requireText(entry, 'assignment.history[]'),
  );
  return validated;
}

/**
 * Validate the concrete facts a node observed about itself.
 *
 * `sampledAt` is a caller-supplied timestamp string: this module never reads a clock.
 *
 * @param {object} data
 */
export function nodeProbeData(data) {
  requireObject(data, 'probe');
  const os = requireObject(data.os ?? {}, 'probe.os');
  const cpu = requireObject(data.cpu ?? {}, 'probe.cpu');
  const memory = requireObject(data.memory ?? {}, 'probe.memory');
  const runtimes = requireObject(data.runtimes ?? {}, 'probe.runtimes');
  const network = requireObject(data.network ?? {}, 'probe.network');
  const gpu = requireArray(data.gpu ?? [], 'probe.gpu').map((entry, index) =>
    requireObject(entry, `probe.gpu[${index}]`),
  );
  const probe = {
    nodeId: requireText(data.nodeId, 'probe.nodeId'),
    os: {
      platform: requireText(os.platform, 'probe.os.platform'),
      arch: requireText(os.arch, 'probe.os.arch'),
      version: requireText(os.version, 'probe.os.version'),
    },
    cpu: {
      cores: requireFiniteNumber(cpu.cores, 'probe.cpu.cores'),
    },
    gpu: gpu.map((entry, index) => {
      const card = { name: requireText(entry.name, `probe.gpu[${index}].name`) };
      if (entry.vramMb !== undefined) card.vramMb = requireFiniteNumber(entry.vramMb, `probe.gpu[${index}].vramMb`);
      return card;
    }),
    memory: {
      totalMb: requireFiniteNumber(memory.totalMb, 'probe.memory.totalMb'),
    },
    runtimes: {},
    webLoggedInProviders: uniqueTextArray(data.webLoggedInProviders ?? [], 'probe.webLoggedInProviders'),
    nativeToolsAvailable: data.nativeToolsAvailable === true,
    network: {
      directReachableProviders: uniqueTextArray(
        network.directReachableProviders ?? [],
        'probe.network.directReachableProviders',
      ),
      proxyCapable: network.proxyCapable === true,
    },
    currentTaskCount: requireFiniteNumber(data.currentTaskCount ?? 0, 'probe.currentTaskCount'),
    sampledAt: requireText(data.sampledAt, 'probe.sampledAt'),
  };
  if (cpu.model !== undefined) probe.cpu.model = requireText(cpu.model, 'probe.cpu.model');
  if (cpu.loadPercent !== undefined) probe.cpu.loadPercent = requireFiniteNumber(cpu.loadPercent, 'probe.cpu.loadPercent');
  if (memory.freeMb !== undefined) probe.memory.freeMb = requireFiniteNumber(memory.freeMb, 'probe.memory.freeMb');
  if (network.region !== undefined) probe.network.region = requireText(network.region, 'probe.network.region');
  for (const runtime of ['node', 'python', 'browser', 'shell']) {
    if (runtimes[runtime] !== undefined) probe.runtimes[runtime] = requireText(runtimes[runtime], `probe.runtimes.${runtime}`);
  }
  return probe;
}

/** Validate one capability verdict. */
export function capabilityVerdict(verdict) {
  requireObject(verdict, 'verdict');
  return {
    id: capabilityId(verdict.id),
    status: capabilityStatus(verdict.status),
    detail: requireText(verdict.detail, 'verdict.detail'),
  };
}

/** Validate a node state derived from self-inspection, with its reason. */
export function probeNodeStateRecord(record) {
  requireObject(record, 'node state');
  return {
    state: requireEnum(record.state, PROBE_NODE_STATES, 'node state.state'),
    reason: requireText(record.reason, 'node state.reason'),
  };
}

/**
 * Validate one routing candidate: an id and the capabilities actually observed.
 *
 * @param {{id: string, capabilities?: string[]}} candidate
 */
export function routerCandidate(candidate) {
  requireObject(candidate, 'candidate');
  return {
    id: requireText(candidate.id, 'candidate.id'),
    capabilities: uniqueTextArray(candidate.capabilities ?? [], 'candidate.capabilities'),
  };
}

/**
 * Validate the outcome of capability-aware eligibility.
 *
 * `selected` keeps the input order; `degraded` lists the admitted DEGRADED ids;
 * `blocked` lists only the ids excluded by state, never by a missing capability.
 */
export function routedResult(result) {
  requireObject(result, 'routedResult');
  const excluded = requireArray(result.excluded ?? [], 'routedResult.excluded').map((entry, index) => {
    requireObject(entry, `routedResult.excluded[${index}]`);
    return {
      id: requireText(entry.id, `routedResult.excluded[${index}].id`),
      reason: requireText(entry.reason, `routedResult.excluded[${index}].reason`),
    };
  });
  return {
    selected: uniqueTextArray(result.selected ?? [], 'routedResult.selected'),
    excluded,
    degraded: uniqueTextArray(result.degraded ?? [], 'routedResult.degraded'),
    blocked: uniqueTextArray(result.blocked ?? [], 'routedResult.blocked'),
  };
}

/**
 * Validate a soft-score for one hard-eligible candidate.
 *
 * Every prediction is optional because the donor's scorer may only produce some of
 * them; `explanation` is mandatory so a score is never unexplained.
 *
 * @param {object} score
 */
export function adaptiveCandidateScore(score) {
  requireObject(score, 'score');
  const validated = {
    runtimeId: requireText(score.runtimeId, 'score.runtimeId'),
    eligible: score.eligible === true,
    explanation: requireArray(score.explanation, 'score.explanation').map((line) =>
      requireText(line, 'score.explanation[]'),
    ),
  };
  for (const field of [
    'expectedUtility',
    'confidence',
    'predictedCompletion',
    'predictedQuality',
    'predictedGoalFidelity',
    'predictedRestrictionImpact',
    'predictedBlockingRisk',
  ]) {
    if (score[field] !== undefined) validated[field] = requireFiniteNumber(score[field], `score.${field}`);
  }
  return validated;
}

/** Validate a routing decision over soft-ranked candidates. */
export function adaptiveRoutingDecision(decision) {
  requireObject(decision, 'decision');
  const validated = {
    decisionId: requireText(decision.decisionId, 'decision.decisionId'),
    taskId: requireText(decision.taskId, 'decision.taskId'),
    policyVersion: requireText(decision.policyVersion, 'decision.policyVersion'),
    candidates: requireArray(decision.candidates ?? [], 'decision.candidates').map((candidate) =>
      adaptiveCandidateScore(candidate),
    ),
    usedFallbackRouter: decision.usedFallbackRouter === true,
  };
  if (decision.selectedRuntimeId !== undefined) {
    validated.selectedRuntimeId = requireText(decision.selectedRuntimeId, 'decision.selectedRuntimeId');
  }
  if (decision.exploration !== undefined) {
    const exploration = requireObject(decision.exploration, 'decision.exploration');
    validated.exploration = { enabled: exploration.enabled === true };
    if (exploration.reason !== undefined) {
      validated.exploration.reason = requireText(exploration.reason, 'decision.exploration.reason');
    }
  }
  return validated;
}

/** Validate one soft-ranked candidate position. */
export function adaptiveRerankCandidate(candidate) {
  requireObject(candidate, 'rerank candidate');
  return {
    runtimeId: requireText(candidate.runtimeId, 'rerank candidate.runtimeId'),
    rank: requireFiniteNumber(candidate.rank, 'rerank candidate.rank'),
    reason: requireText(candidate.reason, 'rerank candidate.reason'),
  };
}

/** Validate a rerank result: the ordered candidates plus the decision that produced them. */
export function adaptiveRerankResult(result) {
  requireObject(result, 'rerank result');
  return {
    ordered: requireArray(result.ordered ?? [], 'rerank result.ordered').map((candidate) =>
      adaptiveRerankCandidate(candidate),
    ),
    decision: adaptiveRoutingDecision(result.decision),
  };
}

/**
 * The utility inputs the donor's `expectedUtility` accepts.
 *
 * Only `latencyMs` and `resourceCost` are optional: when they are absent the donor
 * charges no latency and no resource cost (it does not assume a good value).
 *
 * @param {object} input
 */
export function utilityInputs(input) {
  requireObject(input, 'utility input');
  const validated = {
    completion: requireFiniteNumber(input.completion, 'utility input.completion'),
    quality: requireFiniteNumber(input.quality, 'utility input.quality'),
    goalFidelity: requireFiniteNumber(input.goalFidelity, 'utility input.goalFidelity'),
    restrictionImpact: requireFiniteNumber(input.restrictionImpact, 'utility input.restrictionImpact'),
    runtimeReliability: requireFiniteNumber(input.runtimeReliability, 'utility input.runtimeReliability'),
  };
  if (input.latencyMs !== undefined) validated.latencyMs = requireFiniteNumber(input.latencyMs, 'utility input.latencyMs');
  if (input.resourceCost !== undefined) {
    validated.resourceCost = requireFiniteNumber(input.resourceCost, 'utility input.resourceCost');
  }
  return validated;
}
