// EM-006 conformance suite — local-first Sub-worker placement.
//
// Acceptance: the local host is attempted first; a merely faster or less loaded remote host never
// triggers fallback; remote fallback requires a measured LOCAL_BLOCKED/LOCAL_UNAVAILABLE plus explicit
// user approval; local concurrency is reduced before any fallback is proposed; and a remote dispatch
// without a recorded local attempt is refused.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
 ENGINEERING_PLACEMENT_CONTRACT, FALLBACK_REASONS, LOCAL_FIRST_POLICY, MIN_LOCAL_WORKERS,
 PLACEMENT_CODES, PLACEMENT_DECISIONS, PlacementError, approveRemoteFallback,
 assertLocalFirstAttempted, assertMeasurements, evaluateLocalPlacement, findSpeedFields,
 proposeRemoteFallback, rankCandidateHosts, validateMeasurements
} from '../index.mjs';

const TS = '2026-09-30T12:00:00.000Z';
const MB = 1024 * 1024;
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected the call to fail with ${code}`);
};

const measurements = (overrides = {}) => ({
  cpu: { load_percent: 20, cores: 8 },
  memory: { used_percent: 40, free_bytes: 8 * 1024 * MB },
  gpu: { used_percent: 10, vram_free_bytes: 4 * 1024 * MB, protected: false },
  foreground: { protected_workload: false, full_screen_app: false, user_present: true },
  workers: { running: 0, max: 4 },
  observed_at: TS,
  source: 'host-probe',
  ...overrides,
});

const candidate = (host_ref, overrides = {}) => ({ host_ref, measured_reason: 'LOCAL_BLOCKED', capability_refs: ['FILESYSTEM'], ...overrides });

/* ------------------------------------------------ 1. local first */

test('a healthy local host is used, with local concurrency as the answer', () => {
  const decision = evaluateLocalPlacement(measurements());
  assert.equal(decision.decision, 'LOCAL_ALLOWED');
  assert.equal(decision.reason, null);
  assert.equal(decision.concurrency, 4);
  assert.equal(decision.remote_fallback_eligible, false);
  assert.equal(decision.evidence.cpu_load_percent, 20, 'the decision carries measured evidence, not adjectives');
  assert.equal(ENGINEERING_PLACEMENT_CONTRACT.placement_policy, 'LOCAL_FIRST');
  assert.equal(ENGINEERING_PLACEMENT_CONTRACT.remote_fallback, 'ASK_USER');
});

test('resource pressure reduces local concurrency before any remote fallback', () => {
  const throttled = evaluateLocalPlacement(measurements({ cpu: { load_percent: 80, cores: 8 } }));
  assert.equal(throttled.decision, 'LOCAL_THROTTLED');
  assert.equal(throttled.reason, 'RESOURCE_PRESSURE');
  assert.equal(throttled.concurrency, 1, 'a single worker is attempted before proposing another device');
  assert.equal(throttled.remote_fallback_eligible, false, 'a throttled local host is not a fallback reason');
  // a full worker pool throttles too, and still does not justify remote execution
  const busyPool = evaluateLocalPlacement(measurements({ workers: { running: 4, max: 4 } }));
  assert.equal(busyPool.decision, 'LOCAL_THROTTLED');
  assert.equal(busyPool.remote_fallback_eligible, false);
  // memory pressure behaves the same way
  assert.equal(evaluateLocalPlacement(measurements({ memory: { used_percent: 75, free_bytes: 2 * 1024 * MB } })).decision, 'LOCAL_THROTTLED');
  assert.equal(ENGINEERING_PLACEMENT_CONTRACT.reduces_local_concurrency_first, true);
  expectCode(() => proposeRemoteFallback({ localDecision: throttled, jobRef: 'job-1', candidates: [candidate('device-alien')] }), 'REMOTE_FALLBACK_NOT_JUSTIFIED');
});

test('a protected foreground workload blocks the local host rather than displacing the user', () => {
  const gaming = evaluateLocalPlacement(measurements({ foreground: { protected_workload: true, full_screen_app: true, user_present: true } }));
  assert.equal(gaming.decision, 'LOCAL_BLOCKED');
  assert.equal(gaming.reason, 'PROTECTED_FOREGROUND_WORKLOAD');
  assert.equal(gaming.concurrency, 0);
  assert.equal(gaming.remote_fallback_eligible, true);
  // a protected GPU with workers already running blocks as well
  const protectedGpu = evaluateLocalPlacement(measurements({ gpu: { used_percent: 95, vram_free_bytes: 128 * MB, protected: true }, workers: { running: 2, max: 4 } }));
  assert.equal(protectedGpu.decision, 'LOCAL_BLOCKED');
  // a full-screen app alone does not block; only a protected workload does
  assert.equal(evaluateLocalPlacement(measurements({ foreground: { protected_workload: false, full_screen_app: true, user_present: true } })).decision, 'LOCAL_ALLOWED');
});

test('an unmeasurable local host is unavailable, never assumed free', () => {
  const unknown = evaluateLocalPlacement(measurements({ workers: { running: 0, max: 1 }, memory: { used_percent: 10, free_bytes: 0 } }));
  assert.equal(unknown.decision, 'LOCAL_UNAVAILABLE');
  assert.equal(unknown.reason, 'MEASUREMENT_MISSING');
  assert.equal(unknown.remote_fallback_eligible, true);
  assert.equal(validateMeasurements(measurements({ cpu: { load_percent: 120, cores: 8 } })).ok, false);
  assert.equal(validateMeasurements(measurements({ gpu: { used_percent: 10, vram_free_bytes: 1024, protected: 'yes' } })).ok, false);
  assert.equal(validateMeasurements(measurements({ mood: 'good' })).ok, false);
  assert.equal(validateMeasurements(measurements({ observed_at: 'yesterday' })).ok, false);
  expectCode(() => assertMeasurements({}), 'INVALID_MEASUREMENT');
  expectCode(() => evaluateLocalPlacement(measurements(), { policy: { cpu_block_percent: -1 } }), 'INVALID_POLICY');
  assert.equal(MIN_LOCAL_WORKERS, 1);
});

/* ------------------------------------------------ 2. the invariant */

test('a faster or less loaded remote host alone never triggers fallback', () => {
  const healthy = evaluateLocalPlacement(measurements());
  assert.equal(healthy.decision, 'LOCAL_ALLOWED');
  // the tempting case: local is fine, remote is idle and fast
  const fasterRemote = candidate('device-alien', { measured_reason: 'LOCAL_BLOCKED' });
  expectCode(() => proposeRemoteFallback({ localDecision: healthy, jobRef: 'job-1', candidates: [fasterRemote] }), 'REMOTE_FALLBACK_NOT_JUSTIFIED');
  // and a candidate that advertises its speed is refused outright, even when fallback is justified
  const blocked = evaluateLocalPlacement(measurements({ foreground: { protected_workload: true, full_screen_app: false, user_present: true } }));
  expectCode(
    () => proposeRemoteFallback({ localDecision: blocked, jobRef: 'job-1', candidates: [candidate('device-alien', { speed_rank: 1 })] }),
    'SPEED_IS_NOT_A_REASON',
  );
  expectCode(
    () => proposeRemoteFallback({ localDecision: blocked, jobRef: 'job-1', candidates: [candidate('device-alien', { idle_percent: 97 })] }),
    'SPEED_IS_NOT_A_REASON',
  );
  assert.deepEqual(findSpeedFields({ nested: { faster: true } }, ''), ['.nested.faster']);
  assert.equal(ENGINEERING_PLACEMENT_CONTRACT.remote_selected_because_faster, false);
  assert.equal(ENGINEERING_PLACEMENT_CONTRACT.speed_ranking_allowed, false);
});

test('remote fallback needs a measured reason and explicit user approval', () => {
  const blocked = evaluateLocalPlacement(measurements({ cpu: { load_percent: 99, cores: 8 }, memory: { used_percent: 95, free_bytes: 256 * MB } }));
  assert.equal(blocked.decision, 'LOCAL_THROTTLED', 'a throttled host still runs one worker locally');
  const unavailable = evaluateLocalPlacement(measurements({ memory: { used_percent: 99, free_bytes: 0 } }));
  assert.deepEqual(FALLBACK_REASONS, ['LOCAL_BLOCKED', 'LOCAL_UNAVAILABLE']);
  const proposal = proposeRemoteFallback({ localDecision: unavailable, jobRef: 'job-1', candidates: [candidate('device-alien', { measured_reason: 'LOCAL_UNAVAILABLE' })], requestedBy: 'foreman' });
  assert.equal(proposal.requires_user_approval, true);
  assert.equal(proposal.scope, 'CURRENT_JOB');
  assert.equal(proposal.reason, 'LOCAL_UNAVAILABLE');
  assert.equal(proposal.local_attempted_first, true);
  assert.equal(proposal.ranked_by_speed, false);
  assert.equal(proposal.measured_evidence.cpu_load_percent, 20, 'the evidence that justified it travels with the proposal');
  // an unjustified candidate reason is refused
  expectCode(() => proposeRemoteFallback({ localDecision: unavailable, jobRef: 'job-1', candidates: [candidate('device-alien', { measured_reason: 'FASTER' })] }), 'REMOTE_FALLBACK_NOT_JUSTIFIED');
  expectCode(() => proposeRemoteFallback({ localDecision: unavailable, jobRef: 'job-1', candidates: [] }), 'INVALID_PROPOSAL');
  expectCode(() => proposeRemoteFallback({ localDecision: unavailable, jobRef: '', candidates: [candidate('d')] }), 'INVALID_PROPOSAL');
  expectCode(() => proposeRemoteFallback({ localDecision: unavailable, jobRef: 'job-1', candidates: [{}] }), 'UNKNOWN_CANDIDATE');
  // approval is a human decision and is recorded as one
  expectCode(() => approveRemoteFallback(proposal, {}), 'USER_APPROVAL_REQUIRED');
  expectCode(() => approveRemoteFallback({ ...proposal, requires_user_approval: false }, { approvedBy: 'owner', at: TS }), 'INVALID_PROPOSAL');
  const approved = approveRemoteFallback(proposal, { approvedBy: 'owner', at: TS });
  assert.equal(approved.placement, 'REMOTE_APPROVED');
  assert.equal(approved.approved_by, 'owner');
  assert.equal(approved.local_attempted_first, true);
  assert.equal(approved.owner_preserved, true, 'moving execution does not move the logical owner');
  assert.equal(approved.scope, 'CURRENT_JOB');
  assert.equal(ENGINEERING_PLACEMENT_CONTRACT.remote_fallback_requires_user_approval, true);
  assert.equal(ENGINEERING_PLACEMENT_CONTRACT.requires_measured_blocking_reason, true);
});

test('candidates are ranked by capability fit, only after fallback is justified', () => {
  const unavailable = evaluateLocalPlacement(measurements({ memory: { used_percent: 99, free_bytes: 0 } }));
  const proposal = proposeRemoteFallback({
    localDecision: unavailable,
    jobRef: 'job-1',
    candidates: [
      candidate('device-zeta', { capability_refs: [] }),
      candidate('device-alpha', { capability_refs: ['FILESYSTEM', 'SHELL'] }),
      candidate('device-beta', { capability_refs: ['FILESYSTEM'] }),
    ],
  });
  assert.equal(proposal.rank_by, 'CAPABILITY_FIT_THEN_HOST_REF');
  const ranked = rankCandidateHosts(proposal, { requiredCapabilities: ['FILESYSTEM'] });
  assert.deepEqual(ranked.map(entry => entry.host_ref), ['device-alpha', 'device-beta', 'device-zeta']);
  assert.deepEqual([...ranked[2].missing], ['FILESYSTEM']);
  // with no requirement the order is by host reference, never by speed
  assert.deepEqual(rankCandidateHosts(proposal).map(entry => entry.host_ref), ['device-alpha', 'device-beta', 'device-zeta']);
});

/* ------------------------------------------------ 3. attempts and surface */

test('a remote dispatch requires a recorded local attempt first', () => {
  expectCode(() => assertLocalFirstAttempted({ jobRef: 'job-1', attempts: [] }), 'LOCAL_ATTEMPT_REQUIRED');
  expectCode(() => assertLocalFirstAttempted({ jobRef: 'job-1', attempts: [{ scope: 'REMOTE', throttled: false }] }), 'LOCAL_ATTEMPT_REQUIRED');
  const verdict = assertLocalFirstAttempted({ jobRef: 'job-1', attempts: [{ scope: 'LOCAL', throttled: true }, { scope: 'REMOTE' }] });
  assert.equal(verdict.local_attempted_first, true);
  assert.equal(verdict.local_attempts, 1);
  assert.equal(verdict.reduced_concurrency_first, true);
  expectCode(() => assertLocalFirstAttempted({ jobRef: 'job-1', attempts: 'none' }), 'LOCAL_ATTEMPT_REQUIRED');
  assert.equal(ENGINEERING_PLACEMENT_CONTRACT.local_attempt_required_before_dispatch, true);
  assert.equal(ENGINEERING_PLACEMENT_CONTRACT.owner_moves_with_execution, false);
  assert.deepEqual([...PLACEMENT_DECISIONS], ['LOCAL_ALLOWED', 'LOCAL_THROTTLED', 'LOCAL_BLOCKED', 'LOCAL_UNAVAILABLE']);
  assert.equal(new Set(PLACEMENT_CODES).size, PLACEMENT_CODES.length);
  assert.equal(new PlacementError('X', 'y').status, 409);
  assert.equal(LOCAL_FIRST_POLICY.cpu_block_percent, 92);
});

/* --------------------------------- 7. regressions (Correction, host Alien) */

import { evaluateLocalPlacement as evalLocal, approveRemoteFallback as approveRemote, proposeRemoteFallback as proposeRemote } from '../index.mjs';

const mR = (over = {}) => ({ cpu: { load_percent: 10, cores: 8 }, memory: { used_percent: 20, free_bytes: 8e9 }, gpu: { used_percent: 5, vram_free_bytes: 4e9, protected: false }, foreground: { protected_workload: false, full_screen_app: false, user_present: true }, workers: { running: 0, max: 4 }, observed_at: '2026-09-30T12:00:00.000Z', source: 'os-probe', ...over });
const blockedR = () => evalLocal(mR({ foreground: { protected_workload: true, full_screen_app: false, user_present: true } }));

test('a measurement is a strict own-property record', () => {
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    const probe = Object.defineProperty({ ...mR() }, name, { value: 'X', enumerable: true, configurable: true, writable: true });
    assert.equal(validateMeasurements(probe).ok, false, 'measurements.' + name + ' must not be canonical');
  }
  // an unexamined nested field is part of the same contract
  assert.equal(validateMeasurements(mR({ cpu: { load_percent: 10, cores: 8, faster: true } })).ok, false);
  assert.equal(validateMeasurements(mR({ workers: { running: 0, max: 4, speed_rank: 1 } })).ok, false);
  const inherited = Object.assign(Object.create({ cpu: mR().cpu, memory: mR().memory }), { workers: { running: 0, max: 4 } });
  assert.equal(validateMeasurements(inherited).ok, false, 'an inherited measurement is not a measurement');
  // neighbours: a clean measurement is still valid
  assert.equal(validateMeasurements(mR()).ok, true);
  assert.equal(evalLocal(mR()).decision, 'LOCAL_ALLOWED');
});

test('a measured GPU load is used, and a contradictory worker count is unavailable', () => {
  const hot = evalLocal(mR({ gpu: { used_percent: 100, vram_free_bytes: 4e9, protected: false } }));
  assert.equal(hot.decision, 'LOCAL_THROTTLED', 'a saturated GPU is pressure');
  assert.equal(hot.evidence.gpu_used_percent, 100, 'the measurement is exposed, not discarded');
  // neighbours: an idle GPU still allows full local concurrency
  assert.equal(evalLocal(mR()).concurrency, 4);
  // more workers running than the device permits is a contradiction, not permission to run one
  const over = evalLocal(mR({ workers: { running: 9, max: 2 } }));
  assert.equal(over.decision, 'LOCAL_UNAVAILABLE');
  assert.equal(over.concurrency, 0);
  assert.equal(over.remote_fallback_eligible, true);
});

test('only a justified fallback proposal can be approved', () => {
  const honest = proposeRemote({ localDecision: blockedR(), jobRef: 'job-1', candidates: [{ host_ref: 'host-b', measured_reason: 'LOCAL_BLOCKED' }] });
  expectCode(() => approveRemote({ requires_user_approval: true, job_ref: 'job-x', reason: 'LOCAL_ALLOWED', local_attempted_first: false }, { approvedBy: 'owner-1', at: '2026-09-30T12:00:00.000Z' }), 'REMOTE_FALLBACK_NOT_JUSTIFIED');
  expectCode(() => approveRemote({ requires_user_approval: true, job_ref: 'job-x', reason: 'LOCAL_BLOCKED', local_attempted_first: false }, { approvedBy: 'owner-1', at: '2026-09-30T12:00:00.000Z' }), 'REMOTE_FALLBACK_NOT_JUSTIFIED');
  expectCode(() => approveRemote(honest, { approvedBy: 'owner-1', at: '2026-13-45T99:99:99Z' }), 'INVALID_PROPOSAL');
  // neighbours: the honest proposal is still approvable, and a speed field is still refused
  assert.equal(approveRemote(honest, { approvedBy: 'owner-1', at: '2026-09-30T12:00:00.000Z' }).placement, 'REMOTE_APPROVED');
  expectCode(() => proposeRemote({ localDecision: blockedR(), jobRef: 'j', candidates: [{ host_ref: 'h', measured_reason: 'LOCAL_BLOCKED', speed_rank: 1 }] }), 'SPEED_IS_NOT_A_REASON');
  const hidden = { host_ref: 'h', measured_reason: 'LOCAL_BLOCKED' };
  Object.defineProperty(hidden, 'faster', { value: true, enumerable: false, configurable: true, writable: true });
  expectCode(() => proposeRemote({ localDecision: blockedR(), jobRef: 'j', candidates: [hidden] }), 'SPEED_IS_NOT_A_REASON');
  expectCode(() => proposeRemote({ localDecision: blockedR(), jobRef: 'j', candidates: [Object.assign(Object.create({ host_ref: 'h', measured_reason: 'LOCAL_BLOCKED' }), {})] }), 'UNKNOWN_CANDIDATE');
});