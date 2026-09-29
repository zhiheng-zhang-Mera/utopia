/**
 * Room 08 — Focus Room focused tests (budget: <= 5).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestHub } from './harness.mjs';
import { FOCUS_PRESETS, focusSummary, localDateKey } from '../rooms/focus/room.server.mjs';

const API = '/local-rooms/v1/focus';

test('focus room exposes presets and completes a real short session', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const initial = await hub.api('GET', `${API}/state`);
  assert.deepEqual(initial.payload.presets, FOCUS_PRESETS);
  assert.equal(initial.payload.active, null);
  assert.equal(initial.payload.summary.minutesToday, 0);

  const started = await hub.api('POST', `${API}/sessions/start`, { label: 'writing', plannedMinutes: 5 });
  assert.equal(started.status, 201);
  assert.equal(started.payload.active.label, 'writing');

  const state = await hub.api('GET', `${API}/state`);
  assert.equal(state.payload.active.id, started.payload.active.id, 'a running session is visible to the UI');

  const completed = await hub.api('POST', `${API}/sessions/complete`, { elapsedSeconds: 300 });
  assert.equal(completed.payload.session.elapsedSeconds, 300);
  assert.equal(completed.payload.summary.sessionsToday, 1);
  assert.equal(completed.payload.summary.minutesToday, 5);

  const after = await hub.api('GET', `${API}/state`);
  assert.equal(after.payload.active, null);
  assert.equal(after.payload.sessions.length, 1);
});

test('focus room records an interrupted session honestly after a reload', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  await hub.api('POST', `${API}/sessions/start`, { label: 'interrupted run', plannedMinutes: 25 });
  // a reload asks for state again: the session is still running server side
  const state = await hub.api('GET', `${API}/state`);
  assert.equal(state.payload.active.interrupted, true, 'state reports the session as interrupted');
  assert.equal(state.payload.sessions.length, 0, 'it is not silently added to history');

  const abandoned = await hub.api('POST', `${API}/sessions/abandon`, {});
  assert.equal(abandoned.payload.session.interrupted, true);
  const after = await hub.api('GET', `${API}/state`);
  assert.equal(after.payload.active, null);
  assert.equal(after.payload.sessions.length, 1);
  assert.equal(after.payload.sessions[0].interrupted, true);
});

test('focus room validates session input', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  assert.equal((await hub.api('POST', `${API}/sessions/start`, { plannedMinutes: 0 })).status, 400);
  assert.equal((await hub.api('POST', `${API}/sessions/start`, { plannedMinutes: 5000 })).status, 400);
  assert.equal((await hub.api('POST', `${API}/sessions/start`, { startedAt: 'not-a-date' })).status, 400);
  assert.equal((await hub.api('POST', `${API}/sessions/complete`, { elapsedSeconds: 60 })).status, 400, 'nothing to complete');
  assert.equal((await hub.api('POST', `${API}/sessions/abandon`, {})).status, 400, 'nothing to abandon');
});

test('focus room deletes a session and keeps the rest', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  await hub.api('POST', `${API}/sessions/start`, { label: 'one', plannedMinutes: 5 });
  const first = (await hub.api('POST', `${API}/sessions/complete`, { elapsedSeconds: 60 })).payload.session;
  await hub.api('POST', `${API}/sessions/start`, { label: 'two', plannedMinutes: 5 });
  await hub.api('POST', `${API}/sessions/complete`, { elapsedSeconds: 120 });

  assert.equal((await hub.api('DELETE', `${API}/sessions/${first.id}`)).status, 200);
  assert.equal((await hub.api('DELETE', `${API}/sessions/${first.id}`)).status, 404);
  const state = await hub.api('GET', `${API}/state`);
  assert.equal(state.payload.sessions.length, 1);
  assert.equal(state.payload.sessions[0].label, 'two');
});

test('focus summary counts today using local dates and sessions are durable', async (t) => {
  const key = localDateKey(new Date());
  const summary = focusSummary([
    { startedAt: new Date().toISOString(), elapsedSeconds: 600 },
    { startedAt: '2020-01-01T00:00:00.000Z', elapsedSeconds: 600 },
  ], key);
  assert.equal(summary.sessionsToday, 1);
  assert.equal(summary.minutesToday, 10);
  assert.equal(summary.sessionsTotal, 2);
  assert.equal(summary.minutesTotal, 20);

  const hub = await startTestHub();
  await hub.api('POST', `${API}/sessions/start`, { label: 'durable', plannedMinutes: 5 });
  await hub.api('POST', `${API}/sessions/complete`, { elapsedSeconds: 120 });

  // a second hub instance on the same runtime directory simulates a real restart
  const { createRoomHubServer, HOST } = await import('../hub/server.mjs');
  const restarted = await createRoomHubServer({ runtimeDir: hub.runtimeDir });
  await new Promise((resolve) => restarted.listen(0, HOST, resolve));
  const base = `http://${HOST}:${restarted.address().port}`;
  t.after(() => new Promise((done) => restarted.close(done)));

  const state = await (await fetch(`${base}${API}/state`)).json();
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].label, 'durable');
  assert.equal(state.active, null);
});
