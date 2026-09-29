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
  MANIFEST_SCHEMA_VERSION,
  ManifestError,
  checkManifestAgainstTree,
  discoverTests,
  flattenModules,
  loadManifest,
  moduleIncubationRooms,
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
  assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION);
  assert.equal(manifest.schemaVersion, 2);
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
  for (const entry of modules) {
    const { module } = entry;
    assert.ok(CITY_LIFECYCLES.includes(module.lifecycle), `${module.id} lifecycle is valid`);
    assert.ok(Array.isArray(module.incubationRooms), `${module.id} records incubationRooms as a list`);
    assert.ok(module.incubationRooms.length > 0, `${module.id} names at least one incubator room`);
    assert.equal(
      new Set(module.incubationRooms).size,
      module.incubationRooms.length,
      `${module.id} incubationRooms are unique`,
    );
    assert.deepEqual(entry.incubationRooms, module.incubationRooms, 'flattenModules exposes the rooms');
    assert.equal(module.roomId, undefined, `${module.id} no longer uses the single roomId field`);
  }

  // a room may not be claimed by two modules
  const claimed = modules.flatMap((entry) => entry.incubationRooms);
  assert.equal(new Set(claimed).size, claimed.length, 'no incubation room is claimed twice');

  // D1 is PROMOTED, not ACTIVE, until a real city runtime consumer exists
  const skillIntake = modules.find((entry) => entry.module.id === 'skill-intake').module;
  assert.equal(skillIntake.lifecycle, 'PROMOTED');
  assert.deepEqual(skillIntake.incubationRooms, ['skill-intake-lab']);

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
    ['wrong schemaVersion', () => ({ ...clone(), schemaVersion: 1 })],
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
      module.incubationRooms = [];
      return next;
    }],
    ['incubationRooms that is not an array', () => {
      const next = clone();
      next.districts[0].buildings[0].modules[0].incubationRooms = 'skill-intake-lab';
      return next;
    }],
    ['the same room listed twice inside one module', () => {
      const next = clone();
      next.districts[0].buildings[0].modules[0].incubationRooms = ['skill-intake-lab', 'skill-intake-lab'];
      return next;
    }],
    ['one incubation room claimed by two modules', () => {
      const next = clone();
      next.districts[1].buildings[0].modules[0].incubationRooms = ['skill-intake-lab'];
      return next;
    }],
    ['an empty incubation room entry', () => {
      const next = clone();
      next.districts[0].buildings[0].modules[0].incubationRooms = [''];
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

  // work from a synthetic all-PLANNED manifest so the check is about the rule,
  // not about which modules this repository has already promoted
  const planned = JSON.parse(JSON.stringify(manifest));
  for (const district of planned.districts) {
    for (const building of district.buildings) {
      for (const module of building.modules) {
        module.lifecycle = 'PLANNED';
        module.donor = null;
      }
    }
  }
  assert.deepEqual(await checkManifestAgainstTree(planned, root), [], 'an empty tree matches an all-PLANNED manifest');

  // a PLANNED module with an existing directory is a contradiction
  await mkdir(join(root, '09-planning-knowledge/01-knowledge-service/knowledge-core'), { recursive: true });
  const problems = await checkManifestAgainstTree(planned, root);
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0], /knowledge-core: .*exists but lifecycle is only PLANNED/);

  // declaring that module implemented resolves it
  const promoted = JSON.parse(JSON.stringify(planned));
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
