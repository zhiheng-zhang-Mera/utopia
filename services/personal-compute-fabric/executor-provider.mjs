// PCF-725: the execution-provider CONTRACT and its boundary semantics.
//
// This module states what a provider must DECLARE and what a boundary actually enforces. It deliberately implements no
// process control (that is PCF-710), no residency (712) and no installation (716): the lifecycle answers below name
// which workbook owns the implementation, so this contract cannot become a second scheduler or a provider registry.
//
// Four refusals are built in rather than documented:
//
//   * a manifest may not carry task, identity or credential truth - this is a description of an executor, not a
//     ledger or a secret store;
//   * a free-form command/shell/args field is refused BY NAME, because "provider manifest, not an arbitrary shell
//     string" is the whole point of the contract;
//   * an ENFORCED isolation claim needs separately verified boundary evidence - a string declaration is not
//     enforcement;
//   * a plain Node process is never described as a security sandbox, and a required boundary that is not enforceable
//     on THIS host is a typed refusal instead of a quiet downgrade.
import {requireThat as ok, text, strings, copy, freeze} from './validation.mjs';

export const PROVIDER_CONTRACT_VERSION = 1;
export const ISOLATION_LEVELS = Object.freeze(['ENFORCED', 'COOPERATIVE', 'UNKNOWN']);
export const BOUNDARY_NAMES = Object.freeze(['processTree', 'memory', 'cpu', 'filesystem', 'network', 'credential']);
export const BOUNDARY_STATES = Object.freeze(['ENFORCED', 'COOPERATIVE', 'UNKNOWN']);
export const LIFECYCLE_EVENTS = Object.freeze(['START', 'STOP', 'DISABLE', 'UPGRADE', 'ROLLBACK', 'DEPENDENCY_LOST', 'VERSION_MISMATCH', 'CRASH']);
/** Which workbook implements each part of the contract. The contract is consumed, never re-implemented here. */
export const CONTRACT_OWNERS = Object.freeze({processControl: 'PCF-710', residency: 'PCF-712', installation: 'PCF-716', admission: 'PCF-704', truth: 'CANONICAL_STORE'});
/** Consumer mapping: which field each consumer workbook reads. No consumer is imported by this module. */
export const CONSUMER_MAPPING = Object.freeze({
  'PCF-708': ['providerRef', 'providerVersion', 'workloadKinds', 'capabilities'],
  'PCF-710': ['argvSchema', 'permissionHandles', 'storageNamespace', 'boundaries'],
  'PCF-724': ['workloadKinds', 'workloadSchemas', 'providerRef'],
  'PCF-727': ['providerRef', 'providerVersion', 'lifecycle', 'compatibility'],
  'URA-002': ['providerRef', 'platform', 'capabilities', 'isolation'],
  'URA-003': ['lifecycle', 'boundaries', 'compatibility'],
});
const MANIFEST_KEYS = Object.freeze(['version', 'id', 'providerRef', 'providerVersion', 'platform', 'capabilities', 'workloadKinds', 'workloadSchemas',
  'permissionHandles', 'argvSchema', 'storageNamespace', 'lifecycle', 'isolation', 'boundaries', 'ready', 'boundaryEvidence', 'compatibility', 'sandbox', 'notes']);
const FORBIDDEN_ARGV_KEYS = Object.freeze(['command', 'shell', 'script', 'template', 'argv', 'args', 'exec', 'path', 'binary', 'interpreter']);
const TRUTH_KEYS = /(task|identity|credential|secret|token|password|ledger|ownership)/i;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const NAMESPACE = /^[a-z0-9][a-z0-9/_-]{0,127}$/;
const HANDLING = /^[A-Z][A-Z0-9_]{0,63}$/;
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** The isolation level, from either the legacy `isolation: 'COOPERATIVE'` or the extended object form. */
const isolationOf = manifest => isPlainObject(manifest.isolation) ? manifest.isolation.enforcement : manifest.isolation;
/** Per-boundary states. A manifest that declares nothing gets UNKNOWN everywhere, never an optimistic default. */
function boundariesOf(manifest) {
  const declared = isPlainObject(manifest.isolation) && isPlainObject(manifest.isolation.boundaries) ? manifest.isolation.boundaries : manifest.boundaries ?? {};
  const boundaries = {};
  for (const name of BOUNDARY_NAMES) {
    const state = declared[name] ?? 'UNKNOWN';
    ok(BOUNDARY_STATES.includes(state), 'PROVIDER_BOUNDARY_STATE_UNKNOWN:' + name);
    boundaries[name] = state;
  }
  return boundaries;
}

/**
 * Normalize an execution-provider manifest. Legacy shapes (id/platform string/isolation string) stay valid, because
 * PCF-708 requires that a caller which predates the extension keeps working; everything new is additive.
 */
export function normalizeExecutionProvider(input) {
  const p = copy(input);
  ok(isPlainObject(p), 'PROVIDER_SHAPE');
  ok(p.version === PROVIDER_CONTRACT_VERSION, 'PROVIDER_VERSION');
  for (const key of Object.keys(p)) {
    // Truth duplication is reported before the generic unknown-field refusal, because "this contract is not a ledger"
    // is the more useful diagnosis when a manifest tries to carry a task table or a credential.
    ok(!TRUTH_KEYS.test(key), 'PROVIDER_TRUTH_DUPLICATION:' + key);
    ok(MANIFEST_KEYS.includes(key), 'PROVIDER_UNKNOWN_FIELD:' + key);
  }
  const providerRef = p.providerRef ?? p.id;
  ok(text(providerRef) && IDENTIFIER.test(providerRef), 'PROVIDER_REF_INVALID');
  const providerVersion = p.providerVersion ?? 1;
  ok(Number.isSafeInteger(providerVersion) && providerVersion > 0, 'PROVIDER_VERSION_INVALID');
  ok(text(p.platform) || (isPlainObject(p.platform) && text(p.platform.os) && text(p.platform.arch)), 'PROVIDER_PLATFORM_INVALID');
  ok(strings(p.capabilities) && p.capabilities.length > 0, 'PROVIDER_CAPABILITIES_INVALID');
  ok(strings(p.workloadKinds) && p.workloadKinds.length > 0, 'PROVIDER_WORKLOADS_INVALID');
  ok(p.workloadSchemas === undefined || strings(p.workloadSchemas), 'PROVIDER_SCHEMAS_INVALID');
  ok(p.permissionHandles === undefined || strings(p.permissionHandles), 'PROVIDER_PERMISSION_HANDLE_INVALID');
  if (p.argvSchema !== undefined) {
    ok(isPlainObject(p.argvSchema), 'PROVIDER_ARGV_SCHEMA_INVALID');
    for (const key of Object.keys(p.argvSchema)) ok(!FORBIDDEN_ARGV_KEYS.includes(key), 'PROVIDER_SHELL_NOT_ALLOWED:' + key);
    ok(strings(p.argvSchema.operations) && p.argvSchema.operations.length > 0 && p.argvSchema.operations.every(operation => IDENTIFIER.test(operation)), 'PROVIDER_ARGV_SCHEMA_INVALID');
  }
  if (p.storageNamespace !== undefined) {
    ok(typeof p.storageNamespace === 'string' && NAMESPACE.test(p.storageNamespace) && !p.storageNamespace.includes('..'), 'PROVIDER_NAMESPACE_INVALID');
  }
  if (p.lifecycle !== undefined) {
    ok(isPlainObject(p.lifecycle), 'PROVIDER_LIFECYCLE_INVALID');
    for (const [event, handling] of Object.entries(p.lifecycle)) {
      ok(LIFECYCLE_EVENTS.includes(event), 'PROVIDER_LIFECYCLE_EVENT_UNKNOWN:' + event);
      ok(typeof handling === 'string' && HANDLING.test(handling), 'PROVIDER_LIFECYCLE_HANDLING_INVALID:' + event);
    }
  }
  if (p.compatibility !== undefined) {
    ok(isPlainObject(p.compatibility) && Number.isSafeInteger(p.compatibility.minConsumerVersion) && Number.isSafeInteger(p.compatibility.maxConsumerVersion)
      && p.compatibility.minConsumerVersion <= p.compatibility.maxConsumerVersion, 'PROVIDER_COMPATIBILITY_INVALID');
  }
  const isolation = isolationOf(p);
  ok(ISOLATION_LEVELS.includes(isolation), 'ISOLATION_UNKNOWN');
  ok(typeof p.ready === 'boolean', 'READINESS_UNKNOWN');
  // ENFORCED needs a separately verified boundary report; a string declaration is not enforcement.
  if (isolation === 'ENFORCED') ok(p.boundaryEvidence?.verified === true && text(p.boundaryEvidence.reference), 'BOUNDARY_EVIDENCE_REQUIRED');
  return freeze({...p, providerRef, providerVersion, isolation, boundaries: freeze(boundariesOf(p)), sandbox: p.sandbox ?? (isolation === 'ENFORCED' ? 'PLATFORM_ENFORCED' : 'NOT_A_SANDBOX')});
}

/**
 * Describe what a provider can actually enforce on a host. The three categories are kept apart so a caller cannot
 * read "we hope so" as "the kernel stops it", and a required boundary that is not ENFORCED is refused by name.
 */
export function describeExecutorBoundary(provider, {requireHardIsolation = false, hostFacts = {}} = {}) {
  const p = normalizeExecutionProvider(provider);
  const hardLimits = [], cooperativeLimits = [], unknownLimits = [];
  for (const name of BOUNDARY_NAMES) {
    const state = p.boundaries[name];
    (state === 'ENFORCED' ? hardLimits : state === 'COOPERATIVE' ? cooperativeLimits : unknownLimits).push(name);
  }
  const declaredPlatform = isPlainObject(p.platform) ? p.platform.os : p.platform;
  const hostCompatible = hostFacts.os === undefined ? null : declaredPlatform === hostFacts.os;
  // A boundary verified on another platform is not verified here: on a mismatched host nothing is claimed as hard.
  const effectiveHardLimits = hostCompatible === false ? [] : hardLimits;
  const effectiveUnknownLimits = hostCompatible === false ? [...new Set([...unknownLimits, ...hardLimits])] : unknownLimits;
  if (requireHardIsolation) ok(p.isolation === 'ENFORCED' && effectiveHardLimits.length > 0, 'HARD_ISOLATION_UNAVAILABLE');
  return freeze({providerId: p.providerRef, providerVersion: p.providerVersion, enforcement: p.isolation, evidence: p.boundaryEvidence ?? null,
    boundaries: p.boundaries, hardLimits: freeze(effectiveHardLimits), cooperativeLimits: freeze(cooperativeLimits), unknownLimits: freeze(effectiveUnknownLimits),
    sandbox: p.sandbox, platform: declaredPlatform, hostCompatible,
    note: p.sandbox === 'NOT_A_SANDBOX' ? 'an ordinary process, worker thread or container-less child is NOT a security sandbox' : 'boundary evidence supplied by the manifest'});
}

/** Is this consumer version inside the range the provider declares? An unknown version is refused, not assumed. */
export function assertProviderCompatibility(provider, consumerVersion) {
  const p = normalizeExecutionProvider(provider);
  const range = p.compatibility;
  ok(range === undefined || (Number.isSafeInteger(consumerVersion) && consumerVersion >= range.minConsumerVersion && consumerVersion <= range.maxConsumerVersion), 'PROVIDER_INCOMPATIBLE_CONSUMER');
  return freeze({providerRef: p.providerRef, providerVersion: p.providerVersion, consumerVersion, compatible: true});
}

/**
 * The frozen lifecycle semantics. Each answer says what happens to THIS provider and, explicitly, what must NOT
 * happen to anything else - the workbook requires that disabling one provider neither shuts down the City nor
 * disturbs another provider.
 */
export function lifecycleTransition(provider, event, {crashContained = true} = {}) {
  const p = normalizeExecutionProvider(provider);
  ok(LIFECYCLE_EVENTS.includes(event), 'PROVIDER_LIFECYCLE_EVENT_UNKNOWN');
  if (event === 'START' && p.ready !== true) return freeze({providerRef: p.providerRef, event, accepted: false, action: 'REFUSE_START', reason: 'PROVIDER_NOT_READY', affectsOtherProviders: false, cityShutdown: false, owner: CONTRACT_OWNERS.processControl});
  const table = {
    START: ['START_ATTEMPT', 'PCF-710'],
    STOP: ['STOP_AND_RELEASE_ATTEMPTS', 'PCF-710'],
    DISABLE: ['REFUSE_NEW_ADMISSION_KEEP_EXISTING_ATTEMPTS', 'PCF-704'],
    UPGRADE: ['DRAIN_THEN_SWAP_KEEP_ROLLBACK_TARGET', 'PCF-716'],
    ROLLBACK: ['RESTORE_DECLARED_PREVIOUS_VERSION', 'PCF-716'],
    DEPENDENCY_LOST: ['REFUSE_NEW_ATTEMPTS_KEEP_RUNNING_WORK', 'PCF-710'],
    VERSION_MISMATCH: ['REFUSE_AND_REQUIRE_MIGRATION', 'PCF-716'],
    CRASH: [crashContained ? 'CONTAIN_TO_THIS_ATTEMPT_AND_MARK_OUTCOME_UNKNOWN' : 'ESCALATE_UNCONTAINED_CRASH', 'PCF-712'],
  };
  const [action, owner] = table[event];
  return freeze({providerRef: p.providerRef, event, accepted: true, action, owner, affectsOtherProviders: false, cityShutdown: false,
    // A crash never becomes an automatic retry of side-effecting work: the outcome is unknown until 705 says otherwise.
    requiresOutcomeVerification: event === 'CRASH', autoRestart: false});
}

/** Disable one provider in a registry. The other providers and the City itself are untouched, and the result says so. */
export function disableProvider(providers, providerRef) {
  ok(Array.isArray(providers) && providers.length > 0 && providers.length <= 64, 'PROVIDER_REGISTRY_INVALID');
  const normalized = providers.map(normalizeExecutionProvider);
  ok(normalized.some(entry => entry.providerRef === providerRef), 'PROVIDER_UNKNOWN');
  const next = normalized.map(entry => entry.providerRef === providerRef ? freeze({...entry, ready: false, disabled: true}) : entry);
  return freeze({providers: freeze(next), disabled: providerRef, othersUnchanged: next.filter(entry => entry.providerRef !== providerRef).length === providers.length - 1, cityShutdown: false});
}
