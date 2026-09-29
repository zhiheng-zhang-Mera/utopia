/**
 * Room 06 — Hash Room focused tests (budget: <= 3).
 * The reference digest is checked against Node's own crypto implementation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { startTestHub } from './harness.mjs';
import { compareDigest, sha256OfString } from '../rooms/hash/room.server.mjs';

test('hash room digest matches Node crypto for fixed inputs', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const cases = ['', 'abc', 'Utopia Room Pack V1', '中文内容'];
  for (const text of cases) {
    const response = await hub.api('POST', '/local-rooms/v1/hash/digest', { text });
    const expected = createHash('sha256').update(text, 'utf8').digest('hex');
    assert.equal(response.payload.digest, expected, `digest for ${JSON.stringify(text)}`);
    assert.equal(response.payload.byteLength, Buffer.byteLength(text, 'utf8'));
    assert.equal(response.payload.expectation.status, 'no-expectation');
  }
  assert.equal(sha256OfString('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('hash room compares an expected digest and reports match or mismatch', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  const digest = createHash('sha256').update('sample').digest('hex');

  const match = await hub.api('POST', '/local-rooms/v1/hash/verify', { actual: digest.toUpperCase(), expected: digest });
  assert.equal(match.payload.expectation.status, 'match');
  assert.equal(match.payload.expectation.matches, true);

  const mismatch = await hub.api('POST', '/local-rooms/v1/hash/verify', { actual: digest, expected: 'a'.repeat(64) });
  assert.equal(mismatch.payload.expectation.status, 'mismatch');

  assert.equal((await hub.api('POST', '/local-rooms/v1/hash/verify', { actual: 'not-hex', expected: digest })).status, 400);
  assert.deepEqual(compareDigest('', digest), { status: 'no-expectation', matches: null });
  assert.deepEqual(compareDigest('short', digest), { status: 'invalid-expectation', matches: null });
});

test('hash room rejects unknown algorithms and writes nothing to runtime', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  assert.equal((await hub.api('POST', '/local-rooms/v1/hash/digest', { text: 'x', algorithm: 'md5' })).status, 400);
  assert.equal((await hub.api('POST', '/local-rooms/v1/hash/digest', { text: 'x' })).status, 200);
  assert.deepEqual(await readdir(hub.runtimeDir), [], 'file contents are never persisted by this room');
});
