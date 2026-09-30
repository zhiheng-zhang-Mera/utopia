/**
 * dev-gateway Action status truth — Correction regressions (host Alien, GAI-001).
 *
 * `reconcile()` was the one path that could rewrite a finished Action's status, and it had no
 * test at all: it is reachable only through a CITY_TASK Action backed by a live City task, which
 * nothing in this repository set up. The rule is therefore exported as `reconcileStatus` and
 * tested here directly, and the reserved GENERAL_AI route is exercised through the real facade —
 * which is also the first test this route has ever had.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_ROUTES, FINAL_ACTION_STATUSES, createActions, reconcileStatus,
} from '../services/dev-gateway/actions.mjs';

/** Minimal in-memory stand-in for services/dev-gateway/store.mjs. */
function makeStore() {
  const tables = new Map();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  return {
    list: (table) => [...(tables.get(table)?.values() ?? [])].map(clone),
    get: (table, id) => {
      const value = tables.get(table)?.get(id);
      return value ? clone(value) : null;
    },
    put: (table, value) => {
      if (!tables.has(table)) tables.set(table, new Map());
      tables.get(table).set(value.id, clone(value));
      return value;
    },
  };
}

function makeActions() {
  const store = makeStore();
  let ticks = 0;
  const cityTasks = {
    terminal: ['COMPLETED', 'FAILED', 'CANCELLED'],
    get: () => null,
    availability: () => ({ available: false, reason: 'no node' }),
    create: () => { throw new Error('cityTasks.create must not be called by a non-CITY_TASK route'); },
  };
  const actions = createActions({
    store,
    rooms: { call: async () => { throw Object.assign(new Error('no hub'), { code: 'ROOM_HUB_UNREACHABLE' }); } },
    bridge: { invoke: async () => { throw Object.assign(new Error('no bridge'), { code: 'CAPABILITY_UNAVAILABLE' }); } },
    cityTasks,
    host: 'test-host',
    now: () => new Date(Date.UTC(2026, 8, 30, 12, 0, ticks++)).toISOString(),
  });
  return { actions, store };
}

test('a finished Action is never re-opened by a later observation', () => {
  assert.deepEqual([...FINAL_ACTION_STATUSES], ['SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED', 'UNAVAILABLE']);
  for (const current of FINAL_ACTION_STATUSES) {
    for (const observed of ['QUEUED', 'RUNNING', 'WAITING_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUSED', 'UNAVAILABLE']) {
      const decision = reconcileStatus(current, observed);
      if (observed === current) {
        assert.deepEqual(decision, { status: current, refused: null }, `${current} against itself is a no-op`);
        continue;
      }
      assert.equal(decision.status, current, `${current} must not become ${observed}`);
      assert.equal(decision.refused, observed, `the refused observation is reported, not lost`);
    }
  }
});

test('an in-flight Action still follows the City task it is reporting on', () => {
  for (const current of ['QUEUED', 'RUNNING', 'WAITING_CONFIRMATION']) {
    for (const observed of ['QUEUED', 'RUNNING', 'WAITING_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUSED']) {
      const decision = reconcileStatus(current, observed);
      assert.equal(decision.status, observed, `${current} may become ${observed} while it is in flight`);
      assert.equal(decision.refused, null);
    }
  }
});

test('the reserved GENERAL_AI route answers a typed UNAVAILABLE and never becomes a City task', async () => {
  const { actions } = makeActions();
  assert.deepEqual([...ACTION_ROUTES], ['ROOM', 'CAPABILITY', 'CITY_TASK', 'GENERAL_AI']);

  const created = await actions.create({
    route: 'GENERAL_AI', target: 'openai', operation: 'chat', input: { text: 'hi' }, idempotencyKey: 'gai-1',
  });
  assert.equal(created.action.status, 'UNAVAILABLE', 'a route with no executor must not report success');
  assert.equal(created.action.error.code, 'GENERAL_AI_NOT_ATTACHED');
  assert.equal(created.action.backendRef.kind, 'GENERAL_AI');
  // Typed references, all null until a channel resolves them - and never a City task identity.
  assert.equal(created.action.backendRef.taskId, undefined);
  assert.equal(created.action.backendRef.providerRef, null);
  assert.equal(created.action.backendRef.conversationId, null);
  assert.match(created.action.target.label, /^General AI /, 'the UI label must not call it a City task');

  // Replaying the same request is a replay, and the status is still UNAVAILABLE, not SUCCEEDED.
  const replay = await actions.create({
    route: 'GENERAL_AI', target: 'openai', operation: 'chat', input: { text: 'hi' }, idempotencyKey: 'gai-1',
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.action.status, 'UNAVAILABLE');

  // And a read of the stored Action agrees with what was returned.
  assert.equal(actions.get(created.action.id).status, 'UNAVAILABLE');
});

test('a reordered idempotency key is the same request, and a different one is refused', async () => {
  const { actions } = makeActions();
  const first = await actions.create({
    route: 'ROOM', target: 'hash', operation: 'hash.hash-file', input: { path: 'p', flag: true }, idempotencyKey: 'k-order',
  });
  const reordered = await actions.create({
    route: 'ROOM', target: 'hash', operation: 'hash.hash-file', input: { flag: true, path: 'p' }, idempotencyKey: 'k-order',
  });
  assert.equal(reordered.replayed, true, 'key order does not make a new request');
  assert.equal(reordered.action.id, first.action.id);

  await assert.rejects(
    async () => actions.create({
      route: 'ROOM', target: 'hash', operation: 'hash.hash-file', input: { path: 'different', flag: true }, idempotencyKey: 'k-order',
    }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED' || error.status === 409 || /idempotenc/i.test(String(error.message)),
  );
});
