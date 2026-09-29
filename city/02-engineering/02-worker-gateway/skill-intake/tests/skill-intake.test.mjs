/**
 * City module tests — Skill Intake (city/02-engineering/02-worker-gateway/skill-intake).
 *
 * Donor parity suite: the vectors below come from the DS-Hns donor test suite
 * (`tests/unit/skills-service.test.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b),
 * so this module is proved against the behaviour the donor actually ships.
 * The incubator room that produced this module was removed from the tree once it
 * was promoted here; see apps/rooms/promotions/skill-intake-lab.json.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  MAX_SKILL_BYTES,
  analyzeSkillDocument,
  isSkillName,
  parseFrontmatter,
  parseSimpleYaml,
  parseSkillText,
  renderSkillDocument,
} from '../format.mjs';
import {
  BLOCK_SIZE,
  inspectArchive,
  listEntries,
  maybeGunzip,
  readChecksum,
  readEntries,
  safeRelativePath,
} from '../archive.mjs';
import { buildTar, skillDoc } from './fixtures.mjs';

test('skill name grammar matches the donor', () => {
  for (const valid of ['a', 'code-review', 'x1-y2', 'repo-tour']) {
    assert.equal(isSkillName(valid), true, valid);
  }
  for (const invalid of ['', 'Code-Review', '-lead', 'trail-', 'a--b', 'under_score', 'a b', '中文', null, 12]) {
    assert.equal(isSkillName(invalid), false, String(invalid));
  }
});

test('frontmatter parsing reads the donor subset (metadata, whenToUse, invocation)', () => {
  const parsed = parseSkillText(skillDoc('demo-skill', 'A demo', 'whenToUse: 当需要演示时\nmetadata:\n  category: test'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.skill.name, 'demo-skill');
  assert.equal(parsed.skill.description, 'A demo');
  assert.equal(parsed.skill.whenToUse, '当需要演示时');
  assert.deepEqual(parsed.skill.metadata, { category: 'test' });
  assert.equal(parsed.skill.modelInvocable, true);
  assert.equal(parsed.skill.userInvocable, true);

  for (const truthy of ['true', 'True', 'yes', 'on', '1']) {
    const invoked = parseSkillText(skillDoc('inv-skill', 'x', `disable-model-invocation: ${truthy}`));
    assert.equal(invoked.ok, true, truthy);
    assert.equal(invoked.skill.modelInvocable, false, truthy);
  }
  for (const falsy of ['false', 'no', 'off', '0']) {
    const invoked = parseSkillText(skillDoc('inv-skill', 'x', `user-invocable: ${falsy}`));
    assert.equal(invoked.ok, true, falsy);
    assert.equal(invoked.skill.userInvocable, false, falsy);
  }
  const rejected = parseSkillText(skillDoc('inv-skill', 'x', 'disable-model-invocation: maybe'));
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /must be a boolean/);

  assert.deepEqual(parseSimpleYaml('# comment\nname: demo\nmetadata:\n  a: b\n'), { name: 'demo', metadata: { a: 'b' } });
});

test('malformed frontmatter is rejected with a reason, never guessed', () => {
  assert.match(parseSkillText('no frontmatter').reason, /frontmatter/);
  assert.match(parseSkillText('---\ndescription: only\n---\nbody').reason, /requires "name"/);
  assert.match(parseSkillText('---\nname: only\n---\nbody').reason, /requires "description"/);
  assert.match(parseSkillText('---\nname: BadName\ndescription: x\n---\n').reason, /kebab-case/);
  assert.equal(parseFrontmatter('no frontmatter'), null);
  assert.equal(parseFrontmatter('---\nname: x\n'), null, 'an unterminated block is not frontmatter');
});

test('rendering round-trips through the parser like the donor', () => {
  const original = {
    name: 'round-trip',
    description: '描述 with : colon and "quote"',
    whenToUse: 'when needed',
    metadata: { category: 'testing' },
    modelInvocable: false,
    userInvocable: true,
    body: '# Heading\n\nLine one.',
  };
  const parsed = parseSkillText(renderSkillDocument(original));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.skill, original);
});

test('the highest-level analysis accepts a valid document and rejects an oversized one', () => {
  const accepted = analyzeSkillDocument(skillDoc('good-skill', 'Fine'));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.name, 'good-skill');
  assert.equal(accepted.reason, null);

  const oversized = analyzeSkillDocument(`---\nname: big\ndescription: x\n---\n${'a'.repeat(MAX_SKILL_BYTES + 1)}`);
  assert.equal(oversized.accepted, false);
  assert.match(oversized.reason, /exceeds/);
});

test('the tar reader lists regular files and directories like the donor', () => {
  const document = Buffer.from(skillDoc('archived-skill', 'From an archive'), 'utf8');
  const archive = buildTar([
    { path: 'repo-main/', type: '5' },
    { path: 'repo-main/skills/', type: '5' },
    { path: 'repo-main/skills/archived-skill/SKILL.md', data: document },
  ]);
  const entries = readEntries(archive);
  assert.deepEqual(entries.map((entry) => entry.path), [
    'repo-main',
    'repo-main/skills',
    'repo-main/skills/archived-skill/SKILL.md',
  ]);
  assert.equal(entries[0].type, 'directory');
  assert.equal(entries[2].type, 'file');
  assert.equal(entries[2].size, document.length);
  assert.equal(BLOCK_SIZE, 512);

  const inspection = inspectArchive({ buffer: archive, stripComponents: 1, parseDocument: analyzeSkillDocument });
  assert.deepEqual(inspection.accepted.map((entry) => entry.path), ['skills', 'skills/archived-skill/SKILL.md']);
  assert.equal(inspection.skillDocumentPath, 'skills/archived-skill/SKILL.md');
  assert.equal(inspection.skill.accepted, true);
  assert.equal(inspection.refusedCount, 0);
  assert.equal(inspection.bytes, document.length);
});

test('traversal and absolute paths are refused', () => {
  const evil = Buffer.from('pwned', 'utf8');
  const archive = buildTar([
    { path: '../escaped.txt', data: evil },
    { path: '/absolute.txt', data: evil },
    { path: 'repo/../../escaped2.txt', data: evil },
    { path: 'C:/windows.txt', data: evil },
    { path: 'repo/legit.txt', data: evil },
  ]);
  assert.equal(safeRelativePath('../escaped.txt'), null);
  assert.equal(safeRelativePath('/absolute.txt'), null);
  assert.equal(safeRelativePath('C:/windows.txt'), null);
  assert.equal(safeRelativePath('./repo/legit.txt'), 'repo/legit.txt');

  const entries = readEntries(archive);
  assert.deepEqual(entries.map((entry) => entry.path), ['repo/legit.txt'], 'unsafe paths never become entries');
  const inspection = inspectArchive({ buffer: archive });
  assert.deepEqual(inspection.accepted.map((entry) => entry.path), ['repo/legit.txt']);
});

test('symlinks, hardlinks and devices are refused, never accepted', () => {
  const archive = buildTar([
    { path: 'repo/link', type: '2' },
    { path: 'repo/hard', type: '1' },
    { path: 'repo/dev', type: '3' },
    { path: 'repo/file.txt', data: Buffer.from('ok') },
  ]);
  const inspection = inspectArchive({ buffer: archive });
  assert.deepEqual(inspection.accepted.map((entry) => entry.path), ['repo/file.txt']);
  assert.equal(inspection.refused.length, 3);
  assert.ok(inspection.refused.every((item) => /unsupported entry type/.test(item.reason)));
});

test('byte and entry caps stop a zip-bomb sized archive and a flood of entries', () => {
  const big = Buffer.alloc(2048, 0x61);
  const archive = buildTar([
    { path: 'a.bin', data: big },
    { path: 'b.bin', data: big },
    { path: 'c.bin', data: big },
  ]);
  assert.throws(() => inspectArchive({ buffer: archive, maxBytes: 3000 }), /exceeds/);

  const many = buildTar(Array.from({ length: 8 }, (_, index) => ({ path: `f${index}.txt`, data: Buffer.from('x') })));
  assert.throws(() => readEntries(many, { maxEntries: 4 }), /exceeds 4 entries/);
  assert.equal(readEntries(many, { maxEntries: 20 }).length, 8);
});

test('gzip is detected and decompressed transparently', () => {
  const document = Buffer.from(skillDoc('gzipped-skill', 'Gzipped'), 'utf8');
  const plain = buildTar([{ path: 'repo/SKILL.md', data: document }]);
  const gzipped = zlib.gzipSync(plain);
  assert.equal(maybeGunzip(gzipped).length, plain.length);
  assert.equal(maybeGunzip(plain).length, plain.length, 'a plain tar passes through');

  const inspection = inspectArchive({ buffer: gzipped, parseDocument: analyzeSkillDocument });
  assert.deepEqual(inspection.accepted.map((entry) => entry.path), ['repo/SKILL.md']);
  assert.equal(inspection.skill.accepted, true);
  assert.equal(inspection.skill.name, 'gzipped-skill');
  assert.deepEqual(listEntries(gzipped).map((entry) => entry.path), ['repo/SKILL.md']);
});

test('a corrupt header checksum is refused instead of being misread', () => {
  const archive = buildTar([{ path: 'repo/file.txt', data: Buffer.from('ok') }]);
  assert.ok(readChecksum(archive) !== null, 'a well-formed header verifies');
  const broken = Buffer.from(archive);
  broken[0] = broken[0] === 0x72 ? 0x73 : 0x72;
  assert.throws(() => readEntries(broken), /unsupported tar structure/);
});

test('the module is self-contained: built-ins only, no donor checkout dependency', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const moduleDir = join(import.meta.dirname, '..');
  for (const file of ['format.mjs', 'archive.mjs', 'source.mjs', 'catalog.mjs']) {
    const source = await readFile(join(moduleDir, file), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ['require(', "from 'app/", "from 'node_modules", 'from "app/']) {
      assert.ok(!code.includes(forbidden), `${file} must not depend on the donor checkout (${forbidden})`);
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
  assert.equal(donor.repository, 'zhiheng-zhang-Mera/DS-Hns');
  assert.equal(donor.commit, 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b');
  assert.equal(donor.cityPath, 'city/02-engineering/02-worker-gateway/skill-intake');
  // one module, two incubation rooms: the wave 1 format and archive core (D1) and
  // the wave 2 source and catalog core (D5)
  assert.deepEqual(donor.incubationRooms, ['skill-intake-lab', 'skill-discovery-lab']);
  assert.deepEqual(donor.roomSources['skill-intake-lab'], [
    'app/extensions/mega/skills/skill-format.js',
    'app/extensions/mega/skills/tar.js',
  ]);
  assert.deepEqual(donor.roomSources['skill-discovery-lab'], [
    'app/extensions/mega/skills/skill-source.js',
    'app/extensions/mega/skills/skill-catalog.js',
  ]);
  assert.deepEqual(donor.sourcePaths, [
    'app/extensions/mega/skills/skill-format.js',
    'app/extensions/mega/skills/tar.js',
    'app/extensions/mega/skills/skill-source.js',
    'app/extensions/mega/skills/skill-catalog.js',
  ]);
  assert.deepEqual(Object.values(donor.portedFiles).sort(), ['archive.mjs', 'catalog.mjs', 'format.mjs', 'source.mjs']);
  assert.ok(donor.adaptation.length >= 3);
  assert.ok(donor.knownDifferences.length >= 1);
  assert.ok(donor.parity.vectors.length >= 8);
});
