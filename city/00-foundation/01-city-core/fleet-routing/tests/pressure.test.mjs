// RS-202 step 2 conformance: explainable pressure and eligibility inputs.
//
// The two properties worth defending here are the workbook's own prohibitions, so they are tested
// directly rather than implied:
//   - load is NEVER collapsed to a single CPU/GPU figure, and a partial vector is reported as partial;
//   - UNKNOWN load is NOT idle, because stale telemetry is a named attack and treating absence as spare
//     capacity is the vulnerability that turns into a stampede.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PRESSURE_POLICY, ELIGIBILITY_PRECEDENCE, ELIGIBILITY_REASONS, LOAD_DIMENSIONS,
  PRESSURE_FACTORS, PRESSURE_CONTRACT_VERSION, buildPressureInputs, evaluateEligibility, loadPressure,
} from '../pressure.mjs';

const idleLoad = Object.freeze({ cpu: 0.05, memory: 0.05, gpu: 0.05, io: 0.05, network: 0.05 });
const healthyDevice = Object.freeze({ state: 'READY', presence: 'ONLINE' });
const ok = (extra = {}) => evaluateEligibility({ device: healthyDevice, enablement: 'ENABLED', load: idleLoad, ...extra });

/* ---------------------------------------------------------------- load is a vector, not a number */

test('RS-202: load is a VECTOR and a full vector yields a known pressure', () => {
  const result = loadPressure({ load: idleLoad });
  assert.equal(result.known, true);
  assert.equal(result.partial, false);
  assert.deepEqual([...result.observed], [...LOAD_DIMENSIONS]);
  assert.deepEqual([...result.missing], []);
  assert.ok(result.pressure > 0 && result.pressure < 0.1);
});

test('RS-202: a partial load vector is reported as PARTIAL, with the unobserved dimensions named', () => {
  // This is the prohibition made structural: a device idle on CPU and saturated on IO must not read as
  // simply "idle", and the caller is told which dimensions it is guessing about rather than being handed
  // a confident number.
  const result = loadPressure({ load: { cpu: 0.02 } });
  assert.equal(result.known, true);
  assert.equal(result.partial, true, 'a one-dimension reading must never present as complete');
  assert.deepEqual([...result.observed], ['cpu']);
  assert.deepEqual([...result.missing], ['memory', 'gpu', 'io', 'network']);
  assert.match(result.detail, /unobserved: memory, gpu, io, network/);
});

test('RS-202: an absent or empty load vector is UNKNOWN, never zero', () => {
  for (const load of [null, undefined, {}, 'busy']) {
    const result = loadPressure({ load });
    assert.equal(result.known, false, `load ${JSON.stringify(load)} must not yield a number`);
    assert.equal(result.pressure, null);
  }
  // A partially observed vector below the configured minimum is also untrusted, not averaged.
  const strict = loadPressure({ load: { cpu: 0.9 }, policy: { ...DEFAULT_PRESSURE_POLICY, min_observed_dimensions: 3 } });
  assert.equal(strict.known, false);
  assert.match(strict.detail, /below the minimum of 3/);
});

test('RS-202: a single saturated dimension BINDS, so idle dimensions cannot dilute it', () => {
  // This is the flaw the first implementation had, kept as a test so it cannot come back: averaging a
  // 0.95 CPU against four 0.05 dimensions gave ~0.23 and cheerfully scheduled a device whose CPU was
  // saturated. A saturated resource does not care that something else is idle, so the binding
  // constraint is the maximum, and `mean` is returned alongside so the difference stays visible
  // instead of being hidden inside one number.
  const cpuBound = loadPressure({ load: { cpu: 0.95, memory: 0.05, gpu: 0.05, io: 0.05, network: 0.05 } });
  assert.equal(cpuBound.pressure, 0.95);
  assert.equal(cpuBound.binding_dimension, 'cpu');
  assert.ok(cpuBound.mean < 0.3, 'the mean is still reported, but it is explicitly not what binds');
  assert.equal(ok({ load: { cpu: 0.95, memory: 0.05, gpu: 0.05, io: 0.05, network: 0.05 } }).reason, 'PRESSURE_PAUSED');
  // A different dimension binds just as hard - the rule is about saturation, not about CPU specifically.
  const ioBound = loadPressure({ load: { cpu: 0.05, memory: 0.05, gpu: 0.05, io: 0.99, network: 0.05 } });
  assert.equal(ioBound.binding_dimension, 'io');
  assert.equal(ioBound.pressure, 0.99);
  assert.match(ioBound.detail, /binding on io/);
});

/* ---------------------------------------------------------------- unknown load is not spare capacity */

test('RS-202: UNKNOWN load makes a device INELIGIBLE - absence is not spare capacity', () => {
  const verdict = ok({ load: null });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, 'LOAD_UNKNOWN');
  assert.match(verdict.evidence.join(' '), /no load vector was supplied/);
  // And the refusal stays actionable: the caller is told the load could not be trusted at all.
  assert.equal(verdict.load.known, false);
});

test('RS-202: load at or above the pause threshold pauses placement', () => {
  const paused = ok({ load: { cpu: 0.95, memory: 0.1, gpu: 0.1, io: 0.1, network: 0.1 } });
  assert.equal(paused.eligible, false);
  assert.equal(paused.reason, 'PRESSURE_PAUSED');
  // Just below the threshold is still eligible, so the boundary is a threshold and not a blanket ban.
  const fine = ok({ load: { cpu: 0.89, memory: 0.1, gpu: 0.1, io: 0.1, network: 0.1 } });
  assert.equal(fine.eligible, true);
});

/* ---------------------------------------------------------------- user intent outranks observation */

test('RS-202: a user-disabled device is refused, and an unreadable enablement is refused too', () => {
  assert.equal(ok({ enablement: 'DISABLED' }).reason, 'USER_DISABLED');
  // Absence must not read as consent, exactly as in the RS-201 registry.
  assert.equal(ok({ enablement: null }).reason, 'USER_DISABLED');
  assert.match(ok({ enablement: null }).evidence.join(' '), /not an explicit ENABLED/);
  // The device record may carry it instead of the caller.
  assert.equal(evaluateEligibility({ device: { ...healthyDevice, enablement: 'DISABLED' }, load: idleLoad }).reason, 'USER_DISABLED');
  assert.equal(ok().eligible, true);
});

test('RS-202: eligibility precedence is ordered, so the reported reason is the actionable one', () => {
  assert.deepEqual([...ELIGIBILITY_PRECEDENCE], [
    'USER_DISABLED', 'REFUSING_WORK', 'UNREACHABLE', 'POLICY_EXCLUDED',
    'AT_CAPACITY', 'LOAD_UNKNOWN', 'PRESSURE_PAUSED', 'SESSION_CONGESTED', 'ELIGIBLE',
  ]);
  // Disabled AND offline reports DISABLED: telling the user about reachability would imply that waiting
  // for the device would help, and it would not.
  const disabledOffline = evaluateEligibility({ device: { state: 'OFFLINE', presence: 'OFFLINE' }, enablement: 'DISABLED', load: idleLoad });
  assert.equal(disabledOffline.reason, 'USER_DISABLED');
  // REFUSING_WORK outranks UNREACHABLE: a device that declared itself FAILED said more than "unseen".
  assert.equal(evaluateEligibility({ device: { state: 'FAILED', presence: 'UNREACHABLE' }, enablement: 'ENABLED', load: idleLoad }).reason, 'REFUSING_WORK');
});

test('RS-202: refusing and unreachable states come from the fleet/presence vocabularies, not a new one', () => {
  for (const state of ['FAILED', 'DISABLED', 'OFFLINE']) {
    assert.equal(evaluateEligibility({ device: { state, presence: 'ONLINE' }, enablement: 'ENABLED', load: idleLoad }).reason, 'REFUSING_WORK', state);
  }
  for (const presence of ['OFFLINE', 'SLEEPING', 'UNREACHABLE']) {
    assert.equal(evaluateEligibility({ device: { state: 'READY', presence }, enablement: 'ENABLED', load: idleLoad }).reason, 'UNREACHABLE', presence);
  }
});

/* ---------------------------------------------------------------- capacity, congestion, policy */

test('RS-202: session and provider concurrency ceilings are enforced independently', () => {
  assert.equal(ok({ sessionConcurrency: 0, providerConcurrency: 0 }).eligible, true);
  assert.equal(ok({ sessionConcurrency: 1 }).reason, 'AT_CAPACITY');
  assert.equal(ok({ providerConcurrency: 2 }).reason, 'AT_CAPACITY');
  assert.match(ok({ sessionConcurrency: 1 }).evidence.join(' '), /session concurrency 1 at ceiling 1/);
  // A raised policy ceiling admits the same load, proving the ceiling is policy and not a constant.
  assert.equal(ok({ sessionConcurrency: 1, policy: { ...DEFAULT_PRESSURE_POLICY, max_session_concurrency: 3 } }).eligible, true);
});

test('RS-202: a reachable but BUSY device is momentarily unsuitable rather than ineligible', () => {
  // BUSY is a REACHABLE state, so this is not a reachability refusal - it is the congestion case the
  // queue/alternate-device path exists to consume, and the reason says so.
  const busy = evaluateEligibility({ device: { state: 'READY', presence: 'BUSY' }, enablement: 'ENABLED', load: idleLoad });
  assert.equal(busy.reason, 'SESSION_CONGESTED');
  assert.equal(busy.eligible, false);
  assert.match(busy.evidence.join(' '), /presence=BUSY/);
});

test('RS-202: policy exclusion is reported as policy rather than hidden behind a resource reason', () => {
  const excluded = ok({ excludedByPolicy: true });
  assert.equal(excluded.reason, 'POLICY_EXCLUDED');
  assert.match(excluded.evidence.join(' '), /excluded by policy/);
});

/* ---------------------------------------------------------------- explainability and the boundary */

test('RS-202: every verdict is explainable - it carries its reasons and the evidence for them', () => {
  const verdict = evaluateEligibility({ device: { state: 'READY', presence: 'ONLINE' }, enablement: 'ENABLED', sessionConcurrency: 5, providerConcurrency: 5, load: { cpu: 0.95 } });
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.reasons.length >= 1);
  assert.ok(verdict.evidence.length >= 1, 'a refusal must carry evidence, not just a code');
  assert.equal(verdict.evidence.length, verdict.reasons.length);
  assert.equal(verdict.pressure_version, PRESSURE_CONTRACT_VERSION);
});

test('RS-202: the pressure input bundle exposes all six named factors in one place', () => {
  const inputs = buildPressureInputs({ device: healthyDevice, enablement: 'ENABLED', load: idleLoad, sessionConcurrency: 2, providerConcurrency: 1 });
  assert.deepEqual([...PRESSURE_FACTORS], ['SESSION_CONCURRENCY', 'PROVIDER_CONCURRENCY', 'DEVICE_LOAD', 'DEVICE_REACHABILITY', 'USER_ENABLEMENT', 'POLICY']);
  assert.deepEqual(Object.keys(inputs.factors).sort(), [...PRESSURE_FACTORS].sort());
  assert.equal(inputs.factors.SESSION_CONCURRENCY, 2);
  assert.equal(inputs.factors.USER_ENABLEMENT, 'ENABLED');
  assert.equal(inputs.verdict.eligible, false);
});

test('RS-202: eligibility stays a SCHEDULABILITY decision and never touches permission or trust', () => {
  // The workbook forbids crossing the Remote Fabric trust boundary, and the completion gate requires
  // that pressure may affect scheduling but must never rewrite permissions. Asserted structurally, so a
  // later change that smuggles a permission field into a verdict fails here rather than in production.
  const verdict = ok();
  const serialized = JSON.stringify(verdict).toLowerCase();
  for (const forbidden of ['trust', 'permission', 'scope', 'capability_grant', 'authorization']) {
    assert.equal(serialized.includes(forbidden), false, `a verdict must not carry ${forbidden}`);
  }
  assert.deepEqual(Object.keys(verdict).sort(), ['eligible', 'evidence', 'factors', 'load', 'pressure_version', 'reason', 'reasons'].sort());
  assert.equal(ELIGIBILITY_REASONS.includes('ELIGIBLE'), true);
});
