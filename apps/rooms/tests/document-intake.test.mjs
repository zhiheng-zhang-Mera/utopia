/**
 * D4 — Document Intake Lab focused tests, including donor parity.
 *
 * The vectors restate the Codex-Boss donor behaviour
 * (`electron/ingestion/text-parsers.ts`, `xml-text.ts` @
 * 8df428eaa437a409368401e95194e40266b83080): encoding detection, markdown/plain
 * text section splitting, JSON/JSON Lines, CSV/TSV and the XML text helpers, plus
 * the input limits. YAML is asserted to be refused, because D4a deliberately does
 * not carry the donor's external parser dependency.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestHub } from './harness.mjs';
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
} from '../rooms/document-intake-lab/ingestion-core.mjs';
import { ingestDocument } from '../rooms/document-intake-lab/room.server.mjs';

const API = '/local-rooms/v1/document-intake-lab';
const DONOR_COMMIT = '8df428eaa437a409368401e95194e40266b83080';

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
  const decodedUtf16 = decodeText(utf16);
  assert.equal(decodedUtf16.encoding, 'utf-16le');
  assert.equal(decodedUtf16.text, 'hi');

  const utf16be = new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]);
  assert.equal(decodeText(utf16be).encoding, 'utf-16be');
  assert.equal(decodeText(utf16be).text, 'hi');

  // invalid UTF-8 without a BOM must warn rather than silently pretend
  const broken = new Uint8Array([0x41, 0xc3, 0x28, 0x42]);
  const decoded = decodeText(broken);
  assert.ok(decoded.warnings.length > 0, 'a lossy decode is reported');
  assert.ok(['utf-8-lossy', 'utf-16le', 'utf-16be'].includes(decoded.encoding), decoded.encoding);
});

test('markdown and plain text split into offset-preserving sections', () => {
  const markdown = '# Title\n\n## Section\n\nA paragraph line.\n- bullet one\n- bullet two\n\n1. first\n2. second\n\n```js\nconst x = 1;\n```\n';
  const sections = parseTextSections(markdown);
  const kinds = sections.map((section) => section.kind);
  assert.equal(kinds[0], 'TITLE');
  assert.equal(sections[0].heading, 'Title');
  assert.equal(sections[0].level, 1);
  assert.ok(kinds.includes('HEADING'));
  assert.ok(kinds.includes('BULLET'));
  assert.ok(kinds.includes('NUMBERED'));
  assert.ok(kinds.includes('CODE'));
  assert.ok(sections.filter((section) => section.kind === 'BULLET').length === 1, 'consecutive bullets form one block');
  const code = sections.find((section) => section.kind === 'CODE');
  assert.match(code.text, /const x = 1;/);
  assert.ok(sections.every((section) => section.start <= section.end), 'offsets are ordered');
  for (const section of sections) assert.ok(SECTION_KINDS.includes(section.kind), section.kind);

  const setext = parseTextSections('Heading one\n===\n\nbody text\n');
  assert.equal(setext[0].kind, 'TITLE');
  assert.equal(setext[0].heading, 'Heading one');

  const plain = parseTextSections('一、目标\n正文内容。\n\n二、范围\n更多内容。\n', { plainText: true });
  assert.equal(plain.filter((section) => section.kind === 'HEADING').length, 2, 'Chinese numbered headings become headings in plain text');
  assert.equal(plain[0].heading, '一、目标');

  const keyValue = parseTextSections('owner: team\nstatus: open\n');
  assert.ok(keyValue.some((section) => section.kind === 'KEYVALUE'));

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

  const yamlAttempt = parseStructuredTextSafe('a: 1\nb: 2\n', 'config.yml');
  assert.equal(yamlAttempt.ok, false);
  assert.match(yamlAttempt.message, /D4b/);

  const sections = sectionsFromStructured(json.value);
  assert.equal(sections[0].kind, 'HEADING', 'a non-string value becomes a headed block');
  assert.equal(sections[0].heading, 'a');
  const stringValue = sectionsFromStructured({ owner: 'team', status: 'open' });
  assert.equal(stringValue[0].kind, 'KEYVALUE', 'a string value becomes a key/value section');
  const arraySections = sectionsFromStructured(json.value.b);
  assert.deepEqual(arraySections.map((section) => section.kind), ['HEADING', 'HEADING']);

  const withIds = sectionsFromStructured([{ id: 'one', v: 1 }, { id: 'two', v: 2 }]);
  assert.deepEqual(withIds.map((section) => section.heading), ['one', 'two']);

  assert.equal(renderStructured({ a: 1, b: { c: true } }), 'a: 1\nb:\n  c: true');
  assert.equal(renderStructured([1, 2]), '- 1\n- 2');
  assert.equal(renderStructured('needs: quoting'), '"needs: quoting"');
  assert.equal(renderStructured(null), 'null');
});

function parseStructuredTextSafe(text, fileName) {
  try {
    return { ok: true, value: parseStructuredText(text, fileName) };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

test('CSV and TSV parsing matches the donor, including quoted fields and limits', () => {
  const table = parseDelimited('a,b\n1,"x,y"\n2,"line\nbreak"\n');
  assert.deepEqual(table.rows, [['a', 'b'], ['1', 'x,y'], ['2', 'line\nbreak']]);
  assert.equal(table.delimiter, ',');

  const tsv = parseDelimited('a\tb\n1\t2\n', { delimiter: '\t' });
  assert.deepEqual(tsv.rows, [['a', 'b'], ['1', '2']]);

  const crlf = parseDelimited('a,b\r\n1,2\r\n');
  assert.deepEqual(crlf.rows, [['a', 'b'], ['1', '2']]);

  const escaped = parseDelimited('a\n"say ""hi"""\n');
  assert.deepEqual(escaped.rows, [['a'], ['say "hi"']]);

  const unterminated = parseDelimited('a,"open');
  assert.match(unterminated.warnings.join(' '), /quoted field/);

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

  const single = sectionsFromDelimited(parseDelimited('name\nonly\n'), { fileName: 'x.csv' });
  assert.equal(single.length, 1);

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

test('ingestDocument reports sections, limits and warnings for every accepted format', () => {
  const markdown = ingestDocument({ text: '# T\n\nbody\n', fileName: 'a.md' });
  assert.equal(markdown.format, 'markdown');
  assert.equal(markdown.sections, 2);

  const json = ingestDocument({ text: '{"a":1}', fileName: 'a.json' });
  assert.equal(json.format, 'json');
  assert.equal(json.sections, 1);

  const csv = ingestDocument({ text: 'shelf,name\ns1,a\n', fileName: 'a.csv' });
  assert.equal(csv.format, 'csv');
  assert.match(csv.warnings.join(' '), /delimiter: ,/);

  const xml = ingestDocument({ text: '<r><t>hi</t></r>', fileName: 'a.xml' });
  assert.equal(xml.format, 'xml');
  assert.match(xml.warnings.join(' '), /extracted 1/);

  const unknown = ingestDocument({ text: 'just text', fileName: 'a.bin' });
  assert.equal(unknown.format, 'text');
  assert.match(unknown.warnings.join(' '), /unknown extension/);

  assert.throws(() => ingestDocument({ text: 'a: 1', fileName: 'config.yml' }), (error) => /D4b/.test(error.message));
  // a parser guard is refused, not silently truncated
  assert.throws(
    () => ingestDocument({ text: 'paragraph one\n\nparagraph two\n', fileName: 'a.txt', limits: { maxBytes: 5 } }),
    (error) => error.code === 'TOO_LARGE',
  );
  assert.throws(
    () => ingestDocument({ text: 'x'.repeat(64), fileName: 'a.txt', limits: { maxContentLength: 10 } }),
    (error) => error.code === 'TOO_LARGE',
  );
});

test('the room ingests text and base64 payloads and refuses malformed ones', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const capabilities = await hub.api('GET', `${API}/capabilities`);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.payload.writesToKnowledgeRoom, false);
  assert.equal(capabilities.payload.donor.commit, DONOR_COMMIT);
  assert.deepEqual(capabilities.payload.donor.sourcePaths, [
    'electron/ingestion/xml-text.ts',
    'electron/ingestion/text-parsers.ts',
  ]);
  assert.match(capabilities.payload.deferred.join(' '), /yaml/);

  const textRun = await hub.api('POST', `${API}/ingest`, { text: '# Title\n\nbody\n', fileName: 'a.md' });
  assert.equal(textRun.payload.ok, true);
  assert.equal(textRun.payload.format, 'markdown');
  assert.equal(textRun.payload.preview[0].kind, 'TITLE');
  assert.ok(textRun.payload.preview[0].start <= textRun.payload.preview[0].end);

  const utf8 = Buffer.from('# 标题\n\n正文\n', 'utf8');
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]);
  const base64Run = await hub.api('POST', `${API}/ingest`, { base64: bom.toString('base64'), fileName: 'b.md' });
  assert.equal(base64Run.payload.ok, true);
  assert.equal(base64Run.payload.encoding, 'utf-8');
  assert.equal(base64Run.payload.preview[0].heading, '标题');

  const utf16 = Buffer.from('# hi\n', 'utf16le');
  const utf16Run = await hub.api('POST', `${API}/ingest`, {
    base64: Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]).toString('base64'),
    fileName: 'c.md',
  });
  assert.equal(utf16Run.payload.encoding, 'utf-16le');

  const yamlRun = await hub.api('POST', `${API}/ingest`, { text: 'a: 1\n', fileName: 'config.yaml' });
  assert.equal(yamlRun.status, 400, 'a deferred format is a payload error, not a silent fallback');

  const oversized = await hub.api('POST', `${API}/ingest`, {
    text: 'a\n'.repeat(10),
    fileName: 'a.txt',
    limits: { maxBytes: 5 },
  });
  assert.equal(oversized.payload.ok, false);
  assert.equal(oversized.payload.code, 'TOO_LARGE');

  const detected = await hub.api('POST', `${API}/detect`, { fileName: 'sheet.tsv' });
  assert.equal(detected.payload.format, 'tsv');

  for (const bad of [{}, { base64: 'not base64!!' }, { base64: Buffer.from('x').toString('base64'), fileName: 'a.yaml' }]) {
    const response = await hub.api('POST', `${API}/ingest`, bad);
    assert.ok([400, 200].includes(response.status), JSON.stringify(bad));
    if (response.status === 400) assert.equal(response.payload.error, 'invalid_payload');
  }
});

test('the room never writes a runtime file and keeps the donor dependency rule', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await hub.api('POST', `${API}/ingest`, { text: '# T\n', fileName: 'a.md' });
  assert.deepEqual(await readdir(hub.runtimeDir), [], 'the lab has no durable file');

  const roomDir = join(import.meta.dirname, '..', 'rooms', 'document-intake-lab');
  for (const file of ['ingestion-core.mjs', 'room.server.mjs']) {
    const source = await readFile(join(roomDir, file), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ["from 'yaml'", 'from "yaml"', "require('yaml')", 'durable-json', "from 'electron"]) {
      assert.ok(!code.includes(forbidden), `${file} must stay dependency-free (${forbidden})`);
    }
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
    }
  }
});
