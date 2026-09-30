/**
 * UTOPIA · City Core — root authority, public surface.
 *
 * One import site for the protected-surface decision:
 *
 *   contracts.mjs         the vocabulary — change kinds, decisions, reasons, hits
 *   protected-surface.mjs the pure classifier — CODEOWNERS subset + caller manifest
 *   guard.mjs             the composition — containment seam in, ALLOW/
 *                         REQUIRE_OWNER/DENY out
 *
 * Ported from the Codex-Boss donor `src/shared/root-authority/contracts.ts`,
 * `src/shared/root-authority/protected-surface.ts` and
 * `electron/root-authority/protected-surface-guard.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. See DONOR.json for what was carried
 * over and what was deliberately left behind.
 *
 * Nothing here reads a file, resolves a real path or consults a policy of its own:
 * the immutable manifest is caller-supplied and containment is an injected
 * `resolve` function. `DONOR_ROOT_PROTECTED_MANIFEST` is inert reference data.
 */

export * from './contracts.mjs';
export * from './protected-surface.mjs';
export * from './guard.mjs';
