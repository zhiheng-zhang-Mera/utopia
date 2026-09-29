/**
 * UTOPIA · City · Document Intake — DOCX adapter.
 *
 * Donor: zhiheng-zhang-Mera/Codex-Boss @ 8df428eaa437a409368401e95194e40266b83080
 *        electron/ingestion/docx-reader.ts
 * PROMOTED from the Room Pack incubator `apps/rooms/rooms/document-readers-lab/`
 * (promotion record: apps/rooms/promotions/document-readers-lab.json).
 *
 * Conversion is delegated to mammoth (pinned, BSD-2-Clause) instead of a bespoke
 * OOXML walker: the OOXML text model is large and only a maintained library should
 * parse it. This module never writes a file and never self-writes an OOXML parser.
 *
 * This module owns the boundary, not the parsing:
 *  - a strict per-document limit on bytes, paragraphs, characters, warnings;
 *  - deterministic mapping of mammoth messages to typed diagnostics;
 *  - typed fail-closed errors so one corrupt attachment cannot fail a batch;
 *  - an injectable conversion seam so tests do not depend on a real .docx.
 *
 * The engine belongs to this building and is reached only through `./engines.mjs`,
 * which is the one module that names the package.
 *
 * Port differences: TypeScript -> ESM JavaScript. Every algorithm is unchanged;
 * the donor's lazy `import("mammoth")` becomes the seam's `loadMammoth()`, and a
 * load failure is still converted to `DocxError` with code `ENGINE_UNAVAILABLE`.
 */

import { loadMammoth } from './engines.mjs';

/**
 * Typed fail-closed failure. Codes: 'NOT_DOCX' | 'CORRUPT_DOCX' | 'TOO_LARGE' |
 * 'ENCRYPTED_DOCX' | 'ENGINE_UNAVAILABLE'.
 */
export class DocxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DocxError';
    this.code = code;
  }
}

/** Default guards, as the donor defines them. */
export const DEFAULT_DOCX_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxParagraphs: 20000,
  maxCharacters: 2000000,
});

let injectedConverter;
let injectedHtmlConverter;

/** Test/DI seam: overrides the plain-text converter (undefined restores mammoth). */
export function setDocxConverter(converter) {
  injectedConverter = converter;
}

/** Test/DI seam: overrides the HTML converter (undefined restores mammoth). */
export function setDocxHtmlConverter(converter) {
  injectedHtmlConverter = converter;
}

/** The bridge's own engine failure is reported as this module's ENGINE_UNAVAILABLE. */
async function loadDocxEngine() {
  try {
    return await loadMammoth();
  } catch (error) {
    throw new DocxError('ENGINE_UNAVAILABLE', `mammoth could not be loaded: ${error?.message || error}`);
  }
}

async function mammothConverter(bytes, limits) {
  const mammoth = await loadDocxEngine();
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    void limits;
    return { text: result.value, messages: result.messages ?? [] };
  } catch (error) {
    throw new DocxError('CORRUPT_DOCX', `mammoth could not read the document: ${error?.message || error}`);
  }
}

async function mammothHtmlConverter(bytes, limits) {
  const mammoth = await loadDocxEngine();
  try {
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
    void limits;
    return { html: result.value, messages: result.messages ?? [] };
  } catch (error) {
    throw new DocxError('CORRUPT_DOCX', `mammoth could not convert the document: ${error?.message || error}`);
  }
}

const HEADING_PATTERN = /^(heading|标题)\s*([1-9一二三四五六七八九])$/i;

function headingLevelFor(style) {
  if (!style) return undefined;
  const match = HEADING_PATTERN.exec(style.trim());
  if (!match) return undefined;
  const numeric = Number.parseInt(match[2], 10);
  if (Number.isFinite(numeric)) return numeric;
  return '一二三四五六七八九'.indexOf(match[2]) + 1;
}

/**
 * Splits mammoth's plain text into paragraphs. mammoth's raw-text output
 * separates blocks with blank lines; every non-empty line becomes one
 * paragraph so headings and bullets stay aligned with the source document.
 */
export function paragraphsFromText(text, limits) {
  const paragraphs = [];
  let characters = 0;
  let truncated = false;
  const lines = text.split(/\r\n|\r|\n/);
  for (const raw of lines) {
    const line = raw.replace(/\u00ad/g, '').replace(/[ \t]+$/g, '');
    if (!line.trim()) continue;
    if (paragraphs.length >= limits.maxParagraphs || characters + line.length > limits.maxCharacters) {
      truncated = true;
      break;
    }
    characters += line.length;
    const bullet = /^\s*(?:[-*+•]|\[[ xX]\]|\d+[.)])\s+/.exec(line);
    const content = bullet ? line.slice(bullet[0].length) : line;
    const headingLevel = headingLevelFor(guessStyle(line));
    const paragraph = { text: content.trim() };
    if (headingLevel) paragraph.headingLevel = headingLevel;
    if (bullet) paragraph.listItem = true;
    paragraphs.push(paragraph);
  }
  return { paragraphs, truncated };
}

/**
 * mammoth's raw-text output does not carry styles, so a heading is recognised
 * from the render-ready conventions: markdown ATX prefixes and short
 * numbered/section lines that the source document used as headings.
 */
function guessStyle(line) {
  const atx = /^\s*(#{1,6})\s+/.exec(line);
  if (atx) return `Heading${atx[1].length}`;
  return undefined;
}

/**
 * mammoth's HTML output does not carry style ids, so the heading level is read
 * from the standard `<h1>`..`<h6>` elements mammoth emits for styled headings.
 */
function paragraphsFromHtml(html, limits) {
  const paragraphs = [];
  const blocks = html.match(/<(h[1-6]|p|li)\b[^>]*>[\s\S]*?<\/\1>/gi) ?? [];
  let characters = 0;
  let truncated = false;
  for (const block of blocks) {
    if (paragraphs.length >= limits.maxParagraphs || characters + block.length > limits.maxCharacters) {
      truncated = true;
      break;
    }
    const tag = /^<(h[1-6]|p|li)\b/i.exec(block)?.[1].toLowerCase() ?? 'p';
    const text = htmlToText(block.replace(/^<[^>]*>/, '').replace(/<\/[^>]*>$/, ''));
    if (!text.trim()) continue;
    characters += text.length;
    const paragraph = { text: text.trim() };
    if (/^h[1-6]$/.test(tag)) paragraph.headingLevel = Number.parseInt(tag.slice(1), 10);
    if (tag === 'li') paragraph.listItem = true;
    paragraphs.push(paragraph);
  }
  return { paragraphs, truncated };
}

/** Converts one mammoth HTML fragment to text, dropping tags but not content. */
function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6]|tr|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\u00ad/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function messageToWarning(message) {
  const type = message.type ?? 'warning';
  const text = (message.message ?? '').trim();
  return text ? `${type}: ${text}` : type;
}

function assertContainer(bytes, limits) {
  if (bytes.byteLength === 0) throw new DocxError('NOT_DOCX', 'DOCX is empty');
  if (bytes.byteLength > limits.maxBytes) {
    throw new DocxError('TOO_LARGE', `DOCX is ${bytes.byteLength} bytes, above the ${limits.maxBytes}-byte limit`);
  }
  // A DOCX is a ZIP; the local file header signature is a cheap fail-closed gate
  // that keeps obviously wrong bytes out of the converter.
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new DocxError('NOT_DOCX', 'Missing ZIP container signature (PK)');
}

function warningsFor(conversion, truncated, effective) {
  const warnings = conversion.messages.slice(0, 50).map(messageToWarning);
  if (conversion.messages.length > 50) warnings.push(`${conversion.messages.length - 50} further converter message(s) were suppressed`);
  if (truncated) {
    warnings.push(`document exceeded the ${effective.maxParagraphs}-paragraph / ${effective.maxCharacters}-character budget and was truncated`);
  }
  return warnings;
}

/** Converts DOCX bytes into ordered paragraphs (plain text). Fails closed. */
export async function extractDocx(bytes, limits = {}) {
  const effective = { ...DEFAULT_DOCX_LIMITS, ...limits };
  assertContainer(bytes, effective);
  const converter = injectedConverter ?? mammothConverter;
  const conversion = await converter(bytes, effective);
  const { paragraphs, truncated } = paragraphsFromText(conversion.text, effective);
  const warnings = warningsFor(conversion, truncated, effective);
  if (!paragraphs.length) warnings.push('no readable paragraph was found in the document body');
  return { paragraphs, warnings };
}

/** Converts DOCX bytes into ordered paragraphs with heading levels (HTML pass). */
export async function extractDocxHtml(bytes, limits = {}) {
  const effective = { ...DEFAULT_DOCX_LIMITS, ...limits };
  assertContainer(bytes, effective);
  const converter = injectedHtmlConverter ?? mammothHtmlConverter;
  const conversion = await converter(bytes, effective);
  const { paragraphs, truncated } = paragraphsFromHtml(conversion.html, effective);
  const warnings = warningsFor(conversion, truncated, effective);
  if (!paragraphs.length) warnings.push('no readable paragraph was found in the document body');
  return { paragraphs, warnings };
}
