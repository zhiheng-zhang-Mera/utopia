/**
 * UTOPIA · Research Institute — citation verification suite.
 *
 * The ladder, the primary-claim hard rule and the audit arithmetic restate the
 * Codex-Boss donor `src/shared/research-citation.ts` @
 * 8df428eaa437a409368401e95194e40266b83080: the same statuses, the same question
 * order, the same refusal messages and the same arithmetic. Nothing is upgraded on
 * the way in, and nothing is guessed on the way out.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CITATION_LADDER,
  VERIFIED_CITATION_STATUSES,
  primaryClaimSupported,
  summarizeCitationAudit,
  verifyCitation,
} from '../index.mjs';

const record = (id, status) => ({ id, proposedTitle: `title ${id}`, status, reasons: [], updatedAt: '2026-09-29T00:00:00.000Z' });

test('the ladder returns exactly the status the evidence reaches, in the donor order', () => {
  // no source: metadata alone is the only thing that can be said
  assert.equal(verifyCitation({ sourceAcquired: false, metadataVerified: false, passageLocated: false, passageSupports: false }), 'UNSUPPORTED');
  assert.equal(verifyCitation({ sourceAcquired: false, metadataVerified: true, passageLocated: false, passageSupports: false }), 'METADATA_ONLY');

  // acquired but no located passage stops at SOURCE_RETRIEVED
  assert.equal(verifyCitation({ sourceAcquired: true, metadataVerified: false, passageLocated: false, passageSupports: true }), 'SOURCE_RETRIEVED');
  assert.equal(verifyCitation({ sourceAcquired: true, metadataVerified: true, passageLocated: false, passageSupports: true }), 'SOURCE_RETRIEVED');

  // a located passage that does not support the claim is PASSAGE_VERIFIED, never CLAIM_SUPPORTED
  assert.equal(verifyCitation({ sourceAcquired: true, metadataVerified: true, passageLocated: true, passageSupports: false }), 'PASSAGE_VERIFIED');
  assert.equal(verifyCitation({ sourceAcquired: true, metadataVerified: true, passageLocated: true, passageSupports: true }), 'CLAIM_SUPPORTED');

  // contradiction is asked before support, so a contradicting passage can never be upgraded
  assert.equal(verifyCitation({ sourceAcquired: true, metadataVerified: true, passageLocated: true, passageSupports: false, passageContradicts: true }), 'CONTRADICTED');
  assert.equal(verifyCitation({ sourceAcquired: true, metadataVerified: true, passageLocated: true, passageSupports: true, passageContradicts: true }), 'CONTRADICTED');
  assert.equal(verifyCitation({ sourceAcquired: true, metadataVerified: true, passageLocated: true, passageSupports: true, passageContradicts: false }), 'CLAIM_SUPPORTED');

  // an explicit false is the donor's "no contradiction"; an absent flag is the same
  assert.equal(verifyCitation({ sourceAcquired: true, metadataVerified: true, passageLocated: true, passageSupports: false, passageContradicts: false }), 'PASSAGE_VERIFIED');
  assert.equal(verifyCitation({ sourceAcquired: true, metadataVerified: true, passageLocated: true, passageSupports: false }), 'PASSAGE_VERIFIED');

  // acquisition is asked first: a contradiction without a source cannot be claimed
  assert.equal(verifyCitation({ sourceAcquired: false, metadataVerified: true, passageLocated: true, passageSupports: true, passageContradicts: true }), 'METADATA_ONLY');
  assert.equal(verifyCitation({ sourceAcquired: false, metadataVerified: false, passageLocated: true, passageSupports: true, passageContradicts: true }), 'UNSUPPORTED');

  // every transition lands on the ladder, and the ladder never computes PARTIAL
  const reached = new Set();
  for (const sourceAcquired of [false, true]) {
    for (const metadataVerified of [false, true]) {
      for (const passageLocated of [false, true]) {
        for (const passageSupports of [false, true]) {
          for (const passageContradicts of [false, true]) {
            const status = verifyCitation({ sourceAcquired, metadataVerified, passageLocated, passageSupports, passageContradicts });
            assert.ok(CITATION_LADDER.includes(status), `${status} is on the ladder`);
            assert.notEqual(status, 'PARTIAL', 'PARTIAL is a deliberate human verdict, never computed');
            reached.add(status);
          }
        }
      }
    }
  }
  assert.deepEqual([...reached].sort(), ['CLAIM_SUPPORTED', 'CONTRADICTED', 'METADATA_ONLY', 'PASSAGE_VERIFIED', 'SOURCE_RETRIEVED', 'UNSUPPORTED']);
});

test('a primary claim is refused while any citation is UNSUPPORTED', () => {
  assert.deepEqual(primaryClaimSupported([]), { ok: true, unsupported: [] });
  assert.deepEqual(primaryClaimSupported([record('a', 'CLAIM_SUPPORTED'), record('b', 'PARTIAL')]), { ok: true, unsupported: [] });

  const refused = primaryClaimSupported([record('a', 'CLAIM_SUPPORTED'), record('b', 'UNSUPPORTED'), record('c', 'UNSUPPORTED')]);
  assert.deepEqual(refused, { ok: false, unsupported: ['b', 'c'] });
  assert.equal(refused.ok, false);

  // METADATA_ONLY is not UNSUPPORTED (the donor rule names exactly one blocking status)
  assert.deepEqual(primaryClaimSupported([record('a', 'METADATA_ONLY')]), { ok: true, unsupported: [] });
  // and the donor rule does not name CONTRADICTED: it is the audit, not this rule, that blocks it
  assert.deepEqual(primaryClaimSupported([record('a', 'CONTRADICTED')]), { ok: true, unsupported: [] });
});

test('the audit summarises the records it was given, without inventing citations', () => {
  const records = [
    record('a', 'SOURCE_RETRIEVED'),
    record('b', 'CLAIM_SUPPORTED'),
    record('c', 'PARTIAL'),
    record('d', 'METADATA_ONLY'),
    record('e', 'CONTRADICTED'),
    record('f', 'UNSUPPORTED'),
    record('g', 'SOURCE_RETRIEVED'),
  ];
  const summary = summarizeCitationAudit(records);
  assert.equal(summary.total, 7);
  assert.equal(summary.verified, 4, 'SOURCE_RETRIEVED x2 + CLAIM_SUPPORTED + PARTIAL');
  assert.deepEqual(summary.unsupportedIds, ['f']);
  assert.deepEqual(summary.contradictedIds, ['e']);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.perStatus, {
    SOURCE_RETRIEVED: 2,
    CLAIM_SUPPORTED: 1,
    PARTIAL: 1,
    METADATA_ONLY: 1,
    CONTRADICTED: 1,
    UNSUPPORTED: 1,
  });
  // perStatus is built in first-encounter order, so a report reads in record order
  assert.deepEqual(Object.keys(summary.perStatus), ['SOURCE_RETRIEVED', 'CLAIM_SUPPORTED', 'PARTIAL', 'METADATA_ONLY', 'CONTRADICTED', 'UNSUPPORTED']);

  // verified counts exactly VERIFIED_CITATION_STATUSES and nothing else
  for (const status of CITATION_LADDER) {
    const one = summarizeCitationAudit([record('x', status)]);
    assert.equal(one.verified, VERIFIED_CITATION_STATUSES.includes(status) ? 1 : 0, `${status} verified count`);
    assert.equal(one.total, 1);
    assert.deepEqual(one.perStatus, { [status]: 1 });
  }

  // no records at all: nothing verified, nothing blocking — the donor does not treat
  // an empty bibliography as a failure
  assert.deepEqual(summarizeCitationAudit([]), { total: 0, perStatus: {}, verified: 0, unsupportedIds: [], contradictedIds: [], ok: true });
  // only non-blocking statuses: the audit passes even though nothing is verified
  assert.deepEqual(summarizeCitationAudit([record('a', 'METADATA_ONLY')]).ok, true);
  assert.deepEqual(summarizeCitationAudit([record('a', 'PASSAGE_VERIFIED')]), {
    total: 1,
    perStatus: { PASSAGE_VERIFIED: 1 },
    verified: 1,
    unsupportedIds: [],
    contradictedIds: [],
    ok: true,
  });

  // the audit does not validate: an unknown status is counted, never verified and never blocking
  const unknown = summarizeCitationAudit([record('a', 'VERIFIED')]);
  assert.deepEqual(unknown.perStatus, { VERIFIED: 1 });
  assert.equal(unknown.verified, 0);
  assert.equal(unknown.ok, true);

  // ok is false when either blocking list is non-empty, and only the ids of that status appear
  assert.deepEqual(summarizeCitationAudit([record('a', 'CONTRADICTED')]).contradictedIds, ['a']);
  assert.equal(summarizeCitationAudit([record('a', 'CONTRADICTED')]).ok, false);
  assert.deepEqual(summarizeCitationAudit([record('a', 'UNSUPPORTED')]).unsupportedIds, ['a']);
  assert.equal(summarizeCitationAudit([record('a', 'UNSUPPORTED')]).ok, false);
  // duplicate ids are reported twice: the audit reports records, it does not widen them
  assert.deepEqual(summarizeCitationAudit([record('a', 'UNSUPPORTED'), record('a', 'UNSUPPORTED')]).unsupportedIds, ['a', 'a']);
});
