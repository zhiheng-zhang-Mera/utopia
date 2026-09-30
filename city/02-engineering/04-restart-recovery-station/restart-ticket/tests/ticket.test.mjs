/**
 * UTOPIA · Engineering District — restart ticket suite.
 *
 * The canonical checksum, the builder, the verification ladder, the rejection
 * vocabulary and the supervisor ledger's empty shape restate the donor
 * `dsh-restart` `src/plugin/ticket-store.ts` and `src/plugin/atomic.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd, frozen at that commit.
 *
 * The pinned digest below was computed against the donor's own canonical form
 * (`canonicalJson` with sorted keys -> `createHash('sha256').update(text, 'utf8')`)
 * and is asserted as a literal, so a change to the canonical form or to the digest
 * spelling fails here instead of silently re-baselining.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as surface from '../index.mjs';
import {
  ATOMICITY_CONTRACT,
  LEDGER_FIELDS,
  LEDGER_SCHEMA_VERSION,
  RESTART_MODES,
  TICKET_FIELDS,
  TICKET_REJECTIONS,
  TICKET_SCHEMA_VERSION,
  TicketRejection,
  buildTicket,
  canonicalJson,
  emptyLedger,
  sha256,
  ticketChecksum,
  ticketFromParsed,
  verifyTicket,
} from '../index.mjs';

/** The check clock: the ticket below is written at 00:00:00 and expires at 00:01:00. */
const NOW_MS = Date.parse('2026-05-01T00:00:30.000Z');
const WRITTEN_MS = Date.parse('2026-05-01T00:00:00.000Z');
const TTL_MS = 60_000;
const TICKET_PID = 4242;

/**
 * The digest of the ticket built from {@link draft} with {@link WRITTEN_MS} and
 * {@link TTL_MS}, computed from the donor's canonical form with `node -e`, never
 * guessed.
 */
const PINNED_CHECKSUM = 'sha256:c12d61303692fea8b4ab0f238efd78bbdb6554d6c154a2e587c5f07739185762';

/** The donor's six rejection codes and nothing else. */
const DONOR_REJECTIONS = ['missing', 'schema_version', 'malformed', 'checksum', 'expired', 'wrong_pid'];

test('the pinned digest is the donor digest, recomputed field by field', () => {
  assert.equal(PINNED_CHECKSUM.length, 71);
  assert.equal(PINNED_CHECKSUM.slice(7).length, 64);
  assert.equal(PINNED_CHECKSUM, pinnedTicket().checksum);
  assert.equal(sha256(canonicalJson(ticketFieldsOf(pinnedTicket()))), PINNED_CHECKSUM);
});

function draft(overrides = {}) {
  return {
    ticketId: 'ticket-0001',
    requestId: 'req-0001',
    mode: 'application',
    reasonCode: 'RUNTIME_PRESSURE',
    reasonSummary: 'memory pressure above the threshold',
    pid: TICKET_PID,
    ttlMs: TTL_MS,
    cleanShutdown: true,
    checkpointId: 'ckpt-0001',
    nowMs: WRITTEN_MS,
    ...overrides,
  };
}

/** The pinned ticket, rebuilt from the draft. */
function pinnedTicket() {
  return buildTicket(draft());
}

/** A ticket's fields without `checksum` — what the donor's rung 4 destructures. */
function ticketFieldsOf(ticket) {
  const { checksum: _checksum, ...fields } = ticket;
  return fields;
}

/** The same ticket with a checksum recomputed over whatever fields it now carries. */
function reChecksummed(candidate) {
  return { ...candidate, checksum: ticketChecksum(ticketFieldsOf(candidate)) };
}

test('a built ticket round-trips through the verification ladder', () => {
  const ticket = pinnedTicket();
  assert.deepEqual(ticket, {
    schemaVersion: TICKET_SCHEMA_VERSION,
    ticketId: 'ticket-0001',
    requestId: 'req-0001',
    mode: 'application',
    reasonCode: 'RUNTIME_PRESSURE',
    reasonSummary: 'memory pressure above the threshold',
    pid: TICKET_PID,
    createdAt: '2026-05-01T00:00:00.000Z',
    expiresAt: '2026-05-01T00:01:00.000Z',
    cleanShutdown: true,
    checkpointId: 'ckpt-0001',
    checksum: PINNED_CHECKSUM,
  });

  const verified = verifyTicket(ticket, NOW_MS, TICKET_PID);
  assert.equal(verified.valid, true);
  assert.equal(verified.rejection, null);
  assert.equal(verified.detail, 'ticket verified');
  assert.deepEqual(verified.ticket, ticket);

  // A JSON round-trip is the real path: the ticket is a document on disk.
  const parsed = JSON.parse(JSON.stringify(ticket));
  assert.deepEqual(verifyTicket(parsed, NOW_MS, TICKET_PID).ticket, ticket);
});

test('the builder fills the schema version and computes the checksum over every other field', () => {
  const ticket = pinnedTicket();
  assert.equal(ticket.schemaVersion, TICKET_SCHEMA_VERSION);

  const { checksum, ...rest } = ticket;
  assert.equal(checksum, ticketChecksum(rest));
  assert.equal(checksum, PINNED_CHECKSUM);
  assert.deepEqual(Object.keys(rest), [...TICKET_FIELDS].filter((field) => field !== 'checksum'));
  assert.equal(Object.keys(ticket).length, TICKET_FIELDS.length);

  // expiresAt is exactly nowMs + ttlMs, createdAt exactly nowMs, both ISO-8601.
  assert.equal(Date.parse(ticket.createdAt), WRITTEN_MS);
  assert.equal(Date.parse(ticket.expiresAt), WRITTEN_MS + ttlMsOrThrow(ticket));
  assert.equal(ticket.createdAt, new Date(WRITTEN_MS).toISOString());
  assert.equal(ticket.expiresAt, new Date(WRITTEN_MS + TTL_MS).toISOString());
});

/** The ttl the ticket was built with, read back from its two instants. */
function ttlMsOrThrow(ticket) {
  return Date.parse(ticket.expiresAt) - Date.parse(ticket.createdAt);
}

test('the digest is reproducible and independent of key insertion order', () => {
  const first = pinnedTicket();
  const second = pinnedTicket();
  assert.equal(first.checksum, second.checksum);
  assert.deepEqual(first, second);

  // Same fields, deliberately opposite insertion order in the object handed to the
  // digest. Nothing sorts the fields before they arrive; the canonical form sorts.
  const forwards = {
    schemaVersion: 1,
    ticketId: 'ticket-0001',
    requestId: 'req-0001',
    mode: 'application',
    reasonCode: 'RUNTIME_PRESSURE',
    reasonSummary: 'memory pressure above the threshold',
    pid: TICKET_PID,
    createdAt: '2026-05-01T00:00:00.000Z',
    expiresAt: '2026-05-01T00:01:00.000Z',
    cleanShutdown: true,
    checkpointId: 'ckpt-0001',
  };
  const reversed = Object.fromEntries(Object.entries(forwards).reverse());
  assert.notDeepEqual(Object.keys(forwards), Object.keys(reversed));
  assert.equal(ticketChecksum(forwards), ticketChecksum(reversed));
  assert.equal(ticketChecksum(forwards), PINNED_CHECKSUM);

  // The canonical form is the sorted-key object, spelled out.
  assert.equal(
    canonicalJson(forwards),
    '{"checkpointId":"ckpt-0001","cleanShutdown":true,"createdAt":"2026-05-01T00:00:00.000Z",' +
      '"expiresAt":"2026-05-01T00:01:00.000Z","mode":"application","pid":4242,' +
      '"reasonCode":"RUNTIME_PRESSURE","reasonSummary":"memory pressure above the threshold",' +
      '"requestId":"req-0001","schemaVersion":1,"ticketId":"ticket-0001"}',
  );
  assert.equal(sha256(canonicalJson(forwards)), PINNED_CHECKSUM);
});

test('sha256 is the donor digest spelling: sha256:<hex>, 64 lowercase hex digits', () => {
  assert.equal(sha256(''), 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.match(sha256('ticket'), /^sha256:[0-9a-f]{64}$/);
  assert.equal(sha256('ticket'), sha256('ticket'));
  assert.notEqual(sha256('ticket'), sha256('ticket '));
});

test('rejection missing: no document at all', () => {
  for (const absent of [null, undefined]) {
    const verified = verifyTicket(absent, NOW_MS, TICKET_PID);
    assert.equal(verified.valid, false);
    assert.equal(verified.rejection, TicketRejection.missing);
    assert.equal(verified.rejection, 'missing');
    assert.equal(verified.detail, 'no ticket file');
    assert.equal(verified.ticket, null);
  }
});

test('rejection malformed: a document that is not an object', () => {
  for (const primitive of [42, 'ticket', true, 0n]) {
    const verified = verifyTicket(primitive, NOW_MS, TICKET_PID);
    assert.equal(verified.valid, false);
    assert.equal(verified.rejection, 'malformed');
    assert.equal(verified.detail, 'ticket is not an object');
    assert.equal(verified.ticket, null);
  }
});

test("the donor's malformed rung is exactly `typeof candidate !== 'object'`", () => {
  // Arrays pass that test in the donor, so they are not malformed there: an array has
  // no `schemaVersion`, so it fails rung 3.
  for (const array of [[], [1, 2], [{ schemaVersion: 1 }]]) {
    const verified = verifyTicket(array, NOW_MS, TICKET_PID);
    assert.equal(verified.rejection, 'schema_version');
    assert.equal(verified.detail, `ticket schemaVersion ${String(array.schemaVersion)} is not ${TICKET_SCHEMA_VERSION}`);
  }

  // A function fails the same test, because `typeof fn` is `'function'`, not `'object'`.
  const fn = () => {};
  assert.equal(verifyTicket(fn, NOW_MS, TICKET_PID).rejection, 'malformed');
  assert.equal(verifyTicket(fn, NOW_MS, TICKET_PID).detail, 'ticket is not an object');
  assert.equal(verifyTicket(fn, NOW_MS, TICKET_PID).ticket, null);
});

test('a short or extra-fielded document is judged by the checksum rung, as in the donor', () => {
  const ticket = pinnedTicket();

  // Missing field, checksum still the one over the full ticket: the digest no longer
  // covers the fields received, which is the donor's `checksum` refusal.
  for (const missing of ['ticketId', 'requestId', 'mode', 'reasonCode', 'reasonSummary', 'pid', 'createdAt', 'expiresAt', 'cleanShutdown', 'checkpointId', 'checksum']) {
    const short = { ...ticket };
    delete short[missing];
    const verified = verifyTicket(short, NOW_MS, TICKET_PID);
    assert.equal(verified.valid, false, `${missing}: expected a refusal`);
    assert.equal(verified.rejection, 'checksum', `${missing}: expected checksum`);
    assert.equal(verified.detail, 'ticket checksum does not match its contents');
  }

  // Extra field the donor never reads, with a checksum that covers it: the donor
  // reaches `ticket verified`, because rung 4 hashes every field it received.
  const extra = { ...ticket, extra: 'not part of the ticket' };
  assert.equal(verifyTicket(reChecksummed(extra), NOW_MS, TICKET_PID).valid, true);
  assert.equal(verifyTicket(reChecksummed(extra), NOW_MS, TICKET_PID).detail, 'ticket verified');
  assert.equal(verifyTicket(reChecksummed(extra), NOW_MS, TICKET_PID).rejection, null);

  // The same extra field with the original checksum is a checksum failure.
  assert.equal(verifyTicket(extra, NOW_MS, TICKET_PID).rejection, 'checksum');

  // Extra field plus expired: the donor's `expired` rung, reached because the checksum
  // covers what was received.
  const extraPast = reChecksummed({ ...ticket, extra: 'x', expiresAt: '2000-01-01T00:00:00.000Z' });
  assert.equal(verifyTicket(extraPast, NOW_MS, TICKET_PID).rejection, 'expired');

  // A checksummed but mistyped pid and expiresAt reach the donor's own rungs, because
  // `Number.isFinite(Date.parse(...))` and `!==` are what the donor compares with.
  const typedPid = reChecksummed({ ...ticket, pid: '4242' });
  assert.equal(verifyTicket(typedPid, NOW_MS, TICKET_PID).rejection, 'wrong_pid');
  assert.equal(verifyTicket(typedPid, NOW_MS, TICKET_PID).detail, 'ticket targets pid 4242, not 4242');
  assert.equal(verifyTicket(typedPid, NOW_MS).valid, true);

  const typedExpiry = reChecksummed({ ...ticket, expiresAt: 'x' });
  assert.equal(verifyTicket(typedExpiry, NOW_MS, TICKET_PID).rejection, 'expired');
  assert.equal(verifyTicket(typedExpiry, NOW_MS, TICKET_PID).detail, 'ticket expired at x');

  const numericExpiry = reChecksummed({ ...ticket, expiresAt: 20260501 });
  assert.equal(verifyTicket(numericExpiry, NOW_MS, TICKET_PID).rejection, 'expired');
  assert.equal(verifyTicket(numericExpiry, NOW_MS, TICKET_PID).detail, 'ticket expired at 20260501');
});

test('rejection schema_version: a document from another schema', () => {
  const ticket = pinnedTicket();
  for (const wrong of [2, 0, TICKET_SCHEMA_VERSION + 1]) {
    const candidate = { ...ticket, schemaVersion: wrong };
    const verified = verifyTicket(candidate, NOW_MS, TICKET_PID);
    assert.equal(verified.valid, false);
    assert.equal(verified.rejection, 'schema_version');
    assert.equal(verified.detail, `ticket schemaVersion ${wrong} is not ${TICKET_SCHEMA_VERSION}`);
    assert.equal(verified.ticket, null);
  }

  // The donor's comparison is `!==`, so any value that is not the number 1 fails this
  // rung — it is never remade into one.
  for (const wrong of ['1', null, undefined, false, true, {}, Number.NaN, 1n, '01', '1.0']) {
    const candidate = { ...ticket, schemaVersion: wrong };
    const verified = verifyTicket(candidate, NOW_MS, TICKET_PID);
    assert.equal(verified.rejection, 'schema_version', `${String(wrong)}: expected schema_version`);
    assert.equal(verified.detail, `ticket schemaVersion ${String(wrong)} is not ${TICKET_SCHEMA_VERSION}`);
  }
});

test('rejection checksum: tampering with one field after the build', () => {
  const ticket = pinnedTicket();
  const tampers = [
    ['ticketId', 'ticket-9999'],
    ['requestId', 'req-9999'],
    ['mode', 'system'],
    ['reasonCode', 'OPERATOR_REQUEST'],
    ['reasonSummary', 'because I said so'],
    ['pid', TICKET_PID + 1],
    ['createdAt', '2026-05-01T00:00:01.000Z'],
    ['expiresAt', '2026-05-01T00:02:00.000Z'],
    ['cleanShutdown', false],
    ['checkpointId', null],
  ];
  for (const [field, value] of tampers) {
    const candidate = { ...ticket, [field]: value };
    const verified = verifyTicket(candidate, NOW_MS, TICKET_PID);
    assert.equal(verified.valid, false, `${field}: expected refusal`);
    assert.equal(verified.rejection, 'checksum', `${field}: expected checksum`);
    assert.equal(verified.detail, 'ticket checksum does not match its contents');
    assert.equal(verified.ticket, null);
  }

  // The stored digest itself, and a truncated one.
  const wrongDigest = { ...ticket, checksum: sha256('something else') };
  assert.equal(verifyTicket(wrongDigest, NOW_MS, TICKET_PID).rejection, 'checksum');
  const truncated = { ...ticket, checksum: ticket.checksum.slice(0, -1) };
  assert.equal(verifyTicket(truncated, NOW_MS, TICKET_PID).rejection, 'checksum');
  const reordered = Object.fromEntries(Object.entries(ticket).reverse());
  assert.equal(verifyTicket(reordered, NOW_MS, TICKET_PID).valid, true);
});

test('rejection expired: an unparsable or past expiry', () => {
  const ticket = pinnedTicket();

  const atExpiry = verifyTicket(ticket, Date.parse('2026-05-01T00:01:00.000Z'), TICKET_PID);
  assert.equal(atExpiry.valid, false);
  assert.equal(atExpiry.rejection, 'expired');
  assert.equal(atExpiry.detail, 'ticket expired at 2026-05-01T00:01:00.000Z');
  assert.equal(atExpiry.ticket, null);

  const after = verifyTicket(ticket, Date.parse('2026-05-01T00:01:00.001Z'), TICKET_PID);
  assert.equal(after.rejection, 'expired');
  assert.equal(after.detail, 'ticket expired at 2026-05-01T00:01:00.000Z');

  // One millisecond before expiry is still live — the boundary is `<=`, never `<`.
  assert.equal(verifyTicket(ticket, Date.parse('2026-05-01T00:00:59.999Z'), TICKET_PID).valid, true);

  // A checksummed but unparsable expiry is expired, not malformed: the document is
  // whole, its clock reading is not. This is the donor's own rung.
  const unparsable = { ...ticket, expiresAt: 'not-a-time' };
  const { checksum: _dropped, ...unparsableFields } = unparsable;
  unparsable.checksum = ticketChecksum(unparsableFields);
  const verified = verifyTicket(unparsable, NOW_MS, TICKET_PID);
  assert.equal(verified.rejection, 'expired');
  assert.equal(verified.detail, 'ticket expired at not-a-time');
  assert.equal(verified.ticket, null);
});

test('rejection wrong_pid: only when the caller supplies an expected pid', () => {
  const ticket = pinnedTicket();

  const mismatch = verifyTicket(ticket, NOW_MS, TICKET_PID + 1);
  assert.equal(mismatch.valid, false);
  assert.equal(mismatch.rejection, 'wrong_pid');
  assert.equal(mismatch.detail, `ticket targets pid ${TICKET_PID}, not ${TICKET_PID + 1}`);
  assert.equal(mismatch.ticket, null);

  assert.equal(verifyTicket(ticket, NOW_MS, TICKET_PID).valid, true);
  assert.equal(verifyTicket(ticket, NOW_MS).valid, true);
  assert.equal(verifyTicket(ticket, NOW_MS, undefined).valid, true);

  // The pid rung is last: a wrong pid on an expired ticket is an expiry, not a pid
  // mismatch, because the ladder stops at the first refusal.
  assert.equal(verifyTicket(ticket, Date.parse('2026-05-01T02:00:00.000Z'), TICKET_PID + 1).rejection, 'expired');
});

test("the ladder is the donor's six rungs, and no seventh can fire", () => {
  const ticket = pinnedTicket();
  const checksummed = (mutate) => reChecksummed(mutate({ ...ticket }));
  const candidates = [
    null,
    undefined,
    42,
    'ticket',
    true,
    0n,
    () => {},
    [],
    [1, 2],
    {},
    { schemaVersion: 2 },
    { schemaVersion: '1' },
    { schemaVersion: null },
    { ...ticket, schemaVersion: 2 },
    { ...ticket, ticketId: 'tampered' },
    { ...ticket, reasonSummary: 7 },
    { ...ticket, checksum: 'sha256:0000' },
    { ...ticket, checksum: 7 },
    checksummed((c) => delete c.expiresAt),
    checksummed((c) => (c.expiresAt = 'not-a-time')),
    checksummed((c) => (c.expiresAt = '2000-01-01T00:00:00.000Z')),
    checksummed((c) => (c.pid = 1)),
    checksummed((c) => (c.pid = '4242')),
    checksummed((c) => delete c.pid),
    checksummed((c) => (c.extra = 'undeclared field, covered by the checksum')),
    checksummed(() => ({})),
    ticket,
  ];
  for (const candidate of candidates) {
    const verdict = verifyTicket(candidate, NOW_MS, TICKET_PID);
    assert.deepEqual(Object.keys(verdict), ['valid', 'ticket', 'rejection', 'detail']);
    assert.equal(typeof verdict.valid, 'boolean');
    assert.equal(typeof verdict.detail, 'string');
    if (verdict.valid) {
      assert.equal(verdict.rejection, null);
      assert.equal(verdict.detail, 'ticket verified');
    } else {
      assert.equal(verdict.ticket, null);
      assert.ok(DONOR_REJECTIONS.includes(verdict.rejection), `${verdict.rejection} is not one of the donor's six`);
    }
  }

  assert.deepEqual(TICKET_REJECTIONS, DONOR_REJECTIONS);
});

test('the ladder stops at the first rung, in the donor order', () => {
  const ticket = pinnedTicket();

  // A missing document never reaches the object, schema, checksum, expiry or pid rung.
  assert.equal(verifyTicket(null, NOW_MS, TICKET_PID).rejection, 'missing');
  // Not an object beats every later rung.
  assert.equal(verifyTicket(42, NOW_MS, TICKET_PID).rejection, 'malformed');
  // The schema version beats the checksum and everything after it.
  assert.equal(verifyTicket({ ...ticket, schemaVersion: 9, reasonCode: 'X' }, NOW_MS, TICKET_PID).rejection, 'schema_version');
  // The checksum beats the expiry and the pid.
  assert.equal(verifyTicket({ ...ticket, reasonCode: 'X', expiresAt: '2000-01-01T00:00:00.000Z' }, NOW_MS, TICKET_PID).rejection, 'checksum');
  // The expiry beats the pid.
  assert.equal(verifyTicket(ticket, NOW_MS, TICKET_PID + 1).rejection, 'wrong_pid');
  assert.equal(verifyTicket(ticket, Date.parse('2026-05-01T02:00:00.000Z'), TICKET_PID + 1).rejection, 'expired');
  assert.equal(verifyTicket(reChecksummed({ ...ticket, expiresAt: '2000-01-01T00:00:00.000Z' }), NOW_MS, TICKET_PID + 1).rejection, 'expired');
});

test("the builder throws only where the donor's own date construction throws", () => {
  // The donor's `new Date(...).toISOString()` throws `RangeError: Invalid time value`
  // for a non-finite or out-of-range instant. There is no added guard, so the thrown
  // error is exactly the donor's and no extra draft shape is refused.
  const invalid = [
    [Number.NaN, TTL_MS],
    [Number.POSITIVE_INFINITY, TTL_MS],
    [Number.NEGATIVE_INFINITY, TTL_MS],
    [WRITTEN_MS, Number.NaN],
    [WRITTEN_MS, Number.POSITIVE_INFINITY],
    [WRITTEN_MS, Number.NEGATIVE_INFINITY],
    [8.64e15, TTL_MS],
    [WRITTEN_MS, 8.64e15],
    [undefined, TTL_MS],
    [WRITTEN_MS, undefined],
    [undefined, undefined],
    ['2026-05-01T00:00:00.000Z', TTL_MS],
    [WRITTEN_MS, '60000'],
  ];
  for (const [nowMs, ttlMs] of invalid) {
    assert.throws(() => buildTicket(draft({ nowMs, ttlMs })), RangeError, `nowMs ${String(nowMs)} ttlMs ${String(ttlMs)}`);
  }

  // Values the donor builds are still built: nothing new is rejected.
  const zeroTtl = buildTicket(draft({ ttlMs: 0 }));
  assert.equal(zeroTtl.expiresAt, zeroTtl.createdAt);
  assert.equal(verifyTicket(zeroTtl, NOW_MS - 1).rejection, 'expired');

  const negativeTtl = buildTicket(draft({ ttlMs: -1000 }));
  assert.equal(negativeTtl.expiresAt, '2026-04-30T23:59:59.000Z');
  assert.equal(verifyTicket(negativeTtl, NOW_MS).rejection, 'expired');

  const beyondRange = buildTicket(draft({ ttlMs: 8.64e15 - WRITTEN_MS }));
  assert.equal(beyondRange.expiresAt, new Date(WRITTEN_MS + (8.64e15 - WRITTEN_MS)).toISOString());
  assert.equal(beyondRange.expiresAt, new Date(8.64e15).toISOString());

  // The donor never reads `ttlFromMs`; the builder ignores it in exactly the same way.
  const withTtlFrom = buildTicket(draft({ ttlFromMs: WRITTEN_MS - 5000 }));
  assert.deepEqual(withTtlFrom, pinnedTicket());

  // A non-object draft fails the way the donor's field access fails.
  assert.throws(() => buildTicket(null), TypeError);
  assert.throws(() => buildTicket(undefined), TypeError);
});

test('the ticket factory never turns an invalid document into a valid one', () => {
  const ticket = pinnedTicket();

  // A tampered document is refused, not re-checksummed.
  assert.throws(() => ticketFromParsed({ fields: { ...ticket, pid: 1 }, checksum: ticket.checksum }), TypeError);
  // A document missing a field is refused instead of being handed on with the old digest.
  const short = { ...ticket };
  delete short.expiresAt;
  assert.throws(() => ticketFromParsed({ fields: short, checksum: short.checksum }), TypeError);
  // A document whose digest is not a digest is refused.
  assert.throws(() => ticketFromParsed({ fields: { ...ticket }, checksum: null }), TypeError);
  assert.throws(() => ticketFromParsed(), TypeError);

  // An honest document is rebuilt with the caller's checksum preserved, unfrozen and
  // with every field it carried — including one the verifier never reads.
  const extra = reChecksummed({ ...ticket, extra: 'kept verbatim' });
  const { checksum, ...extraFields } = extra;
  const rebuilt = ticketFromParsed({ fields: extraFields, checksum });
  assert.deepEqual(rebuilt, extra);
  assert.equal(Object.isFrozen(rebuilt), false);
  assert.equal(Object.isFrozen(ticket), false);
});

test('emptyLedger() has the donor shape exactly', () => {
  const ledger = emptyLedger();
  assert.deepEqual(ledger, {
    schemaVersion: 1,
    uncleanStarts: [],
    safeMode: false,
    safeModeReason: null,
    safeModeAt: null,
    relaunches: 0,
  });
  assert.equal(ledger.schemaVersion, LEDGER_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(ledger), [...LEDGER_FIELDS]);
  assert.deepEqual(JSON.parse(JSON.stringify(ledger)), ledger);

  // Fresh arrays: two ledgers never share the list they would mutate.
  const other = emptyLedger();
  assert.notEqual(ledger.uncleanStarts, other.uncleanStarts);
  ledger.uncleanStarts.push({ at: '2026-05-01T00:00:00.000Z', reason: 'CRASH' });
  assert.deepEqual(other.uncleanStarts, []);
});

test('the contract vocabulary is the donor vocabulary', () => {
  assert.equal(TICKET_SCHEMA_VERSION, 1);
  assert.deepEqual(RESTART_MODES, ['application', 'system']);
  assert.deepEqual(Object.values(TicketRejection).sort(), [...TICKET_REJECTIONS].sort());
  assert.deepEqual(TICKET_REJECTIONS, DONOR_REJECTIONS);
  assert.equal(TICKET_FIELDS.length, 12);
  const ticket = pinnedTicket();
  assert.deepEqual(Object.keys(ticket), [...TICKET_FIELDS]);
  assert.deepEqual(Object.keys(ticketFromParsed({ fields: ticketFieldsOf(ticket), checksum: ticket.checksum })), [...TICKET_FIELDS]);
  assert.deepEqual(ATOMICITY_CONTRACT.sequence, ['write sibling temp file', 'fsync the temp file', 'rename over the target']);
  assert.equal(ATOMICITY_CONTRACT.portedHere, false);

  // One export site: every symbol the tests above use is reachable from index.mjs.
  for (const name of [
    'buildTicket',
    'canonicalJson',
    'emptyLedger',
    'restartTicket',
    'sha256',
    'ticketChecksum',
    'ticketFromDocument',
    'ticketFromParsed',
    'verifyTicket',
  ]) {
    assert.equal(typeof surface[name], 'function', `index.mjs must export ${name}`);
  }
});
