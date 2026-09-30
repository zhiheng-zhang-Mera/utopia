/**
 * UTOPIA · 10-automation / Computer Use Runtime — backend-surface entry point.
 *
 * Donor: Codex-Boss @ 8df428eaa437a409368401e95194e40266b83080. Every name below
 * is re-exported with the same identity as the module that defines it, and each
 * block lists exactly the donor's own runtime exports for that file — no name is
 * added, renamed or dropped.
 *
 *   src/shared/computer-recovery.ts              → ./computer-recovery.mjs
 *     COMPUTER_READ_ACTIONS, COMPUTER_MUTATION_ACTIONS, classifyRepairNeed,
 *     tierForTarget, geometryTargetValid, buildRepairPlan,
 *     grantedComputerActions, verdictForOutcome, planSummary
 *   src/shared/action-readiness.ts               → ./action-readiness.mjs
 *     READINESS_GATES, readinessFromProbe, postActionVerified,
 *     escalationAfterFailure
 *   src/shared/ui-surface.ts + ui-surface-ids.ts → ./ui-surface.mjs
 *     UI_SURFACE_REGISTRY_VERSION, UI_SURFACE_CATEGORIES, UI_TOKEN_GROUPS,
 *     UI_TOKEN_NAMES, tokenGroupOf, defaultSurfaceContracts, surfaceById,
 *     validateSurfaceOverride, knownToken, UI_SURFACE_EXTRA_TOKENS,
 *     validateUISurfaceRegistry, summarizeUISurfaceRegistry, and
 *     ui-surface-ids.ts's UI_SURFACE_IDS
 *   src/shared/semantic.ts                       → ./semantic.mjs
 *     validateSemanticAction, computerIntent
 *   src/shared/permission.ts                     → ./permission.mjs
 *     EMPTY_MANIFEST, manifestAllows, manifestNarrow, desktopMutationGate
 *   electron/computer/backends/dom-page.ts       → ./dom-page.mjs
 *     DOM_TARGET_PREFIX, parseDomTarget, DomPageBackend
 *   electron/computer/backends/provider-dom-surface.ts
 *                                                → ./provider-dom-surface.mjs
 *     providerDomSurface
 *
 * `./contracts.mjs` is additionally re-exported because it holds the closed
 * vocabularies those files were written against — the nine
 * SEMANTIC_ACTION_NAMES the validator tests, SEMANTIC_RESULT_STATUSES,
 * SEMANTIC_BACKEND_KINDS, DOM_MUTATIONS / DOM_READS, PERMISSION_KINDS,
 * SECURITY_CLASSES and the DESKTOP_READ_ACTIONS gate list. In the donor those
 * were inline literals or fields of unported files; here they are named constants,
 * which adds no behaviour. Both lists are the donor's, verbatim and in order.
 *
 * The two mandatory exclusions are NOT here and never will be:
 * `src/shared/perception.ts` (its only consumer, the fs/clock-coupled
 * `electron/computer/perception-loop.ts`, is deferred, so the frame vocabulary
 * would land with no consumer) and `createPageRepairExecutor`
 * (`electron/computer/provider-page-repair.ts`, which invents an AbortSignal port
 * the reference node does not supply and a DOM behaviour over real
 * `webContents.executeJavaScript`). Both are recorded in `DONOR.json`
 * `knownDifferences`.
 *
 * This package is pure: no filesystem, no network, no clock, no randomness, no
 * environment. Page surfaces and view accessors are injected by the caller, exactly
 * as the donor injects them.
 */

export {
  COMPUTER_READ_ACTIONS,
  COMPUTER_MUTATION_ACTIONS,
  classifyRepairNeed,
  tierForTarget,
  geometryTargetValid,
  buildRepairPlan,
  grantedComputerActions,
  verdictForOutcome,
  planSummary
} from "./computer-recovery.mjs";

export {
  READINESS_GATES,
  readinessFromProbe,
  postActionVerified,
  escalationAfterFailure
} from "./action-readiness.mjs";

export {
  UI_SURFACE_IDS,
  UI_SURFACE_REGISTRY_VERSION,
  UI_SURFACE_CATEGORIES,
  UI_TOKEN_GROUPS,
  UI_TOKEN_NAMES,
  tokenGroupOf,
  defaultSurfaceContracts,
  surfaceById,
  validateSurfaceOverride,
  knownToken,
  UI_SURFACE_EXTRA_TOKENS,
  validateUISurfaceRegistry,
  summarizeUISurfaceRegistry
} from "./ui-surface.mjs";

export { validateSemanticAction, computerIntent } from "./semantic.mjs";

export { EMPTY_MANIFEST, manifestAllows, manifestNarrow, desktopMutationGate } from "./permission.mjs";

export { DOM_TARGET_PREFIX, parseDomTarget, DomPageBackend } from "./dom-page.mjs";

export { providerDomSurface } from "./provider-dom-surface.mjs";

export {
  SEMANTIC_ACTION_NAMES,
  SEMANTIC_RESULT_STATUSES,
  SEMANTIC_BACKEND_KINDS,
  DOM_MUTATIONS,
  DOM_READS,
  PERMISSION_KINDS,
  SECURITY_CLASSES,
  DESKTOP_READ_ACTIONS
} from "./contracts.mjs";
