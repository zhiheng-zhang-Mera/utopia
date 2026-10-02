// UXI-391 — regression guards for the remote-handoff closeout repair.
//
// WHY THIS FILE EXISTS. The task's own completion gate asks for tests over facts that were previously either
// unguarded or WRONG in the record: the five requestable task types, the partial-load semantics (missing is
// not zero, a saturated observed dimension binds, a single observed dimension is enough), the ownership-
// transfer bridge's refusal cases, and the projection rule that makes REMOTE_HANDOFF durable while a handoff
// is pending. Each block below fails if the corresponding repair is undone.
import test from 'node:test';
import assert from 'node:assert/strict';

import {taskTypes, validateCommand} from '../contracts/city-control-v0/protocol.mjs';
import {loadPressure, LOAD_DIMENSIONS} from '../city/00-foundation/01-city-core/fleet-routing/pressure.mjs';
import {candidateFromNode, eligibilityFor, routePlanFor, routeStageFor, projectTaskStatus, loadFromTelemetry} from '../services/dev-gateway/presentation.mjs';
import {createHandoffBridge} from '../services/dev-gateway/handoff.mjs';

/* --------------------------------------------------------------- the five task types */

test('UXI-391: the City really has FIVE requestable task types - the premise the old record denied', () => {
  assert.deepEqual([...taskTypes], ['WAIT', 'CREATE_TEMP_ARTIFACT', 'HASH_TEMP_ARTIFACT', 'DELETE_TEMP_ARTIFACT', 'CHECKPOINT_DEMO']);
  for (const type of taskTypes) assert.doesNotThrow(() => validateCommand({type}), `${type} must be requestable`);
  // The negative control: a task type the City does not offer is refused, so this test cannot pass by
  // accepting everything.
  assert.throws(() => validateCommand({type: 'NOT_A_TASK'}), /supported safe task type/);
  // Parameters are not accepted, which is why the E2E configures a node rather than a task.
  assert.throws(() => validateCommand({type: 'WAIT', params: {}}), /supported safe task type/);
});

/* --------------------------------------------------------------- partial load semantics */

test('UXI-391: a MISSING load dimension is not zero, and one observed dimension is enough', () => {
  // Nothing measurable at all: LOAD_UNKNOWN, never "idle".
  const none = loadPressure({load: null});
  assert.equal(none.known, false);
  assert.equal(none.pressure, null);
  assert.deepEqual([...none.missing], [...LOAD_DIMENSIONS]);

  // One dimension observed: usable, and the unobserved ones stay MISSING rather than becoming 0.
  const partial = loadPressure({load: {memory: 0.5}});
  assert.equal(partial.known, true);
  assert.equal(partial.pressure, 0.5);
  assert.deepEqual([...partial.observed], ['memory']);
  assert.ok(partial.missing.includes('cpu') && partial.missing.includes('gpu'));
  assert.equal(partial.missing.includes('memory'), false);
  assert.equal(partial.partial, true);
  assert.equal(partial.binding_dimension, 'memory');
});

test('UXI-391: the BINDING dimension is the maximum OBSERVED one, not an average over five', () => {
  // One saturated dimension beside four unobserved ones must bind at 0.95. Averaging over five, or treating
  // the unobserved four as idle, is the failure this contract exists to prevent.
  const saturated = loadPressure({load: {cpu: 0.95}});
  assert.equal(saturated.pressure, 0.95);
  assert.equal(saturated.binding_dimension, 'cpu');
  // And when several are observed, the maximum still wins - a low reading cannot dilute a high one.
  const mixed = loadPressure({load: {cpu: 0.2, memory: 0.8}});
  assert.equal(mixed.pressure, 0.8);
  assert.equal(mixed.binding_dimension, 'memory');
});

test('UXI-391: telemetry produces the vector honestly - measured dimensions only, null when nothing is measured', () => {
  assert.deepEqual(loadFromTelemetry({cpu: {usagePercent: 40}, memory: {usedBytes: 1, totalBytes: 4}}), {cpu: 0.4, memory: 0.25});
  // Disk CAPACITY is not I/O load, so it must not appear as `io`; and an unusable reading is dropped, not zeroed.
  assert.equal(loadFromTelemetry({disk: {usedBytes: 1, totalBytes: 2}}), null);
  assert.equal(loadFromTelemetry({cpu: {usagePercent: 900}}), null);
  assert.equal(loadFromTelemetry(null), null);
});

/* --------------------------------------------------------------- the transfer bridge */

const decidedFor = (stage, chosenDeviceRef) => ({stage, chosenDeviceRef, plan: {stage, chosen_device_ref: chosenDeviceRef}});

test('UXI-391: the bridge transfers ONLY on ALTERNATE_DEVICE, and moves ownership once', () => {
  const bridge = createHandoffBridge();
  const task = {id: 'Q-1', assignedNodeId: 'A'};
  bridge.noteAssignment({subjectRef: 'Q-1', deviceRef: 'A'});

  // Every other stage is not a handoff, and the bridge must say so rather than invent one.
  for (const stage of ['DIRECT', 'SWITCH_OFFERED', 'QUEUED', 'EXHAUSTED', null]) {
    assert.equal(bridge.consider({task, decided: stage === null ? null : decidedFor(stage, 'B')}).outcome, 'NOT_APPLICABLE', stage);
  }
  assert.equal(bridge.holder('Q-1'), 'A', 'a non-handoff stage must not move ownership');

  const moved = bridge.consider({task, decided: decidedFor('ALTERNATE_DEVICE', 'B')});
  assert.equal(moved.outcome, 'TRANSFERRED');
  assert.equal(moved.from, 'A');
  assert.equal(moved.to, 'B');
  assert.equal(moved.epoch, 2, 'the epoch must advance so the previous holder\'s late retry is not idempotent');
  assert.equal(bridge.holder('Q-1'), 'B');

  // A duplicate request must NOT move it a second time.
  const again = bridge.consider({task: {...task, handoffTargetRef: 'B'}, decided: decidedFor('ALTERNATE_DEVICE', 'B')});
  assert.equal(again.outcome, 'REFUSED');
  assert.equal(again.reason, 'ALREADY_TRANSFERRED');
});

test('UXI-391: a stale holder cannot hand on work it no longer owns, and a disabled path refuses', () => {
  const bridge = createHandoffBridge();
  bridge.noteAssignment({subjectRef: 'Q-2', deviceRef: 'A'});
  // A is the current holder, so a transfer that claims to come from C (a stale or invented holder) is refused.
  const wrongHolder = bridge.consider({task: {id: 'Q-2', assignedNodeId: 'C'}, decided: decidedFor('ALTERNATE_DEVICE', 'B')});
  assert.equal(wrongHolder.outcome, 'REFUSED');
  assert.equal(bridge.holder('Q-2'), 'A', 'a refused transfer must change nothing');
  // Same device is not a transfer either.
  const same = bridge.consider({task: {id: 'Q-2', assignedNodeId: 'A'}, decided: decidedFor('ALTERNATE_DEVICE', 'A')});
  assert.equal(same.outcome, 'REFUSED');
  assert.equal(same.reason, 'SAME_DEVICE');
  // No endpoints at all.
  assert.equal(bridge.consider({task: {id: 'Q-2', assignedNodeId: 'A'}, decided: decidedFor('ALTERNATE_DEVICE', null)}).reason, 'NO_TRANSFER_ENDPOINTS');
});

test('UXI-391: only the reserved device - and never a stale holder - may claim a moved task', () => {
  const bridge = createHandoffBridge();
  bridge.noteAssignment({subjectRef: 'Q-3', deviceRef: 'A'});
  bridge.consider({task: {id: 'Q-3', assignedNodeId: 'A'}, decided: decidedFor('ALTERNATE_DEVICE', 'B')});
  // B may take it; the recovered A may not; an unrelated C may not.
  assert.equal(bridge.claimAllowed({subjectRef: 'Q-3', deviceRef: 'B', reservedFor: 'B'}), true);
  assert.equal(bridge.claimAllowed({subjectRef: 'Q-3', deviceRef: 'A', reservedFor: 'B'}), false, 'the previous holder must not re-claim moved work');
  assert.equal(bridge.claimAllowed({subjectRef: 'Q-3', deviceRef: 'C', reservedFor: 'B'}), false);
  // With no reservation, the current holder still cannot be bypassed by a third device.
  const fresh = createHandoffBridge();
  fresh.noteAssignment({subjectRef: 'Q-4', deviceRef: 'A'});
  assert.equal(fresh.claimAllowed({subjectRef: 'Q-4', deviceRef: 'C'}), false);
  assert.equal(fresh.claimAllowed({subjectRef: 'Q-4', deviceRef: 'A'}), true);
  assert.equal(fresh.claimAllowed({subjectRef: 'Q-5', deviceRef: 'C'}), true, 'an unclaimed subject is claimable');
});

/* --------------------------------------------------------------- projection + the planner's decision */

test('UXI-391: a pending handoff is REMOTE_HANDOFF on the surface, from the task record', () => {
  const candidates = [candidateFromNode({id: 'A', online: false}), candidateFromNode({id: 'B', online: true})];
  const pending = projectTaskStatus({
    task: {id: 'Q-6', state: 'QUEUED', assignedNodeId: null, handoffFromRef: 'A', handoffTargetRef: 'B'},
    candidates,
  });
  assert.equal(pending.state, 'REMOTE_HANDOFF', 'the surface must show the handoff the City just executed');
  // Once the run is terminal the handoff is over, so the term must not linger.
  const done = projectTaskStatus({task: {id: 'Q-6', state: 'COMPLETED', handoffTargetRef: 'B'}, candidates});
  assert.equal(done.state, 'COMPLETED');
  // A task with no handoff is untouched by the rule.
  const plain = projectTaskStatus({task: {id: 'Q-7', state: 'RUNNING', assignedNodeId: 'B'}, candidates});
  assert.notEqual(plain.state, 'REMOTE_HANDOFF');
});

test('UXI-391: the planner decision is exposed WITH the chosen device, and routeStageFor stays a thin read', () => {
  // B must report telemetry, or its load is unmeasured and it is not a usable alternate - the first version
  // of this test omitted it and got QUEUED, which is the planner behaving correctly on unusable input.
  const candidates = [candidateFromNode({id: 'A', online: false}), candidateFromNode({id: 'B', online: true, telemetry: {cpu: {usagePercent: 10}}})];
  const task = {id: 'Q-8', state: 'RUNNING', assignedNodeId: 'A', switchDeclined: true};
  const decided = routePlanFor({task, candidates});
  assert.equal(decided.stage, 'ALTERNATE_DEVICE');
  assert.equal(decided.chosenDeviceRef, 'B', 'the orchestration needs the device the planner chose');
  assert.equal(routeStageFor({task, candidates}), 'ALTERNATE_DEVICE', 'the surface read agrees with the full plan');
  // Without the user's decline the planner offers rather than transfers - the gate that keeps a handoff from
  // ever happening without the user's own intent.
  assert.equal(routeStageFor({task: {...task, switchDeclined: false}, candidates}), 'SWITCH_OFFERED');
});

test('UXI-391: the term and the route agree about the SAME candidate - the defect this task is about', () => {
  const enabled = candidateFromNode({id: 'B', online: true, telemetry: {cpu: {usagePercent: 10}}});
  const disabled = candidateFromNode({id: 'B', online: true, enablement: 'DISABLED', telemetry: {cpu: {usagePercent: 10}}});
  assert.equal(eligibilityFor(enabled).eligible, true);
  assert.equal(eligibilityFor(disabled).eligible, false);
  assert.equal(eligibilityFor(disabled).reason, 'USER_DISABLED');
  // The route path must see exactly the same field - that is what was broken.
  const decided = routePlanFor({
    task: {id: 'Q-9', state: 'RUNNING', assignedNodeId: 'A', switchDeclined: true},
    candidates: [candidateFromNode({id: 'A', online: false}), disabled],
  });
  assert.equal(decided.stage, 'QUEUED', 'a disabled alternate must not be chosen, and the planner must not pretend otherwise');
});
