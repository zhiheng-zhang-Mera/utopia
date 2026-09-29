/**
 * UTOPIA · Rooms · Room D7b — Document Readers Lab (server).
 *
 * Incubator for the three office/PDF readers. The room hands bytes to a reader and
 * returns what the reader really produced: type, counts, warnings, the extracted
 * preview and the truncation or limit result. The original document is never
 * persisted, never re-encoded and never written anywhere.
 *
 * Donor: zhiheng-zhang-Mera/Codex-Boss @ 8df428eaa437a409368401e95194e40266b83080
 *        electron/ingestion/docx-reader.ts, xlsx-reader.ts, pdf-reader.ts
 */

import { createRouter, sendJson } from '../../shared/http.mjs';
import { RoomValidationError } from '../../shared/room-kit.mjs';
import { SAMPLE_KINDS, buildSample } from './samples.mjs';
import { DEFAULT_DOCX_LIMITS, extractDocx } from './docx.mjs';
import { DEFAULT_XLSX_LIMITS, extractXlsx } from './xlsx.mjs';
import { DEFAULT_PDF_LIMITS, extractPdf } from './pdf.mjs';
import { enginesProvenance } from './engine-bridge.mjs';

const DONOR = Object.freeze({
  repository: 'zhiheng-zhang-Mera/Codex-Boss',
  commit: '8df428eaa437a409368401e95194e40266b83080',
  sourcePaths: [
    'electron/ingestion/docx-reader.ts',
    'electron/ingestion/xlsx-reader.ts',
    'electron/ingestion/pdf-reader.ts',
  ],
});

/** Which reader serves which kind, and the limits it defaults to. */
const READERS = Object.freeze({
  docx: { extension: '.docx', limits: DEFAULT_DOCX_LIMITS, extract: extractDocx },
  xlsx: { extension: '.xlsx', limits: DEFAULT_XLSX_LIMITS, extract: extractXlsx },
  pdf: { extension: '.pdf', limits: DEFAULT_PDF_LIMITS, extract: extractPdf },
});

/** Hard cap on a request body, so the room can never be asked to buffer the world. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function requireObject(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RoomValidationError('payload must be a JSON object');
  }
  return payload;
}

function requireKind(payload) {
  const kind = String(payload.kind || '').toLowerCase().replace(/^\./, '');
  if (!Object.prototype.hasOwnProperty.call(READERS, kind)) {
    throw new RoomValidationError(`kind must be one of ${Object.keys(READERS).join(', ')}`);
  }
  return kind;
}

function requireBase64(payload) {
  if (typeof payload.base64 !== 'string' || !payload.base64.trim()) {
    throw new RoomValidationError('base64 must be a non-empty string');
  }
  let bytes;
  try {
    bytes = Buffer.from(payload.base64, 'base64');
  } catch (error) {
    throw new RoomValidationError(`base64 could not be decoded: ${error.message}`);
  }
  if (!bytes.length) throw new RoomValidationError('the decoded document is empty');
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new RoomValidationError(`the document is ${bytes.length} bytes, above the ${MAX_UPLOAD_BYTES}-byte room cap`, 413);
  }
  return bytes;
}

function optionalLimits(payload, defaults) {
  if (payload.limits === undefined || payload.limits === null) return {};
  if (typeof payload.limits !== 'object' || Array.isArray(payload.limits)) {
    throw new RoomValidationError('limits must be a JSON object');
  }
  const limits = {};
  for (const [key, value] of Object.entries(payload.limits)) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
      throw new RoomValidationError(`limits.${key} is not a limit of this reader`);
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) throw new RoomValidationError(`limits.${key} must be a positive number`);
    limits[key] = numeric;
  }
  return limits;
}

/** A short, renderer-safe preview of whatever the reader produced. */
function previewOf(extraction) {
  if (typeof extraction?.markdown === 'string' && extraction.markdown.trim()) return extraction.markdown;
  if (typeof extraction?.html === 'string' && extraction.html.trim()) return extraction.html;
  if (typeof extraction?.text === 'string' && extraction.text.trim()) return extraction.text;
  if (Array.isArray(extraction?.paragraphs) && extraction.paragraphs.length) {
    return extraction.paragraphs.map((paragraph) => (typeof paragraph === 'string' ? paragraph : paragraph?.text ?? '')).join('\n');
  }
  if (typeof extraction?.pages !== 'undefined' && extraction.pages !== null) return JSON.stringify(extraction.pages, null, 2).slice(0, 4000);
  return '';
}

/** Fold a reader's result into the room's report shape. */
function report(kind, bytes, extraction) {
  const warnings = Array.isArray(extraction?.warnings) ? extraction.warnings.slice() : [];
  const counts = {};
  if (Array.isArray(extraction?.sheets)) {
    counts.sheets = extraction.sheets.length;
    counts.rows = extraction.sheets.reduce((total, sheet) => total + (sheet.rows?.length ?? 0), 0);
    counts.columns = extraction.sheets.reduce((total, sheet) => total + (sheet.usedRange?.columns ?? 0), 0);
  }
  if (Array.isArray(extraction?.pages)) counts.pages = extraction.pages.length;
  if (Array.isArray(extraction?.paragraphs)) counts.paragraphs = extraction.paragraphs.length;
  const preview = previewOf(extraction);
  return {
    ok: true,
    kind,
    bytes: bytes.length,
    counts,
    warnings,
    truncated: Boolean(extraction?.truncated) || warnings.some((warning) => /truncat|limit/i.test(String(warning))),
    preview,
    extraction,
  };
}

/** Create the Document Readers Lab route handler (no durable store). */
export function createDocumentReadersRoom() {
  const route = createRouter([
    {
      method: 'GET',
      pattern: '/capabilities',
      handle: async ({ res }) => {
        sendJson(res, 200, {
          room: 'document-readers-lab',
          installs: false,
          writes_files: false,
          persists_input: false,
          donor: DONOR,
          readers: Object.entries(READERS).map(([kind, entry]) => ({ kind, extension: entry.extension, limits: entry.limits })),
          engines: enginesProvenance(),
          samples: SAMPLE_KINDS,
          max_upload_bytes: MAX_UPLOAD_BYTES,
          reuse: {
            engines: 'city/09-planning-knowledge/02-document-intake/document-readers/engines.mjs',
            xml: 'city/09-planning-knowledge/02-document-intake/ingestion-core/ingestion-core.mjs',
            note: 'the third-party engines are quarantined in the city tree and reached through one bridge; this room never copies them',
          },
        });
      },
    },
    {
      method: 'POST',
      pattern: '/read',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const kind = requireKind(payload);
        const bytes = requireBase64(payload);
        const reader = READERS[kind];
        const limits = optionalLimits(payload, reader.limits);
        try {
          const extraction = await reader.extract(new Uint8Array(bytes), limits);
          sendJson(res, 200, report(kind, bytes, extraction));
        } catch (error) {
          // A refused document is a product answer: report the typed code and the
          // reader's own reason instead of a transport failure.
          const code = error?.code ?? 'READER_ERROR';
          sendJson(res, 200, {
            ok: false,
            kind,
            bytes: bytes.length,
            code,
            reason: String(error?.message || error),
            name: error?.name ?? 'Error',
          });
        }
      },
    },
    {
      method: 'POST',
      pattern: '/sample',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const kind = String(payload.kind || '').toLowerCase();
        if (!SAMPLE_KINDS.includes(kind)) throw new RoomValidationError(`kind must be one of ${SAMPLE_KINDS.join(', ')}`);
        const sample = await buildSample(kind);
        sendJson(res, 200, {
          ok: true,
          kind: sample.kind,
          fileName: sample.fileName,
          bytes: sample.bytesLength,
          base64: sample.bytes.toString('base64'),
        });
      },
    },
  ]);

  return { id: 'document-readers-lab', handle: route };
}
