/**
 * K0-A/K0-B local HTTP API tests.
 * Budget: <= 4 HTTP/API focused tests.
 *
 * The server binds to 127.0.0.1 on an ephemeral port; nothing else is started.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeRoomServer, HOST } from '../src/server.mjs';
import { buildBundle, bundleSha256, parseImportBundle, serializeBundle } from '../src/import-export.mjs';
import { makeTempDataDir, removeTempDataDir } from './helpers.mjs';

let dataDir;
let server;
let base;

test.before(async () => {
  dataDir = await makeTempDataDir('knowledge-room-http-');
  server = createKnowledgeRoomServer({ dataDir });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, HOST, resolveListen);
  });
  base = `http://${HOST}:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((done) => server.close(done));
  if (dataDir) await removeTempDataDir(dataDir);
});

test('health endpoint reports loopback product state', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.product, 'utopia-knowledge-room');
  assert.equal(body.host, HOST);
  assert.equal(body.schemaVersion, 0);
  assert.equal(typeof body.entries, 'number');
  assert.equal(server.address().address, HOST, 'bound to loopback only');
});

test('CRUD over HTTP: create, list, patch, delete, 404 on missing id', async () => {
  const created = await fetch(`${base}/local-kb/v0/entries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'HTTP entry', body: 'created over http', tags: ['http', 'HTTP'] }),
  });
  assert.equal(created.status, 201);
  const { entry } = await created.json();
  assert.deepEqual(entry.tags, ['http']);

  const listed = await (await fetch(`${base}/local-kb/v0/entries`)).json();
  assert.equal(listed.total, 1);
  assert.equal(listed.entries[0].id, entry.id);

  const patched = await fetch(`${base}/local-kb/v0/entries/${entry.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'edited over http' }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).entry.body, 'edited over http');

  const badCreate = await fetch(`${base}/local-kb/v0/entries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '' }),
  });
  assert.equal(badCreate.status, 400);
  assert.equal((await badCreate.json()).error, 'invalid_payload');

  const deleted = await fetch(`${base}/local-kb/v0/entries/${entry.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deleted: true, id: entry.id });

  const missing = await fetch(`${base}/local-kb/v0/entries/${entry.id}`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'not_found');

  const stillListed = await (await fetch(`${base}/local-kb/v0/entries`)).json();
  assert.equal(stillListed.total, 0);
});

test('search endpoint serves text and tag queries and the static product UI', async () => {
  const seed = [
    { title: 'Utopia knowledge architecture', body: 'local only notes', tags: ['utopia', 'architecture'] },
    { title: 'Client request handling', body: 'deterministic search behaviour', tags: ['engineering'] },
    { title: 'Release checklist', body: 'steps for a local release', tags: ['process'] },
  ];
  for (const item of seed) {
    const response = await fetch(`${base}/local-kb/v0/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(item),
    });
    assert.equal(response.status, 201);
  }

  const byTitle = await (await fetch(`${base}/local-kb/v0/search?q=client`)).json();
  assert.equal(byTitle.total, 1);
  assert.equal(byTitle.entries[0].title, 'Client request handling');

  const byBody = await (await fetch(`${base}/local-kb/v0/search?q=deterministic`)).json();
  assert.equal(byBody.total, 1);

  const byTag = await (await fetch(`${base}/local-kb/v0/search?tag=UTOPIA`)).json();
  assert.equal(byTag.total, 1);

  const noMatch = await (await fetch(`${base}/local-kb/v0/search?q=zzzz-not-present`)).json();
  assert.equal(noMatch.total, 0);
  assert.deepEqual(noMatch.entries, []);

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Knowledge Room/);

  const css = await fetch(`${base}/app.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const traversal = await fetch(`${base}/../package.json`);
  assert.ok([403, 404].includes(traversal.status), 'static serving never escapes the public directory');

  const unknownApi = await fetch(`${base}/local-kb/v0/nope`);
  assert.equal(unknownApi.status, 404);
  assert.equal((await unknownApi.json()).error, 'not_found');
});

test('export and import endpoints round-trip and reject malformed payloads', async () => {
  const exported = await fetch(`${base}/local-kb/v0/export`);
  assert.equal(exported.status, 200);
  const text = await exported.text();
  assert.match(exported.headers.get('content-disposition') ?? '', /utopia-knowledge-room-.*\.json/);
  const bundle = JSON.parse(text);
  assert.equal(bundle.format, 'utopia-knowledge-room');
  assert.equal(bundle.schemaVersion, 0);
  assert.equal(bundle.entries.length, 3);

  const rejected = await fetch(`${base}/local-kb/v0/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ format: 'wrong', schemaVersion: 0, entries: [] }),
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, 'invalid_payload');

  const stillThree = await (await fetch(`${base}/local-kb/v0/entries`)).json();
  assert.equal(stillThree.total, 3, 'a rejected import changes nothing');

  // simulate a brand-new empty runtime-data directory, then import the bundle text
  const emptyDir = await makeTempDataDir('knowledge-room-http-empty-');
  const emptyServer = createKnowledgeRoomServer({ dataDir: emptyDir });
  await new Promise((resolveListen) => emptyServer.listen(0, HOST, resolveListen));
  const emptyBase = `http://${HOST}:${emptyServer.address().port}`;
  try {
    assert.equal((await (await fetch(`${emptyBase}/local-kb/v0/entries`)).json()).total, 0);
    const imported = await fetch(`${emptyBase}/local-kb/v0/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: text,
    });
    assert.equal(imported.status, 200);
    const result = await imported.json();
    assert.equal(result.mode, 'replace');
    assert.equal(result.imported, bundle.entries.length);

    const restored = await (await fetch(`${emptyBase}/local-kb/v0/export`)).text();
    assert.ok(
      bundleSha256(restored) !== bundleSha256(text),
      'raw bytes differ because exportedAt is regenerated',
    );
    const { entries } = await parseImportBundle(restored);
    const reference = (await parseImportBundle(text)).entries;
    assert.deepEqual(
      entries.map((entry) => [entry.id, entry.title, entry.body, entry.tags]),
      reference.map((entry) => [entry.id, entry.title, entry.body, entry.tags]),
      'semantic content is identical after the round trip',
    );
    assert.equal(entries.length, 3);
  } finally {
    await new Promise((done) => emptyServer.close(done));
    await removeTempDataDir(emptyDir);
  }

  // buildBundle stays consistent with what the endpoint produced
  assert.equal(buildBundle({ entries: [] }).format, bundle.format);
  assert.equal(serializeBundle(buildBundle({ entries: [] })).endsWith('\n'), true);
});
