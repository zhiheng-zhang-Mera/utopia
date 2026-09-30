/**
 * UTOPIA · Engineering — restart-recovery-station — canonical JSON tests.
 *
 * Donor: dsh-restart `src/shared/protocol.ts` (`canonicalJson`) @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd, plus the donor's own canonical-JSON
 * vectors from `tests/validation.test.js`.
 *
 * These assertions are pinned strings, not shapes: a ticket checksum is computed
 * over exactly this text by one process and recomputed by another, so the
 * ordering, the `undefined` handling and the separators are the contract. The
 * SHA-256 below was computed from the module's own output for a fixed document —
 * it is a digest, so changing the serialization changes it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { canonicalJson } from '../canonical-json.mjs';

/** One fixed document, used for the pinned digest. */
const FIXED = {
  ticketId: 'application-1-1-abcdef',
  requestId: 'req-1',
  mode: 'application',
  reasonCode: 'RUNTIME_PRESSURE',
  reasonSummary: 'health policy requested an application restart',
  schemaVersion: 1,
  cleanShutdown: true,
  checkpointId: null,
  nested: { z: [1, { b: 2, a: undefined }], a: null },
  dropped: undefined,
};

const FIXED_CANONICAL =
  '{"checkpointId":null,"cleanShutdown":true,"mode":"application","nested":{"a":null,"z":[1,{"b":2}]},' +
  '"reasonCode":"RUNTIME_PRESSURE","reasonSummary":"health policy requested an application restart",' +
  '"requestId":"req-1","schemaVersion":1,"ticketId":"application-1-1-abcdef"}';

/** sha256 of FIXED_CANONICAL, computed with `node -e` from this module's output. */
const FIXED_SHA256 = '492bdcfa2d5101ee02cd45fa356580390888689d0ecf3ecd3e8406066499e379';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

test('sorts object keys by code unit, independently of insertion order', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: 2, b: 1 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));

  // The comparator is `a < b`, i.e. UTF-16 code units: uppercase before lowercase.
  assert.equal(canonicalJson({ B: 1, a: 2, A: 3 }), '{"A":3,"B":1,"a":2}');

  // ...and string order, not numeric order, for numeric-looking keys.
  assert.equal(canonicalJson({ 10: 1, 9: 2 }), '{"10":1,"9":2}');
  assert.equal(canonicalJson({ 9: 2, 10: 1 }), '{"10":1,"9":2}');
});

test('drops undefined object values and renders array positions as null', () => {
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJson({ a: { b: undefined } }), '{"a":{}}');
  assert.equal(canonicalJson(undefined), 'null');
  assert.equal(canonicalJson([undefined, 1, { b: 2, a: 3 }]), '[null,1,{"a":3,"b":2}]');
  assert.equal(canonicalJson({ a: undefined }), '{}');
});

test('recurses through nested objects and arrays, keeping array order', () => {
  // Donor vector from tests/validation.test.js.
  assert.equal(canonicalJson({ a: [1, { d: 4, c: 3 }] }), '{"a":[1,{"c":3,"d":4}]}');

  const left = { z: [{ b: [2, 1], a: { d: 1, c: 2 } }], a: {} };
  const right = { a: {}, z: [{ a: { c: 2, d: 1 }, b: [2, 1] }] };
  assert.equal(canonicalJson(left), '{"a":{},"z":[{"a":{"c":2,"d":1},"b":[2,1]}]}');
  assert.equal(canonicalJson(left), canonicalJson(right));

  // Arrays are never reordered: only their elements are canonicalised.
  assert.equal(canonicalJson([{ b: 1, a: 2 }, { d: 3, c: 4 }]), '[{"a":2,"b":1},{"c":4,"d":3}]');
  assert.equal(canonicalJson([]), '[]');
  assert.equal(canonicalJson({}), '{}');
});

test('emits no whitespace and JSON-quotes every key', () => {
  assert.equal(canonicalJson({ a: 1, b: [1, 2] }), '{"a":1,"b":[1,2]}');
  assert.equal(canonicalJson({ 'a"b': 1 }), '{"a\\"b":1}');
  assert.equal(canonicalJson({ 'a\\b': 1 }), '{"a\\\\b":1}');
  assert.equal(canonicalJson({ '': 1 }), '{"":1}');
});

test('passes non-objects through JSON.stringify with the null fallback', () => {
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson('x'), '"x"');
  assert.equal(canonicalJson(42), '42');
  assert.equal(canonicalJson(true), 'true');
  assert.equal(canonicalJson(0), '0');

  // JSON.stringify answers undefined for these, so the `?? 'null'` fallback fires.
  assert.equal(canonicalJson(Symbol('s')), 'null');
  assert.equal(canonicalJson(() => {}), 'null');

  // Non-finite numbers are not JSON, and canonicalJson does not invent a form.
  assert.equal(canonicalJson({ a: NaN, b: Infinity, c: -Infinity }), '{"a":null,"b":null,"c":null}');
});

test('produces a pinned canonical form and sha256 digest for one fixed document', () => {
  const canonical = canonicalJson(FIXED);
  assert.equal(canonical, FIXED_CANONICAL);
  assert.equal(sha256(canonical), FIXED_SHA256);
  assert.equal(canonical.length, FIXED_CANONICAL.length);
});

test('the digest is stable when the same document is built in another key order', () => {
  const reordered = {
    nested: { a: null, z: [1, { a: undefined, b: 2 }] },
    dropped: undefined,
    checkpointId: null,
    cleanShutdown: true,
    schemaVersion: 1,
    reasonSummary: 'health policy requested an application restart',
    reasonCode: 'RUNTIME_PRESSURE',
    mode: 'application',
    requestId: 'req-1',
    ticketId: 'application-1-1-abcdef',
  };
  assert.equal(canonicalJson(reordered), FIXED_CANONICAL);
  assert.equal(sha256(canonicalJson(reordered)), FIXED_SHA256);
});

test('a different value is a different digest, so the pin is load-bearing', () => {
  const tampered = canonicalJson({ ...FIXED, reasonSummary: 'tampered' });
  assert.notEqual(tampered, FIXED_CANONICAL);
  assert.notEqual(sha256(tampered), FIXED_SHA256);
});
