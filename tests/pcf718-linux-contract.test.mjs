// PCF-718 — Linux worker onboarding, CONTRACT half (workbook: PCF-718-linux-worker-onboarding.md).
//
// This file deliberately tests the CONTRACT and the honest-claim discipline, not a Linux runtime: the physical item
// ("run a CPU task on a real Linux runtime, cancel it, restart it and return the result to the originating
// Windows/Android end") has no platform here and is reported as a typed NOT_RUN by the last test. The half that CAN be
// checked on this host is which declarations are accepted, what a missing/offline/incompatible Linux worker does to the
// existing path, and what is refused rather than simulated.
//
//   line 43  an extra owner gate is required; virtual Linux may support development but must be LABELLED, and a VM on
//            the same physical machine is not an independent failure domain;
//   line 45  headless install/registration/readiness/shutdown, least-privilege service, and the platform adaptations
//            (signals, process tree, path case, file permissions, clocks) - a compatible adapter is ADDED, the app is
//            not rewritten for Linux;
//   line 47  a worker advertises the capabilities and isolation level it actually has; Windows-only acceptance work
//            keeps going to real Windows and is not diverted because a Linux node is idle;
//   line 48  STANDARD_DEVICES <-> HYBRID stays reversible, and a missing/offline/version-mismatched Linux worker must
//            not affect the existing two-Windows + Android path;
//   line 49  real Linux execution/cancel/restart/origin-return, and the rule that virtualised performance may never be
//            generalised to a physical workbench;
//   line 51  scoped Node tests plus platform-native integration; unknown GPU/cgroup support stays UNKNOWN/UNSUPPORTED;
//            missing hardware stays parked rather than being simulated into an acceptance.
//
// No product file was changed for these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {normalizeExecutionProvider, describeExecutorBoundary, assertProviderCompatibility, lifecycleTransition, disableProvider}
  from '../services/personal-compute-fabric/executor-provider.mjs';
import {chooseHybridTarget, createExecutionProfileController} from '../services/dev-gateway/execution-profile.mjs';
import {feasibility, planPlacement} from '../services/personal-compute-fabric/placement.mjs';
import {resolveEffectivePolicy} from '../services/personal-compute-fabric/policy.mjs';
import {planDeployment, preflightDeployment, createDeploymentController} from '../services/personal-compute-fabric/deployment.mjs';
import {createRemoteWorkerPort} from '../services/personal-compute-fabric/remote-worker-port.mjs';
import {createFabricService} from '../services/personal-compute-fabric/service.mjs';
import {measureInstrumentationOverhead} from '../services/personal-compute-fabric/research-adapter.mjs';
import {assessOptionalReadiness} from '../services/personal-compute-fabric/optional-readiness.mjs';
import {Store} from '../services/dev-gateway/store.mjs';

const FAR = 4e12;
// The Linux worker as the workbook proposes it: a WBC-compatible adapter that runs a fixed CPU application. It declares
// only what it has - no invented isolation level and no invented boundary evidence.
const linuxWorker = Object.freeze({version: 1, id: 'linux-worker', platform: 'linux', capabilities: ['cpu.json'],
  workloadKinds: ['CPU_JSON'], ready: true, isolation: 'COOPERATIVE'});
const windowsWorker = Object.freeze({version: 1, id: 'alien-win', platform: 'win32', capabilities: ['cpu.json'],
  workloadKinds: ['CPU_JSON'], ready: true, isolation: 'COOPERATIVE'});
const profile = Object.freeze({version: 1, authorized: true, originDeviceId: 'alien', mode: 'TRUSTED_PERSONAL_FABRIC',
  allowedDevices: ['alien', 'linux-1'], dataScopes: ['PUBLIC'], sharingConsent: true, cloudConsent: false, budget: 0, expiresAt: FAR});

test('PCF-718 line 47: a worker advertises the capability and isolation it actually has, and an unverifiable boundary is a typed refusal', () => {
  const declared = normalizeExecutionProvider(linuxWorker);
  assert.equal(declared.providerRef, 'linux-worker');
  assert.equal(declared.platform, 'linux');
  assert.deepEqual(declared.capabilities, ['cpu.json']);
  assert.equal(declared.isolation, 'COOPERATIVE');
  // An ordinary child process is NOT a sandbox, and every boundary it did not declare is UNKNOWN - never assumed hard.
  assert.equal(declared.sandbox, 'NOT_A_SANDBOX');
  assert.deepEqual(declared.boundaries, {processTree: 'UNKNOWN', memory: 'UNKNOWN', cpu: 'UNKNOWN', filesystem: 'UNKNOWN', network: 'UNKNOWN', credential: 'UNKNOWN'});
  // Counterexample: claiming ENFORCED isolation without separately verified boundary evidence is refused, not downgraded.
  assert.throws(() => normalizeExecutionProvider({...linuxWorker, isolation: 'ENFORCED'}), {code: 'BOUNDARY_EVIDENCE_REQUIRED'});
  const evidenced = normalizeExecutionProvider({...linuxWorker, isolation: 'ENFORCED',
    boundaryEvidence: {verified: true, reference: 'report:linux-cgroup-1'}});
  assert.equal(evidenced.sandbox, 'PLATFORM_ENFORCED');
  // Counterexamples: an unknown isolation word, no advertised capability and no platform are typed refusals.
  assert.throws(() => normalizeExecutionProvider({...linuxWorker, isolation: 'MAYBE'}), {code: 'ISOLATION_UNKNOWN'});
  assert.throws(() => normalizeExecutionProvider({...linuxWorker, capabilities: []}), {code: 'PROVIDER_CAPABILITIES_INVALID'});
  assert.throws(() => normalizeExecutionProvider({...linuxWorker, platform: ''}), {code: 'PROVIDER_PLATFORM_INVALID'});

  // A boundary verified on another platform is not verified HERE: on this Windows host the Linux worker's hard limits
  // become unknown and a caller that requires hard isolation is refused by name.
  const elsewhere = describeExecutorBoundary({...linuxWorker, boundaries: {processTree: 'ENFORCED', credential: 'ENFORCED'}}, {hostFacts: {os: 'win32'}});
  assert.equal(elsewhere.hostCompatible, false);
  assert.deepEqual(elsewhere.hardLimits, []);
  // Everything the manifest declared hard becomes unknown here, together with the boundaries it never declared.
  assert.deepEqual([...elsewhere.unknownLimits].sort(), ['cpu', 'credential', 'filesystem', 'memory', 'network', 'processTree']);
  const onLinux = describeExecutorBoundary({...linuxWorker, boundaries: {processTree: 'ENFORCED'}}, {hostFacts: {os: 'linux'}});
  assert.equal(onLinux.hostCompatible, true);
  assert.deepEqual(onLinux.hardLimits, ['processTree']);
  // Unknown GPU/cgroup permission is UNKNOWN and cannot be promoted to a hard guarantee.
  assert.throws(() => describeExecutorBoundary({...linuxWorker, boundaries: {cpu: 'UNKNOWN', memory: 'UNKNOWN'}}, {requireHardIsolation: true, hostFacts: {os: 'linux'}}),
    {code: 'HARD_ISOLATION_UNAVAILABLE'});
});

test('PCF-718 line 47: Windows-only validation work keeps going to real Windows and is never diverted to an idle Linux node', () => {
  const idleLinux = {nodeId: 'linux-1', platform: 'linux', capabilities: ['cpu.json'], ready: true, trusted: true, freeSlots: 9};
  const busyWindows = {nodeId: 'win-1', platform: 'win32', capabilities: ['cpu.json'], ready: true, trusted: true, freeSlots: 0};
  const validationWindows = {nodeId: 'win-val', platform: 'win32', capabilities: ['cpu.json'], ready: true, trusted: true, freeSlots: 1,
    roles: ['VALIDATION_NODE'], validationCapable: true};
  const windowsOnly = {requiredPlatform: 'win32', requiredCapabilities: ['cpu.json']};

  // The idle Linux node has nine free slots and the Windows node has none; load must not decide this.
  const chosen = chooseHybridTarget({task: windowsOnly, candidates: [idleLinux, busyWindows], poolAvailable: true});
  assert.deepEqual({chosen: chosen.chosen, rule: chosen.rule}, {chosen: 'win-1', rule: 'HARD_REQUIREMENT'});
  // A platform-validation workload goes to a matching REAL validation node.
  assert.deepEqual(chooseHybridTarget({task: windowsOnly, candidates: [idleLinux, validationWindows, busyWindows], poolAvailable: true}).rule, 'VALIDATION_NODE');
  // With no capable Windows node the answer is "nothing", not the idle Linux node.
  assert.deepEqual(chooseHybridTarget({task: windowsOnly, candidates: [idleLinux], poolAvailable: true}),
    {chosen: null, rule: 'NO_CAPABLE_NODE', reason: 'no trusted, ready node satisfies the hard requirements'});
  assert.equal(chooseHybridTarget({task: windowsOnly, candidates: [idleLinux], poolAvailable: false}).rule, 'POOL_UNAVAILABLE');
  // A task that declares no requirement keeps the compatible default and is not rerouted by the new model at all.
  assert.equal(chooseHybridTarget({task: {}, candidates: [idleLinux, busyWindows], poolAvailable: true}).rule, 'LEGACY_DEFAULT');

  // The same rule at the placement layer: a Windows-only workload is not even feasible on a Linux candidate.
  const policy = resolveEffectivePolicy({mode: 'TRUSTED_PERSONAL_FABRIC'}, profile, 1000);
  const linuxCandidate = {deviceId: 'linux-1', bootId: 'b', trusted: true, authorized: true, executorReady: true, sharing: true, platform: 'linux',
    provider: {id: 'cpu', ready: true, capabilities: ['cpu.json'], workloadKinds: ['CPU_JSON'], isolation: 'COOPERATIVE'},
    observationVersion: 1, observedAt: 900, validUntil: FAR, free: {cpu: 8, memory: 100}};
  const windowsOnlyWorkload = {taskId: 'T', actionId: 'A', originDeviceId: 'alien', dataScope: 'PUBLIC', platform: 'win32',
    capabilities: ['cpu.json'], kind: 'CPU_JSON', resources: {cpu: 1}};
  assert.equal(feasibility(windowsOnlyWorkload, linuxCandidate, policy, 1000), 'PLATFORM');
  const refused = planPlacement(windowsOnlyWorkload, [linuxCandidate], policy, 1000);
  assert.equal(refused.state, 'REFUSED');
  assert.deepEqual(refused.decisions, [{deviceId: 'linux-1', code: 'PLATFORM', remedy: 'NONE'}]);
});

test('PCF-718 line 48: STANDARD_DEVICES <-> HYBRID stays reversible, and a missing, offline or mismatched Linux worker leaves the Windows/Android path working', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pcf718-profile-'));
  try {
    let linuxReadiness = 'NOT_READY';
    const controller = createExecutionProfileController({dir, readinessOf: name => name === 'HYBRID' ? {state: linuxReadiness} : 'NOT_READY', clock: () => 1000});
    assert.equal(controller.profile(), 'STANDARD_DEVICES');
    // Linux absent/offline: the switch is refused with a typed code, the working profile is KEPT, and nothing is persisted.
    const refusal = (() => { try { controller.change('HYBRID'); return null; } catch (error) { return error; } })();
    assert.equal(refusal.code, 'PROFILE_NOT_READY');
    assert.equal(refusal.detail.kept, 'STANDARD_DEVICES');
    assert.equal(controller.profile(), 'STANDARD_DEVICES');
    await assert.rejects(() => readFile(join(dir, 'execution-profile.json'), 'utf8'));
    // An unknown profile name is a different refusal, with what IS supported.
    assert.throws(() => controller.change('HYBRID_V2'), error => error.code === 'PROFILE_UNKNOWN' && error.detail.supported.includes('STANDARD_DEVICES'));
    // Linux ready: the switch works...
    linuxReadiness = 'READY';
    assert.deepEqual({changed: controller.change('HYBRID').changed, to: controller.profile()}, {changed: true, to: 'HYBRID'});
    // ...and the rollback must not depend on the Linux pool still being healthy.
    linuxReadiness = 'NOT_READY';
    assert.deepEqual({from: controller.rollback().from, to: controller.profile()}, {from: 'HYBRID', to: 'STANDARD_DEVICES'});
    // Persisted HYBRID with Linux offline after a restart: the City starts on the rollback profile and records why.
    await writeFile(join(dir, 'execution-profile.json'), JSON.stringify({profile: 'HYBRID', changedAt: 7}), 'utf8');
    const degraded = createExecutionProfileController({dir, readinessOf: () => 'NOT_READY'});
    assert.equal(degraded.profile(), 'STANDARD_DEVICES');
    assert.equal(degraded.state().selection, 'DEGRADED_TO_DEFAULT');
    assert.equal(degraded.state().recovery.code, 'PROFILE_NOT_READY');
    // A corrupt persisted selection is recovered to the working profile as well.
    await writeFile(join(dir, 'execution-profile.json'), '{not json', 'utf8');
    const recovered = createExecutionProfileController({dir, readinessOf: () => 'NOT_READY'});
    assert.equal(recovered.profile(), 'STANDARD_DEVICES');
    assert.equal(recovered.state().selection, 'RECOVERED_TO_DEFAULT');
    assert.equal(recovered.state().recovery.code, 'PROFILE_RECOVERY_REQUIRED');
  } finally { await rm(dir, {recursive: true, force: true}); }

  // No Linux worker exists at all: the port invents no endpoint and refuses to dispatch.
  const dormant = createRemoteWorkerPort({enabled: false});
  assert.deepEqual(dormant.endpoints(), []);
  await assert.rejects(() => dormant.dispatch({}), {code: 'REMOTE_NOT_ENABLED'});

  // A version mismatch is refused by name and never migrates itself or touches the other provider.
  assert.throws(() => assertProviderCompatibility({...linuxWorker, compatibility: {minConsumerVersion: 2, maxConsumerVersion: 3}}, 1), {code: 'PROVIDER_INCOMPATIBLE_CONSUMER'});
  assert.deepEqual(assertProviderCompatibility({...linuxWorker, compatibility: {minConsumerVersion: 1, maxConsumerVersion: 3}}, 1),
    {providerRef: 'linux-worker', providerVersion: 1, consumerVersion: 1, compatible: true});
  assert.deepEqual(lifecycleTransition(linuxWorker, 'VERSION_MISMATCH'),
    {providerRef: 'linux-worker', event: 'VERSION_MISMATCH', accepted: true, action: 'REFUSE_AND_REQUIRE_MIGRATION', owner: 'PCF-716',
      affectsOtherProviders: false, cityShutdown: false, requiresOutcomeVerification: false, autoRestart: false});
  // Linux going away must keep the running work and must not shut the City down.
  assert.equal(lifecycleTransition(linuxWorker, 'DEPENDENCY_LOST').action, 'REFUSE_NEW_ATTEMPTS_KEEP_RUNNING_WORK');
  assert.equal(lifecycleTransition(linuxWorker, 'DEPENDENCY_LOST').cityShutdown, false);
  const disabled = disableProvider([linuxWorker, windowsWorker], 'linux-worker');
  assert.deepEqual({othersUnchanged: disabled.othersUnchanged, cityShutdown: disabled.cityShutdown},
    {othersUnchanged: true, cityShutdown: false});
  assert.deepEqual(disabled.providers.map(entry => [entry.providerRef, entry.ready]), [['linux-worker', false], ['alien-win', true]]);
});

test('PCF-718 line 45/51: the headless lifecycle is an explicit, preflight-gated plan with least privilege, and an unwired runtime step is a typed refusal', async () => {
  const config = {version: '1', schemaVersion: 1, port: 49000, credentialReference: 'existing-enrollment-file', profile: 'STANDARD_DEVICES'};
  const checks = {writable: true, portAvailable: true, freeBytes: 1048576, versionsCompatible: true};
  // No opt-in is the default: nothing installs itself, and a plan is only a plan.
  assert.deepEqual(planDeployment({action: 'INSTALL', optIn: false}), {state: 'REFUSED', reason: 'EXPLICIT_OPT_IN_REQUIRED', automaticInstall: false});
  assert.equal(planDeployment({action: 'INSTALL', optIn: true, currentSchema: 1, targetSchema: 1}).automaticInstall, false);
  assert.equal(planDeployment({action: 'START', optIn: true, currentSchema: 1, targetSchema: 1, ready: false}).reason, 'PREFLIGHT_REQUIRED');
  assert.equal(planDeployment({action: 'CALL_SYSTEMD', optIn: true}).reason, 'ACTION_UNSUPPORTED');
  const proposed = planDeployment({action: 'START', optIn: true, currentSchema: 1, targetSchema: 1, ready: true});
  assert.deepEqual({state: proposed.state, requiresOperatorExecution: proposed.requiresOperatorExecution,
    credentialHandling: proposed.credentialHandling, defaultProfile: proposed.defaultProfile},
    {state: 'PROPOSED', requiresOperatorExecution: true, credentialHandling: 'EXISTING_ENROLLMENT_REFERENCE_ONLY', defaultProfile: 'STANDARD_DEVICES'});

  // Readiness is observed, never assumed: each missing observation is its own typed refusal.
  assert.equal(preflightDeployment({config, checks: {}}).reason, 'PERMISSION_DENIED');
  assert.equal(preflightDeployment({config, checks: {writable: true}}).reason, 'PORT_OCCUPIED');
  assert.equal(preflightDeployment({config, checks: {writable: true, portAvailable: true, freeBytes: 1}}).reason, 'DISK_QUOTA');
  assert.equal(preflightDeployment({config, checks: {...checks, versionsCompatible: false}}).reason, 'MIXED_VERSION');
  assert.equal(preflightDeployment({config: {...config, credentialValue: 'plaintext'}, checks}).reason, 'CREDENTIAL_VALUE_FORBIDDEN');
  const ready = preflightDeployment({config, checks});
  assert.deepEqual({state: ready.state, minimumPrivilege: ready.minimumPrivilege, automaticInstall: ready.automaticInstall}, {state: 'READY', minimumPrivilege: 'CURRENT_USER', automaticInstall: false});

  // The controller installs metadata only: no privileged service, no autostart, the existing launcher stays the authority.
  const controller = createDeploymentController({config, checks, adapter: {}});
  assert.equal((await controller.execute('INSTALL', {optIn: true})).state, 'PROPOSED');
  assert.equal((await controller.execute('INSTALL', {optIn: true, dryRun: false})).state, 'INSTALLED');
  const manifest = controller.manifest();
  assert.deepEqual({serviceInstalled: manifest.serviceInstalled, autostart: manifest.autostart, authority: manifest.authority, profile: manifest.profile},
    {serviceInstalled: false, autostart: false, authority: 'EXISTING_WINDOWS_LAUNCHER', profile: 'STANDARD_DEVICES'});
  // Shutdown/readiness that the Linux runtime would own is NOT fabricated when no adapter is wired.
  const start = await controller.execute('START', {optIn: true, dryRun: false});
  assert.deepEqual({state: start.state, reason: start.reason}, {state: 'ATTENTION', reason: 'ADAPTER_REQUIRED_START'});
  assert.equal(controller.manifest().running, false);
  assert.equal((await controller.execute('UPDATE', {optIn: true, dryRun: false, target: config})).reason, 'DRAIN_REQUIRED');
  // The rollback lever to STANDARD_DEVICES always exists, even for an installation that was switched to HYBRID.
  const hybrid = createDeploymentController({config: {...config, profile: 'HYBRID'}, checks, adapter: {}, initialManifest: {installed: true}});
  assert.equal(hybrid.manifest().profile, 'HYBRID');
  const rolledBack = await hybrid.execute('STANDARD_DEVICES', {optIn: true, dryRun: false});
  assert.deepEqual({state: rolledBack.state, profile: rolledBack.manifest.profile}, {state: 'READY', profile: 'STANDARD_DEVICES'});
});

test('PCF-718 line 43/49/51: the honest evidence class of a one-host worker run, the prerequisite ledger, and a local performance figure that is never generalised', () => {
  // A local, single-host worker run is labelled as such: it never claims a real second host.
  assert.equal(createRemoteWorkerPort({enabled: false}).evidenceClass, 'SIMULATED_TOPOLOGY+ACTUAL_LOCAL_PROCESSES');
  // Linux readiness is a PREREQUISITE ledger, not an acceptance: absent hardware, and even an UNKNOWN/NOT_RUN answer,
  // leaves PCF-718 not proven rather than presumed.
  assert.equal(assessOptionalReadiness({})['PCF-718'], 'PREREQUISITE_NOT_PROVEN');
  for (const linuxRuntimeReady of ['NOT_RUN', 'UNKNOWN', 'UNSUPPORTED', 'false', 1, null]) {
    assert.equal(assessOptionalReadiness({linuxRuntimeReady})['PCF-718'], 'PREREQUISITE_NOT_PROVEN');
  }
  assert.equal(assessOptionalReadiness({linuxRuntimeReady: true})['PCF-718'], 'PREREQUISITE_OBSERVED');
  // Virtualised performance may not be generalised to a physical workbench: the only overhead measurement available is
  // explicitly this host, this loop, on a monotonic local clock.
  const overhead = measureInstrumentationOverhead({iterations: 10, enabled: () => 1 + 1, disabled: () => 1});
  assert.deepEqual({scope: overhead.scope, generalisable: overhead.generalisable, clock: overhead.clock},
    {scope: 'THIS_HOST_THIS_LOOP_ONLY', generalisable: false, clock: 'PROCESS_HRTIME_MONOTONIC_LOCAL'});
});

test('PCF-718 line 49/51: executing a CPU task on a real Linux runtime is a typed NOT_RUN on this host', async () => {
  // The premise of the NOT_RUN is asserted rather than assumed: this is not a Linux platform and there is no WSL
  // distribution, so the workbook's real-Linux item has no runtime here. If that ever changes this test must be
  // rewritten into a real execution test instead of passing for the wrong reason.
  assert.notEqual(process.platform, 'linux');
  let distributions = [];
  try {
    const listing = execFileSync('wsl.exe', ['-l', '-q'], {timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    distributions = listing.split(/\r?\n/).map(line => line.replace(/\0/g, '').trim()).filter(Boolean);
  } catch { distributions = []; }
  assert.deepEqual(distributions, [], 'a Linux runtime appeared; this item is no longer NOT_RUN and must be executed for real');
  // The implementation's own typed markers agree: the prerequisite is not observed, and physical acceptance is NOT_RUN.
  assert.equal(assessOptionalReadiness({linuxRuntimeReady: false})['PCF-718'], 'PREREQUISITE_NOT_PROVEN');
  const dir = await mkdtemp(join(tmpdir(), 'pcf718-norun-'));
  const store = new Store(dir);
  try {
    const service = createFabricService({store, artifactRoot: join(dir, 'artifacts'), deviceId: 'alien',
      readAuthority: async () => ({version: 1, authorized: true, expiresAt: Date.now() + 60000, originDeviceId: 'alien',
        allowedDevices: ['alien'], dataScopes: ['PUBLIC'], sharingConsent: false, cloudConsent: false, budget: 0})});
    assert.equal(service.health().physicalAcceptance, 'NOT_RUN');
    assert.equal(service.health().executionScope, 'ACTUAL_LOCAL_CPU');
  } finally { store.db.close(); await rm(dir, {recursive: true, force: true}); }
});
