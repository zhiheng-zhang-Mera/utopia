/**
 * UTOPIA · City · Knowledge Core — contracts.
 *
 * The value shapes and orders the retrieval side depends on. Kept in its own
 * facade so a consumer can import the contract without pulling in the algorithms.
 */

export { TRUST_LEVELS, TRUST_ORDER, DEFAULT_MAX_CHARS } from '../retrieval/knowledge-core.mjs';

/** Required fields of a knowledge entry. */
export const REQUIRED_ENTRY_FIELDS = ['id', 'domain', 'title', 'content', 'trust'];

/** Optional fields the core understands. */
export const OPTIONAL_ENTRY_FIELDS = ['shelf', 'tags', 'source', 'validFrom', 'validUntil', 'supersedes', 'conflictGroup', 'createdAt', 'updatedAt'];

/** The query shape accepted by retrieval. */
export const QUERY_FIELDS = ['domain', 'shelf', 'tags', 'trustAtLeast', 'maxChars'];
