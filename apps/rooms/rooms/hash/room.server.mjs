/**
 * UTOPIA · Rooms · Room 06 — Hash Room (server).
 *
 * Computes a SHA-256 digest for a local file. The browser hashes the file with
 * Web Crypto and this endpoint is only used as the local reference/verification
 * implementation. No upload happens: nothing is persisted, copied into .runtime-rooms/
 * or sent anywhere else. The room has no durable file.
 */

import { createRouter, sendJson } from '../../shared/http.mjs';
import { RoomValidationError } from '../../shared/room-kit.mjs';
import { createHash } from 'node:crypto';

/** SHA-256 of a UTF-8 string (reference path used by tests and the UI fallback). */
export function sha256OfString(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * Verify an expected digest against an actual one.
 * Comparison is case-insensitive and ignores surrounding whitespace.
 */
export function compareDigest(expected, actual) {
  const clean = (value) => String(value ?? '').trim().toLowerCase();
  const wanted = clean(expected);
  const got = clean(actual);
  if (!wanted) return { status: 'no-expectation', matches: null };
  if (!/^[0-9a-f]{64}$/.test(wanted)) return { status: 'invalid-expectation', matches: null };
  return { status: wanted === got ? 'match' : 'mismatch', matches: wanted === got };
}

/** Create the Hash Room route handler (no store). */
export function createHashRoom() {
  const route = createRouter([
    {
      method: 'POST',
      pattern: '/digest',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new RoomValidationError('payload must be a JSON object');
        }
        const text = String(payload.text ?? '');
        const algorithm = String(payload.algorithm ?? 'sha256');
        if (algorithm !== 'sha256') throw new RoomValidationError('only sha256 is supported');
        const digest = sha256OfString(text);
        const expectation = compareDigest(payload.expected, digest);
        sendJson(res, 200, {
          algorithm,
          digest,
          byteLength: Buffer.byteLength(text, 'utf8'),
          expectation,
        });
      },
    },
    {
      method: 'POST',
      pattern: '/verify',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new RoomValidationError('payload must be a JSON object');
        }
        const actual = String(payload.actual ?? '');
        if (!/^[0-9a-f]{64}$/i.test(actual.trim())) {
          throw new RoomValidationError('actual must be a 64 character hex SHA-256 digest');
        }
        sendJson(res, 200, { actual: actual.trim().toLowerCase(), expectation: compareDigest(payload.expected, actual) });
      },
    },
  ]);

  return { id: 'hash', handle: (context) => route(context), persistent: false };
}
