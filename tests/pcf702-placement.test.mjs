// PCF-702 acceptance: the workbook's own counterexamples for explainable placement.
//
// The workbook names seven: the fastest node is still refused without authorisation; a strict target that is offline
// is not re-routed; a missing VRAM reading is neither 0 nor sufficient; identical input and version give an identical
// choice; equal freeSlots do not mean equal performance; a large candidate list stays bounded; and an older proposal
// is rejected by the version check. Each one is checked here against the real planPlacement/estimateCost path, and
// the proposal is checked for the fields the workbook requires (policy/state/observation refs and an expiry).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planPlacement, feasibility, FEASIBILITY_REFUSALS, CANDIDATE_LIMIT, PLACEMENT_PROPOSAL_VERSION} from '../services/personal-compute-fabric/placement.mjs';
import {estimateCost, COST_COMPONENTS, UNCALIBRATED_WIDENING} from '../services/personal-compute-fabric/cost-model.mjs';
import {Store} from '../services/dev-gateway/store.mjs';
import {createCanonicalStateAdapter} from '../services/personal-compute-fabric/canonical-state-adapter.mjs';
import {admit} from '../services/personal-compute-fabric/admission.mjs';

const policy = {version: 7, authorized: true, originDeviceId: 'alien', mode: 'TRUSTED_PERSONAL_FABRIC', allowedDevices: ['alien', 'mech', 'ghost'], dataScopes: ['PUBLIC'], sharingConsent: true, cloudConsent: false, budget: 0, expiresAt: 5000};
const workload = {taskId: 'T', actionId: 'A', originDeviceId: 'alien', parentSessionId: 'S', appId: 'one', dataScope: 'PUBLIC', kind: 'CPU_JSON', capabilities: ['cpu.json'], resources: {cpu: 1, vram: 8}, deadlineAt: 4000, writeScope: [], qos: 'BATCH'};
const candidate = (deviceId, extra = {}) => ({deviceId, bootId: 'boot-' + deviceId, trusted: true, authorized: true, executorReady: true, sharing: true, platform: 'win32',
  provider: {id: 'cpu', ready: true, capabilities: ['cpu.json'], workloadKinds: ['CPU_JSON'], isolation: 'COOPERATIVE'}, observationVersion: 1, observedAt: 900, validUntil: 3000,
  free: {cpu: 2, vram: 16}, queueMs: 10, cost: {inputMs: [1, 2], coldStartMs: [0, 1], executeMs: [10, 20], returnMs: [1, 2]}, ...extra});

test('PCF702-01 the fastest unauthorised node is refused and the slower authorised one wins', () => {
  const fast = candidate('mech', {authorized: false, queueMs: 1, cost: {inputMs: [0, 0], coldStartMs: [0, 0], executeMs: [1, 1], returnMs: [0, 0]}});
  const slow = candidate('alien', {queueMs: 500, cost: {inputMs: [10, 10], coldStartMs: [10, 10], executeMs: [200, 300], returnMs: [10, 10]}});
  const proposal = planPlacement(workload, [fast, slow], policy, 1000);
  assert.equal(proposal.state, 'PROPOSED');
  assert.equal(proposal.deviceId, 'alien', 'the fastest node is not allowed to win without authorisation');
  assert.deepEqual(proposal.decisions, [{deviceId: 'mech', code: FEASIBILITY_REFUSALS.NOT_AUTHORIZED, remedy: 'REQUEST_AUTHORISATION'}]);
  // The refusal is by NAME and carries a remedy, so a UI cannot render it as "no machines available".
  assert.equal(proposal.decisions[0].code, 'EXECUTOR_NOT_AUTHORIZED_OR_READY');
  // Ranking is never reached for the refused candidate, so it does not even appear as feasible.
  assert.deepEqual(proposal.feasible.map(entry => entry.deviceId), ['alien']);
});

test('PCF702-02 a strict target that is offline is refused rather than re-routed', () => {
  const strict = planPlacement({...workload, strictTargetDeviceId: 'ghost'}, [candidate('alien')], policy, 1000);
  assert.equal(strict.state, 'REFUSED');
  assert.equal(strict.deviceId, null);
  assert.equal(strict.decisions[0].code, FEASIBILITY_REFUSALS.STRICT_TARGET);
  // A present-but-slower strict target is chosen over a faster non-target, and a stale strict target is not either.
  const chosen = planPlacement({...workload, strictTargetDeviceId: 'ghost'}, [candidate('alien', {queueMs: 1}), candidate('ghost', {queueMs: 900})], policy, 1000);
  assert.equal(chosen.deviceId, 'ghost');
  const stale = planPlacement({...workload, strictTargetDeviceId: 'ghost'}, [candidate('ghost', {validUntil: 999})], policy, 1000);
  assert.equal(stale.state, 'REFUSED', 'a stale strict target is re-measured, never swapped for another device');
  assert.equal(stale.decisions[0].code, FEASIBILITY_REFUSALS.STALE_OBSERVATION);
});

test('PCF702-03 a missing VRAM reading is neither zero nor sufficient', () => {
  // Not reported at all: UNKNOWN, which is a different code and a different remedy from "too small".
  assert.equal(feasibility(workload, candidate('mech', {free: {cpu: 2}}), policy, 1000), FEASIBILITY_REFUSALS.RESOURCE_UNKNOWN);
  // Reported as a non-number: still UNKNOWN, not silently coerced.
  assert.equal(feasibility(workload, candidate('mech', {free: {cpu: 2, vram: null}}), policy, 1000), FEASIBILITY_REFUSALS.RESOURCE_UNKNOWN);
  // Reported as a real measurement that is too small: INSUFFICIENT, and the two are distinguishable.
  assert.equal(feasibility(workload, candidate('mech', {free: {cpu: 2, vram: 0}}), policy, 1000), FEASIBILITY_REFUSALS.RESOURCE_INSUFFICIENT);
  assert.equal(feasibility(workload, candidate('mech', {free: {cpu: 2, vram: 8}}), policy, 1000), null);
  const unknown = planPlacement(workload, [candidate('mech', {free: {cpu: 2}})], policy, 1000);
  assert.equal(unknown.state, 'REFUSED');
  assert.equal(unknown.decisions[0].remedy, 'REMEASURE_REQUIRED');
  // A malformed demand is unknown too: it cannot be checked, so it is not treated as satisfied.
  assert.equal(feasibility({...workload, resources: {vram: undefined}}, candidate('mech'), policy, 1000), FEASIBILITY_REFUSALS.RESOURCE_UNKNOWN);
});

test('PCF702-04 the same input and version give the same choice, whatever order the candidates arrive in', () => {
  const build = () => [candidate('mech', {queueMs: 20}), candidate('ghost', {queueMs: 5, free: {cpu: 2, vram: 8}}), candidate('alien', {queueMs: 20})];
  const first = planPlacement(workload, build(), policy, 1000);
  const second = planPlacement(workload, build().reverse(), policy, 1000);
  assert.equal(first.deviceId, second.deviceId);
  assert.deepEqual(first.feasible, second.feasible, 'the ranked list is identical, so the tie-break is the identity and not the input order');
  assert.equal(first.deviceId, 'alien', 'local-first outranks the queue length for equal-cost candidates');
  assert.deepEqual(first.feasible.map(entry => entry.rank), [1, 2, 3]);
  assert.equal(first.rankingRule, 'COST_RANKING_BOUND_ASC_LOCAL_FIRST_THEN_DEVICE_ID');
});

test('PCF702-05 equal freeSlots do not mean equal performance', () => {
  const sameCapacity = () => ({cpu: 2, vram: 16});
  const quick = candidate('mech', {free: sameCapacity(), queueMs: 1, cost: {inputMs: [0, 0], coldStartMs: [0, 0], executeMs: [5, 5], returnMs: [0, 0]}});
  const slow = candidate('ghost', {free: sameCapacity(), queueMs: 400, cost: {inputMs: [50, 60], coldStartMs: [30, 40], executeMs: [200, 400], returnMs: [10, 20]}});
  // Neither candidate is the origin device, so local-first does not decide this: the decomposed cost does.
  const proposal = planPlacement(workload, [slow, quick], policy, 1000);
  assert.deepEqual(quick.free, slow.free, 'the two candidates advertise identical free capacity');
  assert.equal(proposal.deviceId, 'mech', 'the choice is made on the decomposed cost, not on the identical freeSlots');
  // The five components are reported separately, so the reason the loser lost is visible.
  assert.deepEqual(COST_COMPONENTS, ['queue', 'inputTransfer', 'coldStart', 'execution', 'resultReturn']);
  assert.deepEqual(proposal.cost.components.execution.intervalMs, [5, 5]);
  assert.deepEqual(proposal.feasible[1].cost.components.execution.intervalMs, [200, 400]);
  assert.deepEqual(estimateCost(slow).components.queue, {state: 'MEASURED', intervalMs: [400, 400], source: 'candidate.queueMs'});
  assert.deepEqual(estimateCost(slow).intervalMs, [690, 920]);
});

test('PCF702-06 cost is decomposed, missing parts are named, and no accuracy is claimed', () => {
  const estimate = estimateCost(candidate('mech'));
  assert.deepEqual(Object.keys(estimate.components), [...COST_COMPONENTS]);
  assert.equal(estimate.state, 'ESTIMATED');
  assert.equal(estimate.complete, true);
  assert.deepEqual(estimate.missing, []);
  // No calibration evidence: the model version says so, the accuracy claim is NONE, and the ranking bound is widened.
  assert.equal(estimate.calibration.status, 'UNCALIBRATED');
  assert.equal(estimate.calibration.samples, 0);
  assert.equal(estimate.accuracyClaim, 'NONE');
  assert.equal(estimate.modelVersion, 'conservative-uncalibrated-v1');
  assert.equal(estimate.rankingMs, estimate.intervalMs[1] * UNCALIBRATED_WIDENING);
  // One component missing is enough to make the estimate unusable for a cost-ranked strategy - and the missing name
  // is reported instead of being substituted with 0.
  const partial = estimateCost(candidate('mech', {cost: {inputMs: [1, 2], coldStartMs: [0, 1], executeMs: [10, 20]}}));
  assert.equal(partial.state, 'UNKNOWN');
  assert.deepEqual(partial.missing, ['resultReturn']);
  assert.equal(partial.intervalMs, null);
  const refused = planPlacement(workload, [candidate('mech', {cost: {inputMs: [1, 2]}})], policy, 1000);
  assert.equal(refused.state, 'REFUSED');
  assert.equal(refused.decisions[0].code, FEASIBILITY_REFUSALS.COST_INCOMPLETE);
  assert.deepEqual(refused.decisions[0].missing, ['coldStart', 'execution', 'resultReturn']);
  // A calibrated model is not widened, and it says which version produced the numbers.
  const calibrated = estimateCost(candidate('mech', {cost: {inputMs: [1, 2], coldStartMs: [0, 1], executeMs: [10, 20], returnMs: [1, 2], calibrationVersion: 'cal-2026-10', calibrationSamples: 40}}));
  assert.equal(calibrated.calibration.status, 'CALIBRATED');
  assert.equal(calibrated.modelVersion, 'cal-2026-10');
  assert.equal(calibrated.rankingMs, calibrated.intervalMs[1]);
});

test('PCF702-07 a large candidate list stays bounded and says what it truncated', () => {
  const names = Array.from({length: CANDIDATE_LIMIT}, (_, index) => 'dev-' + String(index).padStart(3, '0'));
  const many = names.map(name => candidate(name));
  const wide = {...policy, allowedDevices: [...names, 'alien', 'mech', 'ghost']};
  const bounded = planPlacement(workload, many, wide, 1000, {limit: 4});
  assert.equal(bounded.feasible.length, 4);
  assert.equal(bounded.candidates.length, 4);
  assert.deepEqual(bounded.truncated, {feasible: true, decisions: false});
  assert.equal(bounded.counts.feasible, CANDIDATE_LIMIT, 'the full count is still reported although the list is capped');
  assert.equal(bounded.state, 'PROPOSED');
  assert.throws(() => planPlacement(workload, [...many, candidate('one-too-many')], wide, 1000), /CANDIDATE_LIMIT/);
  assert.throws(() => planPlacement(workload, many, wide, 1000, {limit: 0}), /PLACEMENT_OPTIONS/);
  assert.throws(() => planPlacement(workload, many, wide, 1000, {strategy: 'LEARNED'}), /PLACEMENT_OPTIONS/);
  // Every rejection is kept under the cap too, with the counts exposing the truncation instead of hiding it.
  const refused = Array.from({length: 10}, (_, index) => candidate('no-' + index, {authorized: false}));
  const capped = planPlacement(workload, refused, {...wide, allowedDevices: [...wide.allowedDevices, ...refused.map(entry => entry.deviceId)]}, 1000, {limit: 3});
  assert.equal(capped.state, 'REFUSED');
  assert.equal(capped.decisions.length, 3);
  assert.deepEqual(capped.truncated, {feasible: false, decisions: true});
  assert.equal(capped.counts.refused, 10);
  assert.ok(capped.decisions.every(entry => entry.code === FEASIBILITY_REFUSALS.NOT_AUTHORIZED));
});

test('PCF702-08 the proposal carries its refs and expiry, and a superseded version is refused by admission', async () => {
  const proposal = planPlacement(workload, [candidate('alien')], policy, 1000);
  assert.equal(proposal.kind, 'PlacementProposal');
  assert.equal(proposal.proposalVersion, PLACEMENT_PROPOSAL_VERSION);
  assert.equal(proposal.refs.policyRef, 'policy:7');
  assert.equal(proposal.refs.observationRef, 'observation:alien@1');
  // Placement is pure: it does not invent a canonical state ref it never read, and it says so.
  assert.equal(proposal.refs.stateRef, null);
  assert.match(proposal.refs.stateRefNote, /bound by 704 admission/);
  assert.equal(proposal.validUntil, 3000, 'the expiry is the minimum of candidate validity, policy expiry and the workload deadline');
  assert.equal(proposal.expiry.source, 'MIN_OF_CANDIDATE_VALIDITY_POLICY_EXPIRY_AND_WORKLOAD_DEADLINE');
  assert.equal(proposal.decisions.length, 0);
  assert.equal(proposal.state, 'PROPOSED');

  const dir = await mkdtemp(join(tmpdir(), 'pcf702-stale-'));
  let store;
  try {
    store = new Store(dir);
    store.put('tasks', {id: 'T', state: 'QUEUED', actionId: 'A', originDeviceId: 'alien', parentSessionId: 'S'});
    const owner = createCanonicalStateAdapter(store);
    const request = {workload, proposal, policy, candidate: candidate('alien'), idempotencyKey: 'k', ttlMs: 1000, appQuota: {cpu: 2, vram: 16}, now: 1000};
    assert.equal(admit(owner, request).reservation.deviceId, 'alien');
    // A newer observation of the same device supersedes the proposal the placement was computed from.
    assert.throws(() => admit(owner, {...request, candidate: candidate('alien', {observationVersion: 2}), idempotencyKey: 'k2'}), /STALE_PROPOSAL/);
    // So does a proposal whose observation is older than the candidate the caller is asking to admit.
    const older = planPlacement(workload, [candidate('alien', {observationVersion: 1})], {...policy, version: 6}, 1000);
    assert.throws(() => admit(owner, {...request, proposal: older, idempotencyKey: 'k3'}), /STALE_PROPOSAL/);
    // Past the proposal expiry nothing is admitted either.
    assert.throws(() => admit(owner, {...request, now: 3001, idempotencyKey: 'k4'}), /STALE_PROPOSAL/);
    assert.equal(owner.snapshot().reservations.length, 1, 'no refused admission left a reservation behind');
  } finally { store?.db.close(); await rm(dir, {recursive: true, force: true}); }
});

test('PCF702-09 rejections are sanitised: no workload or candidate detail leaks into the proposal', () => {
  const secretive = candidate('mech', {authorized: false, dataScope: 'SECRET_SCOPE', inputPath: 'D:/private/customer-dump.bin', token: 'ghp_NOT_A_REAL_TOKEN'});
  const proposal = planPlacement(workload, [secretive], policy, 1000);
  const text = JSON.stringify(proposal);
  for (const secret of ['SECRET_SCOPE', 'customer-dump', 'ghp_NOT_A_REAL_TOKEN']) assert.ok(!text.includes(secret), secret + ' must not appear in a placement proposal');
  // The reason is a code, a device id and a remedy - nothing that could carry a payload.
  assert.deepEqual(Object.keys(proposal.decisions[0]).sort(), ['code', 'deviceId', 'remedy']);
  // A fixed strategy without a declared priority is refused rather than silently ordered by device name.
  const undeclared = planPlacement(workload, [candidate('alien')], policy, 1000, {strategy: 'FIXED'});
  assert.equal(undeclared.state, 'REFUSED');
  assert.equal(undeclared.decisions[0].code, FEASIBILITY_REFUSALS.FIXED_PRIORITY_UNDECLARED);
  const declared = planPlacement({...workload, fixedPriority: ['ghost', 'alien']}, [candidate('alien'), candidate('ghost')], policy, 1000, {strategy: 'FIXED'});
  assert.equal(declared.deviceId, 'ghost');
  assert.equal(declared.feasible[0].rankingKey, 0);
  // An isolation requirement the provider cannot enforce is refused, never quietly downgraded.
  assert.equal(feasibility({...workload, requireHardIsolation: true}, candidate('alien'), policy, 1000), FEASIBILITY_REFUSALS.ISOLATION);
});
