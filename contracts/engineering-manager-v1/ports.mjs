// Versioned Engineering Manager port contracts (EM-001).
//
// Ports are the replacement-safety boundary: callers depend on these method
// sets, never on a provider, a transport or a concrete connector. An unknown
// port name is rejected rather than guessed, and a subject that does not
// implement the full method set is refused before it can be registered.
import { EngineeringContractError } from './ownership.mjs';

export const PORT_CONTRACT_VERSION = 1;

export const PORT_CONTRACTS = Object.freeze({
 // Foreman-facing facade. Engineering Manager owns Engineering execution only;
 // canonical task truth is read/reported through CanonicalTaskTruthPort.
 EngineeringManagerPort: Object.freeze(['submit', 'status', 'subscribe', 'pause', 'resume', 'cancel', 'respond', 'result', 'listConnectorInstances']),
 // Stable provider-neutral connector surface (ConnectorHub member).
 ConnectorPort: Object.freeze(['probe', 'describe', 'authStatus', 'authenticate', 'start', 'attach', 'stop', 'capabilities', 'submit', 'subscribe', 'pause', 'resume', 'cancel', 'respond', 'result', 'health', 'shutdown']),
 ConnectorRegistryPort: Object.freeze(['probeAll', 'list', 'get', 'capabilities', 'authStatus', 'health']),
 // Remote Fabric performs node trust/addressing/transport; these methods adapt
 // to that public API and are not an independent transport.
 EngineeringRemoteExecutionPort: Object.freeze(['listEligibleRemoteHosts', 'propose', 'dispatchApproved', 'subscribe', 'control', 'respond', 'collectArtifacts']),
 // Owned by Shared Task/Action Core; listed here so Engineering Manager never
 // invents a competing task database.
 CanonicalTaskTruthPort: Object.freeze(['readTaskRef', 'reportExecutionState', 'reportResult', 'requestAttention'])
});

export const PORT_NAMES = Object.freeze(Object.keys(PORT_CONTRACTS));

export function describePort(portName) {
 if (!Object.hasOwn(PORT_CONTRACTS, portName)) throw new EngineeringContractError('UNKNOWN_PORT_CONTRACT', String(portName));
 return Object.freeze({
  name: portName,
  version: PORT_CONTRACT_VERSION,
  methods: PORT_CONTRACTS[portName],
  replacementSafe: true,
  transportAgnostic: true,
  providerAgnostic: true
 });
}

// Conformance probe: required methods must exist as functions. Extra methods are
// reported (as extension surface) but do not fail the port.
export function probePortConformance(portName, subject) {
 const contract = describePort(portName);
 if (subject === null || (typeof subject !== 'object' && typeof subject !== 'function')) {
  return { ok: false, port: portName, version: PORT_CONTRACT_VERSION, missing: [...contract.methods], nonFunctions: [], extensions: [], errors: [`${portName} subject must be an object`] };
 }
 const missing = [];
 const nonFunctions = [];
 for (const method of contract.methods) {
  if (!(method in subject)) missing.push(method);
  else if (typeof subject[method] !== 'function') nonFunctions.push(method);
 }
 const extensions = Object.keys(subject).filter(key => typeof subject[key] === 'function' && !contract.methods.includes(key)).sort();
 const errors = [];
 if (missing.length) errors.push(`missing methods: ${missing.join(', ')}`);
 if (nonFunctions.length) errors.push(`non-function members: ${nonFunctions.join(', ')}`);
 return { ok: errors.length === 0, port: portName, version: PORT_CONTRACT_VERSION, missing, nonFunctions, extensions, errors };
}

export function assertPortConformance(portName, subject) {
 const result = probePortConformance(portName, subject);
 if (!result.ok) throw new EngineeringContractError('PORT_CONFORMANCE_FAILED', `${portName}: ${result.errors.join('; ')}`);
 return subject;
}

// Registering an instance requires both connector conformance and a validated
// instance envelope, so a malformed connector cannot silently join the hub.
export function registerConnectorInstance(registry, { instanceRef, connector, descriptor, authStatus, health }) {
 assertPortConformance('ConnectorPort', connector);
 if (typeof registry?.add !== 'function') throw new EngineeringContractError('INVALID_CONNECTOR_REGISTRY', 'registry.add is required');
 return registry.add({ instanceRef, connector, descriptor, authStatus, health });
}

// Deterministic ConnectorPort test double. Sibling EM tasks use this instead of
// waiting for a real provider; it never fakes success silently - every outcome
// comes from the script it was constructed with.
export function createDeterministicConnectorDouble({ connectorKind = 'generic-process', providerRef = null, capabilities = [], script = [], authStatus = 'AUTHENTICATED', health = 'HEALTHY' } = {}) {
 const jobs = new Map();
 const events = [];
 let cursor = 0;
 const step = () => (cursor < script.length ? script[cursor++] : { state: 'RUNNING', progress: null });
 const record = (type, payload) => { events.push({ type, at: '1970-01-01T00:00:00.000Z', payload }); return events.at(-1); };
 return {
  probe: async () => ({ ok: health !== 'UNAVAILABLE', health }),
  describe: async () => ({ connector_kind: connectorKind, provider_ref: providerRef, capabilities: [...capabilities] }),
  authStatus: async () => ({ status: authStatus }),
  authenticate: async () => ({ status: 'AUTHENTICATED' }),
  start: async () => ({ started: true, connectorKind }),
  attach: async jobRef => (jobs.has(jobRef) ? { attached: true, jobRef } : { attached: false, jobRef }),
  stop: async () => ({ stopped: true }),
  capabilities: async () => [...capabilities],
  submit: async job => { jobs.set(job.job_ref, { job, state: 'SUBMITTED', steps: 0 }); record('JOB_SUBMITTED', { job_ref: job.job_ref }); return { job_ref: job.job_ref, accepted: true }; },
  subscribe: async jobRef => { const entry = jobs.get(jobRef); if (!entry) throw new EngineeringContractError('UNKNOWN_JOB_REF', String(jobRef)); const outcome = step(); entry.steps += 1; entry.state = outcome.state ?? entry.state; record('JOB_STATE_CHANGED', { job_ref: jobRef, state: entry.state }); return { ...outcome, state: entry.state }; },
  pause: async jobRef => { const entry = jobs.get(jobRef); if (!entry) throw new EngineeringContractError('UNKNOWN_JOB_REF', String(jobRef)); entry.state = 'PAUSED'; record('JOB_STATE_CHANGED', { job_ref: jobRef, state: 'PAUSED' }); return { state: 'PAUSED' }; },
  resume: async jobRef => { const entry = jobs.get(jobRef); if (!entry) throw new EngineeringContractError('UNKNOWN_JOB_REF', String(jobRef)); entry.state = 'RUNNING'; record('JOB_STATE_CHANGED', { job_ref: jobRef, state: 'RUNNING' }); return { state: 'RUNNING' }; },
  cancel: async jobRef => { const entry = jobs.get(jobRef); if (!entry) throw new EngineeringContractError('UNKNOWN_JOB_REF', String(jobRef)); entry.state = 'CANCELLED'; record('JOB_STATE_CHANGED', { job_ref: jobRef, state: 'CANCELLED' }); return { state: 'CANCELLED' }; },
  respond: async (attentionId, response) => { record('ATTENTION_ACKNOWLEDGED', { attention_id: attentionId, response }); return { attention_id: attentionId, accepted: true }; },
  result: async jobRef => { const entry = jobs.get(jobRef); if (!entry) throw new EngineeringContractError('UNKNOWN_JOB_REF', String(jobRef)); return { job_ref: jobRef, state: entry.state, steps: entry.steps }; },
  health: async () => ({ health }),
  shutdown: async () => ({ shutdown: true }),
  // introspection for tests/diagnostics only
  __jobs: jobs,
  __events: events
 };
}
