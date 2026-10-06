// MON-903 sibling-class sweep. The author's SECOND adversarial pass, driven by the classes the opposite-host review of
// the SIBLING task (MON-902) surfaced in the same programme. The programme's own recorded observation is that a defect
// found by review does not propagate to its siblings, so the shape is re-probed here deliberately.
//
// The four classes carried over from MON-902's review (see reports/MON-902/AUTHOR_ACCEPTANCE_OF_REVIEW.md section 5):
//   L1  ABSENT or TRUNCATED data must be reported as a finding, never presented as a complete/zero picture.
//   L2  rules about "now" must not be fed history.
//   L3  no number in a payload that nothing measured.
//   L4  the suite must exercise absent/invalid input classes, not only well-formed input.
//
// Every probe states what it would mean if it FAILS, so a pass is a measurement and not a shrug.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createDecisionOverlay} from '../services/dev-gateway/decision.mjs';

const withOverlay = async (options, fn) => {
  const dir = await mkdtemp(resolve('.scratch-mon903-sweep-'));
  try { await fn(dir, opts => createDecisionOverlay({dir, clock: () => Date.now(), ...opts})); }
  finally { await rm(dir, {recursive: true, force: true}); }
};
const settle = () => new Promise(r => setTimeout(r, 60));

test('MON903 sweep L1: the bounded failure log reports that it dropped entries, not just the last 16', async () => {
  await withOverlay({}, async (dir, make) => {
    // A throwing notification hook is the cheapest honest way to produce more failures than the bound: the overlay
    // records DECISION_NOTIFICATION_FAILED for each one.
    const overlay = make({tasks: () => [], onDecision: () => { throw new Error('notification sink refused'); }});
    for (let n = 0; n < 24; n += 1) overlay.submit({kind: 'RESOURCE_CONFLICT', taskRef: `task-${n}`, origin: 'SUBMITTED'});
    await settle();
    const snapshot = overlay.snapshot();
    const failures = snapshot.failures ?? [];
    // The defect: the list is capped by `if (failures.length > 16) failures.shift()` and nothing says how many were
    // dropped, so 16 failures and 16000 failures publish the SAME payload to both snapshot() and metrics().
    const droppedIsDisclosed = Number.isInteger(snapshot.failuresDropped) || Number.isInteger(snapshot.failureCount) || Number.isInteger(snapshot.failuresObserved);
    assert.ok(
      failures.length < 24 ? droppedIsDisclosed : true,
      `the failure log kept ${failures.length} of at least 24 and did NOT say how many it dropped: a reader cannot tell a quiet overlay from a broken one`,
    );
  });
});

test('MON903 sweep L3: a rejected (queue-full) decision does not publish an unmeasured latency of 0', async () => {
  await withOverlay({}, async (dir, make) => {
    const overlay = make({tasks: () => []});
    let full = null;
    for (let n = 0; n < 40 && !full; n += 1) {
      const result = overlay.submit({kind: 'RESOURCE_CONFLICT', taskRef: 'busy-task', origin: 'SUBMITTED'});
      if (result.queueFull) full = result;
    }
    assert.ok(full, 'the probe needs the per-task queue bound to be reached');
    const row = overlay.snapshot().decisions.find(decision => decision.decisionId === full.decisionId);
    assert.ok(row, 'the rejected trigger must still be recorded as a decision fact');
    // The defect: the rejected row hardcodes `decisionLatencyMs: 0`. No decision was made, so nothing measured a
    // latency; publishing 0 makes a refused decision look like an instantaneous one.
    assert.equal(row.decisionLatencyMs, null, `a decision that was never made must not claim a latency of ${row.decisionLatencyMs} ms`);
    assert.ok(row.decisionLatencyReason, 'and it must say why the number is absent');
  });
});

test('MON903 sweep L1: metrics() discloses that its rates are computed over a truncated window', async () => {
  await withOverlay({}, async (dir, make) => {
    const overlay = make({tasks: () => [], retentionLimit: 5});
    for (let n = 0; n < 9; n += 1) overlay.submit({kind: 'RESOURCE_CONFLICT', taskRef: `task-${n}`, origin: 'SUBMITTED'});
    await settle();
    const metrics = overlay.metrics();
    // Nine decisions were recorded and only five are retained, so `decisions: 5` and `autoResolutionRate` describe a
    // TRUNCATED sample. The defect: metrics() publishes the headline rate with no retainedLimit and no
    // retentionTruncated, so a reader of the metrics surface alone cannot know the sample was cut.
    assert.equal(metrics.decisions, 5, 'the fixture must actually truncate the window');
    assert.ok(
      Number.isInteger(metrics.retainedLimit) || metrics.retentionTruncated === true || typeof metrics.windowNote === 'string',
      'metrics() publishes a rate over a truncated sample without saying the sample was truncated',
    );
  });
});

test('MON903 sweep L1: the published window says what it is a window OVER', async () => {
  await withOverlay({}, async (dir, make) => {
    const overlay = make({tasks: () => []});
    overlay.submit({kind: 'RESOURCE_CONFLICT', taskRef: 't1', origin: 'CANONICAL_EVENT', eventId: 'e-10', eventSeq: 10});
    overlay.submit({kind: 'RESOURCE_CONFLICT', taskRef: 't2', origin: 'CANONICAL_EVENT', eventId: 'e-100', eventSeq: 100});
    await settle();
    const snapshot = overlay.snapshot();
    // firstSeq 10 / lastSeq 100 look like a continuous canonical-event window. They are the seqs of the two events that
    // HAPPENED to be triggers; nothing states the canonical high-water mark or how many canonical events in between were
    // deliberately not decisions.
    const labelled = typeof snapshot.window?.over === 'string' || Number.isInteger(snapshot.window?.observedEvents) || typeof snapshot.windowNote === 'string';
    assert.ok(labelled, 'the window field does not state that it spans trigger events, not the canonical event stream');
  });
});

test('MON903 sweep positive control: a well-formed decision is still recorded, receipted and measured', async () => {
  await withOverlay({}, async (dir, make) => {
    const overlay = make({tasks: () => [{id: 'ok-task', state: 'RUNNING', error: 'disk full'}]});
    overlay.submit({kind: 'FAILED', taskRef: 'ok-task', origin: 'CANONICAL_EVENT', eventId: 'e-1', eventSeq: 1});
    await settle();
    const snapshot = overlay.snapshot();
    const row = snapshot.decisions[0];
    assert.equal(row.action, 'RETRY_RECOMMENDED');
    assert.equal(row.ownerRequired, false);
    assert.ok(Number.isFinite(row.decisionLatencyMs) && row.decisionLatencyMs >= 0, 'a real decision does measure its latency');
    assert.equal(snapshot.failures.length, 0);
    assert.equal(overlay.persistAndCheck?.(), undefined);
  });
});
