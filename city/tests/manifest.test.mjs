/**
 * UTOPIA · City — manifest and hierarchy tests.
 *
 * Proves the ownership structure is honest: the manifest matches the tree, every
 * district/building/module path is well formed, an implemented module must name
 * its incubator room, and inconsistent lifecycles are rejected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CITY_LIFECYCLES,
  IMPLEMENTED_LIFECYCLES,
  ManifestError,
  checkManifestAgainstTree,
  discoverTests,
  flattenModules,
  loadManifest,
  validateManifest,
} from '../manifest.mjs';

const WAVE1 = [
  'city/02-engineering/02-worker-gateway/skill-intake',
  'city/09-planning-knowledge/01-knowledge-service/knowledge-core',
  'city/09-planning-knowledge/02-document-intake/ingestion-core',
  'city/11-entertainment/01-entertainment-centre/theme-engine',
];

test('the real manifest describes exactly the wave 1 districts and modules', async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(
    manifest.districts.map((district) => district.id),
    ['02-engineering', '09-planning-knowledge', '11-entertainment'],
    'only the three districts that actually exist are declared',
  );
  for (const district of manifest.districts) {
    assert.ok(district.zh.length > 0 && district.en.length > 0, `${district.id} has bilingual names`);
  }

  const modules = flattenModules(manifest);
  assert.deepEqual(modules.map((entry) => entry.module.path), WAVE1);
  for (const { module } of modules) {
    assert.ok(CITY_LIFECYCLES.includes(module.lifecycle), `${module.id} lifecycle is valid`);
    assert.ok(module.roomId, `${module.id} names its incubator room`);
    assert.ok(['PLANNED', 'INCUBATING', 'PROMOTED', 'ACTIVE', 'DEPRECATED'].includes(module.lifecycle));
  }

  const active = modules.filter(({ module }) => IMPLEMENTED_LIFECYCLES.includes(module.lifecycle));
  assert.ok(active.length <= modules.length);
});

test('the manifest and the city tree agree on what exists', async () => {
  const manifest = await loadManifest();
  const problems = await checkManifestAgainstTree(manifest);
  assert.deepEqual(problems, [], 'every implemented module exists and no unplanned module directory has appeared');
});

test('the manifest rejects malformed hierarchy, paths and lifecycles', async () => {
  const base = await loadManifest();

  const clone = () => JSON.parse(JSON.stringify(base));
  const cases = [
    ['root not an object', () => []],
    ['wrong schemaVersion', () => ({ ...clone(), schemaVersion: 2 })],
    ['no districts', () => ({ ...clone(), districts: [] })],
    ['district id shape', () => {
      const next = clone();
      next.districts[0].id = 'engineering';
      return next;
    }],
    ['duplicate district', () => {
      const next = clone();
      next.districts.push(JSON.parse(JSON.stringify(next.districts[0])));
      return next;
    }],
    ['building without modules', () => {
      const next = clone();
      next.districts[0].buildings[0].modules = [];
      return next;
    }],
    ['module path that is not derived from district/building/module', () => {
      const next = clone();
      next.districts[0].buildings[0].modules[0].path = 'city/02-engineering/02-worker-gateway/skill-intake-core';
      return next;
    }],
    ['unknown lifecycle', () => {
      const next = clone();
      next.districts[0].buildings[0].modules[0].lifecycle = 'READY';
      return next;
    }],
    ['implemented module without an incubator room', () => {
      const next = clone();
      const module = next.districts[0].buildings[0].modules[0];
      module.lifecycle = 'ACTIVE';
      delete module.roomId;
      return next;
    }],
    ['donor without a valid commit', () => {
      const next = clone();
      next.districts[0].buildings[0].modules[0].donor = { repository: 'x', commit: 'nope' };
      return next;
    }],
  ];

  for (const [name, build] of cases) {
    assert.throws(() => validateManifest(build()), ManifestError, name);
  }
});

test('module directories and lifecycles must not contradict each other', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'city-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await loadManifest();

  // a PLANNED module with an existing directory is a contradiction
  await mkdir(join(root, '09-planning-knowledge/01-knowledge-service/knowledge-core'), { recursive: true });
  const problems = await checkManifestAgainstTree(manifest, root);
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0], /knowledge-core: .*exists but lifecycle is only PLANNED/);

  // declaring that module implemented resolves it, and the real tree now matches
  const promoted = JSON.parse(JSON.stringify(manifest));
  promoted.districts[1].buildings[0].modules[0].lifecycle = 'PROMOTED';
  assert.deepEqual(await checkManifestAgainstTree(promoted, root), [], 'the promoted module now matches the tree');

  // an implemented module whose directory is missing is a contradiction
  const missing = JSON.parse(JSON.stringify(promoted));
  missing.districts[1].buildings[1].modules[0].lifecycle = 'ACTIVE';
  const problems2 = await checkManifestAgainstTree(missing, root);
  assert.equal(problems2.length, 1, 'only the missing implemented module is reported');
  assert.match(problems2[0], /ingestion-core: lifecycle ACTIVE but .* does not exist/);
});

test('loadManifest reports an unreadable manifest instead of guessing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'city-manifest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(() => loadManifest(join(dir, 'missing.json')), ManifestError);

  const broken = join(dir, 'broken.json');
  await writeFile(broken, '{ not json', 'utf8');
  await assert.rejects(() => loadManifest(broken), ManifestError);
});

test('city/test-all.mjs discovers module tests without shell globs', async () => {
  const found = await discoverTests();
  const normalized = found.map((file) => file.replace(/\\/g, '/'));
  assert.ok(normalized.some((file) => file.endsWith('tests/manifest.test.mjs')), 'the manifest test is discovered');
  assert.ok(found.every((file) => file.endsWith('.test.mjs')));
  assert.equal(found.length, new Set(found).size, 'no duplicates');
});
