/**
 * UTOPIA · City · Project Foreman — the checkpoint / resume / recovery family.
 *
 * These tests are the migration's own covering suite for `recovery-schema`,
 * `checkpoint`, `recovery-store`, `locking`, `mutation`, `repository` and
 * `process-identity`. The donor's own suites are re-run verbatim under
 * `tests/donor/`; what is asserted here is the part a direct level-by-level port
 * cannot demonstrate on its own: the refusal codes of a *mutated* descriptor, the
 * atomicity of a checkpoint write observed mid-flight, retention bounds under a
 * clock that moves backwards, the one-owner claim's prove-stale rule, and the
 * path-safety refusals.
 *
 * Every fixture is a temporary directory under `os.tmpdir()`; nothing here writes
 * to the repository tree and nothing here needs a live harness.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as repository from '../repository.mjs';
import { createMutationLog, hashContent, MUTATION_RESULTS } from '../mutation.mjs';
import { createWorkspaceLock, LOCK_REASONS, DEFAULT_STALE_AFTER_MS } from '../locking.mjs';
import { createProcessOwner, probeProcessOwner, getProcessIdentity } from '../process-identity.mjs';
import { computePlanDigest, validateRecoveryDescriptor } from '../recovery-schema.mjs';
import { createCheckpointStore, verifyResume, CHECKPOINT_VERSION, DEFAULT_MAX_FILES } from '../checkpoint.mjs';
import { createRecoveryStore, RECOVERY_STATES } from '../recovery-store.mjs';

const CLOCK_START = 1_700_000_000_000;

/** A temporary directory under the OS temp root, never the repository tree. */
function tempDir(prefix = 'project-foreman-recovery-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A clock the test drives by hand. */
function clockFrom(start = CLOCK_START) {
  let value = start;
  return {
    now: () => value,
    advance(ms = 60_000) {
      value += ms;
      return value;
    },
    set(next) {
      value = next;
      return value;
    }
  };
}

/** The `.json` files in a directory, sorted; a missing directory is an empty list. */
function jsonFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

/** A minimal contract-shaped plan the descriptor validator accepts. */
function plan(overrides = {}) {
  return {
    version: 1,
    id: 'plan:1:contract',
    goal: 'resume safely',
    intent: 'contract',
    createdAt: CLOCK_START,
    steps: [{ id: 'step-1', kind: 'test', args: ['--test'], source: 'contract' }],
    budget: { maxSteps: 4 },
    reasons: [],
    ...overrides
  };
}

/** A recovery descriptor that validates, ready to be mutated one field at a time. */
function descriptor(overrides = {}) {
  const savedPlan = overrides.plan || plan();
  return {
    version: 1,
    episodeId: 'ep',
    request: {
      workspace: path.resolve(os.tmpdir()),
      goal: savedPlan.goal,
      startedAt: CLOCK_START,
      deadlineAt: CLOCK_START + 86_400_000,
      contract: { maxSteps: 4 }
    },
    plan: savedPlan,
    planDigest: computePlanDigest(savedPlan),
    cursor: { nextStepIndex: 0, lastVerifiedStepId: null, verifiedStepIds: [], skippedStepIds: [], checkpointSeq: 1 },
    fingerprint: { head: 'abc123' },
    verifiedMutationIds: [],
    unresolvedMutationIds: [],
    executorCompatibility: 'engineering-v1',
    workRoot: path.parse(os.tmpdir()).root,
    crossVolumeTemp: [],
    lifecycleState: 'ACTIVE',
    ...overrides
  };
}

/** A valid off-volume registration on a volume other than the work root. */
function crossVolumeEntry(workRoot, overrides = {}) {
  const otherVolume = workRoot.toLowerCase().startsWith('d:') ? 'C:\\ProjectForemanTemp\\ep\\scratch' : 'D:\\ProjectForemanTemp\\ep\\scratch';
  return {
    path: otherVolume,
    canonicalPath: otherVolume,
    episodeId: 'ep',
    workRoot,
    workRootIdentity: `sha256:${'a'.repeat(64)}`,
    type: 'directory',
    purposeClass: 'build',
    createdByEpisode: true,
    registeredAt: CLOCK_START,
    cleanupState: 'ACTIVE',
    markerPath: path.win32.join(otherVolume, '.dshns-episode-owner.json'),
    ...overrides
  };
}

/** Write a checkpoint carrying a valid recovery descriptor through the store. */
function saveRecoveryCheckpoint(checkpoints, episodeId, overrides = {}) {
  const saved = checkpoints.save({ episodeId, recovery: descriptor({ episodeId, ...overrides }) });
  assert.equal(saved.ok, true, saved.reason);
  return saved;
}

// ---------------------------------------------------------------------------
// recovery-schema: the plan digest and every refusal code
// ---------------------------------------------------------------------------

test('the plan digest is a sha256 of the canonical plan and is stable under key order', () => {
  assert.match(computePlanDigest({ b: 2, a: { z: 3, y: 4 } }), /^sha256:[a-f0-9]{64}$/);
  assert.equal(computePlanDigest({ b: 2, a: { z: 3, y: 4 } }), computePlanDigest({ a: { y: 4, z: 3 }, b: 2 }), 'key order must not change the digest');
  assert.equal(computePlanDigest({ a: [1, { z: 1, y: 2 }] }), computePlanDigest({ a: [1, { y: 2, z: 1 }] }), 'nested key order must not change the digest');
  assert.equal(computePlanDigest({ a: 1, b: undefined }), computePlanDigest({ a: 1 }), 'an undefined value is not part of the canonical form');
  assert.equal(computePlanDigest({ a: 1, b: () => {} }), computePlanDigest({ a: 1 }), 'a function is not part of the canonical form');
});

test('the plan digest is sensitive to every part of the plan it covers', () => {
  const base = plan();
  const digest = computePlanDigest(base);
  assert.notEqual(computePlanDigest(plan({ goal: 'a different goal' })), digest);
  assert.notEqual(computePlanDigest(plan({ budget: { maxSteps: 5 } })), digest);
  assert.notEqual(computePlanDigest(plan({ steps: [{ id: 'step-1', kind: 'patch' }] })), digest);
  assert.notEqual(computePlanDigest(plan({ steps: [] })), digest);
  assert.notEqual(computePlanDigest({ ...base, reasons: ['one more reason'] }), digest);
});

test('a valid recovery descriptor returns a deep copy with the lifecycle state defaulted', () => {
  const input = descriptor();
  const result = validateRecoveryDescriptor(input, { episodeId: 'ep' });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.descriptor, { ...input, lifecycleState: 'ACTIVE' });
  assert.notEqual(result.descriptor, input, 'the validated descriptor is a copy, not the caller object');
  assert.notEqual(result.descriptor.plan, input.plan);

  const implicit = descriptor({ lifecycleState: undefined });
  const defaulted = validateRecoveryDescriptor(implicit);
  assert.equal(defaulted.ok, true, defaulted.reason);
  assert.equal(defaulted.descriptor.lifecycleState, 'ACTIVE');
});

test('every structural refusal of the recovery descriptor is a closed code', () => {
  const cases = [
    ['RECOVERY_DESCRIPTOR_INVALID', null],
    ['RECOVERY_DESCRIPTOR_INVALID', ['an array is not a descriptor']],
    ['RECOVERY_VERSION_UNSUPPORTED', descriptor({ version: 99 })],
    ['EPISODE_ID_INVALID', descriptor({ episodeId: '   ' })],
    ['EPISODE_ID_INVALID', descriptor({ episodeId: 'x'.repeat(513) })],
    ['REQUEST_INVALID', descriptor({ request: { ...descriptor().request, workspace: 'relative/path' } })],
    ['REQUEST_INVALID', descriptor({ request: { ...descriptor().request, goal: '  ' } })],
    ['REQUEST_INVALID', descriptor({ request: null })],
    ['REQUEST_DEADLINE_INVALID', descriptor({ request: { ...descriptor().request, deadlineAt: CLOCK_START } })],
    ['PLAN_VERSION_UNSUPPORTED', (() => { const d = descriptor(); d.plan.version = 99; d.planDigest = computePlanDigest(d.plan); return d; })()],
    ['PLAN_INVALID', (() => { const d = descriptor(); d.plan.steps = new Array(1001).fill({ id: 'step-1', kind: 'test' }); d.planDigest = computePlanDigest(d.plan); return d; })()],
    ['PLAN_INVALID', descriptor({ plan: plan({ budget: { maxSteps: 0 } }) })],
    ['PLAN_INVALID', (() => { const d = descriptor(); d.plan = { ...d.plan, reasons: [1] }; d.planDigest = computePlanDigest(d.plan); return d; })()],
    ['PLAN_GOAL_MISMATCH', descriptor({ request: { ...descriptor().request, goal: 'a different goal' } })],
    ['PLAN_STEP_INVALID', descriptor({ plan: plan({ steps: [{ id: 'step-1', kind: 'test' }, { id: 'step-1', kind: 'test' }] }) })],
    ['PLAN_STEP_INVALID', descriptor({ plan: plan({ steps: [{ id: 'step 1', kind: 'test' }] }) })],
    ['PLAN_DIGEST_MISMATCH', descriptor({ planDigest: `sha256:${'b'.repeat(64)}` })],
    ['CURSOR_INVALID', descriptor({ cursor: { nextStepIndex: 0, lastVerifiedStepId: null, verifiedStepIds: [], skippedStepIds: [], checkpointSeq: 0 } })],
    ['CURSOR_INVALID', descriptor({ cursor: { nextStepIndex: 0, lastVerifiedStepId: null, verifiedStepIds: [], skippedStepIds: [] } })],
    ['CURSOR_INVALID', descriptor({ cursor: { nextStepIndex: 0, lastVerifiedStepId: null, verifiedStepIds: ['unknown-step'], skippedStepIds: [], checkpointSeq: 1 } })],
    ['CURSOR_INVALID', descriptor({ cursor: { nextStepIndex: 0, lastVerifiedStepId: null, verifiedStepIds: ['step-1', 'step-1'], skippedStepIds: [], checkpointSeq: 1 } })],
    ['CURSOR_UNVERIFIED', descriptor({ cursor: { nextStepIndex: 1, lastVerifiedStepId: null, verifiedStepIds: [], skippedStepIds: [], checkpointSeq: 1 } })],
    ['FINGERPRINT_INVALID', descriptor({ fingerprint: 'not-an-object' })],
    ['MUTATION_IDS_INVALID', descriptor({ verifiedMutationIds: 'm1' })],
    ['MUTATION_IDS_INVALID', descriptor({ unresolvedMutationIds: [''] })],
    ['MUTATION_IDS_INVALID', descriptor({ verifiedMutationIds: ['m1', 'm1'] })],
    ['MUTATION_IDS_INVALID', descriptor({ verifiedMutationIds: ['m1'], unresolvedMutationIds: ['m1'] })],
    ['EXECUTOR_COMPATIBILITY_INVALID', descriptor({ executorCompatibility: '   ' })],
    ['WORK_ROOT_INVALID', descriptor({ workRoot: 'not/absolute' })],
    ['CROSS_VOLUME_REGISTRY_INVALID', descriptor({ crossVolumeTemp: 'not-an-array' })],
    ['LIFECYCLE_STATE_UNSUPPORTED', descriptor({ lifecycleState: 'RESUMING' })],
    ['LIFECYCLE_STATE_UNSUPPORTED', descriptor({ lifecycleState: null })],
    ['BLOCKED_REASON_INVALID', descriptor({ lifecycleState: 'RECOVERY_BLOCKED', blockedReason: 7 })],
    ['REPAIR_AUTHORIZATION_INVALID', descriptor({ repairAuthorized: 'yes' })],
  ];
  for (const [code, input] of cases) {
    const result = validateRecoveryDescriptor(input);
    assert.equal(result.ok, false, `expected a refusal for ${code}`);
    assert.equal(result.code, code, `got ${result.code} (${result.reason})`);
    assert.equal(typeof result.reason, 'string');
    assert.notEqual(result.reason, '');
  }
});

test('the cursor must sit exactly after its contiguous verified or optional-skipped prefix', () => {
  const steps = [{ id: 'a', kind: 'test' }, { id: 'b', kind: 'test', optional: true }, { id: 'c', kind: 'test' }];

  const optionalSkipped = { nextStepIndex: 2, lastVerifiedStepId: 'a', verifiedStepIds: ['a'], skippedStepIds: ['b'], checkpointSeq: 1 };
  assert.equal(validateRecoveryDescriptor(descriptor({ plan: plan({ steps }), cursor: optionalSkipped })).ok, true);

  const skippedRequired = { nextStepIndex: 2, lastVerifiedStepId: 'a', verifiedStepIds: ['a'], skippedStepIds: ['c'], checkpointSeq: 1 };
  assert.equal(validateRecoveryDescriptor(descriptor({ plan: plan({ steps }), cursor: skippedRequired })).code, 'CURSOR_INVALID');

  const bothVerifiedAndSkipped = { nextStepIndex: 1, lastVerifiedStepId: 'a', verifiedStepIds: ['a'], skippedStepIds: ['a'], checkpointSeq: 1 };
  assert.equal(validateRecoveryDescriptor(descriptor({ plan: plan({ steps }), cursor: bothVerifiedAndSkipped })).code, 'CURSOR_INVALID');

  const wrongLastVerified = { nextStepIndex: 2, lastVerifiedStepId: 'c', verifiedStepIds: ['a', 'b'], skippedStepIds: [], checkpointSeq: 1 };
  assert.equal(validateRecoveryDescriptor(descriptor({ plan: plan({ steps }), cursor: wrongLastVerified })).code, 'CURSOR_INVALID');
});

test('the descriptor episode id must match the checkpoint that carries it, and the executor must match the run', () => {
  const mismatch = validateRecoveryDescriptor(descriptor({ episodeId: 'ep' }), { episodeId: 'other' });
  assert.equal(mismatch.code, 'EPISODE_ID_MISMATCH');

  const executor = validateRecoveryDescriptor(descriptor({ executorCompatibility: 'engineering-v999' }), { executorCompatibility: 'engineering-v1' });
  assert.equal(executor.code, 'EXECUTOR_COMPATIBILITY_MISMATCH');
  assert.equal(validateRecoveryDescriptor(descriptor()).ok, true, 'no requested executor means no mismatch check');
});

test('the cleanup terminal state is only legal on an active or cleanup-blocked episode', () => {
  assert.equal(validateRecoveryDescriptor(descriptor({ cleanupTerminalState: 'CANCELLED' })).ok, true);
  assert.equal(validateRecoveryDescriptor(descriptor({ lifecycleState: 'RECOVERY_BLOCKED', cleanupTerminalState: 'COMPLETED' })).ok, true);
  assert.equal(validateRecoveryDescriptor(descriptor({ cleanupTerminalState: 'DELETED' })).code, 'CLEANUP_TERMINAL_STATE_INVALID');
  assert.equal(validateRecoveryDescriptor(descriptor({ lifecycleState: 'COMPLETED', cleanupTerminalState: 'COMPLETED' })).code, 'CLEANUP_TERMINAL_STATE_INVALID');
});

test('cross-volume registrations are bound to the episode, work volume, type, state and unique canonical path', () => {
  const workRoot = path.parse(os.tmpdir()).root;
  const entry = crossVolumeEntry(workRoot);

  assert.equal(validateRecoveryDescriptor(descriptor({ workRoot, crossVolumeTemp: [entry] })).ok, true);

  const refusals = [
    crossVolumeEntry(workRoot, { episodeId: 'other' }),
    crossVolumeEntry(workRoot, { workRoot: path.join(workRoot, 'elsewhere') }),
    crossVolumeEntry(workRoot, { workRootIdentity: 'not-a-digest' }),
    crossVolumeEntry(workRoot, { type: 'symlink' }),
    crossVolumeEntry(workRoot, { purposeClass: 'invented' }),
    crossVolumeEntry(workRoot, { createdByEpisode: false }),
    crossVolumeEntry(workRoot, { registeredAt: -1 }),
    crossVolumeEntry(workRoot, { cleanupState: 'INVENTED' }),
    crossVolumeEntry(workRoot, { path: path.win32.join(workRoot, 'scratch') }),
    crossVolumeEntry(workRoot, { canonicalPath: 'C:\\somewhere\\else' }),
    crossVolumeEntry(workRoot, { markerPath: 'C:\\somewhere\\else\\.dshns-episode-owner.json' }),
    crossVolumeEntry(workRoot, { cleanupReason: 5 }),
  ];
  for (const invalid of refusals) {
    const result = validateRecoveryDescriptor(descriptor({ workRoot, crossVolumeTemp: [invalid] }));
    assert.equal(result.code, 'CROSS_VOLUME_REGISTRY_INVALID', JSON.stringify(invalid));
  }

  const fileEntry = crossVolumeEntry(workRoot, { type: 'file', markerPath: undefined, contentDigest: `sha256:${'c'.repeat(64)}` });
  assert.equal(validateRecoveryDescriptor(descriptor({ workRoot, crossVolumeTemp: [fileEntry] })).ok, true);
  assert.equal(validateRecoveryDescriptor(descriptor({ workRoot, crossVolumeTemp: [crossVolumeEntry(workRoot, { type: 'file', markerPath: undefined })] })).code, 'CROSS_VOLUME_REGISTRY_INVALID');
  assert.equal(validateRecoveryDescriptor(descriptor({ workRoot, crossVolumeTemp: [{ ...fileEntry, markerPath: 'C:\\somewhere\\else\\.dshns-episode-owner.json' }] })).code, 'CROSS_VOLUME_REGISTRY_INVALID');

  const duplicated = [crossVolumeEntry(workRoot), crossVolumeEntry(workRoot, { canonicalPath: entry.path })];
  assert.equal(validateRecoveryDescriptor(descriptor({ workRoot, crossVolumeTemp: duplicated })).code, 'CROSS_VOLUME_REGISTRY_INVALID');

  const crowded = new Array(1001).fill(crossVolumeEntry(workRoot));
  assert.equal(validateRecoveryDescriptor(descriptor({ workRoot, crossVolumeTemp: crowded })).code, 'CROSS_VOLUME_REGISTRY_INVALID');
});

// ---------------------------------------------------------------------------
// checkpoint: atomic write, read defensively, retention, resume gate
// ---------------------------------------------------------------------------

test('a checkpoint is written whole or not at all, and a killed writer leaves nothing readable', () => {
  const dir = tempDir();
  const clock = clockFrom();
  try {
    const store = createCheckpointStore({ dir, now: clock.now });
    const saved = store.save({ episodeId: 'ep', cursor: { step: 1 }, goal: 'g', workspace: 'D:\\work' });
    assert.equal(saved.ok, true, saved.reason);
    assert.equal(saved.path.startsWith(dir), true);
    assert.equal(fs.statSync(saved.path).size, saved.bytes);
    assert.equal(JSON.parse(fs.readFileSync(saved.path, 'utf8')).version, CHECKPOINT_VERSION);
    assert.deepEqual(jsonFiles(dir).filter((name) => name.includes('.tmp')), [], 'the temporary file was renamed away');

    // The shape a process killed mid-write leaves behind: a valid payload under a
    // name that was never renamed into place.
    clock.advance();
    const ghost = path.join(dir, `ep.${String(clock.now()).padStart(16, '0')}-000001.json.tmp-4242`);
    fs.writeFileSync(ghost, JSON.stringify({ version: CHECKPOINT_VERSION, episodeId: 'ep', cursor: { step: 'ghost' } }), 'utf8');
    assert.equal(store.latest('ep').cursor.step, 1);
    assert.equal(store.list('ep').length, 1, 'a temporary file is never listed as a checkpoint');

    // A renamed-in file that is truncated on disk is corrupt, not partial state.
    fs.writeFileSync(saved.path, '{ "cursor": { "step": "thr', 'utf8');
    assert.equal(store.latest('ep'), null, 'a single corrupt checkpoint reads as no checkpoint');
    assert.equal(store.list('ep').length, 1, 'list() is still a filesystem view');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the default checkpoint directory hangs off the root option and keeps five files', () => {
  const root = tempDir();
  try {
    const store = createCheckpointStore({ root });
    assert.equal(store.root, path.resolve(root));
    assert.equal(store.dir, path.join(root, 'runtime', 'engineering', 'checkpoints'));
    assert.equal(store.maxFiles, DEFAULT_MAX_FILES);
    assert.equal(DEFAULT_MAX_FILES, 5);
    assert.equal(store.latest('anything'), null);
    assert.deepEqual(store.list('anything'), []);
    assert.deepEqual(store.prune('anything'), { removed: 0, files: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retention keeps the newest recovery sequences per episode and prune is idempotent', () => {
  const dir = tempDir();
  const clock = clockFrom();
  try {
    const writer = createCheckpointStore({ dir, now: clock.now, maxFiles: 10 });
    for (let index = 0; index < 7; index += 1) {
      saveRecoveryCheckpoint(writer, 'ep');
      clock.advance();
    }
    saveRecoveryCheckpoint(writer, 'other');
    assert.equal(jsonFiles(dir).length, 8);

    const bounded = createCheckpointStore({ dir, now: clock.now, maxFiles: 3 });
    assert.equal(bounded.prune('ep').removed, 4);
    assert.equal(jsonFiles(dir).filter((name) => name.startsWith('other.')).length, 1, 'the other episode keeps its checkpoint');
    assert.equal(bounded.list('ep').length, 3);
    assert.deepEqual(bounded.prune('ep'), { removed: 0, files: [] }, 'prune is idempotent');
    assert.equal(bounded.latest('ep').recovery.cursor.checkpointSeq, 7, 'the newest sequence survives retention');
    assert.equal(bounded.latest('other').recovery.cursor.checkpointSeq, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the newest recovery sequence wins even after the wall clock moves backwards', () => {
  const dir = tempDir();
  const clock = clockFrom();
  try {
    const store = createCheckpointStore({ dir, now: clock.now, maxFiles: 2 });
    saveRecoveryCheckpoint(store, 'ep');
    clock.advance(1_000);
    saveRecoveryCheckpoint(store, 'ep');
    clock.advance(-10_000);
    const newest = saveRecoveryCheckpoint(store, 'ep');

    assert.equal(store.latest('ep').recovery.cursor.checkpointSeq, 3);
    assert.equal(store.list('ep').some((entry) => entry.path === newest.path), true, 'the newest write is the one retained');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a checkpoint write refuses a descriptor that fails validation and stays off disk', () => {
  const dir = tempDir();
  try {
    const store = createCheckpointStore({ dir, now: () => CLOCK_START });
    const broken = descriptor();
    broken.plan.steps[0].kind = 'patch';
    const refused = store.save({ episodeId: 'ep', recovery: broken });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'PLAN_DIGEST_MISMATCH');
    assert.equal(refused.path, null);
    assert.deepEqual(jsonFiles(dir), [], 'an invalid descriptor never becomes durable execution truth');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a checkpoint round-trips through disk and remove() clears one episode only', () => {
  const dir = tempDir();
  const clock = clockFrom();
  try {
    const store = createCheckpointStore({ dir, now: clock.now, maxFiles: 10 });
    const saved = store.save({
      episodeId: 'episode 1/with spaces',
      goal: 'green the suite',
      workspace: 'D:\\work\\repo',
      phase: 'REPAIRING',
      recovery: descriptor({ episodeId: 'episode 1/with spaces' })
    });
    assert.equal(saved.ok, true, saved.reason);

    const read = store.latest('episode 1/with spaces');
    assert.equal(read.version, CHECKPOINT_VERSION);
    assert.equal(read.episodeId, 'episode 1/with spaces');
    assert.equal(read.phase, 'REPAIRING');
    assert.equal(read.recovery.cursor.checkpointSeq, 1);
    assert.equal(store.latest('episode_1_with_spaces').recovery.cursor.checkpointSeq, 1, 'the file-name spelling finds the same episode');

    store.save({ episodeId: 'survivor', recovery: descriptor({ episodeId: 'survivor' }) });
    clock.advance();
    store.save({ episodeId: 'episode 1/with spaces', recovery: descriptor({ episodeId: 'episode 1/with spaces' }) });
    const removed = store.remove('episode 1/with spaces');
    assert.equal(removed.removed, 2);
    assert.deepEqual(store.remove('episode 1/with spaces'), { removed: 0, files: [] }, 'removing twice removes nothing');
    assert.equal(store.latest('episode 1/with spaces'), null);
    assert.equal(store.latest('survivor').recovery.cursor.checkpointSeq, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyResume is a read-only gate: it resumes, restarts or refuses and changes nothing', () => {
  const workspace = tempDir('pf-workspace-');
  const dir = tempDir('pf-checkpoints-');
  try {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'unchanged', 'utf8');
    const store = createCheckpointStore({ dir, now: () => CLOCK_START });
    const saved = store.save({
      episodeId: 'inspect',
      workspace,
      fingerprint: repository.fingerprint({ root: workspace }),
      plan: [{ id: 's1' }],
      cursor: { step: 's1' },
      ownedProcesses: []
    });
    assert.equal(saved.ok, true, saved.reason);
    const checkpoint = store.latest('inspect');
    const before = {
      content: fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'),
      checkpoint: fs.readFileSync(saved.path, 'utf8'),
      files: jsonFiles(dir),
      workspace: fs.readdirSync(workspace).sort()
    };

    const resumed = verifyResume({ checkpoint, workspace, fingerprint: repository.fingerprint({ root: workspace }) });
    assert.equal(resumed.action, 'resume');
    assert.equal(resumed.ok, true);
    assert.equal(resumed.staleMutation, null);

    const restarted = verifyResume({ checkpoint, workspace, fingerprint: { ...checkpoint.fingerprint, head: 'ffffffff' }, gitState: { head: 'ffffffff' } });
    assert.equal(restarted.action, 'restart');
    assert.equal(restarted.ok, false);
    assert.equal(restarted.drift.drifted, true);
    assert.equal(restarted.reasons.some((reason) => reason.includes('HEAD moved')), true);

    const refused = verifyResume({ checkpoint, workspace: path.join(workspace, 'gone'), fingerprint: checkpoint.fingerprint });
    assert.equal(refused.action, 'refuse');
    assert.equal(refused.reasons.some((reason) => reason.includes('not usable')), true);

    assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), before.content);
    assert.equal(fs.readFileSync(saved.path, 'utf8'), before.checkpoint);
    assert.deepEqual(jsonFiles(dir), before.files);
    assert.deepEqual(fs.readdirSync(workspace).sort(), before.workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyResume distinguishes a working tree that moved from a plan that no longer means anything', () => {
  const workspace = tempDir('pf-workspace-');
  try {
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'before' }), 'utf8');
    const cleanState = { branch: 'main', head: 'abc', detached: false, modified: [], staged: [], untracked: [], conflicted: [], remotes: [] };
    const checkpoint = {
      version: CHECKPOINT_VERSION,
      episodeId: 'ep',
      workspace,
      fingerprint: repository.fingerprint({ root: workspace, gitState: cleanState }),
      verifiedMutations: [],
      ownedProcesses: []
    };

    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'after' }), 'utf8');
    const drifted = verifyResume({ checkpoint, workspace, fingerprint: repository.fingerprint({ root: workspace, gitState: cleanState }) });
    assert.equal(drifted.action, 'restart');
    assert.equal(drifted.reasons.some((reason) => reason.includes('manifest')), true);

    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'before' }), 'utf8');
    const dirtyState = { branch: 'main', head: 'abc', detached: false, modified: ['tracked.txt'], staged: [], untracked: ['new.txt'], conflicted: [], remotes: [] };
    fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'the user edited this', 'utf8');
    const dirty = verifyResume({ checkpoint, workspace, fingerprint: repository.fingerprint({ root: workspace, gitState: dirtyState }) });
    assert.equal(dirty.action, 'resume', 'a changed working tree is what the episode was for');
    assert.deepEqual(dirty.reasons, ['the working tree changed: the working tree changed'], 'drift in the tree is reported, but it is not a restart');
    assert.equal(dirty.drift.drifted, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('verifyResume re-checks unsettled mutations against disk and never replays them', () => {
  const workspace = tempDir('pf-workspace-');
  try {
    const appliedPath = path.join(workspace, 'applied.txt');
    fs.writeFileSync(appliedPath, 'the repaired content', 'utf8');
    const alreadyComplete = {
      id: 'm1',
      kind: 'write',
      path: appliedPath,
      result: 'pending',
      before: null,
      intended: { bytes: Buffer.byteLength('the repaired content'), hash: hashContent(Buffer.from('the repaired content')) }
    };
    const conflictedPath = path.join(workspace, 'conflicted.txt');
    fs.writeFileSync(conflictedPath, 'somebody else wrote this', 'utf8');
    const stale = {
      id: 'm2',
      kind: 'write',
      path: conflictedPath,
      result: 'pending',
      before: hashContent(Buffer.from('what the file held before')),
      intended: { bytes: 8, hash: hashContent(Buffer.from('intended')) }
    };
    const log = createMutationLog({ now: () => CLOCK_START });
    const base = { version: CHECKPOINT_VERSION, episodeId: 'ep', workspace, fingerprint: repository.fingerprint({ root: workspace }), ownedProcesses: [] };

    const complete = verifyResume({ checkpoint: { ...base, verifiedMutations: [alreadyComplete] }, workspace, mutationLog: log });
    assert.equal(complete.action, 'resume');
    assert.equal(complete.mutations[0].verdict, 'already_complete');
    assert.equal(complete.staleMutation, null);

    const conflict = verifyResume({ checkpoint: { ...base, verifiedMutations: [stale] }, workspace, mutationLog: log });
    assert.equal(conflict.action, 'restart');
    assert.equal(conflict.staleMutation.id, 'm2');
    assert.equal(conflict.mutations[0].verdict, 'failed');

    const unverifiable = verifyResume({ checkpoint: { ...base, verifiedMutations: [stale] }, workspace });
    assert.equal(unverifiable.action, 'restart');
    assert.equal(unverifiable.reasons.some((reason) => reason.includes('cannot be re-checked')), true);

    assert.equal(fs.readFileSync(conflictedPath, 'utf8'), 'somebody else wrote this', 'the gate never wrote over the conflicting file');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('verifyResume reports missing owned processes and never turns "cannot tell" into a restart', () => {
  const workspace = tempDir('pf-workspace-');
  try {
    const checkpoint = {
      version: CHECKPOINT_VERSION,
      episodeId: 'ep',
      workspace,
      fingerprint: repository.fingerprint({ root: workspace }),
      verifiedMutations: [],
      ownedProcesses: [
        { id: 'p-live', pid: 4242, command: 'npm test', status: 'running' },
        { id: 'p-gone', pid: 4343, command: 'npm test', status: 'running' },
        { id: 'p-settled', pid: 4444, command: 'npm test', status: 'exited' }
      ]
    };
    const verdict = verifyResume({ checkpoint, workspace, processes: [{ id: 'p-live', pid: 4242 }] });
    assert.equal(verdict.action, 'resume');
    assert.deepEqual(verdict.missingProcesses.map((entry) => entry.id), ['p-gone']);

    const unobserved = verifyResume({ checkpoint, workspace });
    assert.equal(unobserved.action, 'resume');
    assert.deepEqual(unobserved.missingProcesses, []);
    assert.equal(unobserved.reasons.some((reason) => reason.includes('not re-checked')), true);

    const noCheckpoint = verifyResume({ checkpoint: null, workspace });
    assert.equal(noCheckpoint.action, 'restart');
    assert.deepEqual(noCheckpoint.reasons, ['there is no readable checkpoint to resume from']);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// recovery-store: the durable index, retention/regression rules and claims
// ---------------------------------------------------------------------------

test('the recovery index records a checkpoint, refuses regression and refuses a duplicate sequence', () => {
  const root = tempDir();
  const checkpointDir = path.join(root, 'checkpoints');
  try {
    const clock = clockFrom();
    const checkpoints = createCheckpointStore({ dir: checkpointDir, now: clock.now });
    const first = saveRecoveryCheckpoint(checkpoints, 'ep');
    const store = createRecoveryStore({ root, checkpointDir, now: clock.now });

    const recorded = store.recordCheckpoint({ episodeId: 'ep', checkpointPath: first.path });
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    assert.equal(recorded.entry.state, RECOVERY_STATES.ACTIVE);
    assert.equal(recorded.entry.latestCheckpointSeq, 1);
    assert.equal(recorded.entry.latestCheckpointFile, path.basename(first.path));
    assert.equal(recorded.entry.cleanupDebtSummary.total, 0);
    assert.equal(JSON.parse(fs.readFileSync(store.indexFile, 'utf8')).version, 1);

    clock.advance();
    const second = saveRecoveryCheckpoint(checkpoints, 'ep');
    assert.equal(store.recordCheckpoint({ episodeId: 'ep', checkpointPath: second.path }).entry.latestCheckpointSeq, 2);
    const regression = store.recordCheckpoint({ episodeId: 'ep', checkpointPath: first.path });
    assert.equal(regression.code, 'CHECKPOINT_SEQUENCE_REGRESSION');
    assert.equal(store.get('ep').latestCheckpointSeq, 2, 'a refusal never moves the index backwards');

    const copy = path.join(checkpointDir, 'alternate-copy.json');
    fs.copyFileSync(second.path, copy);
    const conflict = store.recordCheckpoint({ episodeId: 'ep', checkpointPath: copy });
    assert.equal(conflict.code, 'CHECKPOINT_SEQUENCE_CONFLICT');
    assert.equal(store.get('ep').latestCheckpointFile, path.basename(second.path));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the recovery index refuses a missing, foreign, symlinked or incompatible checkpoint', () => {
  const root = tempDir();
  const checkpointDir = path.join(root, 'checkpoints');
  try {
    const checkpoints = createCheckpointStore({ dir: checkpointDir, now: () => CLOCK_START });
    const saved = saveRecoveryCheckpoint(checkpoints, 'ep');
    const store = createRecoveryStore({ root, checkpointDir });

    const missing = store.recordCheckpoint({ episodeId: 'ep', checkpointPath: path.join(checkpointDir, 'missing.json') });
    assert.equal(missing.code, 'CHECKPOINT_MISSING');

    const outside = path.join(root, 'foreign.json');
    fs.writeFileSync(outside, JSON.stringify({ version: 2, episodeId: 'ep', recovery: descriptor() }), 'utf8');
    assert.equal(store.recordCheckpoint({ episodeId: 'ep', checkpointPath: outside }).code, 'CHECKPOINT_OUTSIDE_ROOT');

    const wrongEpisode = store.recordCheckpoint({ episodeId: 'other', checkpointPath: saved.path });
    assert.equal(wrongEpisode.code, 'CHECKPOINT_INVALID');

    const notJson = path.join(checkpointDir, 'garbage.json');
    fs.writeFileSync(notJson, 'not json at all', 'utf8');
    assert.equal(store.recordCheckpoint({ episodeId: 'ep', checkpointPath: notJson }).code, 'CHECKPOINT_INVALID');

    const wrongVersion = path.join(checkpointDir, 'v1.json');
    fs.writeFileSync(wrongVersion, JSON.stringify({ version: 1, episodeId: 'ep', recovery: descriptor() }), 'utf8');
    assert.equal(store.recordCheckpoint({ episodeId: 'ep', checkpointPath: wrongVersion }).code, 'CHECKPOINT_INVALID');

    assert.equal(store.recordCheckpoint({ episodeId: '  ', checkpointPath: saved.path }).code, 'EPISODE_REQUIRED');
    assert.equal(store.recordCheckpoint({ episodeId: 'ep' }).code, 'CHECKPOINT_REQUIRED');
    assert.equal(fs.existsSync(store.indexFile), false, 'every rejection left the durable index untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a path-safety refusal needs no live index, and a symlinked checkpoint is refused', (t) => {
  const root = tempDir();
  const checkpointDir = path.join(root, 'checkpoints');
  try {
    fs.mkdirSync(checkpointDir, { recursive: true });
    const real = path.join(root, 'real.json');
    fs.writeFileSync(real, JSON.stringify({ version: 2, episodeId: 'ep', recovery: descriptor() }), 'utf8');
    const link = path.join(checkpointDir, 'link.json');
    try {
      fs.symlinkSync(real, link);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip(`symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const store = createRecoveryStore({ root, checkpointDir });
    const linked = store.recordCheckpoint({ episodeId: 'ep', checkpointPath: link });
    assert.equal(linked.ok, false);
    assert.equal(['CHECKPOINT_SYMLINK', 'CHECKPOINT_OUTSIDE_ROOT'].includes(linked.code), true, `got ${linked.code}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reconcileIndex rebuilds the index, blocks duplicates and keeps a valid descriptor diagnostic', () => {
  const root = tempDir();
  const checkpointDir = path.join(root, 'checkpoints');
  try {
    const clock = clockFrom();
    const checkpoints = createCheckpointStore({ dir: checkpointDir, now: clock.now });
    const first = saveRecoveryCheckpoint(checkpoints, 'ep');
    clock.advance();
    const second = saveRecoveryCheckpoint(checkpoints, 'ep');
    const store = createRecoveryStore({ root, checkpointDir, now: clock.now });

    const repaired = store.reconcileIndex();
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.equal(repaired.repairedEpisodes, 1);
    assert.equal(repaired.entries[0].latestCheckpointSeq, 2);
    assert.equal(repaired.entries[0].latestCheckpointFile, path.basename(second.path));

    // A parseable newest checkpoint whose plan was edited after the fact blocks.
    const tampered = JSON.parse(fs.readFileSync(second.path, 'utf8'));
    tampered.recovery.plan.steps[0].kind = 'patch';
    fs.writeFileSync(second.path, JSON.stringify(tampered), 'utf8');
    assert.equal(store.reconcileIndex().ok, true);
    assert.equal(store.get('ep').state, RECOVERY_STATES.RECOVERY_BLOCKED);
    assert.equal(store.get('ep').latestCheckpointSeq, 2, 'a blocked episode still reports the sequence it blocked on');
    assert.match(store.get('ep').blockedReason, /PLAN_DIGEST_MISMATCH/);

    // A corrupt index is reconstructed rather than fatal.
    fs.writeFileSync(store.indexFile, '{corrupt', 'utf8');
    assert.equal(store.reconcileIndex().ok, true);
    assert.equal(store.get('ep').latestCheckpointSeq, 2);
    assert.equal(fs.existsSync(first.path), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reconcileIndex blocks duplicate files claiming one sequence and preserves terminal states', () => {
  const root = tempDir();
  const checkpointDir = path.join(root, 'checkpoints');
  try {
    const checkpoints = createCheckpointStore({ dir: checkpointDir, now: () => CLOCK_START });
    const saved = saveRecoveryCheckpoint(checkpoints, 'ep');
    fs.copyFileSync(saved.path, path.join(checkpointDir, 'duplicate.json'));
    const store = createRecoveryStore({ root, checkpointDir });

    assert.equal(store.reconcileIndex().ok, true);
    assert.equal(store.get('ep').state, RECOVERY_STATES.RECOVERY_BLOCKED);
    assert.match(store.get('ep').blockedReason, /duplicate.*sequence/i);
    assert.equal(store.acquireClaim({ episodeId: 'ep', checkpointSeq: 1, owner: { instanceId: 'new', pid: 55, processIdentity: 'start-new' } }).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const doneRoot = tempDir();
  const doneCheckpointDir = path.join(doneRoot, 'checkpoints');
  try {
    const checkpoints = createCheckpointStore({ dir: doneCheckpointDir, now: () => CLOCK_START });
    const saved = saveRecoveryCheckpoint(checkpoints, 'done', { lifecycleState: 'COMPLETED' });
    const store = createRecoveryStore({ root: doneRoot, checkpointDir: doneCheckpointDir });
    assert.equal(store.recordCheckpoint({ episodeId: 'done', checkpointPath: saved.path }).ok, true);
    fs.writeFileSync(saved.path, '{corrupt', 'utf8');
    assert.equal(store.reconcileIndex().ok, true);
    assert.equal(store.get('done').state, 'COMPLETED', 'a terminal episode stays terminal when its checkpoint goes bad');
    assert.equal(store.beginRecoveryAttempt({ episodeId: 'done' }).code, 'EPISODE_NOT_RESUMABLE');
  } finally {
    fs.rmSync(doneRoot, { recursive: true, force: true });
  }
});

test('a terminal episode cannot be re-activated by a checkpoint write, and only a repair-authorized newer checkpoint clears a block', () => {
  const root = tempDir();
  const checkpointDir = path.join(root, 'checkpoints');
  try {
    const clock = clockFrom();
    const checkpoints = createCheckpointStore({ dir: checkpointDir, now: clock.now });
    const store = createRecoveryStore({ root, checkpointDir, now: clock.now });

    const blocked = saveRecoveryCheckpoint(checkpoints, 'ep', { lifecycleState: 'RECOVERY_BLOCKED', blockedReason: 'operator repair required' });
    assert.equal(store.recordCheckpoint({ episodeId: 'ep', checkpointPath: blocked.path }).ok, true);
    assert.equal(store.get('ep').state, RECOVERY_STATES.RECOVERY_BLOCKED);
    assert.equal(store.get('ep').blockedReason, 'operator repair required');

    clock.advance();
    const stillBlocked = saveRecoveryCheckpoint(checkpoints, 'ep');
    const refused = store.recordCheckpoint({ episodeId: 'ep', checkpointPath: stillBlocked.path });
    assert.equal(refused.code, 'BLOCKED_EPISODE_REQUIRES_REPAIR');

    clock.advance();
    const repairedCheckpoint = saveRecoveryCheckpoint(checkpoints, 'ep', { repairAuthorized: true });
    assert.equal(store.recordCheckpoint({ episodeId: 'ep', checkpointPath: repairedCheckpoint.path }).entry.state, RECOVERY_STATES.ACTIVE);
    assert.equal(store.get('ep').latestCheckpointSeq, 3);

    clock.advance();
    const cancelled = saveRecoveryCheckpoint(checkpoints, 'ep', { lifecycleState: 'CANCELLED' });
    assert.equal(store.recordCheckpoint({ episodeId: 'ep', checkpointPath: cancelled.path }).entry.state, 'CANCELLED');
    assert.equal(store.recordCheckpoint({ episodeId: 'ep', checkpointPath: repairedCheckpoint.path }).code, 'EPISODE_TERMINAL');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('automatic recovery attempts are bounded and exhausted attempts persist the block', () => {
  const root = tempDir();
  const checkpointDir = path.join(root, 'checkpoints');
  try {
    const checkpoints = createCheckpointStore({ dir: checkpointDir, now: () => CLOCK_START });
    const saved = saveRecoveryCheckpoint(checkpoints, 'ep');
    const store = createRecoveryStore({ root, checkpointDir, now: () => CLOCK_START });
    assert.equal(store.recordCheckpoint({ episodeId: 'ep', checkpointPath: saved.path }).ok, true);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const started = store.beginRecoveryAttempt({ episodeId: 'ep', maxAttempts: 3 });
      assert.equal(started.ok, true, JSON.stringify(started));
      assert.equal(started.entry.recoveryAttempts, attempt);
    }
    const exhausted = store.beginRecoveryAttempt({ episodeId: 'ep', maxAttempts: 3 });
    assert.equal(exhausted.ok, false);
    assert.equal(exhausted.code, 'RECOVERY_ATTEMPTS_EXHAUSTED');
    assert.equal(store.get('ep').state, RECOVERY_STATES.RECOVERY_BLOCKED);
    assert.match(store.get('ep').blockedReason, /3 consecutive/);

    assert.equal(store.beginRecoveryAttempt({ episodeId: 'unknown-episode' }).code, 'EPISODE_NOT_RESUMABLE');
    assert.equal(store.blockEpisode({ episodeId: 'unknown-episode' }).code, 'EPISODE_NOT_FOUND');
    assert.equal(store.blockEpisode({ episodeId: '' }).code, 'EPISODE_REQUIRED');
    assert.equal(store.get(''), null);
    assert.equal(store.get(null), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a live owner blocks a second claim, and a stale owner is replaced only with identity proof', () => {
  const root = tempDir();
  const checkpointDir = path.join(root, 'checkpoints');
  const ownerA = { instanceId: 'runtime-a', pid: 3101, processIdentity: 'start-a' };
  const ownerB = { instanceId: 'runtime-b', pid: 3102, processIdentity: 'start-b' };
  try {
    const checkpoints = createCheckpointStore({ dir: checkpointDir, now: () => CLOCK_START });
    const saved = saveRecoveryCheckpoint(checkpoints, 'ep');
    const first = createRecoveryStore({ root, checkpointDir, isOwnerAlive: (owner) => owner.instanceId === 'runtime-a' });
    assert.equal(first.recordCheckpoint({ episodeId: 'ep', checkpointPath: saved.path }).ok, true);

    const invalid = first.acquireClaim({ episodeId: 'ep', checkpointSeq: 1, owner: { instanceId: 'x', pid: 1 } });
    assert.equal(invalid.code, 'CLAIM_OWNER_INVALID');
    assert.equal(first.acquireClaim({ episodeId: 'ep', checkpointSeq: 0, owner: ownerA }).code, 'CHECKPOINT_SEQUENCE_INVALID');
    assert.equal(first.acquireClaim({ episodeId: 'ep', checkpointSeq: 2, owner: ownerA }).code, 'CHECKPOINT_NOT_CURRENT');

    assert.equal(first.acquireClaim({ episodeId: 'ep', checkpointSeq: 1, owner: ownerA }).ok, true);
    assert.equal(first.get('ep').ownerInstanceId, 'runtime-a');

    let probes = 0;
    const second = createRecoveryStore({ root, checkpointDir, isOwnerAlive: (owner) => { probes += 1; return owner.instanceId === 'runtime-a'; } });
    const blocked = second.acquireClaim({ episodeId: 'ep', checkpointSeq: 1, owner: ownerB });
    assert.equal(blocked.code, 'CLAIM_ALREADY_OWNED');
    assert.equal(blocked.ownerInstanceId, 'runtime-a');
    assert.equal(probes, 1, 'one classification uses one identity observation');
    assert.equal(second.releaseClaim({ episodeId: 'ep', owner: ownerB }).code, 'CLAIM_NOT_OWNED');

    const noProbe = createRecoveryStore({ root, checkpointDir });
    assert.equal(noProbe.acquireClaim({ episodeId: 'ep', checkpointSeq: 1, owner: ownerB }).code, 'CLAIM_OWNER_UNKNOWN');

    const unknown = createRecoveryStore({ root, checkpointDir, isOwnerAlive: () => null });
    assert.equal(unknown.acquireClaim({ episodeId: 'ep', checkpointSeq: 1, owner: ownerB }).code, 'CLAIM_OWNER_UNKNOWN');

    const stale = createRecoveryStore({ root, checkpointDir, isOwnerAlive: () => false });
    const reclaimed = stale.acquireClaim({ episodeId: 'ep', checkpointSeq: 1, owner: ownerB });
    assert.equal(reclaimed.ok, true, JSON.stringify(reclaimed));
    assert.equal(stale.get('ep').ownerInstanceId, 'runtime-b');
    assert.equal(fs.readdirSync(path.join(root, 'stale-claims')).length, 1, 'the replaced claim is archived, never deleted');
    assert.equal(reclaimed.claim.owner.processIdentity, 'start-b');

    assert.equal(stale.releaseClaim({ episodeId: 'ep', owner: ownerA }).code, 'CLAIM_NOT_OWNED');
    assert.equal(stale.releaseClaim({ episodeId: 'ep', owner: ownerB }).ok, true);
    assert.equal(stale.get('ep').ownerInstanceId, null, 'releasing clears the recorded owner');
    assert.equal(stale.releaseClaim({ episodeId: 'ep', owner: ownerB }).code, 'CLAIM_NOT_OWNED', 'the claim file is gone, so nothing is owned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt claim blocks automatic recovery instead of being overwritten', () => {
  const root = tempDir();
  const checkpointDir = path.join(root, 'checkpoints');
  try {
    const checkpoints = createCheckpointStore({ dir: checkpointDir, now: () => CLOCK_START });
    const saved = saveRecoveryCheckpoint(checkpoints, 'ep');
    const store = createRecoveryStore({ root, checkpointDir, isOwnerAlive: () => false });
    assert.equal(store.recordCheckpoint({ episodeId: 'ep', checkpointPath: saved.path }).ok, true);

    fs.mkdirSync(store.claimsDir, { recursive: true });
    const claimFile = fs.readdirSync(store.claimsDir);
    assert.deepEqual(claimFile, [], 'no claim exists yet');
    const owner = { instanceId: 'runtime-a', pid: 3101, processIdentity: 'start-a' };
    assert.equal(store.acquireClaim({ episodeId: 'ep', checkpointSeq: 1, owner }).ok, true);
    const written = fs.readdirSync(store.claimsDir)[0];
    fs.writeFileSync(path.join(store.claimsDir, written), '{corrupt', 'utf8');

    const refused = store.acquireClaim({ episodeId: 'ep', checkpointSeq: 1, owner: { instanceId: 'runtime-b', pid: 3102, processIdentity: 'start-b' } });
    assert.equal(refused.code, 'CLAIM_CORRUPT');
    assert.equal(store.releaseClaim({ episodeId: 'ep', owner }).code, 'CLAIM_CORRUPT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// locking: exclusion, staleness and verified release
// ---------------------------------------------------------------------------

test('a workspace lock excludes a second writer, reports staleness and never steals a live lock', () => {
  const dir = tempDir('pf-lock-');
  const clock = clockFrom();
  try {
    const first = createWorkspaceLock({ root: dir, now: clock.now });
    assert.equal(first.file, path.join(dir, 'runtime', 'engineering', 'workspace.lock'));
    assert.equal(first.acquire({ episode: 'episode-a' }).ok, true);
    assert.equal(fs.existsSync(first.file), true, 'the lock is a file, because the excluded writer is another process');

    const second = createWorkspaceLock({ root: dir, now: clock.now });
    const held = second.acquire({ episode: 'episode-b' });
    assert.equal(held.ok, false);
    assert.equal(held.code, LOCK_REASONS.HELD);
    assert.equal(held.lock.episode, 'episode-a');

    clock.advance(DEFAULT_STALE_AFTER_MS + 1);
    assert.equal(second.inspect().stale, true, 'a long-held lock is *offered* as stale for diagnosis');
    assert.match(second.inspect().reason, /has been held for/);
    const aged = second.acquire({ episode: 'episode-b', stealStale: true });
    assert.equal(aged.ok, true, 'an aged lock is reclaimable, which is why heartbeat() exists');
    assert.equal(aged.lock.episode, 'episode-b');

    const other = tempDir('pf-lock-');
    try {
      const uncontested = createWorkspaceLock({ root: other, now: clock.now });
      assert.equal(uncontested.acquire({ episode: 'episode-d' }).ok, true);
      assert.equal(uncontested.heartbeat().ok, true, 'the holder refreshes its own lock');
      assert.equal(uncontested.acquire({ episode: 'episode-d' }).reentrant, true, 'the holder re-acquires its own lock');

      const blockedAgain = createWorkspaceLock({ root: other, now: clock.now });
      const fresh = blockedAgain.acquire({ episode: 'episode-e' });
      assert.equal(fresh.ok, false, 'a fresh live lock is not stale, however the age is read');
      assert.equal(fresh.code, LOCK_REASONS.HELD);
      assert.equal(fresh.lock.episode, 'episode-d');
      const freshAged = blockedAgain.acquire({ episode: 'episode-e', stealStale: true });
      assert.equal(freshAged.ok, false, 'within the staleness window a live lock is never stolen');
      assert.equal(freshAged.code, LOCK_REASONS.HELD);
      assert.match(freshAged.reason, /has been held for/);

      assert.equal(blockedAgain.release().ok, false, 'a non-holder never deletes the lock');
      assert.equal(blockedAgain.release().code, LOCK_REASONS.LOST);
      assert.equal(fs.existsSync(uncontested.file), true);

      assert.equal(uncontested.release().ok, true);
      assert.equal(fs.existsSync(uncontested.file), false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dead owner is reported stale and reclaimed only when the caller passes stealStale', () => {
  const dir = tempDir('pf-lock-');
  try {
    const first = createWorkspaceLock({ root: dir });
    fs.mkdirSync(path.dirname(first.file), { recursive: true });
    fs.writeFileSync(first.file, JSON.stringify({ version: 1, episode: 'dead', pid: 999_999_999, token: 'x', at: Date.now() - 10 * 60_000 }), 'utf8');

    const second = createWorkspaceLock({ root: dir });
    const offered = second.acquire({ episode: 'episode-c' });
    assert.equal(offered.ok, false);
    assert.equal(offered.code, LOCK_REASONS.STALE);
    assert.match(offered.reason, /pass stealStale/);
    assert.equal(offered.lock.episode, 'dead', 'the refused acquire reports the lock it found');
    assert.equal(fs.readFileSync(first.file, 'utf8').includes('"episode":"dead"'), true, 'the stale lock is left on disk until the caller decides');

    const reclaimed = second.acquire({ episode: 'episode-c', stealStale: true });
    assert.equal(reclaimed.ok, true);
    assert.equal(reclaimed.lock.episode, 'episode-c');
    assert.equal(second.heartbeat().ok, true);
    assert.equal(second.release().ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a disabled lock and an unheld heartbeat are the only quiet paths', () => {
  const dir = tempDir('pf-lock-');
  try {
    const disabled = createWorkspaceLock({ root: dir, disabled: true });
    assert.equal(disabled.acquire({ episode: 'ep' }).ok, true);
    assert.equal(disabled.acquire({ episode: 'ep' }).disabled, true);
    assert.equal(disabled.inspect().locked, false);
    assert.equal(disabled.heartbeat().ok, false);
    assert.equal(disabled.release().ok, true);
    assert.equal(fs.existsSync(disabled.file), false, 'a disabled lock never writes a file');

    const fresh = createWorkspaceLock({ root: dir });
    const beat = fresh.heartbeat();
    assert.equal(beat.ok, false);
    assert.equal(beat.reason, 'this process does not hold the lock');
    assert.equal(fresh.release().missing, true, 'releasing a lock that is not there is not an error');
    assert.deepEqual(fresh.inspect(), { locked: false, lock: null, stale: false, reason: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// mutation: the journal, the hashes and the ownership rule
// ---------------------------------------------------------------------------

test('mutation intent is durably observed before the effect and settled after it', () => {
  const root = tempDir('pf-mutation-');
  const target = path.join(root, 'episode-owned.txt');
  const observations = [];
  try {
    const log = createMutationLog({
      onChange: (entry, phase) => {
        observations.push({ phase, result: entry.result, exists: fs.existsSync(target) });
        return { ok: true };
      }
    });
    const result = log.apply({ kind: 'create', path: target, content: 'durable intent first', root, reason: 'test journal' });
    assert.equal(result.result, MUTATION_RESULTS.APPLIED);
    assert.equal(result.after, result.intended.hash);
    assert.deepEqual(observations.map((entry) => [entry.phase, entry.result, entry.exists]), [
      ['before', MUTATION_RESULTS.PENDING, false],
      ['after', MUTATION_RESULTS.APPLIED, true]
    ]);
    assert.equal(log.count, 1, 'one stable mutation id advances through pending and settled state');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed pre-effect journal blocks the write and a post-effect journal failure is only a warning', () => {
  const root = tempDir('pf-mutation-');
  try {
    const blocked = createMutationLog({ onChange: (_entry, phase) => (phase === 'before' ? { ok: false, reason: 'checkpoint storage unavailable' } : { ok: true }) });
    const target = path.join(root, 'must-not-exist.txt');
    const refused = blocked.apply({ kind: 'create', path: target, content: 'never written', root, reason: 'fail closed' });
    assert.equal(refused.result, MUTATION_RESULTS.FAILED);
    assert.match(refused.verification.reason, /checkpoint storage unavailable/);
    assert.equal(fs.existsSync(target), false);

    const warned = createMutationLog({ onChange: (_entry, phase) => (phase === 'after' ? { ok: false, reason: 'journal write failed' } : { ok: true }) });
    const written = warned.apply({ kind: 'create', path: target, content: 'written', root, reason: 'warn only' });
    assert.equal(written.result, MUTATION_RESULTS.APPLIED);
    assert.equal(written.journalWarning, 'journal write failed');

    const threw = createMutationLog({ onChange: () => { throw new Error('journal exploded'); } });
    assert.equal(threw.apply({ kind: 'create', path: target, content: 'x', root, reason: 'throws' }).result, MUTATION_RESULTS.FAILED);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a content-hash mismatch is detected and a conflicting file is never overwritten on resume', () => {
  const root = tempDir('pf-mutation-');
  try {
    const target = path.join(root, 'tracked.txt');
    fs.writeFileSync(target, 'the intended content', 'utf8');
    const log = createMutationLog();

    const mismatch = log.verify({
      kind: 'write',
      path: target,
      intended: { bytes: 10, hash: hashContent(Buffer.from('something else')) },
      encoding: 'utf8'
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'the file does not hold the intended content');
    assert.equal(mismatch.expected, hashContent(Buffer.from('something else')));
    assert.equal(mismatch.actual, hashContent(Buffer.from('the intended content')));

    const match = log.verify({ kind: 'write', path: target, intended: { hash: hashContent(Buffer.from('the intended content')) } });
    assert.equal(match.ok, true);

    const missing = log.verify({ kind: 'write', path: path.join(root, 'absent.txt'), intended: { hash: 'x' } });
    assert.equal(missing.ok, false);

    const conflicting = {
      id: 'm9',
      kind: 'write',
      path: target,
      result: 'pending',
      before: hashContent(Buffer.from('what it held before')),
      intended: { hash: hashContent(Buffer.from('intended')) }
    };
    const verdict = log.resume(conflicting);
    assert.equal(verdict.verdict, 'failed');
    assert.equal(fs.readFileSync(target, 'utf8'), 'the intended content', 'resume never writes over the conflicting file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a restored pending mutation is reconciled from disk without being applied again, and a malformed journal is refused', () => {
  const root = tempDir('pf-mutation-');
  const target = path.join(root, 'already-written.txt');
  const content = 'the effect landed before the process died';
  try {
    fs.writeFileSync(target, content, 'utf8');
    const log = createMutationLog();
    const restored = log.restore([{
      id: 'm17',
      at: CLOCK_START,
      kind: 'write',
      path: target,
      relative: path.basename(target),
      before: null,
      after: null,
      result: 'pending',
      intended: { bytes: Buffer.byteLength(content), hash: hashContent(Buffer.from(content)) },
      encoding: 'utf8'
    }]);
    assert.equal(restored.ok, true);
    assert.equal(restored.restored, 1);
    const outcome = log.resume(log.pending()[0]);
    assert.equal(outcome.verdict, MUTATION_RESULTS.ALREADY_COMPLETE);
    assert.equal(log.all()[0].result, MUTATION_RESULTS.ALREADY_COMPLETE);
    assert.deepEqual(log.ownedFiles, [target]);
    assert.equal(log.apply({ kind: 'write', path: path.join(root, 'next.txt'), content: 'next', root }).id, 'm18', 'the sequence continues after the restored id');

    assert.equal(log.restore('not-an-array').code, 'MUTATION_JOURNAL_INVALID');
    assert.equal(log.restore([{ id: 'nope', kind: 'write', path: target, result: 'pending' }]).code, 'MUTATION_JOURNAL_INVALID');
    assert.equal(log.restore([{ id: 'm1', kind: 'invented', path: target, result: 'pending' }]).code, 'MUTATION_JOURNAL_INVALID');
    assert.equal(log.restore([{ id: 'm1', kind: 'write', path: 'relative.txt', result: 'pending' }]).code, 'MUTATION_JOURNAL_INVALID');
    assert.equal(log.restore([{ id: 'm1', kind: 'write', path: target, result: 'invented' }]).code, 'MUTATION_JOURNAL_INVALID');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a mutation may not escape the workspace or touch a file the user had already changed', () => {
  const root = tempDir('pf-mutation-');
  const outside = tempDir('pf-outside-');
  try {
    const dirty = path.join(root, 'user-notes.txt');
    fs.writeFileSync(dirty, 'the user was working on this', 'utf8');
    const log = createMutationLog({ protectedFiles: [dirty] });

    const escaped = log.apply({ kind: 'write', path: path.join(outside, 'sneaky.txt'), content: 'x', root, reason: 'escape' });
    assert.equal(escaped.result, MUTATION_RESULTS.REFUSED);
    assert.match(escaped.verification.reason, /outside the episode workspace/);
    assert.equal(fs.existsSync(path.join(outside, 'sneaky.txt')), false);

    const protectedWrite = log.apply({ kind: 'write', path: dirty, content: 'overwritten', root, reason: 'should refuse' });
    assert.equal(protectedWrite.result, MUTATION_RESULTS.REFUSED);
    assert.equal(protectedWrite.verification.preExisting, true);
    assert.equal(fs.readFileSync(dirty, 'utf8'), 'the user was working on this');

    assert.equal(log.protect(path.join(root, 'declared.txt')), 2);
    assert.equal(log.mayWrite(path.join(root, 'declared.txt'), root).ok, false);
    assert.equal(log.mayWrite(path.join(root, 'fresh.txt'), root).ok, true);
    assert.equal(log.mayWrite(path.join(root, 'fresh.txt'), root).preExisting, false);

    // A file the episode itself wrote is no longer off limits to the episode.
    const own = log.apply({ kind: 'create', path: path.join(root, 'fresh.txt'), content: 'v1', root, reason: 'first write' });
    assert.equal(own.result, MUTATION_RESULTS.APPLIED);
    assert.equal(log.mayWrite(path.join(root, 'fresh.txt'), root).owned, true);

    const dry = log.apply({ kind: 'write', path: path.join(root, 'planned.txt'), content: 'not yet', root, reason: 'dry run', dryRun: true });
    assert.equal(dry.result, MUTATION_RESULTS.PENDING);
    assert.equal(fs.existsSync(path.join(root, 'planned.txt')), false, 'a dry run never touches disk');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('move, mkdir, delete, ring bounding and the changed-file manifest behave as recorded', () => {
  const root = tempDir('pf-mutation-');
  try {
    const log = createMutationLog({ now: () => CLOCK_START, ringSize: 4 });
    assert.equal(log.apply({ kind: 'mkdir', path: path.join(root, 'sub'), root, reason: 'make a directory' }).result, MUTATION_RESULTS.APPLIED);
    const made = log.apply({ kind: 'create', path: path.join(root, 'sub', 'a.txt'), content: 'a', root, reason: 'create a' });
    assert.equal(made.result, MUTATION_RESULTS.APPLIED);

    const moved = log.apply({ kind: 'move', path: path.join(root, 'sub', 'a.txt'), to: path.join(root, 'sub', 'b.txt'), root, reason: 'rename' });
    assert.equal(moved.result, MUTATION_RESULTS.APPLIED);
    assert.equal(fs.existsSync(path.join(root, 'sub', 'b.txt')), true);

    assert.equal(log.apply({ kind: 'delete', path: path.join(root, 'sub', 'b.txt'), root, reason: 'remove' }).result, MUTATION_RESULTS.APPLIED);
    assert.equal(fs.existsSync(path.join(root, 'sub', 'b.txt')), false);

    assert.deepEqual(log.changedFiles(root), ['sub', 'sub/a.txt', 'sub/b.txt'].sort());
    assert.deepEqual(log.summary(root).filesChanged, log.changedFiles(root));
    assert.equal(log.summary(root).failed, 0);
    assert.equal(log.all().length <= 4, true, 'the ring is bounded');

    const unknown = log.apply({ kind: 'invented', path: path.join(root, 'x.txt'), root, reason: 'unknown kind' });
    assert.equal(unknown.result, MUTATION_RESULTS.FAILED);
    assert.match(unknown.verification.reason, /unknown mutation kind/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// repository: the snapshot, path safety and the drift reasons
// ---------------------------------------------------------------------------

test('the workspace is explicit and unverifiable paths are refused, never guessed', () => {
  const root = tempDir('pf-repo-');
  try {
    const file = path.join(root, 'a-file.txt');
    fs.writeFileSync(file, 'not a directory', 'utf8');

    const missing = repository.verifyWorkspace('');
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'no repository path was given');
    assert.equal(repository.verifyWorkspace(null).reason, 'no repository path was given');
    assert.equal(repository.verifyWorkspace(undefined).reason, 'no repository path was given');

    const notThere = repository.verifyWorkspace(path.join(root, 'gone'));
    assert.equal(notThere.ok, false);
    assert.match(notThere.reason, /is not accessible/);

    const notADirectory = repository.verifyWorkspace(file);
    assert.equal(notADirectory.ok, false);
    assert.match(notADirectory.reason, /is not a directory/);

    const directory = repository.verifyWorkspace(root);
    assert.equal(directory.ok, true);
    assert.equal(directory.path, fs.realpathSync(root));
    assert.equal(repository.verifyWorkspace(root, { requireGit: true }).ok, false, 'a plain temp directory is not a git work tree');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a fingerprint detects drift under the same HEAD and names each reason once', () => {
  const root = tempDir('pf-repo-');
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'before' }), 'utf8');
    fs.writeFileSync(path.join(root, 'jest.config.js'), 'module.exports = {}', 'utf8');
    const first = repository.fingerprint({ root, now: CLOCK_START, gitState: { branch: 'main', head: 'abc', detached: false, modified: [], staged: [], untracked: [], conflicted: [], remotes: [] } });
    assert.equal(first.at, CLOCK_START);
    assert.deepEqual(first.dirtyFiles, []);
    assert.equal(typeof first.dirtyHash, 'string');
    assert.equal(repository.diffFingerprint(null, first).drifted, false, 'no previous fingerprint is not drift');
    assert.equal(repository.diffFingerprint(first, first).drifted, false);
    assert.deepEqual(repository.diffFingerprint(first, first).reasons, []);

    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'after' }), 'utf8');
    const manifestMoved = repository.diffFingerprint(first, repository.fingerprint({ root, now: CLOCK_START, gitState: { branch: 'main', head: 'abc', detached: false, modified: [], staged: [], untracked: [], conflicted: [], remotes: [] } }));
    assert.equal(manifestMoved.drifted, true);
    assert.equal(manifestMoved.reasons.includes('a manifest or lockfile changed'), true);
    assert.equal(manifestMoved.reasons.length, 1, 'one edit produces one reason');

    fs.writeFileSync(path.join(root, 'jest.config.js'), 'module.exports = { testMatch: [] }', 'utf8');
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'new', 'utf8');
    const several = repository.diffFingerprint(first, repository.fingerprint({
      root,
      now: CLOCK_START,
      gitState: { branch: 'topic', head: 'def', detached: false, modified: ['untracked.txt'], staged: [], untracked: ['untracked.txt'], conflicted: [], remotes: ['origin'] }
    }));
    assert.equal(several.drifted, true);
    assert.equal(several.reasons.includes('HEAD moved: abc -> def'), true);
    assert.equal(several.reasons.includes('branch changed: main -> topic'), true);
    assert.equal(several.reasons.includes('the working tree changed'), true);
    assert.equal(several.reasons.includes('a manifest or lockfile changed'), true);
    assert.equal(several.reasons.includes('the test configuration changed'), true);
    assert.equal(several.reasons.length, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the snapshot reads the project surface, and git absence is a reported fact', () => {
  const root = tempDir('pf-repo-');
  try {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }), 'utf8');
    fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n', 'utf8');
    fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# guide\n', 'utf8');
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'verify.yml'), 'name: verify\n', 'utf8');

    const snapshot = repository.snapshot({ root, now: () => CLOCK_START });
    assert.equal(snapshot.root, root);
    assert.equal(snapshot.at, CLOCK_START);
    assert.equal(snapshot.git.available, false, 'a plain temporary directory has no git');
    assert.equal(snapshot.git.reason, 'not a git work tree');
    assert.equal(snapshot.manifests.includes('package.json'), true);
    assert.equal(snapshot.instructions.some((entry) => entry.file === 'README.md'), true);
    assert.equal(snapshot.instructions.some((entry) => entry.file === 'docs/guide.md'), true);
    assert.deepEqual(snapshot.ci, ['.github/workflows/verify.yml']);
    assert.deepEqual(snapshot.packageScripts, { test: 'node --test' });
    assert.equal(snapshot.fingerprint.head, null);

    assert.equal(repository.summarizeText('short').includes('[... '), false);
    assert.match(repository.summarizeText('x'.repeat(20), { limit: 5 }), /\[\.\.\. 15 more characters\]/);

    const empty = tempDir('pf-empty-');
    try {
      assert.equal(repository.packageScripts(empty), null, 'no package.json means no scripts block');
      assert.equal(repository.packageScripts(root).test, 'node --test');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('porcelain parsing keeps renamed targets, conflicts and both change sides', () => {
  const parsed = repository.parsePorcelain([
    ' M modified.js',
    'M  staged.js',
    'MM both.js',
    '?? untracked.js',
    'UU conflicted.js',
    'AA both-added.js',
    'R  old.js -> renamed.js',
    ''
  ].join('\n'));
  assert.deepEqual(parsed.modified, ['modified.js', 'both.js'], 'a conflicted line is reported as a conflict only');
  assert.deepEqual(parsed.staged, ['staged.js', 'both.js', 'renamed.js']);
  assert.deepEqual(parsed.untracked, ['untracked.js']);
  assert.deepEqual(parsed.conflicted, ['conflicted.js', 'both-added.js']);
  assert.deepEqual(repository.parsePorcelain(''), { modified: [], staged: [], untracked: [], conflicted: [] });
  assert.deepEqual(repository.parsePorcelain(null), { modified: [], staged: [], untracked: [], conflicted: [] });
});

test('the repository hashes the same content the same way and reads a bounded file', () => {
  const root = tempDir('pf-repo-');
  try {
    const file = path.join(root, 'content.txt');
    fs.writeFileSync(file, 'the same bytes', 'utf8');
    assert.equal(repository.hashFile(file), repository.shortHash(fs.readFileSync(file)));
    assert.equal(repository.hashFile(file).length, 16);
    assert.equal(repository.hashFile(path.join(root, 'absent.txt')), null);

    const read = repository.readTextFile(file);
    assert.equal(read.ok, true);
    assert.equal(read.text, 'the same bytes');
    assert.equal(read.truncated, false);
    const bounded = repository.readTextFile(file, 4);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.bytes, Buffer.byteLength('the same bytes'));
    assert.equal(repository.readTextFile(path.join(root, 'absent.txt')).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// process identity: PID plus a creation identity, and unknown is not dead
// ---------------------------------------------------------------------------

test('an owner carries a process identity alongside its PID', () => {
  assert.deepEqual(
    createProcessOwner({ instanceId: 'runtime-a', pid: 123, processIdentity: 'start-a' }),
    { instanceId: 'runtime-a', pid: 123, processIdentity: 'start-a' }
  );
  const supplied = createProcessOwner({ instanceId: '  runtime-a  ', processIdentity: '  start-a  ' });
  assert.equal(supplied.instanceId, 'runtime-a');
  assert.equal(supplied.processIdentity, 'start-a');
  assert.equal(supplied.pid, process.pid);

  const generated = createProcessOwner({ instanceId: 'runtime-gen' });
  assert.match(generated.processIdentity, /^(win-filetime:\d{10,20}|runtime-start:\d+:\d+:[0-9a-f-]{36})$/);
  assert.equal(typeof createProcessOwner().instanceId, 'string');
});

test('a matching creation identity proves the owner live, a different one is stale and an unknown probe stays unknown', () => {
  const owner = { instanceId: 'runtime-a', pid: 123, processIdentity: 'win-filetime:1000' };
  assert.equal(probeProcessOwner(owner, { getProcessIdentity: () => ({ known: true, exists: true, identity: 'win-filetime:1000' }) }), true);
  assert.equal(probeProcessOwner(owner, { getProcessIdentity: () => ({ known: true, exists: true, identity: 'win-filetime:2000' }) }), false);
  assert.equal(probeProcessOwner(owner, { getProcessIdentity: () => ({ known: true, exists: false, identity: null }) }), false);
  assert.equal(probeProcessOwner(owner, { getProcessIdentity: () => ({ known: false, exists: false, identity: null }) }), null);
  assert.equal(probeProcessOwner(owner, { getProcessIdentity: () => { throw new Error('probe failed'); } }), null);
  assert.equal(probeProcessOwner(owner, { getProcessIdentity: () => ({ known: true, exists: true, identity: null }) }), null);

  const fallback = { instanceId: 'runtime-a', pid: 123, processIdentity: 'runtime-start:123:1000:opaque' };
  assert.equal(probeProcessOwner(fallback, { getProcessIdentity: () => ({ known: true, exists: true, identity: 'win-filetime:2000' }) }), null, 'an unverified fallback never becomes a stale proof');

  assert.equal(probeProcessOwner(null), null);
  assert.equal(probeProcessOwner({ instanceId: 'a', pid: 0, processIdentity: 'x' }), null);
  assert.equal(probeProcessOwner({ instanceId: 'a', pid: 12, processIdentity: '  ' }), null);
});

test('the OS creation-identity probe answers known=false on a non-Windows host and for an invalid PID', () => {
  assert.deepEqual(getProcessIdentity(0), { known: false, exists: false, identity: null });
  assert.deepEqual(getProcessIdentity(-1), { known: false, exists: false, identity: null });
  assert.deepEqual(getProcessIdentity(1.5), { known: false, exists: false, identity: null });
  if (process.platform !== 'win32') {
    assert.deepEqual(getProcessIdentity(process.pid), { known: false, exists: false, identity: null });
    return;
  }
  // On Windows the probe may be known or unknown depending on whether the host
  // lets PowerShell enumerate the process; only the shape is asserted here.
  const probe = getProcessIdentity(process.pid);
  assert.equal(typeof probe.known, 'boolean');
  assert.equal(typeof probe.exists, 'boolean');
  if (probe.known && probe.exists) assert.match(probe.identity, /^win-filetime:\d{10,20}$/);
  else assert.equal(probe.identity, null);
});
