// DeepSeek Harness + Codex reference connectors (EM-011).
//
// Two products, one generic contract. Every product-specific detail — how a version string is parsed, how a
// process is started, how an unsupported operation is detected — lives in an injected `runtime`/`parsing`
// adapter *below* the ConnectorPort, so the registry and the core never branch on a provider name. The point
// of the task is precisely that a third connector would need no core change; the suite proves it with a
// synthetic third connector.
//
// Backend run/session identifiers are kept as **provenance** while the canonical Engineering job id stays
// single and stable, unsupported provider operations become typed UNSUPPORTED_CAPABILITY / ATTENTION /
// REFUSED states rather than silence or success, and an uninstalled or unauthenticated product is reported
// honestly instead of being assumed ready.
//
// Real-provider acceptance: a component run may only *claim* acceptance when a real host runtime produced
// genuine submit → progress → terminal evidence. Otherwise the report carries
// `REAL_PROVIDER_ACCEPTANCE_DEFERRED_TO_PROGRAMME_INTEGRATION`, and an emulated smoke is never labelled as
// provider acceptance.
//
// Pure module: the process/session runtime and the clock are injected; no ambient state, no vendor code.
export const REFERENCE_CONNECTOR_CONTRACT_VERSION = 1;

export const CONNECTOR_KINDS = Object.freeze(['DEEPSEEK_HARNESS', 'CODEX']);
export const INSTALL_STATES = Object.freeze(['INSTALLED', 'NOT_INSTALLED', 'UNKNOWN']);
export const AUTH_STATES = Object.freeze(['READY', 'MISSING', 'EXPIRED', 'NEEDS_USER', 'UNAVAILABLE', 'UNKNOWN']);
export const READINESS = Object.freeze(['READY', 'NOT_READY', 'UNKNOWN']);
export const HEALTH_STATES = Object.freeze(['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN']);
export const SESSION_STATES = Object.freeze(['ATTACHED', 'STARTED', 'CLOSED']);
export const JOB_STATES = Object.freeze(['ACCEPTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED', 'UNKNOWN']);
export const CONTROL_OPS = Object.freeze(['CANCEL', 'PAUSE', 'RESUME']);
export const CANONICAL_CAPABILITIES = Object.freeze([
  'code.generate', 'code.review', 'tests.run', 'repository.inspect', 'shell.execute',
]);

/** The port every connector implements; no method may expose a product-specific shape. */
export const CONNECTOR_PORT = Object.freeze({
  interface: 'ConnectorPort',
  version: 1,
  methods: Object.freeze(['probe', 'version', 'auth', 'readiness', 'capabilities', 'startOrAttach', 'submit', 'events', 'control', 'result', 'health']),
  core_branches_on_provider_name: false,
  product_parsing_lives_below_adapter: true,
});

export const CONNECTOR_CODES = Object.freeze([
  'INVALID_REQUEST', 'INVALID_CLOCK', 'INVALID_RUNTIME', 'UNKNOWN_KIND', 'UNKNOWN_SESSION', 'UNKNOWN_JOB',
  'NOT_INSTALLED', 'AUTH_REQUIRED', 'USER_ACTION_REQUIRED', 'NOT_READY', 'UNSUPPORTED_CAPABILITY',
  'UNSUPPORTED_OPERATION', 'REFUSED', 'DUPLICATE_SUBMIT', 'OUTCOME_UNKNOWN', 'PROVENANCE_REQUIRED',
  'ACCEPTANCE_NOT_PROVEN', 'EMULATED_SMOKE_IS_NOT_ACCEPTANCE',
]);

const CONFLICT_CODES = new Set(['NOT_INSTALLED', 'AUTH_REQUIRED', 'USER_ACTION_REQUIRED', 'NOT_READY', 'UNSUPPORTED_CAPABILITY', 'UNSUPPORTED_OPERATION', 'REFUSED', 'DUPLICATE_SUBMIT', 'OUTCOME_UNKNOWN']);

export class ConnectorError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ConnectorError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_SESSION' || code === 'UNKNOWN_JOB' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
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

export const ACCEPTANCE_DEFERRED = 'REAL_PROVIDER_ACCEPTANCE_DEFERRED_TO_PROGRAMME_INTEGRATION';

/**
 * The two reference descriptors. Everything product-flavoured is data (kind, capabilities, control support,
 * parsing hooks) rather than a branch in the core.
 */
export const REFERENCE_CONNECTORS = Object.freeze({
  DEEPSEEK_HARNESS: Object.freeze({
    connector_kind: 'DEEPSEEK_HARNESS',
    display_name: 'DeepSeek Harness',
    capabilities: Object.freeze(['code.generate', 'code.review', 'repository.inspect', 'shell.execute']),
    supported_controls: Object.freeze(['CANCEL']),
    version_pattern: /(\d+\.\d+\.\d+)/,
    session_kind: 'PROCESS_SESSION',
    donor_repo: 'zhiheng-zhang-Mera/DS-Hns',
    donor_is_runtime_requirement: false,
  }),
  CODEX: Object.freeze({
    connector_kind: 'CODEX',
    display_name: 'Codex',
    capabilities: Object.freeze(['code.generate', 'code.review', 'tests.run', 'repository.inspect']),
    supported_controls: Object.freeze(['CANCEL', 'PAUSE', 'RESUME']),
    version_pattern: /v?(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)/i,
    session_kind: 'CLI_SESSION',
    donor_repo: null,
    donor_is_runtime_requirement: false,
  }),
});

export function createReferenceConnector({ kind, runtime, clock = () => new Date().toISOString(), policy = {} } = {}) {
  const descriptor = REFERENCE_CONNECTORS[kind];
  if (!descriptor) throw new ConnectorError('UNKNOWN_KIND', `unknown connector kind ${String(kind)}`);
  if (!isPlainObject(runtime) || typeof runtime.probe !== 'function') throw new ConnectorError('INVALID_RUNTIME', 'a runtime adapter with probe() is required');
  if (typeof clock !== 'function') throw new ConnectorError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  const config = { required_capabilities: [], ...(isPlainObject(policy) ? policy : {}) };
  const sessions = new Map();
  const jobs = new Map();
  const journal = [];
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isIsoInstant(produced)) throw new ConnectorError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
    return produced;
  };

  const note = (event, at, detail = {}) => {
    journal.push(freeze({ event, at, connector_kind: descriptor.connector_kind, ...detail }));
    return journal.length - 1;
  };

  const probeHost = () => {
    const raw = runtime.probe({ connector_kind: descriptor.connector_kind });
    const installed = raw?.installed === true ? 'INSTALLED' : raw?.installed === false ? 'NOT_INSTALLED' : 'UNKNOWN';
    const version = installed === 'INSTALLED' && isText(raw?.version_output)
      ? (raw.version_output.match(descriptor.version_pattern)?.[1] ?? 'UNKNOWN')
      : 'UNKNOWN';
    return freeze({
      install_state: installed,
      installed: installed === 'INSTALLED',
      version,
      version_known: version !== 'UNKNOWN',
      host_path_ref: isText(raw?.host_path_ref) ? raw.host_path_ref : null,
      probe_source: 'HOST_PROBE',
      emulated: false,
    });
  };

  const requireInstalled = probe => {
    if (probe.install_state === 'NOT_INSTALLED') {
      throw new ConnectorError('NOT_INSTALLED', `${descriptor.display_name} is not installed on this host`, { connector_kind: descriptor.connector_kind, install_state: probe.install_state, auto_install_attempted: false });
    }
    if (probe.install_state === 'UNKNOWN') {
      throw new ConnectorError('NOT_READY', `${descriptor.display_name} installation state is unknown`, { connector_kind: descriptor.connector_kind, install_state: probe.install_state });
    }
    return probe;
  };

  const api = {
    descriptor: () => freeze(clone({ ...descriptor, version_pattern: undefined })),
    connectorKind: () => descriptor.connector_kind,
    port: () => CONNECTOR_PORT,

    probe() {
      const at = now();
      const probe = probeHost();
      note('PROBED', at, { install_state: probe.install_state });
      return probe;
    },

    version() {
      const probe = probeHost();
      return freeze({ connector_kind: descriptor.connector_kind, version: probe.version, version_known: probe.version_known, invented: false });
    },

    auth() {
      const probe = probeHost();
      if (probe.install_state !== 'INSTALLED') {
        return freeze({ connector_kind: descriptor.connector_kind, state: probe.install_state === 'NOT_INSTALLED' ? 'UNAVAILABLE' : 'UNKNOWN', ready: false, install_state: probe.install_state });
      }
      const raw = typeof runtime.auth === 'function' ? runtime.auth({ connector_kind: descriptor.connector_kind }) : { state: 'UNKNOWN' };
      const state = AUTH_STATES.includes(raw?.state) ? raw.state : 'UNKNOWN';
      return freeze({
        connector_kind: descriptor.connector_kind,
        state,
        ready: state === 'READY',
        user_action_required: state === 'NEEDS_USER' || state === 'EXPIRED' || state === 'MISSING',
        auto_retry: false,
        emulated: false,
      });
    },

    readiness() {
      const probe = probeHost();
      if (probe.install_state !== 'INSTALLED') return freeze({ connector_kind: descriptor.connector_kind, state: probe.install_state === 'NOT_INSTALLED' ? 'NOT_READY' : 'UNKNOWN', install_state: probe.install_state, auth_state: 'UNKNOWN', reason: probe.install_state === 'NOT_INSTALLED' ? 'NOT_INSTALLED' : 'INSTALL_STATE_UNKNOWN' });
      const auth = api.auth();
      const state = auth.state === 'READY' ? 'READY' : auth.state === 'UNKNOWN' ? 'UNKNOWN' : 'NOT_READY';
      return freeze({
        connector_kind: descriptor.connector_kind,
        state,
        install_state: probe.install_state,
        version: probe.version,
        auth_state: auth.state,
        reason: state === 'READY' ? 'READY' : `AUTH_${auth.state}`,
      });
    },

    capabilities() {
      return freeze({
        connector_kind: descriptor.connector_kind,
        capabilities: freeze([...descriptor.capabilities]),
        supported_controls: freeze([...descriptor.supported_controls]),
        canonical_names_only: true,
        product_specific_names_exposed: false,
      });
    },

    /** One canonical Engineering job id; the backend run/session id is provenance that may change. */
    startOrAttach({ canonical_job_ref, backend_run_ref = null, at: when } = {}) {
      if (!isText(canonical_job_ref)) throw new ConnectorError('INVALID_REQUEST', 'a canonical_job_ref is required');
      const probe = requireInstalled(probeHost());
      const auth = api.auth();
      if (auth.state !== 'READY') {
        throw new ConnectorError(auth.state === 'NEEDS_USER' ? 'USER_ACTION_REQUIRED' : 'AUTH_REQUIRED', `${descriptor.display_name} authentication is ${auth.state}`, {
          connector_kind: descriptor.connector_kind, auth_state: auth.state, user_action_required: auth.user_action_required, auto_retry: false,
        });
      }
      const at = when ?? now();
      const existing = [...sessions.values()].find(session => session.canonical_job_ref === canonical_job_ref && session.state !== 'CLOSED') ?? null;
      if (existing) {
        note('ATTACHED', at, { canonical_job_ref, session_ref: existing.session_ref });
        return freeze({ ...clone(existing), attached: true, started: false, version: probe.version });
      }
      const raw = typeof runtime.start === 'function' ? runtime.start({ connector_kind: descriptor.connector_kind, canonical_job_ref, backend_run_ref }) : {};
      counter += 1;
      const session = {
        session_ref: `session:${descriptor.connector_kind.toLowerCase()}:${counter}`,
        connector_kind: descriptor.connector_kind,
        canonical_job_ref,
        backend_run_ref: raw?.backend_run_ref ?? backend_run_ref ?? null,
        backend_session_ref: raw?.backend_session_ref ?? null,
        session_kind: descriptor.session_kind,
        state: 'STARTED',
        provenance: freeze({
          backend_run_ref: raw?.backend_run_ref ?? backend_run_ref ?? null,
          backend_session_ref: raw?.backend_session_ref ?? null,
          connector_kind: descriptor.connector_kind,
          is_provenance_only: true,
        }),
        opened_at: at,
        submits: [],
      };
      sessions.set(session.session_ref, session);
      jobs.set(canonical_job_ref, session.session_ref);
      note('STARTED', at, { canonical_job_ref, session_ref: session.session_ref });
      return freeze({ ...clone(session), attached: false, started: true, version: probe.version, canonical_job_id_is_single: true });
    },

    submit({ session_ref = null, canonical_job_ref = null, operation, arguments_ref = null, action_key = null, at: when } = {}) {
      const session = session_ref !== null ? sessions.get(session_ref) ?? null : jobs.has(canonical_job_ref) ? sessions.get(jobs.get(canonical_job_ref)) : null;
      if (!session) throw new ConnectorError('UNKNOWN_SESSION', `no session for ${String(session_ref ?? canonical_job_ref)}`);
      if (session.state === 'CLOSED') throw new ConnectorError('UNKNOWN_SESSION', `session ${session.session_ref} is closed`);
      if (!isText(operation)) throw new ConnectorError('INVALID_REQUEST', 'an operation is required');
      if (!descriptor.capabilities.includes(operation)) {
        note('UNSUPPORTED_CAPABILITY', when ?? now(), { operation });
        throw new ConnectorError('UNSUPPORTED_CAPABILITY', `${descriptor.display_name} does not support ${operation}`, {
          connector_kind: descriptor.connector_kind, operation, supported: freeze([...descriptor.capabilities]), emulated: false, silently_ignored: false,
        });
      }
      const duplicate = action_key !== null ? session.submits.find(entry => entry.action_key === action_key) ?? null : null;
      if (duplicate) {
        return freeze({
          contract_version: REFERENCE_CONNECTOR_CONTRACT_VERSION,
          canonical_job_ref: session.canonical_job_ref,
          session_ref: session.session_ref,
          backend_run_ref: session.backend_run_ref,
          submitted: false,
          duplicate: true,
          repeated: false,
          result_ref: duplicate.result_ref,
          provenance_only_backend_ids: true,
        });
      }
      const at = when ?? now();
      const raw = runtime.submit({ connector_kind: descriptor.connector_kind, session_ref: session.session_ref, operation, arguments_ref, action_key });
      const result_ref = raw?.result_ref ?? `${session.session_ref}:${operation}`;
      session.submits.push({ operation, action_key, result_ref, at });
      note('SUBMITTED', at, { operation, submissions: session.submits.length });
      return freeze({
        contract_version: REFERENCE_CONNECTOR_CONTRACT_VERSION,
        canonical_job_ref: session.canonical_job_ref,
        session_ref: session.session_ref,
        backend_run_ref: session.backend_run_ref,
        operation,
        submitted: true,
        duplicate: false,
        state: 'RUNNING',
        result_ref,
        provenance_only_backend_ids: true,
        connector_kind: descriptor.connector_kind,
        at,
      });
    },

    events({ session_ref, at: when } = {}) {
      const session = sessions.get(session_ref);
      if (!session) throw new ConnectorError('UNKNOWN_SESSION', `no session ${String(session_ref)}`);
      const raw = typeof runtime.events === 'function' ? runtime.events({ connector_kind: descriptor.connector_kind, session_ref }) : [];
      const events = (Array.isArray(raw) ? raw : []).map((event, index) => freeze({
        contract_version: REFERENCE_CONNECTOR_CONTRACT_VERSION,
        canonical_job_ref: session.canonical_job_ref,
        session_ref,
        sequence: Number.isSafeInteger(event.sequence) ? event.sequence : index + 1,
        kind: isText(event.kind) ? event.kind : 'PROGRESS',
        text: isText(event.text) ? event.text : null,
        backend_event_ref: isText(event.backend_event_ref) ? event.backend_event_ref : null,
        is_provenance_only: true,
      }));
      return freeze({ session_ref, canonical_job_ref: session.canonical_job_ref, events: freeze(events), normalized: true, product_shapes_exposed: false, at: when ?? now() });
    },

    control({ session_ref, operation, at: when } = {}) {
      const session = sessions.get(session_ref);
      if (!session) throw new ConnectorError('UNKNOWN_SESSION', `no session ${String(session_ref)}`);
      if (!CONTROL_OPS.includes(operation)) throw new ConnectorError('INVALID_REQUEST', `operation must be one of ${CONTROL_OPS.join(', ')}`);
      if (!descriptor.supported_controls.includes(operation)) {
        note('UNSUPPORTED_OPERATION', when ?? now(), { operation });
        throw new ConnectorError('UNSUPPORTED_OPERATION', `${descriptor.display_name} cannot ${operation}`, {
          connector_kind: descriptor.connector_kind, operation, supported: freeze([...descriptor.supported_controls]), refused: true, silently_ignored: false,
        });
      }
      const at = when ?? now();
      if (typeof runtime.control === 'function') runtime.control({ connector_kind: descriptor.connector_kind, session_ref, operation });
      if (operation === 'CANCEL') session.state = 'CLOSED';
      note('CONTROLLED', at, { operation });
      return freeze({
        contract_version: REFERENCE_CONNECTOR_CONTRACT_VERSION,
        session_ref,
        canonical_job_ref: session.canonical_job_ref,
        operation,
        applied: true,
        state: session.state,
        connector_kind: descriptor.connector_kind,
        at,
      });
    },

    /** An absent or unparseable outcome is UNKNOWN, never success. */
    result({ session_ref, at: when } = {}) {
      const session = sessions.get(session_ref);
      if (!session) throw new ConnectorError('UNKNOWN_SESSION', `no session ${String(session_ref)}`);
      const raw = typeof runtime.result === 'function' ? runtime.result({ connector_kind: descriptor.connector_kind, session_ref }) : null;
      const rawState = isText(raw?.state) ? raw.state.toUpperCase() : null;
      const state = JOB_STATES.includes(rawState) ? rawState : 'UNKNOWN';
      return freeze({
        contract_version: REFERENCE_CONNECTOR_CONTRACT_VERSION,
        session_ref,
        canonical_job_ref: session.canonical_job_ref,
        backend_run_ref: session.backend_run_ref,
        state,
        terminal: ['SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED'].includes(state),
        result_ref: isText(raw?.result_ref) ? raw.result_ref : null,
        outcome_unknown_is_not_success: state === 'UNKNOWN',
        invented_result: false,
        at: when ?? now(),
      });
    },

    health() {
      const probe = probeHost();
      const readiness = api.readiness();
      const auth = api.auth();
      const state = probe.install_state === 'NOT_INSTALLED' ? 'UNHEALTHY' : readiness.state === 'READY' ? 'HEALTHY' : readiness.state === 'UNKNOWN' ? 'UNKNOWN' : 'DEGRADED';
      const attention = state === 'HEALTHY' ? null : freeze({
        contract_version: REFERENCE_CONNECTOR_CONTRACT_VERSION,
        kind: probe.install_state === 'NOT_INSTALLED' ? 'INSTALL_REQUIRED' : 'AUTHENTICATION',
        question: probe.install_state === 'NOT_INSTALLED'
          ? `${descriptor.display_name} is not installed on this host`
          : `${descriptor.display_name} needs attention (${readiness.reason})`,
        connector_kind: descriptor.connector_kind,
        blocking: true,
        auto_retry: false,
      });
      return freeze({
        contract_version: REFERENCE_CONNECTOR_CONTRACT_VERSION,
        connector_kind: descriptor.connector_kind,
        health: state,
        readiness: readiness.state,
        install_state: probe.install_state,
        auth_state: auth.state,
        attention,
        emulated: false,
      });
    },

    sessions: () => clone([...sessions.values()]),
    journal: () => clone(journal),
    /** A connector may only claim acceptance when a real runtime produced genuine evidence. */
    acceptanceReport() {
      const probe = probeHost();
      const realEvidence = typeof runtime.acceptanceEvidence === 'function' ? runtime.acceptanceEvidence({ connector_kind: descriptor.connector_kind }) : null;
      const hasEvidence = isPlainObject(realEvidence) && realEvidence.real === true && isText(realEvidence.submit_ref) && isText(realEvidence.progress_ref) && isText(realEvidence.terminal_ref);
      if (!hasEvidence) {
        return freeze({
          contract_version: REFERENCE_CONNECTOR_CONTRACT_VERSION,
          connector_kind: descriptor.connector_kind,
          component_stage_acceptance: false,
          deferred_marker: ACCEPTANCE_DEFERRED,
          real_submit_evidence: null,
          emulated_smoke_labelled_as_acceptance: false,
          install_state: probe.install_state,
        });
      }
      return freeze({
        contract_version: REFERENCE_CONNECTOR_CONTRACT_VERSION,
        connector_kind: descriptor.connector_kind,
        component_stage_acceptance: true,
        deferred_marker: null,
        evidence_source: 'HOST_RUNTIME',
        real_submit_evidence: freeze({ submit_ref: realEvidence.submit_ref, progress_ref: realEvidence.progress_ref, terminal_ref: realEvidence.terminal_ref, terminal_state: realEvidence.terminal_state ?? 'SUCCEEDED' }),
        emulated_smoke_labelled_as_acceptance: false,
        install_state: probe.install_state,
      });
    },
  };
  return Object.freeze(api);
}

/**
 * The registry is generic: it stores connectors by descriptor and resolves by capability. It has no branch on
 * connector kind, which is what lets a third connector be added without touching the core.
 */
export function createConnectorRegistry({ clock = () => new Date().toISOString() } = {}) {
  if (typeof clock !== 'function') throw new ConnectorError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  const connectors = new Map();
  return Object.freeze({
    register({ connector }) {
      if (!isPlainObject(connector) || typeof connector.connectorKind !== 'function' || typeof connector.capabilities !== 'function') {
        throw new ConnectorError('INVALID_REQUEST', 'a connector must implement the ConnectorPort');
      }
      connectors.set(connector.connectorKind(), connector);
      return freeze({ registered: connector.connectorKind(), count: connectors.size });
    },
    connector: kind => connectors.get(kind) ?? null,
    connectorKinds: () => freeze([...connectors.keys()]),
    /** Capability-based resolution: no provider-name conditionals anywhere in this path. */
    selectForCapability({ capability, ready_only = false } = {}) {
      if (!isText(capability)) throw new ConnectorError('INVALID_REQUEST', 'capability is required');
      const candidates = [...connectors.values()].filter(connector => connector.capabilities().capabilities.includes(capability));
      const eligible = ready_only ? candidates.filter(connector => connector.readiness().state === 'READY') : candidates;
      if (eligible.length === 0) {
        throw new ConnectorError('UNSUPPORTED_CAPABILITY', `no registered connector offers ${capability}`, { capability, candidates: freeze(candidates.map(connector => connector.connectorKind())), provider_name_branching: false });
      }
      const chosen = eligible.map(connector => connector.connectorKind()).sort()[0];
      return freeze({
        contract_version: REFERENCE_CONNECTOR_CONTRACT_VERSION,
        capability,
        connector_kind: chosen,
        candidates: freeze(eligible.map(connector => connector.connectorKind()).sort()),
        provider_name_branching: false,
        capability_based: true,
        core_changed_for_third_connector: false,
      });
    },
    coverage() {
      const at = clock();
      if (!isIsoInstant(at)) throw new ConnectorError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
      const byCapability = {};
      for (const capability of CANONICAL_CAPABILITIES) {
        byCapability[capability] = [...connectors.values()].filter(connector => connector.capabilities().capabilities.includes(capability)).map(connector => connector.connectorKind()).sort();
      }
      return freeze({ contract_version: REFERENCE_CONNECTOR_CONTRACT_VERSION, connectors: freeze([...connectors.keys()]), by_capability: freeze(byCapability), registered_count: connectors.size, at });
    },
    /** Registry-level acceptance summary across connectors. */
    acceptanceSummary() {
      const reports = [...connectors.values()].map(connector => connector.acceptanceReport());
      return freeze({
        contract_version: REFERENCE_CONNECTOR_CONTRACT_VERSION,
        reports: freeze(reports),
        component_stage_accepted: freeze(reports.filter(report => report.component_stage_acceptance).map(report => report.connector_kind)),
        deferred: freeze(reports.filter(report => report.component_stage_acceptance !== true).map(report => report.connector_kind)),
        emulated_acceptance_claimed: 0,
      });
    },
  });
}
