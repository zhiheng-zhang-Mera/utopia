/**
 * D3 — Knowledge Core Lab focused tests, including donor parity.
 *
 * The vectors below restate the Codex-Boss donor behaviour
 * (`src/shared/knowledge.ts` @ 8df428eaa437a409368401e95194e40266b83080): trust
 * ordering, domain/shelf/tag filtering, trustAtLeast, expiry and not-yet-valid
 * exclusion, the character budget, taxonomy, the deterministic domain router and
 * goal reranking, plus the supersession/conflict metadata the incubator requires.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestHub } from './harness.mjs';
import {
  DEFAULT_MAX_CHARS,
  TRUST_LEVELS,
  TRUST_ORDER,
  conflictReport,
  entryMatches,
  relevanceScore,
  retrieveReranked,
  retrieveWithinBudget,
  routeKnowledgeQuery,
  taxonomyOf,
  tokenize,
} from '../rooms/knowledge-core-lab/knowledge-core.mjs';
import { normalizeEntry, normalizeQuery } from '../rooms/knowledge-core-lab/room.server.mjs';

const API = '/local-rooms/v1/knowledge-core-lab';
const DONOR_COMMIT = '8df428eaa437a409368401e95194e40266b83080';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');

function entry(overrides = {}) {
  return {
    id: 'k-1',
    domain: 'engineering',
    shelf: 'utopia',
    tags: ['retrieval'],
    title: 'Retrieval note',
    content: 'x'.repeat(50),
    source: 'test',
    trust: 'MEDIUM',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const catalog = () => [
  entry({ id: 'high', trust: 'HIGH', updatedAt: '2026-01-01T00:00:00.000Z' }),
  entry({ id: 'medium', trust: 'MEDIUM', updatedAt: '2026-03-01T00:00:00.000Z' }),
  entry({ id: 'low', trust: 'LOW', updatedAt: '2026-05-01T00:00:00.000Z' }),
  entry({ id: 'unverified', trust: 'UNVERIFIED', updatedAt: '2026-05-20T00:00:00.000Z' }),
  entry({ id: 'other-domain', domain: 'planning', trust: 'HIGH' }),
  entry({ id: 'other-shelf', shelf: 'side', trust: 'HIGH' }),
  entry({ id: 'tagged', tags: ['retrieval', 'budget'], trust: 'HIGH' }),
  entry({ id: 'expired', trust: 'HIGH', validUntil: '2026-01-01T00:00:00.000Z' }),
  entry({ id: 'future', trust: 'HIGH', validFrom: '2026-12-01T00:00:00.000Z' }),
  entry({ id: 'big', trust: 'HIGH', content: 'y'.repeat(500) }),
];

test('trust ordering and query filters match the donor', () => {
  assert.deepEqual(TRUST_ORDER, { UNVERIFIED: 0, LOW: 1, MEDIUM: 2, HIGH: 3 });
  assert.deepEqual(TRUST_LEVELS, ['HIGH', 'MEDIUM', 'LOW', 'UNVERIFIED']);

  assert.equal(entryMatches({}, entry(), NOW), true);
  assert.equal(entryMatches({ domain: 'engineering' }, entry(), NOW), true);
  assert.equal(entryMatches({ domain: 'planning' }, entry(), NOW), false);
  assert.equal(entryMatches({ shelf: 'utopia' }, entry(), NOW), true);
  assert.equal(entryMatches({ shelf: 'side' }, entry(), NOW), false);
  assert.equal(entryMatches({ tags: ['retrieval'] }, entry(), NOW), true);
  assert.equal(entryMatches({ tags: ['retrieval', 'budget'] }, entry(), NOW), false, 'all tags must match');
  assert.equal(entryMatches({ trustAtLeast: 'LOW' }, entry(), NOW), true);
  assert.equal(entryMatches({ trustAtLeast: 'HIGH' }, entry(), NOW), false);
  assert.equal(entryMatches({}, entry({ trust: 'BOGUS' }), NOW), true, 'an unknown trust counts as zero');
  assert.equal(entryMatches({}, entry({ validUntil: '2026-01-01T00:00:00.000Z' }), NOW), false, 'expired entries are excluded');
  assert.equal(entryMatches({}, entry({ validFrom: '2026-12-01T00:00:00.000Z' }), NOW), false, 'not-yet-valid entries are excluded');
});

test('retrieval is trust-ordered, recency-broken and within the character budget', () => {
  const ordered = retrieveWithinBudget(catalog(), { maxChars: DEFAULT_MAX_CHARS }, NOW);
  const ids = ordered.map((item) => item.id);
  assert.ok(ids.indexOf('high') < ids.indexOf('medium'), 'HIGH before MEDIUM');
  assert.ok(ids.indexOf('medium') < ids.indexOf('low'), 'MEDIUM before LOW');
  assert.ok(ids.indexOf('low') < ids.indexOf('unverified'), 'LOW before UNVERIFIED');
  assert.ok(!ids.includes('expired') && !ids.includes('future'), 'invalid windows never retrieve');

  const all = catalog();
  const sameTrust = [
    entry({ id: 'older', trust: 'HIGH', updatedAt: '2026-01-01T00:00:00.000Z' }),
    entry({ id: 'newer', trust: 'HIGH', updatedAt: '2026-02-01T00:00:00.000Z' }),
  ];
  assert.deepEqual(retrieveWithinBudget(sameTrust, {}, NOW).map((item) => item.id), ['newer', 'older'], 'recency breaks trust ties');
  assert.equal(all.length, 10);

  const budgeted = retrieveWithinBudget(catalog(), { maxChars: 120 }, NOW);
  const used = budgeted.reduce((total, item) => total + item.content.length, 0);
  assert.ok(used <= 120, `budget respected, used ${used}`);
  assert.ok(budgeted.length >= 1, 'at least one entry always fits');
  const generous = retrieveWithinBudget(catalog(), { maxChars: 100000 }, NOW);
  assert.ok(generous.length > budgeted.length, 'a larger budget returns more');
});

test('domain, shelf and trust filters combine with the budget', () => {
  const engineering = retrieveWithinBudget(catalog(), { domain: 'engineering' }, NOW);
  assert.ok(engineering.every((item) => item.domain === 'engineering'));

  const shelved = retrieveWithinBudget(catalog(), { shelf: 'side' }, NOW);
  assert.deepEqual(shelved.map((item) => item.id), ['other-shelf']);

  const strict = retrieveWithinBudget(catalog(), { trustAtLeast: 'HIGH' }, NOW);
  assert.ok(strict.every((item) => TRUST_ORDER[item.trust] >= TRUST_ORDER.HIGH));

  assert.deepEqual(retrieveWithinBudget(catalog(), { tags: ['nope'] }, NOW), []);
});

test('taxonomy and the deterministic domain router match the donor', () => {
  const taxonomy = taxonomyOf(catalog());
  assert.deepEqual(taxonomy.domains, ['engineering', 'planning']);
  assert.deepEqual(taxonomy.shelves, ['side', 'utopia']);
  assert.ok(taxonomy.tags.includes('retrieval') && taxonomy.tags.includes('budget'));

  // The donor router matches the goal against the *domain name*, then routes to
  // the tags that domain shares with the goal. A goal that does not name a domain
  // routes nowhere rather than guessing a domain from unrelated words.
  const routed = routeKnowledgeQuery('engineering retrieval budget', catalog());
  assert.equal(routed.domain, 'engineering');
  assert.ok(routed.tags.includes('retrieval') && routed.tags.includes('budget'), JSON.stringify(routed));
  assert.ok(routed.tags.length <= 3, 'at most three tags are routed');

  const unmatched = routeKnowledgeQuery('totally unrelated words here', catalog());
  assert.deepEqual(unmatched, {}, 'a goal that names no domain routes nowhere rather than guessing');

  const planning = routeKnowledgeQuery('planning', catalog());
  assert.equal(planning.domain, 'planning');
  assert.equal(tokenize('Hello, Wörld 42 a')[0], 'hello', 'tokens are lowercased');
  assert.deepEqual(tokenize('a b c 42'), ['42'], 'single characters are dropped but numbers stay');
});

test('goal reranking prefers relevance over trust, then trust, then recency', () => {
  const entries = [
    entry({ id: 'trusted-vague', trust: 'HIGH', title: 'General notes', content: 'nothing specific here' }),
    entry({ id: 'relevant', trust: 'LOW', title: 'Budget retrieval', content: 'the budget stops retrieval early' }),
  ];
  const reranked = retrieveReranked(entries, {}, 'budget retrieval', NOW);
  assert.equal(reranked[0].id, 'relevant', 'relevance outranks trust');
  assert.ok(relevanceScore(entries[1], 'budget retrieval') > relevanceScore(entries[0], 'budget retrieval'));

  const tied = [
    entry({ id: 'old-high', trust: 'HIGH', title: 'same words', content: 'same words' }),
    entry({ id: 'new-high', trust: 'HIGH', title: 'same words', content: 'same words' }),
  ];
  assert.deepEqual(retrieveReranked(tied, {}, 'same words', NOW).map((item) => item.id).length, 2);
  assert.equal(relevanceScore(entry({ title: 'alpha', tags: ['beta'], domain: 'gamma', content: 'delta' }), 'alpha beta gamma delta'), 3 + 2 + 2 + 1);
});

test('supersession and conflict metadata is reported honestly', () => {
  const report = conflictReport([
    entry({ id: 'a' }),
    entry({ id: 'b', supersedes: 'a', conflictGroup: 'g1' }),
    entry({ id: 'c', conflictGroup: 'g1' }),
    entry({ id: 'd', supersedes: 'missing' }),
  ]);
  assert.deepEqual(report.superseded, ['a', 'missing']);
  assert.deepEqual(report.live, ['b', 'c', 'd'], 'the superseded entry is no longer live');
  assert.deepEqual(report.conflicts, [{ group: 'g1', ids: ['b', 'c'] }]);
  assert.deepEqual(report.conflictingGroups, ['g1']);
  assert.deepEqual(report.danglingSupersedes, ['d'], 'a supersedes pointer to a missing entry is reported');
  assert.equal(conflictReport([entry({ id: 'solo' })]).conflicts.length, 0);
});

test('entry and query payload validation rejects nonsense instead of guessing', () => {
  assert.equal(normalizeEntry({ id: 'x', domain: 'd', title: 't', content: 'c' }).trust, 'UNVERIFIED', 'trust defaults to UNVERIFIED');
  assert.equal(normalizeEntry({ id: 'x', domain: 'd', title: 't', content: 'c', trust: 'high' }).trust, 'HIGH', 'trust is upper-cased');
  assert.equal(normalizeEntry({ id: 'x', domain: 'd', title: 't', content: 'c' }).shelf, 'default');
  assert.equal(normalizeEntry({ id: 'x', domain: 'd', title: 't', content: 'c', tags: 'a, b ,a' }).tags.length, 3);

  const bad = [
    {},
    { id: 'x' },
    { id: 'x', domain: 'd' },
    { id: 'x', domain: 'd', title: 't', trust: 'MAYBE' },
    { id: 'x', domain: 'd', title: 't', validFrom: 'nope' },
    [],
  ];
  for (const input of bad) assert.throws(() => normalizeEntry(input));

  assert.equal(normalizeQuery(undefined).maxChars, DEFAULT_MAX_CHARS);
  assert.deepEqual(normalizeQuery({ trustAtLeast: 'high' }).trustAtLeast, 'HIGH');
  assert.throws(() => normalizeQuery({ maxChars: 0 }));
  assert.throws(() => normalizeQuery({ maxChars: 5000000 }));
  assert.throws(() => normalizeQuery({ trustAtLeast: 'MAYBE' }));
});

test('the room exposes taxonomy, retrieval, routing and conflicts over HTTP', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const capabilities = await hub.api('GET', `${API}/capabilities`);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.payload.embeddings, false);
  assert.equal(capabilities.payload.donor.commit, DONOR_COMMIT);
  assert.deepEqual(capabilities.payload.donor.sourcePaths, ['src/shared/knowledge.ts']);
  assert.deepEqual(capabilities.payload.donor.skippedSourcePaths, ['electron/knowledge/knowledge-store.ts']);

  const taxonomy = await hub.api('POST', `${API}/taxonomy`, { entries: catalog() });
  assert.equal(taxonomy.payload.total, 10);
  assert.deepEqual(taxonomy.payload.taxonomy.domains, ['engineering', 'planning']);

  const retrieved = await hub.api('POST', `${API}/retrieve`, { entries: catalog(), query: { maxChars: 120 } });
  assert.equal(retrieved.payload.mode, 'trust');
  assert.equal(retrieved.payload.withinBudget, true);
  assert.ok(retrieved.payload.characters <= 120);
  assert.ok(!retrieved.payload.entries.some((item) => ['expired', 'future'].includes(item.id)));

  const reranked = await hub.api('POST', `${API}/retrieve`, { entries: catalog(), query: { maxChars: 5000 }, goal: 'budget retrieval' });
  assert.equal(reranked.payload.mode, 'reranked');
  assert.equal(typeof reranked.payload.entries[0].relevance, 'number');

  const routed = await hub.api('POST', `${API}/route`, { entries: catalog(), goal: 'engineering retrieval budget' });
  assert.equal(routed.payload.query.domain, 'engineering');
  assert.ok(routed.payload.matches.length >= 1);
  assert.deepEqual(routed.payload.taxonomy.domains, ['engineering', 'planning']);

  const conflicts = await hub.api('POST', `${API}/conflicts`, {
    entries: [entry({ id: 'a' }), entry({ id: 'b', supersedes: 'a', conflictGroup: 'g' })],
  });
  assert.deepEqual(conflicts.payload.conflicts.superseded, ['a']);
  assert.deepEqual(conflicts.payload.conflicts.conflictingGroups, []);

  assert.equal((await hub.api('POST', `${API}/retrieve`, { entries: [] })).status, 400);
  assert.equal((await hub.api('POST', `${API}/route`, { entries: catalog(), goal: '' })).status, 400);
  assert.equal((await hub.api('POST', `${API}/taxonomy`, { entries: 'nope' })).status, 400);
});

test('the room never writes a runtime file and does not depend on the Boss store', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await hub.api('POST', `${API}/taxonomy`, { entries: catalog() });
  assert.deepEqual(await readdir(hub.runtimeDir), [], 'the lab has no durable file');

  const roomDir = join(import.meta.dirname, '..', 'rooms', 'knowledge-core-lab');
  for (const file of ['knowledge-core.mjs', 'room.server.mjs']) {
    const source = await readFile(join(roomDir, file), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ['require(', 'durable-json', "from 'electron", 'from "electron', "require('electron"]) {
      assert.ok(!code.includes(forbidden), `${file} must not depend on the Boss store (${forbidden})`);
    }
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
    }
  }
});
