// REX-803: the controlled scenario runner and repetition engine.
//
// WHAT IT IS FOR. A research claim about "this behaves better under condition X" is only reproducible if the campaign,
// not the individual run, is the unit of evidence: the same scenario, run N times under a stated seed policy, with the
// warmup runs excluded, every excluded or failed run carrying its reason, and a receipt that says what was actually
// measured. This module produces exactly that, and it is deliberately NOT a scheduler: it never touches canonical task
// truth, never enqueues work behind a global lock, and never resumes a campaign on its own.
//
// THE RULES THAT SHAPE THE CODE:
//   1. SEEDS ARE DERIVED, NOT DRAWN. Every run's seed is a pure function of (campaign seed, run index), so repeating a
//      campaign with the same seed reproduces the same sequence - and a run can be replayed in isolation.
//   2. WARMUP IS NOT MEASURED. Warmup runs execute but are excluded from the measured outcome set, by name, so a
//      "result" can never silently include a run that was only there to bring the system up to temperature.
//   3. ABSENCE OF A RUN IS ALWAYS EXPLAINED. A run that did not produce a measured outcome carries a typed reason
//      (timeout, excluded, cancelled, skipped, interrupted, not-ready), because "N repetitions" with fewer measured
//      runs is exactly the kind of gap a reader must be able to see.
//   4. RESUMING IS AN EXPLICIT DECISION. If a previous campaign for the same scenario is still unfinished, starting
//      again is REFUSED unless the caller either resumes it or explicitly abandons it, so a campaign cannot quietly
//      continue from a state nobody chose - and cannot quietly throw away work nobody agreed to lose.
//   5. LONG CAMPAIGNS DO NOT BLOCK. Runs are driven by an asynchronous loop with a yield between runs; `start`
//      returns the receipt of the campaign immediately, progress is inspectable at any time, and a stop is honoured
//      before the next run starts.
//   6. STOPPING HAS TO REACH THE WORK, NOT JUST THE LOOP. A run may have started real work elsewhere (in this product,
//      a canonical City task). The runner therefore hands every run a `control` handle it can register its cleanup
//      with, and fires those cleanups when the run times out or the campaign is stopped - otherwise "stopped" would
//      mean "no longer counted" while the work kept running.
//   7. A RESTART IS A FIRST-CLASS OUTCOME. A campaign left RUNNING by a process that died is recovered as
//      INTERRUPTED, the single run that was in flight is named, and any work that run had started is offered to the
//      `cancelRun` hook. Resuming continues the SAME campaign from the same seed sequence, so an interrupted campaign
//      and an uninterrupted one produce identical seeds for identical indices.
//   8. EVERY FINISHED CAMPAIGN LEAVES A RECEIPT. The live state file is overwritten as the campaign progresses; a
//      finished campaign is additionally written once, immutably, under `campaigns/`, so evidence is not destroyed by
//      the next campaign.
//
// PURITY. No randomness in any measured value and no clock inside the seed derivation: `clock` is injected, and the
// seeds depend only on the campaign seed and the run index. The runner executes nothing itself; `runOnce` is supplied.
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';

export const RUN_STATES = Object.freeze(['MEASURED', 'WARMUP', 'TIMEOUT', 'FAILED', 'EXCLUDED', 'CANCELLED', 'SKIPPED', 'INTERRUPTED']);
export const CAMPAIGN_STATES = Object.freeze(['RUNNING', 'COMPLETED', 'STOPPED', 'REFUSED', 'INTERRUPTED', 'FAILED']);

/** A stop limit derived from an experiment's declared stop conditions, named exactly as the manifest names it. */
export const STOP_LIMITS = Object.freeze({WALL: 'MAX_WALL_CLOCK_MS', FAILURES: 'MAX_FAILURES', SUCCESS: 'MIN_SUCCESSFUL_RUNS'});
const LIMIT_KEYS = Object.freeze(['wallClockMs', 'maxFailures', 'minSuccessfulRuns']);
/** A campaign receipt is a file whose name this module wrote; anything else in the directory is not adopted. */
const RECEIPT_FILE = /^campaign-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

export const RUNNER_CODES = Object.freeze({
  UNKNOWN_SCENARIO: 'SCENARIO_UNKNOWN',
  INVALID_REPETITIONS: 'REPETITIONS_INVALID',
  NOT_READY: 'TOPOLOGY_NOT_READY',
  RESUME_REQUIRED: 'RESUME_REQUIRED',
  ALREADY_RUNNING: 'CAMPAIGN_ALREADY_RUNNING',
  INVALID_LIMITS: 'LIMITS_INVALID',
  RESUME_CONFLICT: 'RESUME_CONFLICT',
  NOTHING_TO_RESUME: 'NOTHING_TO_RESUME',
  UNKNOWN_CAMPAIGN: 'CAMPAIGN_UNKNOWN',
});

export class ScenarioRunnerError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ScenarioRunnerError';
    this.code = code;
    this.detail = detail;
    // The transport meaning of each refusal lives here, with the refusal, for the same reason the manifest contract
    // carries its own: a caller must not have to re-derive which refusal is a conflict and which is a bad field.
    this.status = code === RUNNER_CODES.UNKNOWN_CAMPAIGN ? 404
      : code === RUNNER_CODES.ALREADY_RUNNING || code === RUNNER_CODES.NOT_READY || code === RUNNER_CODES.RESUME_REQUIRED || code === RUNNER_CODES.RESUME_CONFLICT || code === RUNNER_CODES.NOTHING_TO_RESUME ? 409
        : 422;
  }
}

/** A seed that depends only on the campaign seed and the run index: the same pair always yields the same number. */
export function runSeed(campaignSeed, index) {
  let hash = 2166136261 >>> 0;
  for (const character of `${campaignSeed}:${index}`) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

const copy = value => JSON.parse(JSON.stringify(value));

export function createScenarioRunner({dir = '.runtime/research', scenarios = [], runOnce, readiness = () => ({state: 'READY'}), cancelRun = null, onRunRecord = null, clock = () => Date.now(), timeoutMs = 30000, receiptLimit = 50} = {}) {
  if (typeof runOnce !== 'function') throw new TypeError('runOnce is required: the runner executes scenarios, it does not invent them');
  const scenarioById = new Map(scenarios.map(scenario => [scenario.id, scenario]));
  const file = resolve(dir, 'scenario-campaign.json');
  const receiptDir = resolve(dir, 'campaigns');
  let campaign = null;
  /** Set to the operator's reason while a stop is in flight. It is the reason every later run cites. */
  let cancelled = null;
  /** Cleanups registered by the run that is executing right now. Replaced at the start of every run. */
  let runHandles = new Set();
  /** Non-null once the current run has been torn down (timed out or stopped), so a LATE registration still runs. */
  let runAborted = null;
  /** True while a drive loop is draining. A campaign is not replaceable until its own loop has written its last row. */
  let driving = false;

  const persist = () => {
    if (!campaign) return;
    mkdirSync(dir, {recursive: true});
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify(campaign), {mode: 0o600});
    renameSync(temporary, file);
  };

  /** One finished campaign, written once under its own name so the next campaign cannot overwrite the evidence. */
  function writeReceipt(record) {
    mkdirSync(receiptDir, {recursive: true});
    const target = resolve(receiptDir, `${record.campaignId}.json`);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(record, null, 2), {mode: 0o600});
    renameSync(temporary, target);
    return target;
  }

  /**
   * Every planned run lands in exactly one state, so a reader can add the classes up and reach `planned`. A run that
   * was never attempted because a stop condition ended the campaign is SKIPPED, not missing.
   */
  function summaryOf(record) {
    const count = state => record.runs.filter(run => run.state === state).length;
    const summary = {
      planned: record.totalRuns,
      accounted: record.runs.length,
      warmup: count('WARMUP'),
      measured: count('MEASURED'),
      timedOut: count('TIMEOUT'),
      failed: count('FAILED'),
      excluded: count('EXCLUDED'),
      cancelled: count('CANCELLED'),
      skipped: count('SKIPPED'),
      interrupted: count('INTERRUPTED'),
    };
    return {...summary, terminalAccountingComplete: summary.accounted === summary.planned};
  }

  function finish(state, reason) {
    campaign.state = state;
    campaign.reason = reason;
    campaign.finishedAt = clock();
    campaign.summary = summaryOf(campaign);
    persist();
    try {
      writeReceipt(copy(campaign));
      campaign.receipt = resolve(receiptDir, `${campaign.campaignId}.json`);
    } catch (error) {
      // A campaign that ran but could not be filed is still reported as run: the failure to file is stated on the
      // record rather than substituted for the outcome.
      campaign.receipt = null;
      campaign.receiptFailure = String(error?.code ?? 'RECEIPT_WRITE_FAILED');
    }
    persist();
    return campaign;
  }

  /** The one place a settled run is announced, so a recorder cannot miss a run that ended by timeout or stop. */
  function announce(record, run) {
    if (typeof onRunRecord !== 'function') return;
    try { onRunRecord({campaign: record, run}); }
    catch (error) { run.recordFailure = String(error?.code ?? error?.message ?? 'RUN_RECORD_FAILED'); }
  }

  /** Fire every cleanup the current run registered, once, and forget them. A throwing cleanup must not stop the rest. */
  function fireCancels(reason) {
    runAborted = reason;
    const handles = [...runHandles];
    runHandles = new Set();
    const failures = [];
    for (const handle of handles) {
      try { handle(reason); } catch (error) { failures.push(String(error?.message ?? error)); }
    }
    return failures;
  }

  /** Was this campaign ended early by one of its own declared stop limits? Returns the limit's name, or null. */
  function limitReached(startedAt) {
    const limits = campaign?.limits ?? {};
    if (Number.isSafeInteger(limits.wallClockMs) && clock() - startedAt >= limits.wallClockMs) return STOP_LIMITS.WALL;
    if (Number.isSafeInteger(limits.maxFailures) && campaign.runs.filter(run => ['FAILED', 'TIMEOUT'].includes(run.state)).length >= limits.maxFailures) return STOP_LIMITS.FAILURES;
    if (Number.isSafeInteger(limits.minSuccessfulRuns) && campaign.runs.filter(run => run.measured).length >= limits.minSuccessfulRuns) return STOP_LIMITS.SUCCESS;
    return null;
  }

  function normalizeLimits(limits) {
    if (limits === null || limits === undefined) return {};
    if (typeof limits !== 'object' || Array.isArray(limits)) throw new ScenarioRunnerError(RUNNER_CODES.INVALID_LIMITS, 'limits must be an object', {limits});
    for (const [key, value] of Object.entries(limits)) {
      if (!LIMIT_KEYS.includes(key)) throw new ScenarioRunnerError(RUNNER_CODES.INVALID_LIMITS, `unknown stop limit ${key}`, {known: [...LIMIT_KEYS]});
      if (value === null || value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 1) throw new ScenarioRunnerError(RUNNER_CODES.INVALID_LIMITS, `${key} must be a positive integer`, {key, value});
    }
    return Object.fromEntries(Object.entries(limits).filter(([, value]) => value !== null && value !== undefined));
  }

  /**
   * The persistent record of an unfinished campaign, read from disk rather than from memory: a restarted process has
   * no memory of the campaign it left behind, and that is exactly the case this has to cover.
   */
  function unfinished() {
    if (!existsSync(file)) return null;
    try {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      return record?.state === 'RUNNING' || record?.state === 'INTERRUPTED' ? record : null;
    } catch { return {state: 'INTERRUPTED', campaignId: null, unreadable: true}; }
  }

  /**
   * Recovery runs at construction. A record still marked RUNNING belongs to a process that is gone - this constructor
   * is the new process - so the campaign becomes INTERRUPTED and the one run that was in flight is written down. The
   * remaining planned runs are deliberately NOT written: they were never started, the campaign is not terminal, and
   * pretending otherwise would fill the receipt with runs that never happened.
   */
  function recover() {
    const record = unfinished();
    if (!record || record.unreadable === true) return record;
    if (record.state === 'RUNNING') {
      const index = record.runs.length;
      if (index < record.totalRuns) {
        const run = {index, state: 'INTERRUPTED', reason: 'PROCESS_RESTART', seed: runSeed(record.campaignSeed, index), warmup: index < record.warmup, measured: false, durationMs: null, result: null};
        record.runs.push(run);
        if (typeof cancelRun === 'function') {
          try { cancelRun({campaignId: record.campaignId, scenarioId: record.scenarioId, index, context: record.context ?? null}); }
          catch (error) { record.recoveryCancelFailure = String(error?.message ?? error); }
        }
        campaign = record;
        announce(record, run);
      }
      record.state = 'INTERRUPTED';
      record.reason = 'PROCESS_RESTART';
      record.finishedAt = clock();
      record.summary = summaryOf(record);
      campaign = record;
      persist();
      finish('INTERRUPTED', 'PROCESS_RESTART');
    } else {
      campaign = record;
    }
    return record;
  }
  recover();

  function start({scenarioId, repetitions, warmup = 0, resume = false, abandon = false, seed = null, timeout = timeoutMs, limits = null, context = null} = {}) {
    const scenario = scenarioById.get(scenarioId);
    if (!scenario) throw new ScenarioRunnerError(RUNNER_CODES.UNKNOWN_SCENARIO, `Unknown scenario ${String(scenarioId)}`, {known: [...scenarioById.keys()]});
    if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10000) throw new ScenarioRunnerError(RUNNER_CODES.INVALID_REPETITIONS, 'repetitions must be an integer in 1..10000', {repetitions});
    if (!Number.isSafeInteger(warmup) || warmup < 0 || warmup > repetitions) throw new ScenarioRunnerError(RUNNER_CODES.INVALID_REPETITIONS, 'warmup must be an integer in 0..repetitions', {warmup});
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600000) throw new ScenarioRunnerError(RUNNER_CODES.INVALID_LIMITS, 'timeout must be an integer in 1..3600000 ms', {timeout});
    const boundedLimits = normalizeLimits(limits);
    if (resume === true && abandon === true) throw new ScenarioRunnerError(RUNNER_CODES.RESUME_CONFLICT, 'resume and abandon cannot both be asked for: one campaign cannot be continued and left behind at once');
    if (campaign?.state === 'RUNNING' || driving) throw new ScenarioRunnerError(RUNNER_CODES.ALREADY_RUNNING, 'a campaign is already running; stop it before starting another', {campaignId: campaign?.campaignId ?? null});
    const previous = unfinished();
    if (previous && resume !== true && abandon !== true) {
      throw new ScenarioRunnerError(RUNNER_CODES.RESUME_REQUIRED, 'an earlier campaign never finished; pass resume to continue it or abandon to leave it behind deliberately', {previousCampaignId: previous.campaignId ?? null, previousState: previous.state});
    }
    // Asking to resume nothing is refused rather than silently answered with a new campaign: a caller that believes it
    // continued a campaign, while the runner actually started a different one, has lost the thread of its own evidence.
    if (resume === true && !previous) throw new ScenarioRunnerError(RUNNER_CODES.NOTHING_TO_RESUME, 'there is no unfinished campaign to resume');

    const readinessReport = scenario.readiness ? scenario.readiness(context) : readiness(context);
    const state = typeof readinessReport === 'string' ? readinessReport : readinessReport?.state ?? 'UNKNOWN';
    if (state !== 'READY') {
      campaign = {campaignId: `campaign-${randomUUID()}`, scenarioId, state: 'REFUSED', reason: RUNNER_CODES.NOT_READY, detail: state, totalRuns: warmup + repetitions, runs: [], startedAt: clock(), finishedAt: clock(), context, limits: boundedLimits, readiness: readinessReport, summary: null};
      campaign.summary = summaryOf(campaign);
      persist();
      try { writeReceipt(copy(campaign)); } catch { /* the live refusal is the record that matters here */ }
      throw new ScenarioRunnerError(RUNNER_CODES.NOT_READY, `topology is not ready for ${scenarioId}: ${state}`, readinessReport);
    }

    // RESUMING CONTINUES THE SAME CAMPAIGN. Bounds and seed come from the record, not from this call: a campaign
    // whose repetition count or seed could be changed halfway through would not be one campaign.
    if (resume === true && previous) {
      if (Number.isSafeInteger(repetitions) && repetitions !== previous.repetitions) throw new ScenarioRunnerError(RUNNER_CODES.RESUME_CONFLICT, 'a resumed campaign keeps its declared repetition count', {declared: previous.repetitions, requested: repetitions});
      if (Number.isSafeInteger(warmup) && warmup !== previous.warmup) throw new ScenarioRunnerError(RUNNER_CODES.RESUME_CONFLICT, 'a resumed campaign keeps its declared warmup count', {declared: previous.warmup, requested: warmup});
      if (seed !== null && seed !== previous.campaignSeed) throw new ScenarioRunnerError(RUNNER_CODES.RESUME_CONFLICT, 'a resumed campaign keeps its campaign seed, or it is a different campaign', {declared: previous.campaignSeed, requested: seed});
      campaign = {...previous, state: 'RUNNING', reason: null, finishedAt: null, receipt: null, resumeCount: (previous.resumeCount ?? 0) + 1, resumedAt: clock()};
      cancelled = null;
      persist();
      if (campaign.runs.length >= campaign.totalRuns) {
        finish('COMPLETED', 'REPETITIONS_FINISHED');
        return {campaignId: campaign.campaignId, state: campaign.state, totalRuns: campaign.totalRuns, campaignSeed: campaign.campaignSeed, resumed: true, remaining: 0};
      }
      const remaining = campaign.totalRuns - campaign.runs.length;
      launch();
      return {campaignId: campaign.campaignId, state: campaign.state, totalRuns: campaign.totalRuns, campaignSeed: campaign.campaignSeed, resumed: true, remaining};
    }

    const campaignSeed = seed ?? `${scenarioId}-${clock()}`;
    campaign = {
      campaignId: `campaign-${randomUUID()}`, scenarioId, state: 'RUNNING', reason: null,
      seedPolicy: 'derived:seed(campaign,index)', campaignSeed, repetitions, warmup, timeout, limits: boundedLimits,
      totalRuns: warmup + repetitions, runs: [], startedAt: clock(), finishedAt: null, context,
      resumedFrom: null, resumedAt: null, resumeCount: 0, abandonedFrom: abandon ? previous?.campaignId ?? null : null,
      readiness: readinessReport, summary: null,
    };
    campaign.summary = summaryOf(campaign);
    cancelled = null;
    persist();
    launch();
    return {campaignId: campaign.campaignId, state: campaign.state, totalRuns: campaign.totalRuns, campaignSeed};
  }

  /** `void drive()` must never reject into the void: a runner that breaks itself still leaves a readable receipt. */
  const launch = () => {
    driving = true;
    drive().catch(error => {
      if (!campaign) return;
      finish('FAILED', `RUNNER_FAILURE:${String(error?.message ?? error)}`);
    }).finally(() => { driving = false; });
  };

  /** The loop yields between runs, so a long campaign is inspectable and a stop is honoured before the next run. */
  async function drive() {
    const startedAt = campaign.startedAt;
    for (let index = 0; index < campaign.totalRuns; index += 1) {
      // A RESUMED CAMPAIGN CONTINUES, IT DOES NOT REPLAY. Rows are appended in index order, so a recorded row at this
      // position means this repetition is already accounted for - including the INTERRUPTED row written by recovery.
      // Without this guard a resume re-ran repetition 0 and appended a second row for it, which made the accounting
      // invariant (every planned run explained exactly once) false while still looking plausible.
      if (campaign.runs[index]?.index === index) continue;
      if (cancelled) {
        campaign.runs.push({index, state: 'CANCELLED', reason: cancelled, seed: runSeed(campaign.campaignSeed, index), measured: false, result: null});
        continue;
      }
      const ended = limitReached(startedAt);
      if (ended) {
        campaign.runs.push({index, state: 'SKIPPED', reason: ended, seed: runSeed(campaign.campaignSeed, index), measured: false, result: null});
        continue;
      }
      const isWarmup = index < campaign.warmup;
      const seed = runSeed(campaign.campaignSeed, index);
      const began = clock();
      runHandles = new Set();
      runAborted = null;
      const control = {
        cancelled: () => Boolean(cancelled),
        reason: () => cancelled,
        onCancel: handle => {
          // A run that registers its cleanup AFTER it has been torn down is cleaned up immediately: a late
          // registration must not become work nobody is watching. (The timeout path is exactly this case - the
          // runner stops waiting while the run's own promise is still alive.)
          if (runAborted !== null) {
            try { handle(runAborted); } catch { /* the run reports its own cleanup failure to the runner */ }
            return () => {};
          }
          runHandles.add(handle);
          return () => runHandles.delete(handle);
        },
      };
      let outcome;
      try {
        outcome = await withTimeout(Promise.resolve().then(() => runOnce({scenario: scenarioById.get(campaign.scenarioId), campaignId: campaign.campaignId, index, seed, warmup: isWarmup, control, context: campaign.context ?? null})), campaign.timeout);
      } catch (error) {
        if (error?.code === 'RUN_TIMEOUT') {
          // The run lost its race with the clock, so whatever it started is torn down here rather than left running.
          const failures = fireCancels('run timed out');
          outcome = {state: 'TIMEOUT', reason: `no outcome within ${campaign.timeout}ms${failures.length > 0 ? `; cleanup failed: ${failures.join('; ')}` : ''}`};
        } else {
          outcome = {state: 'FAILED', reason: error?.message ?? 'run failed'};
        }
      }
      runHandles = new Set();
      const run = {index, state: outcome.state === 'MEASURED' && isWarmup ? 'WARMUP' : outcome.state, reason: outcome.reason ?? null, seed, warmup: isWarmup, measured: outcome.state === 'MEASURED' && !isWarmup, durationMs: Math.max(0, clock() - began), result: outcome.result ?? null};
      campaign.runs.push(run);
      persist();
      announce(campaign, run);
      await new Promise(resolveYield => setTimeout(resolveYield, 0));
    }
    const ended = limitReached(startedAt);
    if (cancelled) finish('STOPPED', cancelled);
    else if (ended) finish('COMPLETED', ended);
    else finish('COMPLETED', 'REPETITIONS_FINISHED');
  }

  const withTimeout = (promise, limit) => {
    let timer = null;
    return Promise.race([
      promise,
      new Promise((_yes, no) => { timer = setTimeout(() => no(Object.assign(new Error('run timed out'), {code: 'RUN_TIMEOUT'})), limit); }),
    ]).finally(() => clearTimeout(timer));
  };

  const progress = () => {
    if (!campaign) return {state: 'IDLE', campaign: null, scenarios: [...scenarioById.keys()]};
    const measured = campaign.runs.filter(run => run.measured);
    const notMeasured = campaign.runs.filter(run => !run.measured && run.state !== 'WARMUP');
    return {
      state: campaign.state,
      campaignId: campaign.campaignId,
      scenarioId: campaign.scenarioId,
      seedPolicy: campaign.seedPolicy,
      campaignSeed: campaign.campaignSeed,
      totals: {planned: campaign.totalRuns, attempted: campaign.runs.length, warmup: campaign.runs.filter(run => run.state === 'WARMUP').length, measured: measured.length, notMeasured: notMeasured.length},
      summary: campaign.summary ?? summaryOf(campaign),
      limits: campaign.limits ?? {},
      context: campaign.context ?? null,
      readiness: campaign.readiness ?? null,
      resumeCount: campaign.resumeCount ?? 0,
      startedAt: campaign.startedAt ?? null,
      finishedAt: campaign.finishedAt ?? null,
      measured,
      notMeasured,
      reason: campaign.reason,
      receipt: campaign.receipt ?? null,
    };
  };

  /**
   * Stopping is explicit, and the campaign is not reported as stopped until the loop has actually written the reason
   * onto every run that never happened. An earlier version set the state here, which let a caller observe STOPPED while
   * the cancelled runs were still missing - a reader could then see "3 of 8 measured" with no explanation for the other
   * five, which is precisely the silent gap this module exists to prevent. Rule 6 is applied here too: the cleanups the
   * in-flight run registered are fired now, so a stop reaches the work and not only the bookkeeping.
   */
  function stop({reason = 'stopped by operator'} = {}) {
    if (!campaign || campaign.state !== 'RUNNING') return {stopped: false, state: campaign?.state ?? 'IDLE'};
    cancelled = reason;
    campaign.reason = reason;
    const cleanupFailures = fireCancels(reason);
    if (cleanupFailures.length > 0) campaign.stopCleanupFailure = cleanupFailures.join('; ');
    persist();
    return {stopped: true, state: 'STOPPING', reason, ...(cleanupFailures.length > 0 ? {cleanupFailures} : {})};
  }

  /** Finished campaigns, newest by name order, read from their receipts. Nothing here is inferred from memory. */
  function receipts() {
    if (!existsSync(receiptDir)) return [];
    return readdirSync(receiptDir).filter(name => RECEIPT_FILE.test(name)).sort().slice(-receiptLimit).map(name => {
      try {
        const record = JSON.parse(readFileSync(resolve(receiptDir, name), 'utf8'));
        return {campaignId: record.campaignId, scenarioId: record.scenarioId, state: record.state, reason: record.reason, startedAt: record.startedAt, finishedAt: record.finishedAt, summary: record.summary ?? summaryOf(record), experimentRef: record.context?.experimentId ?? null};
      } catch { return {file: name, state: 'UNREADABLE', reason: 'RECEIPT_UNREADABLE'}; }
    });
  }

  function receipt(campaignId) {
    const id = String(campaignId ?? '');
    if (!RECEIPT_FILE.test(`${id}.json`)) throw new ScenarioRunnerError(RUNNER_CODES.UNKNOWN_CAMPAIGN, `no campaign ${id} is recorded here`, {campaignId: id});
    const path = resolve(receiptDir, `${id}.json`);
    if (!existsSync(path)) {
      if (campaign?.campaignId === id) return copy(campaign);
      throw new ScenarioRunnerError(RUNNER_CODES.UNKNOWN_CAMPAIGN, `no campaign ${id} is recorded here`, {campaignId: id});
    }
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch { return {campaignId: id, state: 'UNREADABLE', reason: 'RECEIPT_UNREADABLE'}; }
  }

  /**
   * A bounded shutdown. A City that closes while a campaign is running stops it - which fires the cleanups, so the
   * canonical task does not outlive the process that started it - and waits a bounded time for the loop to write its
   * last rows. If it does not drain in time the record is simply left RUNNING, which the next process recovers as
   * INTERRUPTED: the failure to drain is visible in the record rather than papered over by a bigger timeout.
   */
  async function close({reason = 'runner closed', timeoutMs = 750} = {}) {
    if (campaign?.state === 'RUNNING') stop({reason});
    const until = clock() + Math.max(1, Math.min(Number(timeoutMs) || 1, 10000));
    while (driving && clock() < until) await new Promise(resolveWait => setTimeout(resolveWait, 5));
    return {drained: !driving, state: campaign?.state ?? 'IDLE'};
  }

  return {start, stop, progress, state: () => campaign, unfinished, receipts, receipt, scenarios: () => [...scenarioById.values()], file, receiptDir, close};
}
