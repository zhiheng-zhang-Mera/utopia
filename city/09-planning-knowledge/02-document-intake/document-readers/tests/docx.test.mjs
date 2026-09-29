/**
 * UTOPIA · City · Document Intake — DOCX adapter suite (D7b promotion).
 *
 * The adapter is a boundary, not a parser: byte/paragraph/character guards, typed
 * fail-closed errors, and two injectable converter seams that stand in for the city
 * tree's mammoth engine. These tests load both seams, then load the real engine
 * through the seam with a synthetic (but genuinely zipped) .docx.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { loadFflate } from '../engines.mjs';
import {
  DEFAULT_DOCX_LIMITS,
  DocxError,
  extractDocx,
  extractDocxHtml,
  paragraphsFromText,
  setDocxConverter,
  setDocxHtmlConverter,
} from '../docx.mjs';

const MODULE_URL = new URL('../docx.mjs', import.meta.url);

/** A payload that passes the ZIP signature gate without being a real archive. */
const PK_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);

/* ---------------------------------------------- synthetic DOCX (a real ZIP) */

/*
 * The bridge exposes only `unzipSync()` (there is no `zipSync()` in the seam), so the
 * archive is written here with node:zlib and then decoded for real through
 * `loadFflate().unzipSync()` before mammoth ever sees it.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** Minimal ZIP writer (deflate entries) — enough for a DOCX container. */
function buildZip(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = encoder.encode(name);
    const raw = encoder.encode(text);
    const deflated = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    Buffer.from(nameBytes).copy(local, 30);
    chunks.push(local, deflated);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); // deflate
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    Buffer.from(nameBytes).copy(central, 46);
    centralParts.push(central);
    offset += local.length + deflated.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, ...centralParts, end]));
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const CONTENT_TYPES =
  `${XML_HEAD}\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
  '</Types>';

const ROOT_RELS =
  `${XML_HEAD}\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

const DOCUMENT_RELS =
  `${XML_HEAD}\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
  '</Relationships>';

const STYLES =
  `${XML_HEAD}\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>' +
  '</w:styles>';

const NUMBERING =
  `${XML_HEAD}\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/></w:lvl></w:abstractNum>' +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
  '</w:numbering>';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const DOCUMENT =
  `${XML_HEAD}\n<w:document xmlns:w="${W}"><w:body>` +
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Section One</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Sub Section</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>Utopia intake</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>bullet one</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>bullet two</w:t></w:r></w:p>' +
  '<w:sectPr/></w:body></w:document>';

/** A real, minimal, mammoth-readable .docx built in memory. */
function syntheticDocx() {
  return buildZip([
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', ROOT_RELS],
    ['word/document.xml', DOCUMENT],
    ['word/_rels/document.xml.rels', DOCUMENT_RELS],
    ['word/styles.xml', STYLES],
    ['word/numbering.xml', NUMBERING],
  ]);
}

/* ------------------------------------------------------------------- tests */

test('default limits and typed error match the donor', () => {
  assert.deepEqual(DEFAULT_DOCX_LIMITS, {
    maxBytes: 64 * 1024 * 1024,
    maxParagraphs: 20000,
    maxCharacters: 2000000,
  });
  assert.ok(Object.isFrozen(DEFAULT_DOCX_LIMITS));
  const error = new DocxError('TOO_LARGE', 'too big');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'DocxError');
  assert.equal(error.code, 'TOO_LARGE');
  assert.equal(error.message, 'too big');
});

test('converter seam extracts, splits paragraphs, maps headings/bullets and truncates', async () => {
  const seen = [];
  const text = '# Title\n\nbody text\u00ad\n- bullet one\n1) numbered\n[x] task\n### Deep   \n';
  setDocxConverter(async (bytes, limits) => {
    seen.push({ bytes, limits });
    return { text, messages: [] };
  });
  try {
    const result = await extractDocx(PK_BYTES, { maxParagraphs: 1000 });
    assert.deepEqual(result.paragraphs, [
      // The donor keeps the ATX marker in the text and only records the level.
      { text: '# Title', headingLevel: 1 },
      { text: 'body text' },
      { text: 'bullet one', listItem: true },
      { text: 'numbered', listItem: true },
      { text: 'task', listItem: true },
      { text: '### Deep', headingLevel: 3 },
    ]);
    assert.equal(result.warnings.length, 0);
    // The seam receives the caller's bytes and the merged effective limits.
    assert.equal(seen.length, 1);
    assert.equal(seen[0].bytes, PK_BYTES);
    assert.deepEqual(seen[0].limits, { ...DEFAULT_DOCX_LIMITS, maxParagraphs: 1000 });

    // The paragraph cap wins first: two paragraphs survive, the rest are cut.
    const byParagraphs = await extractDocx(PK_BYTES, { maxParagraphs: 2, maxCharacters: 100 });
    assert.equal(byParagraphs.paragraphs.length, 2);
    assert.deepEqual(
      byParagraphs.warnings,
      ['document exceeded the 2-paragraph / 100-character budget and was truncated'],
    );

    // The character cap counts each line as the donor counts it (before stripping),
    // and a line that lands exactly on the budget is still accepted.
    const byCharacters = await extractDocx(PK_BYTES, { maxCharacters: 16 });
    assert.deepEqual(byCharacters.paragraphs, [{ text: '# Title', headingLevel: 1 }, { text: 'body text' }]);
    assert.deepEqual(
      byCharacters.warnings,
      ['document exceeded the 20000-paragraph / 16-character budget and was truncated'],
    );

    // An empty conversion reports the donor's no-reader-paragraph warning.
    setDocxConverter(async () => ({ text: '\n\n  \n', messages: [{ type: 'warning', message: 'thin body' }] }));
    const empty = await extractDocx(PK_BYTES);
    assert.deepEqual(empty.paragraphs, []);
    assert.deepEqual(empty.warnings, ['warning: thin body', 'no readable paragraph was found in the document body']);
  } finally {
    setDocxConverter(undefined);
  }
});

test('html converter seam maps h1..h6 and list items, and truncates on its own budget', async () => {
  const html =
    '<h1>Title &amp; Co</h1><p>Body   text</p><ul><li>first</li><li>second</li></ul><h3>Deep</h3><p>last</p>';
  setDocxHtmlConverter(async (bytes, limits) => {
    assert.equal(bytes, PK_BYTES);
    assert.equal(limits.maxBytes, DEFAULT_DOCX_LIMITS.maxBytes);
    return { html, messages: [] };
  });
  try {
    const result = await extractDocxHtml(PK_BYTES);
    assert.deepEqual(result.paragraphs, [
      { text: 'Title & Co', headingLevel: 1 },
      { text: 'Body text' },
      { text: 'first', listItem: true },
      { text: 'second', listItem: true },
      { text: 'Deep', headingLevel: 3 },
      { text: 'last' },
    ]);
    assert.deepEqual(result.warnings, []);

    // The HTML pass checks whole blocks (tags included) but accrues only the text
    // length, so 30 rejects the third block while the first two still fit.
    const capped = await extractDocxHtml(PK_BYTES, { maxCharacters: 30 });
    assert.deepEqual(capped.paragraphs, [
      { text: 'Title & Co', headingLevel: 1 },
      { text: 'Body text' },
    ]);
    assert.deepEqual(
      capped.warnings,
      ['document exceeded the 20000-paragraph / 30-character budget and was truncated'],
    );
  } finally {
    setDocxHtmlConverter(undefined);
  }
});

test('guards fail closed before any converter runs', async () => {
  let calls = 0;
  const tripwire = async () => {
    calls += 1;
    throw new Error('the converter must not run for rejected bytes');
  };
  setDocxConverter(tripwire);
  setDocxHtmlConverter(tripwire);
  try {
    const oversized = new Uint8Array(16);
    oversized.set([0x50, 0x4b]);
    await assert.rejects(
      () => extractDocx(oversized, { maxBytes: 8 }),
      (error) => error instanceof DocxError && error.code === 'TOO_LARGE'
        && error.message === 'DOCX is 16 bytes, above the 8-byte limit',
    );
    await assert.rejects(
      () => extractDocxHtml(oversized, { maxBytes: 8 }),
      (error) => error.code === 'TOO_LARGE',
    );

    await assert.rejects(
      () => extractDocx(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])),
      (error) => error instanceof DocxError && error.code === 'NOT_DOCX'
        && error.name === 'DocxError'
        && error.message === 'Missing ZIP container signature (PK)',
    );
    await assert.rejects(
      () => extractDocxHtml(new Uint8Array([0x50, 0x00, 0x03, 0x04])),
      (error) => error.code === 'NOT_DOCX',
    );

    await assert.rejects(
      () => extractDocx(new Uint8Array(0)),
      (error) => error.code === 'NOT_DOCX' && error.message === 'DOCX is empty',
    );
    assert.equal(calls, 0);
  } finally {
    setDocxConverter(undefined);
    setDocxHtmlConverter(undefined);
  }
});

test('a ZIP that is not a DOCX is CORRUPT_DOCX, not a crash', async () => {
  const notADocx = buildZip([['readme.txt', 'this is a zip but not a docx']]);
  await assert.rejects(
    () => extractDocx(notADocx),
    (error) => error instanceof DocxError && error.code === 'CORRUPT_DOCX'
      && error.message.startsWith('mammoth could not read the document:'),
  );
  await assert.rejects(
    () => extractDocxHtml(notADocx),
    (error) => error instanceof DocxError && error.code === 'CORRUPT_DOCX'
      && error.message.startsWith('mammoth could not convert the document:'),
  );
});

test('real engine: mammoth parses the synthetic DOCX through the bridge', async () => {
  const bytes = syntheticDocx();

  // The container is a genuine ZIP: the seam's own decoder reads all six parts.
  const fflate = await loadFflate();
  assert.deepEqual(Object.keys(fflate.unzipSync(bytes)).sort(), [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/_rels/document.xml.rels',
    'word/document.xml',
    'word/numbering.xml',
    'word/styles.xml',
  ]);

  const plain = await extractDocx(bytes);
  assert.deepEqual(plain.paragraphs, [
    { text: 'Section One' },
    { text: 'Sub Section' },
    { text: 'Utopia intake' },
    { text: 'bullet one' },
    { text: 'bullet two' },
  ]);
  assert.deepEqual(plain.warnings, []);

  const structured = await extractDocxHtml(bytes);
  assert.deepEqual(structured.paragraphs, [
    { text: 'Section One', headingLevel: 1 },
    { text: 'Sub Section', headingLevel: 2 },
    { text: 'Utopia intake' },
    { text: 'bullet one', listItem: true },
    { text: 'bullet two', listItem: true },
  ]);
  assert.deepEqual(structured.warnings, []);

  // Determinism: the same bytes convert to the same structure twice over.
  assert.deepEqual(await extractDocx(bytes), plain);
  assert.deepEqual(await extractDocxHtml(bytes), structured);
});

test('paragraph splitting counts characters and paragraphs exactly as the donor', () => {
  assert.deepEqual(paragraphsFromText('a\n\n b \nsentence\u00ad\n', { maxParagraphs: 10, maxCharacters: 100 }), {
    paragraphs: [{ text: 'a' }, { text: 'b' }, { text: 'sentence' }],
    truncated: false,
  });
  assert.deepEqual(paragraphsFromText('a\nb\nc', { maxParagraphs: 2, maxCharacters: 100 }), {
    paragraphs: [{ text: 'a' }, { text: 'b' }],
    truncated: true,
  });
  assert.deepEqual(paragraphsFromText('abcdef\ngh', { maxParagraphs: 10, maxCharacters: 7 }), {
    paragraphs: [{ text: 'abcdef' }],
    truncated: true,
  });
});

test('quarantine: docx.mjs imports only the engine seam and node: builtins', async () => {
  const source = await readFile(MODULE_URL, 'utf8');
  assert.ok(!source.startsWith('\ufeff'), 'docx.mjs must be UTF-8 without a BOM');
  assert.ok(!source.includes('\r\n'), 'docx.mjs must use LF line endings');

  const specifiers = [...source.matchAll(/^import\s[^'"]*from\s*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
  assert.deepEqual(specifiers, ['./engines.mjs']);
  for (const specifier of specifiers) {
    assert.ok(specifier === './engines.mjs' || specifier.startsWith('node:'), `unexpected import ${specifier}`);
  }

  // Comments may name mammoth; code may not. Strip them and inspect what executes.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(!/require\s*\(/.test(code), 'docx.mjs must not use require()');
  assert.ok(!/\bimport\s*\(/.test(code), 'docx.mjs must not use a dynamic import');
  assert.ok(!/['"]mammoth['"]/.test(code), 'docx.mjs must not name the mammoth module specifier');
  assert.ok(code.includes("import { loadMammoth } from './engines.mjs';"), 'the mammoth engine is reached through the seam');
});
