/**
 * UTOPIA · City · Document Intake — YAML branch suite (D7a promotion).
 *
 * The structured-data order, the fallback warning, the deterministic rendering and
 * the fail-closed refusals restate the Codex-Boss donor
 * `electron/ingestion/text-parsers.ts` @ 8df428eaa437a409368401e95194e40266b83080.
 * The third-party parser stays behind `yaml-parser.mjs`; these tests assert both the
 * behaviour and the quarantine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_TEXT_LIMITS,
  STRUCTURED_FORMATS,
  YAML_EXTENSIONS,
  YAML_PACKAGE,
  detectFormat,
  ingestStructured,
  parseStructuredText,
  prefersYaml,
  renderStructured,
  sectionsFromStructured,
} from '../ingestion-core.mjs';
import { MAX_ALIAS_COUNT, MAX_YAML_BYTES, tryParseYaml, yamlParserProvenance } from '../yaml-parser.mjs';

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
].join('\n');

test('the extension decides the order, and the YAML branch is a real format now', () => {
  assert.deepEqual(YAML_EXTENSIONS, ['.yaml', '.yml']);
  assert.deepEqual(STRUCTURED_FORMATS, ['json', 'jsonl', 'yaml']);
  assert.equal(prefersYaml('note.yaml'), true);
  assert.equal(prefersYaml('note.YML'), true);
  assert.equal(prefersYaml('note.json'), false);
  assert.equal(detectFormat('config.yml').format, 'yaml');
  assert.equal(detectFormat('config.yml').deferred, undefined);
});

test('a .yaml document is parsed as YAML with nested maps and sequences', async () => {
  const parsed = await parseStructuredText(NESTED, 'note.yaml');
  assert.equal(parsed.format, 'yaml');
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.value.shelf, [
    { id: 'trust', level: 3, tags: ['review', 'quality'] },
    { id: 'memory', level: 2 },
  ]);
  assert.deepEqual(parsed.value.owner.contact, { channel: 'local', retries: 2 });

  // a YAML document that is also valid JSON is still reported as YAML
  assert.equal((await parseStructuredText('{"a": 1}', 'note.yaml')).format, 'yaml');
  // JSON stays JSON, JSON Lines stays JSON Lines
  assert.equal((await parseStructuredText('{"a": 1}', 'note.json')).format, 'json');
  const jsonl = await parseStructuredText('{"a": 1}\n{"a": 2}', 'note.jsonl');
  assert.equal(jsonl.format, 'jsonl');
  assert.match(jsonl.warnings.join(' '), /parsed 2 JSON Lines records/);
});

test('the non-YAML fallback is reported, exactly as the donor does', async () => {
  const fallback = await parseStructuredText(NESTED, 'note.txt');
  assert.equal(fallback.format, 'yaml');
  assert.match(fallback.warnings[0], /^JSON parsing failed \([\s\S]*\); parsed as YAML$/);
  const json = await parseStructuredText('{"shelf": []}', 'note.txt');
  assert.equal(json.format, 'json');
  assert.deepEqual(json.warnings, []);
});

test('invalid input fails closed with one reason and the parser detail', async () => {
  await assert.rejects(
    () => parseStructuredText('shelf: [trust, quality\nowner: operator', 'note.txt'),
    (error) => {
      assert.equal(error.code, 'CORRUPT_INPUT');
      assert.match(error.message, /Not valid JSON or YAML: .+ \| .+/);
      return true;
    },
  );

  const yamlFile = await parseStructuredText('shelf: [trust, quality', 'note.yaml').catch((error) => error);
  assert.ok(yamlFile instanceof Error);
  assert.match(yamlFile.message, /Not valid YAML: /);
  assert.ok(!/Not valid JSON or YAML/.test(yamlFile.message), 'a .yaml file does not report a JSON attempt');

  const refused = await ingestStructured('a: [1, 2\nb: 3', 'note.yaml');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'CORRUPT_INPUT');
  assert.equal(refused.detail.line, 2);
  assert.equal(typeof refused.detail.column, 'number');
  assert.equal(refused.declared.format, 'yaml');

  const empty = await ingestStructured('   ', 'note.yaml');
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /empty/);

  const multi = await ingestStructured('a: 1\n---\nb: 2\n', 'note.yaml');
  assert.equal(multi.ok, false, 'a multi-document stream is refused rather than truncated');
  assert.match(multi.reason, /multiple documents/);

  const bomb = ['base: &base [1,2,3]', 'list:', ...Array.from({ length: 200 }, () => '  - *base')].join('\n');
  const bounded = await ingestStructured(bomb, 'bomb.yaml');
  assert.equal(bounded.ok, false, 'an alias bomb is stopped by the alias ceiling');
  assert.match(bounded.reason, /alias/i);
});

test('the intake is deterministic, and every guard is real', async () => {
  const first = await ingestStructured(NESTED, 'note.yaml');
  const second = await ingestStructured(NESTED, 'note.yaml');
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  assert.equal(first.rendered, renderStructured(first.value));
  assert.equal(first.stats.keys, 3);
  assert.equal(first.stats.arrays, 2);
  assert.ok(first.stats.maxDepth >= 3);
  assert.deepEqual(sectionsFromStructured(first.value, DEFAULT_TEXT_LIMITS).length, first.sections.length);

  const capped = await ingestStructured(NESTED, 'note.yaml', { limits: { maxSections: 1 } });
  assert.equal(capped.sections.length, 1);

  const oversized = await tryParseYaml('a: 1\n'.repeat(2000), { maxBytes: 64 });
  assert.equal(oversized.ok, false);
  assert.match(oversized.reason, /above the .* byte limit/);
  assert.equal(MAX_YAML_BYTES, 4 * 1024 * 1024);
  assert.equal(MAX_ALIAS_COUNT, 100);

  // the seam's provenance is this building, and the package resolves from city/
  const provenance = yamlParserProvenance();
  assert.equal(provenance.package, YAML_PACKAGE);
  assert.match(provenance.resolvedFrom.replace(/\\/g, '/'), /\/city\/node_modules\//);
  assert.equal(provenance.quarantinedIn, 'city/09-planning-knowledge/02-document-intake/ingestion-core/yaml-parser.mjs');
});

test('the module never names the package outside the seam', async () => {
  const moduleDir = join(import.meta.dirname, '..');
  for (const file of ['ingestion-core.mjs', 'yaml-parser.mjs']) {
    const code = await readFile(join(moduleDir, file), 'utf8');
    if (file === 'yaml-parser.mjs') {
      assert.match(code, /import\(YAML_PACKAGE\)/, 'the seam loads the package');
      continue;
    }
    assert.ok(!code.includes('import(YAML_PACKAGE)'), 'the core never loads the package');
    assert.ok(!/const YAML_PACKAGE\s*=/.test(code), 'the core never declares the package name');
    assert.match(code, /from '\.\/yaml-parser\.mjs'/, 'the core works through the seam');
  }
});
