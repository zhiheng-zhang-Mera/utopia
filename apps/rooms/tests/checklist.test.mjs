/**
 * Room 03 — Checklist Room focused tests (budget: <= 5).
 * Also asserts the room does not reuse City Control task semantics.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startTestHub } from './harness.mjs';

const API = '/local-rooms/v1/checklist';

test('checklist room creates lists and items with progress', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const list = await hub.api('POST', `${API}/checklists`, { title: 'Trip', note: 'packing' });
  assert.equal(list.status, 201);
  assert.deepEqual(list.payload.checklist.progress, { total: 0, done: 0, open: 0, ratio: 0 });

  const first = await hub.api('POST', `${API}/checklists/${list.payload.checklist.id}/items`, { text: 'passport' });
  const second = await hub.api('POST', `${API}/checklists/${list.payload.checklist.id}/items`, { text: 'charger', dueDate: '2026-10-01' });
  assert.equal(first.status, 201);
  assert.equal(second.payload.item.dueDate, '2026-10-01');

  const toggled = await hub.api('PATCH', `${API}/checklists/${list.payload.checklist.id}/items/${first.payload.item.id}`, { done: true });
  assert.equal(toggled.payload.checklist.progress.done, 1);
  assert.equal(toggled.payload.checklist.progress.total, 2);

  assert.equal((await hub.api('POST', `${API}/checklists/${list.payload.checklist.id}/items`, { text: '' })).status, 400);
  assert.equal((await hub.api('POST', `${API}/checklists/missing/items`, { text: 'x' })).status, 404);
});

test('checklist items can be reordered and deleted', async (t) => {
  const hub = await startTestHub();
  const list = (await hub.api('POST', `${API}/checklists`, { title: 'Order' })).payload.checklist;
  const a = (await hub.api('POST', `${API}/checklists/${list.id}/items`, { text: 'a' })).payload.item;
  await hub.api('POST', `${API}/checklists/${list.id}/items`, { text: 'b' });
  await hub.api('POST', `${API}/checklists/${list.id}/items`, { text: 'c' });

  const moved = await hub.api('POST', `${API}/checklists/${list.id}/items/${a.id}/move`, { direction: 'down' });
  assert.equal(moved.payload.moved, true);
  assert.deepEqual(moved.payload.checklist.items.map((item) => item.text), ['b', 'a', 'c']);

  const atEdge = await hub.api('POST', `${API}/checklists/${list.id}/items/${a.id}/move`, { direction: 'up' });
  assert.equal(atEdge.payload.moved, true);
  assert.deepEqual(atEdge.payload.checklist.items.map((item) => item.text), ['a', 'b', 'c']);

  const first = atEdge.payload.checklist.items[0];
  const blocked = await hub.api('POST', `${API}/checklists/${list.id}/items/${first.id}/move`, { direction: 'up' });
  assert.equal(blocked.payload.moved, false, 'moving past the first item is a no-op, not an error');

  assert.equal((await hub.api('POST', `${API}/checklists/${list.id}/items/${first.id}/move`, { direction: 'sideways' })).status, 400);
  assert.equal((await hub.api('DELETE', `${API}/checklists/${list.id}/items/${first.id}`)).status, 200);
  assert.equal((await hub.api('DELETE', `${API}/checklists/${list.id}/items/missing`)).status, 404);
});

test('checklist clear-completed removes only done items', async (t) => {
  const hub = await startTestHub();
  const list = (await hub.api('POST', `${API}/checklists`, { title: 'Clear' })).payload.checklist;
  const one = (await hub.api('POST', `${API}/checklists/${list.id}/items`, { text: 'done one' })).payload.item;
  await hub.api('POST', `${API}/checklists/${list.id}/items`, { text: 'still open' });
  await hub.api('PATCH', `${API}/checklists/${list.id}/items/${one.id}`, { done: true });

  const cleared = await hub.api('POST', `${API}/checklists/${list.id}/clear-completed`, {});
  assert.equal(cleared.payload.removed, 1);
  assert.deepEqual(cleared.payload.checklist.items.map((item) => item.text), ['still open']);
  assert.equal(cleared.payload.checklist.progress.done, 0);
});

test('checklist data is durable across a hub restart', async (t) => {
  const hub = await startTestHub();
  const list = (await hub.api('POST', `${API}/checklists`, { title: 'Durable' })).payload.checklist;
  await hub.api('POST', `${API}/checklists/${list.id}/items`, { text: 'survives' });

  // a second hub instance on the same runtime directory simulates a real restart
  const { createRoomHubServer, HOST } = await import('../hub/server.mjs');
  const restarted = await createRoomHubServer({ runtimeDir: hub.runtimeDir });
  await new Promise((resolve) => restarted.listen(0, HOST, resolve));
  const base = `http://${HOST}:${restarted.address().port}`;
  t.after(() => new Promise((done) => restarted.close(done)));

  const payload = await (await fetch(`${base}${API}/checklists`)).json();
  assert.equal(payload.total, 1);
  assert.equal(payload.checklists[0].items[0].text, 'survives');
});

test('checklist room avoids City Control task vocabulary', async () => {
  const raw = await readFile(join(import.meta.dirname, '..', 'rooms', 'checklist', 'room.server.mjs'), 'utf8');
  // comments are allowed to explain the boundary; the implementation may not use it
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  for (const forbidden of ['QUEUED', 'RUNNING', 'COMPLETED', 'Task', 'taskId', 'assignee']) {
    assert.ok(!source.includes(forbidden), `checklist room must not mention ${forbidden}`);
  }
  assert.match(source, /Checklist/);
});
