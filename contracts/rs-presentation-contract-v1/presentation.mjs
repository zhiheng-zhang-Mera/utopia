// Unified presentation vocabulary for the rescheduling baseline (RS-290 step 2).
//
// Step 2 requires that the UI not face three sets of availability / busy / handoff vocabulary. The
// measured overlap across the integrated tree is eleven words, and it falls into TWO classes that a
// single rule cannot handle:
//
//   - CROSS-COMPONENT overlap, which is the risk this module exists for: USER_DISABLED in three
//     vocabularies, UNKNOWN in FOUR, ONLINE in two, DISABLED in two.
//   - INTRA-RS-202 overlap, which is DELIBERATE PARTITIONING and must be preserved: STRUCTURAL_REASONS
//     and RESOURCE_REASONS are the two disjoint halves ELIGIBILITY_REASONS is composed from, and
//     RS-202's completion gate depends on that disjointness.
//
// A unification written as "find duplicate words and merge them" would therefore DESTROY the property
// that a structural refusal is distinguishable from a temporary resource shortage - the distinction
// RS-202 exists to make. So the rule here is per MEANING, not per SPELLING:
//
//   - the same meaning reached through different components MERGES to one term (USER_DISABLED);
//   - the same SPELLING carrying different meanings SPLITS into distinct terms, which is why the four
//     UNKNOWN senses become four terms rather than one.
//
// The property asserted by the accompanying tests is stronger than "no duplicate words": NO TWO
// DISTINCT MEANINGS MAY SHARE A PRESENTATION TERM. That is what a UI consumer actually needs.
export const PRESENTATION_CONTRACT_VERSION = 1;

/** Stable presentation states a UI may render, from step 3's list. */
export const PRESENTATION_STATES = Object.freeze([
  'QUEUED', 'RUNNING', 'REMOTE_HANDOFF', 'WAITING_USER', 'DEGRADED', 'COMPLETED', 'FAILED', 'CANCELLED',
]);

/** Actions the UI may offer, from step 3. Absent means the action is not offered, never "unknown". */
export const ALLOWED_ACTIONS = Object.freeze(['CANCEL', 'RETRY', 'KEEP_WAITING', 'CHOOSE_PROVIDER', 'CONFIRM']);

/**
 * Canonical presentation terms, one per MEANING.
 *
 * Deliberately NOT one per word: AVAILABILITY_UNKNOWN, CHANNEL_READINESS_UNKNOWN, FRESHNESS_UNKNOWN and
 * REMOTE_STATE_UNKNOWN are four terms because they are four facts, and a UI that treated them as one
 * would render "we have not measured this" identically to "we cannot see the executor".
 */
export const TERMS = Object.freeze([
  // provider / model / account selection
  'SELECTABLE',
  'USER_DISABLED',
  'ABSENT',
  'REMOVED',
  'REGION_UNSUPPORTED',
  'CREDENTIALS_MISSING',
  'SESSION_ENDED',
  'SERVICE_FAULT',
  // device capacity and reachability
  'DEVICE_UNREACHABLE',
  'DEVICE_REFUSING',
  'DEVICE_DISABLED',
  'DEVICE_ONLINE',
  'AT_CAPACITY',
  'SESSION_CONGESTED',
  'PRESSURE_PAUSED',
  'LOAD_UNMEASURED',
  'POLICY_EXCLUDED',
  // knowledge states, disambiguated by subject
  'AVAILABILITY_UNKNOWN',
  'CHANNEL_READINESS_UNKNOWN',
  'FRESHNESS_UNKNOWN',
  'REMOTE_STATE_UNKNOWN',
  'REMOTE_ONLINE',
  // state tokens a reason can settle into, kept in the same vocabulary so a mapping target is never
  // ambiguous about whether it names a reason or a state
  'DEGRADED',
  'QUEUED',
  'WAITING_USER',
  'REMOTE_HANDOFF',
]);

/**
 * Every term above is either a REFUSAL or a KNOWLEDGE state, and refusals are further split into the
 * two classes RS-202's gate depends on. This table is what stops a later "simplification" from
 * flattening the distinction: a term's class is data, and a test asserts the partitions hold.
 */
export const TERM_CLASS = Object.freeze({
  SELECTABLE: 'PERMITTED',
  DEVICE_ONLINE: 'PERMITTED',
  REMOTE_ONLINE: 'PERMITTED',
  // structural: nothing changes by waiting; someone must act
  USER_DISABLED: 'STRUCTURAL',
  ABSENT: 'STRUCTURAL',
  REMOVED: 'STRUCTURAL',
  REGION_UNSUPPORTED: 'STRUCTURAL',
  DEVICE_REFUSING: 'STRUCTURAL',
  DEVICE_DISABLED: 'STRUCTURAL',
  DEVICE_UNREACHABLE: 'STRUCTURAL',
  POLICY_EXCLUDED: 'STRUCTURAL',
  // resource: becomes usable on its own, so waiting is meaningful
  AT_CAPACITY: 'RESOURCE',
  SESSION_CONGESTED: 'RESOURCE',
  PRESSURE_PAUSED: 'RESOURCE',
  CREDENTIALS_MISSING: 'RESOURCE',
  SESSION_ENDED: 'RESOURCE',
  SERVICE_FAULT: 'RESOURCE',
  /**
   * LOAD_UNMEASURED is RESOURCE, not KNOWLEDGE, and the distinction is not cosmetic: RS-202 classifies
   * LOAD_UNKNOWN under RESOURCE_REASONS because unmeasured load BECOMES USABLE once telemetry arrives,
   * so waiting is meaningful. This module initially classified it KNOWLEDGE and a test caught it, which
   * is the very hazard step 2's analysis warned about - a unification quietly flattening the partition
   * RS-202's gate depends on. Recorded because the defect was mine and it was exactly the predicted one.
   */
  LOAD_UNMEASURED: 'RESOURCE',
  // knowledge: we do not know, which is neither a refusal nor a permission
  AVAILABILITY_UNKNOWN: 'KNOWLEDGE',
  CHANNEL_READINESS_UNKNOWN: 'KNOWLEDGE',
  FRESHNESS_UNKNOWN: 'KNOWLEDGE',
  REMOTE_STATE_UNKNOWN: 'KNOWLEDGE',
  // settled states, which are neither permission nor refusal
  DEGRADED: 'STATE',
  QUEUED: 'STATE',
  WAITING_USER: 'STATE',
  REMOTE_HANDOFF: 'STATE',
});

/**
 * The mapping itself, keyed by SOURCE VOCABULARY then word.
 *
 * Keyed by vocabulary rather than by word alone, because a word-only table cannot express that
 * UNKNOWN means four things - which is the defect this module was written to avoid.
 */
export const TERM_OF = Object.freeze({
  'RS-201.AVAILABILITY_REASONS': Object.freeze({
    AVAILABLE: 'SELECTABLE',
    REGION_UNSUPPORTED: 'REGION_UNSUPPORTED',
    CREDENTIALS_MISSING: 'CREDENTIALS_MISSING',
    SESSION_EXPIRED: 'SESSION_ENDED',
    SERVICE_FAULT: 'SERVICE_FAULT',
    USER_DISABLED: 'USER_DISABLED',
    UNKNOWN: 'AVAILABILITY_UNKNOWN',
  }),
  'RS-201.CHANNEL_READINESS': Object.freeze({
    READY: 'SELECTABLE',
    AUTH_REQUIRED: 'CREDENTIALS_MISSING',
    UNAVAILABLE: 'SERVICE_FAULT',
    UNKNOWN: 'CHANNEL_READINESS_UNKNOWN',
  }),
  'RS-201.FRESHNESS': Object.freeze({
    FRESH: 'SELECTABLE',
    STALE: 'FRESHNESS_UNKNOWN',
    UNKNOWN: 'FRESHNESS_UNKNOWN',
  }),
  'RS-201.ENABLEMENT': Object.freeze({ ENABLED: 'SELECTABLE', DISABLED: 'USER_DISABLED' }),
  'RS-201.PROBE_OUTCOMES': Object.freeze({
    FRESH_PROBE: 'SELECTABLE',
    CACHED_WITHIN_TTL: 'SELECTABLE',
    CACHED_DEGRADED: 'DEGRADED',
    NO_DATA: 'REMOTE_STATE_UNKNOWN',
  }),
  'RS-202.ELIGIBILITY_REASONS': Object.freeze({
    ELIGIBLE: 'SELECTABLE',
    USER_DISABLED: 'USER_DISABLED',
    REFUSING_WORK: 'DEVICE_REFUSING',
    UNREACHABLE: 'DEVICE_UNREACHABLE',
    POLICY_EXCLUDED: 'POLICY_EXCLUDED',
    AT_CAPACITY: 'AT_CAPACITY',
    LOAD_UNKNOWN: 'LOAD_UNMEASURED',
    PRESSURE_PAUSED: 'PRESSURE_PAUSED',
    SESSION_CONGESTED: 'SESSION_CONGESTED',
  }),
  'RS-202.REACHABLE_STATES': Object.freeze({ ONLINE: 'DEVICE_ONLINE', BUSY: 'SESSION_CONGESTED', DEGRADED: 'PRESSURE_PAUSED' }),
  'RS-202.REFUSING_STATES': Object.freeze({ FAILED: 'DEVICE_REFUSING', DISABLED: 'DEVICE_DISABLED', OFFLINE: 'DEVICE_UNREACHABLE' }),
  'RS-202.ROUTE_STAGES': Object.freeze({
    DIRECT: 'SELECTABLE',
    SWITCH_OFFERED: 'WAITING_USER',
    ALTERNATE_DEVICE: 'REMOTE_HANDOFF',
    QUEUED: 'QUEUED',
    EXHAUSTED: 'DEGRADED',
  }),
  'RS-203.REMOTE_STATES': Object.freeze({ ONLINE: 'REMOTE_ONLINE', UNKNOWN: 'REMOTE_STATE_UNKNOWN', RECOVERING: 'DEGRADED' }),
  'RS-203.UNAVAILABILITY_DOMAINS': Object.freeze({ DEVICE: 'DEVICE_UNREACHABLE', PROVIDER: 'SERVICE_FAULT', INPUT: 'FRESHNESS_UNKNOWN' }),
  /**
   * Absence and removal, which the first draft of this table omitted entirely - the coverage test then
   * reported ABSENT and REMOVED as declared-but-never-produced, which is a real gap rather than a
   * bookkeeping one: without it a UI could not tell "never registered" from "you removed it", and that
   * distinction is the whole point of the tombstone design in RS-201.
   */
  'RS-201.ABSENCE_CODES': Object.freeze({
    UNKNOWN_PROVIDER: 'ABSENT',
    UNKNOWN_MODEL: 'ABSENT',
    UNKNOWN_ACCOUNT: 'ABSENT',
    MODEL_NOT_IN_PROVIDER: 'ABSENT',
    ACCOUNT_NOT_IN_PROVIDER: 'ABSENT',
    RETIRED_PROVIDER: 'REMOVED',
    RETIRED_MODEL: 'REMOVED',
    RETIRED_ACCOUNT: 'REMOVED',
    HAS_DEPENDENTS: 'POLICY_EXCLUDED',
    IDENTITY_COLLISION: 'POLICY_EXCLUDED',
    DUPLICATE_IDENTITY: 'POLICY_EXCLUDED',
    INVALID_REGISTRY_RECORD: 'POLICY_EXCLUDED',
    RAW_SECRET_FORBIDDEN: 'POLICY_EXCLUDED',
    HANDLE_STORE_REQUIRED: 'POLICY_EXCLUDED',
  }),
});

/**
 * Map one source word to its canonical term.
 *
 * Throws on an unknown source or an unmapped word rather than returning undefined, because a silent
 * undefined is how a UI ends up rendering a blank status for a real condition.
 */
export function presentTerm(source, word) {
  const table = TERM_OF[source];
  if (!table) throw new Error(`unknown source vocabulary ${String(source)}`);
  const term = table[word];
  if (!term) throw new Error(`${source} has no mapping for ${String(word)}`);
  return term;
}

/** The stable state a UI renders, derived from canonical terms rather than from raw component words. */
export function presentState({ terms = [], terminal = false, failed = false, cancelled = false } = {}) {
  if (cancelled) return 'CANCELLED';
  if (terminal) return failed ? 'FAILED' : 'COMPLETED';
  if (terms.includes('WAITING_USER')) return 'WAITING_USER';
  if (terms.includes('REMOTE_HANDOFF')) return 'REMOTE_HANDOFF';
  if (terms.includes('DEGRADED') || terms.includes('REMOTE_STATE_UNKNOWN')) return 'DEGRADED';
  if (terms.some(term => TERM_CLASS[term] === 'RESOURCE') || terms.includes('QUEUED')) return 'QUEUED';
  if (terms.includes('SELECTABLE')) return 'RUNNING';
  return 'DEGRADED';
}
