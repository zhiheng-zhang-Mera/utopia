/**
 * D1 — Skill Intake Lab focused tests, including donor parity.
 *
 * The format and archive vectors below are copied from the DS-Hns donor test
 * suite (`tests/unit/skills-service.test.js` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b) so the ported core is proved against
 * the behaviour the donor actually ships, not against a restatement of it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { startTestHub } from './harness.mjs';
import {
  MAX_SKILL_BYTES,
  analyzeSkillDocument,
  isSkillName,
  parseFrontmatter,
  parseSimpleYaml,
  parseSkillText,
  renderSkillDocument,
} from '../rooms/skill-intake-lab/format.mjs';
import {
  BLOCK_SIZE,
  inspectArchive,
  listEntries,
  maybeGunzip,
  readChecksum,
  readEntries,
  safeRelativePath,
} from '../rooms/skill-intake-lab/archive.mjs';

const API = '/local-rooms/v1/skill-intake-lab';
const DONOR_COMMIT = 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b';

/** Donor helper: build a SKILL.md document. */
function skillDoc(name, description, extra = '') {
  return `---\nname: ${name}\ndescription: ${description}\n${extra ? `${extra}\n` : ''}---\n\n# ${name}\n\nBody text.\n`;
}

/** Donor helper: build a single tar header block. */
function tarHeader(name, size, type) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  block.write('00000000000\0', 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  block.write(type, 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (let index = 0; index < 512; index += 1) sum += block[index];
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

function tarPad(buffer) {
  const remainder = buffer.length % BLOCK_SIZE;
  return remainder ? Buffer.concat([buffer, Buffer.alloc(BLOCK_SIZE - remainder)]) : buffer;
}

function buildTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    blocks.push(tarHeader(entry.path, entry.data ? entry.data.length : 0, entry.type || '0'));
    if (entry.data) blocks.push(tarPad(entry.data));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// ---------------------------------------------------------------------------
// format parity
// ---------------------------------------------------------------------------

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
  assert.deepEqual(parseSimpleYaml('# comment\nname: demo\nmetadata:\n  a: b\n'), { name: 'demo', metadata: { a: 'b' } });
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

// ---------------------------------------------------------------------------
// archive parity
// ---------------------------------------------------------------------------

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

  const inspection = inspectArchive({ buffer: archive, stripComponents: 1, parseDocument: analyzeSkillDocument });
  assert.deepEqual(inspection.accepted.map((entry) => entry.path), [
    'skills',
    'skills/archived-skill/SKILL.md',
  ]);
  assert.equal(inspection.skillDocumentPath, 'skills/archived-skill/SKILL.md');
  assert.equal(inspection.skill.accepted, true);
  assert.equal(inspection.refusedCount, 0);
  assert.equal(inspection.bytes, document.length);
  assert.equal(entries[2].data.toString('utf8'), document.toString('utf8'), 'inspection never needs to write the file');
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

  // Unsafe paths are refused before they ever become entries (donor behaviour).
  const entries = readEntries(archive);
  assert.deepEqual(entries.map((entry) => entry.path), ['repo/legit.txt']);
  assert.ok(entries.every((entry) => !entry.path.startsWith('..') && !entry.path.startsWith('/')));
  const inspection = inspectArchive({ buffer: archive });
  assert.deepEqual(inspection.accepted.map((entry) => entry.path), ['repo/legit.txt'], 'only the legitimate entry is accepted');
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
  assert.equal(inspection.verdict, undefined, 'verdicts are decided by the room layer');
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
  const broken = Buffer.from(archive);
  broken[0] = broken[0] === 0x72 ? 0x73 : 0x72; // corrupt the first name byte
  assert.equal(readChecksum(archive), readChecksum(archive));
  assert.throws(() => readEntries(broken), /unsupported tar structure/);
});

// ---------------------------------------------------------------------------
// room surface
// ---------------------------------------------------------------------------

test('the room exposes its donor, limits and both intake flows over HTTP', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const capabilities = await hub.api('GET', `${API}/capabilities`);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.payload.installs, false, 'wave 1 installs nothing');
  assert.equal(capabilities.payload.donor.commit, DONOR_COMMIT);
  assert.deepEqual(capabilities.payload.donor.sourcePaths, [
    'app/extensions/mega/skills/skill-format.js',
    'app/extensions/mega/skills/tar.js',
  ]);

  const good = await hub.api('POST', `${API}/skill/analyze`, { text: skillDoc('http-skill', 'From HTTP') });
  assert.equal(good.payload.accepted, true);
  assert.equal(good.payload.name, 'http-skill');
  assert.equal(good.payload.skill.modelInvocable, true);

  const bad = await hub.api('POST', `${API}/skill/analyze`, { text: 'no frontmatter' });
  assert.equal(bad.payload.accepted, false);
  assert.match(bad.payload.reason, /frontmatter/);
  assert.equal((await hub.api('POST', `${API}/skill/analyze`, {})).status, 400, 'a missing text field is a payload error');

  const document = Buffer.from(skillDoc('bundle-skill', 'Inside a bundle'), 'utf8');
  const archive = buildTar([
    { path: 'repo/', type: '5' },
    { path: 'repo/SKILL.md', data: document },
    { path: 'repo/link', type: '2' },
  ]);
  const inspected = await hub.api('POST', `${API}/archive/inspect`, {
    base64: archive.toString('base64'),
    stripComponents: 1,
  });
  assert.equal(inspected.payload.ok, true);
  assert.equal(inspected.payload.verdict, 'REJECTED_ENTRIES', 'a bundle containing a link is refused');
  assert.deepEqual(inspected.payload.accepted.map((entry) => entry.path), ['SKILL.md']);
  assert.equal(inspected.payload.skillDocumentPath, 'SKILL.md');
  assert.equal(inspected.payload.skill.accepted, true);
  assert.equal(inspected.payload.fileCount, 1);
  assert.equal(inspected.payload.gzip, false);

  const cleanArchive = buildTar([{ path: 'SKILL.md', data: document }]);
  const clean = await hub.api('POST', `${API}/archive/inspect`, { base64: cleanArchive.toString('base64') });
  assert.equal(clean.payload.verdict, 'ACCEPTED');
  assert.equal(clean.payload.refusedCount, 0);

  const noSkill = await hub.api('POST', `${API}/archive/inspect`, {
    base64: buildTar([{ path: 'README.md', data: Buffer.from('hi') }]).toString('base64'),
  });
  assert.equal(noSkill.payload.verdict, 'NO_SKILL_DOCUMENT');

  const limit = await hub.api('POST', `${API}/archive/inspect`, {
    base64: buildTar([{ path: 'SKILL.md', data: Buffer.alloc(4096, 0x61) }]).toString('base64'),
    maxBytes: 1024,
  });
  assert.equal(limit.payload.ok, false);
  assert.equal(limit.payload.limit, 'SIZE_LIMIT');

  const listed = await hub.api('POST', `${API}/archive/list`, { base64: archive.toString('base64') });
  assert.equal(listed.payload.ok, true);
  assert.deepEqual(listed.payload.entries.map((entry) => entry.path), ['repo', 'repo/SKILL.md', 'repo/link']);

  for (const bad of [{ base64: '' }, { base64: 'not base64!!' }, { base64: Buffer.from('x').toString('base64'), stripComponents: 99 }]) {
    assert.equal((await hub.api('POST', `${API}/archive/inspect`, bad)).status, 400, JSON.stringify(bad));
  }
});

test('the room never writes a runtime file and stays independent of the donor checkout', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await hub.api('POST', `${API}/skill/analyze`, { text: skillDoc('no-write', 'x') });
  await hub.api('POST', `${API}/archive/inspect`, { base64: buildTar([{ path: 'a.txt', data: Buffer.from('a') }]).toString('base64') });
  const files = await readdir(hub.runtimeDir);
  assert.ok(!files.includes('skill-intake.json'), 'the lab has no durable file');

  const roomDir = join(import.meta.dirname, '..', 'rooms', 'skill-intake-lab');
  for (const file of ['archive.mjs', 'format.mjs', 'room.server.mjs']) {
    const source = await readFile(join(roomDir, file), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    // The donor repository may only be named in provenance text, never imported.
    for (const forbidden of ['require(', "from 'app/", "from 'node_modules", 'from "app/']) {
      assert.ok(!code.includes(forbidden), `${file} must not depend on the donor checkout (${forbidden})`);
    }
    const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('.'),
        `${file} imports only node built-ins and relative modules, got ${specifier}`,
      );
    }
  }
});
