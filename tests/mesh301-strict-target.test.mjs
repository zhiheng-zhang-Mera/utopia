// MESH-301 Step 3 — strict target-device routing intent.
//
// The workbook states the properties this has to have as five lines, and a property that is only asserted
// in a report is not a property. Each of the five is checked here against a real gateway:
//
//   target=Alien  -> only Alien may claim
//   target=Mech   -> only Mech may claim
//   target offline/unknown -> no silent fallback
//   duplicate user action -> no accidental duplicate execution
//   untargeted task -> existing scheduler behavior unchanged
//
// plus the two ways this feature could quietly undo itself: the handoff sweep moving a user-targeted run,
// and a waiting strict task blocking the ordinary queue behind it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { startAgent } from '../agents/reference-node/agent.mjs';
import { readTargetIntent, claimAllowedByTarget, classifyTarget, withheldTasks, isWaitingForTarget, TARGET_REASONS } from '../services/dev-gateway/targeting.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ALIEN = 'Alien-Win';
const MECH = 'Mech-Win';

// ---------------------------------------------------------------- pure unit tests

test('targeting: an absent or empty target means untargeted, never an error', () => {
  // The no-regression requirement lives here: untargeted tasks must not become invalid because a new
  // optional field was added.
  for (const raw of [undefined, null, '', '   ']) {
    const intent = readTargetIntent(raw);
    assert.equal(intent.present, false, `${JSON.stringify(raw)} must read as untargeted`);
  }
  assert.equal(readTargetIntent('Alien-Win').present, true);
  assert.equal(readTargetIntent(' Alien-Win ').value, 'Alien-Win', 'surrounding whitespace is not part of an identity');
});

test('targeting: a malformed target is a typed refusal, not a silently ignored field', () => {
  for (const raw of [42, {}, [], 'has space', 'has/slash', 'x'.repeat(81), 'emoji-🙂']) {
    const intent = readTargetIntent(raw);
    assert.equal(intent.ok, false, `${JSON.stringify(raw)} must be refused`);
    assert.equal(intent.code, TARGET_REASONS.MALFORMED);
  }
});

test('targeting: the claim rule is total - untargeted always allowed, strict only for the named device', () => {
  assert.equal(claimAllowedByTarget({}, ALIEN), true);
  assert.equal(claimAllowedByTarget({ targetDeviceRef: null }, ALIEN), true);
  assert.equal(claimAllowedByTarget({ targetDeviceRef: '' }, ALIEN), true);
  assert.equal(claimAllowedByTarget({ targetDeviceRef: ALIEN }, ALIEN), true);
  assert.equal(claimAllowedByTarget({ targetDeviceRef: ALIEN }, MECH), false);
  assert.equal(claimAllowedByTarget({ targetDeviceRef: MECH }, ALIEN), false);
});

test('targeting: KNOWN, ONLINE and ELIGIBLE are three questions, and only the last one is claimable', () => {
  const nodes = [
    { id: ALIEN, online: true, capabilities: ['task.execute.safe', 'filesystem.temp'] },
    { id: MECH, online: false, capabilities: ['task.execute.safe', 'filesystem.temp'] },
    { id: 'crippled-node', online: true, capabilities: ['filesystem.temp'] },
  ];
  const claimNodeFor = n => ({ nodeId: n.id, state: n.online ? 'READY' : 'OFFLINE', capabilities: n.capabilities, lastHeartbeatAt: 0, seq: 0 });
  const acceptsWork = (node, { requiredCapabilities }) => node.state === 'READY' && requiredCapabilities.every(c => node.capabilities.includes(c));
  const at = targetDeviceRef => classifyTarget({ targetDeviceRef, nodes, claimNodeFor, acceptsWork, requiredCapabilities: ['task.execute.safe', 'filesystem.temp'] });

  assert.equal(at('never-registered').state, 'UNKNOWN');
  assert.equal(at('never-registered').claimable, false);
  assert.equal(at(MECH).state, 'OFFLINE');
  assert.equal(at(MECH).reason, TARGET_REASONS.OFFLINE);
  assert.equal(at('crippled-node').state, 'INELIGIBLE');
  assert.equal(at('crippled-node').reason, TARGET_REASONS.INELIGIBLE);
  assert.equal(at(ALIEN).state, 'ELIGIBLE');
  assert.equal(at(ALIEN).claimable, true);
});

test('targeting: a withheld task names the device it is held for and the device that asked', () => {
  const tasks = [
    { id: 'Q-1', state: 'QUEUED', targetDeviceRef: ALIEN },
    { id: 'Q-2', state: 'QUEUED', targetDeviceRef: MECH },
    { id: 'Q-3', state: 'QUEUED' },
    { id: 'Q-4', state: 'COMPLETED', targetDeviceRef: MECH },
    { id: 'Q-5', state: 'ASSIGNED', targetDeviceRef: ALIEN, assignedNodeId: ALIEN },
  ];
  const withheld = withheldTasks({ tasks, deviceRef: MECH, terminal: ['COMPLETED', 'FAILED', 'CANCELLED'] });
  // Only Q-1: it is waiting, it is not Mech's, and it is not finished. Q-2 is Mech's own, Q-3 has no target,
  // Q-4 is terminal, and Q-5 has already been taken up.
  assert.deepEqual(withheld.map(w => w.taskId), ['Q-1']);
  assert.equal(withheld[0].heldFor, ALIEN);
  assert.equal(withheld[0].askedBy, MECH);
  assert.equal(withheld[0].reason, TARGET_REASONS.BOUND);
});

test('targeting: waiting means strict, unfinished and unclaimed', () => {
  assert.equal(isWaitingForTarget({ state: 'QUEUED', targetDeviceRef: ALIEN }, []), true);
  assert.equal(isWaitingForTarget({ state: 'QUEUED' }, []), false);
  assert.equal(isWaitingForTarget({ state: 'COMPLETED', targetDeviceRef: ALIEN }, ['COMPLETED']), false);
  assert.equal(isWaitingForTarget({ state: 'ASSIGNED', targetDeviceRef: ALIEN, assignedNodeId: ALIEN }, []), false);
});

// ---------------------------------------------------------------- gateway integration

const headers = token => ({ Authorization: `Bearer ${token}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json' });
const nodeHeaders = () => headers('mesh-node');

test('MESH-301 step 3: a strict target routes to one device, waits when that device is away, and never reroutes', async () => {
  const dir = await mkdtemp(resolve('.scratch-mesh301-'));
  let gateway, alien;
  try {
    gateway = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'mesh-control', nodeToken: 'mesh-node', heartbeatTimeout: 400 });
    const control = async (path, body) => {
      const r = await fetch(`${gateway.url}/api/v0/${path}`, { method: body ? 'POST' : 'GET', headers: headers('mesh-control'), body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };
    const node = async (path, body) => {
      const r = await fetch(`${gateway.url}/api/v0/node/${path}`, { method: 'POST', headers: nodeHeaders(), body: JSON.stringify(body ?? {}) });
      return { status: r.status, body: await r.json() };
    };
    const action = (input, idempotencyKey) => control('actions', {
      route: 'CITY_TASK', target: 'city.task', operation: 'CHECKPOINT_DEMO', input, idempotencyKey,
    });
    const taskState = async id => (await control(`tasks/${id}`)).body;

    // --- Alien is known because it really registered, then it goes away. "Known" and "online" must be
    // --- different answers, and the test needs the first without the second.
    alien = await startAgent({ url: gateway.url, token: 'mesh-node', workspace: resolve(dir, 'alien-work'), id: ALIEN, displayName: ALIEN, interval: 100, stepDelay: 50 });
    await sleep(300);
    assert.equal((await control('nodes')).body.nodes.find(n => n.id === ALIEN).online, true, 'Alien-Win must be online first');
    await alien.stop(); alien = null;
    await sleep(700);
    assert.equal((await control('nodes')).body.nodes.find(n => n.id === ALIEN).online, false, 'Alien-Win must now be known but offline');

    // --- 1. UNKNOWN target is refused with a typed code. The target has to reference a City identity.
    const unknown = await action({ targetDeviceRef: 'Never-Registered' }, 'k-unknown');
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.action.status, 'REFUSED');
    assert.equal(unknown.body.action.error.code, 'TARGET_DEVICE_UNKNOWN');
    assert.equal((await control('tasks')).body.tasks.length, 0, 'a refused target must not leave a task behind');

    // --- 2. A malformed target is refused rather than dropped on the floor.
    const malformed = await action({ targetDeviceRef: 'not a valid id' }, 'k-malformed');
    assert.equal(malformed.body.action.status, 'REFUSED');
    assert.equal(malformed.body.action.error.code, TARGET_REASONS.MALFORMED);

    // --- 3. OFFLINE target: the task is accepted and WAITS. This is the explicit-wait half of
    // --- "no silent fallback", and it is also what makes queue-now-run-on-reconnect possible.
    const strict = await action({ targetDeviceRef: ALIEN }, 'k-strict-alien');
    assert.equal(strict.body.action.status, 'QUEUED');
    const strictId = strict.body.action.backendRef.taskId;
    assert.equal(strict.body.action.backendRef.targetDeviceRef, ALIEN, 'the intent must be visible in canonical Action truth');
    assert.equal(strict.body.action.provenance.targetStateAtCreation, 'OFFLINE');
    const strictTask = await taskState(strictId);
    assert.equal(strictTask.state, 'QUEUED');
    assert.equal(strictTask.targetDeviceRef, ALIEN, 'the intent must be persisted on the City task');
    assert.equal(strictTask.assignedNodeId, null);
    const waitingEvents = (await control('events')).body.events.filter(e => e.type === 'TASK_TARGET_WAITING' && e.taskId === strictId);
    assert.equal(waitingEvents.length, 1, 'the wait must be stated in the canonical event stream, exactly once');
    assert.equal(waitingEvents[0].payload.targetDeviceRef, ALIEN);

    // --- 4. Mech is online and able to work, and STILL may not take it. This is the property.
    await node('register', { id: MECH, displayName: MECH, capabilities: ['task.execute.safe', 'filesystem.temp'] });
    const withheldClaim = await node('claim', { id: MECH });
    assert.equal(withheldClaim.body.task, null, 'the named device is the only one that may claim');
    assert.equal(withheldClaim.status, 200);
    const withheld = withheldClaim.body.withheld ?? [];
    assert.equal(withheld.length, 1, 'the refusal must be stated as data, not as a mute null');
    assert.equal(withheld[0].taskId, strictId);
    assert.equal(withheld[0].reason, TARGET_REASONS.BOUND);
    assert.equal(withheld[0].heldFor, ALIEN);
    assert.equal((await taskState(strictId)).state, 'QUEUED', 'and the task must still be waiting afterwards');

    // --- 5. REGRESSION: an untargeted task is still claimed by whoever is healthy, and the waiting strict
    // --- task must not block the queue behind it.
    const plain = await control('tasks', { type: 'CHECKPOINT_DEMO' });
    const plainClaim = await node('claim', { id: MECH });
    assert.equal(plainClaim.body.task.id, plain.body.id, 'untargeted work must still be schedulable normally');
    assert.equal(plainClaim.body.withheld.length, 1, 'and the strict task is still reported as withheld, not lost');
    await node('report', { id: MECH, taskId: plain.body.id, state: 'RUNNING', progress: 10 });
    await node('report', { id: MECH, taskId: plain.body.id, state: 'COMPLETED', progress: 100, result: { ok: true } });
    assert.equal((await taskState(plain.body.id)).state, 'COMPLETED');

    // --- 6. DUPLICATE user action: the Action facade's own idempotency is the boundary, and the target is
    // --- inside the fingerprint, so the same key cannot mean two different devices.
    const replay = await action({ targetDeviceRef: ALIEN }, 'k-strict-alien');
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.action.actionId, strict.body.action.actionId);
    assert.equal(replay.body.action.backendRef.taskId, strictId);
    assert.equal((await control('tasks')).body.tasks.filter(t => t.targetDeviceRef === ALIEN).length, 1, 'a replay must not create a second task');
    const reused = await action({ targetDeviceRef: MECH }, 'k-strict-alien');
    // A reused key is rejected at the contract level rather than stored as a second Action: one key cannot be
    // made to mean two different devices.
    assert.ok(reused.status >= 400, 'reusing a key for a different target must be rejected');
    assert.equal(reused.body.errorCode, 'IDEMPOTENCY_KEY_REUSED');

    // --- 7. THE DEVICE CANNOT BE TALKED OUT OF IT: declining a provider switch is recorded, and the run
    // --- must NOT move to another device on the strength of it.
    await control(`tasks/${strictId}/switch-declined`, {});
    const afterDecline = await taskState(strictId);
    assert.equal(afterDecline.handoffTargetRef, undefined, 'a user-targeted run must never acquire a handoff reservation');
    assert.equal(afterDecline.assignedNodeId, null);
    const refusals = (await control('events')).body.events.filter(e => e.type === 'TASK_HANDOFF_REFUSED' && e.taskId === strictId);
    assert.ok(refusals.some(e => e.payload.reason === TARGET_REASONS.BOUND), 'the refusal must say WHY nothing moved');

    // --- 8. The named device returns. It claims, runs and finishes, and the canonical stream says so.
    alien = await startAgent({ url: gateway.url, token: 'mesh-node', workspace: resolve(dir, 'alien-work'), id: ALIEN, displayName: ALIEN, interval: 100, stepDelay: 50 });
    let final;
    for (let i = 0; i < 120; i++) { final = await taskState(strictId); if (final.state === 'COMPLETED') break; await sleep(100); }
    assert.equal(final.state, 'COMPLETED', 'the device the user named must be able to complete the run');
    assert.equal(final.assignedNodeId, ALIEN);
    const events = (await control('events')).body.events.filter(e => e.taskId === strictId).map(e => e.type);
    assert.ok(events.includes('TASK_TARGET_READY'), 'the reconnect must be observable in the canonical stream');
    assert.ok(events.includes('TASK_STARTED') && events.includes('TASK_COMPLETED'));
    // The waiting event precedes the ready event precedes completion: a canonical `seq` order the three
    // surfaces can converge on, rather than three local clocks to compare.
    const seqOf = async type => (await control('events')).body.events.filter(e => e.taskId === strictId && e.type === type).at(-1).seq;
    const [waitSeq, readySeq, doneSeq] = await Promise.all(['TASK_TARGET_WAITING', 'TASK_TARGET_READY', 'TASK_COMPLETED'].map(seqOf));
    assert.ok(waitSeq < readySeq && readySeq < doneSeq, 'canonical seq must order wait -> ready -> completed');
  } finally {
    await alien?.stop();
    await gateway?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
