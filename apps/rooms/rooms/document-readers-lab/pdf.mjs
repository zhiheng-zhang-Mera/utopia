/**
 * UTOPIA · Rooms · Document Readers Lab — PDF text adapter.
 *
 * Ported mechanically from the Codex-Boss donor `electron/ingestion/pdf-reader.ts`
 * at commit 8df428eaa437a409368401e95194e40266b83080. Text extraction is
 * delegated to a mature PDF engine instead of a bespoke parser: PDF is a large
 * hostile surface and only a mature engine should read it. The engine belongs to
 * the city tree and is reached through the seam (`./engine-bridge.mjs`), so this
 * module names no third-party package and imports nothing but the seam and
 * `node:` builtins. Encrypted documents and oversized documents fail closed with
 * typed errors, so one bad attachment can never take down a batch.
 *
 * What this module owns is the boundary, not the parsing:
 *  - the seam's lazily loaded legacy build keeps the shared layer clean;
 *  - strict per-document limits (bytes, pages, page characters, total text);
 *  - fail-closed typed errors (empty, not a PDF, encryption, corrupt, over-limit);
 *  - a deterministic page split of the extracted text.
 *
 * Port notes (deliberate, behavioural):
 *  - The donor's own lazy dynamic import of the engine's legacy build (and its
 *    module cache) is replaced by the seam's `loadPdfjs()`, which already loads
 *    that legacy build — the one that runs without a browser worker, i.e. no
 *    worker file to serve, no DOM, no bundler. A seam failure is converted to
 *    `PdfError('ENGINE_UNAVAILABLE', <engine message>)`.
 *  - Nothing had to be dropped from the `getDocument` options. The legacy build
 *    accepts `isEvalSupported`, `disableFontFace`, `useSystemFonts` and
 *    `verbosity` when it runs in Node without a worker, so the donor's option
 *    object is kept as it stands and no `workerSrc` is set.
 *  - Typed error codes follow this port's contract: `CORRUPT_PDF` and
 *    `ENCRYPTED_PDF` where the donor wrote `CORRUPT` and `ENCRYPTED`. The donor's
 *    `UNSUPPORTED` code is gone because no path in the donor ever raised it.
 *  - Two diagnostic strings that spelled out the engine's package name now say
 *    "the pdfjs engine", so this file contains no third-party package name.
 */

import { Buffer } from 'node:buffer';

import { loadPdfjs } from './engine-bridge.mjs';

/** Typed failure raised at this boundary; `code` is stable and machine-readable. */
export class PdfError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PdfError';
    this.code = code;
  }
}

/**
 * Default per-document limits. `maxBytes` is 64 MiB; the character caps keep a
 * single pathological page or document from exhausting memory downstream.
 */
export const DEFAULT_PDF_LIMITS = Object.freeze({
  maxPages: 300,
  maxBytes: 64 * 1024 * 1024,
  maxCharactersPerPage: 200000,
  maxTotalCharacters: 2000000,
});

/**
 * pdfjs verbosity levels (the library's own enum values, inlined so this module
 * does not depend on the enum's runtime shape). ERRORS keeps the engine quiet
 * on the console without this module touching global console functions.
 */
export const PdfVerbosity = { ERRORS: 0, WARNINGS: 1, INFOS: 5 };

/** Cheap pre-flight checks so obviously out-of-scope files never reach the engine. */
export function inspectPdfHeader(bytes) {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  if (!head.includes('%PDF-')) return { ok: false, error: new PdfError('NOT_PDF', 'Missing %PDF- header') };
  // /Encrypt may appear anywhere in the trailer; scanning the whole buffer is
  // the only reliable pre-flight check without parsing.
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(Buffer.from(bytes).toString('latin1'))) {
    return { ok: false, error: new PdfError('ENCRYPTED_PDF', 'Encrypted PDFs are not supported; export an unencrypted copy') };
  }
  return { ok: true };
}

/**
 * Extracts per-page text with the seam's PDF engine. Fails closed: an engine
 * error, an encrypted document or a page-count overrun becomes a typed PdfError.
 */
export async function extractPdf(bytes, limits = {}) {
  const effective = { ...DEFAULT_PDF_LIMITS, ...limits };
  if (bytes.byteLength === 0) throw new PdfError('NOT_PDF', 'PDF is empty');
  if (bytes.byteLength > effective.maxBytes) throw new PdfError('TOO_LARGE', `PDF is ${bytes.byteLength} bytes, above the ${effective.maxBytes}-byte limit`);
  const header = inspectPdfHeader(bytes);
  if (!header.ok) throw header.error;

  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch (error) {
    throw new PdfError('ENGINE_UNAVAILABLE', (error && error.message) ? error.message : String(error));
  }

  const warnings = [];
  let document;
  let loadingTask;
  try {
    // `data` is copied because the engine transfers/detaches the buffer it is
    // given. `verbosity: ERRORS` keeps the engine's own informational output off
    // the process log; this module never redirects or intercepts logging, so
    // unrelated application output is untouched.
    loadingTask = pdfjs.getDocument({
      data: Uint8Array.from(bytes),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: PdfVerbosity.ERRORS,
    });
    document = await loadingTask.promise;
  } catch (error) {
    await loadingTask?.destroy().catch(() => undefined);
    const message = (error && error.message) ?? String(error);
    if (/password/i.test(message)) throw new PdfError('ENCRYPTED_PDF', 'PDF requires a password; provide an unencrypted copy');
    throw new PdfError('CORRUPT_PDF', `the pdfjs engine could not open the document: ${message}`);
  }
  // Fail closed if the engine could not resolve the page tree: an untrustworthy
  // page count would silently under-report the document.
  if (!Number.isInteger(document.numPages) || document.numPages < 1) {
    await loadingTask.destroy().catch(() => undefined);
    throw new PdfError('CORRUPT_PDF', `the pdfjs engine resolved an invalid page count (${String(document.numPages)})`);
  }

  try {
    if (document.numPages > effective.maxPages) {
      warnings.push(`document has ${document.numPages} pages; only the first ${effective.maxPages} were read`);
    }
    const pageCount = Math.min(document.numPages, effective.maxPages);
    const pages = [];
    let totalCharacters = 0;
    for (let number = 1; number <= pageCount; number++) {
      const page = await document.getPage(number);
      let text = '';
      try {
        const content = await page.getTextContent();
        text = joinTextItems(content.items);
      } finally {
        page.cleanup();
      }
      if (text.length > effective.maxCharactersPerPage) {
        warnings.push(`page ${number} exceeded ${effective.maxCharactersPerPage} characters and was truncated`);
        text = text.slice(0, effective.maxCharactersPerPage);
      }
      if (totalCharacters + text.length > effective.maxTotalCharacters) {
        warnings.push(`document text exceeded ${effective.maxTotalCharacters} characters; remaining pages were dropped`);
        pages.push({ number, text: text.slice(0, Math.max(0, effective.maxTotalCharacters - totalCharacters)) });
        break;
      }
      totalCharacters += text.length;
      if (!text.trim()) warnings.push(`page ${number} produced no extractable text`);
      pages.push({ number, text });
    }

    const documentInfo = {};
    try {
      const metadata = await document.getMetadata();
      for (const key of ['Title', 'Author', 'Subject', 'Producer']) {
        const value = metadata.info?.[key];
        if (typeof value === 'string' && value.trim()) documentInfo[key.toLowerCase()] = value.trim();
      }
    } catch {
      warnings.push('document metadata could not be read');
    }
    if (!pages.some((page) => page.text.trim())) {
      warnings.push('no page contained extractable text (the PDF may be a scan; OCR is out of scope for this unit)');
    }
    return { pages, warnings, documentInfo };
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

/**
 * Joins pdfjs text items, honouring explicit end-of-line markers and the
 * item order the engine reports (no positional re-flow heuristics).
 */
function joinTextItems(items) {
  const parts = [];
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    parts.push(item.str);
    parts.push(item.hasEOL ? '\n' : ' ');
  }
  return parts.join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
