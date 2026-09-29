/**
 * K0-B durable CRUD tests (model + store).
 * Budget: <= 6 store/model tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KnowledgeStore, StoreFormatError } from '../src/store.mjs';
import { ValidationError, normalizeTags } from '../src/model.mjs';
import { makeTempDataDir, removeTempDataDir } from './helpers.mjs';

test('create stores a normalized entry and rejects invalid input', async (t) => {
  const dataDir = await makeTempDataDir();
  t.after(() => removeTempDataDir(dataDir));
  const store = new KnowledgeStore({ dataDir });

  const entry = await store.create({
    title: '  First note  ',
    body: 'hello world',
    tags: ['Utopia', 'utopia', ' Research '],
  });

  assert.equal(entry.title, 'First note');
  assert.deepEqual(entry.tags, ['utopia', 'research'], 'tags are normalized and deduped');
  assert.equal(entry.createdAt, entry.updatedAt);
  assert.match(entry.id, /^[0-9a-f-]{36}$/);
  assert.equal(store.count(), 1);

  await assert.rejects(() => store.create({ title: '   ' }), ValidationError);
  await assert.rejects(() => store.create({ body: 'no title' }), ValidationError);
  assert.equal(store.count(), 1, 'rejected input does not change the store');
});

test('durable file records schemaVersion and survives a reload', async (t) => {
  const dataDir = await makeTempDataDir();
  t.after(() => removeTempDataDir(dataDir));
  const store = new KnowledgeStore({ dataDir });
  const created = await store.create({ title: 'Persisted', body: 'body text', tags: ['durability'] });

  const raw = JSON.parse(await readFile(join(dataDir, 'knowledge-v0.json'), 'utf8'));
  assert.equal(raw.schemaVersion, 0);
  assert.equal(raw.entries.length, 1);

  const reopened = new KnowledgeStore({ dataDir });
  await reopened.load();
  const entry = reopened.get(created.id);
  assert.equal(entry.title, 'Persisted');
  assert.equal(entry.body, 'body text');
  assert.deepEqual(entry.tags, ['durability']);
  assert.equal(entry.createdAt, created.createdAt);
});

test('update changes fields, keeps id and createdAt, bumps updatedAt', async (t) => {
  const dataDir = await makeTempDataDir();
  t.after(() => removeTempDataDir(dataDir));
  const store = new KnowledgeStore({ dataDir });
  const created = await store.create({ title: 'Draft', body: 'v1', tags: ['a'] });

  const updated = await store.update(created.id, { title: 'Final', tags: ['a', 'b'] });

  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.title, 'Final');
  assert.equal(updated.body, 'v1', 'omitted fields are untouched');
  assert.deepEqual(updated.tags, ['a', 'b']);
  assert.ok(updated.updatedAt >= created.updatedAt);
  assert.equal(await store.update('missing-id', { title: 'nope' }), null);
  await assert.rejects(() => store.update(created.id, {}), ValidationError);
});

test('delete removes the entry permanently', async (t) => {
  const dataDir = await makeTempDataDir();
  t.after(() => removeTempDataDir(dataDir));
  const store = new KnowledgeStore({ dataDir });
  const created = await store.create({ title: 'Temporary' });

  assert.equal(await store.delete(created.id), true);
  assert.equal(await store.delete(created.id), false);
  assert.equal(store.get(created.id), null);
  assert.equal(store.count(), 0);

  const reopened = new KnowledgeStore({ dataDir });
  await reopened.load();
  assert.equal(reopened.count(), 0, 'deletion is durable');
});

test('three creates, one update, one delete survive a restart (K0-B flow)', async (t) => {
  const dataDir = await makeTempDataDir();
  t.after(() => removeTempDataDir(dataDir));
  const store = new KnowledgeStore({ dataDir });
  const a = await store.create({ title: 'Alpha', body: 'first', tags: ['one'] });
  const b = await store.create({ title: 'Beta', body: 'second', tags: ['two'] });
  const c = await store.create({ title: 'Gamma', body: 'third', tags: ['three'] });
  await store.update(b.id, { body: 'second (edited)' });
  await store.delete(c.id);

  const reopened = new KnowledgeStore({ dataDir });
  await reopened.load();
  const titles = reopened.list().map((entry) => entry.title);
  assert.deepEqual(titles.sort(), ['Alpha', 'Beta']);
  assert.equal(reopened.get(a.id).body, 'first');
  assert.equal(reopened.get(b.id).body, 'second (edited)');
  assert.equal(reopened.get(c.id), null);
});

test('an unreadable or wrong-schema file fails loudly instead of silently resetting', async (t) => {
  const dataDir = await makeTempDataDir();
  t.after(() => removeTempDataDir(dataDir));
  const store = new KnowledgeStore({ dataDir });
  await store.create({ title: 'Guarded' });
  const file = join(dataDir, 'knowledge-v0.json');

  await store.replaceAll([]);
  const emptied = new KnowledgeStore({ dataDir });
  await emptied.load();
  assert.equal(emptied.count(), 0);

  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, '{ not json', 'utf8');
  await assert.rejects(() => new KnowledgeStore({ dataDir }).load(), StoreFormatError);

  await writeFile(file, JSON.stringify({ schemaVersion: 99, entries: [] }), 'utf8');
  await assert.rejects(() => new KnowledgeStore({ dataDir }).load(), StoreFormatError);
});
