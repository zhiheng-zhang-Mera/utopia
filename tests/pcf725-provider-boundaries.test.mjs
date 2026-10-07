// PCF-725 acceptance: the execution-provider contract and its boundaries.
//
// The workbook names these counterexamples: an unknown version, an unknown permission, an out-of-range namespace, a
// malicious argument, a forged isolation claim, a provider crash and a disable race - plus the requirement that
// disabling one provider neither shuts the City down nor disturbs another provider. The real CPU provider's manifest
// is validated through this contract, which is the direction the dependency is allowed to run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeExecutionProvider, describeExecutorBoundary, assertProviderCompatibility, lifecycleTransition, disableProvider,
  PROVIDER_CONTRACT_VERSION, BOUNDARY_NAMES, LIFECYCLE_EVENTS, CONSUMER_MAPPING, CONTRACT_OWNERS} from '../services/personal-compute-fabric/executor-provider.mjs';
import {CPU_PROVIDER_MANIFEST, CPU_PROVIDER_REF} from '../services/personal-compute-fabric/executor.mjs';

const manifest = (extra = {}) => ({version: 1, providerRef: 'fixture-provider', providerVersion: 2, platform: {os: process.platform, arch: process.arch},
  capabilities: ['cpu.json'], workloadKinds: ['CPU_JSON'], workloadSchemas: ['json'], permissionHandles: ['filesystem:attempt-scratch'],
  argvSchema: {operations: ['SORT']}, storageNamespace: 'fixture/scratch', lifecycle: {START: 'SPAWN_AND_TRACK', CRASH: 'CONTAIN_TO_ATTEMPT'},
  compatibility: {minConsumerVersion: 1, maxConsumerVersion: 3}, isolation: {enforcement: 'COOPERATIVE', boundaries: {processTree: 'COOPERATIVE', filesystem: 'COOPERATIVE'}}, ready: true, ...extra});

test('PCF725-01 an unknown contract version, field or provider version is refused', () => {
  assert.equal(normalizeExecutionProvider(manifest()).providerRef, 'fixture-provider');
  assert.equal(PROVIDER_CONTRACT_VERSION, 1);
  assert.throws(() => normalizeExecutionProvider(manifest({version: 2})), /PROVIDER_VERSION/);
  assert.throws(() => normalizeExecutionProvider(manifest({providerVersion: 0})), /PROVIDER_VERSION_INVALID/);
  assert.throws(() => normalizeExecutionProvider(manifest({providerRef: 'NOT A REF'})), /PROVIDER_REF_INVALID/);
  // An unknown field is refused rather than ignored, so a manifest cannot smuggle a capability past the contract.
  assert.throws(() => normalizeExecutionProvider(manifest({preApprovedEverything: true})), /PROVIDER_UNKNOWN_FIELD/);
  // ...and the contract is not a second ledger: task, identity and credential truth do not belong in it.
  for (const key of ['taskTable', 'credentials', 'secretRef', 'identityProvider']) {
    assert.throws(() => normalizeExecutionProvider(manifest({[key]: 'x'})), /PROVIDER_TRUTH_DUPLICATION/, key + ' must be refused by name');
  }
  assert.throws(() => normalizeExecutionProvider(manifest({isolation: 'MAGIC'})), /ISOLATION_UNKNOWN/);
  assert.throws(() => normalizeExecutionProvider(manifest({ready: 'yes'})), /READINESS_UNKNOWN/);
});

test('PCF725-02 a free-form command, shell or path is refused by name', () => {
  for (const forbidden of ['command', 'shell', 'script', 'template', 'argv', 'args', 'exec', 'path', 'binary', 'interpreter']) {
    assert.throws(() => normalizeExecutionProvider(manifest({argvSchema: {operations: ['SORT'], [forbidden]: 'rm -rf /'}})), /PROVIDER_SHELL_NOT_ALLOWED/, forbidden);
  }
  // Only the operation allowlist is accepted, and an empty one is not an allowlist at all.
  assert.throws(() => normalizeExecutionProvider(manifest({argvSchema: {operations: []}})), /PROVIDER_ARGV_SCHEMA_INVALID/);
  assert.throws(() => normalizeExecutionProvider(manifest({argvSchema: {operations: ['SORT; curl evil.test']}})), /PROVIDER_ARGV_SCHEMA_INVALID/);
  // The real provider declares exactly the two operations its worker implements.
  assert.deepEqual(CPU_PROVIDER_MANIFEST.argvSchema.operations, ['SORT', 'SUM']);
  assert.equal(CPU_PROVIDER_MANIFEST.permissionHandles.includes('filesystem:attempt-scratch'), true);
});

test('PCF725-03 a storage namespace cannot escape its range', () => {
  assert.equal(normalizeExecutionProvider(manifest()).storageNamespace, 'fixture/scratch');
  for (const namespace of ['../etc', 'a/../../b', '/absolute/path', 'C:/Windows', 'with space', 'UPPER..CASE', 'x'.repeat(200)]) {
    assert.throws(() => normalizeExecutionProvider(manifest({storageNamespace: namespace})), /PROVIDER_NAMESPACE_INVALID/, namespace);
  }
  assert.equal(CPU_PROVIDER_MANIFEST.storageNamespace, 'pcf-cpu-scratch');
});

test('PCF725-04 a forged isolation claim is refused and a plain Node process is never called a sandbox', () => {
  // ENFORCED without separately verified boundary evidence is refused, and so is evidence that is not verified.
  assert.throws(() => normalizeExecutionProvider(manifest({isolation: {enforcement: 'ENFORCED'}})), /BOUNDARY_EVIDENCE_REQUIRED/);
  assert.throws(() => normalizeExecutionProvider(manifest({isolation: {enforcement: 'ENFORCED'}, boundaryEvidence: {verified: false, reference: 'self-declared'}})), /BOUNDARY_EVIDENCE_REQUIRED/);
  const verified = normalizeExecutionProvider(manifest({isolation: {enforcement: 'ENFORCED', boundaries: {processTree: 'ENFORCED', memory: 'ENFORCED'}}, boundaryEvidence: {verified: true, reference: 'job-object-2026-10'}}));
  assert.equal(verified.sandbox, 'PLATFORM_ENFORCED');
  // The real CPU provider is an ordinary child process, and the contract says exactly that.
  const boundary = describeExecutorBoundary(CPU_PROVIDER_MANIFEST);
  assert.equal(boundary.enforcement, 'COOPERATIVE');
  assert.equal(boundary.sandbox, 'NOT_A_SANDBOX');
  assert.match(boundary.note, /NOT a security sandbox/);
  assert.deepEqual(boundary.hardLimits, [], 'nothing about this provider is hard-enforced');
  assert.ok(boundary.cooperativeLimits.includes('processTree'));
  assert.ok(boundary.unknownLimits.includes('cpu'));
  assert.ok(boundary.unknownLimits.includes('network'));
  // Each of the six named boundaries is classified, so nothing is silently absent.
  assert.deepEqual(Object.keys(boundary.boundaries), [...BOUNDARY_NAMES]);
  // A required hard boundary that this provider cannot enforce is a refusal, not a downgrade.
  assert.throws(() => describeExecutorBoundary(CPU_PROVIDER_MANIFEST, {requireHardIsolation: true}), /HARD_ISOLATION_UNAVAILABLE/);
  // A boundary verified on another platform is not claimed as hard here.
  const elsewhere = describeExecutorBoundary(verified, {hostFacts: {os: 'plan9'}});
  assert.equal(elsewhere.hostCompatible, false);
  assert.deepEqual(elsewhere.hardLimits, []);
  assert.ok(elsewhere.unknownLimits.includes('processTree'));
});

test('PCF725-05 the lifecycle is frozen, names its owner workbook, and a crash is not an automatic retry', () => {
  const provider = normalizeExecutionProvider(manifest());
  for (const event of LIFECYCLE_EVENTS) {
    const transition = lifecycleTransition(provider, event);
    assert.equal(transition.event, event);
    assert.equal(transition.accepted, true);
    assert.equal(transition.affectsOtherProviders, false, event + ' must not disturb another provider');
    assert.equal(transition.cityShutdown, false, event + ' must not shut the City down');
    assert.ok(CONTRACT_OWNERS.processControl === 'PCF-710' && transition.owner.startsWith('PCF-'), 'the implementation owner is named');
    assert.ok(Object.values(CONTRACT_OWNERS).includes(transition.owner));
  }
  // A crash contains itself to the attempt, marks the outcome unknown, and NEVER auto-restarts side-effecting work.
  const crash = lifecycleTransition(provider, 'CRASH');
  assert.equal(crash.action, 'CONTAIN_TO_THIS_ATTEMPT_AND_MARK_OUTCOME_UNKNOWN');
  assert.equal(crash.requiresOutcomeVerification, true);
  assert.equal(crash.autoRestart, false);
  assert.equal(lifecycleTransition(provider, 'CRASH', {crashContained: false}).action, 'ESCALATE_UNCONTAINED_CRASH');
  // A version mismatch requires a migration instead of a silent downgrade.
  assert.equal(lifecycleTransition(provider, 'VERSION_MISMATCH').action, 'REFUSE_AND_REQUIRE_MIGRATION');
  // A provider that is not ready cannot start, and says so.
  assert.equal(lifecycleTransition(normalizeExecutionProvider(manifest({ready: false})), 'START').accepted, false);
  assert.throws(() => lifecycleTransition(provider, 'REBOOT'), /PROVIDER_LIFECYCLE_EVENT_UNKNOWN/);
  assert.throws(() => normalizeExecutionProvider(manifest({lifecycle: {REBOOT: 'SURE'}})), /PROVIDER_LIFECYCLE_EVENT_UNKNOWN/);
});

test('PCF725-06 disabling one provider leaves the others and the City alone', () => {
  const first = normalizeExecutionProvider(manifest());
  const second = normalizeExecutionProvider(manifest({providerRef: 'other-provider'}));
  const outcome = disableProvider([first, second], 'fixture-provider');
  assert.equal(outcome.disabled, 'fixture-provider');
  assert.equal(outcome.cityShutdown, false);
  assert.equal(outcome.othersUnchanged, true);
  assert.equal(outcome.providers.find(entry => entry.providerRef === 'fixture-provider').disabled, true);
  const untouched = outcome.providers.find(entry => entry.providerRef === 'other-provider');
  assert.equal(untouched.disabled, undefined);
  assert.equal(untouched.ready, true);
  assert.throws(() => disableProvider([first], 'ghost'), /PROVIDER_UNKNOWN/);
  assert.throws(() => disableProvider([], 'ghost'), /PROVIDER_REGISTRY_INVALID/);
});

test('PCF725-07 the schema version and the consumer mapping are explicit, and no consumer is imported', () => {
  for (const consumer of ['PCF-708', 'PCF-710', 'PCF-724', 'PCF-727', 'URA-002', 'URA-003']) {
    assert.ok(Array.isArray(CONSUMER_MAPPING[consumer]) && CONSUMER_MAPPING[consumer].length > 0, consumer + ' must be mapped');
    for (const field of CONSUMER_MAPPING[consumer]) assert.ok(Object.hasOwn(normalizeExecutionProvider(manifest()), field) || field === 'boundaries', field + ' is not a manifest field');
  }
  // The contract declares the range it serves; a consumer outside it is refused rather than guessed at.
  const provider = normalizeExecutionProvider(manifest({compatibility: {minConsumerVersion: 2, maxConsumerVersion: 4}}));
  assert.equal(assertProviderCompatibility(provider, 3).compatible, true);
  assert.throws(() => assertProviderCompatibility(provider, 1), /PROVIDER_INCOMPATIBLE_CONSUMER/);
  assert.throws(() => assertProviderCompatibility(provider, 5), /PROVIDER_INCOMPATIBLE_CONSUMER/);
  assert.throws(() => assertProviderCompatibility(provider, undefined), /PROVIDER_INCOMPATIBLE_CONSUMER/);
  assert.throws(() => normalizeExecutionProvider(manifest({compatibility: {minConsumerVersion: 4, maxConsumerVersion: 2}})), /PROVIDER_COMPATIBILITY_INVALID/);
  // The real CPU provider is version 1 of the contract and serves consumer version 1 only.
  assert.equal(assertProviderCompatibility(CPU_PROVIDER_MANIFEST, 1).providerRef, CPU_PROVIDER_REF);
  assert.throws(() => assertProviderCompatibility(CPU_PROVIDER_MANIFEST, 2), /PROVIDER_INCOMPATIBLE_CONSUMER/);
});
