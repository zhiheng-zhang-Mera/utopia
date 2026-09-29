/**
 * UTOPIA · Rooms · Room 05 — Text Workshop (server).
 *
 * Pure local text processing. This room has no durable file at all: text is
 * transformed in memory and never written to .runtime-rooms/.
 */

import { createRouter, sendJson } from '../../shared/http.mjs';
import { RoomValidationError, requireString } from '../../shared/room-kit.mjs';
import {
  applyOperation,
  characterCount,
  diffLines,
  lineCount,
  summarize,
  wordCount,
} from '../../shared/text-tools.mjs';

export const OPERATIONS = [
  'trim',
  'normalize-whitespace',
  'remove-blank-lines',
  'sort-lines',
  'dedupe-lines',
  'upper',
  'lower',
  'title',
];

function textOf(payload, field = 'text') {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RoomValidationError('payload must be a JSON object');
  }
  return requireString(payload[field] ?? '', field);
}

/** Create the Text Workshop route handler (no store). */
export function createTextWorkshopRoom() {
  const route = createRouter([
    {
      method: 'GET',
      pattern: '/operations',
      handle: async ({ res }) => sendJson(res, 200, { operations: OPERATIONS }),
    },
    {
      method: 'POST',
      pattern: '/analyze',
      handle: async ({ res, readJson }) => {
        const text = textOf(await readJson());
        sendJson(res, 200, { stats: summarize(text), characters: characterCount(text), words: wordCount(text), lines: lineCount(text) });
      },
    },
    {
      method: 'POST',
      pattern: '/transform',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        const text = textOf(payload);
        const operation = requireString(payload.operation ?? '', 'operation');
        if (!OPERATIONS.includes(operation)) {
          throw new RoomValidationError(`operation must be one of ${OPERATIONS.join(', ')}`);
        }
        const options = {
          descending: Boolean(payload.descending),
          caseInsensitive: Boolean(payload.caseInsensitive),
        };
        const result = applyOperation(text, operation, options);
        sendJson(res, 200, { operation, options, result, stats: summarize(result) });
      },
    },
    {
      method: 'POST',
      pattern: '/diff',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        const left = requireString(payload.left ?? '', 'left');
        const right = requireString(payload.right ?? '', 'right');
        const rows = diffLines(left, right);
        sendJson(res, 200, {
          rows,
          added: rows.filter((row) => row.type === 'added').length,
          removed: rows.filter((row) => row.type === 'removed').length,
          same: rows.filter((row) => row.type === 'same').length,
        });
      },
    },
  ]);

  return { id: 'text-workshop', handle: (context) => route(context), persistent: false };
}
