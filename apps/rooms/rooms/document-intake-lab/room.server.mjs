/**
 * UTOPIA · Rooms · Room 14 — Document Intake Lab (server).
 *
 * Incubator for the Codex-Boss document intake core, D4a subset: decode text with
 * BOM/encoding detection, split markdown/plain text into offset-preserving
 * sections, parse JSON/JSON Lines, split CSV/TSV into table sections and extract
 * text runs from XML markup — all with hard input limits.
 *
 * Nothing is written into the existing Knowledge Room and no runtime file is
 * created. YAML is not accepted here (D4b) because the donor's YAML branch needs
 * an external parser.
 *
 * Donor: zhiheng-zhang-Mera/Codex-Boss @ 8df428eaa437a409368401e95194e40266b83080
 *        electron/ingestion/xml-text.ts, electron/ingestion/text-parsers.ts
 */

import { createRouter, sendJson } from '../../shared/http.mjs';
import { RoomValidationError } from '../../shared/room-kit.mjs';
import {
  DEFAULT_TEXT_LIMITS,
  TextParseError,
  decodeText,
  detectDelimiter,
  detectFormat,
  parseDelimited,
  parseStructuredText,
  parseTextSections,
  parseXmlText,
  sectionsFromDelimited,
  sectionsFromStructured,
} from './ingestion-core.mjs';

const MAX_BASE64_BYTES = 6 * 1024 * 1024;
const MAX_PREVIEW_SECTIONS = 200;

function requireObject(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RoomValidationError('payload must be a JSON object');
  }
  return payload;
}

function decodeBase64(value, field = 'base64') {
  if (typeof value !== 'string' || value.trim() === '') throw new RoomValidationError(`${field} must be a base64 string`);
  const normalized = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new RoomValidationError(`${field} is not valid base64`);
  }
  const buffer = Buffer.from(normalized, 'base64');
  if (buffer.length === 0) throw new RoomValidationError(`${field} decoded to zero bytes`);
  if (buffer.length > MAX_BASE64_BYTES) {
    throw new RoomValidationError(`document exceeds the ${Math.round(MAX_BASE64_BYTES / 1024 / 1024)} MB intake limit`);
  }
  return buffer;
}

function previewSections(sections) {
  return sections.slice(0, MAX_PREVIEW_SECTIONS).map((section) => ({
    kind: section.kind,
    heading: section.heading ?? null,
    level: section.level ?? null,
    start: section.start,
    end: section.end,
    characters: section.text.length,
    text: section.text.length > 400 ? `${section.text.slice(0, 400)}…` : section.text,
  }));
}

/** Run the intake pipeline for one decoded document. */
export function ingestDocument({ text, fileName = '', limits = {} }) {
  const effective = { ...DEFAULT_TEXT_LIMITS, ...limits };
  const detected = detectFormat(fileName);
  if (detected.deferred) {
    throw new RoomValidationError(`unsupported format ${detected.format}: ${detected.deferred}`);
  }
  const warnings = [];
  let sections = [];
  let format = detected.format;

  if (detected.format === 'markdown' || detected.format === 'text') {
    sections = parseTextSections(text, { plainText: detected.plainText, limits: effective });
  } else if (detected.format === 'json' || detected.format === 'jsonl') {
    const parsed = parseStructuredText(text, fileName);
    format = parsed.format;
    warnings.push(...parsed.warnings);
    sections = sectionsFromStructured(parsed.value, effective);
  } else if (detected.format === 'csv' || detected.format === 'tsv') {
    const delimiter = detectDelimiter(text, fileName);
    const table = parseDelimited(text, { delimiter, limits: effective });
    warnings.push(...table.warnings);
    sections = sectionsFromDelimited(table, { fileName, maxColumns: 64 });
    warnings.push(`delimiter: ${delimiter === '\t' ? 'tab' : delimiter}`);
  } else if (detected.format === 'xml') {
    const parsed = parseXmlText(text, { tag: 't', limit: effective.maxSections });
    sections = parsed.sections;
    warnings.push(`extracted ${parsed.textRuns} <t> run(s) from ${parsed.blocks} block(s)`);
  } else {
    // Unknown extension: fall back to plain-text splitting, never to a guess about
    // a binary format.
    sections = parseTextSections(text, { plainText: true, limits: effective });
    format = 'text';
    warnings.push('unknown extension; treated as plain text');
  }

  const contentType = sections.reduce((total, section) => total + section.text.length, 0);
  if (contentType > effective.maxContentLength) {
    throw new TextParseError('TOO_LARGE', `Parsed content exceeds the ${effective.maxContentLength}-character budget`);
  }

  return {
    fileName: fileName || null,
    format,
    kind: detected.kind,
    characters: text.length,
    sections: sections.length,
    contentCharacters: contentType,
    limits: effective,
    warnings,
    preview: previewSections(sections),
  };
}

/** Create the Document Intake Lab route handler (no durable store). */
export function createDocumentIntakeRoom() {
  const route = createRouter([
    {
      method: 'GET',
      pattern: '/capabilities',
      handle: async ({ res }) => {
        sendJson(res, 200, {
          room: 'document-intake-lab',
          writesToKnowledgeRoom: false,
          donor: {
            repository: 'zhiheng-zhang-Mera/Codex-Boss',
            commit: '8df428eaa437a409368401e95194e40266b83080',
            sourcePaths: ['electron/ingestion/xml-text.ts', 'electron/ingestion/text-parsers.ts'],
            deferredSourcePaths: ['electron/ingestion/pdf-reader.ts', 'electron/ingestion/docx-reader.ts', 'electron/ingestion/xlsx-reader.ts'],
          },
          accepts: ['txt', 'md', 'json', 'jsonl', 'csv', 'tsv', 'xml'],
          deferred: ['yaml/yml (D4b: external parser must be isolated first)', 'docx', 'xlsx', 'pdf'],
          limits: { ...DEFAULT_TEXT_LIMITS, maxIntakeBytes: MAX_BASE64_BYTES, maxPreviewSections: MAX_PREVIEW_SECTIONS },
        });
      },
    },
    {
      method: 'POST',
      pattern: '/ingest',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const fileName = typeof payload.fileName === 'string' ? payload.fileName : '';
        let text;
        let encoding = 'utf-8';
        const warnings = [];

        if (typeof payload.text === 'string') {
          text = payload.text;
        } else if (typeof payload.base64 === 'string') {
          const buffer = decodeBase64(payload.base64);
          const decoded = decodeText(new Uint8Array(buffer));
          text = decoded.text;
          encoding = decoded.encoding;
          warnings.push(...decoded.warnings);
        } else {
          throw new RoomValidationError('provide either text or base64');
        }

        const limits = {};
        if (payload.limits && typeof payload.limits === 'object') {
          for (const key of ['maxSections', 'maxBytes', 'maxContentLength', 'maxCsvRows']) {
            const value = Number(payload.limits[key]);
            if (Number.isFinite(value) && value > 0) limits[key] = Math.floor(value);
          }
        }

        try {
          const result = ingestDocument({ text, fileName, limits });
          sendJson(res, 200, { ok: true, encoding, warnings: [...warnings, ...result.warnings], ...result });
        } catch (error) {
          if (error instanceof TextParseError) {
            sendJson(res, 200, { ok: false, code: error.code, reason: error.message, fileName: fileName || null, encoding });
            return;
          }
          throw error;
        }
      },
    },
    {
      method: 'POST',
      pattern: '/detect',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const fileName = String(payload.fileName ?? '');
        sendJson(res, 200, { fileName, ...detectFormat(fileName) });
      },
    },
  ]);

  return { id: 'document-intake-lab', handle: (context) => route(context), persistent: false };
}
