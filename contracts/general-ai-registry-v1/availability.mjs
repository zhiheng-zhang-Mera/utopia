// General AI availability resolution and candidate output (RS-201).
//
// This module answers one question per record — "may this be used, and if not, WHY" — and one
// question per pool — "what are the candidates, and which of them could be chosen". It deliberately
// does NOT choose. `suggestSwitch` produces a suggestion that is structurally incapable of executing:
// the returned object always carries `executed: false`, so the separation the workbook requires
// between "suggest a switch" and "perform a switch" is a property of the data rather than a promise
// in a comment.
//
// The vocabulary lives in records.mjs and is reused rather than re-minted, and the time base is the
// existing observed_at/ttl_ms pair rather than a second cache. What is added here is PRECEDENCE: when
// several reasons apply at once, which one is reported.
import {
  AVAILABILITY_REASONS, ENABLEMENT, FRESHNESS, SELECTABLE_REASON, SUBJECT_KINDS,
  RegistryError, channelReadiness, freshnessOf,
} from './records.mjs';

export const AVAILABILITY_CONTRACT_VERSION = 1;

/**
 * Which reason wins when more than one applies, highest first.
 *
 * Ordering is a judgement, not an accident, and each step has a reason:
 *   - USER_DISABLED first: the user's own instruction outranks every observation, and it is the only
 *     reason the user can act on directly. A disabled provider that is ALSO region-blocked is
 *     reported as disabled, because telling the user about the region would imply that fixing the
 *     region would help.
 *   - REGION_UNSUPPORTED next: a region restriction is not something the user can retry past, and it
 *     makes any session or credential state moot.
 *   - SESSION_EXPIRED before CREDENTIALS_MISSING: an expired session is the more specific fact, and
 *     reporting "credentials missing" when a login merely lapsed would send the user to re-enter a
 *     credential that is in fact still stored.
 *   - SERVICE_FAULT after the auth reasons: a provider we are not logged into cannot tell us it is
 *     down, so an auth reason is the more trustworthy explanation when both are visible.
 *   - UNKNOWN above AVAILABLE and below everything else: this is where staleness lands. A stale
 *     observation is NOT live truth, so it must not be reported as available; UNKNOWN is the honest
 *     answer and it is not selectable.
 */
export const REASON_PRECEDENCE = Object.freeze([
  'USER_DISABLED',
  'REGION_UNSUPPORTED',
  'SESSION_EXPIRED',
  'CREDENTIALS_MISSING',
  'SERVICE_FAULT',
  'UNKNOWN',
  'AVAILABLE',
]);

/** Auth states that end a session outright, versus ones that never had credentials. */
const SESSION_ENDED_STATUSES = Object.freeze(['EXPIRED', 'REVOKED']);
const CREDENTIAL_STATUSES = Object.freeze(['UNAUTHENTICATED']);

const rank = reason => {
  const index = REASON_PRECEDENCE.indexOf(reason);
  return index === -1 ? REASON_PRECEDENCE.length : index;
};
const worst = reasons => reasons.slice().sort((a, b) => rank(a) - rank(b))[0] ?? 'UNKNOWN';

/**
 * Resolve one record's availability.
 *
 * `requestedRegion` is what the CALLER needs; a provider declares its own `region`, and a mismatch is
 * REGION_UNSUPPORTED. A provider with `region: null` is region-neutral and can never mismatch — which
 * is a declared fact about the provider, not a guess about the host's location.
 */
export function resolveAvailability({ record, subject = null, now = Date.now(), requestedRegion = null, channel = null } = {}) {
  if (!record || typeof record !== 'object') {
    return Object.freeze({ reason: 'UNKNOWN', selectable: false, freshness: 'UNKNOWN', subject, ref: null, detail: 'no record', sources: Object.freeze([]) });
  }
  const ref = record.provider_ref ?? record.model_ref ?? record.account_ref ?? null;
  const freshness = freshnessOf(record, now);
  const reasons = [];
  const sources = [];

  // Enablement. Anything that is not an explicit ENABLED is refused, so a record carrying an
  // unreadable enablement cannot slip through as usable — absence never reads as consent.
  if (record.enablement === 'DISABLED') { reasons.push('USER_DISABLED'); sources.push('enablement=DISABLED'); }
  else if (!ENABLEMENT.includes(record.enablement)) { reasons.push('UNKNOWN'); sources.push(`enablement=${String(record.enablement)}`); }

  // Region. Only providers declare one.
  if (requestedRegion !== null && requestedRegion !== undefined && 'region' in record) {
    if (record.region !== null && record.region !== requestedRegion) {
      reasons.push('REGION_UNSUPPORTED');
      sources.push(`region=${record.region} requested=${requestedRegion}`);
    }
  }

  // Account status: observed, and distinct from the user's enablement.
  const status = typeof record.status === 'string' ? record.status : null;
  if (status !== null && SESSION_ENDED_STATUSES.includes(status)) { reasons.push('SESSION_EXPIRED'); sources.push(`status=${status}`); }
  else if (status !== null && CREDENTIAL_STATUSES.includes(status)) { reasons.push('CREDENTIALS_MISSING'); sources.push(`status=${status}`); }

  // Channel readiness: the per-channel view, when a channel is named.
  if (channel !== null && channel !== undefined) {
    if (Array.isArray(record.channels) && record.channels.length > 0) {
      const readiness = channelReadiness(record, channel, now);
      if (readiness.readiness === 'AUTH_REQUIRED') { reasons.push('CREDENTIALS_MISSING'); sources.push(`${channel} readiness=AUTH_REQUIRED`); }
      else if (readiness.readiness === 'UNAVAILABLE') { reasons.push('SERVICE_FAULT'); sources.push(`${channel} readiness=UNAVAILABLE`); }
      else if (readiness.readiness === 'UNKNOWN') { reasons.push('UNKNOWN'); sources.push(`${channel} readiness=UNKNOWN`); }
    } else if (record.channel_handles && typeof record.channel_handles === 'object') {
      // An ACCOUNT states its per-channel position through handles rather than readiness, so asking
      // channelReadiness about an account would answer UNKNOWN and lose a fact we actually hold. A
      // channel with no handle is a channel we hold no credential for: that is a credential GAP, and
      // reporting it as "unknown" would understate what is known and misdirect the user.
      const slot = record.channel_handles[channel];
      if (slot === null || slot === undefined) { reasons.push('CREDENTIALS_MISSING'); sources.push(`${channel} has no credential handle`); }
    }
  } else if (Array.isArray(record.channels)) {
    // With no channel named, a channel that is outright UNAVAILABLE is still evidence of a fault.
    if (record.channels.some(entry => entry?.readiness === 'UNAVAILABLE')) { reasons.push('SERVICE_FAULT'); sources.push('a channel reports UNAVAILABLE'); }
  }

  // Staleness. A stale observation is not live truth, so it cannot be AVAILABLE.
  if (freshness !== 'FRESH') { reasons.push('UNKNOWN'); sources.push(`freshness=${freshness}`); }

  const reason = reasons.length === 0 ? 'AVAILABLE' : worst(reasons);
  return Object.freeze({
    reason,
    selectable: reason === SELECTABLE_REASON,
    freshness,
    subject,
    ref,
    detail: sources.length === 0 ? 'all facts fresh and permissive' : sources.join('; '),
    sources: Object.freeze(sources),
  });
}

/**
 * The candidate view of a whole pool: every record with its reason, the selectable subset, and the
 * refused ones WITH their reasons attached. Refused candidates are listed rather than filtered away,
 * because "unavailable but explainable and not selectable" is exactly what the workbook asks for — a
 * provider that vanishes from the list cannot explain itself.
 */
export function buildCandidates({ registry, subject = 'PROVIDER', now = Date.now(), requestedRegion = null, channel = null } = {}) {
  if (!SUBJECT_KINDS.includes(subject)) throw new RegistryError('INVALID_REGISTRY_RECORD', `${subject} is not a registry subject`);
  const records = subject === 'PROVIDER' ? registry.listProviders()
    : subject === 'MODEL' ? registry.listModels()
      : registry.listAccounts();
  const candidates = records.map(record => resolveAvailability({ record, subject, now, requestedRegion, channel }));
  const selectable = candidates.filter(candidate => candidate.selectable);
  return Object.freeze({
    availability_version: AVAILABILITY_CONTRACT_VERSION,
    subject,
    requested_region: requestedRegion,
    channel,
    candidates: Object.freeze(candidates),
    selectable: Object.freeze(selectable.map(candidate => candidate.ref)),
    refused: Object.freeze(candidates.filter(candidate => !candidate.selectable).map(candidate => Object.freeze({ ref: candidate.ref, reason: candidate.reason }))),
    /** The fallback-candidates-empty case, named so a caller cannot mistake it for "not asked yet". */
    all_refused: selectable.length === 0 && candidates.length > 0,
    empty_pool: candidates.length === 0,
  });
}

/**
 * A SUGGESTION, never an action.
 *
 * The workbook requires "suggest a switch" and "perform a switch" to be separate, so this returns an
 * object that always says `executed: false` and `requires_user_confirmation: true`. There is no
 * function in this module that performs the switch, which is the point: the separation cannot be
 * broken by a later caller passing a flag, because the capability was never built.
 */
export function suggestSwitch({ candidates, from = null } = {}) {
  if (!candidates || !Array.isArray(candidates.candidates)) {
    throw new RegistryError('INVALID_REGISTRY_RECORD', 'suggestSwitch needs a candidate list from buildCandidates');
  }
  const selectable = candidates.candidates.filter(candidate => candidate.selectable && candidate.ref !== from);
  const chosen = selectable.length > 0 ? selectable[0].ref : null;
  return Object.freeze({
    availability_version: AVAILABILITY_CONTRACT_VERSION,
    suggested_ref: chosen,
    from_ref: from,
    rationale: chosen !== null
      ? `${chosen} is selectable and differs from the current ${String(from)}`
      : (candidates.all_refused ? 'every candidate is refused; there is nothing to suggest' : (candidates.empty_pool ? 'the pool is empty; there is nothing to suggest' : 'no alternative selectable candidate')),
    /** Structural, not advisory: this module never executes a switch. */
    executed: false,
    requires_user_confirmation: true,
    alternatives: Object.freeze(selectable.map(candidate => candidate.ref)),
    refused: candidates.refused,
  });
}

// NOTE: this module deliberately does NOT re-export AVAILABILITY_REASONS / FRESHNESS /
// SELECTABLE_REASON. index.mjs re-exports both this file and records.mjs with `export *`, and a name
// exported by two star sources is AMBIGUOUS — importing it then throws rather than resolving. The
// vocabulary is owned by records.mjs and is already reachable through the same index.

