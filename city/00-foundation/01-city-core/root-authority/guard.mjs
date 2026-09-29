/**
 * UTOPIA · City Core — protected surface guard.
 *
 * The host-side half of the protected-surface decision: it takes what a caller
 * claims it will do, resolves every path through an injected containment resolver,
 * classifies the contained paths against the protected surface, and composes one
 * decision from the result.
 *
 * Ported from the Codex-Boss donor
 * `electron/root-authority/protected-surface-guard.ts` @
 * 8df428eaa437a409368401e95194e40266b83080, with the host coupling removed.
 *
 * DELIBERATE DEVIATION (see DONOR.json): the donor's `ProtectedSurfaceGuard`
 * class owns fs and realpath containment — its constructor reads `.github/CODEOWNERS`
 * and its `resolve` calls `workspacePath` + `canonicalRealPathSync`, which resolve
 * symlinks and junctions against a real on-disk root. None of that is carried
 * over: this module never touches a filesystem. Containment is an injected seam,
 * `resolve(requested) -> { relative } | undefined`, so the same behaviour is
 * testable without a real tree and no host path policy is invented here. A
 * resolver that throws is treated as an escape, exactly as the donor treated a
 * throwing `workspacePath`.
 *
 * Properties the donor's acceptance tests exercised, kept as real behaviour:
 *   - `../stable/...` and an absolute path ⇒ escape ⇒ DENY
 *   - a new file inside a protected directory ⇒ REQUIRE_OWNER
 *   - a rename is classified on BOTH source and destination
 *   - a delete is classified exactly like a write
 *   - case differences cannot slip past on a case-insensitive surface
 *
 * It follows that the composition rule is fixed and never loosened:
 *
 *   any escape            ⇒ DENY
 *   else any protected    ⇒ REQUIRE_OWNER
 *   else                  ⇒ ALLOW
 */

import {
  REASON_CODES,
  REASON_LIMITS,
  protectedReasonCode,
  rootDecisionReason,
  strictestRootDecision,
  surfaceAssessment,
} from './contracts.mjs';
import {
  DONOR_COMMIT,
  DONOR_REPOSITORY,
  assessProtectedPaths,
  compileProtectedSurface,
  normalizeRepoPath,
} from './protected-surface.mjs';

export {
  CHANGE_KINDS,
  PROTECTED_SOURCES,
  REASON_CODES,
  REASON_LIMITS,
  ROOT_DECISIONS,
  foldRootDecisions,
  isChangeKind,
  isKnownReasonCode,
  isRootDecision,
  protectedPathHit,
  protectedReasonCode,
  rootDecisionReason,
  strictestRootDecision,
  surfaceAssessment,
  surfaceChange,
} from './contracts.mjs';

export {
  DONOR_COMMIT,
  DONOR_REPOSITORY,
  DONOR_ROOT_PROTECTED_MANIFEST,
  assessProtectedPaths,
  codeownersPatternToRegExp,
  compileProtectedSurface,
  isProtectedPath,
  normalizeRepoPath,
  parseCodeownersPatterns,
} from './protected-surface.mjs';

/** The decisions this module can reach, in strictness order. */
const COMPOSITION_RULE = Object.freeze({
  DENY: 'any escape',
  REQUIRE_OWNER: 'any protected hit, no escape',
  ALLOW: 'neither',
});

/** A change kind that never contributes a second path. */
function changeTargets(change) {
  // A rename contributes both its `from` and its `path`, and a delete contributes
  // its target, so neither direction of a move and no removal escapes the boundary.
  return change?.kind === 'rename' ? [change.from, change.path] : [change?.path];
}

/**
 * Build a guard over a caller-supplied immutable manifest and an injected
 * containment resolver.
 *
 * @param {object} [options]
 * @param {readonly string[]} [options.manifest]   the immutable protected surface.
 *   Caller-supplied by design: this module has no protected-path policy of its
 *   own, and the donor's Boss manifest is exported only as inert data.
 * @param {readonly string[]} [options.extraPatterns]  normally parsed CODEOWNERS.
 * @param {boolean} [options.caseInsensitive]  defaults to true, as in the donor.
 * @param {(requested: string) => ({relative?: string} | undefined)} [options.resolve]
 *   containment. Returns the contained workspace-relative path, or anything falsy
 *   when the path left the root — lexically or through a link.
 */
export function createProtectedSurfaceGuard(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('guard options must be an object');
  }
  const resolve = options.resolve;
  if (typeof resolve !== 'function') {
    throw new TypeError('guard requires an injected `resolve` containment function');
  }
  const manifest = [...(options.manifest ?? [])];
  const codeownersPatterns = [...(options.extraPatterns ?? [])];
  const caseInsensitive = options.caseInsensitive ?? true;
  const surface = compileProtectedSurface({ manifest, extraPatterns: codeownersPatterns, caseInsensitive });

  /**
   * Resolves a caller-supplied path to a contained workspace-relative path.
   * Returns `undefined` when the path escapes the root — lexically (`..`) or
   * through a link — because those are DENY, not REQUIRE_OWNER. A resolver that
   * throws is an escape too, never an unhandled crash.
   */
  function contained(requested) {
    if (typeof requested !== 'string' || !requested.trim()) return undefined;
    let resolved;
    try {
      resolved = resolve(requested);
    } catch {
      return undefined;
    }
    if (!resolved || typeof resolved !== 'object') return undefined;
    const relative = normalizeRepoPath(resolved.relative);
    return relative === undefined ? undefined : { relative };
  }

  /** Classify contained paths and compose the decision with the escapes. */
  function assessResolved(relatives, escapes, additionalPatterns = []) {
    const surfaceOptions = {
      manifest,
      caseInsensitive,
      ...(codeownersPatterns.length + additionalPatterns.length > 0
        ? { extraPatterns: [...codeownersPatterns, ...additionalPatterns] }
        : {}),
    };
    const assessment = assessProtectedPaths(relatives, [], surfaceOptions);
    return compose(assessment.hits, [...escapes, ...assessment.escapes]);
  }

  /**
   * The donor's composition rule, unchanged:
   *
   *   any escape ⇒ DENY; otherwise any protected hit ⇒ REQUIRE_OWNER; otherwise ALLOW
   *
   * Reasons list at most the first 5 escapes as a single `path:escape` reason, and
   * at most the first 10 hits as one `path:protected:<source>` reason each.
   */
  function compose(hits, escapes) {
    const reasons = [];
    if (escapes.length) {
      reasons.push(rootDecisionReason({
        code: REASON_CODES.PATH_ESCAPE,
        detail: `path escaped the candidate workspace: ${escapes.slice(0, REASON_LIMITS.escapes).join(', ')}`,
      }));
    }
    for (const hit of hits.slice(0, REASON_LIMITS.protected)) {
      reasons.push(rootDecisionReason({
        code: protectedReasonCode(hit.source),
        detail: `${hit.path} matches ${hit.rule}`,
      }));
    }
    // An escape is a containment violation (DENY). A protected hit alone is a
    // review boundary (REQUIRE_OWNER).
    const decision = strictestRootDecision(
      escapes.length ? 'DENY' : 'ALLOW',
      hits.length ? 'REQUIRE_OWNER' : 'ALLOW',
    );
    return surfaceAssessment({ decision, protected: hits, escapes, reasons });
  }

  return {
    /** The immutable manifest in force. */
    manifest,
    /** The compiled CODEOWNERS/extra patterns in force. */
    extraPatterns: codeownersPatterns,
    /** Match case-insensitively (default true). */
    caseInsensitive,
    /** The frozen donor commit this module was ported from. */
    donorCommit: DONOR_COMMIT,
    /** The donor repository this module was ported from. */
    donorRepository: DONOR_REPOSITORY,
    /** The composition rule, exposed so a caller can state it without re-deriving it. */
    compositionRule: COMPOSITION_RULE,

    /** Every pattern currently in force (immutable manifest first, then CODEOWNERS). */
    patterns() {
      return surface.rules.map((rule) => ({ pattern: rule.pattern, source: rule.source }));
    },

    /** Resolve one path through the injected containment seam. */
    resolve: contained,

    /** Classifies a set of paths (no rename semantics). */
    assessPaths(paths = [], also = []) {
      const escapes = [];
      const relatives = [];
      for (const raw of [...paths, ...also]) {
        if (typeof raw !== 'string') {
          escapes.push(String(raw));
          continue;
        }
        const resolved = contained(raw);
        if (!resolved) escapes.push(raw);
        else relatives.push(resolved.relative);
      }
      return assessResolved(relatives, escapes);
    },

    /**
     * Classifies structural changes. A rename contributes both its `from` and its
     * `path`, and a delete contributes its target (classified exactly like a write).
     */
    assessChanges(changes = []) {
      const escapes = [];
      const relatives = [];
      for (const change of changes) {
        for (const raw of changeTargets(change)) {
          if (typeof raw !== 'string') {
            escapes.push(String(raw));
            continue;
          }
          const resolved = contained(raw);
          if (!resolved) escapes.push(raw);
          else relatives.push(resolved.relative);
        }
      }
      return assessResolved(relatives, escapes);
    },

    /**
     * The change-set check used for `git diff --name-only` style input: paths are
     * already repo-relative, but they are still resolved so a path that escapes the
     * root is DENY rather than REQUIRE_OWNER. `additionalProtectedPaths` are unioned
     * into this call only; they are not compiled into `patterns()`.
     *
     * A blank or non-string entry is skipped rather than escaped — an empty line
     * from a diff is not a containment violation.
     */
    assessChangeSet(changedFiles = [], additionalProtectedPaths = []) {
      const escapes = [];
      const relatives = [];
      for (const raw of changedFiles) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const resolved = contained(raw);
        if (!resolved) escapes.push(raw);
        else relatives.push(resolved.relative);
      }
      return assessResolved(relatives, escapes, [...additionalProtectedPaths]);
    },
  };
}

/**
 * Convenience for one-shot checks without holding a guard instance.
 *
 * @param {{manifest?: readonly string[], extraPatterns?: readonly string[], caseInsensitive?: boolean, resolve: Function}} options
 * @param {readonly object[]} changes
 */
export function assessWorkspaceChanges(options, changes) {
  return createProtectedSurfaceGuard(options).assessChanges(changes);
}
