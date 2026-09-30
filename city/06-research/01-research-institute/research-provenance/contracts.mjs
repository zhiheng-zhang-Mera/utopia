/**
 * UTOPIA · Research Institute — research provenance contracts.
 *
 * The frozen vocabularies and value shapes a source-provenance record is built
 * from, plus the validators that gate them. Nothing here is a runtime: there is no
 * research conductor, no stage machine, no provider call and no storage, because a
 * citation record has to be readable on its own, years later, without the machinery
 * that produced it.
 *
 * The value shapes are materialised through copy-on-construct factories: a factory
 * validates first and then copies, so a caller that keeps the array it passed in
 * cannot later mutate the record it already handed over. Validation is the single
 * gate, and a factory never repairs the input it was given — it throws the donor's
 * exact error, or it returns a faithful copy.
 *
 * Ported from the Codex-Boss donor `src/shared/research-citation.ts` (the status
 * ladder, the `CitationRecord` shape and its validator) and
 * `src/shared/research-input.ts` (the `HumanDefinedResearchInput` /
 * `HumanResearchBudget` shapes and their validator) @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * Vocabulary:
 *   CITATION_LADDER             the verification ladder, weakest first
 *   VERIFIED_CITATION_STATUSES  statuses that count as verified evidence
 *   BIBLIOGRAPHY_STATUSES       statuses that may enter a bibliography
 *   PROVIDER_POLICIES           the provider policies an input may declare
 */

/**
 * The citation verification ladder, in the donor's order.
 *
 * A web-AI suggesting a paper is NOT a verified citation: citations progress
 * through source acquired → metadata verified → relevant passage located → claim
 * relation verified, and only CLAIM_SUPPORTED (or a deliberate PARTIAL with
 * reasons) may support a primary claim.
 */
export const CITATION_LADDER = Object.freeze([
  'UNSUPPORTED', // suggested only; nothing acquired
  'METADATA_ONLY', // metadata verified (title/authors/venue)
  'SOURCE_RETRIEVED', // full source acquired
  'PASSAGE_VERIFIED', // relevant passage located in the source
  'CLAIM_SUPPORTED', // passage supports the claim
  'PARTIAL', // partial support with explicit caveats
  'CONTRADICTED', // source contradicts the claim
]);

/** Statuses that count as verified evidence for a primary claim (donor audit rule). */
export const VERIFIED_CITATION_STATUSES = Object.freeze([
  'SOURCE_RETRIEVED',
  'PASSAGE_VERIFIED',
  'CLAIM_SUPPORTED',
  'PARTIAL',
]);

/**
 * Statuses whose source was actually acquired and does not contradict the claim.
 * A bibliography is generated from *verified* records only: UNSUPPORTED /
 * METADATA_ONLY / CONTRADICTED records are excluded.
 */
export const BIBLIOGRAPHY_STATUSES = Object.freeze([
  'SOURCE_RETRIEVED',
  'PASSAGE_VERIFIED',
  'CLAIM_SUPPORTED',
  'PARTIAL',
]);

/** The provider policies a human research input may declare. */
export const PROVIDER_POLICIES = Object.freeze(['AUTO', 'FIXED']);

/**
 * Validate a citation record, with the donor's exact rules and messages.
 *
 * The donor checks the id, the title, the status, the reasons array and the
 * passages; it deliberately does not check `proposedAuthors`, `proposedVenue`,
 * `sourceRef` or `updatedAt`, and no rule is added here — an input the donor
 * accepts is accepted, and an input the donor refuses is refused with the same
 * message.
 *
 * @param {object} record
 * @throws {Error} "Citation requires an id" | "Citation title invalid" |
 *   "Invalid citation status" | "Citation reasons must be an array" |
 *   "Invalid citation passages"
 */
export function validateCitationRecord(record) {
  if (!record || typeof record.id !== 'string' || !record.id) throw new Error('Citation requires an id');
  if (typeof record.proposedTitle !== 'string' || !record.proposedTitle.trim() || record.proposedTitle.length > 500) throw new Error('Citation title invalid');
  if (!CITATION_LADDER.includes(record.status)) throw new Error('Invalid citation status');
  if (!Array.isArray(record.reasons)) throw new Error('Citation reasons must be an array');
  if (record.passages && (record.passages.length > 50 || record.passages.some((passage) => typeof passage.quote !== 'string' || !passage.quote || passage.quote.length > 4000))) throw new Error('Invalid citation passages');
}

/**
 * Build a validated citation record copy.
 *
 * The donor exposes the shape and a void validator; the copy is what makes a
 * validated record safe to hand on. `reasons` and `passages` (and every passage)
 * are copied, so mutating the arrays that were passed in cannot change a record
 * that has already been validated. The fields the donor declares required (`id`,
 * `proposedTitle`, `status`, `reasons`, `updatedAt`) are always present; an
 * optional field the caller left undefined stays undefined rather than being
 * filled in with a default.
 *
 * @param {object} record
 * @returns {object} a validated copy
 * @throws {Error} exactly what {@link validateCitationRecord} throws
 */
export function citationRecord(record) {
  validateCitationRecord(record);
  return {
    id: record.id,
    proposedTitle: record.proposedTitle,
    ...(record.proposedAuthors !== undefined
      ? { proposedAuthors: Array.isArray(record.proposedAuthors) ? [...record.proposedAuthors] : record.proposedAuthors }
      : {}),
    ...(record.proposedVenue !== undefined ? { proposedVenue: record.proposedVenue } : {}),
    ...(record.sourceRef !== undefined ? { sourceRef: record.sourceRef } : {}),
    status: record.status,
    ...(record.passages !== undefined
      ? {
        passages: Array.isArray(record.passages)
          ? record.passages.map((passage) => ({
            quote: passage.quote,
            ...(passage.page !== undefined ? { page: passage.page } : {}),
          }))
          : record.passages,
      }
      : {}),
    reasons: [...record.reasons],
    updatedAt: record.updatedAt,
  };
}

/**
 * Validate the human-defined research input, with the donor's exact rules and
 * messages.
 *
 * The donor keeps this private; it is exported here so the rules can be tested
 * directly, which is a surface change only. The rules, their order and their
 * messages are the donor's: `researchQuestion` (1–20000 chars), an authorized
 * `workspace`, `hypothesis`, `constraints` (max 50 strings), `providerPolicy`,
 * `reviewers` (1–5 runtime ids), the positive-integer budget and
 * `maxRuntimeMinutes`.
 *
 * @param {object} input
 * @throws {Error} the donor's exact message for the first failing rule
 */
export function validateHumanResearchInput(input) {
  if (!input || typeof input.researchQuestion !== 'string' || !input.researchQuestion.trim() || input.researchQuestion.length > 20000) throw new Error('researchQuestion is required (1–20000 chars) and immutable');
  if (typeof input.workspace !== 'string' || !input.workspace.trim()) throw new Error('An authorized workspace is required');
  if (input.hypothesis !== undefined && (typeof input.hypothesis !== 'string' || !input.hypothesis.trim() || input.hypothesis.length > 20000)) throw new Error('hypothesis invalid');
  if (input.constraints !== undefined && (!Array.isArray(input.constraints) || input.constraints.length > 50 || input.constraints.some((item) => typeof item !== 'string' || item.length > 2000))) throw new Error('constraints invalid (max 50 strings)');
  if (input.providerPolicy !== undefined && !PROVIDER_POLICIES.includes(input.providerPolicy)) throw new Error('providerPolicy must be AUTO or FIXED');
  if (input.reviewers !== undefined && (!Array.isArray(input.reviewers) || input.reviewers.length < 1 || input.reviewers.length > 5)) throw new Error('reviewers must be 1–5 runtime ids');
  const budget = input.budget;
  if (!budget || !Number.isInteger(budget.maxSteps) || budget.maxSteps < 1 || !Number.isInteger(budget.maxExperiments) || budget.maxExperiments < 1 || !Number.isInteger(budget.maxProviderCalls) || budget.maxProviderCalls < 1) throw new Error('budget requires positive integer maxSteps / maxExperiments / maxProviderCalls');
  if (budget.maxRuntimeMinutes !== undefined && (!Number.isInteger(budget.maxRuntimeMinutes) || budget.maxRuntimeMinutes < 1)) throw new Error('maxRuntimeMinutes invalid');
}

/**
 * Build a validated copy of a human-defined research input.
 *
 * The research question, the hypothesis and the workspace are carried verbatim:
 * the donor's validator only checks that they are usable, and the factory never
 * trims, rewrites or default-fills them. `constraints`, `reviewers`, the budget
 * and the optional `id` are copied so the caller's arrays stay the caller's.
 *
 * @param {object} input
 * @returns {object} a validated copy
 * @throws {Error} exactly what {@link validateHumanResearchInput} throws
 */
export function humanResearchInput(input) {
  validateHumanResearchInput(input);
  return {
    ...(input.id !== undefined ? { id: input.id } : {}),
    researchQuestion: input.researchQuestion,
    workspace: input.workspace,
    ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis } : {}),
    ...(input.constraints !== undefined ? { constraints: [...input.constraints] } : {}),
    ...(input.providerPolicy !== undefined ? { providerPolicy: input.providerPolicy } : {}),
    ...(input.reviewers !== undefined ? { reviewers: [...input.reviewers] } : {}),
    budget: {
      maxSteps: input.budget.maxSteps,
      maxExperiments: input.budget.maxExperiments,
      maxProviderCalls: input.budget.maxProviderCalls,
      ...(input.budget.maxRuntimeMinutes !== undefined ? { maxRuntimeMinutes: input.budget.maxRuntimeMinutes } : {}),
    },
  };
}
