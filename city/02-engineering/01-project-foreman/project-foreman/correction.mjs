/**
 * UTOPIA · City · Project Foreman — human corrections on an auto-generated RFC draft.
 *
 * An RFC draft is generated from telemetry/evaluation/failure clusters; a human
 * may then correct individual text fields (problem, hypothesis, fix, risk, …).
 * Corrections are durable, keyed by the failure cluster they amend, and re-applied
 * on top of the generated draft so later rounds (self-modification review) see the
 * human-adjusted version — never a silently overwritten one.
 *
 * Donor provenance: Codex-Boss `src/shared/correction.ts` @
 * 8df428eaa437a409368401e95194e40266b83080, ported from TypeScript to ESM. Pure
 * and dependency-free: the donor's only import, `type { RfcDraft } from
 * "./self-diagnosis"`, is a type-only import with no runtime binding, so the port
 * has no imports at all and the draft's shape is documented in JSDoc instead.
 *
 * Two donor semantics are preserved exactly because they are easy to "fix" by
 * accident, and a port is not the place to fix them:
 *
 *  * **The cluster key is not used by the merge.** `RfcCorrection.clusterKey` is
 *    documented as the key the correction amends, but `applyCorrections()` selects
 *    the latest correction *per field* across every correction it is handed; it
 *    never filters or groups by `clusterKey`. Preserved as-is and reported.
 *  * **An empty correction set returns the same draft object.** When nothing
 *    applies the donor returns `draft` itself, not a copy, so identity is
 *    preserved for callers that compare by reference. Preserved as-is.
 *
 * @module project-foreman/correction
 */

/**
 * RFC text fields a human may correct (structured `evidence` is excluded).
 *
 * Private, exactly as in the donor: the donor's runtime surface is
 * `isCorrectableField` and `applyCorrections` only, and its `RfcCorrection` /
 * `CorrectableRfcField` types are erased. Adding an export here would widen the
 * module's contract beyond the donor's.
 */
const CORRECTABLE_RFC_FIELDS = Object.freeze([
  'problem', 'hypothesis', 'candidateFix', 'expectedBenefit',
  'risk', 'benchmark', 'rollback', 'compatibilityImpact',
]);

/**
 * The shape of a generated RFC draft, for documentation only.
 *
 * @typedef {object} RfcDraft
 * @property {string} problem
 * @property {string} evidence the failure cluster the draft was generated from
 * @property {string} hypothesis
 * @property {string} candidateFix
 * @property {string} expectedBenefit
 * @property {string} risk
 * @property {string} benchmark
 * @property {string} rollback
 * @property {string} compatibilityImpact
 */

/**
 * Is this string one of the fields a human is allowed to correct?
 *
 * @param {unknown} value
 * @returns {boolean} true when `value` names a correctable RFC field
 */
export function isCorrectableField(value) {
  return typeof value === 'string' && CORRECTABLE_RFC_FIELDS.includes(value);
}

/**
 * Applies the latest correction per field (ordered by correctedAt) onto a copy of
 * the RFC draft. Corrections whose field is not correctable or whose
 * correctedValue is blank are ignored. The original draft is never mutated.
 *
 * @param {RfcDraft} draft the generated draft
 * @param {object[]} corrections `{ id, clusterKey, field, correctedValue, note?, correctedAt }[]`
 * @returns {RfcDraft} the corrected draft, or the same object when nothing applies
 */
export function applyCorrections(draft, corrections) {
  const latestByField = new Map();
  for (const correction of corrections) {
    const field = correction.field;
    if (!CORRECTABLE_RFC_FIELDS.includes(field)) continue;
    if (!correction.correctedValue.trim()) continue;
    const existing = latestByField.get(field);
    if (!existing || correction.correctedAt >= existing.correctedAt) latestByField.set(field, correction);
  }
  if (latestByField.size === 0) return draft;
  return {
    ...draft,
    problem: latestByField.get('problem')?.correctedValue ?? draft.problem,
    hypothesis: latestByField.get('hypothesis')?.correctedValue ?? draft.hypothesis,
    candidateFix: latestByField.get('candidateFix')?.correctedValue ?? draft.candidateFix,
    expectedBenefit: latestByField.get('expectedBenefit')?.correctedValue ?? draft.expectedBenefit,
    risk: latestByField.get('risk')?.correctedValue ?? draft.risk,
    benchmark: latestByField.get('benchmark')?.correctedValue ?? draft.benchmark,
    rollback: latestByField.get('rollback')?.correctedValue ?? draft.rollback,
    compatibilityImpact: latestByField.get('compatibilityImpact')?.correctedValue ?? draft.compatibilityImpact,
  };
}
