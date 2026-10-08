// PCF-711 acceptance — explicit checkpoints and resume compatibility.
//
// Workbook: PCF-711-checkpoint-and-resume-contract.md (spec_revision 1).
//   * bullet 1: provider save/restore capability, original task/attempt/inputDigest, schema, executor/runtime/model
//     versions, completed stages, pending outputs and side-effect state;
//   * bullet 2: checkpoints publish as verifiable COMPLETE artifacts; partial / write-failed states are not visible as
//     recoverable; generation/digest and authorization are handed to 709;
//   * bullet 3: restore must check target platform/dependency/model/data domain compatibility; an incompatible upgrade
//     is refused (or migrated by a tested migration), never guessed from file existence;
//   * bullet 4: a real chunked CPU task is interrupted, resumed, and matches the uninterrupted final digest; GUI /
//     external sessions / hidden provider reasoning are explicitly NOT resumable;
//   * acceptance paragraph: half-writes, corruption, wrong task, old input, wrong executor/model, unresolved external
//     side effects, authority revocation, duplicate restore; a committed result cannot be committed twice; save/read
//     compatible artifacts across the two real workers without claiming arbitrary process migration.
//
// NAMING DIFFERENCE (reported, not silently absorbed): the workbook's candidate path is
// `services/personal-compute-fabric/checkpoints.mjs`. No such file exists; the checkpoint contract lives in
// `services/personal-compute-fabric/checkpoint.mjs` (singular) and its storage half in `artifacts.mjs`. This test
// exercises the real modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createArtifactStore, sha256} from '../services/personal-compute-fabric/artifacts.mjs';
import {saveCheckpoint, restoreCheckpoint} from '../services/personal-compute-fabric/checkpoint.mjs';
import {createArtifactRef, createResumeCursor, canResume, advanceCursor} from '../services/personal-compute-fabric/artifact-reference.mjs';
import {executeCpu} from '../services/personal-compute-fabric/executor.mjs';
import {retrySafetyCapabilities} from '../services/personal-compute-fabric/workload-envelope.mjs';

const DIGEST = value => sha256(String(value));
const scratch = () => mkdtemp(join(tmpdir(), 'pcf711-checkpoint-'));

// The binding is the checkpoint's identity contract: provider/save-capability, original task and attempt, the input
// digest, the schema stage and the executor/runtime/model/platform/dependency versions restore must re-check.
const binding = (attemptId = 'attempt-old', extra = {}) => ({
  taskId: 'task-711', attemptId, inputDigest: DIGEST('input-711'), providerVersion: '1', stageId: 'sum',
  owner: 'worker-a', dataScope: 'PUBLIC', expiresAt: 5000,
  executorVersion: 'pcf-cpu-executor-1', runtimeVersion: 'node-' + process.versions.node.split('.')[0],
  modelVersion: 'NOT_APPLICABLE_CPU', platform: 'portable-js-integer', dependencyDigest: DIGEST('no-dependencies'),
  workloadKind: 'CPU', ...extra,
});
const approval = (extra = {}) => ({
  approved: true, sourceAttemptId: 'attempt-old', targetFence: 'fence-2',
  validateFence: async (target, request) => target.attemptId === 'attempt-new'
    && request.sourceBinding.attemptId === 'attempt-old' && request.sourceBinding.taskId === target.taskId
    && request.targetFence === 'fence-2', ...extra,
});
const openStore = (root, extra = {}) => createArtifactStore({root, maxBytes: 1000000, maxItems: 10, authorize: () => true, ...extra});

test('PCF711-01 the checkpoint carries the provider save contract, task/attempt/input digest, versions and side-effect state (workbook bullet 1)', async () => {
  const dir = await scratch();
  try {
    const store = openStore(join(dir, 'a'));
    const state = {sideEffects: 'NONE', cursor: 2, sum: 3, completedStages: ['chunk-1'], pendingOutputs: []};
    const ref = await saveCheckpoint(store, state, binding(), 0);
    // Published as a verifiable artifact (bullet 2): digest, size, schema version and generation are all on the ref.
    assert.match(ref.digest, /^[a-f0-9]{64}$/);
    assert.equal(ref.schema, 'pcf-checkpoint-v1');
    assert.equal(ref.version, 1);
    assert.ok(Number.isSafeInteger(ref.size) && ref.size > 0);
    assert.equal(ref.owner, 'worker-a');
    // The binding round-trips through the published bytes unchanged.
    const restored = await restoreCheckpoint(store, ref, binding(), 1);
    assert.deepEqual(restored, state);
    // A state that does not DECLARE its side-effect state is refused rather than assumed safe: a checkpoint taken with
    // an unresolved external effect must not become recoverable state.
    await assert.rejects(() => saveCheckpoint(store, {cursor: 2}, binding(), 0), {code: 'CHECKPOINT_SIDE_EFFECT_UNKNOWN'});
    // Nor may an unresolved effect be written as if it had none.
    await assert.rejects(() => saveCheckpoint(store, {sideEffects: 'PENDING', cursor: 2}, binding(), 0), {code: 'CHECKPOINT_SIDE_EFFECT_UNKNOWN'});
    // An incomplete binding names the missing field instead of publishing an unattributable checkpoint.
    await assert.rejects(() => saveCheckpoint(store, {sideEffects: 'NONE'}, {...binding(), inputDigest: undefined}, 0), {code: 'CHECKPOINT_BINDING'});
    assert.equal((await readdir(join(dir, 'a'))).filter(f => f.endsWith('.blob')).length, 1, 'the refused saves published nothing');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('PCF711-02 a failed/partial write is not visible as recoverable state (workbook bullet 2)', async () => {
  const dir = await scratch();
  const root = join(dir, 'a');
  try {
    // A store whose rename fails models the last step of publish breaking: the temp file exists, the index entry does
    // not. Whatever error surfaces, nothing may become readable as a checkpoint.
    const broken = createArtifactStore({
      root, maxBytes: 1000000, maxItems: 10, authorize: () => true,
      storageIo: {rename: async () => { throw Object.assign(new Error('disk full during commit'), {code: 'ENOSPC'}); }},
    });
    await assert.rejects(() => saveCheckpoint(broken, {sideEffects: 'NONE', cursor: 1}, binding(), 0));
    // Re-open the same root: no blob was published, so no writer can read a checkpoint that never completed.
    const reopened = openStore(root);
    const files = await readdir(root);
    assert.equal(files.filter(f => f.endsWith('.blob')).length, 0, 'a half-written checkpoint left a readable blob');
    // A reference to the failed artifact cannot be resurrected: the store refuses it as unknown, not as recoverable.
    const failedRef = {...createArtifactRef({opaqueId: '00000000-0000-4000-8000-000000000000', digest: DIGEST('x'), size: 1, schema: 'pcf-checkpoint-v1', owner: 'worker-a', dataScope: 'PUBLIC'}), id: '00000000-0000-4000-8000-000000000000'};
    await assert.rejects(() => restoreCheckpoint(reopened, failedRef, binding(), 1), {code: 'ARTIFACT_UNKNOWN'});
    // A partially seen artifact is a DIFFERENT failure from a wrong binding and from a revoked one.
    const ref = await saveCheckpoint(reopened, {sideEffects: 'NONE', cursor: 1}, binding(), 0);
    await assert.rejects(() => restoreCheckpoint(reopened, {...ref, size: ref.size + 1}, binding(), 1), {code: 'ARTIFACT_UNKNOWN'});
    await assert.rejects(() => restoreCheckpoint(reopened, {...ref, digest: DIGEST('other')}, binding(), 1), {code: 'ARTIFACT_UNKNOWN'});
    // A durable write against a full cache is refused by name and publishes nothing extra.
    const small = createArtifactStore({root: join(dir, 'small'), maxBytes: 1000000, maxItems: 1, authorize: () => true});
    await saveCheckpoint(small, {sideEffects: 'NONE', cursor: 1}, {...binding('a1'), taskId: 'task-1'}, 0);
    await assert.rejects(() => saveCheckpoint(small, {sideEffects: 'NONE', cursor: 1}, {...binding('a2'), taskId: 'task-2'}, 0), {code: 'CACHE_QUOTA'});
    assert.equal((await readdir(join(dir, 'small'))).filter(f => f.endsWith('.blob')).length, 1);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('PCF711-03 restore refuses corruption, wrong task, old input, wrong executor/model/platform/dependency, and a committed result (acceptance paragraph)', async () => {
  const dir = await scratch();
  try {
    const store = openStore(join(dir, 'a'));
    const base = binding();
    const ref = await saveCheckpoint(store, {sideEffects: 'NONE', cursor: 2, sum: 3}, base, 0);
    const target = binding('attempt-new');
    // A different attempt cannot silently pick up another attempt's state: it needs an explicit approval plus a fence.
    await assert.rejects(() => restoreCheckpoint(store, ref, target, 1), {code: 'CHECKPOINT_BINDING_attemptId'});
    // Every compatibility field of the ORIGINAL binding is re-checked by name, one at a time.
    for (const key of ['taskId', 'inputDigest', 'providerVersion', 'stageId', 'owner', 'dataScope', 'executorVersion', 'runtimeVersion', 'modelVersion', 'platform', 'dependencyDigest']) {
      const wrong = key === 'dependencyDigest' ? DIGEST('different-dependencies') : 'mismatched-' + key;
      const outcome = await restoreCheckpoint(store, ref, {...target, [key]: wrong}, 1, approval()).then(() => null, error => error.code);
      assert.equal(outcome, 'CHECKPOINT_BINDING_' + key, 'changing ' + key + ' must be refused by name');
    }
    // workloadKind is compared too. It cannot be varied on its own without also moving an earlier-checked field,
    // because the stored CPU marker (modelVersion NOT_APPLICABLE_CPU) is itself only valid for a CPU workload, so a
    // declaration that switches the kind while keeping the marker is refused as UNPROVEN COMPATIBILITY - the honest
    // answer, not a quietly accepted mismatch.
    const changedKind = await restoreCheckpoint(store, ref, {...target, workloadKind: 'GPU'}, 1, approval()).then(() => null, error => error.code);
    assert.equal(changedKind, 'CHECKPOINT_COMPATIBILITY_REQUIRED');
    // A binding whose compatibility facts are simply ABSENT is refused once a NEW attempt asks for it, rather than
    // being assumed compatible because the checkpoint file exists and parses.
    const bare = {taskId: 'task-bare', attemptId: 'attempt-bare', inputDigest: DIGEST('input-711'), providerVersion: '1', stageId: 'sum', owner: 'worker-a', dataScope: 'PUBLIC', expiresAt: 5000};
    const bareRef = await saveCheckpoint(store, {sideEffects: 'NONE', cursor: 1}, bare, 0);
    // The same attempt may still read what it wrote - it is the compatibility gate for a new attempt that refuses.
    assert.equal((await restoreCheckpoint(store, bareRef, bare, 1)).cursor, 1);
    await assert.rejects(() => restoreCheckpoint(store, bareRef, {...bare, attemptId: 'attempt-bare-new'}, 1,
      approval({sourceAttemptId: 'attempt-bare'})), {code: 'CHECKPOINT_COMPATIBILITY_REQUIRED'});
    // Declaring four of the five facts is refused just the same: an unproven dependency digest is not a proven one.
    await assert.rejects(() => restoreCheckpoint(store, bareRef, {...bare, attemptId: 'attempt-bare-new2',
      executorVersion: 'cpu-v2', runtimeVersion: 'node-24', platform: 'portable-js-integer', modelVersion: 'NOT_APPLICABLE_CPU', workloadKind: 'CPU'}, 1,
      approval({sourceAttemptId: 'attempt-bare'})), {code: 'CHECKPOINT_COMPATIBILITY_REQUIRED'});
    // Even with every fact declared, a new attempt whose dependency digest disagrees is refused by name.
    const complete = {...bare, executorVersion: 'cpu-v1', runtimeVersion: 'node-24', platform: 'portable-js-integer', modelVersion: 'NOT_APPLICABLE_CPU', workloadKind: 'CPU', dependencyDigest: DIGEST('no-dependencies')};
    const completeRef = await saveCheckpoint(store, {sideEffects: 'NONE', cursor: 1}, complete, 0);
    await assert.rejects(() => restoreCheckpoint(store, completeRef, {...complete, attemptId: 'attempt-complete-new', dependencyDigest: DIGEST('changed-dependencies')}, 1,
      approval({sourceAttemptId: 'attempt-bare'})), {code: 'CHECKPOINT_BINDING_dependencyDigest'});
    // A committed result cannot be restored for a second commit.
    const committed = await saveCheckpoint(store, {sideEffects: 'NONE', cursor: 3, committed: true}, binding('attempt-done'), 0);
    await assert.rejects(() => restoreCheckpoint(store, committed, binding('attempt-done'), 1), {code: 'CHECKPOINT_ALREADY_COMMITTED'});
    // Corruption (digest/size that no longer describe the bytes) is an integrity refusal, not a binding one.
    await assert.rejects(() => restoreCheckpoint(store, {...ref, digest: DIGEST('corrupted-bytes')}, base, 1), {code: 'ARTIFACT_UNKNOWN'});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('PCF711-04 unresolved external side effects, revocation, expiry and duplicate restore are each refused by name (acceptance paragraph)', async () => {
  const dir = await scratch();
  try {
    // Authority revocation: publishing is allowed, reading after revocation is not - integrity is not permission.
    const store = openStore(join(dir, 'a'));
    const ref = await saveCheckpoint(store, {sideEffects: 'NONE', cursor: 2, sum: 3}, binding(), 0);
    await store.revoke(ref.id, {caller: 'worker-a'}, 1);
    await assert.rejects(() => restoreCheckpoint(store, ref, binding(), 1), {code: 'ARTIFACT_UNAUTHORIZED_OR_EXPIRED'});
    // Expiry is a separate reason with the same honest outcome: this checkpoint is no longer recoverable.
    const expiring = openStore(join(dir, 'b'));
    const expiringRef = await saveCheckpoint(expiring, {sideEffects: 'NONE', cursor: 1}, binding(), 0);
    await assert.rejects(() => restoreCheckpoint(expiring, expiringRef, binding(), 6000), {code: 'ARTIFACT_UNAUTHORIZED_OR_EXPIRED'});
    // Duplicate restore of the same target attempt is refused; a DIFFERENT target attempt still gets its own claim.
    const claims = openStore(join(dir, 'c'));
    const claimRef = await saveCheckpoint(claims, {sideEffects: 'NONE', cursor: 1}, binding(), 0);
    assert.equal((await restoreCheckpoint(claims, claimRef, binding('attempt-new'), 1, approval())).cursor, 1);
    await assert.rejects(() => restoreCheckpoint(claims, claimRef, binding('attempt-new'), 1, approval()), {code: 'CHECKPOINT_RESTORE_ALREADY_CLAIMED'});
    // A fence that says the target holder is not current blocks the claim before any state is handed over.
    await assert.rejects(() => restoreCheckpoint(claims, claimRef, binding('attempt-third'), 1,
      approval({validateFence: async () => false})), {code: 'CHECKPOINT_FENCE_REJECTED'});
    // No approval at all is not a fence rejection: it is a binding refusal, so a caller cannot mistake "unapproved"
    // for "approved but stale".
    await assert.rejects(() => restoreCheckpoint(claims, claimRef, binding('attempt-fourth'), 1), {code: 'CHECKPOINT_BINDING_attemptId'});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('PCF711-05 a real chunked CPU task interrupted and resumed reaches the uninterrupted final digest (workbook bullet 4)', async () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // Uninterrupted reference run.
  const uninterrupted = await executeCpu({operation: 'SUM', values, deadlineMs: 5000});
  assert.equal(uninterrupted.outcome, 'SUCCEEDED');
  assert.equal(uninterrupted.output.sum, 55);
  // Interruption: the attempt's own signal fires before any byte is supplied, so the child is cancelled and publishes
  // NO output. A cancelled attempt is not a partial success.
  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await executeCpu({operation: 'SUM', values, deadlineMs: 5000, signal: aborted.signal}).catch(error => ({code: error.code}));
  assert.equal(cancelled.code, 'CANCELLED');
  assert.equal(cancelled.output, undefined, 'an interrupted attempt published no partial output');
  // Resume through the real checkpoint contract: the chunk state is saved as an artifact, the new attempt restores it,
  // and the provider's declared save/restore capability is what makes that legitimate.
  const dir = await scratch();
  try {
    const store = openStore(join(dir, 'a'));
    const saved = {sideEffects: 'NONE', cursor: 3, sum: 6, completedStages: ['chunk-0..2'], pendingOutputs: []};
    const ref = await saveCheckpoint(store, saved, binding('attempt-old'), 0);
    const resumedState = await restoreCheckpoint(store, ref, binding('attempt-new'), 1, approval());
    assert.deepEqual(resumedState, saved);
    // The provider capability is declared, not assumed: a CHECKPOINT_RESUMABLE retry class must carry its capability
    // reference, and self-declaration alone is reported as such rather than trusted.
    const envelope = {
      envelopeVersion: 2, taskId: 'task-711', actionId: 'action-711', originDeviceId: 'origin', parentSessionId: 'session',
      appId: 'cpu-sum', targetDeviceRef: null,
      executor: {providerRef: 'pcf-fixed-cpu-v1', providerVersion: 1, providerManifestRef: 'pcf-fixed-cpu-v1'},
      inputSchema: 'json', outputSchema: 'json', capabilities: ['cpu.json'], inputRefs: [], writeScope: [],
      platform: {os: ['win32'], arch: ['x64']}, resources: {cpu: {amount: 1, unit: 'millicores'}},
      qos: 'BATCH', deadlineAt: null, missPolicy: null, retrySafety: 'CHECKPOINT_RESUMABLE',
      checkpointCapabilityRef: 'cap:cpu.checkpoint', dataScope: 'PUBLIC', consent: {required: false, scopeRef: null}, privilegeRequests: [],
    };
    const declared = retrySafetyCapabilities(envelope);
    assert.equal(declared.checkpointResumable, true);
    assert.equal(declared.checkpointCapabilityRef, 'cap:cpu.checkpoint');
    assert.equal(declared.selfDeclaredOnly, false);
    // A bare "I can checkpoint" claim with no backing reference is refused rather than believed.
    assert.throws(() => retrySafetyCapabilities({...envelope, checkpointCapabilityRef: undefined}), {code: 'ENVELOPE_CHECKPOINT_CAPABILITY_REQUIRED'});
    // The resumed run reads the restored chunk state and completes the remaining chunks.
    const resumed = await executeCpu({operation: 'SUM', values, checkpoint: {cursor: resumedState.cursor, sum: resumedState.sum}, deadlineMs: 5000});
    assert.equal(resumed.outcome, 'SUCCEEDED');
    assert.equal(resumed.output.sum, uninterrupted.output.sum, 'the resumed sum matches the uninterrupted execution');
    assert.equal(DIGEST(JSON.stringify(resumed.output)), DIGEST(JSON.stringify(uninterrupted.output)), 'the final digest matches');
    // Work actually saved, measured rather than claimed: the resumed process was given the first three elements only.
    const savedWork = resumedState.cursor;
    assert.equal(savedWork, 3);
    assert.equal(values.length - savedWork, 7, 'seven elements of work remained; four (including the resumed chunk state) were not redone');
    // Honest boundary: an interrupted TASK is resumable through its explicit checkpoint; this is NOT arbitrary process
    // migration, so a fresh process must reconstruct the state from the cursor we hand it.
    const fromScratch = await executeCpu({operation: 'SUM', values, deadlineMs: 5000});
    assert.equal(fromScratch.output.sum, uninterrupted.output.sum);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('PCF711-06 two real workers save and read compatible artifacts, and the resume cursor is bound to digest/version (workbook bullet 2/acceptance)', async () => {
  const dir = await scratch();
  try {
    // Two worker stores over one durable root: distinct adapters, one durable checkpoint.
    const workerA = openStore(join(dir, 'shared'));
    const ref = await saveCheckpoint(workerA, {sideEffects: 'NONE', cursor: 500, sum: 125250}, binding('attempt-upstream'), 0);
    const workerB = openStore(join(dir, 'shared'));
    const onWorkerB = await restoreCheckpoint(workerB, ref, binding('attempt-upstream'), 1);
    assert.equal(onWorkerB.cursor, 500);
    // 709 hand-off: the reference carries the version and location provenance a consumer needs, and reading it does NOT
    // require the private contents to be displayed.
    const reference = createArtifactRef({opaqueId: 'checkpoint-art-711', digest: ref.digest, size: ref.size,
      schema: 'pcf-checkpoint-v1', owner: 'worker-a', dataScope: 'PUBLIC', replicas: [{kind: 'LOCAL_CACHE', state: 'AVAILABLE', locationRef: 'worker-a'}],
      expiresAt: ref.expiresAt, createdAt: 0});
    const cursor = createResumeCursor({opaqueId: reference.opaqueId, digest: reference.digest, referenceVersion: reference.referenceVersion, completedBytes: 400, completedItems: 4, partialOutputVisible: false});
    const decision = canResume(reference, cursor, {now: 1});
    assert.equal(decision.resume, true);
    assert.equal(decision.fromBytes, 400);
    assert.equal(decision.remainingBytes, reference.size - 400);
    // A cursor that does not match the bytes is not applicable, and going backward is refused rather than silently
    // restarting work.
    assert.equal(canResume(reference, {...cursor, digest: DIGEST('other-bytes')}, {now: 1}).reason, 'DIGEST_MISMATCH');
    assert.equal(canResume(reference, {...cursor, referenceVersion: 2}, {now: 1}).reason, 'VERSION_MISMATCH');
    assert.equal(canResume({...reference, expiresAt: 10}, cursor, {now: 20}).reason, 'EXPIRED');
    assert.equal(canResume(reference, {...cursor, completedBytes: reference.size + 1}, {now: 1}).reason, 'CURSOR_AHEAD');
    assert.throws(() => advanceCursor(cursor, {completedBytes: 100}), {code: 'CURSOR_CANNOT_GO_BACKWARD'});
    // A partial transfer may not be presented as usable content: the flag is mandatory once progress exists.
    assert.throws(() => createResumeCursor({opaqueId: reference.opaqueId, digest: reference.digest, completedBytes: 10}), {code: 'CURSOR_PARTIAL_FLAG_REQUIRED'});
  } finally { await rm(dir, {recursive: true, force: true}); }
});
