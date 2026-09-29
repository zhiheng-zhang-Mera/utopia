/**
 * K0-C deterministic search tests.
 * Budget: <= 4 search tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeStore } from '../src/store.mjs';
import { makeTempDataDir, removeTempDataDir } from './helpers.mjs';

async function seededStore(t) {
  const dataDir = await makeTempDataDir();
  t.after(() => removeTempDataDir(dataDir));
  const store = new KnowledgeStore({ dataDir });
  await store.create({
    title: 'Utopia knowledge architecture',
    body: 'Notes about how the Knowledge Room stores entries locally.',
    tags: ['utopia', 'architecture'],
  });
  await store.create({
    title: 'Client request handling',
    body: 'The client requests a deterministic search over TITLE and body text.',
    tags: ['engineering'],
  });
  await store.create({
    title: 'Release checklist',
    body: 'Steps for a local release.',
    tags: ['process', 'Utopia'],
  });
  return store;
}

test('title substring search is case-insensitive and ordered newest-first', async (t) => {
  const store = await seededStore(t);

  const hits = store.search({ query: 'CLIENT' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, 'Client request handling');

  const all = store.search({ query: 'e' });
  assert.deepEqual(
    all.map((entry) => entry.updatedAt),
    [...all.map((entry) => entry.updatedAt)].sort().reverse(),
    'newest updatedAt first',
  );
});

test('body-only match is found and does not require a title hit', async (t) => {
  const store = await seededStore(t);

  const hits = store.search({ query: 'deterministic' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, 'Client request handling');
  assert.ok(!hits[0].title.toLowerCase().includes('deterministic'));
});

test('tag filter is exact and normalized (silent no-match for unknown tag)', async (t) => {
  const store = await seededStore(t);

  const utopia = store.search({ tag: 'UTOPIA' });
  assert.equal(utopia.length, 2, 'tag matching ignores case and surrounding space');
  assert.ok(utopia.every((entry) => entry.tags.includes('utopia')));

  const utopiaEng = store.search({ tags: ['utopia'] });
  assert.equal(utopiaEng.length, 2);

  assert.deepEqual(store.search({ tag: 'utop' }), [], 'tag filter is not a substring match');
  assert.deepEqual(store.search({ query: 'no such text' }), [], 'no match yields an empty result');
});

test('search combines a text query with tag filters', async (t) => {
  const store = await seededStore(t);

  const combined = store.search({ query: 'release', tag: 'process' });
  assert.equal(combined.length, 1);
  assert.equal(combined[0].title, 'Release checklist');

  const contradiction = store.search({ query: 'release', tag: 'engineering' });
  assert.deepEqual(contradiction, []);
});
