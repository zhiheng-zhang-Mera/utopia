/**
 * UTOPIA · City Core — root-authority contracts.
 *
 * The vocabulary a protected-surface decision is spoken in: the change kinds, the
 * three-valued decision, the reason shape, the hit shape and the assessment shape,
 * as plain values plus small validators. Nothing here reads a file, resolves a
 * real path or knows where a workspace root is.
 *
 * Ported from the Codex-Boss donor `src/shared/root-authority/contracts.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. Almost all of that file's vocabulary
 * belongs to the Boss product and was NOT carried over: `RootOperation` and
 * `ROOT_OPERATIONS`, `ROOT_OPERATION_FLOOR`, `RootIdentity`, `RootDecisionRecord`
 * and `RootRequestMode` describe a Boss run, a Boss actor and a Boss audit ledger,
 * none of which exist here. What travels is the decision itself
 * (`RootDecision`, its strictness order and its composition) and the structured
 * `RootDecisionReason` shape that the host guard emits.
 *
 * The one thing this module must never let happen: a decision getting looser. The
 * strictness order is fixed —
 *
 *   ALLOW (0)  <  REQUIRE_OWNER (1)  <  DENY (2)
 *
 * — so composing two decisions always yields the stricter one and a permissive
 * sub-decision can never launder a stricter one.
 *
 * Vocabulary:
 *   CHANGE_KINDS        what a caller may claim about a path
 *   ROOT_DECISIONS      ALLOW | REQUIRE_OWNER | DENY, in that strictness order
 *   PROTECTED_SOURCES   which boundary produced a rule that matched
 *   REASON_CODES        the stable machine codes this module can produce
 *   SurfaceChange       one claimed structural change (path, kind, rename source)
 *   ProtectedPathHit    one matching path, the rule that matched it, its source
 *   RootDecisionReason  why the decision was reached: code + human detail
 *   SurfaceAssessment   decision, protected hits, escapes and reasons
 */

/** The five ways a caller may describe its intent for a path. */
export const CHANGE_KINDS = Object.freeze(['read', 'write', 'create', 'delete', 'rename']);

/** The unified Root permission result, ordered from loosest to strictest. */
export const ROOT_DECISIONS = Object.freeze(['ALLOW', 'REQUIRE_OWNER', 'DENY']);

/**
 * The two boundaries a rule can come from, most authoritative first.
 *
 * `immutable-manifest` rules are compiled in by the caller and are matched before
 * `codeowners` rules, so a CODEOWNERS line can never shadow the caller's own
 * boundary. The donor had exactly these two sources.
 */
export const PROTECTED_SOURCES = Object.freeze(['immutable-manifest', 'codeowners']);

/**
 * The stable reason codes this module can actually produce.
 *
 * The donor's `RootDecisionReason.code` is a free string whose documented examples
 * include `floor:DENY` and `policy:REQUIRE_OWNER`. Those belong to the donor's
 * operation classifier, which is not ported, so they are not declared here. Every
 * code below is emitted by `guard.mjs`, and no code outside this set may be
 * emitted: a reason nobody can produce is a comment pretending to be a contract.
 */
export const REASON_CODES = Object.freeze({
  /** A path left the candidate workspace, lexically or through a resolver. */
  PATH_ESCAPE: 'path:escape',
  /** Prefix of every protected reason: `path:protected:<source>`. */
  PATH_PROTECTED_PREFIX: 'path:protected:',
});

/** The composition rule's own limits, kept where the reason list is shaped. */
export const REASON_LIMITS = Object.freeze({ escapes: 5, protected: 10 });

const ROOT_DECISION_RANK = Object.freeze({ ALLOW: 0, REQUIRE_OWNER: 1, DENY: 2 });

/** Prefix of every protected reason code. */
const PROTECTED_REASON_PREFIX = REASON_CODES.PATH_PROTECTED_PREFIX;

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

/** Is this one of the three decisions? */
export function isRootDecision(value) {
  return value === 'ALLOW' || value === 'REQUIRE_OWNER' || value === 'DENY';
}

/** Is this one of the five change kinds? */
export function isChangeKind(value) {
  return typeof value === 'string' && CHANGE_KINDS.includes(value);
}

/** Is this one of the two rule sources? */
export function isProtectedSource(value) {
  return value === 'immutable-manifest' || value === 'codeowners';
}

/** True when `candidate` is at least as strict as `floor`. */
export function isAtLeastAsStrict(candidate, floor) {
  if (!isRootDecision(candidate)) throw new TypeError(`candidate must be one of ${ROOT_DECISIONS.join(', ')}`);
  if (!isRootDecision(floor)) throw new TypeError(`floor must be one of ${ROOT_DECISIONS.join(', ')}`);
  return ROOT_DECISION_RANK[candidate] >= ROOT_DECISION_RANK[floor];
}

/** The stricter of two decisions (DENY beats REQUIRE_OWNER beats ALLOW). */
export function strictestRootDecision(a, b) {
  if (!isRootDecision(a)) throw new TypeError(`decision must be one of ${ROOT_DECISIONS.join(', ')}`);
  if (!isRootDecision(b)) throw new TypeError(`decision must be one of ${ROOT_DECISIONS.join(', ')}`);
  return ROOT_DECISION_RANK[a] >= ROOT_DECISION_RANK[b] ? a : b;
}

/** Folds a set of decisions into the strictest one; the empty set is ALLOW. */
export function foldRootDecisions(decisions) {
  return requireArray(decisions, 'decisions').reduce(
    (worst, next) => strictestRootDecision(worst, next),
    'ALLOW',
  );
}

/** The reason code a rule source produces when it matches. */
export function protectedReasonCode(source) {
  if (!isProtectedSource(source)) throw new TypeError(`source must be one of ${PROTECTED_SOURCES.join(', ')}`);
  return `${PROTECTED_REASON_PREFIX}${source}`;
}

/** True for `path:escape` and for every `path:protected:<source>`. */
export function isKnownReasonCode(code) {
  if (typeof code !== 'string' || !code) return false;
  if (code === REASON_CODES.PATH_ESCAPE) return true;
  if (!code.startsWith(PROTECTED_REASON_PREFIX)) return false;
  return isProtectedSource(code.slice(PROTECTED_REASON_PREFIX.length));
}

/**
 * Build one decision reason.
 *
 * `detail` is human-readable and must never contain secret material (the donor's
 * rule, kept). Only codes from `REASON_CODES` are accepted, so this module cannot
 * grow a reason vocabulary by accident.
 */
export function rootDecisionReason({ code, detail } = {}) {
  if (!isKnownReasonCode(code)) {
    throw new TypeError(`reason code must be ${REASON_CODES.PATH_ESCAPE} or ${PROTECTED_REASON_PREFIX}<source>`);
  }
  return { code, detail: requireText(detail, 'reason.detail') };
}

/** Validate one protected-surface hit. */
export function protectedPathHit(hit) {
  if (hit === null || typeof hit !== 'object' || Array.isArray(hit)) throw new TypeError('hit must be an object');
  const pattern = requireText(hit.rule, 'hit.rule');
  if (typeof hit.path !== 'string') throw new TypeError('hit.path must be a string');
  if (!isProtectedSource(hit.source)) throw new TypeError(`hit.source must be one of ${PROTECTED_SOURCES.join(', ')}`);
  return { path: hit.path, rule: pattern, source: hit.source };
}

/** Validate one claimed structural change. */
export function surfaceChange(change) {
  if (change === null || typeof change !== 'object' || Array.isArray(change)) throw new TypeError('change must be an object');
  if (!isChangeKind(change.kind)) throw new TypeError(`change.kind must be one of ${CHANGE_KINDS.join(', ')}`);
  const result = { path: requireText(change.path, 'change.path'), kind: change.kind };
  // A rename source is carried as given, including a non-string: the guard must
  // see the raw value so it can classify it as an escape rather than silently
  // dropping half of a move.
  if (change.from !== undefined) result.from = change.from;
  return result;
}

/**
 * Validate a complete assessment.
 *
 * The `decision` field is checked against what the donor's composition rule
 * implies for these escapes and hits, so an assessment can never be recorded with
 * a decision looser than its own evidence:
 *
 *   any escape ⇒ DENY; otherwise any protected hit ⇒ REQUIRE_OWNER; otherwise ALLOW
 */
export function surfaceAssessment(assessment) {
  if (assessment === null || typeof assessment !== 'object' || Array.isArray(assessment)) {
    throw new TypeError('assessment must be an object');
  }
  if (!isRootDecision(assessment.decision)) {
    throw new TypeError(`assessment.decision must be one of ${ROOT_DECISIONS.join(', ')}`);
  }
  const protectedHits = requireArray(assessment.protected ?? [], 'assessment.protected').map((hit) => protectedPathHit(hit));
  // An escape is whatever raw value could not be resolved, stringified. It may be
  // the empty string (a blank entry) or a stringified non-string (`"null"`), so
  // only the type is checked here -- requiring non-empty text would reject the
  // donor's own evidence.
  const escapes = requireArray(assessment.escapes ?? [], 'assessment.escapes').map((escape) => {
    if (typeof escape !== 'string') throw new TypeError('assessment.escapes[] must be a string');
    return escape;
  });
  const reasons = requireArray(assessment.reasons ?? [], 'assessment.reasons').map((reason) => rootDecisionReason(reason));

  const implied = escapes.length > 0 ? 'DENY' : protectedHits.length > 0 ? 'REQUIRE_OWNER' : 'ALLOW';
  if (!isAtLeastAsStrict(assessment.decision, implied)) {
    throw new TypeError(`assessment.decision ${assessment.decision} is looser than its evidence implies (${implied})`);
  }
  return { decision: assessment.decision, protected: protectedHits, escapes, reasons };
}
