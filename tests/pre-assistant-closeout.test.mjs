/**
 * Pre-assistant product closeout (T1–T3) — bounded real chain.
 *
 * Every case here drives the real gateway against a real Room Hub on loopback. Nothing is
 * mocked except the two things that must be controllable to be testable honestly:
 *   - a gateway pointed at a closed port, to prove `available:false` is a truthful state
 *     rather than an exception;
 *   - the absence of a node, to prove a City task reports UNAVAILABLE instead of pretending.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { startRoomHub } from '../apps/rooms/hub/server.mjs';

const TOKEN = 'product-closeout-control';
const NODE_TOKEN = 'product-closeout-node';

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'X-City-Api-Version': '0',
  'X-City-Schema-Version': '0',
});

/** The hub's own URL already ends in a slash; everything here must tolerate that. */
const withoutSlash = (value) => String(value).replace(/\/+$/, '');

async function withStack(run, { roomHubUrl } = {}) {
  const hubDir = await mkdtemp(resolve('.scratch-rooms-'));
  const dir = await mkdtemp(resolve('.scratch-gateway-'));
  let hub;
  let app;
  try {
    hub = await startRoomHub({ host: '127.0.0.1', port: 0, runtimeDir: hubDir });
    app = await createGateway({
      host: '127.0.0.1',
      port: 0,
      dir,
      token: TOKEN,
      nodeToken: NODE_TOKEN,
      hostId: 'TEST-HOST',
      roomHubUrl: roomHubUrl === undefined ? hub.url : roomHubUrl,
    });
    const call = (path, body, token = TOKEN) => fetch(`${app.url}/api/v0/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: headers(token),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = async (path, body, token = TOKEN) => {
      const response = await call(path, body, token);
      return { status: response.status, body: await response.json() };
    };
    const node = (path, body) => call(`node/${path}`, body, NODE_TOKEN);
    const hubApi = (path) => fetch(`${withoutSlash(hub.url)}${path}`).then((response) => response.json());
    return await run({ app, hub, call, json, node, hubApi, hubUrl: hub.url, dir });
  } finally {
    if (app) await app.close();
    if (hub) await new Promise((done) => hub.server.close(done));
    await rm(hubDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
}

test('T1: the Web shell is served from apps/web and cannot be escaped', async () => {
  await withStack(async ({ app }) => {
    const shell = await fetch(`${app.url}/`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /<html/i);
    const script = await fetch(`${app.url}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    const traversal = await fetch(`${app.url}/..%2f..%2fpackage.json`);
    assert.ok([403, 404].includes(traversal.status), `traversal returned ${traversal.status}`);
    assert.ok(!(await traversal.text()).includes('pnpm-lock'));
  }, { roomHubUrl: 'http://127.0.0.1:1' });
});

test('T1: rooms are reported truthfully when the hub is up', async () => {
  await withStack(async ({ json, hubUrl }) => {
    const available = await json('rooms');
    assert.equal(available.status, 200);
    assert.equal(available.body.rooms.available, true);
    assert.equal(available.body.rooms.count, 10, 'the accepted Room Pack has ten rooms');
    assert.equal(available.body.rooms.hubUrl, `${withoutSlash(hubUrl)}/`);
    assert.ok(available.body.rooms.hubUrl.startsWith('http://127.0.0.1:'), 'the catalog URL stays loopback');
    const ids = available.body.rooms.rooms.map((room) => room.id);
    for (const expected of ['knowledge', 'bookmarks', 'checklist', 'prompts', 'text-workshop', 'hash', 'data-lab', 'focus', 'calendar', 'decisions']) {
      assert.ok(ids.includes(expected), `room ${expected} is present`);
    }
  });
});

test('T1: an unreachable Room Hub is a state, not an error', async () => {
  // Port 1 on loopback is closed, so the hub is genuinely absent.
  await withStack(async ({ json }) => {
    const { status, body } = await json('rooms');
    assert.equal(status, 200, 'the product must be able to render UNAVAILABLE');
    assert.equal(body.rooms.available, false);
    assert.equal(body.rooms.hubUrl, null);
    assert.match(body.rooms.reason, /not reachable|did not answer/i);
    assert.equal(body.rooms.count, 10, 'the catalog is still shown, marked unavailable');
  }, { roomHubUrl: 'http://127.0.0.1:1' });
});

test('T2: a Room Action keeps the Room own truth and is idempotent', async () => {
  await withStack(async ({ json, hubApi }) => {
    const payload = {
      intent: 'add buy milk to my checklist',
      route: 'ROOM',
      target: 'checklist',
      operation: 'checklist.add-item',
      input: { itemText: 'buy milk' },
      idempotencyKey: 'test-key-1',
    };
    const first = await json('actions', payload);
    assert.equal(first.status, 200);
    assert.equal(first.body.action.status, 'SUCCEEDED');
    assert.equal(first.body.action.route, 'ROOM');
    assert.equal(first.body.action.backendRef.roomId, 'checklist');
    assert.equal(first.body.action.progress, 100);
    assert.ok(first.body.action.resultRef.id, 'a real room record id is referenced');
    assert.equal(first.body.action.provenance.host, 'TEST-HOST');
    assert.equal(first.body.action.provenance.source, 'utopia.dev-gateway');

    const readItems = async () => {
      const lists = await hubApi('/local-rooms/v1/checklist/checklists');
      return lists.checklists.flatMap((list) => list.items).filter((item) => item.text === 'buy milk');
    };
    assert.equal((await readItems()).length, 1, 'the item really exists in the Room');

    // Same key -> same Action, and no second execution.
    const replay = await json('actions', payload);
    assert.equal(replay.body.action.actionId, first.body.action.actionId);
    assert.equal((await readItems()).length, 1, 'no duplicate execution on replay');

    // The Action is readable by id and appears in the list, unchanged.
    const byId = await json(`actions/${first.body.action.actionId}`);
    assert.equal(byId.body.action.actionId, first.body.action.actionId);
    assert.equal(byId.body.action.status, 'SUCCEEDED');
    const list = await json('actions?limit=10');
    assert.ok(list.body.actions.some((action) => action.actionId === first.body.action.actionId));
  });
});

test('T2: a Capability Action carries the real invocation identity', async () => {
  await withStack(async ({ json, dir }) => {
    const file = join(dir, 'note.txt');
    await writeFile(file, 'Utopia pre-assistant closeout.\nSecond line.\n', 'utf8');

    const intake = await json('actions', {
      intent: `read document ${file}`,
      route: 'CAPABILITY',
      target: 'planning.document.intake',
      operation: 'read',
      input: { path: file },
    });
    assert.equal(intake.body.action.status, 'SUCCEEDED');
    assert.equal(intake.body.action.backendRef.capabilityId, 'planning.document.intake');
    assert.match(intake.body.action.backendRef.invocationId, /^I-/);
    assert.equal(intake.body.action.resultRef.kind, 'CAPABILITY_RESULT');
    assert.ok(intake.body.action.resultRef.digest, 'the invocation digest is retained');
    assert.equal(intake.body.action.provenance.invocationId, intake.body.action.backendRef.invocationId);

    // A refused operation stays REFUSED, never FAILED and never SUCCEEDED.
    const refused = await json('actions', {
      intent: 'read a document with the wrong operation',
      route: 'CAPABILITY',
      target: 'planning.document.intake',
      operation: 'not-an-operation',
      input: {},
    });
    assert.equal(refused.body.action.status, 'REFUSED');
    assert.equal(refused.body.action.error.code, 'OPERATION_BLOCKED');
  });
});

test('T2: a City task is UNAVAILABLE with no node, and follows the real task when there is one', async () => {
  await withStack(async ({ json, node }) => {
    const request = {
      intent: 'run a safe task of type WAIT',
      route: 'CITY_TASK',
      target: 'city.task',
      operation: 'WAIT',
      input: {},
    };

    const noNode = await json('actions', request);
    assert.equal(noNode.body.action.status, 'UNAVAILABLE');
    assert.match(noNode.body.action.error.message, /no online node/i);
    assert.equal(noNode.body.action.backendRef.taskId, null, 'no task is created when nothing can run it');
    assert.equal(noNode.body.action.resultRef, null, 'UNAVAILABLE never carries a fabricated result');

    const registered = await node('register', {
      id: 'closeout-node',
      displayName: 'Closeout reference node',
      metadata: { platform: 'test' },
      capabilities: ['task.execute.safe', 'filesystem.temp'],
    });
    assert.equal(registered.status, 200);

    const withNode = await json('actions', { ...request, idempotencyKey: 'city-task-1' });
    assert.equal(withNode.body.action.status, 'QUEUED', 'the real City Control state is mapped, not invented');
    assert.match(withNode.body.action.backendRef.taskId, /^Q-/);
    assert.equal(withNode.body.action.provenance.taskId, withNode.body.action.backendRef.taskId);

    const taskId = withNode.body.action.backendRef.taskId;
    const task = await json(`tasks/${taskId}`);
    assert.equal(task.body.state, 'QUEUED', 'the facade points at the real task');

    // The Action follows the task's real state instead of caching the first answer.
    await node('claim', { id: 'closeout-node' });
    const running = await json(`actions/${withNode.body.action.actionId}`);
    assert.equal(running.body.action.status, 'RUNNING');
    await node('report', { id: 'closeout-node', taskId, state: 'RUNNING', progress: 40 });
    const midway = await json(`actions/${withNode.body.action.actionId}`);
    assert.equal(midway.body.action.progress, 40);
    await node('report', { id: 'closeout-node', taskId, state: 'COMPLETED', progress: 100, result: { ok: true } });
    const done = await json(`actions/${withNode.body.action.actionId}`);
    assert.equal(done.body.action.status, 'SUCCEEDED');
    assert.equal(done.body.action.resultRef.kind, 'CITY_TASK_RESULT');
  });
});

test('T3: Ask / Do routes deterministically, refuses to guess, and confirms side effects', async () => {
  await withStack(async ({ json, dir }) => {
    const file = join(dir, 'hash-me.txt');
    await writeFile(file, 'hash me\n', 'utf8');

    // A single high-confidence match runs without confirmation.
    const hash = await json('ask', { text: `hash ${file}` });
    assert.equal(hash.body.ask.status, 'COMPLETED');
    assert.equal(hash.body.ask.router, 'DETERMINISTIC_RULES');
    assert.equal(hash.body.ask.llm, false);
    assert.equal(hash.body.ask.route, 'ROOM');
    assert.match(hash.body.ask.action.resultRef.digest, /^[0-9a-f]{64}$/);

    // Two genuinely plausible owners -> show both instead of choosing.
    const ambiguous = await json('ask', { text: 'search knowledge for gateway port' });
    assert.equal(ambiguous.body.ask.status, 'AMBIGUOUS');
    assert.equal(ambiguous.body.ask.action, null, 'nothing executes while the request is ambiguous');
    const routes = ambiguous.body.ask.candidates.map((candidate) => `${candidate.route}:${candidate.target}`).sort();
    assert.deepEqual(routes, ['CAPABILITY:planning.knowledge.query', 'ROOM:knowledge']);
    assert.ok(ambiguous.body.ask.candidates.every((candidate) => candidate.description), 'each candidate says what it will do');

    // Choosing one executes exactly that one, with the rule's own extracted input.
    const chosen = await json('ask', {
      text: 'search knowledge for gateway port',
      selection: { route: 'ROOM', target: 'knowledge', operation: 'knowledge.search' },
    });
    assert.equal(chosen.body.ask.status, 'COMPLETED');
    assert.equal(chosen.body.ask.action.route, 'ROOM');
    assert.equal(chosen.body.ask.action.backendRef.operationId, 'knowledge.search');

    const capability = await json('ask', {
      text: 'search knowledge for gateway port',
      selection: { route: 'CAPABILITY', target: 'planning.knowledge.query', operation: 'query' },
    });
    assert.equal(capability.body.ask.action.route, 'CAPABILITY');
    assert.match(capability.body.ask.action.backendRef.invocationId, /^I-/);

    // A side-effecting target cannot run on the first pass.
    const needsConfirmation = await json('ask', { text: 'run a safe task of type WAIT' });
    assert.equal(needsConfirmation.body.ask.status, 'AWAITING_CONFIRMATION');
    assert.equal(needsConfirmation.body.ask.action, null, 'nothing executes before the user confirms');
    assert.equal(needsConfirmation.body.ask.confirmation.sideEffect, true);

    const confirmed = await json('ask', {
      text: 'run a safe task of type WAIT',
      selection: { route: 'CITY_TASK', target: 'city.task', operation: 'WAIT' },
      confirm: true,
    });
    assert.notEqual(confirmed.body.ask.status, 'AWAITING_CONFIRMATION');
    assert.ok(confirmed.body.ask.action, 'after confirmation the action really runs');
    assert.equal(confirmed.body.ask.action.route, 'CITY_TASK');
    assert.equal(confirmed.body.ask.action.status, 'UNAVAILABLE', 'still truthful with no node available');

    // No rule -> the manual picker, and still nothing executed.
    const unmatched = await json('ask', { text: 'please do the thing with the stuff' });
    assert.equal(unmatched.body.ask.status, 'UNMATCHED');
    assert.equal(unmatched.body.ask.action, null);
    assert.ok(unmatched.body.ask.candidates.length >= 10, 'the manual picker offers the real targets');

    const targets = await json('ask/targets');
    assert.equal(targets.body.targets.length, unmatched.body.ask.candidates.length);
    assert.ok(targets.body.targets.every((target) => ['ROOM', 'CAPABILITY', 'CITY_TASK'].includes(target.route)));

    // Every route the workbook names has a deterministic path.
    const doc = await json('ask', { text: `read document ${file}` });
    assert.equal(doc.body.ask.route, 'CAPABILITY');
    assert.equal(doc.body.ask.target, 'planning.document.intake');
    const evidence = await json('ask', { text: 'review evidence' });
    assert.equal(evidence.body.ask.route, 'CAPABILITY');
    const bookmark = await json('ask', { text: 'save this link https://example.com/a' });
    assert.equal(bookmark.body.ask.status, 'COMPLETED');
    assert.equal(bookmark.body.ask.route, 'ROOM');
    const checklist = await json('ask', { text: 'add call the owner to my checklist' });
    assert.equal(checklist.body.ask.status, 'COMPLETED');
    const theme = await json('ask', { text: 'generate a theme for a research dashboard' });
    assert.equal(theme.body.ask.route, 'CAPABILITY');
    assert.equal(theme.body.ask.target, 'presentation.theme.lab');
  });
});

test('scope: no BOSS or HNS route can be created, by any path', async () => {
  await withStack(async ({ json }) => {
    for (const route of ['BOSS', 'HNS', 'SYSTEM', 'SHELL']) {
      const rejected = await json('actions', { intent: 'x', route, target: 'anything', operation: 'x', input: {} });
      assert.equal(rejected.status, 400, `${route} must be refused`);
      assert.match(rejected.body.error, /route must be one of ROOM, CAPABILITY, CITY_TASK/);
    }
    const targets = await json('ask/targets');
    assert.ok(targets.body.targets.every((target) => !/boss|hns/i.test(JSON.stringify(target))));
  }, { roomHubUrl: 'http://127.0.0.1:1' });
});

test('T1.1: health reflects real readiness instead of being a constant', async () => {
  // Healthy host.
  await withStack(async ({ json }) => {
    const health = await json('health');
    assert.equal(health.body.status, 'healthy');
    assert.equal(health.body.components.gateway.state, 'READY');
    assert.equal(health.body.components.rooms.state, 'READY');
    assert.match(health.body.components.rooms.hubUrl, /^http:\/\/127\.0\.0\.1:/);
  });
  // Same product, dead Room Hub: the status must say so.
  await withStack(async ({ json }) => {
    const health = await json('health');
    assert.equal(health.body.status, 'degraded', 'a supervisor must be able to see the degradation');
    assert.equal(health.body.components.gateway.state, 'READY');
    assert.equal(health.body.components.rooms.state, 'UNAVAILABLE');
    assert.match(health.body.components.rooms.reason, /not reachable|did not answer/i);
    assert.equal(health.body.components.rooms.hubUrl, null);
  }, { roomHubUrl: 'http://127.0.0.1:1' });
});

test('T2: an idempotency key is bound to one request', async () => {
  await withStack(async ({ json, hubApi }) => {
    const first = await json('actions', {
      intent: 'add keyed item to my checklist',
      route: 'ROOM',
      target: 'checklist',
      operation: 'checklist.add-item',
      input: { itemText: 'keyed item' },
      idempotencyKey: 'bound-key-1',
    });
    assert.equal(first.body.action.status, 'SUCCEEDED');

    // Same key, same request -> replay, no second execution.
    const replay = await json('actions', {
      intent: 'add keyed item to my checklist',
      route: 'ROOM',
      target: 'checklist',
      operation: 'checklist.add-item',
      input: { itemText: 'keyed item' },
      idempotencyKey: 'bound-key-1',
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.action.actionId, first.body.action.actionId);

    // Same key, DIFFERENT request -> refused, never a silent replay of something else.
    const reused = await json('actions', {
      intent: 'add a different item to my checklist',
      route: 'ROOM',
      target: 'checklist',
      operation: 'checklist.add-item',
      input: { itemText: 'a different item' },
      idempotencyKey: 'bound-key-1',
    });
    assert.equal(reused.status, 400);
    assert.equal(reused.body.errorCode, 'IDEMPOTENCY_KEY_REUSED');

    const lists = await hubApi('/local-rooms/v1/checklist/checklists');
    const items = lists.checklists.flatMap((list) => list.items).map((item) => item.text);
    assert.equal(items.filter((text) => text === 'keyed item').length, 1, 'no duplicate execution on replay');
    assert.equal(items.filter((text) => text === 'a different item').length, 0, 'the reused key must not execute');
  });
});

test('T2: City task provenance follows the real task state', async () => {
  await withStack(async ({ json, node }) => {
    await node('register', {
      id: 'closeout-node-2',
      displayName: 'Closeout reference node',
      metadata: { platform: 'test' },
      capabilities: ['task.execute.safe', 'filesystem.temp'],
    });
    const created = await json('actions', {
      intent: 'run a safe task of type HASH_TEMP_ARTIFACT',
      route: 'CITY_TASK',
      target: 'city.task',
      operation: 'HASH_TEMP_ARTIFACT',
      input: {},
      idempotencyKey: 'city-task-provenance',
    });
    assert.equal(created.body.action.provenance.cityTaskState, 'QUEUED');

    const taskId = created.body.action.backendRef.taskId;
    await node('claim', { id: 'closeout-node-2' });
    await node('report', { id: 'closeout-node-2', taskId, state: 'RUNNING', progress: 50 });
    await node('report', { id: 'closeout-node-2', taskId, state: 'COMPLETED', progress: 100, result: { ok: true } });

    const done = await json(`actions/${created.body.action.actionId}`);
    assert.equal(done.body.action.status, 'SUCCEEDED');
    assert.equal(done.body.action.provenance.cityTaskState, 'COMPLETED', 'provenance must not keep claiming QUEUED');
  });
});
