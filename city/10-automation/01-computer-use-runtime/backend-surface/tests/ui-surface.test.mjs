/**
 * Donor-behaviour pin for the §9/§9.1/§10 UI surface registry.
 *
 * Donor: `src/shared/ui-surface.ts` (310 lines) + `src/shared/ui-surface-ids.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. That pair HAS a donor test
 * (`tests/unit/ui-surface.test.ts`), but its discovery half
 * (`electron/engineering/ui-surface-discovery.ts`, `electron/engineering/world-model.ts`)
 * reads the filesystem and is NOT ported, so every discovery assertion in it is
 * out of scope by boundary. Its registry/vocabulary/override assertions are
 * reproduced here by value.
 *
 * The table below is complete on purpose: all 23 contract rows with their donor
 * category, allowedProperties and defaultTokens, so the port is checked against the
 * donor's values rather than against itself.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  UI_SURFACE_CATEGORIES,
  UI_SURFACE_EXTRA_TOKENS,
  UI_SURFACE_IDS,
  UI_SURFACE_REGISTRY_VERSION,
  UI_TOKEN_GROUPS,
  UI_TOKEN_NAMES,
  defaultSurfaceContracts,
  knownToken,
  surfaceById,
  summarizeUISurfaceRegistry,
  tokenGroupOf,
  validateSurfaceOverride,
  validateUISurfaceRegistry
} from "../ui-surface.mjs";

/** The donor's SEEDS table, transcribed (donor lines 111-135). */
const EXPECTED_SURFACES = [
  ["APP_BACKGROUND", "CANVAS", ["background", "background-color", "background-image", "color"], ["--boss-bg-root", "--boss-text-primary"], "BUILT_IN_DARK"],
  ["SURFACE_PRIMARY", "SURFACE", ["background", "background-color", "background-image", "color", "border-color"], ["--boss-bg-surface", "--boss-text-primary", "--boss-border"], "BUILT_IN_DARK"],
  ["SURFACE_SECONDARY", "SURFACE", ["background", "background-color", "color", "border-color", "box-shadow"], ["--boss-bg-elevated", "--boss-text-secondary", "--boss-shadow"], "BUILT_IN_DARK"],
  ["SIDEBAR", "NAVIGATION", ["background", "background-color", "color", "border-color", "width"], ["--boss-bg-surface", "--boss-text-secondary", "--boss-border"], "BUILT_IN_DARK"],
  ["TOP_NAV", "NAVIGATION", ["background", "background-color", "color", "border-color", "padding"], ["--boss-bg-elevated", "--boss-text-primary", "--boss-border"], "BUILT_IN_DARK"],
  ["CARD", "SURFACE", ["background", "background-color", "border-color", "border-radius", "box-shadow", "color"], ["--boss-bg-elevated", "--boss-border", "--boss-radius", "--boss-shadow"], "BUILT_IN_DARK"],
  ["MODAL", "SURFACE", ["background", "background-color", "backdrop-filter", "border-color", "box-shadow", "color"], ["--boss-bg-elevated", "--boss-backdrop", "--boss-blur", "--boss-shadow"], "BUILT_IN_DARK"],
  ["INPUT", "CONTROL", ["background", "background-color", "border-color", "border-radius", "color", "caret-color", "font-family"], ["--boss-bg-surface", "--boss-border", "--boss-text-primary", "--boss-radius"], "BUILT_IN_DARK"],
  ["BUTTON_PRIMARY", "CONTROL", ["background", "background-color", "border-color", "border-radius", "color", "box-shadow", "font-weight"], ["--boss-accent", "--boss-on-accent", "--boss-radius"], "BUILT_IN_DARK"],
  ["BUTTON_SECONDARY", "CONTROL", ["background", "background-color", "border-color", "border-radius", "color"], ["--boss-bg-elevated", "--boss-border", "--boss-text-secondary", "--boss-radius"], "BUILT_IN_DARK"],
  ["TEXT_PRIMARY", "TYPOGRAPHY", ["color", "font-family", "font-size", "font-weight", "letter-spacing", "line-height"], ["--boss-text-primary", "--boss-font-family", "--boss-line-height"], "BUILT_IN_DARK"],
  ["TEXT_SECONDARY", "TYPOGRAPHY", ["color", "font-size", "letter-spacing", "line-height"], ["--boss-text-secondary", "--boss-text-muted"], "BUILT_IN_DARK"],
  ["BORDER", "LINE", ["border-color", "border-width", "border-style", "border-radius"], ["--boss-border", "--boss-border-width", "--boss-radius"], "INHERIT_PARENT"],
  ["DIVIDER", "LINE", ["border-color", "background-color", "opacity"], ["--boss-divider"], "INHERIT_PARENT"],
  ["ACCENT", "STATE", ["background-color", "color", "box-shadow", "outline-color"], ["--boss-accent", "--boss-accent-muted"], "BUILT_IN_DARK"],
  ["SUCCESS", "STATE", ["background-color", "color", "border-color"], ["--boss-success"], "BUILT_IN_DARK"],
  ["WARNING", "STATE", ["background-color", "color", "border-color"], ["--boss-warning"], "BUILT_IN_DARK"],
  ["DANGER", "STATE", ["background-color", "color", "border-color"], ["--boss-danger"], "BUILT_IN_DARK"],
  ["SCROLLBAR", "SCROLL", ["background-color", "border-radius", "width", "opacity"], ["--boss-scrollbar-thumb", "--boss-scrollbar-track"], "INHERIT_PARENT"],
  ["CODE_PANEL", "CONTENT", ["background", "background-color", "border-color", "border-radius", "color", "font-family", "font-size", "white-space"], ["--boss-code-bg", "--boss-font-mono", "--boss-text-primary"], "BUILT_IN_DARK"],
  ["WORKSPACE_PANEL", "LAYOUT", ["background", "background-color", "border-color", "gap", "padding"], ["--boss-bg-root", "--boss-border"], "BUILT_IN_DARK"],
  ["AI_PANE", "LAYOUT", ["background", "background-color", "border-color", "color"], ["--boss-bg-surface", "--boss-border", "--boss-text-secondary"], "BUILT_IN_DARK"],
  ["STATUS_BADGE", "FEEDBACK", ["background-color", "color", "border-color", "border-radius", "letter-spacing"], ["--boss-bg-elevated", "--boss-text-secondary", "--boss-radius-sm"], "BUILT_IN_DARK"]
];

/** The donor's UI_TOKEN_GROUPS (lines 37-48) and EXTRA_TOKENS (lines 209-211). */
const EXPECTED_TOKEN_GROUPS = {
  color: [
    "--boss-bg-root", "--boss-bg-surface", "--boss-bg-elevated", "--boss-bg-muted",
    "--boss-text-primary", "--boss-text-secondary", "--boss-text-muted",
    "--boss-accent", "--boss-border", "--boss-divider",
    "--boss-success", "--boss-warning", "--boss-danger"
  ],
  shape: ["--boss-radius", "--boss-radius-sm", "--boss-radius-lg", "--boss-border-width", "--boss-shadow"],
  effect: ["--boss-blur", "--boss-opacity", "--boss-transition"],
  typography: ["--boss-font-family", "--boss-font-mono", "--boss-font-size", "--boss-line-height", "--boss-letter-spacing"],
  density: ["--boss-spacing-density", "--boss-space-1", "--boss-space-2", "--boss-space-3", "--boss-space-4"]
};
const EXPECTED_EXTRA_TOKENS = [
  "--boss-on-accent", "--boss-accent-muted", "--boss-backdrop", "--boss-scrollbar-thumb", "--boss-scrollbar-track", "--boss-code-bg"
];
const EXPECTED_TOKEN_NAMES = Object.values(EXPECTED_TOKEN_GROUPS).flat();

/** A registry whose contracts all have a contract, tokens and an honest unbound list. */
function balancedRegistry() {
  const contracts = defaultSurfaceContracts();
  return {
    schemaVersion: 1,
    version: UI_SURFACE_REGISTRY_VERSION,
    generated_at: "2026-01-01T00:00:00.000Z",
    root: "/repo",
    contracts,
    unbound: contracts.map((contract) => contract.id),
    tokens: [],
    tokens_applied: false,
    style_files: [],
    component_files: []
  };
}

/* ---------------------------------------------------------------- vocabulary */

test("the surface id vocabulary is the donor's 23 ids in the donor's order, frozen", () => {
  assert.deepEqual([...UI_SURFACE_IDS], EXPECTED_SURFACES.map((row) => row[0]));
  assert.equal(UI_SURFACE_IDS.length, 23);
  assert.equal(new Set(UI_SURFACE_IDS).size, 23);
  assert.equal(Object.isFrozen(UI_SURFACE_IDS), true);
});

test("the registry version string is the donor's literal", () => {
  assert.equal(UI_SURFACE_REGISTRY_VERSION, "ui-surface-registry-1");
  assert.equal(UI_SURFACE_REGISTRY_VERSION.length, 21);
});

test("the eleven surface categories are the donor's, in order", () => {
  assert.deepEqual([...UI_SURFACE_CATEGORIES], [
    "CANVAS", "SURFACE", "NAVIGATION", "CONTROL", "TYPOGRAPHY", "LINE", "STATE", "SCROLL", "CONTENT", "LAYOUT", "FEEDBACK"
  ]);
  assert.equal(UI_SURFACE_CATEGORIES.length, 11);
});

test("the §10 token groups are the donor's five groups and 31 names, in order", () => {
  assert.deepEqual(Object.keys(UI_TOKEN_GROUPS), ["color", "shape", "effect", "typography", "density"]);
  for (const [group, names] of Object.entries(EXPECTED_TOKEN_GROUPS)) {
    assert.deepEqual([...UI_TOKEN_GROUPS[group]], names, group);
  }
  assert.deepEqual([...UI_TOKEN_NAMES], EXPECTED_TOKEN_NAMES);
  // 13 color + 5 shape + 3 effect + 5 typography + 5 density.
  assert.deepEqual(Object.values(EXPECTED_TOKEN_GROUPS).map((names) => names.length), [13, 5, 3, 5, 5]);
  assert.equal(UI_TOKEN_NAMES.length, 31);
  assert.equal(Object.isFrozen(UI_TOKEN_NAMES), true);
  // The extra tokens are the donor's six, and none of them is a §10 group member.
  assert.deepEqual([...UI_SURFACE_EXTRA_TOKENS], EXPECTED_EXTRA_TOKENS);
  assert.equal(UI_SURFACE_EXTRA_TOKENS.length, 6);
  for (const token of EXPECTED_EXTRA_TOKENS) {
    assert.equal(EXPECTED_TOKEN_NAMES.includes(token), false, `${token} must not be a §10 group member`);
    assert.equal(knownToken(token), true, `${token} must be known via EXTRA_TOKENS`);
  }
});

test("tokenGroupOf resolves each group and rejects a token in no group", () => {
  assert.equal(tokenGroupOf("--boss-accent"), "color");
  assert.equal(tokenGroupOf("--boss-radius"), "shape");
  assert.equal(tokenGroupOf("--boss-blur"), "effect");
  assert.equal(tokenGroupOf("--boss-font-mono"), "typography");
  assert.equal(tokenGroupOf("--boss-space-3"), "density");
  assert.equal(tokenGroupOf("--boss-spacing-density"), "density");
  assert.equal(tokenGroupOf("--boss-backdrop"), undefined, "an extra token belongs to no §10 group");
  assert.equal(tokenGroupOf("--boss-invented"), undefined);
  assert.equal(tokenGroupOf(""), undefined);
});

test("knownToken accepts the §10 names and the six extras, nothing else", () => {
  for (const token of EXPECTED_TOKEN_NAMES) assert.equal(knownToken(token), true, token);
  for (const token of EXPECTED_EXTRA_TOKENS) assert.equal(knownToken(token), true, token);
  for (const token of ["--boss-invented-token", "--boss-bg", "", "boss-accent"]) assert.equal(knownToken(token), false, token);
});

/* ---------------------------------------------------------------- contract table */

test("defaultSurfaceContracts covers every §9 surface exactly once, in id order", () => {
  const contracts = defaultSurfaceContracts();
  assert.deepEqual(contracts.map((contract) => contract.id), [...UI_SURFACE_IDS]);
  assert.equal(new Set(contracts.map((contract) => contract.id)).size, UI_SURFACE_IDS.length);
});

test("every contract row carries the donor's category, allowedProperties, defaultTokens and fallback", () => {
  const contracts = defaultSurfaceContracts();
  assert.equal(contracts.length, EXPECTED_SURFACES.length);
  contracts.forEach((contract, index) => {
    const [id, category, allowedProperties, defaultTokens, strategy] = EXPECTED_SURFACES[index];
    assert.equal(contract.id, id);
    assert.equal(contract.category, category, id);
    assert.deepEqual(contract.allowedProperties, allowedProperties, `${id} allowedProperties`);
    assert.deepEqual(contract.defaultTokens, defaultTokens, `${id} defaultTokens`);
    assert.equal(contract.fallback.strategy, strategy, `${id} fallback.strategy`);
    assert.equal(contract.componentBindings.length, 0, `${id} starts unbound`);
    assert.equal(contract.locked, undefined, `${id} is not locked in the donor's SEEDS`);
    assert.equal(typeof contract.description === "string" && contract.description.length > 0, true, `${id} description`);
  });
});

test("the two fallback notes are the donor's strings and only BORDER/DIVIDER/SCROLLBAR inherit", () => {
  const inheriting = defaultSurfaceContracts().filter((contract) => contract.fallback.strategy === "INHERIT_PARENT");
  assert.deepEqual(inheriting.map((contract) => contract.id), ["BORDER", "DIVIDER", "SCROLLBAR"]);
  for (const contract of inheriting) {
    assert.equal(contract.fallback.note, "no value of its own: inherits the enclosing surface");
  }
  const dark = defaultSurfaceContracts().filter((contract) => contract.fallback.strategy === "BUILT_IN_DARK");
  assert.equal(dark.length, 20);
  for (const contract of dark) {
    assert.equal(contract.fallback.note, "falls back to the locked built-in Dark theme");
  }
});

test("every contract reads only known tokens and allows at least one property", () => {
  for (const contract of defaultSurfaceContracts()) {
    assert.equal(contract.allowedProperties.length > 0, true, contract.id);
    assert.equal(contract.defaultTokens.length > 0, true, contract.id);
    for (const token of contract.defaultTokens) assert.equal(knownToken(token), true, `${contract.id} → ${token}`);
  }
});

test("defaultSurfaceContracts returns fresh arrays and fallback objects each call", () => {
  const first = defaultSurfaceContracts();
  const second = defaultSurfaceContracts();
  assert.notEqual(first, second);
  assert.notEqual(first[0].allowedProperties, second[0].allowedProperties);
  assert.notEqual(first[0].defaultTokens, second[0].defaultTokens);
  assert.notEqual(first[0].componentBindings, second[0].componentBindings);
  assert.notEqual(first[0].fallback, second[0].fallback);
  first[0].allowedProperties.push("mutated");
  first[0].fallback.strategy = "UNCHANGED";
  assert.deepEqual(second[0].allowedProperties, EXPECTED_SURFACES[0][2]);
  assert.equal(second[0].fallback.strategy, "BUILT_IN_DARK");
});

test("surfaceById finds a contract by id and returns undefined otherwise", () => {
  assert.equal(surfaceById("CODE_PANEL").category, "CONTENT");
  assert.equal(surfaceById("NOPE"), undefined);
  const custom = [{ id: "SIDEBAR", category: "NAVIGATION", description: "d", allowedProperties: ["color"], defaultTokens: ["--boss-accent"], componentBindings: [], fallback: { strategy: "UNCHANGED", note: "n" } }];
  assert.equal(surfaceById("CODE_PANEL", custom), undefined, "the caller's table wins over the default");
  assert.equal(surfaceById("SIDEBAR", custom).description, "d");
});

/* ---------------------------------------------------------------- §20 overrides */

test("§9.1 an allowed property with a literal or a declared token is accepted, property normalised", () => {
  assert.deepEqual(validateSurfaceOverride({ surface: "SIDEBAR", property: "background-color", value: "#101418" }), { ok: true, surface: "SIDEBAR", property: "background-color" });
  assert.deepEqual(validateSurfaceOverride({ surface: "SIDEBAR", property: "background-color", value: "var(--boss-bg-surface)" }), { ok: true, surface: "SIDEBAR", property: "background-color" });
  // Trimmed + lower-cased property, trimmed value.
  assert.deepEqual(validateSurfaceOverride({ surface: "SIDEBAR", property: "  Background-Color  ", value: "  #101418  " }), { ok: true, surface: "SIDEBAR", property: "background-color" });
  assert.equal(validateSurfaceOverride({ surface: "SIDEBAR", property: "WIDTH", value: "200px" }).ok, true);
});

test("§9.1 an unknown surface fails closed with UNKNOWN_SURFACE", () => {
  const verdict = validateSurfaceOverride({ surface: "RANDOM_DIV", property: "color", value: "#fff" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "UNKNOWN_SURFACE");
  assert.equal(verdict.detail, "RANDOM_DIV is not a registered UI surface");
});

test("§9.1 a property the surface does not allow fails closed with UNKNOWN_PROPERTY", () => {
  const verdict = validateSurfaceOverride({ surface: "SIDEBAR", property: "position", value: "fixed" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "UNKNOWN_PROPERTY");
  assert.equal(verdict.detail, "SIDEBAR does not allow the property position; allowed: background, background-color, color, border-color, width");
  // A property another surface allows is still refused here.
  assert.equal(validateSurfaceOverride({ surface: "ACCENT", property: "font-size", value: "14px" }).code, "UNKNOWN_PROPERTY");
});

test("§9.1 an empty value fails closed with EMPTY_VALUE, checked after the property", () => {
  const blank = validateSurfaceOverride({ surface: "ACCENT", property: "color", value: "   " });
  assert.equal(blank.ok, false);
  assert.equal(blank.code, "EMPTY_VALUE");
  assert.equal(blank.detail, "an override value cannot be empty");
  // Precedence: a bad property outranks an empty value.
  assert.equal(validateSurfaceOverride({ surface: "ACCENT", property: "nope", value: "" }).code, "UNKNOWN_PROPERTY");
});

test("§20 unsafe values fail closed with UNSAFE_VALUE, in pattern order", () => {
  const cases = [
    ["url(https://evil.example/x.png)", /url\(\s*['"]?\s*(?:https?:)?\/\//i],
    ["javascript:alert(1)", /javascript:/i],
    ["expression(alert(1))", /expression\s*\(/i],
    ["@import url(x)", /@import/i]
  ];
  for (const [value, pattern] of cases) {
    const verdict = validateSurfaceOverride({ surface: "APP_BACKGROUND", property: "background-image", value });
    assert.equal(verdict.ok, false, value);
    assert.equal(verdict.code, "UNSAFE_VALUE", value);
    assert.equal(verdict.detail, `value rejected by §20 (${pattern}): ${value.slice(0, 80)}`, value);
  }
  // The remaining three donor patterns.
  for (const value of ["<script>alert(1)</script>", "behavior: url(#default#time2)", "binding: x"]) {
    assert.equal(validateSurfaceOverride({ surface: "APP_BACKGROUND", property: "background-image", value }).code, "UNSAFE_VALUE", value);
  }
});

test("DEFECT PINNED: the unsafe patterns match their substring anywhere, including benign values", () => {
  // /behavior\s*:/i and /binding\s*:/i reject the word anywhere in the value, so a
  // perfectly innocent literal is refused. Preserved, not narrowed.
  assert.equal(validateSurfaceOverride({ surface: "SIDEBAR", property: "color", value: "rgb(1,2,3) /* behavior: none */" }).code, "UNSAFE_VALUE");
  assert.equal(validateSurfaceOverride({ surface: "SIDEBAR", property: "color", value: "red /* binding: unused */" }).code, "UNSAFE_VALUE");
  assert.equal(validateSurfaceOverride({ surface: "SIDEBAR", property: "color", value: "BEHAVIOR : x" }).code, "UNSAFE_VALUE");
});

test("DEFECT PINNED: the §10 token scan is var()-only and stops at an underscore", () => {
  // The donor's pattern is /var\(\s*(--[a-z0-9-]+)/gi, so:
  //   * a reference written without var() is never examined at all;
  //   * the class has no "_", so a capture stops at the first underscore.
  // Both are preserved; the first accepts an undeclared token outright, the second
  // accepts one whose truncated PREFIX happens to be declared.
  const invented = validateSurfaceOverride({ surface: "ACCENT", property: "color", value: "var(--boss-invented-token)" });
  assert.equal(invented.ok, false);
  assert.equal(invented.code, "UNKNOWN_TOKEN");
  assert.equal(invented.detail, "--boss-invented-token is not a declared §10 token");

  // Bare reference: no var(), no scan, accepted.
  assert.equal(validateSurfaceOverride({ surface: "ACCENT", property: "color", value: "--boss-invented-token" }).ok, true, "a bare custom property is never scanned");

  // Underscore: the capture stops before it, so a declared prefix carries the value.
  assert.equal(validateSurfaceOverride({ surface: "ACCENT", property: "color", value: "var(--boss-accent_muted)" }).ok, true, "captured as --boss-accent, which is declared");
  assert.deepEqual(validateSurfaceOverride({ surface: "ACCENT", property: "color", value: "var(--boss-invented_token)" }), {
    ok: false, code: "UNKNOWN_TOKEN", detail: "--boss-invented is not a declared §10 token"
  }, "the detail names the truncated capture, not the caller's text");

  // The scan is otherwise thorough: case-insensitive wrapper, embedded in a value,
  // repeated references (the first is reported), and an unterminated reference.
  for (const value of ["VAR(--boss-invented)", "url(x) var(--boss-invented)", "var(--boss-invented) var(--boss-also)", "var(--boss-invented"]) {
    assert.equal(validateSurfaceOverride({ surface: "ACCENT", property: "color", value }).code, "UNKNOWN_TOKEN", value);
  }
  assert.equal(validateSurfaceOverride({ surface: "ACCENT", property: "color", value: "var(--boss-invented) var(--boss-also)" }).detail, "--boss-invented is not a declared §10 token");

  // A valid token reference passes the scan, with or without inner space.
  assert.equal(validateSurfaceOverride({ surface: "ACCENT", property: "color", value: "var(--boss-bg-surface)" }).ok, true);
  assert.equal(validateSurfaceOverride({ surface: "ACCENT", property: "color", value: "var( --boss-bg-surface)" }).ok, true);
  // A doubled hyphen is inside the class and is caught.
  const doubled = validateSurfaceOverride({ surface: "ACCENT", property: "color", value: "var(--boss-bg--invented)" });
  assert.equal(doubled.ok, false);
  assert.equal(doubled.code, "UNKNOWN_TOKEN");
  assert.equal(doubled.detail, "--boss-bg--invented is not a declared §10 token");
  // A non --boss- custom property is ignored entirely by the scan.
  assert.equal(validateSurfaceOverride({ surface: "ACCENT", property: "color", value: "var(--other-thing--x)" }).ok, true);
  // Every --boss- token in the donor's own default table is accepted as a value.
  for (const contract of defaultSurfaceContracts()) {
    for (const token of contract.defaultTokens) {
      assert.equal(validateSurfaceOverride({ surface: "ACCENT", property: "color", value: `var(${token})` }).ok, true, `${contract.id} → ${token}`);
    }
  }
  // The donor's own test used a SIDEBAR/background-color combination, which is an
  // allowed property, so its `ok: false` verdict WAS the §10 case it named.
  assert.equal(validateSurfaceOverride({ surface: "SIDEBAR", property: "background-color", value: "var(--boss-invented-token)" }).code, "UNKNOWN_TOKEN");
});

test("DEFECT PINNED: LOCKED_SURFACE is unreachable with the donor's SEEDS table", () => {
  // No seed carries `locked: true`, so no default contract can hit the branch.
  assert.equal(defaultSurfaceContracts().some((contract) => contract.locked === true), false);
  // The branch itself is real and is reached when a caller's own table locks one.
  const locked = [{ ...defaultSurfaceContracts()[0], locked: true }];
  const verdict = validateSurfaceOverride({ surface: "APP_BACKGROUND", property: "color", value: "#fff" }, locked);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "LOCKED_SURFACE");
  assert.equal(verdict.detail, "APP_BACKGROUND is locked and cannot be themed");
  // LOCKED_SURFACE outranks the property check.
  assert.equal(validateSurfaceOverride({ surface: "APP_BACKGROUND", property: "nope", value: "#fff" }, locked).code, "LOCKED_SURFACE");
});

/* ---------------------------------------------------------------- registry validation */

test("validateUISurfaceRegistry accepts a complete, honest registry", () => {
  assert.deepEqual(validateUISurfaceRegistry(balancedRegistry()), { ok: true, problems: [] });
});

test("validateUISurfaceRegistry reports every missing surface contract, in seed order", () => {
  const registry = balancedRegistry();
  registry.contracts = registry.contracts.slice(0, 3);
  const validation = validateUISurfaceRegistry(registry);
  assert.equal(validation.ok, false);
  assert.equal(validation.problems.length, 20);
  assert.equal(validation.problems[0], "surface SIDEBAR has no contract");
  assert.equal(validation.problems.at(-1), "surface STATUS_BADGE has no contract");
  assert.equal(validation.problems.some((problem) => problem.includes("has no contract")), true);
});

test("validateUISurfaceRegistry reports duplicate ids, empty properties, empty tokens and undeclared tokens", () => {
  const duplicate = balancedRegistry();
  duplicate.contracts = [...duplicate.contracts, { ...defaultSurfaceContracts()[0] }];
  assert.equal(validateUISurfaceRegistry(duplicate).problems.includes("duplicate surface ids in the registry"), true);

  const noProperties = balancedRegistry();
  noProperties.contracts[0] = { ...noProperties.contracts[0], allowedProperties: [] };
  assert.equal(validateUISurfaceRegistry(noProperties).problems.includes("APP_BACKGROUND allows no properties"), true);

  const noTokens = balancedRegistry();
  noTokens.contracts[0] = { ...noTokens.contracts[0], defaultTokens: [] };
  assert.equal(validateUISurfaceRegistry(noTokens).problems.includes("APP_BACKGROUND declares no default tokens"), true);

  const undeclared = balancedRegistry();
  undeclared.contracts[0] = { ...undeclared.contracts[0], defaultTokens: ["--boss-nope"] };
  assert.equal(validateUISurfaceRegistry(undeclared).problems.includes("APP_BACKGROUND references undeclared token --boss-nope"), true);
});

test("validateUISurfaceRegistry enforces the unbound list in both directions", () => {
  const missing = balancedRegistry();
  missing.unbound = missing.unbound.filter((id) => id !== "ACCENT");
  assert.equal(validateUISurfaceRegistry(missing).problems.includes("ACCENT has no binding but is not listed in unbound"), true);

  const surplus = balancedRegistry();
  surplus.contracts[0] = {
    ...surplus.contracts[0],
    componentBindings: [{ kind: "css-class", value: ".app-canvas", file: "src/renderer/styles.css", evidence: ".app-canvas { … }" }]
  };
  const validation = validateUISurfaceRegistry(surplus);
  assert.equal(validation.problems.includes("APP_BACKGROUND has a binding but is listed in unbound"), true);
  surplus.unbound = surplus.unbound.filter((id) => id !== "APP_BACKGROUND");
  assert.deepEqual(validateUISurfaceRegistry(surplus), { ok: true, problems: [] });
});

test("validateUISurfaceRegistry refuses an evidence-free binding", () => {
  const registry = balancedRegistry();
  registry.unbound = registry.unbound.filter((id) => id !== "APP_BACKGROUND");
  registry.contracts[0] = { ...registry.contracts[0], componentBindings: [{ kind: "css-class", value: ".app-canvas", file: "", evidence: "" }] };
  assert.equal(validateUISurfaceRegistry(registry).problems.includes("APP_BACKGROUND has an evidence-free binding .app-canvas"), true);
});

/* ---------------------------------------------------------------- summary */

test("summarizeUISurfaceRegistry reports every summary field from the registry", () => {
  const registry = {
    schemaVersion: 1,
    version: UI_SURFACE_REGISTRY_VERSION,
    generated_at: "2026-01-01T00:00:00.000Z",
    root: "/repo",
    contracts: defaultSurfaceContracts(),
    unbound: ["SCROLLBAR"],
    tokens: [{ name: "--boss-accent", group: "color", declared: false, evidence: [] }],
    tokens_applied: false,
    style_files: ["src/renderer/styles.css"],
    component_files: ["src/renderer/main.tsx"]
  };
  const summary = summarizeUISurfaceRegistry(registry);
  assert.deepEqual(Object.keys(summary), [
    "version", "generated_at", "surfaces", "bound", "unbound", "tokens_declared", "tokens_total", "tokens_applied", "style_files", "component_files"
  ]);
  assert.equal(summary.version, "ui-surface-registry-1");
  assert.equal(summary.generated_at, "2026-01-01T00:00:00.000Z");
  assert.equal(summary.surfaces, UI_SURFACE_IDS.length);
  assert.equal(summary.bound, 0);
  assert.deepEqual(summary.unbound, ["SCROLLBAR"]);
  assert.equal(summary.tokens_declared, 0);
  assert.equal(summary.tokens_total, 1);
  assert.equal(summary.tokens_applied, false);
  assert.deepEqual(summary.style_files, ["src/renderer/styles.css"]);
  assert.deepEqual(summary.component_files, ["src/renderer/main.tsx"]);
});

test("summarizeUISurfaceRegistry counts bound surfaces and declared tokens, and copies its arrays", () => {
  const contracts = defaultSurfaceContracts();
  contracts[0] = { ...contracts[0], componentBindings: [{ kind: "css-class", value: ".app-canvas", file: "f", evidence: "e" }] };
  contracts[1] = { ...contracts[1], componentBindings: [{ kind: "token", value: "--boss-bg-surface", file: "f", evidence: "e" }] };
  const registry = {
    version: UI_SURFACE_REGISTRY_VERSION,
    generated_at: "2026-02-02T00:00:00.000Z",
    contracts,
    unbound: ["SCROLLBAR"],
    tokens: [
      { name: "--boss-accent", group: "color", declared: true, evidence: ["a.css"] },
      { name: "--boss-on-accent", group: "extended", declared: true, evidence: ["a.css"] },
      { name: "--boss-backdrop", group: "extended", declared: false, evidence: [] }
    ],
    tokens_applied: true,
    style_files: ["a.css"],
    component_files: ["App.tsx"]
  };
  const summary = summarizeUISurfaceRegistry(registry);
  assert.equal(summary.bound, 2);
  assert.equal(summary.surfaces, 23);
  assert.equal(summary.tokens_declared, 2);
  assert.equal(summary.tokens_total, 3);
  assert.equal(summary.tokens_applied, true);
  // Arrays are copied, not aliased.
  summary.unbound.push("MUTATED");
  summary.style_files.push("b.css");
  assert.deepEqual(registry.unbound, ["SCROLLBAR"]);
  assert.deepEqual(registry.style_files, ["a.css"]);
});
