/**
 * UTOPIA · City · Ingestion Core — encoding, section splitting and helpers.
 *
 * PROMOTED from the Room Pack incubator `apps/rooms/rooms/document-intake-lab/`
 * (promotion record: apps/rooms/promotions/document-intake-lab.json), and
 * strengthened by `apps/rooms/rooms/yaml-intake-lab/` in wave 2 (D7a).
 *
 * Donor: zhiheng-zhang-Mera/Codex-Boss @ 8df428eaa437a409368401e95194e40266b83080
 *        electron/ingestion/text-parsers.ts, electron/ingestion/xml-text.ts
 *
 * D4a scope: encoding detection, TXT/Markdown section splitting, JSON/JSON Lines,
 * CSV/TSV and the XML text helpers, with the donor's input guards.
 *
 * D7a scope: the donor's YAML branch, completed. The external `yaml` package is
 * isolated behind `./yaml-parser.mjs` inside this building, so this module still
 * contains no parser of its own and never imports the package directly.
 *
 * Port differences: TypeScript -> ESM JavaScript. Every algorithm is unchanged.
 */

import { tryParseYaml } from './yaml-parser.mjs';

export { MAX_ALIAS_COUNT, MAX_YAML_BYTES, YAML_PACKAGE, YamlParserError } from './yaml-parser.mjs';

/** Section kinds the parser produces. */
export const SECTION_KINDS = ['TITLE', 'HEADING', 'PARAGRAPH', 'BULLET', 'NUMBERED', 'TABLE', 'KEYVALUE', 'CODE'];

/** Default parser guards, as the donor defines them. */
export const DEFAULT_TEXT_LIMITS = {
  maxSections: 4000,
  maxBytes: 8 * 1024 * 1024,
  maxContentLength: 4 * 1024 * 1024,
  maxCsvRows: 20000,
  maxJsonNodes: 20000,
};

/** Parse failures carry a stable code so callers can explain them. */
export class TextParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TextParseError';
    this.code = code;
  }
}

/* ---------------------------------------------------------------- encoding */

const BOMS = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8', skip: 3 },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le', skip: 2 },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be', skip: 2 },
];

function decodeWith(bytes, encoding, fatal = false) {
  return new TextDecoder(encoding, { fatal }).decode(bytes);
}

/**
 * Decode bytes using BOM detection, then strict UTF-8, then UTF-16 without a BOM,
 * and only then a lossy UTF-8 fallback. The donor additionally tried GBK; that is
 * reported as an explicit warning here because the Node runtime's `TextDecoder`
 * does not always ship the GBK table, and guessing must never be silent.
 */
export function decodeText(bytes) {
  const warnings = [];
  for (const bom of BOMS) {
    if (bytes.length >= bom.skip && bom.bytes.every((byte, index) => bytes[index] === byte)) {
      return { text: decodeWith(bytes.subarray(bom.skip), bom.encoding), encoding: bom.encoding, warnings };
    }
  }
  try {
    return { text: decodeWith(bytes, 'utf-8', true), encoding: 'utf-8', warnings };
  } catch {
    for (const encoding of ['utf-16le', 'utf-16be']) {
      try {
        const text = decodeWith(bytes, encoding, true);
        if (!text.includes('\u0000')) {
          warnings.push(`file was not valid UTF-8; decoded as ${encoding}`);
          return { text, encoding, warnings };
        }
      } catch {
        // try the next candidate
      }
    }
    warnings.push('file was neither valid UTF-8 nor UTF-16; decoded lossily as UTF-8 (GBK is not available in this runtime)');
    return { text: decodeWith(bytes, 'utf-8'), encoding: 'utf-8-lossy', warnings };
  }
}

/* -------------------------------------------------------------- xml helpers */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', shy: '\u00ad' };

/** Decode XML character and named entities exactly once. */
export function unescapeXml(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[body] ?? whole;
  });
}

/** All `<tag ...>...</tag>` blocks, bounded by a caller-supplied cap. */
export function matchBlocks(xml, tag, limit = 100000) {
  const pattern = new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>|<${tag}\\b[^>]*/>`, 'g');
  const blocks = [];
  let match;
  while ((match = pattern.exec(xml)) !== null && blocks.length < limit) blocks.push(match[0]);
  return blocks;
}

/** Concatenated `<t>` runs of one OOXML block (shared-string / inline text). */
export function extractTextRuns(block) {
  const runs = block.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) ?? [];
  return runs.map((run) => unescapeXml(/<t\b[^>]*>([\s\S]*?)<\/t>/.exec(run)?.[1] ?? '')).join('');
}

/* ----------------------------------------------------------- text sections */

const MD_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const SETEXT_UNDERLINE = /^(=+|-{2,})\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+/;
const NUMBERED_CJK = /^\s*(?:第[一二三四五六七八九十百\d]+[章节条]|[一二三四五六七八九十]+[、.]|\d+[、]|[（(]\d+[)）])\s*/;
const KEY_VALUE = /^\s*(?:[-*+]\s*)?([^:：]{1,60})[:：]\s*(\S.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;

function headingLevelForLine(line, nextLine, plainText) {
  const atx = MD_HEADING.exec(line);
  if (atx) return { level: atx[1].length, heading: atx[2].trim() };
  if (nextLine !== undefined && SETEXT_UNDERLINE.test(nextLine) && line.trim() && !LIST_ITEM.test(line)) {
    return { level: nextLine.trim().startsWith('=') ? 1 : 2, heading: line.trim() };
  }
  if (plainText) {
    // Chinese WorkBooks head sections with 「一、目标」 or 「第一章 范围」. Arabic
    // list items (`1.`) are body content, so they are deliberately excluded.
    if (NUMBERED_CJK.test(line) && line.trim().length <= 60 && !/[。；;]$/.test(line.trim())) {
      return { level: 2, heading: line.trim() };
    }
  }
  return undefined;
}

/**
 * Split markdown/plain text into ordered, offset-preserving sections. Fenced code
 * blocks are never split internally; headings carry their level and text.
 */
export function parseTextSections(text, options = {}) {
  const limits = { ...DEFAULT_TEXT_LIMITS, ...(options.limits ?? {}) };
  const plainText = options.plainText ?? false;
  if (text.length > limits.maxBytes) {
    throw new TextParseError('TOO_LARGE', `Document exceeds the ${limits.maxBytes}-character parser guard`);
  }
  const lines = text.split('\n');
  const sections = [];
  let offset = 0;
  let current;
  let inFence = false;
  let fenceMarker = '';

  const pushCurrent = (end) => {
    if (!current) return;
    current.text = current.text.replace(/\s+$/g, '');
    current.end = current.text ? current.end : end;
    if (current.text.trim() || current.heading) sections.push(current);
    current = undefined;
  };

  for (let index = 0; index < lines.length && sections.length < limits.maxSections; index += 1) {
    const line = lines[index];
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1;

    const fence = FENCE.exec(line);
    if (fence) {
      if (!inFence) {
        pushCurrent(lineStart);
        inFence = true;
        fenceMarker = fence[1][0];
        current = { kind: 'CODE', text: line, start: lineStart, end: lineEnd };
      } else if (fence[1][0] === fenceMarker) {
        current = current ?? { kind: 'CODE', text: '', start: lineStart, end: lineEnd };
        current.text += `\n${line}`;
        current.end = lineEnd;
        inFence = false;
        pushCurrent(lineEnd);
      } else {
        current = current ?? { kind: 'CODE', text: '', start: lineStart, end: lineEnd };
        current.text += `\n${line}`;
        current.end = lineEnd;
      }
      continue;
    }
    if (inFence) {
      if (current) {
        current.text += `\n${line}`;
        current.end = lineEnd;
      }
      continue;
    }

    const heading = headingLevelForLine(line, lines[index + 1], plainText);
    if (heading) {
      pushCurrent(lineStart);
      const isSetext = !MD_HEADING.test(line) && SETEXT_UNDERLINE.test(lines[index + 1] ?? '');
      const end = isSetext ? lineEnd + (lines[index + 1]?.length ?? 0) + 1 : lineEnd;
      sections.push({
        kind: heading.level === 1 ? 'TITLE' : 'HEADING',
        heading: heading.heading,
        level: heading.level,
        text: heading.heading,
        start: lineStart,
        end,
      });
      if (isSetext) {
        offset = end;
        index += 1;
      }
      continue;
    }

    if (!line.trim()) {
      pushCurrent(lineStart);
      continue;
    }

    const kind = TABLE_ROW.test(line)
      ? 'TABLE'
      : LIST_ITEM.test(line)
        ? (/^\s*\d/.test(line) ? 'NUMBERED' : 'BULLET')
        : KEY_VALUE.test(line) && !plainText
          ? 'KEYVALUE'
          : 'PARAGRAPH';

    if (!current) {
      current = { kind, text: line, start: lineStart, end: lineEnd };
      if (kind === 'TABLE') current.heading = undefined;
      continue;
    }
    const continues = current.kind === kind;
    if (continues) {
      current.text += `\n${line}`;
      current.end = lineEnd;
    } else {
      pushCurrent(lineStart);
      current = { kind, text: line, start: lineStart, end: lineEnd };
    }
  }
  pushCurrent(offset);
  return sections;
}

/* -------------------------------------------- structured data (JSON/JSONL) */

/** Deterministic YAML-ish rendering used for section bodies and the merged view. */
export function renderStructured(value, indent = 0, depth = 0) {
  const pad = '  '.repeat(indent);
  if (depth > 12) return `${pad}...`;
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object') return `${pad}-\n${renderStructured(item, indent + 1, depth + 1)}`;
        return `${pad}- ${renderScalar(item)}`;
      })
      .join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    return entries
      .map(([key, item]) => {
        if (item !== null && typeof item === 'object') return `${pad}${key}:\n${renderStructured(item, indent + 1, depth + 1)}`;
        return `${pad}${key}: ${renderScalar(item)}`;
      })
      .join('\n');
  }
  return `${pad}${renderScalar(value)}`;
}

function renderScalar(value) {
  if (typeof value === 'string') return /[:#\-?[\]{},&*!|>'"%@`]|^\s|\s$/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

/** Structured formats this core can report. */
export const STRUCTURED_FORMATS = ['json', 'jsonl', 'yaml'];

/** Extensions that must be parsed as YAML regardless of their content. */
export const YAML_EXTENSIONS = ['.yaml', '.yml'];

export function prefersYaml(fileName = '') {
  const name = String(fileName || '');
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
  return YAML_EXTENSIONS.includes(extension);
}

/**
 * Parse JSON, then JSON Lines, then YAML - the donor's order, completed by D7a.
 *
 * A `.yaml`/`.yml` document is parsed as YAML first and only. Every other extension
 * tries JSON, then JSON Lines, and only then YAML, and the fallback is reported
 * (`JSON parsing failed (...); parsed as YAML`) rather than silent.
 *
 * @returns {Promise<{value: unknown, format: 'json'|'jsonl'|'yaml', warnings: string[]}>}
 * @throws {TextParseError} CORRUPT_INPUT
 */
export async function parseStructuredText(text, fileName = '') {
  const warnings = [];
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new TextParseError('CORRUPT_INPUT', 'Structured document is empty');

  const refuse = (message, detail) => {
    const failure = new TextParseError('CORRUPT_INPUT', message);
    failure.detail = detail ?? null;
    return failure;
  };

  const tryJson = () => {
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  };

  if (prefersYaml(fileName)) {
    const parsed = await tryParseYaml(trimmed, { fileName });
    if (!parsed.ok) throw refuse(`Not valid YAML: ${parsed.detail?.reason ?? parsed.reason}`, parsed.detail ?? null);
    if (Array.isArray(parsed.warnings)) warnings.push(...parsed.warnings);
    return { value: parsed.value, format: 'yaml', warnings };
  }

  const json = tryJson();
  if (json.ok) return { value: json.value, format: 'json', warnings };

  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > 1 && lines.every((line) => line.trim().startsWith('{') && line.trim().endsWith('}'))) {
    const rows = [];
    for (const line of lines) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        rows.length = 0;
        break;
      }
    }
    if (rows.length) {
      warnings.push(`parsed ${rows.length} JSON Lines records`);
      return { value: rows, format: 'jsonl', warnings };
    }
  }

  const parsed = await tryParseYaml(trimmed, { fileName });
  if (!parsed.ok) {
    throw refuse(`Not valid JSON or YAML: ${json.error} | ${parsed.detail?.reason ?? parsed.reason}`, parsed.detail ?? null);
  }
  warnings.push(`JSON parsing failed (${json.error}); parsed as YAML`);
  if (Array.isArray(parsed.warnings)) warnings.push(...parsed.warnings);
  return { value: parsed.value, format: 'yaml', warnings };
}

/**
 * The whole structured intake in one call: parse, then split into deterministic
 * sections. Every outcome is returned, so a caller never has to catch a thrown error
 * to show a product answer and never has to guess which parser ran.
 */
export async function ingestStructured(text, fileName = '', { limits = {} } = {}) {
  const effective = { ...DEFAULT_TEXT_LIMITS, ...limits };
  const declared = detectFormat(fileName);
  try {
    const parsed = await parseStructuredText(text, fileName);
    const sections = sectionsFromStructured(parsed.value, effective);
    return {
      ok: true,
      fileName: String(fileName || ''),
      declared,
      format: parsed.format,
      value: parsed.value,
      warnings: parsed.warnings,
      sections,
      rendered: renderStructured(parsed.value),
      stats: {
        bytes: Buffer.byteLength(String(text ?? ''), 'utf8'),
        sections: sections.length,
        keys: parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? Object.keys(parsed.value).length : 0,
        arrays: countArrays(parsed.value),
        maxDepth: depthOf(parsed.value),
      },
    };
  } catch (error) {
    if (error instanceof TextParseError) {
      return {
        ok: false,
        fileName: String(fileName || ''),
        declared,
        code: error.code,
        reason: error.message,
        detail: error.detail ?? null,
        warnings: [],
      };
    }
    return {
      ok: false,
      fileName: String(fileName || ''),
      declared,
      code: 'INTERNAL_ERROR',
      reason: String(error?.message || error),
      detail: null,
      warnings: [],
    };
  }
}

function countArrays(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return 1 + value.reduce((total, item) => total + countArrays(item, depth + 1), 0);
  return Object.values(value).reduce((total, item) => total + countArrays(item, depth + 1), 0);
}

function depthOf(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  if (!children.length) return depth;
  return Math.max(...children.map((child) => depthOf(child, depth + 1)));
}

/** Flatten a parsed structure into headed sections (one per top-level key). */
export function sectionsFromStructured(value, limits = {}) {
  const effective = { ...DEFAULT_TEXT_LIMITS, ...limits };
  const sections = [];
  let cursor = 0;
  const push = (kind, heading, text, level) => {
    if (sections.length >= effective.maxSections) return;
    const rendered = text.trim();
    if (!rendered && !heading) return;
    const section = { kind, text: rendered, start: cursor, end: cursor + rendered.length };
    if (heading !== undefined) section.heading = heading;
    if (level !== undefined) section.level = level;
    sections.push(section);
    cursor = section.end + 1;
  };

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (sections.length >= effective.maxSections) break;
      if (typeof item === 'string') push('KEYVALUE', key, item, 2);
      else if (Array.isArray(item) && item.every((entry) => typeof entry === 'string')) {
        push('HEADING', key, item.map((entry) => `- ${String(entry)}`).join('\n'), 2);
      } else push('HEADING', key, renderStructured(item, 0), 2);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (sections.length >= effective.maxSections) return;
      const heading = item !== null && typeof item === 'object' && 'id' in item ? String(item.id) : `item-${index + 1}`;
      push('HEADING', heading, renderStructured(item, 0), 2);
    });
  } else {
    push('PARAGRAPH', undefined, renderStructured(value, 0));
  }
  return sections;
}

/* -------------------------------------------------------------- CSV / TSV */

/** RFC4180-ish CSV/TSV parser: quoted fields, escaped quotes, CRLF, bounded rows. */
export function parseDelimited(text, options = {}) {
  const limits = { ...DEFAULT_TEXT_LIMITS, ...(options.limits ?? {}) };
  const delimiter = options.delimiter ?? (text.includes('\t') && !text.includes(',') ? '\t' : ',');
  const rows = [];
  const warnings = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let index = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || (row[0] ?? '').trim() !== '') rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (character === '"' && field === '') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (character === delimiter) {
      endField();
      index += 1;
      continue;
    }
    if (character === '\r') {
      index += 1;
      continue;
    }
    if (character === '\n') {
      endRow();
      index += 1;
      if (rows.length >= limits.maxCsvRows) {
        warnings.push(`row limit ${limits.maxCsvRows} reached; remaining rows were not read`);
        break;
      }
      continue;
    }
    field += character;
    index += 1;
  }
  if (field !== '' || row.length) endRow();
  if (inQuotes) warnings.push('file ended inside a quoted field; the last field may be truncated');
  return { rows, delimiter, warnings };
}

function csvMarkdown(rows, maxColumns) {
  const width = Math.min(Math.max(...rows.map((row) => row.length), 1), maxColumns);
  const cell = (value) => (value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = [];
  const header = rows[0]?.slice(0, width) ?? [];
  lines.push(`| ${header.map(cell).join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const row of rows.slice(1)) lines.push(`| ${row.slice(0, width).map(cell).join(' | ')} |`);
  return lines.join('\n');
}

/**
 * Turn a delimited table into sections: one table section per group of rows whose
 * first column carries a label, falling back to a single whole-file table.
 */
export function sectionsFromDelimited(table, options = {}) {
  const maxColumns = options.maxColumns ?? 64;
  const rows = table.rows;
  if (!rows.length) return [];
  const header = rows[0];
  const body = rows.slice(1);
  const sections = [];
  let cursor = 0;
  const push = (heading, text, kind = 'TABLE') => {
    const rendered = text.trim();
    if (!rendered) return;
    const section = { kind, text: rendered, start: cursor, end: cursor + rendered.length };
    if (heading) section.heading = heading;
    sections.push(section);
    cursor = section.end + 1;
  };
  if (!body.length) {
    push(options.fileName, csvMarkdown(rows, maxColumns));
    return sections;
  }
  const labelColumn = header.length > 1 && body.some((row) => (row[0] ?? '').trim().length > 0);
  if (!labelColumn) {
    push(options.fileName, csvMarkdown(rows, maxColumns));
    return sections;
  }
  let groupLabel;
  let groupRows = [];
  const flush = () => {
    if (!groupRows.length) return;
    push(groupLabel, csvMarkdown([header, ...groupRows], maxColumns));
    groupRows = [];
  };
  for (const row of body) {
    const label = (row[0] ?? '').replace(/^"|"$/g, '').trim();
    if (label && label !== groupLabel) {
      flush();
      groupLabel = label;
    }
    groupRows.push(row);
  }
  flush();
  return sections;
}

/** Detect the delimiter for a `.csv`/`.tsv`/table-ish file. */
export function detectDelimiter(text, fileName = '') {
  const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '';
  if (extension === '.tsv') return '\t';
  if (extension === '.csv') return ',';
  const sample = text.split(/\r?\n/).slice(0, 5).join('\n');
  const commas = (sample.match(/,/g) ?? []).length;
  const tabs = (sample.match(/\t/g) ?? []).length;
  const pipes = (sample.match(/\|/g) ?? []).length;
  if (tabs >= commas && tabs >= pipes && tabs > 0) return '\t';
  if (pipes > commas) return '|';
  return ',';
}

/** Pick the parser for a file by extension, and report the type/kind it maps to. */
export function detectFormat(fileName = '') {
  const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '';
  if (extension === '.md' || extension === '.markdown') return { format: 'markdown', kind: 'text', plainText: false };
  if (extension === '.txt' || extension === '.text' || extension === '') return { format: 'text', kind: 'text', plainText: true };
  if (extension === '.json') return { format: 'json', kind: 'structured' };
  if (extension === '.jsonl' || extension === '.ndjson') return { format: 'jsonl', kind: 'structured' };
  if (extension === '.csv') return { format: 'csv', kind: 'table' };
  if (extension === '.tsv') return { format: 'tsv', kind: 'table' };
  if (extension === '.xml' || extension === '.rels' || extension === '.svg') return { format: 'xml', kind: 'markup' };
  if (extension === '.yaml' || extension === '.yml') return { format: 'yaml', kind: 'structured' };
  return { format: 'unknown', kind: 'unknown' };
}

/** Extract a readable outline from XML markup without inventing a schema. */
export function parseXmlText(text, options = {}) {
  const trimmed = String(text).trim();
  if (!trimmed) throw new TextParseError('CORRUPT_INPUT', 'XML document is empty');
  if (!trimmed.startsWith('<')) throw new TextParseError('CORRUPT_INPUT', 'Document does not start with markup');
  const tag = options.tag ?? 't';
  const blocks = matchBlocks(trimmed, tag, options.limit ?? 10000);
  const runs = blocks.map((block) => extractTextRuns(block)).filter((run) => run.length > 0);
  const sections = runs.map((run, index) => ({
    kind: 'PARAGRAPH',
    text: run,
    start: index,
    end: index + run.length,
  }));
  return {
    format: 'xml',
    textRuns: runs.length,
    blocks: blocks.length,
    sections,
  };
}
