// PCF-727 workbook acceptance: live engineering connector execution contract.
// Workbook: dc/mission-book/mission-group/personal-compute-fabric/PCF-727-engineering-connector-live-execution.md
// Real modules under test: services/personal-compute-fabric/engineering-runtime.mjs,
// engineering-executor-adapter.mjs and the EM-011 reference connectors. tests/pcf727-runtime.test.mjs
// already owns the process-durability regressions, so this file covers the workbook's own acceptance
// list: the ConnectorPort binding, typed NOT_RUN/ATTENTION/UNSUPPORTED when the client is missing or
// unlicensed, owned-session binding, canonical correlation, isolated-worktree staging instead of blind
// writes, and the separation of provider inference from host execution.
//
// NOT_RUN on this host (external prerequisite, no attempt made): the real Codex / DeepSeek Harness
// session loop (CODEX_LOCAL, CODEX_REMOTE, DEEPSEEK_LOCAL, DEEPSEEK_REMOTE) needs a licensed client and a
// completed login. No install, login or purchase is performed here; the tests below assert the typed
// NOT_RUN contract instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, realpath, rm, writeFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEngineeringRuntime, buildCodexInvocation} from '../services/personal-compute-fabric/engineering-runtime.mjs';
import {bindEngineeringExecutor} from '../services/personal-compute-fabric/engineering-executor-adapter.mjs';
import {createArtifactStore, sha256} from '../services/personal-compute-fabric/artifacts.mjs';
import {saveCheckpoint} from '../services/personal-compute-fabric/checkpoint.mjs';
import {copy} from '../services/personal-compute-fabric/validation.mjs';
import {CONNECTOR_PORT, ACCEPTANCE_DEFERRED, createReferenceConnector, createConnectorRegistry} from '../contracts/engineering-reference-connectors-v1/reference-connectors.mjs';

const SHA = 'a'.repeat(40);
const jsonl = events => `process.stdout.write(${JSON.stringify(events.join('\n') + '\n')})`;
const STARTED = '{"type":"thread.started","thread_id":"owned-provider-session"}';
const PROGRESS = '{"type":"progress","stage":"generate","percent":50}';
const COMPLETED = '{"type":"turn.completed","output":{"value":42}}';

// A throwaway git repository with one real linked worktree beside it. It is self-contained, so the
// checkout under test is never touched and no worktree registration leaks into its .git directory.
async function gitWorktreeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pcf727-exec-'));
  const worktree = root + '-wt';
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', maxBuffer: 65536}).trim();
  git('init', '-q');
  git('config', 'user.email', 'pcf727-fixture@example.invalid');
  git('config', 'user.name', 'PCF-727 fixture');
  git('config', 'core.autocrlf', 'false');
  await writeFile(join(root, 'README.md'), 'pcf727 fixture base\n');
  git('add', '--', 'README.md');
  git('commit', '-q', '-m', 'fixture base');
  const baseSha = git('rev-parse', 'HEAD');
  git('worktree', 'add', '-q', worktree, 'HEAD');
  return {
    root,
    worktree,
    baseSha,
    status: () => git('status', '--porcelain'),
    cleanup: async () => {
      for (const path of [root, worktree]) await rm(path, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    },
  };
}

// Host-runtime adapter shape for the EM-011 reference connectors (product parsing lives below the port).
const hostRuntime = ({installed = true, version = 'codex-cli 0.42.0', auth = 'READY', evidence} = {}) => ({
  probe: () => ({installed, version_output: version}),
  auth: () => ({state: auth}),
  start: () => ({backend_session_ref: 'backend-session-1'}),
  submit: () => ({result_ref: null}),
  events: () => [{sequence: 1, kind: 'PROGRESS', text: 'compiling'}],
  control: () => ({}),
  result: () => ({state: 'SUCCEEDED'}),
  ...(evidence === undefined ? {} : {acceptanceEvidence: () => evidence}),
});

// Workbook line 11: bindEngineeringExecutor(connector, providerManifest) maps probe/version/auth/
// readiness, launch or supported attach, session binding, submit, progress/checkpoint, control/result/health.
test('727 the executor binding maps the whole ConnectorPort and refuses an unversioned manifest or an incomplete port', () => {
  const connector = createReferenceConnector({kind: 'CODEX', runtime: hostRuntime()});
  const adapter = bindEngineeringExecutor(connector, {version: 1, id: 'codex-cli-pcf-candidate'});
  // Workbook line 11's own mapping list.
  for (const method of ['probe', 'version', 'auth', 'readiness', 'startOrAttach', 'submit', 'events', 'control', 'result', 'health']) {
    assert.equal(typeof adapter[method], 'function', 'the binding maps ' + method);
  }
  assert.equal(adapter.providerId, 'codex-cli-pcf-candidate');
  assert.equal(adapter.evidenceClass, 'CONNECTOR_CONTRACT_ONLY_UNTIL_REAL_PROVIDER_RUN', 'a contract binding is not provider acceptance');
  assert.throws(() => bindEngineeringExecutor(connector, {version: 2, id: 'codex-cli-pcf-candidate'}), {code: 'ENGINEERING_PROVIDER_VERSION'});
  assert.throws(() => bindEngineeringExecutor(connector, {id: 'codex-cli-pcf-candidate'}), {code: 'ENGINEERING_PROVIDER_VERSION'});
  assert.throws(() => bindEngineeringExecutor(connector, {version: 1}), {code: 'ENGINEERING_PROVIDER_VERSION'});
  const incomplete = {...connector};
  delete incomplete.result;
  assert.throws(() => bindEngineeringExecutor(incomplete, {version: 1, id: 'codex-cli-pcf-candidate'}), {code: 'CONNECTOR_METHOD_result'});
  const noCapabilities = {...connector};
  delete noCapabilities.capabilities;
  assert.ok(CONNECTOR_PORT.methods.includes('capabilities'), 'the EM-011 port inventory includes capabilities');
  assert.throws(() => bindEngineeringExecutor(noCapabilities, {version: 1, id: 'codex-cli-pcf-candidate'}), {code: 'CONNECTOR_METHOD_capabilities'}, 'the whole ConnectorPort inventory must be implemented');
  assert.throws(() => bindEngineeringExecutor(null, {version: 1, id: 'codex-cli-pcf-candidate'}), {code: 'CONNECTOR_METHOD_probe'});
});

// Workbook line 12: missing installation/auth/licence/permissions yields typed NOT_RUN/ATTENTION/
// UNSUPPORTED, with no automatic installation, login, purchase or paid-API switch.
test('727 a missing or unlicensed client is a typed NOT_RUN refusal, never an install or login attempt', async () => {
  const runtime = createEngineeringRuntime({});
  assert.deepEqual(await runtime.probe(), {state: 'UNKNOWN', installation: 'NOT_PROBED', realProviderAcceptance: 'NOT_RUN'}, 'the host is not probed for a client that was never approved');
  assert.deepEqual(await runtime.version(), {version: null, state: 'NOT_RUN'}, 'an unverified version is NOT_RUN, not invented');
  const auth = await runtime.auth();
  assert.equal(auth.state, 'UNKNOWN');
  assert.equal(auth.credentialRead, false, 'no credential is read');
  const readiness = await runtime.readiness();
  assert.equal(readiness.state, 'NOT_READY');
  assert.equal(readiness.reason, 'EXPLICIT_PROVIDER_APPROVAL_AND_AUTH_REQUIRED');
  assert.equal(readiness.realProviderAcceptance, 'NOT_RUN');
  const health = await runtime.health();
  assert.equal(health.state, 'NOT_READY');
  assert.equal(health.realProviderAcceptance, 'NOT_RUN');
  assert.equal(health.restartRecovery, 'UNSUPPORTED');
  assert.equal(health.active, 0);
  for (const forbidden of ['install', 'login', 'purchase', 'subscribe', 'enroll']) {
    assert.equal(Object.hasOwn(runtime, forbidden), false, 'the runtime exposes no ' + forbidden + ' capability');
  }
  await assert.rejects(runtime.submit({taskId: 'T-727', attemptId: 'A-727', approved: true, baseSha: SHA, isolatedWorktree: 'D:/never-used', prompt: 'x'}), {code: 'REAL_PROVIDER_UNAVAILABLE'});
  assert.equal((await runtime.health()).active, 0, 'a refused submission starts no process');

  const notInstalled = createReferenceConnector({kind: 'CODEX', runtime: hostRuntime({installed: false})});
  const probe = notInstalled.probe();
  assert.equal(probe.install_state, 'NOT_INSTALLED');
  assert.equal(probe.installed, false);
  assert.equal(probe.version, 'UNKNOWN');
  assert.equal(probe.emulated, false);
  assert.equal(notInstalled.readiness().state, 'NOT_READY');
  assert.equal(notInstalled.readiness().reason, 'NOT_INSTALLED');
  assert.equal(notInstalled.auth().state, 'UNAVAILABLE');
  assert.equal(notInstalled.auth().ready, false, 'a client that is not installed is never reported as an authenticated one');
  await assert.rejects(async () => notInstalled.startOrAttach({canonical_job_ref: 'job:not-installed'}), error => {
    assert.equal(error.code, 'NOT_INSTALLED');
    assert.equal(error.auto_install_attempted, false, 'no installation is attempted');
    return true;
  });
  const notInstalledHealth = notInstalled.health();
  assert.equal(notInstalledHealth.health, 'UNHEALTHY');
  assert.equal(notInstalledHealth.attention.kind, 'INSTALL_REQUIRED');
  assert.equal(notInstalledHealth.attention.blocking, true);
  assert.equal(notInstalledHealth.attention.auto_retry, false);
  const bound = bindEngineeringExecutor(notInstalled, {version: 1, id: 'codex-cli-pcf-candidate'});
  await assert.rejects(bound.submit({capsule: {}, inputArtifact: 'a', isolatedWorktree: 'D:/never-used', approved: true}), {code: 'REAL_PROVIDER_UNAVAILABLE'});

  const expired = createReferenceConnector({kind: 'CODEX', runtime: hostRuntime({auth: 'EXPIRED'})});
  assert.equal(expired.readiness().state, 'NOT_READY');
  assert.equal(expired.readiness().reason, 'AUTH_EXPIRED');
  await assert.rejects(async () => expired.startOrAttach({canonical_job_ref: 'job:expired'}), error => {
    assert.equal(error.code, 'AUTH_REQUIRED');
    assert.equal(error.auth_state, 'EXPIRED');
    assert.equal(error.user_action_required, true, 'an expired login needs the user, it is not a silent retry');
    assert.equal(error.auto_retry, false);
    assert.equal(error.connector_kind, 'CODEX');
    return true;
  });
  const needsUser = createReferenceConnector({kind: 'DEEPSEEK_HARNESS', runtime: hostRuntime({auth: 'NEEDS_USER'})});
  await assert.rejects(async () => needsUser.startOrAttach({canonical_job_ref: 'job:needs-user'}), error => {
    assert.equal(error.code, 'USER_ACTION_REQUIRED');
    assert.equal(error.user_action_required, true);
    assert.equal(error.auto_retry, false);
    return true;
  });
});

// Workbook line 12: an installed version offers only the interfaces it really advertises. Unsupported
// capability and unsupported control are typed refusals, not silence and not success.
test('727 unsupported capability and unsupported control are typed refusals against the installed interface', async () => {
  const codex = createReferenceConnector({kind: 'CODEX', runtime: hostRuntime()});
  const capabilities = codex.capabilities();
  assert.equal(capabilities.canonical_names_only, true);
  assert.equal(capabilities.product_specific_names_exposed, false);
  assert.deepEqual([...capabilities.capabilities].sort(), ['code.generate', 'code.review', 'repository.inspect', 'tests.run']);
  await codex.startOrAttach({canonical_job_ref: 'job:capability'});
  await assert.rejects(async () => codex.submit({canonical_job_ref: 'job:capability', operation: 'shell.execute'}), error => {
    assert.equal(error.code, 'UNSUPPORTED_CAPABILITY');
    assert.equal(error.silently_ignored, false);
    assert.equal(error.emulated, false);
    return true;
  });

  const deepseek = createReferenceConnector({kind: 'DEEPSEEK_HARNESS', runtime: hostRuntime()});
  await deepseek.startOrAttach({canonical_job_ref: 'job:control'});
  await assert.rejects(async () => deepseek.control({canonical_job_ref: 'job:control', operation: 'PAUSE'}), error => {
    assert.equal(error.code, 'UNSUPPORTED_OPERATION');
    assert.equal(error.refused, true);
    assert.equal(error.silently_ignored, false);
    return true;
  });
  assert.deepEqual([...deepseek.capabilities().supported_controls], ['CANCEL'], 'only the advertised controls exist');
});

// Workbook line 11 + line 16: session binding is an owned session, or a supported attach of one; an
// ambient or foreign session and an unsupported resume are refused.
test('727 session binding refuses ambient, foreign and resumed sessions', async () => {
  const runtime = createEngineeringRuntime({});
  await assert.rejects(runtime.startOrAttach({backendSessionId: 'foreign-session'}), {code: 'OWNED_SESSION_REQUIRED'});
  await assert.rejects(runtime.startOrAttach({backend_run_ref: 'foreign-run'}), {code: 'OWNED_SESSION_REQUIRED'});
  await assert.rejects(runtime.startOrAttach({}), {code: 'EXPLICIT_OWNED_SESSION_REQUIRED'});
  await assert.rejects(runtime.startOrAttach({sessionId: 'not-an-owned-session'}), {code: 'OWNED_SESSION_REQUIRED'});
  assert.throws(() => buildCodexInvocation({workspace: 'D:/isolated', prompt: 'x', resumeSession: '--last'}), {code: 'OWNED_SESSION_RESUME_UNSUPPORTED'});
  assert.equal(runtime.capabilities().resume, 'UNSUPPORTED');
  await assert.rejects(runtime.control({sessionId: 'any', operation: 'RESUME'}), {code: 'UNSUPPORTED_OPERATION'});
  await assert.rejects(runtime.control({sessionId: 'any', operation: 'PAUSE'}), {code: 'UNSUPPORTED_OPERATION'});

  const adapter = bindEngineeringExecutor(createReferenceConnector({kind: 'CODEX', runtime: hostRuntime()}), {version: 1, id: 'codex-cli-pcf-candidate'});
  const started = await adapter.startOrAttach({canonical_job_ref: 'job:attach'});
  assert.equal(started.started, true);
  assert.equal(started.attached, false);
  assert.equal(started.canonical_job_ref, 'job:attach', 'one canonical job id, the backend ids stay provenance');
  assert.equal(started.backend_run_ref, null, 'a backend run ref is never invented');
  assert.equal(started.session_kind, 'CLI_SESSION');
  const attached = await adapter.startOrAttach({canonical_job_ref: 'job:attach'});
  assert.equal(attached.attached, true);
  assert.equal(attached.started, false);
  assert.equal(attached.session_ref, started.session_ref);
  const duplicate = {canonical_job_ref: 'job:attach', operation: 'code.generate', action_key: 'action-1', capsule: {}, inputArtifact: 'a', isolatedWorktree: 'D:/never-used', approved: true};
  const first = await adapter.submit(duplicate);
  assert.equal(first.submitted, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.result_ref, null);
  assert.equal(first.backend_result_ref_known, false, 'a backend result reference is only reported when the backend produced one');
  const second = await adapter.submit(duplicate);
  assert.equal(second.submitted, false, 'the same logical action is not executed twice');
  assert.equal(second.duplicate, true);
  assert.equal(second.repeated, false);
});

// Workbook line 11 + line 16: submit/progress/checkpoint/control/result/health wiring, and correlation of
// the canonical job/task with provider session, base SHA, worktree and host/boot/attempt. Workbook line 15:
// provider inference, host execution and queue/network time are separate readings; remote host work neither
// pools hosted-model inference nor expands account limits.
test('727 submit, progress, result and health correlate the canonical attempt with a real subprocess', async () => {
  const fixture = await gitWorktreeFixture();
  try {
    const runtime = createEngineeringRuntime({
      executable: process.execPath,
      componentFixture: true,
      approved: true,
      hostId: 'pcf727-host',
      bootId: 'pcf727-boot',
      fixtureArgs: ['-e', jsonl([STARTED, PROGRESS, COMPLETED])],
      persistReceipt: async () => {},
    });
    const receipt = await runtime.submit({taskId: 'T-727', attemptId: 'A-727', approved: true, isolatedWorktree: fixture.worktree, baseSha: fixture.baseSha, prompt: 'fixture'});
    assert.equal(receipt.state, 'RUNNING');
    assert.equal(typeof receipt.sessionId, 'string');
    assert.equal(receipt.taskId, 'T-727');
    assert.equal(receipt.attemptId, 'A-727');
    assert.equal(receipt.baseSha, fixture.baseSha);
    assert.equal(receipt.worktree, await realpath(fixture.worktree), 'the verified real path is what executes');
    assert.equal(receipt.hostId, 'pcf727-host');
    assert.equal(receipt.bootId, 'pcf727-boot');
    assert.ok(receipt.pid > 0);
    assert.equal(receipt.evidenceClass, 'REAL_SUBPROCESS_COMPONENT_FIXTURE', 'a component fixture is not provider acceptance');

    const exit = await runtime.wait(receipt.sessionId);
    assert.equal(exit.state, 'SUCCEEDED');
    assert.equal(exit.exitCode, 0);
    assert.equal(exit.processClosed, true);
    assert.equal(exit.durableReceipt, true, 'a result is only collectable behind a durable receipt');
    assert.equal(exit.backendSessionId, 'owned-provider-session', 'the provider session is provenance beside the canonical owned session');
    assert.notEqual(exit.backendSessionId, receipt.sessionId);
    assert.equal(exit.unknownSideEffects, true, 'a clean exit does not prove tree termination or reconciled effects');
    assert.equal(exit.processTreeTermination, 'NOT_PROVEN');
    assert.equal(exit.providerInference, 'NOT_MEASURED', 'provider inference time is not a host measurement');
    for (const claim of ['pooledInference', 'hostedInferenceSpeedup', 'accountLimitExpansion', 'inferenceMs']) {
      assert.equal(Object.hasOwn(exit, claim), false, 'host execution never claims ' + claim);
    }

    // Progress is read from the owned stream by cursor; the durable event record outlives the process.
    const progress = await runtime.events({sessionId: receipt.sessionId});
    assert.equal(progress.cursor, 3);
    assert.ok(progress.events.some(event => event.type === 'progress'), 'progress is read from the owned stream');
    assert.deepEqual((await runtime.events({sessionId: receipt.sessionId, cursor: progress.cursor})).events, [], 'a consumed cursor is not re-delivered');
    await assert.rejects(runtime.events({sessionId: receipt.sessionId, cursor: 99}), {code: 'EVENT_CURSOR'});

    const result = await runtime.result({sessionId: receipt.sessionId});
    assert.equal(result.taskId, 'T-727');
    assert.equal(result.attemptId, 'A-727');
    assert.equal(result.baseSha, fixture.baseSha);
    assert.equal(result.worktree, await realpath(fixture.worktree));
    const health = await runtime.health();
    assert.equal(health.state, 'READY');
    assert.equal(health.active, 0);
    assert.equal(health.realProviderAcceptance, 'NOT_RUN', 'a component fixture never becomes real-provider acceptance');
    assert.equal(health.restartRecovery, 'UNSUPPORTED');
  } finally {
    await fixture.cleanup();
  }
});

// Workbook line 14: stage verified versioned inputs into isolated worktrees, explicitly snapshot dirty
// inputs, and never blindly share a writable worktree, overwrite another workspace or auto-merge.
test('727 isolated-worktree staging refuses dirty input, a foreign checkout and any auto-merge', async () => {
  const fixture = await gitWorktreeFixture();
  try {
    const runtime = createEngineeringRuntime({
      executable: process.execPath,
      componentFixture: true,
      approved: true,
      hostId: 'pcf727-host',
      bootId: 'pcf727-boot',
      fixtureArgs: ['-e', jsonl([STARTED, COMPLETED])],
      persistReceipt: async () => {},
    });
    // The primary checkout is not an isolated worktree.
    await assert.rejects(runtime.submit({taskId: 'T-primary', attemptId: 'A-primary', approved: true, isolatedWorktree: fixture.root, baseSha: fixture.baseSha, prompt: 'x'}), {code: 'ISOLATED_WORKTREE_REQUIRED'});
    await assert.rejects(runtime.submit({taskId: 'T-relative', attemptId: 'A-relative', approved: true, isolatedWorktree: 'isolated', baseSha: fixture.baseSha, prompt: 'x'}), {code: 'ISOLATED_WORKTREE_REQUIRED'});
    await assert.rejects(runtime.submit({taskId: 'T-sha', attemptId: 'A-sha', approved: true, isolatedWorktree: fixture.worktree, baseSha: 'b'.repeat(40), prompt: 'x'}), {code: 'BASE_SHA_MISMATCH'});

    await writeFile(join(fixture.worktree, 'dirty-input.txt'), 'uncommitted work\n');
    await assert.rejects(runtime.submit({taskId: 'T-dirty', attemptId: 'A-dirty', approved: true, isolatedWorktree: fixture.worktree, baseSha: fixture.baseSha, prompt: 'x'}), {code: 'DIRTY_WORKTREE_SNAPSHOT_REQUIRED'});
    assert.equal(await readFile(join(fixture.worktree, 'dirty-input.txt'), 'utf8'), 'uncommitted work\n', 'a dirty input is snapshotted, never overwritten or discarded');
    assert.equal((await runtime.health()).active, 0, 'no process starts against an unverified worktree');
    await rm(join(fixture.worktree, 'dirty-input.txt'));

    const script = `require('fs').writeFileSync('evidence.txt','isolated-only');${jsonl([STARTED, COMPLETED])}`;
    const clean = createEngineeringRuntime({executable: process.execPath, componentFixture: true, approved: true, fixtureArgs: ['-e', script], persistReceipt: async () => {}});
    const receipt = await clean.submit({taskId: 'T-clean', attemptId: 'A-clean', approved: true, isolatedWorktree: fixture.worktree, baseSha: fixture.baseSha, prompt: 'x'});
    await clean.wait(receipt.sessionId);
    await access(join(fixture.worktree, 'evidence.txt'));
    await assert.rejects(access(join(fixture.root, 'evidence.txt')), 'the run never writes into another workspace (the primary checkout)');
    assert.equal(fixture.status(), '', 'the primary checkout stays untouched');

    await assert.rejects(clean.control({sessionId: receipt.sessionId, operation: 'MERGE'}), {code: 'UNSUPPORTED_OPERATION'});
    await assert.rejects(clean.control({sessionId: receipt.sessionId, operation: 'OVERWRITE'}), {code: 'UNSUPPORTED_OPERATION'});
    for (const forbidden of ['merge', 'overwrite', 'checkout']) {
      assert.equal(Object.hasOwn(clean, forbidden), false, 'the runtime exposes no ' + forbidden + ' operation');
    }
  } finally {
    await fixture.cleanup();
  }
});

// Workbook line 16: track process trees, cancellation, deadlines and unknown effects; an unsupported
// session resume never becomes a transparent-resume claim.
test('727 cancellation, deadlines and unknown effects stay honest, and an unknown-effect run is not checkpointed', async () => {
  const fixture = await gitWorktreeFixture();
  try {
    const hanging = createEngineeringRuntime({executable: process.execPath, componentFixture: true, approved: true, fixtureArgs: ['-e', 'setInterval(()=>{},1000)'], persistReceipt: async () => {}});
    const running = await hanging.submit({taskId: 'T-cancel', attemptId: 'A-cancel', approved: true, isolatedWorktree: fixture.worktree, baseSha: fixture.baseSha, prompt: 'x'});
    const control = await hanging.control({sessionId: running.sessionId, operation: 'CANCEL'});
    assert.equal(control.requested, true);
    assert.equal(control.unknownSideEffects, true);
    const cancelled = await hanging.wait(running.sessionId);
    assert.equal(cancelled.state, 'CANCELLED');
    assert.equal(cancelled.processClosed, true);
    assert.equal(cancelled.unknownSideEffects, true, 'killing the child does not reconcile unknown effects');
    assert.equal(cancelled.processTreeTermination, 'NOT_PROVEN');

    const slow = createEngineeringRuntime({executable: process.execPath, componentFixture: true, approved: true, timeoutMs: 250, fixtureArgs: ['-e', 'setInterval(()=>{},1000)'], persistReceipt: async () => {}});
    const timed = await slow.submit({taskId: 'T-deadline', attemptId: 'A-deadline', approved: true, isolatedWorktree: fixture.worktree, baseSha: fixture.baseSha, prompt: 'x'});
    const timedOut = await slow.wait(timed.sessionId);
    assert.equal(timedOut.state, 'FAILED', 'a deadline is not a success');
    assert.equal(timedOut.reason, 'TIMEOUT');
    assert.equal(timedOut.processClosed, true);

    const artifacts = createArtifactStore({root: join(fixture.root, 'artifacts'), maxBytes: 1048576, maxItems: 16, authorize: async () => true});
    const now = Date.now();
    const binding = {taskId: 'T-727', attemptId: 'A-727', inputDigest: 'c'.repeat(64), providerVersion: '0.42.0', stageId: 'stage-1', owner: 'owner:session', dataScope: 'PUBLIC', expiresAt: now + 60000};
    await assert.rejects(saveCheckpoint(artifacts, {sideEffects: 'UNKNOWN', committed: false}, binding, now), {code: 'CHECKPOINT_SIDE_EFFECT_UNKNOWN'}, 'an unknown-effect run is not checkpointed for replay');
    const state = {sideEffects: 'NONE', committed: false, cursor: 7};
    const ref = await saveCheckpoint(artifacts, state, binding, now);
    assert.equal(ref.schema, 'pcf-checkpoint-v1');
    assert.equal(ref.version, 1);
    assert.equal(ref.digest, sha256(Buffer.from(JSON.stringify({version: 1, binding: copy(binding), state: copy(state)}))), 'the checkpoint digest binds the canonical attempt');
  } finally {
    await fixture.cleanup();
  }
});

// Workbook line 13: Codex and DeepSeek Harness evidence is tracked separately; CODEX_REMOTE and
// DEEPSEEK_REMOTE are not accepted from a local fixture, and the requirement for both real providers is
// not silently weakened to Codex-only.
test('727 provider acceptance stays per-provider and is never claimed from a local fixture', async () => {
  const codex = createReferenceConnector({kind: 'CODEX', runtime: hostRuntime()});
  const deepseek = createReferenceConnector({kind: 'DEEPSEEK_HARNESS', runtime: hostRuntime({version: 'deepseek-harness 1.2.3'})});
  for (const connector of [codex, deepseek]) {
    const report = connector.acceptanceReport();
    assert.equal(report.component_stage_acceptance, false, connector.connectorKind() + ' has not produced real runtime evidence');
    assert.equal(report.deferred_marker, ACCEPTANCE_DEFERRED);
    assert.equal(report.real_submit_evidence, null);
    assert.equal(report.emulated_smoke_labelled_as_acceptance, false);
    assert.equal(report.install_state, 'INSTALLED');
  }
  assert.deepEqual([...codex.capabilities().capabilities].sort().join(','), 'code.generate,code.review,repository.inspect,tests.run');
  assert.deepEqual([...deepseek.capabilities().capabilities].sort().join(','), 'code.generate,code.review,repository.inspect,shell.execute');
  assert.notEqual(codex.descriptor().display_name, deepseek.descriptor().display_name, 'the two providers keep separate conformance records');

  const partial = createReferenceConnector({kind: 'CODEX', runtime: hostRuntime({evidence: {real: true, submit_ref: 'submit:1', progress_ref: 'progress:1', terminal_ref: null, terminal_state: 'SUCCEEDED'}})});
  assert.equal(partial.acceptanceReport().component_stage_acceptance, false);
  assert.equal(partial.acceptanceReport().evidence_incomplete, true, 'two stages are not a submit/progress/terminal chain');
  const emulated = createReferenceConnector({kind: 'CODEX', runtime: hostRuntime({evidence: {real: false, submit_ref: 'submit:1', progress_ref: 'progress:1', terminal_ref: 'terminal:1', terminal_state: 'SUCCEEDED'}})});
  assert.equal(emulated.acceptanceReport().component_stage_acceptance, false, 'an emulated smoke is not acceptance');
  const real = createReferenceConnector({kind: 'CODEX', runtime: hostRuntime({evidence: {real: true, submit_ref: 'submit:1', progress_ref: 'progress:1', terminal_ref: 'terminal:1', terminal_state: 'SUCCEEDED'}})});
  assert.equal(real.acceptanceReport().component_stage_acceptance, true);
  assert.equal(real.acceptanceReport().evidence_source, 'HOST_RUNTIME');

  const registry = createConnectorRegistry({});
  registry.register({connector: codex});
  registry.register({connector: deepseek});
  const summary = registry.acceptanceSummary();
  assert.deepEqual([...summary.component_stage_accepted], []);
  assert.deepEqual([...summary.deferred].sort(), ['CODEX', 'DEEPSEEK_HARNESS'], 'both providers stay deferred; neither is dropped');
  assert.equal(summary.emulated_acceptance_claimed, 0);

  const documentation = await readFile(new URL('../docs/en/pcf/engineering-runtime.md', import.meta.url), 'utf8');
  assert.match(documentation, /CODEX_REMOTE/, 'the installed interface and its limits are recorded');
  assert.match(documentation, /DEEPSEEK_REMOTE/);
  assert.match(documentation, /NOT_RUN/);
  assert.match(documentation, /declines resume/, 'the unsupported resume is documented, not hidden');
});
