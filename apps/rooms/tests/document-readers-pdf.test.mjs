/**
 * Room · Document Readers Lab — PDF adapter focused tests.
 *
 * The PDF fixture is assembled in memory by `buildPdf` below: it is a real,
 * minimal, valid PDF (header, catalog, pages tree, one page per text list with a
 * content stream that draws text in a standard font, a correct xref table and
 * `%%EOF`). Nothing here stubs the engine — every extraction goes through the
 * real pdfjs legacy build reached through `engine-bridge.mjs`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

import {
  DEFAULT_PDF_LIMITS,
  PdfError,
  PdfVerbosity,
  extractPdf,
  inspectPdfHeader,
} from '../rooms/document-readers-lab/pdf.mjs';

const PDF_PATH = fileURLToPath(new URL('../rooms/document-readers-lab/pdf.mjs', import.meta.url));

/**
 * Assembles a minimal multi-page PDF from plain strings and returns its bytes.
 *
 * Object layout: 1 catalog, 2 pages tree, 3..(2+n) pages, then one shared
 * Helvetica font, then one content stream per page, then an optional Info
 * dictionary. Every object offset is computed as it is written, so the xref
 * table and `startxref` are correct by construction.
 */
function buildPdf({ pages, info = null }) {
  assert.ok(Array.isArray(pages) && pages.length > 0, 'buildPdf needs at least one page');

  const catalogNum = 1;
  const pagesNum = 2;
  const firstPageNum = 3;
  const fontNum = firstPageNum + pages.length;
  const firstContentNum = fontNum + 1;
  const infoNum = firstContentNum + pages.length;
  const size = infoNum + 1;

  const bodies = new Map();
  bodies.set(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  bodies.set(pagesNum, `<< /Type /Pages /Kids [${pages.map((_, i) => `${firstPageNum + i} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  pages.forEach((_, i) => {
    bodies.set(firstPageNum + i,
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] `
      + `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${firstContentNum + i} 0 R >>`);
  });
  bodies.set(fontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  pages.forEach((lines, i) => {
    const operators = ['BT', '/F1 24 Tf', '72 700 Td'];
    lines.forEach((line, index) => {
      if (index > 0) operators.push('0 -30 Td');
      operators.push(`(${line.replace(/([\\()])/g, '\\$1')}) Tj`);
    });
    operators.push('ET');
    const stream = operators.join('\n');
    bodies.set(firstContentNum + i,
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });
  if (info !== null) bodies.set(infoNum, info);

  let out = '%PDF-1.4\n';
  const offsets = new Array(size).fill(0);
  for (let num = 1; num < size; num += 1) {
    offsets[num] = Buffer.byteLength(out, 'latin1');
    out += `${num} 0 obj\n${bodies.get(num)}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let num = 1; num < size; num += 1) {
    out += `${String(offsets[num]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${size} /Root ${catalogNum} 0 R${info !== null ? ` /Info ${infoNum} 0 R` : ''} >>\n`
    + `startxref\n${xrefOffset}\n%%EOF\n`;
  return Uint8Array.from(Buffer.from(out, 'latin1'));
}

const ONE_PAGE_PDF = buildPdf({
  pages: [['Hello Utopia World', 'Second line here']],
  info: '<< /Title (Synthetic Report) /Author (Test Author) /Producer (Utopia Lab) /Subject ( ) >>',
});

const THREE_PAGE_PDF = buildPdf({
  pages: [['Alpha page one'], ['Beta page two'], ['Gamma page three']],
});

test('limits and verbosity mirror the donor exactly', () => {
  assert.deepEqual(DEFAULT_PDF_LIMITS, {
    maxPages: 300,
    maxBytes: 64 * 1024 * 1024,
    maxCharactersPerPage: 200000,
    maxTotalCharacters: 2000000,
  });
  assert.equal(DEFAULT_PDF_LIMITS.maxBytes, 67108864);
  assert.ok(Object.isFrozen(DEFAULT_PDF_LIMITS), 'DEFAULT_PDF_LIMITS must be frozen');
  assert.deepEqual(PdfVerbosity, { ERRORS: 0, WARNINGS: 1, INFOS: 5 });
});

test('PdfError carries its name and code', () => {
  const error = new PdfError('NOT_PDF', 'Missing %PDF- header');
  assert.ok(error instanceof Error);
  assert.ok(error instanceof PdfError);
  assert.equal(error.name, 'PdfError');
  assert.equal(error.code, 'NOT_PDF');
  assert.equal(error.message, 'Missing %PDF- header');
});

test('inspectPdfHeader accepts a real PDF and rejects other payloads with typed errors', () => {
  assert.deepEqual(inspectPdfHeader(ONE_PAGE_PDF), { ok: true });

  const notPdf = inspectPdfHeader(Buffer.from('plain text, definitely not a PDF', 'latin1'));
  assert.equal(notPdf.ok, false);
  assert.ok(notPdf.error instanceof PdfError);
  assert.equal(notPdf.error.code, 'NOT_PDF');
  assert.equal(notPdf.error.message, 'Missing %PDF- header');

  const encrypted = inspectPdfHeader(Buffer.from('%PDF-1.4\ntrailer\n<< /Encrypt 12 0 R >>\n%%EOF\n', 'latin1'));
  assert.equal(encrypted.ok, false);
  assert.equal(encrypted.error.code, 'ENCRYPTED_PDF');

  const empty = inspectPdfHeader(new Uint8Array(0));
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'NOT_PDF');
});

test('extractPdf decodes a synthetic one-page PDF through the real engine', async () => {
  const result = await extractPdf(ONE_PAGE_PDF);
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].number, 1);
  assert.equal(result.pages[0].text, 'Hello Utopia World\nSecond line here');
  assert.match(result.pages[0].text, /Hello Utopia World/);
  assert.match(result.pages[0].text, /Second line here/);
  assert.deepEqual(result.documentInfo, {
    title: 'Synthetic Report',
    author: 'Test Author',
    producer: 'Utopia Lab',
  });
  assert.ok(Array.isArray(result.warnings));
  assert.deepEqual(result.warnings, []);
});

test('extractPdf honours the page cap and warns about the unread pages', async () => {
  const capped = await extractPdf(THREE_PAGE_PDF, { maxPages: 2 });
  assert.equal(capped.pages.length, 2);
  assert.deepEqual(capped.pages.map((page) => page.number), [1, 2]);
  assert.match(capped.pages[0].text, /Alpha page one/);
  assert.match(capped.pages[1].text, /Beta page two/);
  assert.ok(!capped.pages.some((page) => page.text.includes('Gamma')), 'page 3 must not be read');
  assert.ok(
    capped.warnings.includes('document has 3 pages; only the first 2 were read'),
    `expected the page-cap warning, got ${JSON.stringify(capped.warnings)}`,
  );

  const whole = await extractPdf(THREE_PAGE_PDF);
  assert.equal(whole.pages.length, 3);
  assert.match(whole.pages[2].text, /Gamma page three/);
});

test('extractPdf fails closed on a truncated or corrupt document', async () => {
  const truncated = THREE_PAGE_PDF.slice(0, Math.floor(THREE_PAGE_PDF.byteLength * 0.75));
  assert.ok(truncated.byteLength > 0 && truncated.byteLength < THREE_PAGE_PDF.byteLength);

  await assert.rejects(
    () => extractPdf(truncated),
    (error) => {
      assert.ok(error instanceof PdfError, `expected PdfError, got ${error?.name}: ${error?.message}`);
      assert.equal(error.code, 'CORRUPT_PDF');
      return true;
    },
  );

  // A %PDF- header with a broken body must never come back as an empty success.
  const brokenBody = Uint8Array.from(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'));
  await assert.rejects(
    () => extractPdf(brokenBody),
    (error) => error instanceof PdfError && error.code === 'CORRUPT_PDF',
  );

  await assert.rejects(
    () => extractPdf(new Uint8Array(0)),
    (error) => error instanceof PdfError && error.code === 'NOT_PDF',
  );
});

test('extractPdf rejects over-limit bytes before the engine is consulted', async () => {
  // The payload is not a PDF at all: with the default limit it fails as NOT_PDF,
  // so receiving TOO_LARGE here proves the byte check runs first, ahead of both
  // the header pre-flight and the engine.
  const payload = Uint8Array.from(Buffer.from('this is not a PDF document payload', 'latin1'));
  assert.equal(payload.byteLength, 34);

  await assert.rejects(
    () => extractPdf(payload, { maxBytes: 16 }),
    (error) => {
      assert.ok(error instanceof PdfError);
      assert.equal(error.code, 'TOO_LARGE');
      assert.equal(error.message, 'PDF is 34 bytes, above the 16-byte limit');
      return true;
    },
  );

  await assert.rejects(
    () => extractPdf(payload),
    (error) => error instanceof PdfError && error.code === 'NOT_PDF',
  );
});

test('extractPdf is deterministic for identical bytes', async () => {
  const first = await extractPdf(THREE_PAGE_PDF);
  const second = await extractPdf(THREE_PAGE_PDF);
  assert.deepEqual(second, first);
  assert.equal(THREE_PAGE_PDF.byteLength, buildPdf({
    pages: [['Alpha page one'], ['Beta page two'], ['Gamma page three']],
  }).byteLength, 'the fixture builder itself must be deterministic');
});

test('the port keeps its engine quarantine', async () => {
  const source = await readFile(PDF_PATH, 'utf8');
  assert.ok(!source.includes('pdfjs-dist'), 'pdf.mjs must not name the third-party package at all');

  const specifiers = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(specifiers, ['node:buffer', './engine-bridge.mjs']);
  assert.ok(
    specifiers.every((specifier) => specifier === './engine-bridge.mjs' || specifier.startsWith('node:')),
    `only the seam and node: builtins may be imported, saw ${JSON.stringify(specifiers)}`,
  );
  assert.ok(!/\brequire\s*\(/.test(source), 'no require() allowed');
  assert.ok(!/\bimport\s*\(/.test(source), 'no dynamic import() allowed');
  assert.match(source, /import \{ loadPdfjs \} from '\.\/engine-bridge\.mjs';/);
});
