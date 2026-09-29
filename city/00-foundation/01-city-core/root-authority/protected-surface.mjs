/**
 * UTOPIA · City Core — protected surface classifier.
 *
 * The decision whether a path is a protected surface, and nothing else: no fs, no
 * realpath, no workspace root, no host. It mirrors the CODEOWNERS matching subset
 * so a boundary declared in `.github/CODEOWNERS` is honoured, and it unions that
 * with a manifest the caller compiles in.
 *
 * Ported from the Codex-Boss donor `src/shared/root-authority/protected-surface.ts`
 * @ 8df428eaa437a409368401e95194e40266b83080.
 *
 * DELIBERATE DEVIATION (see DONOR.json): the donor hard-codes its own
 * `ROOT_PROTECTED_MANIFEST` inside `compileProtectedSurface`. That list is Boss's
 * protected-path policy, and inventing a protected-path policy for Utopia would be
 * new authority policy rather than a migration. So the immutable manifest is an
 * explicit caller option — `compileProtectedSurface({ manifest, extraPatterns })` —
 * and the donor's list is exported below as inert data
 * (`DONOR_ROOT_PROTECTED_MANIFEST`) purely so the donor's behaviour stays readable
 * and testable. Nothing in this module consults it automatically.
 *
 * Two sources are unioned, in this order:
 *
 *   1. `manifest` — supplied by the caller and compiled into the surface. Because
 *      it is code, deleting or emptying `.github/CODEOWNERS` cannot open it.
 *   2. `extraPatterns` — normally the parsed `.github/CODEOWNERS`.
 *
 * Paths are normalized *before* matching, and a rename is classified on both its
 * source and its destination by the caller, so neither half of a move can smuggle
 * a protected file past the boundary.
 */

import {
  REASON_CODES,
  protectedReasonCode,
} from './contracts.mjs';

export {
  PROTECTED_SOURCES,
  REASON_CODES,
  REASON_LIMITS,
  foldRootDecisions,
  isAtLeastAsStrict,
  isChangeKind,
  isKnownReasonCode,
  isProtectedSource,
  isRootDecision,
  protectedPathHit,
  protectedReasonCode,
  rootDecisionReason,
  strictestRootDecision,
  surfaceAssessment,
  surfaceChange,
} from './contracts.mjs';

/** The donor repository and frozen commit every header here names. */
export const DONOR_REPOSITORY = 'zhiheng-zhang-Mera/Codex-Boss';
export const DONOR_COMMIT = '8df428eaa437a409368401e95194e40266b83080';

/**
 * The donor's compiled-in Root Surface, carried over as INERT DATA.
 *
 * Codex-Boss `src/shared/root-authority/protected-surface.ts` @
 * 8df428eaa437a409368401e95194e40266b83080, lines 27-220, verbatim and in order.
 * It is exported for documentation and for tests that want to measure the donor's
 * grammar against the donor's own patterns. It is NOT a default: no function here
 * reads it, because adopting a Boss protected-path policy as Utopia's would be
 * inventing authority policy, which this migration forbids.
 */
export const DONOR_ROOT_PROTECTED_MANIFEST = Object.freeze([
  // The review boundary itself, so it cannot be deleted to escape review.
  '/.github/CODEOWNERS',
  '/.github/workflows/',

  // The authority model, and the exact path only.
  '/docs/root-trust-authority-model.md',

  // CI command indirection / dependency execution surface.
  '/package.json',
  '/pnpm-lock.yaml',
  '/pnpm-workspace.yaml',
  '/.npmrc',

  // Build / typecheck / test-runner configuration.
  '/tsconfig.json',
  '/tsconfig.electron.json',
  '/tsconfig.*.json',
  '/vite.config.*',
  '/vitest.config.*',

  // Critical promotion / acceptance gates used by CI.
  '/scripts/benchmark.cjs',
  '/scripts/package-portable.cjs',
  '/scripts/smoke-portable.ps1',
  '/scripts/acceptance-restart.cjs',
  '/scripts/acceptance-*.cjs',
  '/scripts/acceptance-*.ps1',
  '/scripts/*soak*.cjs',
  '/scripts/*soak*.ps1',
  '/scripts/r901-soak.cjs',

  // Root Authority policy surface. Policy metadata only — never a secret.
  '/.codex-boss/root/',
  '/.codex-boss/config/root-*.json',
  '/.codex-boss/config/root-*.schema.json',

  // Root authority implementation.
  '/electron/root-authority/',
  '/src/root-authority/',
  '/src/**/root-authority/',

  // Owner identity / authority verification.
  '/electron/owner-authority/',
  '/src/owner-authority/',
  '/src/**/owner-authority/',

  // Explicit self-elevation guards.
  '/electron/self-elevation/',
  '/src/self-elevation/',
  '/src/**/self-elevation/',

  // Credential boundary.
  '/electron/credential-boundary/',
  '/electron/security/credential-boundary/',
  '/src/credential-boundary/',
  '/src/**/credential-boundary/',
  '/electron/root-credential*/',
  '/src/**/root-credential*/',

  // Promotion / Stable-Candidate authority boundary.
  '/electron/promotion-gate/',
  '/electron/engineering/promotion-gate/',
  '/src/promotion-gate/',
  '/src/**/promotion-gate/',
  '/electron/stable-candidate/',
  '/src/stable-candidate/',
  '/src/**/stable-candidate/',

  // Emergency stop / recovery authority.
  '/electron/emergency-control/',
  '/src/emergency-control/',
  '/src/**/emergency-control/',
  '/electron/root-recovery/',
  '/src/root-recovery/',
  '/src/**/root-recovery/',

  // Root-invariant tests.
  '/tests/**/root-authority*.test.*',
  '/tests/**/owner-authority*.test.*',
  '/tests/**/self-elevation*.test.*',
  '/tests/**/credential-boundary*.test.*',
  '/tests/**/promotion-gate*.test.*',
  '/tests/**/stable-candidate*.test.*',
  '/tests/**/emergency-control*.test.*',
  '/tests/**/root-recovery*.test.*',

  // The Trust / Owner-Authority plane.
  '/trust-policy/',

  // The architecture judge and its evidence sources.
  '/config/architecture-enforcement-baseline.json',
  '/config/architecture-baseline.json',
  '/scripts/architecture-enforcement.cjs',
  '/scripts/architecture-enforcement-baseline.cjs',
  '/scripts/architecture-baseline-series.cjs',
  '/scripts/architecture-observatory.cjs',
  '/scripts/architecture.cjs',
  '/scripts/architecture-baseline.cjs',

  // The trust verifier, classifier, self-certification judge and its evidence helpers.
  '/src/shared/autonomous-evolution-*.ts',
  '/src/shared/trust-problems.ts',
  '/src/shared/acceptance-*.ts',
  '/src/shared/bootstrap-audit.ts',
  '/src/shared/owner-intervention.ts',

  // Host-side session / bootstrap / intervention / surface plumbing the gates audit.
  '/electron/engineering/acceptance-session.ts',
  '/electron/engineering/bootstrap-completion.ts',
  '/electron/engineering/owner-intervention-ledger.ts',
  '/electron/engineering/autonomous-evolution-*.ts',

  // The attested acceptance gates and the helpers that build their evidence.
  '/tests/acceptance/',
  '/tests/helpers/acceptance-report.ts',
  '/tests/helpers/trusted-evidence.ts',

  // The trust model's extension globs are bare, so they classify a matching file
  // anywhere in the tree.
  '/tests/**/autonomous-evolution*.test.*',
  '/tests/**/acceptance-evolution*.test.*',

  // The trust-epoch finalization terminal decision.
  '/scripts/trust-epoch-finalize-handoff.cjs',
  '/scripts/trust-epoch-finalization-handoff.cjs',

  // The tier declarations and configurations decide WHICH gates run at all.
  '/vitest.tiers.mjs',
  '/vitest.*.config.mjs',
  '/scripts/verify-targeted-vs-full.cjs',
  '/scripts/qualification-*.cjs',

  // The lockdown's own tooling.
  '/scripts/trust-migration-proposal.cjs',
  '/scripts/verify-authority-separation.cjs',
]);

/** One compiled rule: the pattern as written, where it came from, and its regex. */
function compiledRule(pattern, source, caseInsensitive) {
  return { pattern, source, regex: codeownersPatternToRegExp(pattern, caseInsensitive) };
}

/** Splits a CODEOWNERS line into its pattern and owner list. */
function parseCodeownersLine(line) {
  // GitHub strips `#` comments; an escaped `\#` is literal and is not supported
  // by CODEOWNERS in practice, so a plain split is faithful here.
  const withoutComment = String(line).split('#')[0].trim();
  if (!withoutComment) return undefined;
  const parts = withoutComment.split(/\s+/);
  const pattern = parts[0];
  if (!pattern) return undefined;
  return { pattern, owners: parts.slice(1) };
}

/**
 * Parses `.github/CODEOWNERS` into the pattern list that actually carries an owner.
 *
 * Lines whose owner list is empty are ignored (they grant nothing). The parse is
 * total: malformed lines are skipped, never thrown, so a broken CODEOWNERS file
 * cannot crash the guard — the caller's immutable manifest still applies.
 */
export function parseCodeownersPatterns(content) {
  const patterns = [];
  for (const line of String(content ?? '').split(/\r?\n/)) {
    const parsed = parseCodeownersLine(line);
    if (!parsed) continue;
    if (!parsed.owners.length) continue;
    patterns.push(parsed.pattern);
  }
  return patterns;
}

/**
 * Translates one CODEOWNERS pattern into an anchored regular expression.
 *
 * Supported semantics (the subset GitHub documents, ported unchanged):
 *   - `#` comments and blank lines are handled by the caller;
 *   - a leading `/` anchors the pattern at the repository root;
 *   - a pattern containing an internal `/` is root-anchored;
 *   - a pattern with no `/` matches the basename at any depth;
 *   - a trailing `/` matches the directory and everything beneath it;
 *   - `*` matches within a path segment, `**` matches across segments;
 *   - `?` matches a single character within a segment;
 *   - a bare double-star is `.*`, and a double-star followed by a slash
 *     consumes zero or more whole segments;
 */
export function codeownersPatternToRegExp(pattern, caseInsensitive = true) {
  let body = String(pattern).trim();
  if (!body) return /$^/; // never matches
  let directoryOnly = false;
  if (body.endsWith('/')) {
    directoryOnly = true;
    body = body.slice(0, -1);
  }
  const anchored = body.startsWith('/');
  if (anchored) body = body.slice(1);
  // After removing a leading slash, an internal slash still means root-anchored.
  const rootAnchored = anchored || body.includes('/');

  let source = '';
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === '*') {
      if (body[index + 1] === '*') {
        // A double-star followed by a slash consumes zero or more whole segments;
        // a bare double-star is `.*`.
        if (body[index + 2] === '/') {
          source += '(?:[^/]+/)*';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  const prefix = rootAnchored ? '^' : '^(?:.*/)?';
  // A directory pattern protects the directory entry itself and everything under
  // it, so deleting the directory also matches.
  const suffix = directoryOnly ? '(?:/.*)?$' : '$';
  return new RegExp(prefix + source + suffix, caseInsensitive ? 'i' : '');
}

/**
 * Compiles the caller's manifest plus extra patterns once; callers reuse the result.
 *
 * @param {{manifest?: readonly string[], extraPatterns?: readonly string[], caseInsensitive?: boolean}} [options]
 *   `manifest` is the immutable surface: it is compiled first and is matched
 *   before any CODEOWNERS rule, so a duplicate cannot shadow it. It is
 *   caller-supplied on purpose — this module has no protected-path policy of its
 *   own. `caseInsensitive` defaults to true: on Windows/macOS the filesystem is
 *   case-insensitive anyway, and on a case-sensitive host the only cost of
 *   over-matching is an extra Owner approval, which is the fail-closed side.
 */
export function compileProtectedSurface(options = {}) {
  const caseInsensitive = options.caseInsensitive ?? true;
  const rules = [];
  for (const pattern of options.manifest ?? []) {
    rules.push(compiledRule(pattern, 'immutable-manifest', caseInsensitive));
  }
  for (const pattern of options.extraPatterns ?? []) {
    rules.push(compiledRule(pattern, 'codeowners', caseInsensitive));
  }
  return { rules, caseInsensitive };
}

/**
 * Normalizes an arbitrary caller-supplied path into a repo-relative POSIX path.
 *
 * Returns `undefined` when the path cannot be expressed relative to the root:
 * a Windows drive-letter or UNC prefix, an absolute path, or `..` traversal past
 * the root. Callers must treat `undefined` as a containment failure (DENY), never
 * as "unprotected".
 */
export function normalizeRepoPath(input) {
  if (typeof input !== 'string' || !input.trim()) return undefined;
  const value = input.trim().replace(/\\/g, '/');
  // Windows drive-letter and UNC prefixes are absolute by definition.
  if (/^[a-zA-Z]:\//.test(value) || value.startsWith('//')) return undefined;
  if (value.startsWith('/')) return undefined;
  const segments = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (!segments.length) return undefined;
  return segments.join('/');
}

/**
 * Classifies a set of repo-relative paths against the protected surface.
 *
 * Rename/delete support is explicit rather than implicit: pass the *destination*
 * paths in `paths` and the *source* paths in `also`, and both are assessed. The
 * function is intentionally total — a non-string entry becomes an escape so a
 * malformed manifest from a worker fails closed instead of silently passing.
 *
 * One rule per path is enough evidence: the first matching rule is recorded, and a
 * path already seen (case-folded when matching case-insensitively) is not counted
 * twice.
 *
 * @param {readonly unknown[]} paths
 * @param {readonly unknown[]} [also]
 * @param {{manifest?: readonly string[], extraPatterns?: readonly string[], caseInsensitive?: boolean}} [options]
 * @returns {{protected: boolean, hits: {path: string, rule: string, source: string}[], escapes: string[]}}
 */
export function assessProtectedPaths(paths, also = [], options = {}) {
  const surface = compileProtectedSurface(options);
  const hits = [];
  const escapes = [];
  const seen = new Set();

  const consider = (raw) => {
    if (typeof raw !== 'string' || !raw.trim()) {
      escapes.push(String(raw));
      return;
    }
    // An absolute path is only meaningful when the caller already relativized it;
    // treat it as an escape so the host wrapper must do that work explicitly.
    const normalized = normalizeRepoPath(raw);
    if (!normalized) {
      escapes.push(raw);
      return;
    }
    const key = surface.caseInsensitive ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) return;
    seen.add(key);
    for (const rule of surface.rules) {
      if (rule.regex.test(normalized)) {
        hits.push({ path: normalized, rule: rule.pattern, source: rule.source });
        return; // one rule per path is enough evidence
      }
    }
  };

  for (const path of paths) consider(path);
  for (const path of also) consider(path);

  return { protected: hits.length > 0, hits, escapes };
}

/** True when the path (repo-relative or normalizable) is a protected surface path. */
export function isProtectedPath(path, options = {}) {
  return assessProtectedPaths([path], [], options).protected;
}
