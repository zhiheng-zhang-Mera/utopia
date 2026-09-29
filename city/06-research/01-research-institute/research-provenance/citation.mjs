/**
 * UTOPIA · Research Institute — citation verification.
 *
 * The deterministic ladder over citation evidence, the hard rule that a primary
 * claim may not rest on an UNSUPPORTED citation, and the audit summary a manuscript
 * tree reports. Every function is a pure function of its records.
 *
 * Ported from the Codex-Boss donor `src/shared/research-citation.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. The donor's TypeScript types are
 * replaced by the frozen vocabularies and copy-on-construct shapes in
 * `./contracts.mjs`; the ladder, the statuses and the audit arithmetic are the
 * donor's, unchanged.
 *
 * The rules that must never be softened:
 *   - a citation status is never guessed upward: no source means UNSUPPORTED (or
 *     METADATA_ONLY when just the metadata was verified), no located passage means
 *     SOURCE_RETRIEVED, and a contradicting passage is CONTRADICTED *before* any
 *     support question is asked;
 *   - `primaryClaimSupported` reports every UNSUPPORTED id, and one is enough to
 *     refuse the claim;
 *   - `summarizeCitationAudit` recomputes everything from the records, so a summary
 *     can never disagree with the records it describes.
 */

import {
  CITATION_LADDER,
  VERIFIED_CITATION_STATUSES,
  citationRecord,
  validateCitationRecord,
} from './contracts.mjs';

export {
  CITATION_LADDER,
  VERIFIED_CITATION_STATUSES,
  citationRecord,
  validateCitationRecord,
} from './contracts.mjs';

/**
 * Deterministic verification ladder: the max status reachable from the evidence.
 *
 * The donor asks its questions in a fixed order, and so does this port: acquisition
 * first, then the located passage, then contradiction, then support. `PARTIAL` is
 * never reached here — it is a deliberate human verdict, not something evidence
 * computes.
 *
 * @param {{sourceAcquired: boolean, metadataVerified: boolean, passageLocated: boolean, passageSupports: boolean, passageContradicts?: boolean}} input
 * @returns {string} one of CITATION_LADDER
 */
export function verifyCitation(input) {
  if (!input.sourceAcquired) return input.metadataVerified ? 'METADATA_ONLY' : 'UNSUPPORTED';
  if (!input.passageLocated) return 'SOURCE_RETRIEVED';
  if (input.passageContradicts) return 'CONTRADICTED';
  return input.passageSupports ? 'CLAIM_SUPPORTED' : 'PASSAGE_VERIFIED';
}

/**
 * Primary claims may not rely on UNSUPPORTED citations (hard rule).
 *
 * @param {object[]} records
 * @returns {{ok: boolean, unsupported: string[]}} the ids that refuse the claim
 */
export function primaryClaimSupported(records) {
  const unsupported = records.filter((record) => record.status === 'UNSUPPORTED').map((record) => record.id);
  return { ok: unsupported.length === 0, unsupported };
}

/**
 * Deterministic audit over citation records for the manuscript audit tree.
 *
 * `perStatus` is built in first-encounter order and carries only the statuses that
 * actually occur; `verified` counts the statuses in VERIFIED_CITATION_STATUSES;
 * `ok` requires no UNSUPPORTED id and no CONTRADICTED id.
 *
 * @param {object[]} records
 * @returns {{total: number, perStatus: object, verified: number, unsupportedIds: string[], contradictedIds: string[], ok: boolean}}
 */
export function summarizeCitationAudit(records) {
  const perStatus = {};
  for (const record of records) perStatus[record.status] = (perStatus[record.status] ?? 0) + 1;
  const verified = records.filter((record) => VERIFIED_CITATION_STATUSES.includes(record.status)).length;
  const unsupportedIds = records.filter((record) => record.status === 'UNSUPPORTED').map((record) => record.id);
  const contradictedIds = records.filter((record) => record.status === 'CONTRADICTED').map((record) => record.id);
  return { total: records.length, perStatus, verified, unsupportedIds, contradictedIds, ok: unsupportedIds.length === 0 && contradictedIds.length === 0 };
}
