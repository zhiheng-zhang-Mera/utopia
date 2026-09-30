// Conformance tests for EM-009 — runtime ownership + health / restart / recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_RESTART_POLICY, HEALTH_STATES, REGISTRY_HEALTH, RESTART_REFUSALS, RuntimeSupervisorError,
  createHealthMonitor, createOwnershipRegistry, createRestartSupervisor, mapToRegistryHealth,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const at = ms => new Date(Date.parse(T0) + ms).toISOString();

/** A mutable clock so cooldown/backoff can be exercised deterministically. */
function clockFrom(start = 0) {
  const state = { ms: start };
  const clock = () => at(state.ms);
  clock.advance = ms => { state.ms += ms; return clock(); };
  clock.set = ms => { state.ms = ms; return clock(); };
  return clock;
}

/** A probe double: readings come from a table (or a function of the observation), so health is exercised
 * without any real process. */
function probeFrom(readingsByInstance) {
  const calls = [];
  const probe = ({ instance_ref, at: observed_at }) => {
    calls.push(instance_ref);
    const sample = readingsByInstance[instance_ref];
    if (sample instanceof Error) throw sample;
    return typeof sample === 'function' ? sample({ at: observed_at }) : sample;
  };
  return { probe, calls };
}

function processPort() {
  const signals = [];
  return {
    signals,
    port: Object.freeze({
      signal({ instance_ref, pid, signal, owner_token }) {
        signals.push({ instance_ref, pid, signal, owner_token });
        return { accepted: true, pid };
      },
    }),
  };
}

const ownedInstance = (ownership, { instance_ref = 'worker:1', pid = 4242, marker = 'start-1', owner_token = 'token-1' } = {}) => {
  ownership.claim({ instance_ref, owner_token, pid, process_start_marker: marker });
  return { instance_ref, pid, marker, owner_token };
};

test('authority is split: the monitor senses, the supervisor restarts, and neither can do the other', () => {
  const { probe } = probeFrom({ 'worker:1': { consecutive_failures: 3, confidence: 1, last_liveness_at: T0 } });
  const monitor = createHealthMonitor({ probe, clock: () => T0 });
  const ownership = createOwnershipRegistry({ clock: () => T0 });
  const { port } = processPort();
  const supervisor = createRestartSupervisor({ monitor, ownership, processes: port, checkpoint: { capture: () => ({ checkpoint_ref: 'cp:1' }) }, clock: () => T0 });

  // The monitor has no destructive surface at all.
  const monitorKeys = Object.keys(monitor);
  assert.deepEqual(monitorKeys.sort(), ['decidePressure', 'policy', 'readings', 'sense']);
  for (const forbidden of ['restart', 'kill', 'spawn', 'signal', 'terminate', 'execute']) {
    assert.equal(monitor[forbidden], undefined, `the monitor must not expose ${forbidden}`);
  }
  assert.equal(JSON.stringify(monitorKeys).match(/restart|kill|spawn/), null);
  // Source-level proof: the monitor factory never mentions a process signal or the supervisor.
  const source = readFileSync(new URL('../supervisor.mjs', import.meta.url), 'utf8');
  const monitorSource = source.slice(source.indexOf('export function createHealthMonitor'), source.indexOf('export function createOwnershipRegistry'));
  assert.equal(/signal\(|processes\.|createRestartSupervisor|\.kill\(/.test(monitorSource), false, 'the monitor source cannot execute a restart');

  // The supervisor owns no thresholds and cannot be handed a hand-made pressure decision.
  const supervisorKeys = Object.keys(supervisor);
  for (const forbidden of ['setThresholds', 'setPolicy', 'decidePressure', 'sense']) {
    assert.equal(supervisor[forbidden], undefined, `the supervisor must not expose ${forbidden}`);
  }
  const handMade = { kind: 'PRESSURE', instance_ref: 'worker:1', verdict: 'PRESSURE', action: 'RESTART', decided_at: T0, policy_ref: 'policy:mine', thresholds: {} };
  const refused = supervisor.restart({ decision: handMade, instance_ref: 'worker:1' });
  assert.equal(refused.refused, true);
  assert.equal(refused.code, 'PRESSURE_REQUIRED', 'a decision the monitor did not mint is not authority to restart');
  assert.equal(refused.process_signalled, false);

  // A reading the monitor never produced cannot be turned into pressure.
  assert.throws(
    () => monitor.decidePressure({ reading: { reading_id: 'reading:999', instance_ref: 'worker:1', health: 'CRITICAL', confidence: 1, freshness: { stale: false } } }),
    error => error.code === 'INVALID_PRESSURE',
  );

  // The real path works: sense -> decide -> restart.
  const reading = monitor.sense({ instance_ref: 'worker:1' });
  assert.equal(reading.health, 'CRITICAL');
  assert.equal(reading.registry_health, 'UNHEALTHY');
  const decision = monitor.decidePressure({ reading });
  assert.equal(decision.verdict, 'PRESSURE');
  assert.equal(decision.action, 'RESTART');
  assert.equal(decision.destructive_authority, false, 'a pressure decision is not itself a restart');
  assert.equal(decision.restart_executed, false);
  assert.equal(decision.policy_ref, 'policy:default');
  assert.deepEqual(HEALTH_STATES, ['HEALTHY', 'ELEVATED', 'DEGRADED', 'CRITICAL', 'UNKNOWN']);
  assert.deepEqual(REGISTRY_HEALTH, ['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN']);
  assert.equal(mapToRegistryHealth('ELEVATED'), 'DEGRADED');
  assert.equal(mapToRegistryHealth('CRITICAL'), 'UNHEALTHY');
  assert.equal(mapToRegistryHealth('WHATEVER'), 'UNKNOWN');
});

test('a stale or reused pid is never signalled', () => {
  const ownership = createOwnershipRegistry({ clock: () => T0 });
  const { probe } = probeFrom({ 'worker:1': { consecutive_failures: 3, confidence: 1, last_liveness_at: T0 } });
  const monitor = createHealthMonitor({ probe, clock: () => T0 });
  const { signals, port } = processPort();
  const supervisor = createRestartSupervisor({ monitor, ownership, processes: port, checkpoint: { capture: () => ({ checkpoint_ref: 'cp:1' }) }, clock: () => T0 });
  const instance = ownedInstance(ownership);
  const decision = monitor.decidePressure({ reading: monitor.sense({ instance_ref: instance.instance_ref }) });

  // No live process with that pid: stale ownership, no signal.
  const stale = supervisor.restart({ decision, instance_ref: instance.instance_ref, live_processes: [] });
  assert.equal(stale.refused, true);
  assert.equal(stale.code, 'STALE_OWNERSHIP');
  assert.equal(stale.process_signalled, false);

  // A reused pid is a DIFFERENT process: refuse and do not touch it.
  const reused = supervisor.restart({ decision, instance_ref: instance.instance_ref, live_processes: [{ pid: 4242, process_start_marker: 'start-OTHER' }] });
  assert.equal(reused.refused, true);
  assert.equal(reused.code, 'PID_REUSED');
  assert.equal(reused.ownership.live_start_marker, 'start-OTHER');
  assert.equal(reused.process_signalled, false);
  assert.equal(signals.length, 0, 'an unrelated process was never signalled');

  // A different owner token may not drive the instance either.
  const impostor = supervisor.restart({ decision, instance_ref: instance.instance_ref, owner_token: 'token-other', live_processes: [{ pid: 4242, process_start_marker: 'start-1' }] });
  assert.equal(impostor.code, 'NOT_THE_OWNER');
  assert.equal(signals.length, 0);

  // Only the exact live process is restarted.
  const ok = supervisor.restart({ decision, instance_ref: instance.instance_ref, live_processes: [{ pid: 4242, process_start_marker: 'start-1' }] });
  assert.equal(ok.restarted, true);
  assert.equal(ok.pid, 4242);
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0], { instance_ref: 'worker:1', pid: 4242, signal: 'RESTART', owner_token: 'token-1' });
  assert.equal(ownership.get('worker:1').process_start_marker, 'start-1');
});

test('the restart budget ends in safe mode instead of an infinite loop', () => {
  const clock = clockFrom();
  const ownership = createOwnershipRegistry({ clock });
  // Liveness follows the observation instant, so a long wait does not turn the crash loop into "stale".
  const { probe } = probeFrom({ 'worker:1': ({ at: observed_at }) => ({ consecutive_failures: 3, confidence: 1, last_liveness_at: observed_at }) });
  const monitor = createHealthMonitor({ probe, clock });
  const { signals, port } = processPort();
  const supervisor = createRestartSupervisor({
    monitor,
    ownership,
    processes: port,
    checkpoint: { capture: () => ({ checkpoint_ref: 'cp:1' }) },
    clock,
    policy: { max_restarts: 3, cooldown_ms: 0, backoff_base_ms: 1000, backoff_factor: 2, backoff_cap_ms: 8000 },
  });
  const instance = ownedInstance(ownership);
  const live = [{ pid: 4242, process_start_marker: 'start-1' }];

  // A crash loop: every attempt is refused until the backoff has elapsed, and the loop terminates.
  const outcomes = [];
  const attempt = () => {
    const decision = monitor.decidePressure({ reading: monitor.sense({ instance_ref: instance.instance_ref }) });
    return supervisor.restart({ decision, instance_ref: instance.instance_ref, live_processes: live });
  };
  outcomes.push(attempt());
  assert.equal(outcomes.at(-1).restarted, true);
  assert.equal(outcomes.at(-1).restarts, 1);

  const tooSoon = attempt();
  assert.equal(tooSoon.refused, true);
  assert.equal(tooSoon.code, 'COOLDOWN_ACTIVE');
  assert.equal(tooSoon.retry_after_ms, 1000);
  assert.equal(tooSoon.process_signalled, false);

  clock.advance(1000);
  outcomes.push(attempt());
  assert.equal(outcomes.at(-1).restarts, 2);
  clock.advance(2000);
  outcomes.push(attempt());
  assert.equal(outcomes.at(-1).restarts, 3);

  clock.advance(4000);
  const exhausted = attempt();
  assert.equal(exhausted.refused, true);
  assert.equal(exhausted.code, 'RESTART_BUDGET_EXHAUSTED');
  assert.equal(exhausted.safe_mode, true);
  assert.equal(supervisor.stateFor(instance.instance_ref).runtime_state, 'SAFE_MODE');
  assert.equal(supervisor.stateFor(instance.instance_ref).restarts, 3, 'the budget is a hard bound');

  // Safe mode is terminal for restarts: no further signal, however long we wait.
  clock.advance(600000);
  const stillSafe = attempt();
  assert.equal(stillSafe.code, 'SAFE_MODE_ACTIVE');
  assert.equal(stillSafe.process_signalled, false);
  assert.equal(signals.length, 3, 'exactly the budgeted number of restarts was ever signalled');
  assert.equal(supervisor.stateFor(instance.instance_ref).safe_mode_reason.includes('budget exhausted'), true);
  assert.equal(supervisor.journal().filter(entry => entry.event === 'RESTART_EXECUTED').length, 3);
  assert.deepEqual(DEFAULT_RESTART_POLICY.max_restarts, 3);
  assert.ok(RESTART_REFUSALS.includes('RESTART_BUDGET_EXHAUSTED'));
});

test('resume happens only after a checkpoint and a readiness confirmation', () => {
  const clock = clockFrom();
  const ownership = createOwnershipRegistry({ clock });
  const { probe } = probeFrom({ 'worker:1': { consecutive_failures: 3, confidence: 1, last_liveness_at: T0 } });
  const monitor = createHealthMonitor({ probe, clock });
  const live = [{ pid: 4242, process_start_marker: 'start-1' }];
  const instance = ownedInstance(ownership);
  const decision = () => monitor.decidePressure({ reading: monitor.sense({ instance_ref: instance.instance_ref }) });

  // No checkpoint hook: no restart at all.
  const noCheckpoint = createRestartSupervisor({ monitor, ownership, processes: processPort().port, clock });
  const refused = noCheckpoint.restart({ decision: decision(), instance_ref: instance.instance_ref, live_processes: live });
  assert.equal(refused.code, 'CHECKPOINT_REQUIRED');
  assert.equal(refused.process_signalled, false);

  // A failing checkpoint also stops the restart.
  const badCheckpoint = createRestartSupervisor({ monitor, ownership, processes: processPort().port, checkpoint: { capture() { throw new Error('disk full'); } }, clock });
  const failed = badCheckpoint.restart({ decision: decision(), instance_ref: instance.instance_ref, live_processes: live });
  assert.equal(failed.code, 'CHECKPOINT_FAILED');
  assert.equal(failed.process_signalled, false);

  // Checkpoint captured, but readiness not confirmed: the instance stays suspended.
  const { signals, port } = processPort();
  const cautious = createRestartSupervisor({ monitor, ownership, processes: port, checkpoint: { capture: () => ({ checkpoint_ref: 'cp:7' }) }, readiness: { confirm: () => false }, clock });
  const withheld = cautious.restart({ decision: decision(), instance_ref: instance.instance_ref, live_processes: live });
  assert.equal(withheld.restarted, true);
  assert.equal(withheld.checkpoint_ref, 'cp:7');
  assert.equal(withheld.resumed, false, 'a restart is not a resume');
  assert.equal(withheld.resume_withheld_reason, 'READINESS_NOT_CONFIRMED');
  assert.equal(withheld.runtime_state, 'SUSPENDED');
  assert.equal(withheld.readiness_confirmed, false);
  assert.equal(signals.length, 1, 'the process was restarted but work was not resumed');

  // Readiness confirmed: the instance returns to RUNNING.
  let ready = false;
  const full = createRestartSupervisor({ monitor, ownership, processes: processPort().port, checkpoint: { capture: () => ({ checkpoint_ref: 'cp:8' }) }, readiness: { confirm: () => ({ ready }) }, clock });
  const pending = full.restart({ decision: decision(), instance_ref: instance.instance_ref, live_processes: live });
  assert.equal(pending.runtime_state, 'SUSPENDED');
  ready = true;
  clock.advance(DEFAULT_RESTART_POLICY.backoff_base_ms);
  const resumed = full.restart({ decision: decision(), instance_ref: instance.instance_ref, live_processes: live });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.runtime_state, 'RUNNING');
  assert.equal(resumed.resume_withheld_reason, null);
  assert.equal(full.stateFor(instance.instance_ref).checkpoints.length, 2, 'every restart captured its own checkpoint');
});

test('a terminal job does not resurrect after recovery', () => {
  const clock = clockFrom();
  const { probe } = probeFrom({});
  const monitor = createHealthMonitor({ probe, clock });
  const ownership = createOwnershipRegistry({ clock });
  const supervisor = createRestartSupervisor({ monitor, ownership, processes: processPort().port, checkpoint: { capture: () => ({ checkpoint_ref: 'cp:1' }) }, clock });

  // A recovered local queue still lists a job that authoritative state says is finished.
  const reconciled = supervisor.reconcileQueue({
    active: [{ job_ref: 'job:1' }, { job_ref: 'job:2' }, { job_ref: 'job:3' }],
    terminal: [{ job_ref: 'job:2', state: 'SUCCEEDED' }, 'job:3'],
  });
  assert.deepEqual(reconciled.resumed_jobs, ['job:1']);
  assert.deepEqual(reconciled.dropped_terminal_jobs, ['job:2', 'job:3']);
  assert.equal(reconciled.terminal_did_not_resurrect, true);
  assert.equal(reconciled.authoritative_state_wins, true);
  assert.equal(supervisor.reconcileQueue({ active: [{ job_ref: 'job:9' }], terminal: [] }).resumed_jobs.includes('job:9'), true);
  // A malformed terminal list is refused rather than silently read as "nothing is terminal".
  assert.throws(() => supervisor.reconcileQueue({ active: [], terminal: 'job:1' }), error => error.code === 'INVALID_INSTANCE');
  assert.throws(() => supervisor.reconcileQueue({ active: 'job:1', terminal: [] }), error => error.code === 'INVALID_INSTANCE');
  const stillTerminal = supervisor.reconcileQueue({ active: [{ job_ref: 'job:2' }], terminal: [{ job_ref: 'job:2' }] });
  assert.deepEqual(stillTerminal.resumed_jobs, []);
  assert.equal(stillTerminal.terminal_did_not_resurrect, true);
});

test('one crashed connector never terminates unrelated connectors', () => {
  const clock = clockFrom();
  const ownership = createOwnershipRegistry({ clock });
  const { probe } = probeFrom({
    'worker:1': { consecutive_failures: 3, confidence: 1, last_liveness_at: T0 },
    'worker:2': { consecutive_failures: 0, confidence: 1, last_liveness_at: T0 },
  });
  const monitor = createHealthMonitor({ probe, clock });
  const { signals, port } = processPort();
  const supervisor = createRestartSupervisor({ monitor, ownership, processes: port, checkpoint: { capture: () => ({ checkpoint_ref: 'cp:1' }) }, readiness: { confirm: () => true }, clock });
  ownedInstance(ownership, { instance_ref: 'worker:1', pid: 111, marker: 'start-1', owner_token: 'token-1' });
  ownedInstance(ownership, { instance_ref: 'worker:2', pid: 222, marker: 'start-2', owner_token: 'token-2' });
  const live = [{ pid: 111, process_start_marker: 'start-1' }, { pid: 222, process_start_marker: 'start-2' }];

  const first = monitor.sense({ instance_ref: 'worker:1' });
  const second = monitor.sense({ instance_ref: 'worker:2' });
  assert.equal(first.health, 'CRITICAL');
  assert.equal(second.health, 'HEALTHY');
  assert.equal(second.registry_health, 'HEALTHY');

  // A healthy instance produces no pressure, so it cannot even be restarted by accident.
  const noPressure = monitor.decidePressure({ reading: second });
  assert.equal(noPressure.verdict, 'NONE');
  assert.equal(noPressure.action, 'OBSERVE');
  assert.equal(supervisor.restart({ decision: noPressure, instance_ref: 'worker:2', live_processes: live }).code, 'PRESSURE_REQUIRED');

  const supervised = supervisor.supervise({
    instances: ['worker:1', 'worker:2'],
    decisions: [monitor.decidePressure({ reading: first }), noPressure],
    live_processes: live,
  });
  assert.deepEqual(supervised.restarted, ['worker:1']);
  assert.deepEqual(supervised.untouched, ['worker:2']);
  assert.deepEqual(supervised.other_instances_terminated, []);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].pid, 111, 'only the unhealthy instance was signalled');
  assert.equal(supervisor.stateFor('worker:2').runtime_state, 'RUNNING');
  assert.equal(supervisor.stateFor('worker:2').restarts, 0);
  assert.equal(supervisor.stateFor('worker:1').runtime_state, 'RUNNING', 'the restarted instance is back and resumed');

  // An unproven probe is UNKNOWN and never HEALTHY.
  const broken = createHealthMonitor({ probe: () => { throw new Error('probe blew up'); }, clock });
  const unknown = broken.sense({ instance_ref: 'worker:3' });
  assert.equal(unknown.health, 'UNKNOWN');
  assert.equal(unknown.confidence, 0);
  assert.equal(unknown.probe_failed, true);
  assert.equal(broken.decidePressure({ reading: unknown }).verdict, 'NONE', 'an unknown reading can never justify a restart');
  assert.equal(unknown.registry_health, 'UNKNOWN');
});

test('the contract is strict, frozen, and honest about stale observations', () => {
  const clock = clockFrom();
  const { probe } = probeFrom({ 'worker:1': { consecutive_failures: 3, confidence: 1, last_liveness_at: T0 } });
  const monitor = createHealthMonitor({ probe, clock });
  const ownership = createOwnershipRegistry({ clock });
  const { port } = processPort();
  const supervisor = createRestartSupervisor({ monitor, ownership, processes: port, checkpoint: { capture: () => ({ checkpoint_ref: 'cp:1' }) }, clock });

  // A stale liveness timestamp is UNKNOWN rather than CRITICAL: old evidence is not pressure.
  clock.advance(60000);
  const stale = monitor.sense({ instance_ref: 'worker:1' });
  assert.equal(stale.health, 'UNKNOWN');
  assert.equal(stale.freshness.stale, true);
  assert.equal(stale.registry_health, 'UNKNOWN');
  assert.equal(monitor.decidePressure({ reading: stale }).verdict, 'NONE');

  // Low confidence cannot drive a restart either.
  const shy = createHealthMonitor({ probe: () => ({ consecutive_failures: 9, confidence: 0.1, last_liveness_at: T0 }), clock: () => T0 });
  const shyReading = shy.sense({ instance_ref: 'worker:1' });
  assert.equal(shyReading.health, 'UNKNOWN');
  assert.equal(shy.decidePressure({ reading: shyReading }).verdict, 'NONE');

  // Strict shapes.
  assert.throws(() => createHealthMonitor({ }), error => error.code === 'INVALID_PRESSURE');
  assert.throws(() => createHealthMonitor({ probe: () => ({}), clock: 'now' }), error => error.code === 'INVALID_PRESSURE');
  assert.throws(() => ownerless(), error => error.code === 'INVALID_OWNERSHIP');
  function ownerless() { return createOwnershipRegistry({ clock: () => T0 }).claim({ instance_ref: 'w', owner_token: 't', pid: 0, process_start_marker: 'm' }); }
  assert.throws(() => createRestartSupervisor({ ownership, processes: port }), error => error.code === 'INVALID_PRESSURE');
  assert.throws(() => createRestartSupervisor({ monitor, processes: port }), error => error.code === 'INVALID_OWNERSHIP');
  assert.throws(() => createRestartSupervisor({ monitor, ownership }), error => error.code === 'INVALID_INSTANCE');
  assert.throws(() => supervisor.stateFor('worker:nope'), error => error.code === 'UNKNOWN_INSTANCE');
  assert.throws(() => monitor.sense({}), error => error.code === 'INVALID_INSTANCE');
  assert.throws(() => monitor.sense({ instance_ref: 'worker:1', at: 'yesterday' }), error => error.code === 'INVALID_PRESSURE');
  assert.throws(() => supervisor.restart({}), error => error.code === 'INVALID_INSTANCE');

  const state = supervisor.reconcileQueue({ active: [], terminal: [] });
  assert.throws(() => { state.resumed_jobs.push('x'); }, TypeError, 'records are frozen');
  assert.equal(supervisor.policy().max_restarts, DEFAULT_RESTART_POLICY.max_restarts);
  assert.equal(monitor.policy().policy_ref, 'policy:default');
  assert.equal(ownership.get('worker:1'), null, 'no claim, no ownership record');
  assert.ok(RESTART_REFUSALS.includes('POLICY_IS_MONITOR_OWNED'));
  assert.equal(typeof RuntimeSupervisorError, 'function');
});
