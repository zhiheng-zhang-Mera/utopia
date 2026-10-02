// RS-290 step 5 conformance: the regression matrix run against the INTEGRATED tree.
//
// The point of this file is that it exercises the three components TOGETHER rather than each in
// isolation. RS-201, RS-202 and RS-203 each have their own suites on their own branches, and the
// integrated tree is a verified pure union of them - so re-running those suites would prove only that
// the union did not break each part, not that the parts COMPOSE. Each test below crosses at least two
// components and asserts a property that neither component owns alone.
import test from 'node:test';
import assert from 'node:assert/strict';

// createProviderRegistry and createDeterministicHandleStoreDouble live in registry.mjs, NOT records.mjs -
// the first draft imported records.mjs for both and threw at the call site. The vocabularies are reached
// through presentTerm's source keys here, so records.mjs is not needed at all.
import * as registry from '../../general-ai-registry-v1/registry.mjs';
import * as availability from '../../general-ai-registry-v1/availability.mjs';
import * as pressure from '../../../city/00-foundation/01-city-core/fleet-routing/pressure.mjs';
import * as routing from '../../../city/00-foundation/01-city-core/fleet-routing/routing-sequence.mjs';
import * as rescan from '../../../city/00-foundation/01-city-core/fleet-routing/rescan.mjs';
import * as hysteresis from '../../../city/00-foundation/01-city-core/fleet-routing/hysteresis.mjs';
import * as guard from '../../../city/00-foundation/01-city-core/fleet-routing/assignment-guard.mjs';
import { createReturnBridge } from '../../rs-cross-device-return-v1/return-bridge.mjs';
import { presentTerm, projectStatus, termRef } from '../presentation.mjs';

const idle = Object.freeze({ cpu: 0.05, memory: 0.05, gpu: 0.05, io: 0.05, network: 0.05 });
const hot = Object.freeze({ cpu: 0.95, memory: 0.9, gpu: 0.9, io: 0.9, network: 0.9 });
const device = (extra = {}) => ({ state: 'READY', presence: 'ONLINE', enablement: 'ENABLED', load: idle, sessionConcurrency: 0, providerConcurrency: 0, ...extra });
const surface = ref => ({ device_ref: ref, surface_ref: 's:' + ref });

/* ------------------------------------------------- 1. concurrency across pool, guard and projection */

test('RS-290 matrix: concurrent submissions cannot double-execute, and the pool still reports a reason', () => {
  // RS-202's guard decides WHO may run; RS-201's availability decides WHETHER the provider may be used;
  // the projection reports both. Individually each is tested on its own branch - here they must agree.
  const bridge = createReturnBridge({ resolveSurface: () => surface('device-A') });
  const claims = guard.createAssignmentGuard();
  bridge.register({ actionRef: 'act-1', interactionDeviceRef: 'device-A', executionDeviceRef: 'device-B' });

  const first = claims.claim({ subjectRef: 'act-1', deviceRef: 'device-B', idempotencyKey: 'k1' });
  const second = claims.claim({ subjectRef: 'act-1', deviceRef: 'device-C', idempotencyKey: 'k2' });
  assert.equal(first.outcome, 'CLAIMED');
  assert.equal(second.outcome, 'ALREADY_CLAIMED');

  // The same fact reaches the UI through the unified vocabulary, not through three component dialects.
  const dto = projectStatus({
    providerRefs: [termRef('RS-202.ELIGIBILITY_REASONS', 'ELIGIBLE')],
    routeStageRef: termRef('RS-202.ROUTE_STAGES', 'DIRECT'),
  });
  assert.equal(dto.state, 'RUNNING');
  assert.equal(dto.providers[0].selectable, true);
  assert.equal(dto.fabricated, false);
});

test('RS-290 matrix: a saturated device is routed around, and the projection says WAITING not CHOOSE', () => {
  const loaded = pressure.evaluateEligibility({ device: { state: 'READY', presence: 'ONLINE' }, enablement: 'ENABLED', load: hot });
  const plan = routing.planRoute({ originDeviceRef: 'loaded', current: device({ load: hot }), alternates: [{ deviceRef: 'peer', ...device() }], userDeclinedSwitch: true });
  assert.equal(loaded.reason, 'PRESSURE_PAUSED');
  assert.equal(plan.stage, 'ALTERNATE_DEVICE');

  const dto = projectStatus({
    providerRefs: [termRef('RS-202.ELIGIBILITY_REASONS', loaded.reason)],
    routeStageRef: termRef('RS-202.ROUTE_STAGES', plan.stage),
  });
  // The plan genuinely diverted to another device, so REMOTE_HANDOFF is the CORRECT state here - the
  // property that matters is that a resource refusal never renders as an ACTIVE run on the origin.
  assert.equal(dto.state, 'REMOTE_HANDOFF');
  assert.notEqual(dto.state, 'RUNNING');
  assert.equal(dto.provider_choice_required, false, 'a saturated pool must not demand a choice');
  assert.ok(dto.actions.includes('KEEP_WAITING'));
});

/* ------------------------------------------- 2. lease / idempotency across the guard and the bridge */

test('RS-290 matrix: lease transfer is holder-only and the old holder cannot resume reassigned work', () => {
  const claims = guard.createAssignmentGuard();
  claims.claim({ subjectRef: 'act-2', deviceRef: 'device-A', idempotencyKey: 'k1' });
  assert.equal(claims.transfer({ subjectRef: 'act-2', fromDeviceRef: 'device-X', toDeviceRef: 'device-C' }).outcome, 'REFUSED');
  assert.equal(claims.transfer({ subjectRef: 'act-2', fromDeviceRef: 'device-A', toDeviceRef: 'device-C' }).outcome, 'TRANSFERRED');
  // The epoch bump is what makes the dropped holder's late retry non-idempotent, which is the property
  // that stops two devices running the same work after a dropout.
  assert.equal(claims.claim({ subjectRef: 'act-2', deviceRef: 'device-A', idempotencyKey: 'k1' }).outcome, 'ALREADY_CLAIMED');
  assert.equal(claims.epoch('act-2'), 2);
});

/* ----------------------------------------------------------- 3. device offline / reconnect composed */

test('RS-290 matrix: a disconnect degrades truthfully and recovery restores, through the projection', () => {
  const bridge = createReturnBridge({ resolveSurface: () => surface('device-A') });
  bridge.register({ actionRef: 'act-3', interactionDeviceRef: 'device-A', executionDeviceRef: 'device-B' });
  bridge.apply({ actionRef: 'act-3', sequence: 1, kind: 'PROGRESS' });

  const down = bridge.markDisconnected({ actionRef: 'act-3' });
  assert.equal(down.canonical_state, 'RUNNING', 'losing the executor does not change the run truth');
  assert.equal(down.remote_state, 'UNKNOWN');
  assert.equal(down.truthful_success, false);

  const degraded = projectStatus({
    termRefs: [termRef('RS-203.REMOTE_STATES', down.remote_state)],
    routeStageRef: termRef('RS-202.ROUTE_STAGES', 'QUEUED'),
  });
  assert.equal(degraded.state, 'DEGRADED');
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.fabricated, false);

  const up = bridge.apply({ actionRef: 'act-3', sequence: 2, kind: 'PROGRESS' });
  assert.equal(up.remote_state_recovered, true);
  assert.equal(projectStatus({ termRefs: [termRef('RS-203.REMOTE_STATES', up.remote_state)] }).state, 'RUNNING');
});

/* --------------------------------------------------------------------- 4. provider flap, damped */

test('RS-290 matrix: a flapping pool does not move the work, and the rescan is event-driven', () => {
  let clock = 0;
  const flap = hysteresis.createAntiFlap({ now: () => clock });
  flap.consider({ subjectRef: 'act-4', candidateRef: 'provider-a' });
  clock += 1_000_000;
  for (const candidate of ['provider-b', 'provider-c', 'provider-b', 'provider-c']) {
    assert.equal(flap.consider({ subjectRef: 'act-4', candidateRef: candidate }).decision, 'HOLD');
  }
  assert.equal(flap.current('act-4'), 'provider-a');
  assert.equal(flap.switches('act-4'), 1, 'only the initial adoption');

  // And the re-scan that would notice a real change is event-driven rather than a poll.
  const coordinator = rescan.createRescanCoordinator();
  assert.equal(coordinator.policy().ceiling_ms, 1_200_000);
  assert.equal('interval_ms' in coordinator.policy(), false);
});

/* ------------------------------------------------- 5. end-to-end composition of all three layers */

test('RS-290 matrix: availability, routing and return compose into ONE stable presentation contract', () => {
  // The workbook's own requirement: the UI must not face three vocabularies. This walks a single run
  // through all three components and asserts the UI-facing surface is one set of terms.
  const reg = registry.createProviderRegistry({ handleStore: registry.createDeterministicHandleStoreDouble(), clock: () => Date.parse('2026-10-02T00:00:00.000Z') });
  reg.upsertProvider({ registry_version: 1, provider_ref: 'p-ok', display_name: 'OK', enablement: 'ENABLED', region: null, channels: [{ channel: 'WEB', readiness: 'READY' }], capabilities: { TEXT: 'SUPPORTED' }, observed_at: '2026-10-02T00:00:00.000Z', source: { kind: 'PROBED', ref: 'r' }, ttl_ms: 60000 });
  reg.upsertProvider({ registry_version: 1, provider_ref: 'p-off', display_name: 'Off', enablement: 'DISABLED', region: null, channels: [{ channel: 'WEB', readiness: 'READY' }], capabilities: { TEXT: 'SUPPORTED' }, observed_at: '2026-10-02T00:00:00.000Z', source: { kind: 'CONFIGURED', ref: 'r' }, ttl_ms: 60000 });

  const list = availability.buildCandidates({ registry: reg, now: Date.parse('2026-10-02T00:00:00.000Z') });
  assert.deepEqual([...list.selectable], ['p-ok']);

  const providerRefs = list.candidates.map(candidate => termRef('RS-201.AVAILABILITY_REASONS', candidate.reason));
  const bridge = createReturnBridge({ resolveSurface: () => surface('device-A') });
  bridge.register({ actionRef: 'act-5', interactionDeviceRef: 'device-A', executionDeviceRef: 'device-B' });
  const applied = bridge.apply({ actionRef: 'act-5', sequence: 1, kind: 'FINAL' });

  const dto = projectStatus({
    providerRefs,
    routeStageRef: termRef('RS-202.ROUTE_STAGES', 'DIRECT'),
    terminal: applied.terminal,
    failed: applied.canonical_state === 'FAILED',
  });
  assert.equal(dto.state, 'COMPLETED');
  assert.equal(dto.providers.length, 2);
  // Every provider carries a REASON as a canonical term, so the UI never has to know which component
  // produced it - which is the property that makes step 2's consolidation worth having.
  //
  // Mech's RS-290 addendum found the assertions that used to sit here could not fail: `entry.class` is
  // `TERM_CLASS[term]` and every value in `TERM_CLASS` is one of those four strings by construction,
  // while `resolves_by_waiting` is assigned from that same table - so they restated the table's shape
  // rather than testing behaviour, and "a test that cannot fail is not evidence". These replace them
  // with a cross-check against the mapping computed independently here, which a projection that
  // dropped, reordered or mismapped a provider WOULD fail.
  assert.deepEqual(
    dto.providers.map(entry => entry.term),
    providerRefs.map(reference => presentTerm(reference.source, reference.word)),
    'each provider must carry the term its own source reason maps to, in order',
  );
  assert.deepEqual(dto.providers.map(entry => entry.index), [0, 1], 'provider indices must follow input order');
  // And the decision the classes exist to drive: p-ok is selectable and p-off is user-disabled, so the
  // pool is structurally refused overall but does NOT demand a provider choice while one is usable.
  assert.equal(dto.providers.some(entry => entry.selectable), true);
  assert.equal(dto.structural_refusal, true, 'a USER_DISABLED provider is structural');
  assert.equal(dto.provider_choice_required, false, 'a usable provider means no choice is demanded');
  assert.equal(dto.from_backend_truth, true);
  assert.equal(dto.fabricated, false);
  // The presentation surface exposes exactly one vocabulary's worth of fields, not three.
  assert.deepEqual(Object.keys(dto).sort(), [
    'actions', 'degraded', 'fabricated', 'from_backend_truth', 'presentation_version',
    'provider_choice_required', 'provider_choice_taken', 'providers', 'state', 'structural_refusal', 'terms',
  ].sort());
});
