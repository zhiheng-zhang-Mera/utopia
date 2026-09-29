/**
 * Hub + shared store tests (budget: <= 10).
 * Covers the durable store contract, hub routing, loopback serving and the
 * namespace isolation guarantee required by Gate P4.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore, RoomStoreError, ROOM_SCHEMA_VERSION } from '../shared/atomic-store.mjs';
import { createCollection, matchesTags, normalizeTags, normalizeText } from '../shared/room-kit.mjs';
import { matchRoute, serveStatic } from '../shared/http.mjs';
import { startTestHub } from './harness.mjs';

test('room store writes schemaVersion/updatedAt/data and survives a reload', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rooms-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RoomStore({ runtimeDir: dir, fileName: 'demo.json', initialData: { items: [] } });
  await store.ensureLoaded();

  await store.update((data) => {
    data.items.push({ id: 'one' });
    return null;
  });
  await store.flushed();

  const raw = JSON.parse(await readFile(join(dir, 'demo.json'), 'utf8'));
  assert.equal(raw.schemaVersion, ROOM_SCHEMA_VERSION);
  assert.equal(raw.data.items.length, 1);
  assert.ok(!Number.isNaN(Date.parse(raw.updatedAt)));

  const reopened = new RoomStore({ runtimeDir: dir, fileName: 'demo.json', initialData: { items: [] } });
  await reopened.ensureLoaded();
  assert.deepEqual(reopened.data.items, [{ id: 'one' }]);
});

test('room store rejects a wrong schemaVersion and a non-object root', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rooms-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { writeFile } = await import('node:fs/promises');
  const file = join(dir, 'broken.json');

  await writeFile(file, JSON.stringify({ schemaVersion: 99, data: {} }), 'utf8');
  await assert.rejects(() => new RoomStore({ runtimeDir: dir, fileName: 'broken.json' }).load(), RoomStoreError);

  await writeFile(file, JSON.stringify([1, 2, 3]), 'utf8');
  await assert.rejects(() => new RoomStore({ runtimeDir: dir, fileName: 'broken.json' }).load(), RoomStoreError);

  await writeFile(file, '{ not json', 'utf8');
  await assert.rejects(() => new RoomStore({ runtimeDir: dir, fileName: 'broken.json' }).load(), RoomStoreError);
});

test('store mutations are serialized so concurrent writes do not lose items', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rooms-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RoomStore({ runtimeDir: dir, fileName: 'race.json', initialData: { items: [] } });
  await store.ensureLoaded();

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.update((data) => {
        data.items.push({ id: index });
        return null;
      }),
    ),
  );
  await store.flushed();
  assert.equal(store.data.items.length, 20);

  const reopened = new RoomStore({ runtimeDir: dir, fileName: 'race.json', initialData: { items: [] } });
  await reopened.ensureLoaded();
  assert.equal(reopened.data.items.length, 20);
});

test('shared helpers normalize text, tags and collection CRUD', async (t) => {
  assert.equal(normalizeText('  a \r\n b  '), 'a \n b');
  assert.deepEqual(normalizeTags([' Utopia ', 'utopia', '']), ['utopia']);
  assert.equal(matchesTags({ tags: ['a', 'b'] }, ['A']), true);
  assert.equal(matchesTags({ tags: ['a'] }, ['b']), false);
  assert.deepEqual(matchRoute('/items/:id/move', '/items/abc/move'), { id: 'abc' });
  assert.equal(matchRoute('/items/:id', '/items/abc/move'), null);

  const dir = await mkdtemp(join(tmpdir(), 'rooms-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RoomStore({ runtimeDir: dir, fileName: 'coll.json', initialData: { items: [] } });
  await store.ensureLoaded();
  const collection = createCollection({
    store,
    collection: 'items',
    normalize: (input, { partial }) => {
      const out = {};
      if (input.name !== undefined) out.name = normalizeText(input.name);
      else if (!partial) throw new Error('name required');
      return out;
    },
    onCreate: (item) => ({ ...item, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }),
  });

  const created = await collection.create({ name: ' First ' });
  assert.equal(created.name, 'First');
  assert.equal(collection.get(created.id).name, 'First');
  assert.equal(await collection.update('missing', { name: 'x' }), null);
  assert.equal(await collection.remove(created.id), true);
  assert.equal(collection.list().length, 0);
});

test('hub serves health, the room catalog and the product shell on loopback', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const health = await hub.api('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.payload.product, 'utopia-room-pack');
  assert.equal(health.payload.host, '127.0.0.1');
  assert.equal(health.payload.rooms.length, 10, 'ten local rooms; the promoted lab no longer serves a surface');

  const catalog = await hub.api('GET', '/local-rooms/v1/rooms');
  assert.equal(catalog.payload.rooms.length, 10);
  assert.equal(catalog.payload.rooms[0].id, 'knowledge');
  assert.equal(catalog.payload.rooms[9].id, 'decisions');
  assert.ok(!catalog.payload.rooms.some((room) => room.id === 'skill-intake-lab'), 'a promoted room leaves the catalog');

  const page = await hub.get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Rooms/);

  const kit = await hub.get('/shared/client-kit.js');
  assert.equal(kit.status, 200);
  assert.match(kit.headers.get('content-type'), /javascript/);

  for (const id of catalog.payload.rooms.map((room) => room.id)) {
    const asset = await hub.get(`/rooms/${id}/client.mjs`);
    assert.equal(asset.status, 200, `${id} client module served`);
    assert.match(asset.headers.get('content-type'), /javascript/);
  }
});

test('hub rejects unknown rooms and unknown routes without touching other rooms', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  assert.equal((await hub.api('GET', '/local-rooms/v1/nope')).status, 404);
  assert.equal((await hub.api('GET', '/local-rooms/v1/knowledge/nope')).status, 404);
  assert.equal((await hub.api('DELETE', '/local-rooms/v1/rooms')).status, 404);

  const traversal = await hub.get('/../package.json');
  assert.ok([403, 404].includes(traversal.status));
});

test('static serving never escapes the configured root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rooms-static-'));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'ok.txt'), 'fine', 'utf8');
  const responses = [];
  const res = {
    writeHead(status) {
      responses.push(status);
    },
    end() {},
  };
  assert.equal(await serveStatic(res, dir, '/ok.txt'), true);
  assert.equal(responses[0], 200);
  assert.equal(await serveStatic(res, dir, '/../../etc/hosts'), true);
  assert.equal(responses[1], 403);
  assert.equal(await serveStatic(res, dir, '/missing.txt'), false);
  await rm(dir, { recursive: true, force: true });
});

test('room data files are isolated: clearing one room leaves the others intact', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  await hub.api('POST', '/local-rooms/v1/knowledge/entries', { title: 'keep me', body: 'x' });
  await hub.api('POST', '/local-rooms/v1/bookmarks/bookmarks', { title: 'other room', url: 'https://example.com/' });
  await hub.api('POST', '/local-rooms/v1/calendar/events', { title: 'calendar entry', date: '2026-10-05' });

  // clear the knowledge room only
  const bundle = { format: 'utopia-rooms-knowledge', schemaVersion: 1, exportedAt: new Date().toISOString(), entries: [] };
  const cleared = await hub.api('POST', '/local-rooms/v1/knowledge/import', bundle);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.payload.imported, 0);

  assert.equal((await hub.api('GET', '/local-rooms/v1/knowledge/entries')).payload.total, 0, 'knowledge room cleared');
  assert.equal((await hub.api('GET', '/local-rooms/v1/bookmarks/bookmarks')).payload.total, 1, 'bookmarks untouched');
  assert.equal((await hub.api('GET', '/local-rooms/v1/calendar/events')).payload.total, 1, 'calendar untouched');

  const { readdir } = await import('node:fs/promises');
  const files = await readdir(hub.runtimeDir);
  assert.deepEqual(files.sort(), ['bookmarks.json', 'calendar.json', 'knowledge.json'], 'only used rooms have files');
});

test('hub configuration defaults to port 4320 and loopback only', async () => {
  const { resolveHubConfig, DEFAULT_PORT } = await import('../hub/server.mjs');
  const config = resolveHubConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, DEFAULT_PORT);
  assert.equal(resolveHubConfig({ ROOMS_PORT: '5000' }).port, 5000);
  assert.throws(() => resolveHubConfig({ ROOMS_PORT: 'nope' }));
});
