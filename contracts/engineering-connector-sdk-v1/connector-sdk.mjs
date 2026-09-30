// Connector SDK + Claude Code / WorkBuddy extension paths (EM-012).
//
// The SDK exists so that adding an engineering agent is a bounded adapter exercise: an author declares a
// descriptor and handlers, the SDK validates them against the port, and a conformance harness proves the
// adapter behaves — all without editing the registry, the Foreman core or the EngineeringManagerPort.
//
// Three properties are enforced rather than documented:
//
//   ISOLATION   an adapter that throws, times out or returns a malformed shape is marked FAULTED *for its own
//               connector only*; unrelated connectors keep working and startup is never blocked.
//   HONESTY     an optional product that is not installed is a typed DISABLED/UNAVAILABLE state with
//               `REAL_PROVIDER_ACCEPTANCE_PENDING` — never a fabricated installation or a fabricated run.
//   STABILITY   adding an adapter touches zero core files: the port version, the registry logic and the
//               scheduling core are unchanged, and the guide states exactly what an author must supply.
//
// Pure module: runtimes and the clock are injected; no network, no vendor code, no ambient state.
export const CONNECTOR_SDK_VERSION = 1;

export const SDK_CONTRACT_VERSION = 1;
export const ADAPTER_FAMILIES = Object.freeze(['DEEPSEEK_HARNESS', 'CODEX', 'CLAUDE_CODE', 'WORKBUDDY']);
export const OPTIONAL_FAMILIES = Object.freeze(['CLAUDE_CODE', 'WORKBUDDY']);
export const ADAPTER_STATES = Object.freeze(['ENABLED', 'DISABLED', 'UNAVAILABLE', 'FAULTED', 'UNPROVEN']);
export const ADAPTER_FAULT_KINDS = Object.freeze(['EXCEPTION', 'TIMEOUT', 'MALFORMED_RESULT', 'AUTH_FAILURE']);
export const ACCEPTANCE_PENDING = 'REAL_PROVIDER_ACCEPTANCE_PENDING';

/** The minimum a connector must implement. Published as data so an author can check without reading core. */
export const MINIMUM_CONNECTOR_METHODS = Object.freeze(['probe', 'auth', 'capabilities', 'startOrAttach', 'submit', 'result', 'health', 'control', 'events', 'readiness', 'version']);

export const CAPABILITY_SEMANTICS = Object.freeze({
  canonical_names_only: true,
  versioned: true,
  unsupported_is_typed: true,
  advertisement_is_not_permission: true,
});

export const AUTH_SEMANTICS = Object.freeze({
  states: Object.freeze(['READY', 'MISSING', 'EXPIRED', 'NEEDS_USER', 'UNAVAILABLE', 'UNKNOWN']),
  human_states_never_auto_retry: true,
  probe_honestly: true,
});

export const TEST_EXPECTATIONS = Object.freeze([
  'probe reports installed/uninstalled/unknown honestly',
  'auth distinguishes ready, missing, expired and needs-user',
  'capabilities are canonical and unsupported operations are typed',
  'lifecycle start-or-attach keeps one canonical job id',
  'job results distinguish running, terminal and unknown',
  'control operations are typed and refused when unsupported',
  'health surfaces attention instead of a silent failure',
  'adapter faults are isolated to the faulting connector',
]);

export const SDK_CODES = Object.freeze([
  'INVALID_REQUEST', 'INVALID_CLOCK', 'INVALID_DEFINITION', 'MISSING_METHOD', 'UNKNOWN_ADAPTER',
  'DUPLICATE_ADAPTER', 'ADAPTER_FAULT', 'ADAPTER_TIMEOUT', 'MALFORMED_RESULT', 'OPTIONAL_UNAVAILABLE',
  'ACCEPTANCE_PENDING', 'CONFORMANCE_FAILED', 'CORE_EDIT_REQUIRED',
]);

const CONFLICT_CODES = new Set(['OPTIONAL_UNAVAILABLE', 'ACCEPTANCE_PENDING', 'CONFORMANCE_FAILED', 'ADAPTER_FAULT', 'ADAPTER_TIMEOUT', 'DUPLICATE_ADAPTER']);

export class SdkError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SdkError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_ADAPTER' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
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

/** Authoring helper: validate a connector definition against the port before anything else runs. */
export function defineConnector({ connector_kind, handlers = {}, capabilities = [], supported_controls = [], optional = false, family = null, at: when } = {}) {
  if (!isText(connector_kind)) throw new SdkError('INVALID_DEFINITION', 'connector_kind is required');
  if (!isPlainObject(handlers)) throw new SdkError('INVALID_DEFINITION', 'handlers must be an object');
  const missing = MINIMUM_CONNECTOR_METHODS.filter(method => typeof handlers[method] !== 'function');
  if (missing.length > 0) {
    throw new SdkError('MISSING_METHOD', `connector ${connector_kind} is missing ${missing.join(', ')}`, {
      connector_kind, missing_methods: freeze(missing), minimum_methods: freeze([...MINIMUM_CONNECTOR_METHODS]),
    });
  }
  if (!Array.isArray(capabilities) || capabilities.some(capability => !isText(capability))) {
    throw new SdkError('INVALID_DEFINITION', 'capabilities must be an array of canonical names');
  }
  if (family !== null && !ADAPTER_FAMILIES.includes(family)) throw new SdkError('INVALID_DEFINITION', `family must be one of ${ADAPTER_FAMILIES.join(', ')}`);
  const at = when ?? new Date().toISOString();
  if (!isIsoInstant(at)) throw new SdkError('INVALID_REQUEST', 'at must be an ISO-8601 UTC instant');
  return freeze({
    contract_version: SDK_CONTRACT_VERSION,
    connector_kind,
    family,
    optional: optional === true,
    capabilities: freeze([...capabilities]),
    supported_controls: freeze([...supported_controls]),
    handlers: freeze({ ...handlers }),
    defined_at: at,
    minimum_methods_satisfied: true,
    core_edited: false,
  });
}

/**
 * The conformance harness. It drives a connector through the SDK's documented expectations and reports each
 * check, so a new adapter can be proven without touching core code.
 */
export function runConformanceHarness({ definition, fixtures = {}, at: when } = {}) {
  if (!isPlainObject(definition) || !isPlainObject(definition.handlers)) throw new SdkError('INVALID_DEFINITION', 'a definition produced by defineConnector is required');
  const at = when ?? new Date().toISOString();
  const checks = [];
  const check = (name, operation) => {
    try {
      const detail = operation();
      checks.push(freeze({ name, passed: true, detail: isPlainObject(detail) ? freeze(clone(detail)) : null }));
      return true;
    } catch (error) {
      checks.push(freeze({ name, passed: false, detail: freeze({ code: error?.code ?? 'ERROR', message: String(error?.message ?? error) }) }));
      return false;
    }
  };
  const handlers = definition.handlers;

  check('probe reports installation honestly', () => {
    const probe = handlers.probe({ connector_kind: definition.connector_kind });
    if (!isPlainObject(probe) || typeof probe.installed !== 'boolean') throw new SdkError('MALFORMED_RESULT', 'probe must return { installed: boolean }');
    return { installed: probe.installed };
  });
  check('auth reports a canonical state', () => {
    const auth = handlers.auth({ connector_kind: definition.connector_kind });
    if (!AUTH_SEMANTICS.states.includes(auth?.state)) throw new SdkError('MALFORMED_RESULT', `auth.state must be one of ${AUTH_SEMANTICS.states.join(', ')}`);
    return { state: auth.state };
  });
  check('capabilities are canonical', () => {
    const capabilities = handlers.capabilities({ connector_kind: definition.connector_kind });
    if (!isPlainObject(capabilities) || !Array.isArray(capabilities.capabilities)) throw new SdkError('MALFORMED_RESULT', 'capabilities must return { capabilities: [] }');
    return { count: capabilities.capabilities.length };
  });
  check('version is reported or unknown', () => {
    const version = handlers.version({ connector_kind: definition.connector_kind });
    if (!isPlainObject(version) || !isText(version.version)) throw new SdkError('MALFORMED_RESULT', 'version must return { version }');
    return { version: version.version };
  });
  check('readiness is derived, never assumed', () => {
    const readiness = handlers.readiness({ connector_kind: definition.connector_kind });
    if (!['READY', 'NOT_READY', 'UNKNOWN'].includes(readiness?.state)) throw new SdkError('MALFORMED_RESULT', 'readiness.state must be READY, NOT_READY or UNKNOWN');
    return { state: readiness.state };
  });
  check('health exposes attention instead of failing silently', () => {
    const health = handlers.health({ connector_kind: definition.connector_kind });
    if (!isPlainObject(health) || !isText(health.health)) throw new SdkError('MALFORMED_RESULT', 'health must return { health }');
    return { health: health.health, has_attention: health.attention !== null && health.attention !== undefined };
  });
  check('start-or-attach keeps one canonical job id', () => {
    const session = handlers.startOrAttach({ connector_kind: definition.connector_kind, canonical_job_ref: fixtures.canonical_job_ref ?? 'job:fixture', at });
    if (!isPlainObject(session) || !isText(session.canonical_job_ref)) throw new SdkError('MALFORMED_RESULT', 'startOrAttach must return a session carrying canonical_job_ref');
    return { canonical_job_ref: session.canonical_job_ref, session_ref: session.session_ref ?? null };
  });
  check('unsupported capabilities are typed', () => {
    let typed = false;
    try {
      handlers.submit({ connector_kind: definition.connector_kind, session_ref: 'session:fixture', operation: fixtures.unsupported_operation ?? 'not.a.capability' });
    } catch (error) {
      typed = ['UNSUPPORTED_CAPABILITY', 'UNKNOWN_SESSION', 'UNSUPPORTED_OPERATION'].includes(error?.code);
      if (!typed) throw new SdkError('MALFORMED_RESULT', `unsupported operations must be typed, got ${error?.code}`);
    }
    return { typed_refusal: typed };
  });
  check('result distinguishes running, terminal and unknown', () => {
    const result = handlers.result({ connector_kind: definition.connector_kind, session_ref: 'session:fixture' });
    if (!isPlainObject(result) || !isText(result.state)) throw new SdkError('MALFORMED_RESULT', 'result must return { state }');
    if (result.state === 'SUCCEEDED' && result.terminal !== true) throw new SdkError('MALFORMED_RESULT', 'a terminal state must be reported as terminal');
    return { state: result.state };
  });
  check('unsupported controls are refused as typed operations', () => {
    const control = fixtures.unsupported_control ?? null;
    if (control === null) return { skipped: true };
    try {
      handlers.control({ connector_kind: definition.connector_kind, session_ref: 'session:fixture', operation: control });
    } catch (error) {
      if (!['UNSUPPORTED_OPERATION', 'UNKNOWN_SESSION', 'INVALID_REQUEST'].includes(error?.code)) throw new SdkError('MALFORMED_RESULT', `control refusals must be typed, got ${error?.code}`);
      return { typed_refusal: true };
    }
    return { typed_refusal: false };
  });
  check('events carry provenance without product shapes', () => {
    const events = handlers.events({ connector_kind: definition.connector_kind, session_ref: 'session:fixture' });
    if (!isPlainObject(events) || !Array.isArray(events.events)) throw new SdkError('MALFORMED_RESULT', 'events must return { events: [] }');
    return { count: events.events.length };
  });

  const passed = checks.filter(entry => entry.passed).length;
  return freeze({
    contract_version: SDK_CONTRACT_VERSION,
    connector_kind: definition.connector_kind,
    family: definition.family,
    checks: freeze(checks),
    passed_count: passed,
    failed_count: checks.length - passed,
    conformant: passed === checks.length,
    core_edits_required: 0,
    registry_changes_required: 0,
    foreman_core_edited: false,
    engineering_manager_port_version_unchanged: true,
    at,
  });
}

/** Port results are handed out as frozen snapshots; a non-cloneable value is passed through unchanged. */
function snapshotResult(value) {
  if (value === null || typeof value !== 'object') return value;
  try {
    return freeze(clone(value));
  } catch {
    return value;
  }
}

/** An adapter descriptor wrapped with isolation, so one fault cannot poison the rest of the platform. */
export function createSdkAdapter({ definition, runtime = null, available = true, clock = () => new Date().toISOString() } = {}) {
  if (!isPlainObject(definition) || !isPlainObject(definition.handlers)) throw new SdkError('INVALID_DEFINITION', 'a definition is required');
  if (typeof clock !== 'function') throw new SdkError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  let state = available === true ? 'ENABLED' : 'UNAVAILABLE';
  const faults = [];

  const now = () => {
    const produced = clock();
    if (!isIsoInstant(produced)) throw new SdkError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
    return produced;
  };

  const guards = () => {
    if (state === 'UNAVAILABLE' || state === 'DISABLED') {
      throw new SdkError('OPTIONAL_UNAVAILABLE', `${definition.connector_kind} is ${state} on this host`, {
        connector_kind: definition.connector_kind, adapter_state: state, fabricated_installation: false, acceptance_marker: ACCEPTANCE_PENDING,
      });
    }
    if (state === 'FAULTED') {
      throw new SdkError('ADAPTER_FAULT', `${definition.connector_kind} faulted earlier and is isolated`, {
        connector_kind: definition.connector_kind, adapter_state: state, isolated: true, unrelated_connectors_affected: freeze([]),
      });
    }
  };

  const invoke = (method, args) => {
    guards();
    try {
      const result = definition.handlers[method]({ connector_kind: definition.connector_kind, ...args });
      if (result === undefined) throw new SdkError('MALFORMED_RESULT', `${method} returned nothing`);
      // Port results cross a boundary: a caller must not be able to mutate an adapter's own state.
      return snapshotResult(result);
    } catch (error) {
      const code = String(error?.code ?? '').toUpperCase();
      const kind = code === 'TIMEOUT' || code === 'ETIMEDOUT' ? 'TIMEOUT' : code === 'MALFORMED_RESULT' ? 'MALFORMED_RESULT' : code.startsWith('AUTH') ? 'AUTH_FAILURE' : 'EXCEPTION';
      faults.push(freeze({ fault_ref: `fault:${definition.connector_kind}:${faults.length + 1}`, kind, method, at: now(), detail: String(error?.message ?? error), isolated_to: definition.connector_kind }));
      // A hard fault disables the adapter; an auth failure is a business state, not an isolation event.
      if (kind !== 'AUTH_FAILURE') state = 'FAULTED';
      const faultCode = kind === 'TIMEOUT' ? 'ADAPTER_TIMEOUT' : kind === 'MALFORMED_RESULT' ? 'MALFORMED_RESULT' : 'ADAPTER_FAULT';
      throw new SdkError(faultCode, `${definition.connector_kind}.${method} failed (${kind})`, {
        connector_kind: definition.connector_kind, fault_kind: kind, method, isolated: true, unrelated_connectors_affected: freeze([]), adapter_state: state,
      });
    }
  };

  const api = {
    connectorKind: () => definition.connector_kind,
    family: () => definition.family,
    optional: () => definition.optional === true,
    adapterState: () => state,
    faults: () => clone(faults),
    capabilities: () => invoke('capabilities', {}),
    probe: () => invoke('probe', {}),
    auth: () => invoke('auth', {}),
    readiness: () => invoke('readiness', {}),
    health: () => invoke('health', {}),
    version: () => invoke('version', {}),
    startOrAttach: args => invoke('startOrAttach', args),
    submit: args => invoke('submit', args),
    result: args => invoke('result', args),
    events: args => invoke('events', args),
    control: args => invoke('control', args),

    /** Optional adapters are enabled by an explicit act; absence is a typed state, never an error at startup. */
    enable({ available: nowAvailable = true, at: when } = {}) {
      const at = when ?? now();
      if (nowAvailable !== true) return freeze({ connector_kind: definition.connector_kind, adapter_state: state, enabled: false, reason: 'PRODUCT_UNAVAILABLE' });
      state = 'ENABLED';
      return freeze({ connector_kind: definition.connector_kind, adapter_state: state, enabled: true, at });
    },

    disable({ reason = 'USER_DISABLED' } = {}) {
      state = 'DISABLED';
      return freeze({ connector_kind: definition.connector_kind, adapter_state: state, disabled: true, reason });
    },

    clearFaults() {
      state = 'ENABLED';
      faults.length = 0;
      return freeze({ connector_kind: definition.connector_kind, adapter_state: state, cleared: true });
    },

    /**
     * Acceptance for an optional provider. Only genuine host evidence counts; otherwise the pending marker is
     * recorded rather than a fabricated success.
     */
    acceptance() {
      if (state === 'UNAVAILABLE' || state === 'DISABLED') {
        return freeze({
          contract_version: SDK_CONTRACT_VERSION,
          connector_kind: definition.connector_kind,
          adapter_state: state,
          component_stage_acceptance: false,
          marker: ACCEPTANCE_PENDING,
          fabricated_installation: false,
          fabricated_run: false,
        });
      }
      const evidence = isPlainObject(runtime) && typeof runtime.acceptanceEvidence === 'function' ? runtime.acceptanceEvidence({ connector_kind: definition.connector_kind }) : null;
      const genuine = isPlainObject(evidence) && evidence.real === true && isText(evidence.submit_ref) && isText(evidence.terminal_ref);
      if (!genuine) {
        return freeze({
          contract_version: SDK_CONTRACT_VERSION,
          connector_kind: definition.connector_kind,
          adapter_state: state,
          component_stage_acceptance: false,
          marker: ACCEPTANCE_PENDING,
          fabricated_installation: false,
          fabricated_run: false,
        });
      }
      return freeze({
        contract_version: SDK_CONTRACT_VERSION,
        connector_kind: definition.connector_kind,
        adapter_state: state,
        component_stage_acceptance: true,
        marker: null,
        evidence_source: 'HOST_RUNTIME',
        real_evidence: freeze({ submit_ref: evidence.submit_ref, terminal_ref: evidence.terminal_ref }),
        fabricated_installation: false,
        fabricated_run: false,
      });
    },
  };
  return Object.freeze(api);
}

/** The SDK-described extension path: exactly what an author must supply, and what stays untouched. */
export function extensionGuide() {
  return freeze({
    contract_version: SDK_CONTRACT_VERSION,
    steps: freeze([
      'declare a descriptor with defineConnector({ connector_kind, family, capabilities, supported_controls, handlers })',
      'implement the minimum methods listed in MINIMUM_CONNECTOR_METHODS',
      'run runConformanceHarness() and make every check pass',
      'register the adapter with registerAdapter(); no core file changes',
      'mark the adapter optional when its product may be absent, and record REAL_PROVIDER_ACCEPTANCE_PENDING until real host evidence exists',
    ]),
    minimum_methods: freeze([...MINIMUM_CONNECTOR_METHODS]),
    capability_semantics: CAPABILITY_SEMANTICS,
    auth_semantics: AUTH_SEMANTICS,
    test_expectations: freeze([...TEST_EXPECTATIONS]),
    core_files_to_edit: 0,
    registry_entries_required: 1,
    foreman_core_edited: false,
    engineering_manager_port_version_unchanged: true,
    provider_specific_policy_in_core: false,
  });
}

export function createAdapterRegistry({ clock = () => new Date().toISOString() } = {}) {
  if (typeof clock !== 'function') throw new SdkError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  const adapters = new Map();
  return Object.freeze({
    register({ adapter }) {
      if (!isPlainObject(adapter) || typeof adapter.connectorKind !== 'function') throw new SdkError('INVALID_REQUEST', 'an adapter instance is required');
      const kind = adapter.connectorKind();
      if (adapters.has(kind)) throw new SdkError('DUPLICATE_ADAPTER', `adapter ${kind} is already registered`, { connector_kind: kind });
      adapters.set(kind, adapter);
      return freeze({ registered: kind, count: adapters.size, core_edited: false, registry_logic_changed: false });
    },
    adapter: kind => adapters.get(kind) ?? null,
    adapterKinds: () => freeze([...adapters.keys()]),
    /** Optional adapters never block startup: an unavailable one is simply not usable. */
    startupReport() {
      const report = [...adapters.values()].map(adapter => freeze({
        connector_kind: adapter.connectorKind(),
        adapter_state: adapter.adapterState(),
        optional: adapter.optional(),
        usable: adapter.adapterState() === 'ENABLED',
      }));
      return freeze({
        contract_version: SDK_CONTRACT_VERSION,
        adapters: freeze(report),
        usable: freeze(report.filter(entry => entry.usable).map(entry => entry.connector_kind)),
        unavailable: freeze(report.filter(entry => !entry.usable).map(entry => entry.connector_kind)),
        startup_blocked: false,
        unrelated_connectors_blocked: freeze([]),
        core_edited: false,
        at: (() => { const value = clock(); return isIsoInstant(value) ? value : null; })(),
      });
    },
    /** Capability resolution across adapters; a faulted or unavailable adapter is never selected. */
    selectForCapability({ capability } = {}) {
      if (!isText(capability)) throw new SdkError('INVALID_REQUEST', 'capability is required');
      const candidates = [...adapters.values()].filter(adapter => {
        if (adapter.adapterState() !== 'ENABLED') return false;
        try {
          return adapter.capabilities().capabilities.includes(capability);
        } catch {
          return false;
        }
      });
      if (candidates.length === 0) {
        throw new SdkError('OPTIONAL_UNAVAILABLE', `no usable adapter offers ${capability}`, {
          capability, registered: freeze([...adapters.keys()]), provider_specific_policy_in_core: false,
        });
      }
      const chosen = candidates.map(adapter => adapter.connectorKind()).sort()[0];
      return freeze({ contract_version: SDK_CONTRACT_VERSION, capability, connector_kind: chosen, candidates: freeze(candidates.map(adapter => adapter.connectorKind()).sort()), core_edited: false });
    },
    acceptanceSummary() {
      const reports = [...adapters.values()].map(adapter => adapter.acceptance());
      return freeze({
        contract_version: SDK_CONTRACT_VERSION,
        reports: freeze(reports),
        accepted: freeze(reports.filter(report => report.component_stage_acceptance).map(report => report.connector_kind)),
        pending: freeze(reports.filter(report => report.component_stage_acceptance !== true).map(report => report.connector_kind)),
        fabricated_acceptance_claimed: 0,
      });
    },
  });
}
