// REX-803 third-class sweep: the failure classes the opposite host's MON-903 review found in the SYBILING module, applied
// here. This is deliberately NOT the class set of my earlier passes.
//
// MON-902's review gave me the classes L1-L4 (absent/truncated data presented as complete; history fed to "now" rules; an
// unmeasured number; probes that only feed well-formed input). My second pass on MON-903 swept those and found four
// findings - and the reviewer then found EIGHT more that my pass had not looked for at all, because they were state
// machine and lifecycle defects. I recorded that as the structural limit of a class-driven sweep. This file attacks that
// limit directly by taking the reviewer's classes and pointing them at the largest module I still own:
//
//   L6  a bounded collection pruned or ordered by a key that is not its age
//   L7  a shutdown/closed boundary that some entry point ignores
//   L1b a truncated list returned without saying how much was truncated
//
// Every probe states what it would mean if it fails, and the probes are committed BEFORE the repair so the red run is a
// measurement rather than a claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {createScenarioRunner} from '../services/dev-gateway/scenario-runner.mjs';

const SCENARIOS = [{id: 'WAIT', readiness: () => ({state: 'READY'})}];
const settle = ms => new Promise(r => setTimeout(r, ms));
const make = (dir, options = {}) => createScenarioRunner({
  dir, scenarios: SCENARIOS, runOnce: async () => ({state: 'MEASURED', result: {ok: true}}), ...options,
});

test('REX803 L6: the receipt list is ordered by AGE, not by a random identifier in the filename', async () => {
  const dir = await mkdtemp(resolve('.scratch-rex803-sweep-'));
  try {
    // Six finished campaigns, written oldest-first with clearly separated finishedAt values, and with identifiers whose
    // LEXICOGRAPHIC order is the REVERSE of their age order - which is what a real UUID gives you. The first version of
    // this probe used sequential identifiers (…-000000000000 … -000000000005), whose name order happened to equal their
    // age order, so it PASSED on the defective code. A fixture that accidentally agrees with the implementation tests
    // nothing; the red run is only evidence when the fixture cannot agree with it by luck.
    const ids = ['ffffffff-0000-0000-0000-000000000000', 'eeeeeeee-0000-0000-0000-000000000000', 'dddddddd-0000-0000-0000-000000000000', 'cccccccc-0000-0000-0000-000000000000', 'bbbbbbbb-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000000'];
    const records = ids.map((suffix, n) => ({campaignId: `campaign-${suffix}`, scenarioId: 'WAIT', state: 'COMPLETED', reason: 'REPETITIONS_FINISHED', startedAt: 1000 + n, finishedAt: 1000 + n, summary: {planned: 1, accounted: 1, measured: 1}, context: null}));
    const {mkdirSync} = await import('node:fs');
    mkdirSync(join(dir, 'campaigns'), {recursive: true});
    for (const record of records) writeFileSync(join(dir, 'campaigns', `${record.campaignId}.json`), JSON.stringify(record));
    const runner = make(dir, {receiptLimit: 3});
    const listed = runner.receipts();
    assert.equal(listed.length, 3, 'the fixture must truncate');
    // The contract this module's own comment states is "newest by name order". Newest means the highest finishedAt, i.e.
    // records 3, 4 and 5 - never the three whose identifiers happen to sort last, which here are the THREE OLDEST.
    assert.deepEqual(listed.map(row => row.campaignId).sort(), [records[3].campaignId, records[4].campaignId, records[5].campaignId].sort(),
      'the bounded list must be the NEWEST campaigns; ordering by a random identifier in the file name returns an arbitrary sample');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('REX803 L1b: the receipt list says how many campaigns exist beyond the bound', async () => {
  const dir = await mkdtemp(resolve('.scratch-rex803-sweep-'));
  try {
    const {mkdirSync} = await import('node:fs');
    mkdirSync(join(dir, 'campaigns'), {recursive: true});
    for (let n = 0; n < 7; n += 1) {
      const record = {campaignId: `campaign-00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, scenarioId: 'WAIT', state: 'COMPLETED', finishedAt: n, startedAt: n, summary: {planned: 1, accounted: 1, measured: 1}};
      writeFileSync(join(dir, 'campaigns', `${record.campaignId}.json`), JSON.stringify(record));
    }
    const runner = make(dir, {receiptLimit: 3});
    const listed = runner.receipts();
    // Seven campaigns exist and three are returned. If nothing in the module says so, a reader sees "3 campaigns" - the
    // same defect as MON-903's bounded failure log and its truncated metrics window. The requirement is that SOME
    // surface states the size of the history behind the bound; the fix chose receiptWindow(), and the probe accepts any
    // of the honest shapes rather than pinning the implementation.
    const window = typeof runner.receiptWindow === 'function' ? runner.receiptWindow() : null;
    const disclosed = Number.isInteger(window?.total) || Number.isInteger(runner.receiptTotal?.()) || Number.isInteger(runner.receiptCount?.()) || listed.some(row => Number.isInteger(row.totalCampaigns));
    assert.ok(disclosed, `7 campaigns exist and ${listed.length} were returned with nothing stating that the list was truncated`);
    if (window) {
      assert.equal(window.total, 7);
      assert.equal(window.truncated, true);
      assert.equal(window.limit, 3);
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('REX803 L7: a runner that has been closed refuses new work instead of starting a campaign', async () => {
  const dir = await mkdtemp(resolve('.scratch-rex803-sweep-'));
  try {
    const runner = make(dir);
    const closed = await runner.close({reason: 'sweep shutdown'});
    assert.equal(closed.drained, true);
    let threw = null;
    let accepted = null;
    try { accepted = runner.start({scenarioId: 'WAIT', repetitions: 1}); } catch (error) { threw = error; }
    // A runner whose City has closed must not accept a campaign: the work would be started after the process it belongs
    // to has begun shutting down, and nothing would be left to report it.
    assert.ok(threw, `close() was called and start() still accepted a campaign: ${JSON.stringify(accepted)}`);
    assert.match(String(threw.code), /CLOSED|SHUTDOWN/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('REX803 positive control: a normal campaign still plans, measures and files exactly once', async () => {
  const dir = await mkdtemp(resolve('.scratch-rex803-sweep-'));
  try {
    const runner = make(dir);
    const started = runner.start({scenarioId: 'WAIT', repetitions: 3, warmup: 1, seed: 'sweep'});
    assert.equal(started.totalRuns, 4);
    for (let n = 0; n < 80 && runner.state()?.state === 'RUNNING'; n += 1) await settle(10);
    const record = runner.state();
    assert.equal(record.state, 'COMPLETED');
    assert.equal(record.summary.planned, 4);
    assert.equal(record.summary.accounted, 4);
    assert.equal(record.summary.measured, 3);
    assert.equal(record.summary.warmup, 1);
    assert.equal(record.summary.terminalAccountingComplete, true);
    assert.equal(runner.receipts().length, 1);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
