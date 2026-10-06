// REX-803: the repetition engine's contracts - determinism, warmup exclusion, explained absences, explicit resume.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createScenarioRunner, runSeed, ScenarioRunnerError, RUNNER_CODES} from '../services/dev-gateway/scenario-runner.mjs';

const scenarios = [{id: 'baseline-wait'}, {id: 'slow-scenario'}];
const settle = async (runner, ms = 500) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const state = runner.progress().state;
    if (state === 'COMPLETED' || state === 'STOPPED' || state === 'REFUSED') return runner.progress();
    await new Promise(r => setTimeout(r, 5));
  }
  return runner.progress();
};
const withDir = async fn => { const dir = await mkdtemp(resolve('.scratch-rex803-')); try { await fn(dir); } finally { await rm(dir, {recursive: true, force: true}); } };

test('REX803 seeds: a run seed is a pure function of the campaign seed and the index', () => {
  assert.equal(runSeed('alpha', 3), runSeed('alpha', 3), 'the same pair must always give the same seed');
  assert.notEqual(runSeed('alpha', 3), runSeed('alpha', 4));
  assert.notEqual(runSeed('alpha', 3), runSeed('beta', 3));
  assert.equal(Number.isSafeInteger(runSeed('alpha', 0)), true);
});

test('REX803 campaign: N repetitions yield exactly N measured outcomes, and warmup is run but never measured', async () => {
  await withDir(async dir => {
    const seen = [];
    const runner = createScenarioRunner({dir, scenarios, runOnce: async ({index, seed, warmup}) => { seen.push({index, seed, warmup}); return {state: 'MEASURED', result: {index}}; }});
    runner.start({scenarioId: 'baseline-wait', repetitions: 3, warmup: 2, seed: 'fixed'});
    const progress = await settle(runner);
    assert.equal(progress.state, 'COMPLETED');
    assert.equal(progress.totals.planned, 5);
    assert.equal(progress.totals.warmup, 2);
    assert.equal(progress.totals.measured, 3, 'only the non-warmup runs are measured outcomes');
    assert.equal(seen.length, 5, 'warmup runs still executed');
    assert.equal(progress.reason, null);
    // the same campaign seed reproduces the same run seeds in the same order
    assert.deepEqual(progress.measured.map(run => run.seed), [runSeed('fixed', 2), runSeed('fixed', 3), runSeed('fixed', 4)]);
  });
});

test('REX803 campaign: a timeout and a failure are absences WITH reasons, never silent gaps', async () => {
  await withDir(async dir => {
    let call = 0;
    const runner = createScenarioRunner({dir, scenarios, timeoutMs: 40, runOnce: async () => {
      call += 1;
      if (call === 1) return {state: 'MEASURED', result: {ok: true}};
      if (call === 2) return new Promise(() => {});            // never settles -> timeout
      throw new Error('scenario refused to start');            // failure
    }});
    runner.start({scenarioId: 'slow-scenario', repetitions: 3, seed: 'mixed'});
    const progress = await settle(runner, 1500);
    assert.equal(progress.state, 'COMPLETED');
    assert.equal(progress.totals.measured, 1);
    assert.equal(progress.totals.notMeasured, 2);
    const states = progress.notMeasured.map(run => run.state).sort();
    assert.deepEqual(states, ['FAILED', 'TIMEOUT']);
    for (const run of progress.notMeasured) assert.ok(run.reason, `${run.state} must carry a reason`);
    assert.match(progress.notMeasured.find(run => run.state === 'TIMEOUT').reason, /within 40ms/);
  });
});

test('REX803 campaign: stopping cancels the runs that never happened, each with the operator reason', async () => {
  await withDir(async dir => {
    const runner = createScenarioRunner({dir, scenarios, runOnce: async () => { await new Promise(r => setTimeout(r, 15)); return {state: 'MEASURED', result: {}}; }});
    runner.start({scenarioId: 'baseline-wait', repetitions: 8, seed: 'stop-me'});
    await new Promise(r => setTimeout(r, 20));
    const stopped = runner.stop({reason: 'operator aborted the campaign'});
    assert.equal(stopped.stopped, true);
    const progress = await settle(runner, 1500);
    assert.equal(progress.state, 'STOPPED');
    assert.equal(progress.reason, 'operator aborted the campaign');
    const cancelled = progress.notMeasured.filter(run => run.state === 'CANCELLED');
    assert.ok(cancelled.length >= 1, 'runs that never happened must appear as CANCELLED');
    for (const run of cancelled) assert.equal(run.reason, 'operator aborted the campaign');
    assert.ok(progress.totals.measured < 8, 'and they must not be counted as measured');
  });
});

test('REX803 campaign: an unfinished campaign is refused unless resuming is asked for explicitly', async () => {
  await withDir(async dir => {
    const runner = createScenarioRunner({dir, scenarios, runOnce: async () => { await new Promise(r => setTimeout(r, 50)); return {state: 'MEASURED', result: {}}; }});
    runner.start({scenarioId: 'baseline-wait', repetitions: 4, seed: 'first'});
    // A second runner on the same directory stands for a restarted process that finds the previous campaign unfinished.
    const restarted = createScenarioRunner({dir, scenarios, runOnce: async () => ({state: 'MEASURED', result: {}})});
    assert.ok(restarted.unfinished(), 'the unfinished campaign must be visible, not forgotten');
    assert.throws(() => restarted.start({scenarioId: 'baseline-wait', repetitions: 2}), error => {
      assert.ok(error instanceof ScenarioRunnerError);
      assert.equal(error.code, RUNNER_CODES.RESUME_REQUIRED);
      return true;
    });
    runner.stop({reason: 'test cleanup'});
    await settle(runner, 500);
    // With the earlier campaign finished, a fresh start is allowed without resume.
    const clean = createScenarioRunner({dir, scenarios, runOnce: async () => ({state: 'MEASURED', result: {}})});
    assert.equal(clean.unfinished(), null);
    clean.start({scenarioId: 'baseline-wait', repetitions: 1});
    assert.equal((await settle(clean)).state, 'COMPLETED');
  });
});

test('REX803 campaign: unknown scenarios, bad repetitions, a busy runner and an unready topology are typed refusals', async () => {
  await withDir(async dir => {
    let ready = 'READY';
    const runner = createScenarioRunner({dir, scenarios, readiness: () => ({state: ready}), runOnce: async () => ({state: 'MEASURED', result: {}})});
    assert.throws(() => runner.start({scenarioId: 'nope', repetitions: 1}), error => error.code === RUNNER_CODES.UNKNOWN_SCENARIO);
    assert.throws(() => runner.start({scenarioId: 'baseline-wait', repetitions: 0}), error => error.code === RUNNER_CODES.INVALID_REPETITIONS);
    assert.throws(() => runner.start({scenarioId: 'baseline-wait', repetitions: 2, warmup: 5}), error => error.code === RUNNER_CODES.INVALID_REPETITIONS);

    ready = 'DEGRADED';
    assert.throws(() => runner.start({scenarioId: 'baseline-wait', repetitions: 1}), error => {
      assert.equal(error.code, RUNNER_CODES.NOT_READY);
      return true;
    });
    assert.equal(runner.progress().state, 'REFUSED', 'a refused campaign is recorded rather than leaving no trace');
    assert.equal(runner.progress().reason, RUNNER_CODES.NOT_READY);

    ready = 'READY';
    runner.start({scenarioId: 'baseline-wait', repetitions: 6, seed: 'busy'});
    assert.throws(() => runner.start({scenarioId: 'baseline-wait', repetitions: 1}), error => error.code === RUNNER_CODES.ALREADY_RUNNING);
    runner.stop({reason: 'cleanup'});
    await settle(runner, 1000);
  });
});
