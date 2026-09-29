/**
 * Room 01 — Knowledge Room focused tests (budget: <= 6).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestHub } from './harness.mjs';

const API = '/local-rooms/v1/knowledge';

test('knowledge room creates, lists, edits and deletes entries over HTTP', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const created = await hub.api('POST', `${API}/entries`, { title: '  First note ', body: 'hello', tags: [' Utopia ', 'utopia'] });
  assert.equal(created.status, 201);
  assert.equal(created.payload.entry.title, 'First note');
  assert.deepEqual(created.payload.entry.tags, ['utopia']);

  const listed = await hub.api('GET', `${API}/entries`);
  assert.equal(listed.payload.total, 1);

  const patched = await hub.api('PATCH', `${API}/entries/${created.payload.entry.id}`, { body: 'edited' });
  assert.equal(patched.payload.entry.body, 'edited');
  assert.equal(patched.payload.entry.createdAt, created.payload.entry.createdAt);

  assert.equal((await hub.api('POST', `${API}/entries`, { title: '' })).status, 400);
  assert.equal((await hub.api('PATCH', `${API}/entries/missing`, { title: 'x' })).status, 404);
  assert.equal((await hub.api('DELETE', `${API}/entries/missing`)).status, 404);

  assert.equal((await hub.api('DELETE', `${API}/entries/${created.payload.entry.id}`)).status, 200);
  assert.equal((await hub.api('GET', `${API}/entries`)).payload.total, 0);
});

test('knowledge entries survive a hub restart', async (t) => {
  const hub = await startTestHub();
  const created = await hub.api('POST', `${API}/entries`, { title: 'Durable', body: 'body', tags: ['keep'] });

  // a second hub instance on the same runtime directory simulates a real restart
  const { createRoomHubServer, HOST } = await import('../hub/server.mjs');
  const restarted = await createRoomHubServer({ runtimeDir: hub.runtimeDir });
  await new Promise((resolve) => restarted.listen(0, HOST, resolve));
  const base = `http://${HOST}:${restarted.address().port}`;
  t.after(() => new Promise((done) => restarted.close(done)));

  const entries = await (await fetch(`${base}${API}/entries`)).json();
  assert.equal(entries.total, 1);
  assert.equal(entries.entries[0].id, created.payload.entry.id);
  assert.deepEqual(entries.entries[0].tags, ['keep']);
});

test('knowledge search covers title, body and tags and is case-insensitive', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  await hub.api('POST', `${API}/entries`, { title: 'Utopia architecture', body: 'local only notes', tags: ['design'] });
  await hub.api('POST', `${API}/entries`, { title: 'Client handling', body: 'deterministic window behavior', tags: ['engineering'] });

  assert.equal((await hub.api('GET', `${API}/entries?q=UTOPIA`)).payload.total, 1);
  assert.equal((await hub.api('GET', `${API}/entries?q=deterministic`)).payload.total, 1);
  assert.equal((await hub.api('GET', `${API}/entries?tag=DESIGN`)).payload.total, 1);
  assert.equal((await hub.api('GET', `${API}/entries?tag=des`)).payload.total, 0, 'tag filter is exact');
  assert.equal((await hub.api('GET', `${API}/entries?q=zzz-none`)).payload.total, 0);
});

test('knowledge export bundle carries format, schemaVersion and full entries', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  await hub.api('POST', `${API}/entries`, { title: 'A', body: 'a', tags: ['t'] });

  const bundle = await hub.api('GET', `${API}/export`);
  assert.equal(bundle.payload.format, 'utopia-rooms-knowledge');
  assert.equal(bundle.payload.schemaVersion, 1);
  assert.ok(!Number.isNaN(Date.parse(bundle.payload.exportedAt)));
  assert.deepEqual(Object.keys(bundle.payload.entries[0]).sort(), ['body', 'createdAt', 'id', 'tags', 'title', 'updatedAt']);
});

test('knowledge import replaces data and rejects malformed bundles whole', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  await hub.api('POST', `${API}/entries`, { title: 'Original', body: 'keep' });
  const bundle = (await hub.api('GET', `${API}/export`)).payload;

  for (const bad of [
    { ...bundle, format: 'wrong' },
    { ...bundle, schemaVersion: 2 },
    { ...bundle, entries: 'nope' },
    { ...bundle, entries: [{ id: 'x', title: '', body: '', tags: [], createdAt: 'bad', updatedAt: 'bad' }] },
  ]) {
    const response = await hub.api('POST', `${API}/import`, bad);
    assert.equal(response.status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await hub.api('GET', `${API}/entries`)).payload.total, 1, 'rejected imports never change data');

  const replacement = {
    format: 'utopia-rooms-knowledge',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    entries: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Restored',
        body: 'from bundle',
        tags: ['restored'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
  const imported = await hub.api('POST', `${API}/import`, replacement);
  assert.equal(imported.payload.mode, 'replace');
  assert.equal(imported.payload.imported, 1);
  const entries = await hub.api('GET', `${API}/entries`);
  assert.equal(entries.payload.total, 1);
  assert.equal(entries.payload.entries[0].title, 'Restored');

  // export → fresh room → import → identical semantic content
  const after = (await hub.api('GET', `${API}/export`)).payload;
  const project = (value) => JSON.stringify(value.entries.map((entry) => [entry.id, entry.title, entry.body, entry.tags, entry.createdAt, entry.updatedAt]));
  assert.equal(project(after), project(replacement));
});

test('knowledge entries are ordered newest-updated first', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  const first = await hub.api('POST', `${API}/entries`, { title: 'First' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await hub.api('POST', `${API}/entries`, { title: 'Second' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await hub.api('PATCH', `${API}/entries/${first.payload.entry.id}`, { body: 'touched' });

  const entries = (await hub.api('GET', `${API}/entries`)).payload.entries;
  assert.equal(entries[0].title, 'First', 'the most recently updated entry comes first');
  assert.equal(entries[1].title, 'Second');
});
