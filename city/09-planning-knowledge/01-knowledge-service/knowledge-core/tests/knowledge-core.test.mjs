/**
 * City module tests — Knowledge Core
 * (city/09-planning-knowledge/01-knowledge-service/knowledge-core).
 *
 * Donor parity suite: the vectors restate the Codex-Boss donor behaviour
 * (`src/shared/knowledge.ts` @ 8df428eaa437a409368401e95194e40266b83080). The
 * incubator room that produced this module was removed from the tree once it was
 * promoted here; see apps/rooms/promotions/knowledge-core-lab.json.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_CHARS,
  TRUST_LEVELS,
  TRUST_ORDER,
  conflictReport,
  entryMatches,
  planRetrieval,
  relevanceScore,
  retrieveReranked,
  retrieveWithinBudget,
  routeKnowledgeQuery,
  taxonomyOf,
  tokenize,
} from '../index.mjs';
import { REQUIRED_ENTRY_FIELDS, QUERY_FIELDS } from '../contracts/index.mjs';
import { routeKnowledgeQuery as routeFromTaxonomy } from '../taxonomy/index.mjs';
import { TRUST_ORDER as trustFromTrust } from '../trust/index.mjs';
import { conflictReport as conflictsFromConflict } from '../conflict/index.mjs';

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
  assert.equal(trustFromTrust.HIGH, 3, 'the trust facade exposes the same order');
  assert.deepEqual(REQUIRED_ENTRY_FIELDS, ['id', 'domain', 'title', 'content', 'trust']);
  assert.deepEqual(QUERY_FIELDS, ['domain', 'shelf', 'tags', 'trustAtLeast', 'maxChars']);

  assert.equal(entryMatches({}, entry(), NOW), true);
  assert.equal(entryMatches({ domain: 'engineering' }, entry(), NOW), true);
  assert.equal(entryMatches({ domain: 'planning' }, entry(), NOW), false);
  assert.equal(entryMatches({ shelf: 'utopia' }, entry(), NOW), true);
  assert.equal(entryMatches({ tags: ['retrieval'] }, entry(), NOW), true);
  assert.equal(entryMatches({ tags: ['retrieval', 'budget'] }, entry(), NOW), false, 'all tags must match');
  assert.equal(entryMatches({ trustAtLeast: 'HIGH' }, entry(), NOW), false);
  assert.equal(entryMatches({}, entry({ trust: 'BOGUS' }), NOW), true, 'an unknown trust counts as zero');
  assert.equal(entryMatches({}, entry({ validUntil: '2026-01-01T00:00:00.000Z' }), NOW), false, 'expired entries are excluded');
  assert.equal(entryMatches({}, entry({ validFrom: '2026-12-01T00:00:00.000Z' }), NOW), false, 'not-yet-valid entries are excluded');
});

test('retrieval is trust-ordered, recency-broken and within the character budget', () => {
  const ids = retrieveWithinBudget(catalog(), { maxChars: DEFAULT_MAX_CHARS }, NOW).map((item) => item.id);
  assert.ok(ids.indexOf('high') < ids.indexOf('medium'), 'HIGH before MEDIUM');
  assert.ok(ids.indexOf('medium') < ids.indexOf('low'), 'MEDIUM before LOW');
  assert.ok(ids.indexOf('low') < ids.indexOf('unverified'), 'LOW before UNVERIFIED');
  assert.ok(!ids.includes('expired') && !ids.includes('future'), 'invalid windows never retrieve');

  const sameTrust = [
    entry({ id: 'older', trust: 'HIGH', updatedAt: '2026-01-01T00:00:00.000Z' }),
    entry({ id: 'newer', trust: 'HIGH', updatedAt: '2026-02-01T00:00:00.000Z' }),
  ];
  assert.deepEqual(retrieveWithinBudget(sameTrust, {}, NOW).map((item) => item.id), ['newer', 'older'], 'recency breaks trust ties');

  const budgeted = retrieveWithinBudget(catalog(), { maxChars: 120 }, NOW);
  const used = budgeted.reduce((total, item) => total + item.content.length, 0);
  assert.ok(used <= 120, `budget respected, used ${used}`);
  assert.ok(budgeted.length >= 1, 'at least one entry always fits');
  assert.ok(retrieveWithinBudget(catalog(), { maxChars: 100000 }, NOW).length > budgeted.length, 'a larger budget returns more');
});

test('taxonomy and the deterministic domain router match the donor', () => {
  const taxonomy = taxonomyOf(catalog());
  assert.deepEqual(taxonomy.domains, ['engineering', 'planning']);
  assert.deepEqual(taxonomy.shelves, ['side', 'utopia']);
  assert.ok(taxonomy.tags.includes('retrieval') && taxonomy.tags.includes('budget'));

  const routed = routeKnowledgeQuery('engineering retrieval budget', catalog());
  assert.equal(routed.domain, 'engineering');
  assert.ok(routed.tags.includes('retrieval') && routed.tags.includes('budget'), JSON.stringify(routed));
  assert.equal(routeFromTaxonomy('planning', catalog()).domain, 'planning', 'the taxonomy facade routes identically');
  assert.deepEqual(routeKnowledgeQuery('totally unrelated words here', catalog()), {}, 'a goal that names no domain routes nowhere');
  assert.equal(tokenize('Hello, Wörld 42 a')[0], 'hello', 'tokens are lowercased');
  assert.deepEqual(tokenize('a b c 42'), ['42'], 'single characters are dropped but numbers stay');
});

test('goal reranking prefers relevance, then trust, then recency', () => {
  const entries = [
    entry({ id: 'trusted-vague', trust: 'HIGH', title: 'General notes', content: 'nothing specific here' }),
    entry({ id: 'relevant', trust: 'LOW', title: 'Budget retrieval', content: 'the budget stops retrieval early' }),
  ];
  assert.equal(retrieveReranked(entries, {}, 'budget retrieval', NOW)[0].id, 'relevant', 'relevance outranks trust');
  assert.ok(relevanceScore(entries[1], 'budget retrieval') > relevanceScore(entries[0], 'budget retrieval'));
  assert.equal(relevanceScore(entry({ title: 'alpha', tags: ['beta'], domain: 'gamma', content: 'delta' }), 'alpha beta gamma delta'), 8);
});

test('planRetrieval combines routing, reranking and the budget in one call', () => {
  const plan = planRetrieval('engineering retrieval budget', catalog(), { maxChars: 200 });
  assert.equal(plan.query.domain, 'engineering');
  assert.equal(plan.query.maxChars, 200);
  assert.ok(plan.entries.length >= 1);
  assert.ok(plan.entries.every((item) => item.domain === 'engineering'), 'routing restricted the result set');
  assert.ok(plan.entries.reduce((total, item) => total + item.content.length, 0) <= 200, 'the budget still applies');

  const withoutGoal = planRetrieval('', catalog(), { maxChars: 100 });
  assert.equal(withoutGoal.query.maxChars, 100);
  assert.ok(withoutGoal.entries.length >= 1, 'no goal falls back to trust-ordered retrieval');
});

test('supersession and conflict metadata is reported honestly', () => {
  const report = conflictReport([
    entry({ id: 'a' }),
    entry({ id: 'b', supersedes: 'a', conflictGroup: 'g1' }),
    entry({ id: 'c', conflictGroup: 'g1' }),
    entry({ id: 'd', supersedes: 'missing' }),
  ]);
  assert.deepEqual(report.superseded, ['a', 'missing']);
  assert.deepEqual(report.live, ['b', 'c', 'd'], 'a superseded entry is no longer live');
  assert.deepEqual(report.conflicts, [{ group: 'g1', ids: ['b', 'c'] }]);
  assert.deepEqual(report.conflictingGroups, ['g1']);
  assert.deepEqual(report.danglingSupersedes, ['d'], 'a supersedes pointer to a missing entry is reported');
  assert.deepEqual(conflictsFromConflict([entry({ id: 'solo' })]).conflicts, [], 'the conflict facade agrees');
});

test('the module is self-contained: built-ins only, no Boss store dependency', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const moduleDir = join(import.meta.dirname, '..');

  async function walk(directory) {
    const found = [];
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.name === 'tests') continue; // the suite itself is not part of the module surface
      const absolute = join(directory, item.name);
      if (item.isDirectory()) found.push(...(await walk(absolute)));
      else if (item.name.endsWith('.mjs')) found.push(absolute);
    }
    return found;
  }

  const files = await walk(moduleDir);
  assert.ok(files.length >= 5, `expected the module facade files, found ${files.length}`);
  for (const file of files) {
    const code = (await readFile(file, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ['require(', 'durable-json', "from 'electron", 'from "electron']) {
      assert.ok(!code.includes(forbidden), `${file} must not depend on the Boss store (${forbidden})`);
    }
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
    }
  }
});

test('provenance stays honest: DONOR.json pins the donor and records the adaptation', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const donor = JSON.parse(await readFile(join(import.meta.dirname, '..', 'DONOR.json'), 'utf8'));
  assert.equal(donor.repository, 'zhiheng-zhang-Mera/Codex-Boss');
  assert.equal(donor.commit, '8df428eaa437a409368401e95194e40266b83080');
  assert.equal(donor.cityPath, 'city/09-planning-knowledge/01-knowledge-service/knowledge-core');
  assert.equal(donor.room, 'knowledge-core-lab');
  assert.deepEqual(donor.sourcePaths, ['src/shared/knowledge.ts']);
  assert.ok(donor.skippedSourcePaths.includes('electron/knowledge/knowledge-store.ts'));
  assert.ok(donor.adaptation.length >= 3);
  assert.ok(donor.knownDifferences.length >= 1);
  assert.ok(donor.parity.vectors.length >= 8);
});
