/**
 * Room D7b — Document Readers Lab: focused XLSX adapter tests.
 *
 * The workbook is assembled in memory as a real OOXML package (fflate deflates the
 * parts, exactly as `samples.mjs` does), so the reader is exercised through its real
 * decode path and no binary fixture can rot in the repository. The builder is the
 * donor's `tests/fixtures/workbook-fixtures.ts` idea, reduced to the synthetic XLSX
 * this suite needs.
 *
 * Donor: zhiheng-zhang-Mera/Codex-Boss @ 8df428eaa437a409368401e95194e40266b83080
 *        electron/ingestion/xlsx-reader.ts, tests/fixtures/workbook-fixtures.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadFflate } from '../rooms/document-readers-lab/engine-bridge.mjs';
import {
  DEFAULT_XLSX_LIMITS,
  XlsxError,
  extractXlsx,
  readArchiveEntries,
} from '../rooms/document-readers-lab/xlsx.mjs';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Deflates the parts with the engine the reader itself uses, through the bridge. */
async function zip(entries) {
  const { zipSync, strToU8 } = await loadFflate();
  const input = {};
  for (const [name, content] of Object.entries(entries)) {
    input[name] = typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(input);
}

/**
 * The five parts of a minimal workbook, with caller-supplied `<sheetData>` bodies.
 * Worksheet parts are named `sheet1.xml`, `sheet2.xml`, ... in body order.
 */
async function buildWorkbook(sheetBodies, { names = [], sharedStrings = [] } = {}) {
  const sheetNames = sheetBodies.map((_, index) => names[index] ?? `Sheet${index + 1}`);
  const workbookSheets = sheetNames
    .map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('');
  const workbookRels = sheetNames
    .map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join('') + '<Relationship Id="rIdShared" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>';

  const entries = {
    '[Content_Types].xml': `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    'xl/workbook.xml': `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRels}</Relationships>`,
    'xl/sharedStrings.xml': `${XML_HEADER}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedStrings.map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`).join('')}</sst>`,
  };
  sheetBodies.forEach((body, index) => {
    entries[`xl/worksheets/sheet${index + 1}.xml`] = `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  });
  return zip(entries);
}

/** Ported `buildXlsx`: row-major values, strings become shared strings, numbers stay numeric. */
async function buildXlsx(sheets) {
  const sharedStrings = [];
  const sharedIndex = new Map();
  const indexFor = (value) => {
    const existing = sharedIndex.get(value);
    if (existing !== undefined) return existing;
    const index = sharedStrings.length;
    sharedStrings.push(value);
    sharedIndex.set(value, index);
    return index;
  };
  const columnName = (index) => {
    let value = index + 1;
    let name = '';
    while (value > 0) {
      const remainder = (value - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      value = Math.floor((value - 1) / 26);
    }
    return name;
  };

  const bodies = sheets.map((sheet) => sheet.rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
      if (typeof value === 'number') return `<c r="${reference}"><v>${value}</v></c>`;
      return `<c r="${reference}" t="s"><v>${indexFor(value)}</v></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join(''));

  return buildWorkbook(bodies, { names: sheets.map((sheet) => sheet.name), sharedStrings });
}

const SUMMARY = [{ name: 'Summary', rows: [['Region', 'Amount'], ['North', 1200], ['South', 900]] }];

test('a sheet with shared strings extracts the expected rows, part and used range', async () => {
  const extraction = await extractXlsx(await buildXlsx(SUMMARY));

  assert.equal(extraction.sheets.length, 1);
  const [sheet] = extraction.sheets;
  assert.equal(sheet.name, 'Summary');
  assert.equal(sheet.part, 'xl/worksheets/sheet1.xml');
  assert.deepEqual(sheet.rows, [['Region', 'Amount'], ['North', '1200'], ['South', '900']]);
  assert.deepEqual(sheet.usedRange, { rows: 3, columns: 2 });
  assert.deepEqual(extraction.warnings, []);
});

test('the markdown rendering is a real table with a header row and a separator row', async () => {
  const { markdown } = await extractXlsx(await buildXlsx(SUMMARY));

  assert.equal(markdown, [
    '### Summary',
    '',
    '| Region | Amount |',
    '| --- | --- |',
    '| North | 1200 |',
    '| South | 900 |',
  ].join('\n'));
  assert.match(markdown, /^### Summary$/m);
  assert.match(markdown, /^\| Region \| Amount \|$/m);
  assert.match(markdown, /^\| --- \| --- \|$/m);
});

test('the synthetic package is a real ZIP the engine itself can open', async () => {
  const bytes = await buildXlsx(SUMMARY);
  const { unzipSync } = await loadFflate();
  const raw = unzipSync(bytes);
  assert.deepEqual(Object.keys(raw).sort(), [
    '[Content_Types].xml',
    'xl/_rels/workbook.xml.rels',
    'xl/sharedStrings.xml',
    'xl/workbook.xml',
    'xl/worksheets/sheet1.xml',
  ]);

  const entries = await readArchiveEntries(bytes);
  assert.deepEqual(Object.keys(entries).sort(), Object.keys(raw).sort());
  assert.deepEqual(entries['xl/workbook.xml'], raw['xl/workbook.xml']);
});

test('a formula without a cached value warns and is never given an invented result', async () => {
  const bytes = await buildWorkbook([
    '<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2"><f>SUM(B1:B2)</f></c></row>',
  ], { names: ['Calc'], sharedStrings: ['Total'] });

  const extraction = await extractXlsx(bytes);
  const rows = extraction.sheets[0].rows;
  assert.deepEqual(rows, [['Total'], ['=SUM(B1:B2)']]);
  assert.deepEqual(extraction.warnings, ['a formula cell (A2) had no cached value; emitted the formula text']);
  // The formula text is reported as such; no numeric result is invented for it.
  assert.equal(rows[1][0], '=SUM(B1:B2)');
  assert.ok(Number.isNaN(Number(rows[1][0])));
});

test('two extractions of the same bytes are deeply equal', async () => {
  const bytes = await buildXlsx(SUMMARY);
  const first = await extractXlsx(bytes);
  const second = await extractXlsx(bytes);
  assert.deepEqual(first, second);
  assert.equal(first.markdown, second.markdown);
  assert.deepEqual(await readArchiveEntries(bytes), await readArchiveEntries(bytes));
});

test('sheets beyond limits.maxSheets are reported, not silently dropped', async () => {
  const bytes = await buildXlsx([
    { name: 'First', rows: [['a']] },
    { name: 'Second', rows: [['b']] },
  ]);
  const extraction = await extractXlsx(bytes, { maxSheets: 1 });
  assert.equal(extraction.sheets.length, 1);
  assert.equal(extraction.sheets[0].name, 'First');
  assert.deepEqual(extraction.warnings, ['sheet limit 1 reached; extra sheets were not read']);
});

test('a payload that is not a ZIP fails closed as NOT_XLSX (a truncated one as CORRUPT_XLSX)', async () => {
  await assert.rejects(() => extractXlsx(new Uint8Array([0x25, 0x50, 0x44, 0x46])), (error) => {
    assert.ok(error instanceof XlsxError);
    assert.equal(error.name, 'XlsxError');
    assert.equal(error.code, 'NOT_XLSX');
    assert.equal(error.message, 'Missing ZIP container signature (PK)');
    return true;
  });
  await assert.rejects(() => extractXlsx(new Uint8Array(0)), (error) => {
    assert.equal(error.code, 'NOT_XLSX');
    assert.equal(error.message, 'XLSX is empty');
    return true;
  });
  // A truncated container is a document problem, not an installation problem, so it
  // must not be reported as NOT_XLSX.
  await assert.rejects(() => extractXlsx(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8])), (error) => {
    assert.equal(error.code, 'CORRUPT_XLSX');
    assert.match(error.message, /^Archive could not be decompressed: /);
    return true;
  });
});

test('an archive above limits.maxEntries or limits.maxBytes fails closed as TOO_LARGE', async () => {
  const bytes = await buildXlsx(SUMMARY);
  const entries = await readArchiveEntries(bytes);
  const count = Object.keys(entries).length;

  await assert.rejects(() => readArchiveEntries(bytes, { maxEntries: count - 1 }), (error) => {
    assert.ok(error instanceof XlsxError);
    assert.equal(error.code, 'TOO_LARGE');
    assert.equal(error.message, `Archive has ${count} entries, above the ${count - 1}-entry limit`);
    return true;
  });
  await assert.rejects(() => readArchiveEntries(bytes, { maxBytes: 10 }), (error) => {
    assert.equal(error.code, 'TOO_LARGE');
    assert.equal(error.message, `XLSX is ${bytes.byteLength} bytes, above the 10-byte limit`);
    return true;
  });
});

test('an entry expanding above limits.maxEntryBytes fails closed as TOO_LARGE', async () => {
  const bytes = await buildWorkbook([
    `<row r="1"><c r="A1" t="inlineStr"><is><t>${'x'.repeat(4096)}</t></is></c></row>`,
  ], { names: ['Big'] });
  const size = (await readArchiveEntries(bytes))['xl/worksheets/sheet1.xml'].byteLength;
  assert.ok(size > 2048);

  await assert.rejects(() => readArchiveEntries(bytes, { maxEntryBytes: 2048 }), (error) => {
    assert.equal(error.code, 'TOO_LARGE');
    assert.equal(error.message, `Entry xl/worksheets/sheet1.xml expands to ${size} bytes, above the 2048-byte limit`);
    return true;
  });
});

test('DEFAULT_XLSX_LIMITS carries the donor pin and is frozen', () => {
  assert.deepEqual(DEFAULT_XLSX_LIMITS, {
    maxBytes: 64 * 1024 * 1024,
    maxEntries: 4096,
    maxEntryBytes: 32 * 1024 * 1024,
    maxTotalBytes: 128 * 1024 * 1024,
    maxSheets: 50,
    maxRowsPerSheet: 5000,
    maxColumns: 256,
  });
  assert.ok(Object.isFrozen(DEFAULT_XLSX_LIMITS));
});

test('the reader is quarantined: only the bridge (plus node: builtins), never fflate', async () => {
  const source = await readFile(new URL('../rooms/document-readers-lab/xlsx.mjs', import.meta.url), 'utf8');
  // Strip comments first: the module's own prose *names* fflate and the donor import
  // it replaced, and only real import statements may be asserted on.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const specifiers = [...code.matchAll(/(?:^|\n)\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g)].map((match) => match[1]);

  assert.ok(specifiers.includes('./engine-bridge.mjs'), 'the reader must take its engine and XML helpers from the bridge');
  for (const specifier of specifiers) {
    assert.ok(specifier === './engine-bridge.mjs' || specifier.startsWith('node:'), `unexpected import "${specifier}"`);
    assert.ok(!/fflate/i.test(specifier), `fflate must not be imported directly ("${specifier}")`);
  }
  assert.doesNotMatch(code, /\bfrom\s+['"]fflate['"]/);
  assert.doesNotMatch(code, /\brequire\s*\(/);
});
