/**
 * UTOPIA · Rooms · Room 07 — Data Lab (server).
 *
 * JSON parse / pretty / minify / validate with an error position and message,
 * plus a light CSV preview. No storage, no Excel, no database, no SQL.
 */

import { createRouter, sendJson } from '../../shared/http.mjs';
import { RoomValidationError, requireString } from '../../shared/room-kit.mjs';
import { summarizeCsv } from '../../shared/csv.mjs';

/** Parse JSON and report the failure position/line for a bad payload. */
export function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    const message = error.message;
    const positionMatch = /(?:at )?position (\d+)/.exec(message);
    const lineMatch = /line (\d+)/.exec(message);
    let line = lineMatch ? Number(lineMatch[1]) : null;
    let column = null;
    let position = positionMatch ? Number(positionMatch[1]) : null;

    // Newer V8 builds omit the position for "Unexpected token" errors and instead
    // quote the offending snippet; locate it so the UI can still point at a place.
    if (position === null) {
      const snippetMatch = /Unexpected token '([^']*)', "([\s\S]*)" is not valid JSON/.exec(message);
      if (snippetMatch) {
        const token = snippetMatch[1];
        const snippet = snippetMatch[2];
        if (token) {
          const at = text.indexOf(token);
          if (at >= 0) position = at;
        }
        if (position === null) {
          const snippetAt = text.indexOf(snippet);
          if (snippetAt >= 0) position = snippetAt;
        }
      }
    }
    if (position !== null && line === null) {
      const before = text.slice(0, position);
      const lines = before.split('\n');
      line = lines.length;
      column = lines[lines.length - 1].length + 1;
    }
    return { ok: false, message, position, line, column };
  }
}

/** Build a short structural description of a JSON value. */
export function describeJson(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return `object(${Object.keys(value).length} keys)`;
  return typeof value;
}

/** Create the Data Lab route handler (no store). */
export function createDataLabRoom() {
  const route = createRouter([
    {
      method: 'POST',
      pattern: '/json/parse',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        if (payload === null || typeof payload !== 'object') {
          throw new RoomValidationError('payload must be a JSON object');
        }
        const text = requireString(payload.text ?? '', 'text');
        const parsed = parseJson(text);
        if (!parsed.ok) {
          sendJson(res, 200, { ok: false, error: parsed });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          type: describeJson(parsed.value),
          pretty: `${JSON.stringify(parsed.value, null, 2)}\n`,
          minified: JSON.stringify(parsed.value),
        });
      },
    },
    {
      method: 'POST',
      pattern: '/json/transform',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        if (payload === null || typeof payload !== 'object') {
          throw new RoomValidationError('payload must be a JSON object');
        }
        const text = requireString(payload.text ?? '', 'text');
        const mode = String(payload.mode ?? 'pretty');
        if (mode !== 'pretty' && mode !== 'minify' && mode !== 'validate') {
          throw new RoomValidationError('mode must be pretty, minify or validate');
        }
        const parsed = parseJson(text);
        if (!parsed.ok) {
          sendJson(res, 200, { ok: false, error: parsed });
          return;
        }
        if (mode === 'validate') {
          sendJson(res, 200, { ok: true, mode, type: describeJson(parsed.value) });
          return;
        }
        const value = mode === 'pretty' ? `${JSON.stringify(parsed.value, null, 2)}\n` : JSON.stringify(parsed.value);
        sendJson(res, 200, { ok: true, mode, value, type: describeJson(parsed.value) });
      },
    },
    {
      method: 'POST',
      pattern: '/csv/preview',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        if (payload === null || typeof payload !== 'object') {
          throw new RoomValidationError('payload must be a JSON object');
        }
        const text = requireString(payload.text ?? '', 'text');
        if (!text.trim()) throw new RoomValidationError('csv text must not be empty');
        const previewRows = Number.isInteger(payload.previewRows) ? Math.min(Math.max(payload.previewRows, 1), 200) : 50;
        try {
          sendJson(res, 200, summarizeCsv(text, { previewRows }));
        } catch (error) {
          throw new RoomValidationError(`csv could not be parsed: ${error.message}`);
        }
      },
    },
  ]);

  return { id: 'data-lab', handle: (context) => route(context), persistent: false };
}
