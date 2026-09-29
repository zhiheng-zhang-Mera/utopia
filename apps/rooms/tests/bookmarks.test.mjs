/**
 * Room 02 — Bookmark Room focused tests (budget: <= 5).
 * Also asserts the room's safety boundary: only http(s) URLs are accepted and
 * nothing is ever fetched by the server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestHub } from './harness.mjs';

const API = '/local-rooms/v1/bookmarks';

test('bookmark room creates, edits and deletes bookmarks', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const created = await hub.api('POST', `${API}/bookmarks`, {
    title: 'Docs',
    url: 'https://example.com/docs',
    note: 'read later',
    tags: ['Reading', 'reading'],
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.payload.bookmark.tags, ['reading']);

  const patched = await hub.api('PATCH', `${API}/bookmarks/${created.payload.bookmark.id}`, { note: 'read now' });
  assert.equal(patched.payload.bookmark.note, 'read now');

  assert.equal((await hub.api('DELETE', `${API}/bookmarks/${created.payload.bookmark.id}`)).status, 200);
  assert.equal((await hub.api('GET', `${API}/bookmarks`)).payload.total, 0);
  assert.equal((await hub.api('PATCH', `${API}/bookmarks/missing`, { note: 'x' })).status, 404);
});

test('bookmark room accepts only absolute http(s) URLs', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  for (const url of ['not-a-url', 'javascript:alert(1)', 'file:///c:/secret.txt', 'ftp://example.com/x']) {
    const response = await hub.api('POST', `${API}/bookmarks`, { title: 'bad', url });
    assert.equal(response.status, 400, `${url} must be rejected`);
  }
  const ok = await hub.api('POST', `${API}/bookmarks`, { title: 'good', url: 'http://127.0.0.1:9/local' });
  assert.equal(ok.status, 201);
});

test('bookmark title falls back to the URL and search covers url and note', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const created = await hub.api('POST', `${API}/bookmarks`, { url: 'https://example.org/page', note: 'about gateways' });
  assert.equal(created.payload.bookmark.title, 'https://example.org/page');

  assert.equal((await hub.api('GET', `${API}/bookmarks?q=example.org`)).payload.total, 1);
  assert.equal((await hub.api('GET', `${API}/bookmarks?q=gateways`)).payload.total, 1);
  assert.equal((await hub.api('GET', `${API}/bookmarks?tag=none`)).payload.total, 0);
});

test('bookmark export/import replaces the collection and rejects bad payloads', async (t) => {
  const hub = await startTestHub();
  await hub.api('POST', `${API}/bookmarks`, { title: 'One', url: 'https://one.example/', tags: ['a'] });
  await hub.api('POST', `${API}/bookmarks`, { title: 'Two', url: 'https://two.example/' });

  const bundle = (await hub.api('GET', `${API}/export`)).payload;
  assert.equal(bundle.format, 'utopia-rooms-bookmarks');
  assert.equal(bundle.bookmarks.length, 2);

  assert.equal((await hub.api('POST', `${API}/import`, { ...bundle, format: 'nope' })).status, 400);
  assert.equal((await hub.api('POST', `${API}/import`, { ...bundle, schemaVersion: 0 })).status, 400);
  assert.equal((await hub.api('POST', `${API}/import`, { ...bundle, bookmarks: [{ id: 'x', url: 'javascript:1' }] })).status, 400);
  assert.equal((await hub.api('GET', `${API}/bookmarks`)).payload.total, 2, 'rejections leave data untouched');

  const one = { ...bundle, bookmarks: [bundle.bookmarks[0]] };
  const imported = await hub.api('POST', `${API}/import`, one);
  assert.equal(imported.payload.mode, 'replace');
  assert.equal((await hub.api('GET', `${API}/bookmarks`)).payload.total, 1);
});

test('bookmark data is durable across a hub restart', async (t) => {
  const hub = await startTestHub();
  await hub.api('POST', `${API}/bookmarks`, { title: 'Durable', url: 'https://durable.example/' });

  // a second hub instance on the same runtime directory simulates a real restart
  const { createRoomHubServer, HOST } = await import('../hub/server.mjs');
  const restarted = await createRoomHubServer({ runtimeDir: hub.runtimeDir });
  await new Promise((resolve) => restarted.listen(0, HOST, resolve));
  const base = `http://${HOST}:${restarted.address().port}`;
  t.after(() => new Promise((done) => restarted.close(done)));

  const payload = await (await fetch(`${base}${API}/bookmarks`)).json();
  assert.equal(payload.total, 1);
  assert.equal(payload.bookmarks[0].url, 'https://durable.example/');
});
