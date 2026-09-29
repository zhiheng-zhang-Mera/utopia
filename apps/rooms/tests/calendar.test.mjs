/**
 * Room 09 — Calendar Room focused tests (budget: <= 5).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestHub } from './harness.mjs';
import { bySchedule, localDateKey, splitByDay } from '../rooms/calendar/room.server.mjs';

const API = '/local-rooms/v1/calendar';

test('calendar room creates, edits and deletes a dated event', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const created = await hub.api('POST', `${API}/events`, {
    title: 'Review',
    date: '2026-10-02',
    startTime: '09:00',
    endTime: '10:00',
    label: 'work',
    note: 'bring notes',
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.event.startTime, '09:00');

  const edited = await hub.api('PATCH', `${API}/events/${created.payload.event.id}`, { title: 'Review moved', startTime: '11:00', endTime: '12:00' });
  assert.equal(edited.payload.event.title, 'Review moved');

  assert.equal((await hub.api('DELETE', `${API}/events/${created.payload.event.id}`)).status, 200);
  assert.equal((await hub.api('GET', `${API}/events`)).payload.total, 0);
  assert.equal((await hub.api('PATCH', `${API}/events/missing`, { title: 'x' })).status, 404);
});

test('calendar room validates dates and times', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const bad = [
    { title: 'x', date: '02-10-2026' },
    { title: 'x', date: '2026-10-02', startTime: '25:00' },
    { title: 'x', date: '2026-10-02', startTime: '9:00' },
    { title: 'x', date: '2026-10-02', startTime: '12:00', endTime: '11:00' },
    { date: '2026-10-02' },
  ];
  for (const payload of bad) {
    const response = await hub.api('POST', `${API}/events`, payload);
    assert.equal(response.status, 400, JSON.stringify(payload));
  }

  const created = await hub.api('POST', `${API}/events`, { title: 'ok', date: '2026-10-02' });
  const reversed = await hub.api('PATCH', `${API}/events/${created.payload.event.id}`, { startTime: '15:00', endTime: '14:00' });
  assert.equal(reversed.status, 400, 'edit-time validation still applies');
});

test('calendar groups events into today, upcoming and past in order', () => {
  const events = [
    { id: 'b', title: 'beta', date: '2026-10-03', startTime: '10:00' },
    { id: 'a', title: 'alpha', date: '2026-10-03', startTime: '08:00' },
    { id: 'c', title: 'gamma', date: '2026-10-05' },
    { id: 'p', title: 'past', date: '2026-10-01' },
  ];
  const groups = splitByDay(events, '2026-10-03');
  assert.deepEqual(groups.today.map((event) => event.title), ['alpha', 'beta']);
  assert.deepEqual(groups.upcoming.map((event) => event.title), ['gamma']);
  assert.deepEqual(groups.past.map((event) => event.title), ['past']);
  assert.equal([...events].sort(bySchedule)[0].title, 'past');
});

test('calendar scope filters today and upcoming over HTTP', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  const today = localDateKey(new Date());
  const future = new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10);

  await hub.api('POST', `${API}/events`, { title: 'Today standup', date: today, startTime: '09:30' });
  await hub.api('POST', `${API}/events`, { title: 'Future review', date: future, startTime: '14:00' });

  const todayOnly = await hub.api('GET', `${API}/events?scope=today`);
  assert.equal(todayOnly.payload.total, 1);
  assert.equal(todayOnly.payload.events[0].title, 'Today standup');
  assert.equal(todayOnly.payload.today, 1);

  const upcoming = await hub.api('GET', `${API}/events?scope=upcoming`);
  assert.equal(upcoming.payload.total, 1);
  assert.equal(upcoming.payload.events[0].title, 'Future review');

  const search = await hub.api('GET', `${API}/events?q=standup`);
  assert.equal(search.payload.total, 1);
});

test('calendar export/import replaces events and data survives a restart', async (t) => {
  const hub = await startTestHub();
  await hub.api('POST', `${API}/events`, { title: 'One', date: '2026-11-01', label: 'work' });
  await hub.api('POST', `${API}/events`, { title: 'Two', date: '2026-11-02' });

  const bundle = (await hub.api('GET', `${API}/export`)).payload;
  assert.equal(bundle.format, 'utopia-rooms-calendar');
  assert.equal(bundle.events.length, 2);
  assert.equal((await hub.api('POST', `${API}/import`, { ...bundle, events: [{ id: 'x', title: '', date: 'bad' }] })).status, 400);
  assert.equal((await hub.api('GET', `${API}/events`)).payload.total, 2);

  // a second hub instance on the same runtime directory simulates a real restart
  const { createRoomHubServer, HOST } = await import('../hub/server.mjs');
  const restarted = await createRoomHubServer({ runtimeDir: hub.runtimeDir });
  await new Promise((resolve) => restarted.listen(0, HOST, resolve));
  const base = `http://${HOST}:${restarted.address().port}`;
  t.after(() => new Promise((done) => restarted.close(done)));

  const afterRestart = await (await fetch(`${base}${API}/events`)).json();
  assert.equal(afterRestart.total, 2);
  assert.deepEqual(afterRestart.events.map((event) => event.title), ['One', 'Two']);
});
