/**
 * UTOPIA · Research Institute — bibliography generation.
 *
 * `references.bib` is rendered deterministically from *verified* citation records —
 * never from AI-suggested titles alone. A record is included only when its source
 * was actually acquired and does not contradict the claim (status ∈
 * SOURCE_RETRIEVED / PASSAGE_VERIFIED / CLAIM_SUPPORTED / PARTIAL). UNSUPPORTED /
 * METADATA_ONLY / CONTRADICTED records are excluded, matching the citation-audit
 * rule that a primary claim must not bind unverified or contradicting sources.
 *
 * Ported from the Codex-Boss donor `src/shared/research-bibliography.ts` @
 * 8df428eaa437a409368401e95194e40266b83080; the type-only import of
 * `CitationRecord` / `CitationStatus` is replaced by the frozen vocabulary in
 * `./contracts.mjs`. Rendering is bytes-for-bytes the donor's: record order is
 * preserved, keys are sanitised to `[a-zA-Z0-9:_-]`, `{` and `}` are escaped in the
 * title, journal and url fields only, and there is no deduplication and no
 * validation — a bibliography is a faithful report of the records it was handed,
 * not a place to repair them.
 */

import { BIBLIOGRAPHY_STATUSES } from './contracts.mjs';

export { BIBLIOGRAPHY_STATUSES } from './contracts.mjs';

/**
 * One BibTeX `@misc` entry per verified record, in the donor's order.
 *
 * @param {object[]} records
 * @returns {string[]} the entries (empty when nothing is verified)
 */
export function bibliographyEntries(records) {
  return records.filter((record) => BIBLIOGRAPHY_STATUSES.includes(record.status)).map((record) => {
    const key = (record.id || 'citation').replace(/[^a-zA-Z0-9:_-]/g, '-');
    const authors = record.proposedAuthors?.length ? record.proposedAuthors.join(' and ') : 'Unknown';
    const title = (record.proposedTitle ?? 'Untitled').replace(/([{}])/g, '\\$1');
    const fields = [`title = {${title}}`, `author = {${authors}}`];
    if (record.proposedVenue) fields.push(`journal = {${record.proposedVenue.replace(/([{}])/g, '\\$1')}}`);
    if (record.sourceRef) fields.push(`url = {${record.sourceRef.replace(/([{}])/g, '\\$1')}}`);
    return `@misc{${key},\n  ${fields.join(',\n  ')}\n}`;
  });
}

/**
 * The whole `references.bib` document: a count header, then the entries separated
 * by blank lines. With nothing verified the donor writes an explicit placeholder
 * line rather than an empty file.
 *
 * @param {object[]} records
 * @returns {string}
 */
export function referencesBib(records) {
  const entries = bibliographyEntries(records);
  const header = `% References generated deterministically from verified citations (${entries.length} verified).\n`;
  return header + (entries.length ? entries.join('\n\n') + '\n' : '% no verified citations yet\n');
}
