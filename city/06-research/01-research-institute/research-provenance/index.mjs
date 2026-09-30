/**
 * UTOPIA · Research Institute — research provenance, one clean export site.
 *
 * Citation verification, bibliography rendering and the human-defined research
 * input, together with the frozen vocabularies and copy-on-construct shapes they
 * are built from.
 *
 * Ported from the Codex-Boss donor `src/shared/research-citation.ts`,
 * `src/shared/research-bibliography.ts` and `src/shared/research-input.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. The donor set had no runtime imports
 * (its only edges were `import type`), and this module keeps that property: the
 * `evidence-engine` sibling and the `research-protocol` sibling are neither imported
 * nor re-exported.
 */

export {
  BIBLIOGRAPHY_STATUSES,
  CITATION_LADDER,
  PROVIDER_POLICIES,
  VERIFIED_CITATION_STATUSES,
  citationRecord,
  humanResearchInput,
  validateCitationRecord,
  validateHumanResearchInput,
} from './contracts.mjs';

export { primaryClaimSupported, summarizeCitationAudit, verifyCitation } from './citation.mjs';

export { bibliographyEntries, referencesBib } from './bibliography.mjs';

export { humanResearchToIR, researchIdFor } from './input.mjs';
