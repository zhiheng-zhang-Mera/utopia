/**
 * UTOPIA · 10-automation / Computer Use Runtime — ui-surface.
 *
 * Donor: `src/shared/ui-surface.ts` (18 830 B, 310 lines) + `src/shared/ui-surface-ids.ts`
 * (821 B) @ 8df428eaa437a409368401e95194e40266b83080. Pure and unchanged in
 * behaviour.
 *
 * Update-Plan/checkpoint-1.md §9/§9.1/§10 — the UI Surface Registry.
 *
 * §9 forbids a theme from guessing selectors: "不得让 AI 自己在代码里随意猜
 * `.sidebar` / `.some-random-div` / `button:nth-child(3)`". A theme therefore
 * faces a *semantic surface* with a §9.1 `UISurfaceContract`
 * (`id, category, allowedProperties, defaultTokens, componentBindings, fallback`)
 * and §10 semantic tokens, never a raw DOM path.
 *
 * This module owns the contract vocabulary and the fail-closed validation. The
 * host-side discovery that fills `componentBindings` with real evidence from the
 * repository lives in `electron/engineering/ui-surface-discovery.ts`, which is NOT
 * ported: it reads the filesystem (`fs`/`os`/`path` over a world model) and is
 * therefore outside this building's purity boundary. The registry shapes and
 * `validateUISurfaceRegistry` it feeds are ported, so a registry produced anywhere
 * is still validated here.
 *
 * CP3 scope note, as in the donor: this is the *registry + discovery* half of
 * Phase 2B. The theme package format, generator, validator, preview and activation
 * controller are CP4/CP5 and are deliberately not implemented here.
 *
 * `ui-surface-ids.ts` is merged into this file rather than ported as a ninth
 * module, because the file's whole reason to exist — letting a host depend on the
 * id vocabulary "without pulling in the contract table" — is a build-graph concern
 * that a single ESM module with a hoisted `UI_SURFACE_IDS` const does not have.
 * The list, its order and the `UISurfaceId` union are unchanged.
 *
 * The donor's two type-only edges (`import type { UISurfaceId }` and
 * `export type { UISurfaceId }`) are erased at runtime and carry no behaviour.
 *
 * Preserved donor defects (pinned by tests, not repaired):
 *   (a) `UNSAFE_VALUE` includes `/behavior\s*:/i` and `/binding\s*:/i`, which reject
 *       those substrings anywhere in a value — including inside a benign literal.
 *   (b) The §10 token-reference scan uses `/var\(\s*(--[a-z0-9-]+)/gi`, so it only
 *       examines tokens written inside `var(...)` and its class stops at the first
 *       character outside `[a-z0-9-]` — notably `_`. A bare `--boss-invented-token`
 *       literal is therefore never checked at all, and `var(--boss-accent_muted)` is
 *       captured as the declared prefix `--boss-accent` and accepted. The `detail`
 *       the refusal reports names the captured text, not the caller's value.
 *   (c) `SEEDS` carries no `locked: true` entry, so the LOCKED_SURFACE branch of
 *       `validateSurfaceOverride` is unreachable with the default table.
 *
 * This module is pure: no filesystem, no network, no clock, no randomness, no
 * environment.
 */

/* ------------------------------- §9 surface ids (donor ui-surface-ids.ts) */

/**
 * Update-Plan/checkpoint-1.md §9 — the canonical UI surface id list. "Kept in its
 * own file so the hosts (discovery, theme packages, validators) can depend on the
 * vocabulary without pulling in the contract table, and so the list has exactly
 * one definition. The order is the order the plan prints them."
 *
 * @type {readonly string[]}
 */
export const UI_SURFACE_IDS = Object.freeze([
  "APP_BACKGROUND",
  "SURFACE_PRIMARY",
  "SURFACE_SECONDARY",
  "SIDEBAR",
  "TOP_NAV",
  "CARD",
  "MODAL",
  "INPUT",
  "BUTTON_PRIMARY",
  "BUTTON_SECONDARY",
  "TEXT_PRIMARY",
  "TEXT_SECONDARY",
  "BORDER",
  "DIVIDER",
  "ACCENT",
  "SUCCESS",
  "WARNING",
  "DANGER",
  "SCROLLBAR",
  "CODE_PANEL",
  "WORKSPACE_PANEL",
  "AI_PANE",
  "STATUS_BADGE"
]);

/* ------------------------------- §9 surface vocabulary */

export const UI_SURFACE_REGISTRY_VERSION = "ui-surface-registry-1";

export const UI_SURFACE_CATEGORIES = Object.freeze([
  "CANVAS", "SURFACE", "NAVIGATION", "CONTROL", "TYPOGRAPHY", "LINE", "STATE", "SCROLL", "CONTENT", "LAYOUT", "FEEDBACK"
]);

/* ------------------------------- §10 semantic tokens */

export const UI_TOKEN_GROUPS = Object.freeze({
  color: Object.freeze([
    "--boss-bg-root", "--boss-bg-surface", "--boss-bg-elevated", "--boss-bg-muted",
    "--boss-text-primary", "--boss-text-secondary", "--boss-text-muted",
    "--boss-accent", "--boss-border", "--boss-divider",
    "--boss-success", "--boss-warning", "--boss-danger"
  ]),
  shape: Object.freeze(["--boss-radius", "--boss-radius-sm", "--boss-radius-lg", "--boss-border-width", "--boss-shadow"]),
  effect: Object.freeze(["--boss-blur", "--boss-opacity", "--boss-transition"]),
  typography: Object.freeze(["--boss-font-family", "--boss-font-mono", "--boss-font-size", "--boss-line-height", "--boss-letter-spacing"]),
  density: Object.freeze(["--boss-spacing-density", "--boss-space-1", "--boss-space-2", "--boss-space-3", "--boss-space-4"])
});

/** Every token name declared by the §10 groups, flattened in group order. */
export const UI_TOKEN_NAMES = Object.freeze(Object.values(UI_TOKEN_GROUPS).flat());

/**
 * Which §10 group declares this token, or undefined.
 * @param {string} token
 * @returns {"color"|"shape"|"effect"|"typography"|"density"|undefined}
 */
export function tokenGroupOf(token) {
  for (const [group, names] of Object.entries(UI_TOKEN_GROUPS)) {
    if (names.includes(token)) return group;
  }
  return undefined;
}

/* ------------------------------- §9.1 default contract table */

/** Private in the donor (line 108). */
const INHERIT = { strategy: "INHERIT_PARENT", note: "no value of its own: inherits the enclosing surface" };
/** Private in the donor (line 109). */
const DARK = { strategy: "BUILT_IN_DARK", note: "falls back to the locked built-in Dark theme" };

/**
 * The donor's `SEEDS` table, verbatim and in donor order (line 111). Private in
 * the donor, so private here; the public view is `defaultSurfaceContracts()`.
 * @type {readonly object[]}
 */
const SEEDS = [
  { id: "APP_BACKGROUND", category: "CANVAS", description: "the application canvas behind every panel", allowedProperties: ["background", "background-color", "background-image", "color"], defaultTokens: ["--boss-bg-root", "--boss-text-primary"], fallback: DARK },
  { id: "SURFACE_PRIMARY", category: "SURFACE", description: "the main working surface (conversation/work area)", allowedProperties: ["background", "background-color", "background-image", "color", "border-color"], defaultTokens: ["--boss-bg-surface", "--boss-text-primary", "--boss-border"], fallback: DARK },
  { id: "SURFACE_SECONDARY", category: "SURFACE", description: "elevated or secondary blocks inside a surface", allowedProperties: ["background", "background-color", "color", "border-color", "box-shadow"], defaultTokens: ["--boss-bg-elevated", "--boss-text-secondary", "--boss-shadow"], fallback: DARK },
  { id: "SIDEBAR", category: "NAVIGATION", description: "the history/navigation sidebar", allowedProperties: ["background", "background-color", "color", "border-color", "width"], defaultTokens: ["--boss-bg-surface", "--boss-text-secondary", "--boss-border"], fallback: DARK },
  { id: "TOP_NAV", category: "NAVIGATION", description: "the top-level view switch (Chat/Work/Research/Goal)", allowedProperties: ["background", "background-color", "color", "border-color", "padding"], defaultTokens: ["--boss-bg-elevated", "--boss-text-primary", "--boss-border"], fallback: DARK },
  { id: "CARD", category: "SURFACE", description: "a discrete card such as a task, evidence or runtime block", allowedProperties: ["background", "background-color", "border-color", "border-radius", "box-shadow", "color"], defaultTokens: ["--boss-bg-elevated", "--boss-border", "--boss-radius", "--boss-shadow"], fallback: DARK },
  { id: "MODAL", category: "SURFACE", description: "a modal/backdrop overlay (settings, dialogs)", allowedProperties: ["background", "background-color", "backdrop-filter", "border-color", "box-shadow", "color"], defaultTokens: ["--boss-bg-elevated", "--boss-backdrop", "--boss-blur", "--boss-shadow"], fallback: DARK },
  { id: "INPUT", category: "CONTROL", description: "text inputs, textareas and select controls", allowedProperties: ["background", "background-color", "border-color", "border-radius", "color", "caret-color", "font-family"], defaultTokens: ["--boss-bg-surface", "--boss-border", "--boss-text-primary", "--boss-radius"], fallback: DARK },
  { id: "BUTTON_PRIMARY", category: "CONTROL", description: "the primary action control of a surface", allowedProperties: ["background", "background-color", "border-color", "border-radius", "color", "box-shadow", "font-weight"], defaultTokens: ["--boss-accent", "--boss-on-accent", "--boss-radius"], fallback: DARK },
  { id: "BUTTON_SECONDARY", category: "CONTROL", description: "secondary and toggle controls", allowedProperties: ["background", "background-color", "border-color", "border-radius", "color"], defaultTokens: ["--boss-bg-elevated", "--boss-border", "--boss-text-secondary", "--boss-radius"], fallback: DARK },
  { id: "TEXT_PRIMARY", category: "TYPOGRAPHY", description: "primary readable text", allowedProperties: ["color", "font-family", "font-size", "font-weight", "letter-spacing", "line-height"], defaultTokens: ["--boss-text-primary", "--boss-font-family", "--boss-line-height"], fallback: DARK },
  { id: "TEXT_SECONDARY", category: "TYPOGRAPHY", description: "supporting and muted text", allowedProperties: ["color", "font-size", "letter-spacing", "line-height"], defaultTokens: ["--boss-text-secondary", "--boss-text-muted"], fallback: DARK },
  { id: "BORDER", category: "LINE", description: "structural borders around surfaces and controls", allowedProperties: ["border-color", "border-width", "border-style", "border-radius"], defaultTokens: ["--boss-border", "--boss-border-width", "--boss-radius"], fallback: INHERIT },
  { id: "DIVIDER", category: "LINE", description: "separators inside a surface (toolbars, list rows)", allowedProperties: ["border-color", "background-color", "opacity"], defaultTokens: ["--boss-divider"], fallback: INHERIT },
  { id: "ACCENT", category: "STATE", description: "the product accent and focus affordance", allowedProperties: ["background-color", "color", "box-shadow", "outline-color"], defaultTokens: ["--boss-accent", "--boss-accent-muted"], fallback: DARK },
  { id: "SUCCESS", category: "STATE", description: "success/verified state", allowedProperties: ["background-color", "color", "border-color"], defaultTokens: ["--boss-success"], fallback: DARK },
  { id: "WARNING", category: "STATE", description: "warning/degraded state", allowedProperties: ["background-color", "color", "border-color"], defaultTokens: ["--boss-warning"], fallback: DARK },
  { id: "DANGER", category: "STATE", description: "danger/blocked state", allowedProperties: ["background-color", "color", "border-color"], defaultTokens: ["--boss-danger"], fallback: DARK },
  { id: "SCROLLBAR", category: "SCROLL", description: "scrollbar track and thumb", allowedProperties: ["background-color", "border-radius", "width", "opacity"], defaultTokens: ["--boss-scrollbar-thumb", "--boss-scrollbar-track"], fallback: INHERIT },
  { id: "CODE_PANEL", category: "CONTENT", description: "code/monospace content blocks (final response, diffs)", allowedProperties: ["background", "background-color", "border-color", "border-radius", "color", "font-family", "font-size", "white-space"], defaultTokens: ["--boss-code-bg", "--boss-font-mono", "--boss-text-primary"], fallback: DARK },
  { id: "WORKSPACE_PANEL", category: "LAYOUT", description: "the provider/web workspace area", allowedProperties: ["background", "background-color", "border-color", "gap", "padding"], defaultTokens: ["--boss-bg-root", "--boss-border"], fallback: DARK },
  { id: "AI_PANE", category: "LAYOUT", description: "one web-AI processor pane and its frame", allowedProperties: ["background", "background-color", "border-color", "color"], defaultTokens: ["--boss-bg-surface", "--boss-border", "--boss-text-secondary"], fallback: DARK },
  { id: "STATUS_BADGE", category: "FEEDBACK", description: "status pills and badges (stage, outcome, counts)", allowedProperties: ["background-color", "color", "border-color", "border-radius", "letter-spacing"], defaultTokens: ["--boss-bg-elevated", "--boss-text-secondary", "--boss-radius-sm"], fallback: DARK }
];

/**
 * The locked contract table with empty bindings (discovery fills them in). Fresh
 * arrays and a fresh fallback object per contract, as the donor spreads them.
 *
 * @returns {import("./contracts.mjs").UISurfaceContract[]}
 */
export function defaultSurfaceContracts() {
  return SEEDS.map((seed) => ({
    id: seed.id,
    category: seed.category,
    description: seed.description,
    allowedProperties: [...seed.allowedProperties],
    defaultTokens: [...seed.defaultTokens],
    componentBindings: [],
    ...(seed.locked ? { locked: seed.locked } : {}),
    fallback: { ...seed.fallback }
  }));
}

/**
 * One contract by id, or undefined.
 * @param {string} id
 * @param {readonly import("./contracts.mjs").UISurfaceContract[]} [contracts]
 * @returns {import("./contracts.mjs").UISurfaceContract|undefined}
 */
export function surfaceById(id, contracts = defaultSurfaceContracts()) {
  return contracts.find((contract) => contract.id === id);
}

/* ------------------------------- §9.1/§20 fail-closed validation */

/**
 * The unsafe-value patterns, donor order. Private in the donor (line 169).
 * @type {readonly RegExp[]}
 */
const UNSAFE_VALUE = Object.freeze([
  /javascript:/i,
  /expression\s*\(/i,
  /@import/i,
  /url\(\s*['"]?\s*(?:https?:)?\/\//i,
  /<\/?\s*script/i,
  /behavior\s*:/i,
  /binding\s*:/i
]);

/**
 * §9.1 + §20: a theme may only touch a declared surface, only through allowed
 * properties, only with inline values that reference known tokens or literals.
 * Everything else fails closed with a machine-readable code.
 *
 * Precedence is the donor's: UNKNOWN_SURFACE → LOCKED_SURFACE → UNKNOWN_PROPERTY →
 * EMPTY_VALUE → UNSAFE_VALUE → UNKNOWN_TOKEN → ok. The property is matched
 * lower-cased and trimmed; the returned `property` is that normalised form, not
 * the caller's spelling.
 *
 * @param {{surface: string, property: string, value: string}} request
 * @param {readonly import("./contracts.mjs").UISurfaceContract[]} [contracts]
 * @returns {{ok: true, surface: string, property: string}|{ok: false, code: "UNKNOWN_SURFACE"|"UNKNOWN_PROPERTY"|"UNKNOWN_TOKEN"|"UNSAFE_VALUE"|"LOCKED_SURFACE"|"EMPTY_VALUE", detail: string}}
 */
export function validateSurfaceOverride(request, contracts = defaultSurfaceContracts()) {
  const contract = surfaceById(request.surface, contracts);
  if (!contract) return { ok: false, code: "UNKNOWN_SURFACE", detail: `${request.surface} is not a registered UI surface` };
  if (contract.locked) return { ok: false, code: "LOCKED_SURFACE", detail: `${contract.id} is locked and cannot be themed` };
  const property = request.property.trim().toLocaleLowerCase();
  if (!contract.allowedProperties.map((item) => item.toLocaleLowerCase()).includes(property)) {
    return { ok: false, code: "UNKNOWN_PROPERTY", detail: `${contract.id} does not allow the property ${request.property}; allowed: ${contract.allowedProperties.join(", ")}` };
  }
  const value = request.value.trim();
  if (!value) return { ok: false, code: "EMPTY_VALUE", detail: "an override value cannot be empty" };
  for (const pattern of UNSAFE_VALUE) {
    if (pattern.test(value)) return { ok: false, code: "UNSAFE_VALUE", detail: `value rejected by §20 (${pattern}): ${value.slice(0, 80)}` };
  }
  for (const reference of value.match(/var\(\s*(--[a-z0-9-]+)/gi) ?? []) {
    const token = reference.replace(/var\(\s*/i, "").trim();
    if (token.startsWith("--boss-") && !knownToken(token)) {
      return { ok: false, code: "UNKNOWN_TOKEN", detail: `${token} is not a declared §10 token` };
    }
  }
  return { ok: true, surface: contract.id, property };
}

/**
 * Tokens the contract table reads that are not in the five §10 groups. Private in
 * the donor (line 209), re-exported as `UI_SURFACE_EXTRA_TOKENS` (line 217).
 * @type {readonly string[]}
 */
const EXTRA_TOKENS = Object.freeze([
  "--boss-on-accent", "--boss-accent-muted", "--boss-backdrop", "--boss-scrollbar-thumb", "--boss-scrollbar-track", "--boss-code-bg"
]);

/**
 * Is this a declared token (one of the §10 groups, or an extra)?
 * @param {string} token
 * @returns {boolean}
 */
export function knownToken(token) {
  return UI_TOKEN_NAMES.includes(token) || EXTRA_TOKENS.includes(token);
}

export const UI_SURFACE_EXTRA_TOKENS = EXTRA_TOKENS;

/* ------------------------------- registry validation and summary */

/**
 * A registry is only usable if every §9 surface has a contract, every contract
 * reads declared tokens, and any surface without a binding is listed in `unbound`.
 * This is what stops a theme from quietly inventing a surface.
 *
 * Checks run in the donor's order, so `problems` has the donor's order too.
 *
 * @param {{contracts: import("./contracts.mjs").UISurfaceContract[], unbound: string[]}} registry
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateUISurfaceRegistry(registry) {
  const problems = [];
  const ids = new Set(registry.contracts.map((contract) => contract.id));
  for (const seed of SEEDS) {
    if (!ids.has(seed.id)) problems.push(`surface ${seed.id} has no contract`);
  }
  if (ids.size !== registry.contracts.length) problems.push("duplicate surface ids in the registry");
  for (const contract of registry.contracts) {
    if (!contract.allowedProperties.length) problems.push(`${contract.id} allows no properties`);
    if (!contract.defaultTokens.length) problems.push(`${contract.id} declares no default tokens`);
    for (const token of contract.defaultTokens) {
      if (!knownToken(token)) problems.push(`${contract.id} references undeclared token ${token}`);
    }
  }
  const declaredUnbound = new Set(registry.unbound);
  for (const contract of registry.contracts) {
    const bound = contract.componentBindings.length > 0;
    if (!bound && !declaredUnbound.has(contract.id)) problems.push(`${contract.id} has no binding but is not listed in unbound`);
    if (bound && declaredUnbound.has(contract.id)) problems.push(`${contract.id} has a binding but is listed in unbound`);
    for (const binding of contract.componentBindings) {
      if (!binding.file || !binding.evidence) problems.push(`${contract.id} has an evidence-free binding ${binding.value}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Compact statement for a task record / report.
 *
 * @param {{version: string, generated_at: string, contracts: import("./contracts.mjs").UISurfaceContract[], unbound: string[], tokens: Array<{declared: boolean}>, tokens_applied: boolean, style_files: string[], component_files: string[]}} registry
 * @returns {{version: string, generated_at: string, surfaces: number, bound: number, unbound: string[], tokens_declared: number, tokens_total: number, tokens_applied: boolean, style_files: string[], component_files: string[]}}
 */
export function summarizeUISurfaceRegistry(registry) {
  return {
    version: registry.version,
    generated_at: registry.generated_at,
    surfaces: registry.contracts.length,
    bound: registry.contracts.filter((contract) => contract.componentBindings.length > 0).length,
    unbound: [...registry.unbound],
    tokens_declared: registry.tokens.filter((token) => token.declared).length,
    tokens_total: registry.tokens.length,
    tokens_applied: registry.tokens_applied,
    style_files: [...registry.style_files],
    component_files: [...registry.component_files]
  };
}
