/**
 * UTOPIA · Research Institute — export site, purity and edge suite.
 *
 * Proves three things the migration must hold:
 *   - `index.mjs` is the single export site and its surface is exactly the pinned
 *     list, no more and no less;
 *   - the module is pure (no filesystem, network, clock, randomness or environment)
 *     and self-contained (only relative imports, no donor checkout, no runtime);
 *   - the donor's `research-levela.ts` -> `research-levelb.ts` value edge is a real
 *     `import { isFalsifiable } from './levelb.mjs'`, and nothing re-implements the
 *     sibling evidence engine or adds a research direction MB-007 forbids.
 *
 * Ported from the Codex-Boss donor files `src/shared/research-review.ts`,
 * `src/shared/research-adjudicate.ts`, `src/shared/research-levela.ts`,
 * `src/shared/research-levelb.ts` and
 * `src/shared/research-capability-registry.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as researchReview from '../index.mjs';
import { FALSIFIABLE_FEASIBILITY_BONUS, noveltyReview } from '../index.mjs';

const MODULE_DIR = join(import.meta.dirname, '..');

/** Every name the module publishes, pinned so an extra export is a failure too. */
const EXPORTED_NAMES = [
  'DEFAULT_REPLICATION_RUNS',
  'DEFAULT_REQUIRED_VOTES',
  'DEFAULT_SEED',
  'EPOCH_TIMESTAMP',
  'EXPERIMENT_PURPOSES',
  'FALSIFIABLE_FEASIBILITY_BONUS',
  'LEVEL_A_MIN_SCORE',
  'MAX_TEXT_LENGTH',
  'NOVELTY_OVERLAP_CREDIT',
  'NOVELTY_OVERLAP_PENALTY',
  'NOVELTY_SCORE_WEIGHT',
  'NO_HARNESS_FEASIBILITY_PENALTY',
  'PRIMARY_METRICS',
  'REPLICATION_RUNS_MAX',
  'REPLICATION_RUNS_MIN',
  'RESEARCH_CAPABILITIES',
  'RESEARCH_CAPABILITY_IDS',
  'RESEARCH_CAPABILITY_STATUSES',
  'REVIEW_ROLES',
  'REVIEW_SEVERITIES',
  'REVIEW_STANCES',
  'REVIEW_VERDICTS',
  'SCORE_MAX',
  'SCORE_MIN',
  'adjudicateClaim',
  'buildExperimentSpec',
  'candidateQuestion',
  'claimEvidence',
  'experimentSpec',
  'isFalsifiable',
  'isResearchCapabilityStatus',
  'levelAGate',
  'metaReview',
  'noveltyReview',
  'planResearchCapabilities',
  'projectSignals',
  'publicationReady',
  'publicationState',
  'researchStudyProfile',
  'respondToObjections',
  'reviewObjection',
  'reviewResponse',
  'reviewRound',
  'reviewRoundSettled',
  'reviewerVote',
  'selectFalsifiableQuestion',
  'validateCandidateQuestion',
  'validateLevelAPlan',
];

/** The module sources with comments removed, so prose cannot satisfy a check. */
async function moduleSources() {
  const entries = (await readdir(MODULE_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => entry.name)
    .sort();
  const sources = new Map();
  for (const name of entries) {
    const code = (await readFile(join(MODULE_DIR, name), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    sources.set(name, code);
  }
  return sources;
}

test('index.mjs is the single export site, and its surface is pinned', () => {
  const names = Object.keys(researchReview).sort();
  assert.deepEqual(names, EXPORTED_NAMES);
  assert.equal(names.length, 48);
  assert.equal('default' in researchReview, false, 'there is no default export');
  for (const name of names) {
    assert.notEqual(researchReview[name], undefined, `${name} is exported`);
  }
});

test('the module is self-contained and pure: only relative imports, no clock, no randomness, no environment', async () => {
  const sources = await moduleSources();
  assert.deepEqual([...sources.keys()], ['adjudicate.mjs', 'capability-registry.mjs', 'contracts.mjs', 'index.mjs', 'levela.mjs', 'levelb.mjs', 'review.mjs']);

  const dateCalls = [];
  for (const [name, code] of sources) {
    for (const forbidden of ['process.env', 'Math.random', 'Date.now', "require(", 'fetch(', 'http://', 'https://', 'from "app/', "from 'app/", "from 'electron"]) {
      assert.ok(!code.includes(forbidden), `${name} must not contain ${forbidden}`);
    }
    assert.ok(!/\bimport\s*\(/.test(code) && !/\brequire\b/.test(code), `${name} must not load anything dynamically`);
    assert.ok(!/import\s+type\b/.test(code), `${name} carries no type-only import`);

    for (const specifier of [...code.matchAll(/from\s*'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('./'), `${name} imports ${specifier}`);
    }
    for (const match of code.matchAll(/new Date\(([^)]*)\)/g)) dateCalls.push(`${name}:${match[1]}`);
  }

  // the only clock-shaped expression is the deterministic epoch sentinel
  assert.deepEqual(dateCalls, ['contracts.mjs:0']);

  // no hashing, no claim statuses, no decision vocabulary from the sibling evidence engine
  for (const [name, code] of sources) {
    for (const forbidden of ['evidence-engine', 'HOLD_FOR_REVIEW', 'integrityRoot', 'createHash', 'sha256', 'ARTIFACT_HASH_MISMATCH']) {
      assert.ok(!code.includes(forbidden), `${name} must not carry the evidence engine's ${forbidden}`);
    }
  }
});

test('no new delayed-learning or Machine Intelligence research direction was added', async () => {
  const sources = await moduleSources();
  for (const [name, code] of sources) {
    assert.ok(!/machine[\s-]?intelligence/i.test(code), `${name} adds no Machine Intelligence direction`);
    assert.ok(!/delayed[\s-]?learning/i.test(code), `${name} adds no delayed-learning direction`);
  }
});

test('the donor levela -> levelb value edge is preserved, and never reversed', async () => {
  const sources = await moduleSources();
  const levela = sources.get('levela.mjs');
  const levelb = sources.get('levelb.mjs');

  assert.ok(levela.includes("import { isFalsifiable } from './levelb.mjs';"), 'levela imports the Level-B value');
  assert.ok(levela.includes("from './levelb.mjs'"), 'and the specifier points at the sibling behaviour module');
  assert.ok(!levelb.includes("from './levela.mjs'"), 'levelb must not import levela back');

  // the edge is a value edge: the Level-B rule demonstrably drives Level-A scoring
  const signals = { files: 1, testFiles: 1, languages: ['ts'], topModules: [] };
  const base = { id: 'q1', question: 'Does X cause Y?', measurable: true, proposedBy: 'p' };
  const falsifiable = noveltyReview({ ...base, falsifiable: true }, signals);
  const unfalsifiable = noveltyReview({ ...base, falsifiable: false }, signals);
  assert.equal(falsifiable.feasibilityScore - unfalsifiable.feasibilityScore, FALSIFIABLE_FEASIBILITY_BONUS);
});
