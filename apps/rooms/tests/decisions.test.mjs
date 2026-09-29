/**
 * Room 10 — Decision Room focused tests (budget: <= 5).
 * Status is limited to OPEN / DECIDED / REVISIT; there is no voting or approval.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestHub } from './harness.mjs';
import { DECISION_STATUSES } from '../rooms/decisions/room.server.mjs';

const API = '/local-rooms/v1/decisions';

test('decision room records a question with options and opens as OPEN', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const created = await hub.api('POST', `${API}/decisions`, {
    question: 'Which storage shape?',
    context: 'local only',
    options: ['single json file', 'one file per room'],
    tags: ['Architecture'],
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.decision.status, 'OPEN');
  assert.equal(created.payload.decision.decidedAt, null);
  assert.equal(created.payload.decision.options.length, 2);
  assert.deepEqual(created.payload.decision.tags, ['architecture']);

  assert.equal((await hub.api('POST', `${API}/decisions`, { options: ['x'] })).status, 400);
  assert.equal((await hub.api('POST', `${API}/decisions`, { question: 'q', status: 'MAYBE' })).status, 400);
});

test('decision room appends options and keeps selected option ids stable', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  const decision = (await hub.api('POST', `${API}/decisions`, { question: 'Pick', options: ['a', 'b'] })).payload.decision;
  const optionA = decision.options[0].id;

  const added = await hub.api('POST', `${API}/decisions/${decision.id}/options`, { text: 'c' });
  assert.equal(added.payload.decision.options.length, 3);

  const edited = await hub.api('PATCH', `${API}/decisions/${decision.id}`, {
    options: ['a', 'b', 'c'],
    selectedOptionId: optionA,
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.payload.decision.options[0].id, optionA, 'unchanged option text keeps its id');
  assert.equal(edited.payload.decision.selectedOptionId, optionA);

  const invalid = await hub.api('PATCH', `${API}/decisions/${decision.id}`, { selectedOptionId: 'not-an-option' });
  assert.equal(invalid.status, 400);
});

test('decision room decide and revisit transitions', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  const decision = (await hub.api('POST', `${API}/decisions`, { question: 'Ship now?', options: ['yes', 'no'] })).payload.decision;
  const yes = decision.options[0].id;

  const decided = await hub.api('POST', `${API}/decisions/${decision.id}/decide`, { selectedOptionId: yes, rationale: 'small blast radius' });
  assert.equal(decided.payload.decision.status, 'DECIDED');
  assert.equal(decided.payload.decision.decision, 'yes', 'the chosen option text is used when no decision text is given');
  assert.ok(!Number.isNaN(Date.parse(decided.payload.decision.decidedAt)));

  const revisited = await hub.api('POST', `${API}/decisions/${decision.id}/revisit`, {});
  assert.equal(revisited.payload.decision.status, 'REVISIT');

  assert.equal((await hub.api('POST', `${API}/decisions/missing/decide`, {})).status, 404);
  assert.equal((await hub.api('POST', `${API}/decisions/missing/revisit`, {})).status, 404);
});

test('decision room searches and filters by status', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  await hub.api('POST', `${API}/decisions`, { question: 'Use SQLite?', context: 'durability', options: ['yes', 'no'], tags: ['storage'] });
  const second = (await hub.api('POST', `${API}/decisions`, { question: 'Use a queue?', options: ['yes', 'no'] })).payload.decision;
  await hub.api('POST', `${API}/decisions/${second.id}/decide`, { selectedOptionId: second.options[0].id });

  assert.equal((await hub.api('GET', `${API}/decisions?q=sqlite`)).payload.total, 1);
  assert.equal((await hub.api('GET', `${API}/decisions?q=durability`)).payload.total, 1);
  assert.equal((await hub.api('GET', `${API}/decisions?tag=storage`)).payload.total, 1);
  assert.equal((await hub.api('GET', `${API}/decisions?status=DECIDED`)).payload.total, 1);
  assert.equal((await hub.api('GET', `${API}/decisions?status=OPEN`)).payload.total, 1);
  assert.equal((await hub.api('GET', `${API}/decisions?status=BOGUS`)).status, 400);
  assert.deepEqual((await hub.api('GET', `${API}/decisions`)).payload.statuses, DECISION_STATUSES);
});

test('decision export/import replaces data, validates payloads and survives a restart', async (t) => {
  const hub = await startTestHub();
  const decision = (await hub.api('POST', `${API}/decisions`, { question: 'Persist me', options: ['y', 'n'] })).payload.decision;
  await hub.api('POST', `${API}/decisions/${decision.id}/decide`, { selectedOptionId: decision.options[0].id });

  const bundle = (await hub.api('GET', `${API}/export`)).payload;
  assert.equal(bundle.format, 'utopia-rooms-decisions');
  assert.equal(bundle.decisions.length, 1);
  assert.equal((await hub.api('POST', `${API}/import`, { ...bundle, format: 'x' })).status, 400);
  assert.equal((await hub.api('POST', `${API}/import`, { ...bundle, decisions: [{ id: 'd', question: 'q', status: 'NOPE' }] })).status, 400);
  assert.equal((await hub.api('GET', `${API}/decisions`)).payload.total, 1);

  // a second hub instance on the same runtime directory simulates a real restart
  const { createRoomHubServer, HOST } = await import('../hub/server.mjs');
  const restarted = await createRoomHubServer({ runtimeDir: hub.runtimeDir });
  await new Promise((resolve) => restarted.listen(0, HOST, resolve));
  const base = `http://${HOST}:${restarted.address().port}`;
  t.after(() => new Promise((done) => restarted.close(done)));

  const restored = await (await fetch(`${base}${API}/decisions`)).json();
  assert.equal(restored.total, 1);
  assert.equal(restored.decisions[0].status, 'DECIDED');

  const deleted = await fetch(`${base}${API}/decisions/${decision.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const empty = await (await fetch(`${base}${API}/decisions`)).json();
  assert.equal(empty.total, 0);
});
