/**
 * D7a — YAML Intake Lab focused tests, including donor parity.
 *
 * The structured-data order, the fallback warning and the deterministic rendering
 * restate the Codex-Boss donor `electron/ingestion/text-parsers.ts`
 * @ 8df428eaa437a409368401e95194e40266b83080. The third-party parser is injected,
 * so these tests run the real city seam and a deterministic stub.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestHub } from './harness.mjs';
import {
  DEFAULT_TEXT_LIMITS,
  STRUCTURED_FORMATS,
  YAML_EXTENSIONS,
  extensionOf,
  ingestStructured,
  parseStructuredText,
  prefersYaml,
  renderStructured,
  sectionsFromStructured,
  validateStructured,
} from '../rooms/yaml-intake-lab/yaml-core.mjs';
import { MAX_ALIAS_COUNT, MAX_YAML_BYTES, tryParseYaml } from '../rooms/yaml-intake-lab/intake-bridge.mjs';

const API = '/local-rooms/v1/yaml-intake-lab';
const DONOR_COMMIT = '8df428eaa437a409368401e95194e40266b83080';

const parseYaml = (text, options = {}) => tryParseYaml(text, options);

const NESTED = [
  'shelf:',
  '  - id: trust',
  '    level: 3',
  '    tags: [review, quality]',
  '  - id: memory',
  '    level: 2',
  'owner:',
  '  name: operator',
  '  contact:',
  '    channel: local',
  '    retries: 2',
  'enabled: true',
  'reviewed_at: 2026-09-29',
].join('\n');

test('the extension decides the order, and only .yaml/.yml prefer YAML', () => {
  assert.deepEqual(YAML_EXTENSIONS, ['.yaml', '.yml']);
  assert.equal(prefersYaml('note.yaml'), true);
  assert.equal(prefersYaml('note.YML'), true);
  assert.equal(prefersYaml('note.json'), false);
  assert.equal(prefersYaml('note'), false);
  assert.equal(extensionOf('a/b/c.tar.gz'), '.gz');
  assert.equal(extensionOf('no-extension'), '');
  assert.deepEqual(STRUCTURED_FORMATS, ['json', 'jsonl', 'yaml']);
});

test('a .yaml document is parsed as YAML with nested maps and sequences', async () => {
  const parsed = await parseStructuredText(NESTED, 'note.yaml', { parseYaml });
  assert.equal(parsed.format, 'yaml');
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.value.shelf, [
    { id: 'trust', level: 3, tags: ['review', 'quality'] },
    { id: 'memory', level: 2 },
  ]);
  assert.deepEqual(parsed.value.owner.contact, { channel: 'local', retries: 2 });
  assert.equal(parsed.value.enabled, true);
  assert.equal(parsed.value.reviewed_at, '2026-09-29');

  // a YAML document that is also valid JSON is still reported as YAML
  const ambiguous = await parseStructuredText('{"a": 1}', 'note.yaml', { parseYaml });
  assert.equal(ambiguous.format, 'yaml');

  // JSON stays JSON, JSON Lines stays JSON Lines
  assert.equal((await parseStructuredText('{"a": 1}', 'note.json', { parseYaml })).format, 'json');
  const jsonl = await parseStructuredText('{"a": 1}\n{"a": 2}', 'note.jsonl', { parseYaml });
  assert.equal(jsonl.format, 'jsonl');
  assert.equal(jsonl.value.length, 2);
  assert.match(jsonl.warnings.join(' '), /parsed 2 JSON Lines records/);
});

test('the non-YAML fallback is reported, exactly as the donor does', async () => {
  const fallback = await parseStructuredText(NESTED, 'note.txt', { parseYaml });
  assert.equal(fallback.format, 'yaml');
  assert.equal(fallback.warnings.length, 1);
  assert.match(fallback.warnings[0], /^JSON parsing failed \([\s\S]*\); parsed as YAML$/);
  assert.deepEqual(fallback.value.shelf.length, 2);

  // a JSON document never takes the fallback branch
  const json = await parseStructuredText('{"shelf": []}', 'note.txt', { parseYaml });
  assert.equal(json.format, 'json');
  assert.deepEqual(json.warnings, []);
});

test('invalid input fails closed with one reason that names both attempts', async () => {
  await assert.rejects(
    () => parseStructuredText('shelf: [trust, quality\nowner: operator', 'note.txt', { parseYaml }),
    (error) => {
      assert.equal(error.code, 'CORRUPT_INPUT');
      assert.match(error.message, /Not valid JSON or YAML: .+ \| .+/);
      return true;
    },
  );

  const yamlFile = await parseStructuredText('shelf: [trust, quality', 'note.yaml', { parseYaml }).catch((error) => error);
  assert.ok(yamlFile instanceof Error);
  assert.match(yamlFile.message, /Not valid YAML: /);
  assert.ok(!/Not valid JSON or YAML/.test(yamlFile.message), 'a .yaml file does not report a JSON attempt');

  const empty = await ingestStructured('   ', 'note.yaml', { parseYaml });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'CORRUPT_INPUT');
  assert.match(empty.reason, /empty/);

  const refused = await ingestStructured('a: [1, 2\nb: 3', 'note.yaml', { parseYaml });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'CORRUPT_INPUT');
  assert.match(refused.reason, /Not valid YAML: /);
  assert.equal(refused.declared.format, 'yaml', 'the declared format is still reported');
  assert.equal(refused.detail.line, 2, 'the parser line is carried through to the caller');
  assert.equal(typeof refused.detail.column, 'number');

  const multi = await ingestStructured('a: 1\n---\nb: 2\n', 'note.yaml', { parseYaml });
  assert.equal(multi.ok, false, 'a multi-document stream is refused rather than silently truncated');
  assert.match(multi.reason, /multiple documents/);
});

test('the seam is injected: the core works without the third-party parser present', async () => {
  const stub = async (text) => ({ ok: true, value: { stub: text.trim() }, warnings: ['parsed by the stub'] });
  const parsed = await parseStructuredText('anything: here', 'note.yaml', { parseYaml: stub });
  assert.equal(parsed.format, 'yaml');
  assert.deepEqual(parsed.value, { stub: 'anything: here' });
  assert.deepEqual(parsed.warnings, ['parsed by the stub']);

  const failing = async () => ({ ok: false, reason: 'stub refuses everything' });
  const refused = await ingestStructured('a: 1', 'note.yaml', { parseYaml: failing });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /stub refuses everything/);

  await assert.rejects(
    () => parseStructuredText('a: 1', 'note.yaml', {}),
    (error) => error.code === 'PARSER_UNAVAILABLE',
    'the core refuses to run without a parser rather than guessing',
  );
});

test('the intake is deterministic: sections, rendering and stats', async () => {
  const first = await ingestStructured(NESTED, 'note.yaml', { parseYaml });
  const second = await ingestStructured(NESTED, 'note.yaml', { parseYaml });
  assert.deepEqual(first, second, 'the same document produces the same report');
  assert.equal(first.ok, true);
  assert.equal(first.format, 'yaml');
  assert.ok(first.sections.length >= 3, 'the top-level keys become sections');
  assert.ok(first.sections.every((section) => typeof section.start === 'number' && typeof section.end === 'number'), 'sections carry offsets');
  assert.equal(first.rendered, renderStructured(first.value));
  assert.deepEqual(sectionsFromStructured(first.value, DEFAULT_TEXT_LIMITS).length, first.sections.length);
  assert.equal(first.stats.keys, 4, 'shelf, owner, enabled and reviewed_at');
  assert.equal(first.stats.arrays, 2, 'shelf and its tags array');
  assert.ok(first.stats.maxDepth >= 3);

  // a section cap is honoured rather than ignored
  const capped = await ingestStructured(NESTED, 'note.yaml', { parseYaml, limits: { maxSections: 1 } });
  assert.equal(capped.sections.length, 1);

  const verdict = await validateStructured(NESTED, 'note.yaml', { parseYaml });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.format, 'yaml');
  const refused = await validateStructured('a: [1', 'note.yaml', { parseYaml });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'CORRUPT_INPUT');
});

test('the room exposes the YAML intake surface', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const capabilities = await hub.api('GET', `${API}/capabilities`);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.payload.writes_files, false);
  assert.equal(capabilities.payload.donor.commit, DONOR_COMMIT);
  assert.deepEqual(capabilities.payload.donor.sourcePaths, ['electron/ingestion/text-parsers.ts']);
  assert.deepEqual(capabilities.payload.formats, ['json', 'jsonl', 'yaml']);
  assert.match(capabilities.payload.extension_rule, /parsed as YAML first and only/);
  assert.match(capabilities.payload.reuse.note, /never copies/);
  assert.equal(capabilities.payload.parser.package, 'yaml');
  assert.match(capabilities.payload.parser.resolvedFrom.replace(/\\/g, '/'), /\/city\/node_modules\//, 'the parser belongs to the city tree');
  assert.equal(capabilities.payload.parser.maxAliasCount, MAX_ALIAS_COUNT);
  assert.equal(capabilities.payload.parser.maxBytes, MAX_YAML_BYTES);
  assert.deepEqual(capabilities.payload.limits, DEFAULT_TEXT_LIMITS);

  const parsed = await hub.api('POST', `${API}/yaml/parse`, { text: NESTED, fileName: 'note.yaml' });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.payload.ok, true);
  assert.equal(parsed.payload.format, 'yaml');
  assert.deepEqual(parsed.payload.value.owner.contact, { channel: 'local', retries: 2 });
  assert.match(parsed.payload.rendered, /shelf:/);
  assert.ok(parsed.payload.sections.some((section) => section.heading === 'shelf'));

  const fallback = await hub.api('POST', `${API}/yaml/parse`, { text: NESTED, fileName: 'note.txt' });
  assert.equal(fallback.payload.format, 'yaml');
  assert.match(fallback.payload.warnings.join(' '), /parsed as YAML/);

  const refused = await hub.api('POST', `${API}/yaml/parse`, { text: 'a: [1, 2\nb: 3', fileName: 'note.yaml' });
  assert.equal(refused.status, 200, 'a refused document is a product answer, not a transport error');
  assert.equal(refused.payload.ok, false);
  assert.equal(refused.payload.code, 'CORRUPT_INPUT');

  const validated = await hub.api('POST', `${API}/yaml/validate`, { text: NESTED, fileName: 'note.yaml' });
  assert.equal(validated.payload.ok, true);

  const badPayload = await hub.api('POST', `${API}/yaml/parse`, { text: 42 });
  assert.equal(badPayload.status, 400);
  const badLimit = await hub.api('POST', `${API}/yaml/parse`, { text: 'a: 1', limits: { maxNope: 1 } });
  assert.equal(badLimit.status, 400);
  const badLimitValue = await hub.api('POST', `${API}/yaml/parse`, { text: 'a: 1', limits: { maxSections: -1 } });
  assert.equal(badLimitValue.status, 400);
});

test('the lab writes no runtime file and never imports the third-party parser itself', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await hub.api('POST', `${API}/yaml/parse`, { text: NESTED, fileName: 'note.yaml' });
  assert.deepEqual(await readdir(hub.runtimeDir), [], 'the lab has no durable file');

  const roomDir = join(import.meta.dirname, '..', 'rooms', 'yaml-intake-lab');
  for (const file of ['yaml-core.mjs', 'room.server.mjs', 'intake-bridge.mjs']) {
    const code = (await readFile(join(roomDir, file), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ["require('", 'from "app/', "from 'app/", 'writeFileSync']) {
      assert.ok(!code.includes(forbidden), `${file} must not ${forbidden}`);
    }
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
      assert.notEqual(specifier, 'yaml', `${file} must not import the parser directly`);
    }
  }
  // the renderer, splitter, limits and typed error come from the promoted city core
  const bridge = await readFile(join(roomDir, 'intake-bridge.mjs'), 'utf8');
  assert.match(bridge, /ingestion-core\/ingestion-core\.mjs/, 'the promoted core is reused');
  assert.match(bridge, /ingestion-core\/yaml-parser\.mjs/, 'the quarantined parser seam is reached through the bridge');
});
