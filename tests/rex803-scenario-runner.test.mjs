// REX-803: the repetition engine's contracts - determinism, warmup exclusion, explained absences, explicit resume,
// stop that reaches the work, restart recovery, declared stop limits and immutable campaign receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createScenarioRunner, runSeed, ScenarioRunnerError, RUNNER_CODES, STOP_LIMITS} from '../services/dev-gateway/scenario-runner.mjs';

const scenarios = [{id: 'baseline-wait'}, {id: 'slow-scenario'}];
const settle = async (runner, ms = 500) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const state = runner.progress().state;
    if (state === 'COMPLETED' || state === 'STOPPED' || state === 'REFUSED' || state === 'INTERRUPTED' || state === 'FAILED') return runner.progress();
    await new Promise(r => setTimeout(r, 5));
  }
  return runner.progress();
};
const withDir = async fn => { const dir = await mkdtemp(resolve('.scratch-rex803-')); try { await fn(dir); } finally { await rm(dir, {recursive: true, force: true}); } };
/** The accounting invariant this module promises: a terminal campaign explains every planned run exactly once. */
const assertFullyAccounted = progress => {
  const {summary, totals} = progress;
  assert.equal(summary.planned, totals.planned);
  assert.equal(summary.accounted, summary.planned, `${progress.campaignId} must account for every planned run`);
  const classes = ['measured', 'warmup', 'timedOut', 'failed', 'excluded', 'cancelled', 'skipped', 'interrupted'];
  assert.equal(classes.reduce((total, key) => total + summary[key], 0), summary.planned, 'the classes must not overlap or double count');
  assert.equal(summary.terminalAccountingComplete, true);
};

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
    assert.equal(progress.reason, 'REPETITIONS_FINISHED');
    assert.equal(progress.totals.planned, 5);
    assert.equal(progress.totals.warmup, 2);
    assert.equal(progress.totals.measured, 3, 'only the non-warmup runs are measured outcomes');
    assert.equal(seen.length, 5, 'warmup runs still executed');
    // the same campaign seed reproduces the same run seeds in the same order
    assert.deepEqual(progress.measured.map(run => run.seed), [runSeed('fixed', 2), runSeed('fixed', 3), runSeed('fixed', 4)]);
    assertFullyAccounted(progress);
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
    assertFullyAccounted(progress);
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
    assertFullyAccounted(progress);
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
    assert.throws(() => runner.start({scenarioId: 'baseline-wait', repetitions: 1, limits: {maxFailures: 0}}), error => error.code === RUNNER_CODES.INVALID_LIMITS);
    assert.throws(() => runner.start({scenarioId: 'baseline-wait', repetitions: 1, limits: {madeUpLimit: 2}}), error => error.code === RUNNER_CODES.INVALID_LIMITS);

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
    // The drained campaign is replaceable again, and the refusal above did not leave the runner wedged.
    runner.start({scenarioId: 'baseline-wait', repetitions: 1});
    assert.equal((await settle(runner, 1000)).state, 'COMPLETED');
  });
});

test('REX803 stop: the cleanups a run registered are fired, so a stop reaches the work and not only the bookkeeping', async () => {
  await withDir(async dir => {
    const cleaned = [];
    const runner = createScenarioRunner({dir, scenarios, runOnce: async ({index, control}) => {
      cleaned.push(`run-${index}-registered`);
      control.onCancel(reason => cleaned.push(`run-${index}-cleaned:${reason}`));
      while (!control.cancelled()) await new Promise(r => setTimeout(r, 2));
      return {state: 'CANCELLED', reason: control.reason()};
    }});
    runner.start({scenarioId: 'baseline-wait', repetitions: 4, seed: 'cleanup'});
    await new Promise(r => setTimeout(r, 30));
    const stopped = runner.stop({reason: 'operator changed their mind'});
    assert.equal(stopped.stopped, true);
    assert.deepEqual(stopped.cleanupFailures, undefined, 'a cleanup that works is not reported as a failure');
    const progress = await settle(runner, 1000);
    assert.equal(progress.state, 'STOPPED');
    assert.ok(cleaned.some(entry => entry === 'run-0-registered'), 'the first run must have registered its cleanup');
    assert.ok(cleaned.includes('run-0-cleaned:operator changed their mind'), 'the stop must reach the work the run started');
    assertFullyAccounted(progress);
  });
});

test('REX803 timeout: a run that never answers is torn down, and its cleanup failure is stated rather than hidden', async () => {
  await withDir(async dir => {
    let cleaned = 0;
    const runner = createScenarioRunner({dir, scenarios, timeoutMs: 30, runOnce: async ({index, control}) => {
      control.onCancel(() => { cleaned += 1; if (index === 1) throw new Error('canonical cancel refused'); });
      return new Promise(() => {});
    }});
    runner.start({scenarioId: 'slow-scenario', repetitions: 2, seed: 'timeouts'});
    const progress = await settle(runner, 1500);
    assert.equal(progress.state, 'COMPLETED');
    assert.equal(cleaned, 2, 'every timed-out run must have its cleanup fired');
    assert.equal(progress.summary.timedOut, 2);
    const withCleanupFailure = progress.notMeasured.filter(run => /cleanup failed: canonical cancel refused/.test(run.reason));
    assert.equal(withCleanupFailure.length, 1, 'the cleanup failure is part of the run reason, not swallowed');
    assertFullyAccounted(progress);
  });
});

test('REX803 restart: a campaign left RUNNING by a dead process is recovered as INTERRUPTED, named, and optionally resumed', async () => {
  await withDir(async dir => {
    // The on-disk shape a process killed mid-run leaves behind: state RUNNING, the in-flight run has no row yet.
    const crashed = {
      campaignId: 'campaign-11111111-2222-4333-8444-555555555555', scenarioId: 'baseline-wait', state: 'RUNNING', reason: null,
      seedPolicy: 'derived:seed(campaign,index)', campaignSeed: 'crashed-seed', repetitions: 3, warmup: 0, timeout: 5000, limits: {},
      totalRuns: 3, runs: [{index: 0, state: 'MEASURED', reason: null, seed: runSeed('crashed-seed', 0), measured: true, result: {}}],
      startedAt: 1000, finishedAt: null, context: {experimentId: 'restart-experiment'}, resumeCount: 0,
    };
    await writeFile(join(dir, 'scenario-campaign.json'), JSON.stringify(crashed));
    const recovered = [];
    const runner = createScenarioRunner({dir, scenarios, cancelRun: info => recovered.push(info), runOnce: async () => ({state: 'MEASURED', result: {}})});
    const progress = runner.progress();
    assert.equal(progress.state, 'INTERRUPTED');
    assert.equal(progress.reason, 'PROCESS_RESTART');
    const interrupted = progress.notMeasured.find(run => run.state === 'INTERRUPTED');
    assert.ok(interrupted, 'the run that was in flight must be written down, not lost');
    assert.equal(interrupted.index, 1);
    assert.equal(interrupted.seed, runSeed('crashed-seed', 1));
    assert.deepEqual(recovered, [{campaignId: crashed.campaignId, scenarioId: 'baseline-wait', index: 1, context: {experimentId: 'restart-experiment'}}], 'the orphaned work is offered to the recovery hook');
    // Recovery is not a resume: a fresh start is still refused until someone decides.
    assert.throws(() => runner.start({scenarioId: 'baseline-wait', repetitions: 1}), error => error.code === RUNNER_CODES.RESUME_REQUIRED);
    // A resume continues THE SAME campaign from the same seed sequence, and the earlier run is kept. The repetition
    // the process died inside is NOT re-run: it stays INTERRUPTED, so the record shows that a measurement was lost
    // rather than quietly replacing it with a later one.
    const resumed = runner.start({scenarioId: 'baseline-wait', repetitions: 3, seed: 'crashed-seed', resume: true});
    assert.equal(resumed.campaignId, crashed.campaignId);
    assert.equal(resumed.campaignSeed, 'crashed-seed');
    assert.equal(resumed.remaining, 1);
    const done = await settle(runner, 1000);
    assert.equal(done.state, 'COMPLETED');
    assert.deepEqual(done.measured.map(run => [run.index, run.seed]), [[0, runSeed('crashed-seed', 0)], [2, runSeed('crashed-seed', 2)]]);
    assert.equal(done.resumeCount, 1);
    assert.equal(new Set(done.measured.map(run => run.index)).size, done.measured.length, 'no repetition may be counted twice across a resume');
    assert.equal(done.summary.interrupted, 1, 'the lost repetition stays visible in the resumed campaign');
    assertFullyAccounted(done);
    // Asking to resume a campaign that is already finished is refused rather than silently answered with a new one.
    assert.throws(() => runner.start({scenarioId: 'baseline-wait', repetitions: 1, resume: true}), error => error.code === RUNNER_CODES.NOTHING_TO_RESUME);
  });
});

test('REX803 resume: abandoning an unfinished campaign is an explicit act, and it is recorded on the replacement', async () => {
  await withDir(async dir => {
    const never = createScenarioRunner({dir, scenarios, timeoutMs: 20000, runOnce: ({control}) => new Promise(resolve => control.onCancel(reason => resolve({state: 'CANCELLED', reason})))});
    never.start({scenarioId: 'baseline-wait', repetitions: 2, seed: 'abandoned'});
    const restarted = createScenarioRunner({dir, scenarios, runOnce: async () => ({state: 'MEASURED', result: {}})});
    assert.equal(restarted.progress().state, 'INTERRUPTED');
    assert.throws(() => restarted.start({scenarioId: 'baseline-wait', repetitions: 1, resume: true, abandon: true}), error => error.code === RUNNER_CODES.RESUME_CONFLICT);
    const fresh = restarted.start({scenarioId: 'baseline-wait', repetitions: 1, seed: 'fresh', abandon: true});
    assert.equal(fresh.campaignSeed, 'fresh');
    const state = restarted.state();
    assert.ok(state.abandonedFrom.startsWith('campaign-'), 'the abandoned campaign is named on the replacement');
    const done = await settle(restarted, 1000);
    assert.equal(done.state, 'COMPLETED');
    const abandonedReceipt = await readFile(join(dir, 'campaigns', `${state.abandonedFrom}.json`), 'utf8');
    assert.match(abandonedReceipt, /PROCESS_RESTART/);
    await never.stop({reason: 'test cleanup'});
    await settle(never, 500);
  });
});

test('REX803 limits: declared stop conditions end the campaign early, and every unrun repetition is SKIPPED with that reason', async () => {
  await withDir(async dir => {
    let call = 0;
    const failing = createScenarioRunner({dir, scenarios, runOnce: async () => { call += 1; if (call > 1) throw new Error('provider unavailable'); return {state: 'MEASURED', result: {}}; }});
    failing.start({scenarioId: 'slow-scenario', repetitions: 10, seed: 'max-failures', limits: {maxFailures: 2}});
    const failed = await settle(failing, 2000);
    assert.equal(failed.state, 'COMPLETED');
    assert.equal(failed.reason, STOP_LIMITS.FAILURES);
    assert.equal(failed.summary.failed, 2);
    assert.equal(failed.summary.skipped, 7, 'the repetitions the limit cancelled must be present and explained');
    for (const run of failed.notMeasured.filter(run => run.state === 'SKIPPED')) assert.equal(run.reason, STOP_LIMITS.FAILURES);
    assertFullyAccounted(failed);

    const succeeding = createScenarioRunner({dir: join(dir, 'success'), scenarios, runOnce: async () => ({state: 'MEASURED', result: {}})});
    succeeding.start({scenarioId: 'baseline-wait', repetitions: 10, seed: 'enough', limits: {minSuccessfulRuns: 3}});
    const enough = await settle(succeeding, 2000);
    assert.equal(enough.reason, STOP_LIMITS.SUCCESS);
    assert.equal(enough.summary.measured, 3);
    assert.equal(enough.summary.skipped, 7);
    assertFullyAccounted(enough);

    const bounded = createScenarioRunner({dir: join(dir, 'wall'), scenarios, runOnce: async () => { await new Promise(r => setTimeout(r, 20)); return {state: 'MEASURED', result: {}}; }});
    bounded.start({scenarioId: 'baseline-wait', repetitions: 50, seed: 'wall', limits: {wallClockMs: 60}});
    const walled = await settle(bounded, 3000);
    assert.equal(walled.reason, STOP_LIMITS.WALL);
    assert.ok(walled.summary.measured >= 1 && walled.summary.measured < 50, `a wall limit must bound the campaign, got ${walled.summary.measured}`);
    assertFullyAccounted(walled);
  });
});

test('REX803 receipts: a finished campaign is filed once and the next campaign cannot overwrite it', async () => {
  await withDir(async dir => {
    const runner = createScenarioRunner({dir, scenarios, runOnce: async () => ({state: 'MEASURED', result: {ok: true}})});
    const first = runner.start({scenarioId: 'baseline-wait', repetitions: 2, seed: 'receipt-one'});
    const firstDone = await settle(runner, 1000);
    assert.equal(firstDone.state, 'COMPLETED');
    const filed = JSON.parse(await readFile(join(dir, 'campaigns', `${first.campaignId}.json`), 'utf8'));
    assert.equal(filed.campaignId, first.campaignId);
    assert.equal(filed.campaignSeed, 'receipt-one');
    assert.equal(filed.summary.measured, 2);
    assert.equal(runner.receipts().length, 1);
    assert.equal(runner.receipts()[0].campaignId, first.campaignId);
    assert.equal(runner.receipt(first.campaignId).summary.measured, 2);

    const second = runner.start({scenarioId: 'slow-scenario', repetitions: 1, seed: 'receipt-two'});
    await settle(runner, 1000);
    assert.notEqual(second.campaignId, first.campaignId);
    assert.equal(runner.receipts().length, 2);
    assert.equal(runner.receipt(first.campaignId).campaignSeed, 'receipt-one', 'the earlier receipt is immutable evidence');
    assert.throws(() => runner.receipt('../../etc/passwd'), error => error.code === RUNNER_CODES.UNKNOWN_CAMPAIGN);
    assert.throws(() => runner.receipt('campaign-not-a-real-id'), error => error.code === RUNNER_CODES.UNKNOWN_CAMPAIGN);
  });
});
