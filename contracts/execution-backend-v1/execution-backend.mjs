/**
 * UTOPIA · Execution Backend Contract v1 (WBC-601).
 *
 * WHY THIS EXISTS. Until now the only execution resources Utopia could use were the Windows devices that had
 * registered with this City, and that fact was not a *contract* — it was simply what the node routes happened
 * to do. The Workbench Compatibility Migration aims to add future execution resources (a Workbench node pool,
 * and a hybrid of both) without the business layer ever learning about them. Doing that later, while the
 * device path is still expressed only as inline route code, would mean rewriting the dispatch path at the same
 * moment the new resource is introduced — the worst possible time. So this contract freezes the shape of an
 * execution backend *first*, wraps today's behaviour as `STANDARD_DEVICES`, and leaves future backends as a
 * registration that is allowed to exist but is not allowed to be enabled by this task.
 *
 * WHAT IT IS NOT. This is not a new scheduler and not a second task truth. A backend does not own task state:
 * the canonical task record, its lease semantics and its idempotency stay exactly where they were (Shared Task
 * Core). A backend answers five bounded questions and nothing else:
 *
 *   readiness()  can this backend be used at all, and why not if it cannot
 *   endpoints()  which execution endpoints exist, and what each one's truthful availability is
 *   dispatch()   put one already-decided unit of work in front of one execution endpoint
 *   claim()      hand the next *allowed* task to one endpoint, or say truthfully that none is allowed
 *   report()     accept one progress/terminal report from the endpoint holding the task
 *   control()    cancel/steer a task that is already out
 *
 * THE TWO INVARIANTS THIS CONTRACT EXISTS TO PROTECT:
 *
 *  1. **NO_WORKBENCH_REGRESSION.** `STANDARD_DEVICES` is the default profile, it is always registered, and a
 *     City with no Workbench and no Linux server must be completely startable, discoverable and executable. A
 *     backend is never a startup dependency; `readiness()` of an absent backend is `ABSENT`, not a crash.
 *  2. **STRICT TARGET WINS.** A user who named a device has made a decision this layer may not override. The
 *     target-intent guard is applied by the backend *before* generic availability, exactly as the existing node
 *     route applies it before the fleet gate, so an offline named device yields a withheld task rather than a
 *     reassignment.
 *
 * ADDITIVE ONLY. Nothing here may require an existing field to appear on an existing record. A node or task
 * written before this contract existed is valid, and every derived value has an explicit legacy default.
 */

/** Contract version. A reader that does not know this number must refuse rather than guess. */
export const EXECUTION_BACKEND_CONTRACT_VERSION = 1;

/**
 * The execution profiles. `STANDARD_DEVICES` is today's Windows Alien/Mech path and stays the long-term
 * default; the other two are declared here so a future switch has a fixed name to switch *to*, and are
 * deliberately not enabled by WBC-601.
 */
export const EXECUTION_PROFILES = Object.freeze(['STANDARD_DEVICES', 'WORKER_POOL', 'HYBRID']);

/** The only profile this task is allowed to activate. */
export const DEFAULT_EXECUTION_PROFILE = 'STANDARD_DEVICES';

/** Backend identity kinds. A backend says what *kind* of resource it is, never which machine it is. */
export const BACKEND_KINDS = Object.freeze(['DEVICE_FLEET', 'WORKER_POOL', 'COMPOSITE']);

/**
 * The registration lifecycle of a backend. `enabled` is the only state that may serve ordinary work; the
 * registry refuses to serve from a `dormant` backend even when one is registered, which is what makes "the
 * seam exists but the feature is off" a checkable fact rather than a comment.
 */
export const BACKEND_MODES = Object.freeze(['enabled', 'dormant']);

/**
 * Readiness states, in the vocabulary a surface can render without knowing the backend.
 *
 *   READY       at least one execution endpoint can accept work right now
 *   DEGRADED    usable, but something the user should know about is wrong
 *   UNAVAILABLE every endpoint is present and none can accept work
 *   ABSENT      this backend does not exist on this City at all (the honest state of a future Workbench)
 *   UNKNOWN     readiness could not be established — never silently treated as READY
 */
export const READINESS_STATES = Object.freeze(['READY', 'DEGRADED', 'UNAVAILABLE', 'ABSENT', 'UNKNOWN']);

/** Typed refusal codes. A refusal is data; a crash is not. */
export const EXECUTION_BACKEND_CODES = Object.freeze([
  'INVALID_BACKEND', 'INVALID_PROFILE', 'INVALID_REQUEST', 'INCOMPATIBLE_CONTRACT',
  'UNKNOWN_BACKEND', 'PROFILE_NOT_REGISTERED', 'BACKEND_DORMANT', 'BACKEND_UNAVAILABLE',
  'NO_ELIGIBLE_ENDPOINT', 'UNKNOWN_ENDPOINT', 'ENDPOINT_NOT_READY', 'TASK_NOT_CLAIMABLE',
  'NOT_TASK_HOLDER', 'INVALID_TRANSITION',
]);

/** The methods a port must expose. Used by conformance so "wired to a backend" is verifiable, not assumed. */
export const REQUIRED_PORT_METHODS = Object.freeze(['readiness', 'endpoints', 'dispatch', 'claim', 'report', 'control']);

const CONFLICT_CODES = new Set(['BACKEND_DORMANT', 'BACKEND_UNAVAILABLE', 'NO_ELIGIBLE_ENDPOINT', 'ENDPOINT_NOT_READY', 'TASK_NOT_CLAIMABLE', 'NOT_TASK_HOLDER', 'INVALID_TRANSITION']);
const NOT_FOUND_CODES = new Set(['UNKNOWN_BACKEND', 'PROFILE_NOT_REGISTERED', 'UNKNOWN_ENDPOINT']);

export class ExecutionBackendError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ExecutionBackendError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = NOT_FOUND_CODES.has(code) ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
    Object.assign(this, extra);
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;

const freeze = value => {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};

/** `backendId` is a stable, machine-readable name such as `standard-devices`. */
export function assertBackendId(value) {
  if (!isText(value) || !/^[a-z][a-z0-9-]{1,63}$/.test(value.trim())) {
    throw new ExecutionBackendError('INVALID_BACKEND', `backendId must match [a-z][a-z0-9-]{1,63}, got ${String(value)}`);
  }
  return value.trim();
}

export function assertProfile(value) {
  if (!EXECUTION_PROFILES.includes(value)) {
    throw new ExecutionBackendError('INVALID_PROFILE', `execution profile must be one of ${EXECUTION_PROFILES.join(', ')}, got ${String(value)}`);
  }
  return value;
}

/**
 * A readiness fact. `reason` is always present (null when READY) so a surface never has to invent an
 * explanation for why something is not usable.
 */
export function describeReadiness({ state, reason = null, detail = null, endpointCount = 0, readyEndpointCount = 0 } = {}) {
  if (!READINESS_STATES.includes(state)) {
    throw new ExecutionBackendError('INVALID_BACKEND', `readiness state must be one of ${READINESS_STATES.join(', ')}, got ${String(state)}`);
  }
  if (state !== 'READY' && !isText(reason)) {
    throw new ExecutionBackendError('INVALID_BACKEND', `readiness state ${state} requires a reason`);
  }
  return freeze({
    state,
    ready: state === 'READY',
    usable: state === 'READY' || state === 'DEGRADED',
    reason: reason ?? null,
    detail: detail ?? null,
    endpointCount,
    readyEndpointCount,
  });
}

/**
 * One candidate execution endpoint, as a *view*. Nothing here is an identity claim: `endpointRef` names the
 * endpoint inside its own backend (for `STANDARD_DEVICES` it is the City node id), and `capabilities` is what
 * the endpoint advertised, not what this layer decided it can do.
 */
export function executionEndpoint({
  endpointRef, displayName = null, platform = null, ready = false, capabilities = [], online = false,
  sharingEnabled = true, readinessReason = null, lastHeartbeatAt = null, kind = 'DEVICE',
  isWorker = true, isControlSurface = false,
} = {}) {
  if (!isText(endpointRef)) throw new ExecutionBackendError('INVALID_REQUEST', 'endpointRef is required');
  return freeze({
    endpointRef,
    displayName: displayName ?? endpointRef,
    platform: platform ?? null,
    kind,
    ready: ready === true,
    online: online === true,
    sharingEnabled: sharingEnabled !== false,
    capabilities: freeze([...(Array.isArray(capabilities) ? capabilities : [])]),
    readinessReason: readinessReason ?? null,
    lastHeartbeatAt: lastHeartbeatAt ?? null,
    // Stated on every row so a reader cannot mistake a control surface for an execution resource.
    isWorker: isWorker === true,
    isControlSurface: isControlSurface === true,
  });
}

/**
 * Assert that a value is a conforming execution backend port.
 *
 * Conformance is checked on the *shape* (the six methods and the identity fields), not on behaviour: a port
 * that lies about its own readiness will be caught by the equivalence tests against the real gateway, whereas
 * a port that is missing `report` can never work and is caught here, at wiring time, with a named field.
 */
export function assertExecutionBackendPort(port, path = 'port') {
  if (!isPlainObject(port) && typeof port !== 'object') throw new ExecutionBackendError('INVALID_BACKEND', `${path} must be an object`);
  assertBackendId(port.backendId);
  if (port.contractVersion !== EXECUTION_BACKEND_CONTRACT_VERSION) {
    throw new ExecutionBackendError('INCOMPATIBLE_CONTRACT', `${path}.contractVersion must be ${EXECUTION_BACKEND_CONTRACT_VERSION}, got ${String(port.contractVersion)}`);
  }
  assertProfile(port.profile);
  if (!BACKEND_KINDS.includes(port.kind)) {
    throw new ExecutionBackendError('INVALID_BACKEND', `${path}.kind must be one of ${BACKEND_KINDS.join(', ')}, got ${String(port.kind)}`);
  }
  if (!BACKEND_MODES.includes(port.mode)) {
    throw new ExecutionBackendError('INVALID_BACKEND', `${path}.mode must be one of ${BACKEND_MODES.join(', ')}, got ${String(port.mode)}`);
  }
  for (const method of REQUIRED_PORT_METHODS) {
    if (typeof port[method] !== 'function') throw new ExecutionBackendError('INVALID_BACKEND', `${path}.${method} must be a function`);
  }
  return port;
}

/** A short, stable descriptor for diagnostics — never used to make a routing decision. */
export function describeExecutionBackend(port) {
  assertExecutionBackendPort(port);
  return freeze({
    contractVersion: port.contractVersion,
    backendId: port.backendId,
    kind: port.kind,
    profile: port.profile,
    mode: port.mode,
    canExecute: port.mode === 'enabled',
  });
}

/**
 * The backend registry.
 *
 * The registry deliberately knows how to hold a *dormant* backend, because the whole point of a compatibility
 * migration is that the seam can exist before the resource does. It also deliberately refuses to invent one:
 * asking for a profile nobody registered is `PROFILE_NOT_REGISTERED`, not a silent fallback to the default.
 * A silent fallback here would be the exact failure this programme forbids — a future `WORKER_POOL` request
 * quietly served by the Windows devices while every surface reports that the pool is doing the work.
 */
export function createExecutionBackendRegistry({ defaultProfile = DEFAULT_EXECUTION_PROFILE } = {}) {
  assertProfile(defaultProfile);
  const backends = new Map();
  const profileIndex = new Map();
  const history = [];

  const note = (event, detail) => {
    history.push(freeze({ event, at: new Date().toISOString(), ...detail }));
  };

  const api = {
    contractVersion: EXECUTION_BACKEND_CONTRACT_VERSION,
    defaultProfile,

    register(port) {
      assertExecutionBackendPort(port);
      const prior = backends.get(port.backendId);
      if (prior && prior.profile !== port.profile) {
        throw new ExecutionBackendError('INVALID_BACKEND', `backend ${port.backendId} is already registered under profile ${prior.profile}`);
      }
      // One profile owns one live backend id. Two backends answering for the same profile would make
      // "which resource executed this" unanswerable, so the conflict is refused by name rather than resolved.
      const owner = profileIndex.get(port.profile);
      if (owner !== undefined && owner !== port.backendId) {
        throw new ExecutionBackendError('INVALID_BACKEND', `profile ${port.profile} is already served by backend ${owner}`);
      }
      backends.set(port.backendId, port);
      profileIndex.set(port.profile, port.backendId);
      note('BACKEND_REGISTERED', { backendId: port.backendId, profile: port.profile, mode: port.mode, replaced: prior !== undefined });
      return describeExecutionBackend(port);
    },

    has: backendId => typeof backendId === 'string' && backends.has(backendId),

    get(backendId) {
      const found = backends.get(String(backendId));
      if (!found) throw new ExecutionBackendError('UNKNOWN_BACKEND', `no backend is registered as ${String(backendId)}`);
      return found;
    },

    forProfile(profile) {
      assertProfile(profile);
      const backendId = profileIndex.get(profile);
      if (backendId === undefined) {
        throw new ExecutionBackendError('PROFILE_NOT_REGISTERED', `no execution backend serves profile ${profile}`, { profile });
      }
      return backends.get(backendId);
    },

    /** The backend ordinary work uses, unless a caller explicitly asks for another profile. */
    active(profile = defaultProfile) {
      const port = api.forProfile(profile);
      if (port.mode !== 'enabled') {
        throw new ExecutionBackendError('BACKEND_DORMANT', `execution backend ${port.backendId} for profile ${profile} is registered but dormant`, { backendId: port.backendId, profile });
      }
      return port;
    },

    profiles: () => [...profileIndex.keys()].sort(),
    list: () => [...backends.values()].map(describeExecutionBackend),
    history: () => [...history],
  };
  return Object.freeze(api);
}
