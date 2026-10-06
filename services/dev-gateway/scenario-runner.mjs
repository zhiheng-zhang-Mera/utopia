// REX-803: the controlled scenario runner and repetition engine.
//
// WHAT IT IS FOR. A research claim about "this behaves better under condition X" is only reproducible if the campaign,
// not the individual run, is the unit of evidence: the same scenario, run N times under a stated seed policy, with the
// warmup runs excluded, every excluded or failed run carrying its reason, and a receipt that says what was actually
// measured. This module produces exactly that, and it is deliberately NOT a scheduler: it never touches canonical task
// truth, never enqueues work behind a global lock, and never resumes a campaign on its own.
//
// THE FIVE RULES THAT SHAPE THE CODE:
//   1. SEEDS ARE DERIVED, NOT DRAWN. Every run's seed is a pure function of (campaign seed, run index), so repeating a
//      campaign with the same seed reproduces the same sequence - and a run can be replayed in isolation.
//   2. WARMUP IS NOT MEASURED. Warmup runs execute but are excluded from the measured outcome set, by name, so a
//      "result" can never silently include a run that was only there to bring the system up to temperature.
//   3. ABSENCE OF A RUN IS ALWAYS EXPLAINED. A run that did not produce a measured outcome carries a typed reason
//      (timeout, excluded, cancelled, not-ready), because "N repetitions" with fewer measured runs is exactly the kind of
//      gap a reader must be able to see.
//   4. RESUMING IS AN EXPLICIT DECISION. If a previous campaign for the same scenario is still unfinished, starting
//      again is REFUSED unless the caller says resume, so a campaign cannot quietly continue from a state nobody chose.
//   5. LONG CAMPAIGNS DO NOT BLOCK. Runs are driven by an asynchronous loop with a yield between runs; progress is
//      inspectable at any time and stopping is honoured before the next run starts.
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

export const RUN_STATES = Object.freeze(['MEASURED', 'WARMUP', 'TIMEOUT', 'FAILED', 'EXCLUDED', 'CANCELLED', 'SKIPPED']);
export const CAMPAIGN_STATES = Object.freeze(['RUNNING', 'COMPLETED', 'STOPPED', 'REFUSED']);

export const RUNNER_CODES = Object.freeze({
  UNKNOWN_SCENARIO: 'SCENARIO_UNKNOWN',
  INVALID_REPETITIONS: 'REPETITIONS_INVALID',
  NOT_READY: 'TOPOLOGY_NOT_READY',
  RESUME_REQUIRED: 'RESUME_REQUIRED',
  ALREADY_RUNNING: 'CAMPAIGN_ALREADY_RUNNING',
});

export class ScenarioRunnerError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ScenarioRunnerError';
    this.code = code;
    this.detail = detail;
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

export function createScenarioRunner({dir = '.runtime/research', scenarios = [], runOnce, readiness = () => ({state: 'READY'}), clock = () => Date.now(), timeoutMs = 30000} = {}) {
  if (typeof runOnce !== 'function') throw new TypeError('runOnce is required: the runner executes scenarios, it does not invent them');
  const scenarioById = new Map(scenarios.map(scenario => [scenario.id, scenario]));
  const file = resolve(dir, 'scenario-campaign.json');
  let campaign = null;
  let cancelled = null;

  const persist = () => { if (!campaign) return; mkdirSync(dir, {recursive: true}); const temporary = `${file}.tmp`; writeFileSync(temporary, JSON.stringify(campaign), {mode: 0o600}); renameSync(temporary, file); };

  /** A campaign left unfinished by an earlier process is visible, and is never continued without being asked for. */
  function unfinished() {
    if (!existsSync(file)) return null;
    try {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      return record?.state === 'RUNNING' ? record : null;
    } catch { return {state: 'RUNNING', campaignId: null, unreadable: true}; }
  }

  function start({scenarioId, repetitions, warmup = 0, resume = false, seed = null, timeout = timeoutMs} = {}) {
    if (!scenarioById.has(scenarioId)) throw new ScenarioRunnerError(RUNNER_CODES.UNKNOWN_SCENARIO, `Unknown scenario ${String(scenarioId)}`, {known: [...scenarioById.keys()]});
    if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10000) throw new ScenarioRunnerError(RUNNER_CODES.INVALID_REPETITIONS, 'repetitions must be an integer in 1..10000', {repetitions});
    if (!Number.isSafeInteger(warmup) || warmup < 0 || warmup > repetitions) throw new ScenarioRunnerError(RUNNER_CODES.INVALID_REPETITIONS, 'warmup must be an integer in 0..repetitions', {warmup});
    if (campaign?.state === 'RUNNING') throw new ScenarioRunnerError(RUNNER_CODES.ALREADY_RUNNING, 'a campaign is already running; stop it before starting another', {campaignId: campaign.campaignId});
    const previous = unfinished();
    if (previous && resume !== true) {
      throw new ScenarioRunnerError(RUNNER_CODES.RESUME_REQUIRED, 'an earlier campaign never finished; pass resume to continue it deliberately', {previousCampaignId: previous.campaignId ?? null});
    }
    const readinessReport = scenarioById.get(scenarioId).readiness ? scenarioById.get(scenarioId).readiness() : readiness();
    const state = typeof readinessReport === 'string' ? readinessReport : readinessReport?.state ?? 'UNKNOWN';
    if (state !== 'READY') {
      const refused = {campaignId: `campaign-${clock()}`, scenarioId, state: 'REFUSED', reason: RUNNER_CODES.NOT_READY, detail: state, totalRuns: warmup + repetitions, runs: [], startedAt: clock(), finishedAt: clock()};
      campaign = refused; persist();
      throw new ScenarioRunnerError(RUNNER_CODES.NOT_READY, `topology is not ready for ${scenarioId}: ${state}`, {state});
    }

    const campaignSeed = seed ?? `${scenarioId}-${clock()}`;
    campaign = {
      campaignId: `campaign-${clock()}`, scenarioId, state: 'RUNNING', reason: null,
      seedPolicy: 'derived:seed(campaign,index)', campaignSeed, repetitions, warmup, timeout,
      totalRuns: warmup + repetitions, runs: [], startedAt: clock(), finishedAt: null, resumedFrom: previous?.campaignId ?? null,
    };
    cancelled = null;
    persist();
    void drive();
    return {campaignId: campaign.campaignId, state: campaign.state, totalRuns: campaign.totalRuns, campaignSeed};
  }

  /** The loop yields between runs, so a long campaign is inspectable and a stop is honoured before the next run. */
  async function drive() {
    for (let index = 0; index < campaign.totalRuns; index += 1) {
      if (cancelled) {
        campaign.runs.push({index, state: 'CANCELLED', reason: cancelled, seed: runSeed(campaign.campaignSeed, index)});
        continue;
      }
      const isWarmup = index < campaign.warmup;
      const seed = runSeed(campaign.campaignSeed, index);
      let outcome;
      try {
        outcome = await withTimeout(runOnce({scenario: scenarioById.get(campaign.scenarioId), index, seed, warmup: isWarmup}), campaign.timeout);
      } catch (error) {
        outcome = error?.code === 'RUN_TIMEOUT'
          ? {state: 'TIMEOUT', reason: `no outcome within ${campaign.timeout}ms`}
          : {state: 'FAILED', reason: error?.message ?? 'run failed'};
      }
      campaign.runs.push({index, state: outcome.state === 'MEASURED' && isWarmup ? 'WARMUP' : outcome.state, reason: outcome.reason ?? null, seed, measured: outcome.state === 'MEASURED' && !isWarmup, result: outcome.result ?? null});
      persist();
      await new Promise(resolveYield => setTimeout(resolveYield, 0));
    }
    campaign.state = cancelled ? 'STOPPED' : 'COMPLETED';
    campaign.reason = cancelled ?? null;
    campaign.finishedAt = clock();
    persist();
  }

  const withTimeout = (promise, limit) => Promise.race([
    promise,
    new Promise((_yes, no) => setTimeout(() => no(Object.assign(new Error('run timed out'), {code: 'RUN_TIMEOUT'})), limit)),
  ]);

  const progress = () => {
    if (!campaign) return {state: 'IDLE', campaign: null};
    const measured = campaign.runs.filter(run => run.measured);
    const notMeasured = campaign.runs.filter(run => !run.measured && run.state !== 'WARMUP');
    return {
      state: campaign.state,
      campaignId: campaign.campaignId,
      scenarioId: campaign.scenarioId,
      seedPolicy: campaign.seedPolicy,
      campaignSeed: campaign.campaignSeed,
      totals: {planned: campaign.totalRuns, attempted: campaign.runs.length, warmup: campaign.runs.filter(run => run.state === 'WARMUP').length, measured: measured.length, notMeasured: notMeasured.length},
      measured,
      notMeasured,
      reason: campaign.reason,
    };
  };

  /**
   * Stopping is explicit, and the campaign is not reported as stopped until the loop has actually written the reason
   * onto every run that never happened. An earlier version set the state here, which let a caller observe STOPPED while
   * the cancelled runs were still missing - a reader could then see "3 of 8 measured" with no explanation for the other
   * five, which is precisely the silent gap this module exists to prevent.
   */
  function stop({reason = 'stopped by operator'} = {}) {
    if (!campaign || campaign.state !== 'RUNNING') return {stopped: false, state: campaign?.state ?? 'IDLE'};
    cancelled = reason;
    campaign.reason = reason;
    persist();
    return {stopped: true, state: 'STOPPING', reason};
  }

  return {start, stop, progress, state: () => campaign, unfinished, file};
}
