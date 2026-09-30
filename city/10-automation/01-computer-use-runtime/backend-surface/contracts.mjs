/**
 * UTOPIA · 10-automation / Computer Use Runtime — backend-surface contracts.
 *
 * The closed vocabularies and plain value shapes the eight ported modules agree
 * on. Nothing here behaves: it is data and typedefs only, so every ported file
 * stays independently loadable and none of them has to redefine a vocabulary.
 *
 * Donor: Codex-Boss @ 8df428eaa437a409368401e95194e40266b83080.
 *
 * What each constant is, and which donor line it came from:
 *
 *   SEMANTIC_ACTION_NAMES   the nine-value action union of
 *                           `src/shared/semantic.ts` line 1, in the donor's
 *                           order. `src/shared/semantic.ts`
 *                           `validateSemanticAction()` tests membership with an
 *                           inline array literal of exactly these nine strings
 *                           (line 4) and `electron/computer/semantic-runtime.ts`
 *                           line 8 builds its mutation set from the same union.
 *   SEMANTIC_RESULT_STATUSES `SemanticResult["status"]`, `electron/computer/
 *                           semantic-runtime.ts` line 5.
 *   SEMANTIC_BACKEND_KINDS  `SemanticBackendKind`, `electron/computer/
 *                           semantic-runtime.ts` line 4. `DomPageBackend.kind`
 *                           is `"dom"`.
 *   DOM_MUTATIONS /         `electron/computer/backends/dom-page.ts` lines 29-30,
 *   DOM_READS               verbatim and in the donor's order.
 *   PERMISSION_KINDS        `src/shared/permission.ts` line 4.
 *   SECURITY_CLASSES        `src/shared/permission.ts` line 22.
 *   DESKTOP_READ_ACTIONS    `src/shared/permission.ts` line 56 — the read set
 *                           `desktopMutationGate` treats as always-allowed.
 *
 * Every vocabulary is `Object.freeze`d and no list has a companion guard
 * function invented for it, because the donor has none: the donor's only
 * membership guard is the inline `includes(...)` / `new Set(...)` check inside
 * the functions that need it, and those functions still do exactly that.
 *
 * Value shapes (`@typedef`, erased at runtime):
 *
 *   SemanticAction          `src/shared/semantic.ts` line 2.
 *   SemanticResult          `electron/computer/semantic-runtime.ts` line 5.
 *   SemanticBackend         `electron/computer/semantic-runtime.ts` line 6.
 *   DomPageRef              `electron/computer/backends/dom-page.ts` lines 12-15.
 *   DomPageSurface          `electron/computer/backends/dom-page.ts` lines 16-23.
 *   BoundedRegion,
 *   ComputerTarget,
 *   PostCondition,
 *   RepairStep,
 *   RepairPlan              `src/shared/computer-recovery.ts` lines 25-40,
 *                           42-45, 118-133.
 *   ReadinessProbeFacts     `src/shared/action-readiness.ts` lines 36-49.
 *   UISurfaceBinding,
 *   UISurfaceFallback,
 *   UISurfaceContract       `src/shared/ui-surface.ts` lines 64-92.
 *   PermissionScope,
 *   PermissionManifest      `src/shared/permission.ts` lines 6-11.
 *
 * `SemanticBackendKind`, `SemanticResult` and `SemanticBackend` live in
 * `electron/computer/semantic-runtime.ts`, which is NOT ported (it owns the
 * durable-JSON state file, the provider mutation queue and an AbortController
 * timer — fs/clock-coupled, out of this building). `dom-page.ts`'s only edge to
 * it is `import type`, which TypeScript erases, so the three shapes it actually
 * names are declared here as typedefs and nothing from the runtime is ported.
 *
 * This module is pure: no filesystem, no network, no clock, no randomness, no
 * environment.
 */

/* ------------------------------- semantic action protocol */

/** The donor's `SemanticActionName` union, in donor order (`semantic.ts` line 1). */
export const SEMANTIC_ACTION_NAMES = Object.freeze([
  "open_app",
  "focus_window",
  "find_control",
  "click_control",
  "enter_text",
  "read_page",
  "submit",
  "wait_for_state",
  "verify_state"
]);

/** `SemanticResult["status"]` (`semantic-runtime.ts` line 5), in donor order. */
export const SEMANTIC_RESULT_STATUSES = Object.freeze(["SUCCESS", "UNSUPPORTED", "FAILED", "UNCERTAIN"]);

/** `SemanticBackendKind` (`semantic-runtime.ts` line 4), in donor order (its `priority` array, line 7). */
export const SEMANTIC_BACKEND_KINDS = Object.freeze(["native", "dom", "uia", "structured", "vision"]);

/* ------------------------------- DOM page tier */

/** `DOM_MUTATIONS` (`backends/dom-page.ts` line 29), verbatim. */
export const DOM_MUTATIONS = Object.freeze(["click_control", "enter_text", "submit"]);

/** `DOM_READS` (`backends/dom-page.ts` line 30), verbatim. */
export const DOM_READS = Object.freeze(["read_page", "verify_state"]);

/* ------------------------------- permission vocabulary */

/** `PERMISSION_KINDS` (`src/shared/permission.ts` line 4), verbatim and in donor order. */
export const PERMISSION_KINDS = Object.freeze(["filesystem", "repo", "network", "secret", "side-effect"]);

/** `SecurityClass` (`src/shared/permission.ts` line 22), verbatim and in donor order. */
export const SECURITY_CLASSES = Object.freeze(["PUBLIC", "INTERNAL", "SECRET", "GUARDIAN"]);

/**
 * `DESKTOP_READ_ACTIONS` (`src/shared/permission.ts` line 56), verbatim: the
 * desktop computer actions that only observe, "always allowed, mirroring the
 * lease's shared-read set".
 */
export const DESKTOP_READ_ACTIONS = Object.freeze(["read_page", "find_control", "verify_state", "wait_for_state"]);

/* ------------------------------- value shapes */

/**
 * One semantic action. `name` is one of SEMANTIC_ACTION_NAMES; `target` is the
 * addressing string (`dom:{...}`, `uia:{...}`, `vision:{...}`, `explorer:.`, …).
 * @typedef {object} SemanticAction
 * @property {string} name
 * @property {string} target
 * @property {string} [value]
 * @property {string} [expected]
 * @property {number} [timeoutMs]
 */

/**
 * What a backend answers. `status` is one of SEMANTIC_RESULT_STATUSES.
 * @typedef {object} SemanticResult
 * @property {"SUCCESS"|"UNSUPPORTED"|"FAILED"|"UNCERTAIN"} status
 * @property {unknown} [evidence]
 * @property {string} [message]
 * @property {string} [backend] one of SEMANTIC_BACKEND_KINDS
 */

/**
 * A backend the (deferred) semantic runtime would route over.
 * @typedef {object} SemanticBackend
 * @property {string} kind one of SEMANTIC_BACKEND_KINDS
 * @property {(action: SemanticAction) => boolean} supports
 * @property {(action: SemanticAction, signal: AbortSignal) => Promise<SemanticResult>} execute
 */

/**
 * Which visible provider pane runs a script.
 * @typedef {object} DomPageRef
 * @property {string} [providerId]
 */

/**
 * The injected page surface: "Evaluates JS inside a visible page (like
 * WebContentsView.executeJavaScript)". `page` selects which provider pane runs
 * the script; surfaces without a page concept may ignore it.
 * @typedef {object} DomPageSurface
 * @property {<T>(script: string, page?: DomPageRef) => Promise<T>} evaluate
 */

/**
 * A bounded rectangle a geometry target may land in.
 * @typedef {object} BoundedRegion
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * A repair-plan target. Kind is one of TEXT/ROLE/ACCESSIBILITY/ICON/REGION/POINT;
 * `frameRevisionAt` and `boundedRegion` are mandatory for ICON/POINT (§28).
 * @typedef {object} ComputerTarget
 * @property {"TEXT"|"ROLE"|"ACCESSIBILITY"|"ICON"|"REGION"|"POINT"} kind
 * @property {string} [hint]
 * @property {number} [frameRevisionAt]
 * @property {BoundedRegion} [boundedRegion]
 */

/**
 * What must be observable after a step for it to be VERIFIED.
 * @typedef {object} PostCondition
 * @property {string} description
 */

/**
 * One ordered plan step.
 * @typedef {object} RepairStep
 * @property {string} action one of SEMANTIC_ACTION_NAMES
 * @property {ComputerTarget} target
 * @property {PostCondition} postCondition
 * @property {string} rationale
 */

/**
 * The repair plan. `verdict` is one of READY/UNCERTAIN/DENIED/EMPTY.
 * @typedef {object} RepairPlan
 * @property {string} [episodeId]
 * @property {"SEND_AFFORDANCE_MISSING"|"INPUT_AFFORDANCE_MISSING"|"RESPONSE_SELECTOR_DRIFT"|"PAGE_STRUCTURE_CHANGED"} need
 * @property {"READY"|"UNCERTAIN"|"DENIED"|"EMPTY"} verdict
 * @property {RepairStep[]} steps
 * @property {string} [reason]
 */

/**
 * One page-readiness sample. Absence of a fact means "unknown ⇒ pass".
 * @typedef {object} ReadinessProbeFacts
 * @property {string} [readyState]
 * @property {boolean} [found]
 * @property {boolean} [visible]
 * @property {boolean} [enabled]
 * @property {boolean} [navigationAccepted]
 * @property {number} [stableSamples]
 */

/**
 * Evidence that a surface is bound to something real. Kind is one of
 * css-class/css-selector/component-file/token/token-family/attribute.
 * @typedef {object} UISurfaceBinding
 * @property {string} kind
 * @property {string} value
 * @property {string} file repository-relative file the evidence was read from
 * @property {string} evidence how the binding was observed
 */

/**
 * What a theme falls back to. Strategy is one of
 * BUILT_IN_DARK/BUILT_IN_LIGHT/INHERIT_PARENT/UNCHANGED.
 * @typedef {object} UISurfaceFallback
 * @property {string} strategy
 * @property {string} note
 */

/**
 * One §9.1 UI surface contract.
 * @typedef {object} UISurfaceContract
 * @property {string} id one of the UI_SURFACE_IDS literal union
 * @property {string} category one of UI_SURFACE_CATEGORIES
 * @property {string} description
 * @property {string[]} allowedProperties
 * @property {string[]} defaultTokens
 * @property {UISurfaceBinding[]} componentBindings
 * @property {UISurfaceFallback} fallback
 * @property {boolean} [locked]
 */

/**
 * An allow/deny pair. An empty `allow` denies everything.
 * @typedef {object} PermissionScope
 * @property {string[]} allow
 * @property {string[]} deny
 */

/**
 * One scope per permission kind.
 * @typedef {Record<"filesystem"|"repo"|"network"|"secret"|"side-effect", PermissionScope>} PermissionManifest
 */
