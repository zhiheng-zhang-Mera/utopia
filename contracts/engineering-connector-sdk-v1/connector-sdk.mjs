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
// The job-result vocabulary a connector may report; anything else is a malformed answer, not a state.
export const RESULT_STATES = Object.freeze(['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN']);
export const TERMINAL_RESULT_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'CANCELLED']);
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

/** Authoring helper: validate a connector definition against the port before anything else runs. */
export function defineConnector({ connector_kind, handlers = {}, capabilities = [], supported_controls = [], optional = false, family = null, at: when } = {}) {
  if (!isText(connector_kind)) throw new SdkError('INVALID_DEFINITION', 'connector_kind is required');
  if (!isPlainObject(handlers)) throw new SdkError('INVALID_DEFINITION', 'handlers must be a plain object of methods');
  // Own methods only: an inherited or non-enumerable handler is not a method this connector implements.
  const missing = MINIMUM_CONNECTOR_METHODS.filter(method => !Object.hasOwn(handlers, method) || typeof handlers[method] !== 'function');
  if (missing.length > 0) {
    throw new SdkError('MISSING_METHOD', `connector ${connector_kind} is missing ${missing.join(', ')}`, {
      connector_kind, missing_methods: freeze(missing), minimum_methods: freeze([...MINIMUM_CONNECTOR_METHODS]),
    });
  }
  if (!Array.isArray(capabilities) || capabilities.some(capability => !isText(capability))) {
    throw new SdkError('INVALID_DEFINITION', 'capabilities must be an array of canonical names');
  }
  if (!Array.isArray(supported_controls) || supported_controls.some(control => !isText(control))) {
    throw new SdkError('INVALID_DEFINITION', 'supported_controls must be an array of canonical control names');
  }
  // A truthy string is not a declaration: an opt-in must be the boolean it claims to be.
  if (typeof optional !== 'boolean') throw new SdkError('INVALID_DEFINITION', 'optional must be a boolean');
  if (family !== null && !ADAPTER_FAMILIES.includes(family)) throw new SdkError('INVALID_DEFINITION', `family must be one of ${ADAPTER_FAMILIES.join(', ')}`);
  const at = when ?? new Date().toISOString();
  if (!isRealInstant(at)) throw new SdkError('INVALID_REQUEST', 'at must be a real ISO-8601 UTC instant, got ' + String(at));
  // The stored record is built from the validated own methods, so the claim below describes what a caller
  // actually receives rather than the object that was passed in.
  const storedHandlers = {};
  for (const method of MINIMUM_CONNECTOR_METHODS) storedHandlers[method] = handlers[method];
  for (const key of Object.keys(handlers)) if (!Object.hasOwn(storedHandlers, key)) storedHandlers[key] = handlers[key];
  return freeze({
    contract_version: SDK_CONTRACT_VERSION,
    connector_kind,
    family,
    optional: optional === true,
    capabilities: freeze([...new Set(capabilities)]),
    supported_controls: freeze([...new Set(supported_controls)]),
    handlers: freeze(storedHandlers),
    defined_at: at,
    minimum_methods_satisfied: MINIMUM_CONNECTOR_METHODS.every(method => typeof storedHandlers[method] === 'function'),
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
  if (!isRealInstant(at)) throw new SdkError('INVALID_REQUEST', 'at must be a real ISO-8601 UTC instant, got ' + String(at));
  const checks = [];
  const check = (name, operation) => {
    try {
      const detail = operation();
      checks.push(freeze({ name, passed: true, detail: isPlainObject(detail) ? freeze(clone(detail)) : null }));
      return true;
    } catch (error) {
      checks.push(freeze({ name, passed: false, detail: freeze({ code: error?.code ?? (error?.name === 'DataCloneError' ? 'MALFORMED_RESULT' : 'ERROR'), message: String(error?.message ?? error) }) }));
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
    // A capability the definition declares but the connector does not report is not a capability it has.
    const declared = Array.isArray(definition.capabilities) ? definition.capabilities : [];
    const unreported = declared.filter(capability => !capabilities.capabilities.includes(capability));
    if (unreported.length > 0) throw new SdkError('MALFORMED_RESULT', 'declared capabilities the connector does not report: ' + unreported.join(', '));
    return { count: capabilities.capabilities.length, declared_count: declared.length };
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
    // A connector that silently accepts an unsupported operation has not proved the expectation.
    if (!typed) throw new SdkError('MALFORMED_RESULT', 'an unsupported capability must be refused with a typed code, not accepted');
    return { typed_refusal: true };
  });
  check('result distinguishes running, terminal and unknown', () => {
    const result = handlers.result({ connector_kind: definition.connector_kind, session_ref: 'session:fixture' });
    if (!isPlainObject(result) || !isText(result.state)) throw new SdkError('MALFORMED_RESULT', 'result must return { state }');
    if (!RESULT_STATES.includes(result.state)) throw new SdkError('MALFORMED_RESULT', 'result.state must be one of ' + RESULT_STATES.join(', '));
    if (TERMINAL_RESULT_STATES.includes(result.state) && result.terminal !== true) throw new SdkError('MALFORMED_RESULT', 'a terminal state must be reported as terminal');
    if (!TERMINAL_RESULT_STATES.includes(result.state) && result.terminal === true) throw new SdkError('MALFORMED_RESULT', 'a non-terminal state cannot be reported as terminal');
    return { state: result.state };
  });
  check('unsupported controls are refused as typed operations', () => {
    // The check runs by default: an optional skip would let an unproven connector look conformant.
    const control = fixtures.unsupported_control ?? 'sdk.unsupported.control';
    if (control === null) return { skipped: true };
    try {
      handlers.control({ connector_kind: definition.connector_kind, session_ref: 'session:fixture', operation: control });
    } catch (error) {
      if (!['UNSUPPORTED_OPERATION', 'UNKNOWN_SESSION', 'INVALID_REQUEST'].includes(error?.code)) throw new SdkError('MALFORMED_RESULT', `control refusals must be typed, got ${error?.code}`);
      return { typed_refusal: true };
    }
    throw new SdkError('MALFORMED_RESULT', 'an unsupported control must be refused with a typed code, not accepted');
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
    skipped_count: checks.filter(entry => entry.detail?.skipped === true).length,
    conformant: passed === checks.length,
    // These are claims about this harness applied to a connector that proved itself: a non-conformant
    // connector gets no such certificate, so the fields are withheld rather than asserted.
    core_edits_required: passed === checks.length ? 0 : null,
    registry_changes_required: passed === checks.length ? 0 : null,
    foreman_core_edited: passed === checks.length ? false : null,
    engineering_manager_port_version_unchanged: passed === checks.length ? true : null,
    claims_withheld: passed !== checks.length,
    at,
  });
}

/** Port results are handed out as frozen snapshots; a non-cloneable value is passed through unchanged. */
function snapshotResult(value) {
  if (value === null || typeof value !== 'object') return value;
  let copy = null;
  try {
    copy = structuredClone(value);
  } catch (error) {
    // Handing the adapter's own object out live would let a caller mutate its state.
    throw new SdkError('MALFORMED_RESULT', 'a port result must be cloneable: ' + String(error?.message ?? error));
  }
  return freeze(copy);
}

/** An adapter descriptor wrapped with isolation, so one fault cannot poison the rest of the platform. */
const SDK_ADAPTER_BRAND = Symbol('em012.connector.sdk.adapter');

// Fault identities are unique across every adapter in the process, not just within one adapter.
let FAULT_SEQ = 0;

export function createSdkAdapter({ definition, runtime = null, available = true, clock = () => new Date().toISOString() } = {}) {
  if (!isPlainObject(definition) || !isPlainObject(definition.handlers)) throw new SdkError('INVALID_DEFINITION', 'a definition is required');
  if (typeof clock !== 'function') throw new SdkError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  let state = available === true ? 'ENABLED' : 'UNAVAILABLE';
  const faults = [];
  const faultHistory = [];

  const now = () => {
    const produced = clock();
    if (!isRealInstant(produced)) throw new SdkError('INVALID_CLOCK', 'clock() must return a real ISO-8601 UTC instant');
    return produced;
  };

  const atFrom = when => {
    if (when === undefined || when === null) return now();
    if (!isRealInstant(when)) throw new SdkError('INVALID_REQUEST', 'at must be a real ISO-8601 UTC instant, got ' + String(when));
    return when;
  };

  /**
   * What the adapter itself reports about installation, read without faulting anything: a faulted adapter is
   * UNKNOWN. Availability claims follow this, not the enable flag alone.
   */
  const installState = () => {
    if (state === 'FAULTED') return 'UNKNOWN';
    try {
      const probe = definition.handlers.probe({ connector_kind: definition.connector_kind });
      if (!isPlainObject(probe) || typeof probe.installed !== 'boolean') return 'UNKNOWN';
      return probe.installed === true ? 'INSTALLED' : 'NOT_INSTALLED';
    } catch {
      return 'UNKNOWN';
    }
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
      // Reading a hostile error must not replace the fault with a second, untyped failure: an object whose
      // `code` or `message` getter throws is an unreadable fault, still isolated and still recorded.
      let code = '';
      let detail = 'unreadable error';
      let codeReadable = true;
      try {
        code = String(error?.code ?? '').toUpperCase();
        detail = String(error?.message ?? error);
      } catch {
        codeReadable = false;
      }
      const kind = !codeReadable ? 'EXCEPTION' : code === 'TIMEOUT' || code === 'ETIMEDOUT' ? 'TIMEOUT' : code === 'MALFORMED_RESULT' ? 'MALFORMED_RESULT' : code.startsWith('AUTH') ? 'AUTH_FAILURE' : 'EXCEPTION';
      // A hard fault disables the adapter; an auth failure is a business state, not an isolation event.
      // The state is set and the fault recorded before anything else can fail: an invalid clock must not
      // lose the fault and leave a broken adapter looking healthy.
      if (kind !== 'AUTH_FAILURE') state = 'FAULTED';
      let faultAt = null;
      try { faultAt = now(); } catch { faultAt = null; }
      FAULT_SEQ += 1;
      faults.push(freeze({ fault_ref: `fault:${definition.connector_kind}:${FAULT_SEQ}`, kind, method, at: faultAt, clock_valid: faultAt !== null, code_readable: codeReadable, detail, recorded_by: 'SDK_ADAPTER', isolated_to: definition.connector_kind }));
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
    installState: () => installState(),
    faults: () => clone(faults),
    faultHistory: () => freeze(clone(faultHistory)),
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
      const at = atFrom(when);
      if (typeof nowAvailable !== 'boolean') throw new SdkError('INVALID_REQUEST', 'available must be a boolean');
      if (nowAvailable !== true) return freeze({ connector_kind: definition.connector_kind, adapter_state: state, enabled: false, reason: 'PRODUCT_UNAVAILABLE', install_state: installState(), at });
      // A fault is cleared explicitly, never by re-declaring availability.
      if (state === 'FAULTED') throw new SdkError('ADAPTER_FAULT', definition.connector_kind + ' is faulted; clearFaults() is the only revival path', { connector_kind: definition.connector_kind, adapter_state: state, enabled: false, revived: false });
      state = 'ENABLED';
      return freeze({ connector_kind: definition.connector_kind, adapter_state: state, enabled: true, install_state: installState(), at });
    },

    disable({ reason = 'USER_DISABLED' } = {}) {
      state = 'DISABLED';
      return freeze({ connector_kind: definition.connector_kind, adapter_state: state, disabled: true, reason });
    },

    clearFaults({ at: when } = {}) {
      if (state !== 'FAULTED') throw new SdkError('INVALID_REQUEST', 'only a faulted adapter may be cleared', { connector_kind: definition.connector_kind, adapter_state: state, cleared: false });
      const at = atFrom(when);
      // The faults leave the active ledger but not the record: an operator act does not erase the audit.
      const cleared = faults.splice(0, faults.length).map(entry => clone(entry));
      faultHistory.push(freeze({ cleared_at: at, cleared_fault_count: cleared.length, faults: freeze(cleared) }));
      state = 'ENABLED';
      return freeze({ connector_kind: definition.connector_kind, adapter_state: state, cleared: true, cleared_fault_count: cleared.length, faults_retained: true, at });
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
          install_state: installState(),
          component_stage_acceptance: false,
          marker: ACCEPTANCE_PENDING,
          acceptance_verified_here: false,
          evidence_declared_by: null,
          fabricated_installation: false,
          fabricated_run: false,
        });
      }
      const install = installState();
      let evidence = null;
      if (isPlainObject(runtime) && typeof runtime.acceptanceEvidence === 'function') {
        // A runtime that breaks is not evidence of a real acceptance.
        try { evidence = runtime.acceptanceEvidence({ connector_kind: definition.connector_kind }); } catch { evidence = null; }
      }
      // A product the adapter itself reports as not installed cannot have produced a real run.
      const genuine = install !== 'NOT_INSTALLED' && isPlainObject(evidence) && evidence.real === true && isText(evidence.submit_ref) && isText(evidence.terminal_ref);
      if (!genuine) {
        return freeze({
          contract_version: SDK_CONTRACT_VERSION,
          connector_kind: definition.connector_kind,
          adapter_state: state,
          install_state: install,
          component_stage_acceptance: false,
          marker: ACCEPTANCE_PENDING,
          acceptance_verified_here: false,
          evidence_declared_by: evidence === null ? null : 'CALLER_SUPPLIED_RUNTIME',
          fabricated_installation: false,
          fabricated_run: false,
        });
      }
      return freeze({
        contract_version: SDK_CONTRACT_VERSION,
        connector_kind: definition.connector_kind,
        adapter_state: state,
        install_state: install,
        component_stage_acceptance: true,
        marker: null,
        evidence_source: 'HOST_RUNTIME',
        // This SDK does not own the host: the evidence is a caller-supplied runtime's declaration, and the
        // payload says so instead of implying the SDK verified an installation or a run.
        acceptance_verified_here: false,
        evidence_declared_by: 'CALLER_SUPPLIED_RUNTIME',
        real_evidence: freeze({ submit_ref: evidence.submit_ref, terminal_ref: evidence.terminal_ref }),
        real_evidence_verified_here: false,
        fabricated_installation: false,
        fabricated_run: false,
      });
    },
  };
  // An unforgeable stamp: only an adapter the SDK wrapped may be registered, so isolation cannot be bypassed.
  Object.defineProperty(api, SDK_ADAPTER_BRAND, { value: true, enumerable: false });
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

  // Reading an adapter must never be able to break a report about the other adapters.
  const safeKind = adapter => {
    try { return String(adapter.connectorKind()); } catch { return 'UNKNOWN_ADAPTER'; }
  };
  return Object.freeze({
    register({ adapter }) {
      if (!isPlainObject(adapter) || typeof adapter.connectorKind !== 'function' || adapter[SDK_ADAPTER_BRAND] !== true) {
        throw new SdkError('INVALID_REQUEST', 'an adapter instance created by createSdkAdapter is required', { sdk_wrapped: false, isolation_wrapped: false });
      }
      const kind = adapter.connectorKind();
      if (adapters.has(kind)) throw new SdkError('DUPLICATE_ADAPTER', `adapter ${kind} is already registered`, { connector_kind: kind });
      adapters.set(kind, adapter);
      return freeze({ registered: kind, count: adapters.size, isolation_wrapped: true, core_edited: false, registry_logic_changed: false });
    },
    adapter: kind => adapters.get(kind) ?? null,
    adapterKinds: () => freeze([...adapters.keys()]),
    /** Optional adapters never block startup: an unavailable one is simply not usable. */
    startupReport() {
      const report = [...adapters.values()].map(adapter => {
        let install = 'UNKNOWN';
        try { install = typeof adapter.installState === 'function' ? adapter.installState() : 'UNKNOWN'; } catch { install = 'UNKNOWN'; }
        let adapterState = 'UNKNOWN';
        try { adapterState = adapter.adapterState(); } catch { adapterState = 'UNKNOWN'; }
        let optional = null;
        try { optional = adapter.optional(); } catch { optional = null; }
        return freeze({
          connector_kind: safeKind(adapter),
          adapter_state: adapterState,
          optional,
          install_state: install,
          // Enabled is not the same as usable: an adapter that reports the product is not installed is not usable.
          usable: adapterState === 'ENABLED' && install !== 'NOT_INSTALLED',
        });
      });
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
        if (typeof adapter.installState === 'function' && adapter.installState() === 'NOT_INSTALLED') return false;
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
      const chosen = candidates.map(adapter => safeKind(adapter)).sort()[0];
      return freeze({ contract_version: SDK_CONTRACT_VERSION, capability, connector_kind: chosen, candidates: freeze(candidates.map(adapter => safeKind(adapter)).sort()), install_checked: true, capability_source: 'ADAPTER_DECLARATION', core_edited: false });
    },
    acceptanceSummary() {
      const reports = [...adapters.values()].map(adapter => {
        // One broken adapter must not take the whole acceptance summary down with a raw error.
        try {
          return adapter.acceptance();
        } catch (error) {
          return freeze({
            contract_version: SDK_CONTRACT_VERSION,
            connector_kind: safeKind(adapter),
            adapter_state: 'UNKNOWN',
            component_stage_acceptance: false,
            marker: ACCEPTANCE_PENDING,
            acceptance_verified_here: false,
            evidence_declared_by: null,
            report_error: String(error?.message ?? error),
          });
        }
      });
      const accepted = reports.filter(report => report.component_stage_acceptance === true).map(report => report.connector_kind);
      // This SDK cannot verify a host runtime: an acceptance resting on a caller's declaration is named so.
      const unverified = reports.filter(report => report.component_stage_acceptance === true && report.acceptance_verified_here !== true).map(report => report.connector_kind);
      return freeze({
        contract_version: SDK_CONTRACT_VERSION,
        reports: freeze(reports),
        accepted: freeze(accepted),
        pending: freeze(reports.filter(report => report.component_stage_acceptance !== true).map(report => report.connector_kind)),
        unverified_acceptances: freeze(unverified),
        acceptance_verified_here: false,
        fabricated_acceptance_claimed: unverified.length,
      });
    },
  });
}
