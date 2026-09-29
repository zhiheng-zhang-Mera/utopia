/**
 * UTOPIA · City · Document Intake — document readers integration suite (D7b).
 *
 * The three adapters have their own focused suites; this one proves they compose: a
 * synthetic document of each kind is built in memory, decoded through the real engine
 * and reduced to reportable counts, warnings and a preview - the same shape the
 * incubator room returned, now produced by the city module itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_KINDS, buildDocx, buildPdf, buildSample, buildXlsx } from '../samples.mjs';
import { DEFAULT_DOCX_LIMITS, extractDocx } from '../docx.mjs';
import { DEFAULT_XLSX_LIMITS, extractXlsx } from '../xlsx.mjs';
import { DEFAULT_PDF_LIMITS, extractPdf, inspectPdfHeader } from '../pdf.mjs';
import { enginesProvenance } from '../engines.mjs';

test('every sample is a real document of its kind, built in memory', async () => {
  assert.deepEqual(SAMPLE_KINDS, ['xlsx', 'docx', 'pdf']);
  assert.equal(Buffer.from(await buildXlsx()).subarray(0, 2).toString('latin1'), 'PK');
  assert.equal(Buffer.from(await buildDocx()).subarray(0, 2).toString('latin1'), 'PK');
  assert.equal(buildPdf().subarray(0, 5).toString('latin1'), '%PDF-');
  for (const kind of SAMPLE_KINDS) {
    const sample = await buildSample(kind);
    assert.equal(sample.kind, kind);
    assert.ok(sample.bytesLength > 100);
  }
  await assert.rejects(() => buildSample('zip'), /unknown sample kind/);
});

test('the three adapters decode their own sample with the real engines', async () => {
  assert.ok(enginesProvenance().every((engine) => engine.available), 'all three engines are installed');

  const xlsxSample = await buildSample('xlsx');
  const workbook = await extractXlsx(new Uint8Array(xlsxSample.bytes));
  assert.equal(workbook.sheets.length, 1);
  assert.equal(workbook.sheets[0].name, 'Inventory');
  assert.ok(workbook.sheets[0].rows.length >= 3);
  assert.match(workbook.markdown, /\| id \| item \| qty \|/);
  assert.match(workbook.markdown, /trust anchor/);
  assert.ok(workbook.warnings.some((warning) => /formula/i.test(warning)), 'a formula without a cached value is reported');
  assert.ok(!/\|\s*5\s*\|/.test(workbook.markdown), 'the formula is never computed by the reader');

  const docxSample = await buildSample('docx');
  const document = await extractDocx(new Uint8Array(docxSample.bytes));
  assert.ok(document.paragraphs.length >= 4);
  const text = document.paragraphs.map((paragraph) => paragraph.text ?? paragraph).join('\n');
  assert.match(text, /Intake Note/);
  assert.match(text, /first bullet/);

  const pdfSample = await buildSample('pdf');
  assert.deepEqual(inspectPdfHeader(new Uint8Array(pdfSample.bytes)), { ok: true });
  const pdf = await extractPdf(new Uint8Array(pdfSample.bytes));
  assert.equal(pdf.pages.length, 1);
  assert.match(pdf.pages[0].text, /Intake note/);
});

test('a refused document fails closed in every adapter, with its own code', async () => {
  const junk = new Uint8Array(Buffer.from('merely some text, not a document at all'));
  const refusals = await Promise.all([
    extractXlsx(junk).then(() => null, (error) => error.code),
    extractDocx(junk).then(() => null, (error) => error.code),
    extractPdf(junk).then(() => null, (error) => error.code),
  ]);
  assert.deepEqual(refusals.sort(), ['NOT_DOCX', 'NOT_PDF', 'NOT_XLSX']);
});

test('every adapter carries the same fail-closed default limits shape', () => {
  assert.equal(DEFAULT_XLSX_LIMITS.maxBytes, 64 * 1024 * 1024);
  assert.equal(DEFAULT_XLSX_LIMITS.maxColumns, 256);
  assert.equal(DEFAULT_DOCX_LIMITS.maxBytes, 64 * 1024 * 1024);
  assert.equal(DEFAULT_PDF_LIMITS.maxBytes, 64 * 1024 * 1024);
  assert.equal(DEFAULT_PDF_LIMITS.maxPages, 300);
  for (const limits of [DEFAULT_XLSX_LIMITS, DEFAULT_DOCX_LIMITS, DEFAULT_PDF_LIMITS]) {
    assert.ok(Object.isFrozen(limits));
    assert.equal(typeof limits.maxBytes, 'number');
  }
});
