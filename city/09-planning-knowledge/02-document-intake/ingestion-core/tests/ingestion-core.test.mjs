/**
 * City module tests — Ingestion Core
 * (city/09-planning-knowledge/02-document-intake/ingestion-core).
 *
 * Donor parity suite: the vectors restate the Codex-Boss donor behaviour
 * (`electron/ingestion/text-parsers.ts`, `xml-text.ts` @
 * 8df428eaa437a409368401e95194e40266b83080). The incubator room that produced
 * this module was removed from the tree once it was promoted here; see
 * apps/rooms/promotions/document-intake-lab.json. D4b (YAML) is asserted to be
 * deliberately absent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TEXT_LIMITS,
  SECTION_KINDS,
  TextParseError,
  decodeText,
  detectDelimiter,
  detectFormat,
  extractTextRuns,
  matchBlocks,
  parseDelimited,
  parseStructuredText,
  parseTextSections,
  parseXmlText,
  renderStructured,
  sectionsFromDelimited,
  sectionsFromStructured,
  unescapeXml,
} from '../ingestion-core.mjs';

const encoder = new TextEncoder();

test('encoding detection follows BOMs, validates UTF-8 and refuses to guess silently', () => {
  const utf8 = decodeText(encoder.encode('plain ascii'));
  assert.equal(utf8.encoding, 'utf-8');
  assert.equal(utf8.text, 'plain ascii');
  assert.deepEqual(utf8.warnings, []);

  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('bom text')]);
  assert.equal(decodeText(withBom).encoding, 'utf-8');
  assert.equal(decodeText(withBom).text, 'bom text');

  const utf16 = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
  assert.equal(decodeText(utf16).encoding, 'utf-16le');
  assert.equal(decodeText(utf16).text, 'hi');

  const utf16be = new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]);
  assert.equal(decodeText(utf16be).encoding, 'utf-16be');
  assert.equal(decodeText(utf16be).text, 'hi');

  const broken = new Uint8Array([0x41, 0xc3, 0x28, 0x42]);
  const decoded = decodeText(broken);
  assert.ok(decoded.warnings.length > 0, 'a lossy decode is reported');
  assert.ok(['utf-8-lossy', 'utf-16le', 'utf-16be'].includes(decoded.encoding), decoded.encoding);
});

test('markdown and plain text split into offset-preserving sections', () => {
  const markdown = '# Title\n\n## Section\n\nA paragraph line.\n- bullet one\n- bullet two\n\n1. first\n2. second\n\n```js\nconst x = 1;\n```\n';
  const sections = parseTextSections(markdown);
  assert.equal(sections[0].kind, 'TITLE');
  assert.equal(sections[0].heading, 'Title');
  assert.equal(sections[0].level, 1);
  assert.equal(sections.filter((section) => section.kind === 'BULLET').length, 1, 'consecutive bullets form one block');
  assert.match(sections.find((section) => section.kind === 'CODE').text, /const x = 1;/);
  assert.ok(sections.every((section) => section.start <= section.end), 'offsets are ordered');
  for (const section of sections) assert.ok(SECTION_KINDS.includes(section.kind), section.kind);

  const setext = parseTextSections('Heading one\n===\n\nbody text\n');
  assert.equal(setext[0].kind, 'TITLE');
  assert.equal(setext[0].heading, 'Heading one');

  const plain = parseTextSections('一、目标\n正文内容。\n\n二、范围\n更多内容。\n', { plainText: true });
  assert.equal(plain.filter((section) => section.kind === 'HEADING').length, 2, 'Chinese numbered headings in plain text');
  assert.equal(plain[0].heading, '一、目标');

  assert.ok(parseTextSections('owner: team\nstatus: open\n').some((section) => section.kind === 'KEYVALUE'));
  assert.throws(() => parseTextSections('x'.repeat(50), { limits: { maxBytes: 10 } }), TextParseError);
});

test('JSON, JSON Lines and structured sections match the donor', () => {
  const json = parseStructuredText('{"a":1,"b":["x","y"]}', 'data.json');
  assert.equal(json.format, 'json');
  assert.deepEqual(json.value, { a: 1, b: ['x', 'y'] });

  const jsonl = parseStructuredText('{"a":1}\n{"a":2}', 'data.jsonl');
  assert.equal(jsonl.format, 'jsonl');
  assert.equal(jsonl.value.length, 2);
  assert.match(jsonl.warnings.join(' '), /2 JSON Lines records/);

  assert.throws(() => parseStructuredText('   ', 'x.json'), TextParseError);
  assert.throws(() => parseStructuredText('# heading only', 'notes.md'), TextParseError);

  const yamlAttempt = (() => {
    try {
      return { ok: true, value: parseStructuredText('a: 1\nb: 2\n', 'config.yml') };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  })();
  assert.equal(yamlAttempt.ok, false, 'YAML is deferred, not guessed');
  assert.match(yamlAttempt.message, /D4b/);

  const sections = sectionsFromStructured(json.value);
  assert.equal(sections[0].kind, 'HEADING');
  assert.equal(sections[0].heading, 'a');
  assert.equal(sectionsFromStructured({ owner: 'team' })[0].kind, 'KEYVALUE', 'a string value becomes a key/value section');
  assert.deepEqual(sectionsFromStructured(json.value.b).map((section) => section.kind), ['HEADING', 'HEADING']);
  assert.deepEqual(sectionsFromStructured([{ id: 'one' }, { id: 'two' }]).map((section) => section.heading), ['one', 'two']);

  assert.equal(renderStructured({ a: 1, b: { c: true } }), 'a: 1\nb:\n  c: true');
  assert.equal(renderStructured([1, 2]), '- 1\n- 2');
  assert.equal(renderStructured('needs: quoting'), '"needs: quoting"');
  assert.equal(renderStructured(null), 'null');
});

test('CSV and TSV parsing matches the donor, including quoted fields and limits', () => {
  const table = parseDelimited('a,b\n1,"x,y"\n2,"line\nbreak"\n');
  assert.deepEqual(table.rows, [['a', 'b'], ['1', 'x,y'], ['2', 'line\nbreak']]);
  assert.equal(table.delimiter, ',');
  assert.deepEqual(parseDelimited('a\tb\n1\t2\n', { delimiter: '\t' }).rows, [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseDelimited('a,b\r\n1,2\r\n').rows, [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseDelimited('a\n"say ""hi"""\n').rows, [['a'], ['say "hi"']]);
  assert.match(parseDelimited('a,"open').warnings.join(' '), /quoted field/);

  const bounded = parseDelimited('h\n1\n2\n3\n', { limits: { maxCsvRows: 2 } });
  assert.ok(bounded.rows.length <= 3, JSON.stringify(bounded.rows));
  assert.match(bounded.warnings.join(' '), /row limit 2/);

  assert.equal(detectDelimiter('a,b', 'x.csv'), ',');
  assert.equal(detectDelimiter('a\tb', 'x.tsv'), '\t');
  assert.equal(detectDelimiter('a\tb\nc\td', 'unknown.txt'), '\t');
  assert.equal(detectDelimiter('a|b|c', 'unknown.txt'), '|');

  const grouped = sectionsFromDelimited(parseDelimited('shelf,name\ns1,a\ns1,b\ns2,c\n'), { fileName: 'x.csv' });
  assert.deepEqual(grouped.map((section) => section.heading), ['s1', 's2'], 'rows group by the first column label');
  assert.ok(grouped.every((section) => section.kind === 'TABLE'));
  assert.equal(sectionsFromDelimited(parseDelimited('name\nonly\n'), { fileName: 'x.csv' }).length, 1);
  const capped = sectionsFromDelimited(parseDelimited('a,b,c,d\n1,2,3,4\n'), { fileName: 'x.csv', maxColumns: 2 });
  assert.ok(capped[0].text.split('\n')[0].split('|').length <= 4, capped[0].text);
});

test('XML helpers decode entities and extract text runs exactly once', () => {
  assert.equal(unescapeXml('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'), 'a & b <c> "d" \'e\'');
  assert.equal(unescapeXml('&#65;&#x42;'), 'AB');
  assert.equal(unescapeXml('&unknown; &#x110000;'), '&unknown; &#x110000;', 'invalid entities are left alone');
  assert.equal(unescapeXml('&amp;amp;'), '&amp;', 'entities decode exactly once');

  const xml = '<root><t>First</t><t>Second &amp; third</t></root>';
  assert.deepEqual(matchBlocks(xml, 't'), ['<t>First</t>', '<t>Second &amp; third</t>']);
  assert.equal(extractTextRuns('<t>A</t><t>B</t>'), 'AB');

  const parsed = parseXmlText(xml);
  assert.equal(parsed.textRuns, 2);
  assert.equal(parsed.sections[0].text, 'First');
  assert.equal(parsed.sections[1].text, 'Second & third');
  assert.throws(() => parseXmlText('not markup'), TextParseError);
});

test('format detection names the parser and marks deferred formats honestly', () => {
  assert.equal(detectFormat('notes.md').format, 'markdown');
  assert.equal(detectFormat('notes.txt').format, 'text');
  assert.equal(detectFormat('data.json').format, 'json');
  assert.equal(detectFormat('data.jsonl').format, 'jsonl');
  assert.equal(detectFormat('table.csv').format, 'csv');
  assert.equal(detectFormat('table.tsv').format, 'tsv');
  assert.equal(detectFormat('markup.xml').format, 'xml');
  const yaml = detectFormat('config.yml');
  assert.equal(yaml.format, 'yaml');
  assert.match(yaml.deferred, /D4b/);
  assert.equal(detectFormat('archive.zip').format, 'unknown');
  assert.equal(DEFAULT_TEXT_LIMITS.maxSections, 4000);
});

test('the module is dependency-free: no YAML parser, no donor checkout', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const moduleDir = join(import.meta.dirname, '..');

  async function walk(directory) {
    const found = [];
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.name === 'tests') continue;
      const absolute = join(directory, item.name);
      if (item.isDirectory()) found.push(...(await walk(absolute)));
      else if (item.name.endsWith('.mjs')) found.push(absolute);
    }
    return found;
  }

  const files = await walk(moduleDir);
  assert.ok(files.length >= 1);
  for (const file of files) {
    const code = (await readFile(file, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ["from 'yaml'", 'from "yaml"', "require('yaml')", "from 'electron", 'from "electron']) {
      assert.ok(!code.includes(forbidden), `${file} must stay dependency-free (${forbidden})`);
    }
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
    }
  }
});

test('provenance stays honest: DONOR.json pins the donor and records the deferral', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const donor = JSON.parse(await readFile(join(import.meta.dirname, '..', 'DONOR.json'), 'utf8'));
  assert.equal(donor.repository, 'zhiheng-zhang-Mera/Codex-Boss');
  assert.equal(donor.commit, '8df428eaa437a409368401e95194e40266b83080');
  assert.equal(donor.cityPath, 'city/09-planning-knowledge/02-document-intake/ingestion-core');
  assert.equal(donor.room, 'document-intake-lab');
  assert.deepEqual(donor.sourcePaths, ['electron/ingestion/xml-text.ts', 'electron/ingestion/text-parsers.ts']);
  assert.match(donor.deferred.join(' '), /yaml/i);
  assert.ok(donor.adaptation.length >= 3);
  assert.ok(donor.parity.vectors.length >= 8);
});
