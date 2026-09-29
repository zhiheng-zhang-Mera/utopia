/**
 * K0-D export / import tests (IMPORT_MODE = replace).
 * Budget: <= 4 import/export tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeStore } from '../src/store.mjs';
import { ValidationError } from '../src/model.mjs';
import {
  IMPORT_MODE,
  buildBundle,
  bundleSha256,
  bundlesAreEquivalent,
  parseImportBundle,
  serializeBundle,
} from '../src/import-export.mjs';
import { makeTempDataDir, removeTempDataDir } from './helpers.mjs';

async function storeWithSamples(t) {
  const dataDir = await makeTempDataDir();
  t.after(() => removeTempDataDir(dataDir));
  const store = new KnowledgeStore({ dataDir });
  await store.create({ title: 'Alpha', body: 'first body', tags: ['one', 'shared'] });
  await store.create({ title: 'Beta', body: 'second body', tags: ['two'] });
  await store.create({ title: 'Gamma', body: 'third body', tags: ['three', 'shared'] });
  return { store, dataDir };
}

test('export bundle carries format, schemaVersion, exportedAt and full entries', async (t) => {
  const { store } = await storeWithSamples(t);
  const bundle = buildBundle(store.snapshot(), '2026-09-29T00:00:00.000Z');

  assert.equal(bundle.format, 'utopia-knowledge-room');
  assert.equal(bundle.schemaVersion, 0);
  assert.equal(bundle.exportedAt, '2026-09-29T00:00:00.000Z');
  assert.equal(bundle.entries.length, 3);
  for (const entry of bundle.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['body', 'createdAt', 'id', 'tags', 'title', 'updatedAt']);
  }

  const text = serializeBundle(bundle);
  assert.match(bundleSha256(text), /^[0-9a-f]{64}$/, 'export bytes hash to a stable SHA-256');
  assert.notEqual(bundleSha256(text), bundleSha256(`${text} `));
  assert.equal(IMPORT_MODE, 'replace');
});

test('parseImportBundle rejects wrong format, wrong schemaVersion and malformed entries', async () => {
  await assert.rejects(() => parseImportBundle({ format: 'something-else', schemaVersion: 0, entries: [] }), ValidationError);
  await assert.rejects(() => parseImportBundle({ format: 'utopia-knowledge-room', schemaVersion: 7, entries: [] }), ValidationError);
  await assert.rejects(() => parseImportBundle({ format: 'utopia-knowledge-room', schemaVersion: 0, entries: 'nope' }), ValidationError);
  await assert.rejects(() => parseImportBundle('{ broken json'), ValidationError);
  await assert.rejects(() => parseImportBundle([]), ValidationError);
  await assert.rejects(
    () =>
      parseImportBundle({
        format: 'utopia-knowledge-room',
        schemaVersion: 0,
        entries: [{ id: 'x', title: '', body: '', tags: [], createdAt: 'nope', updatedAt: 'nope' }],
      }),
    ValidationError,
  );
  await assert.rejects(
    () =>
      parseImportBundle({
        format: 'utopia-knowledge-room',
        schemaVersion: 0,
        entries: [
          { id: 'dup', title: 'a', body: '', tags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'dup', title: 'b', body: '', tags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
    ValidationError,
  );
});

test('export → empty data state → import restores every entry field', async (t) => {
  const { store, dataDir } = await storeWithSamples(t);
  const before = buildBundle(store.snapshot());
  const beforeSha = bundleSha256(serializeBundle(before));

  // fresh/empty runtime-data state
  const freshDir = await makeTempDataDir();
  t.after(() => removeTempDataDir(freshDir));
  const fresh = new KnowledgeStore({ dataDir: freshDir });
  await fresh.load();
  assert.equal(fresh.count(), 0);

  const { entries } = await parseImportBundle(serializeBundle(before));
  await fresh.replaceAll(entries);
  await fresh.mutate(async () => {}); // flush the write queue

  const reopened = new KnowledgeStore({ dataDir: freshDir });
  await reopened.load();
  assert.equal(reopened.count(), before.entries.length);
  for (const original of before.entries) {
    const restored = reopened.get(original.id);
    assert.ok(restored, `entry ${original.id} restored`);
    assert.equal(restored.title, original.title);
    assert.equal(restored.body, original.body);
    assert.deepEqual(restored.tags, original.tags);
    assert.equal(restored.createdAt, original.createdAt);
    assert.equal(restored.updatedAt, original.updatedAt);
  }

  const after = buildBundle(reopened.snapshot(), new Date(Date.now() + 1000).toISOString());
  assert.ok(bundlesAreEquivalent(before, after), 'semantic content is identical after restore');
  assert.notEqual(beforeSha, bundleSha256(serializeBundle(after)), 'exportedAt differs between exports');
  assert.equal([...new Set(after.entries.map((e) => e.id))].length, after.entries.length);

  // the original store's own directory still holds its data
  const stillThere = new KnowledgeStore({ dataDir });
  await stillThere.load();
  assert.equal(stillThere.count(), 3);
});

test('import replaces all current data instead of merging', async (t) => {
  const { store } = await storeWithSamples(t);
  const bundle = buildBundle(store.snapshot());
  const replacement = await parseImportBundle({
    format: 'utopia-knowledge-room',
    schemaVersion: 0,
    exportedAt: bundle.exportedAt,
    entries: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Only survivor',
        body: 'replacement payload',
        tags: ['replaced'],
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
  });

  await store.replaceAll(replacement.entries);
  assert.equal(store.count(), 1);
  assert.equal(store.list()[0].title, 'Only survivor');
  assert.equal(store.get(bundle.entries[0].id), null, 'previous entries are gone');
});
