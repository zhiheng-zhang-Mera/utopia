/**
 * FIRST coverage of `src/shared/permission.ts`.
 *
 * Donor: `src/shared/permission.ts` @ 8df428eaa437a409368401e95194e40266b83080.
 * The donor file ships with NO test at all — `tests/unit/` has no
 * `permission.test.ts`, and the donor exercises this module only indirectly
 * (`scripts/permission-surface-report.cjs`, `electron/security/permission-manifest.ts`,
 * `electron/capability/permission-contract.ts`). Every expectation below is
 * derived from the donor source: `PERMISSION_KINDS` (line 4), `EMPTY_MANIFEST`
 * (line 14), `manifestAllows` (lines 24-29), `manifestNarrow` (lines 35-43), the
 * four `DESKTOP_READ_ACTIONS` (line 56), and `desktopMutationGate` (lines 68-73).
 *
 * `desktopMutationGate` is the command's most-cited side-effect gate, so its
 * allow/deny/absent-manifest cases are covered exhaustively here.
 *
 * The four preserved defects this file pins are documented in the module header of
 * `../permission.mjs`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { DESKTOP_READ_ACTIONS, PERMISSION_KINDS, SECURITY_CLASSES } from "../contracts.mjs";
import { EMPTY_MANIFEST, desktopMutationGate, manifestAllows, manifestNarrow } from "../permission.mjs";

/** Build a full manifest from partial scopes; kinds not named get empty scopes. */
function manifest(spec = {}) {
  const out = {};
  for (const kind of PERMISSION_KINDS) {
    out[kind] = { allow: [...(spec[kind]?.allow ?? [])], deny: [...(spec[kind]?.deny ?? [])] };
  }
  return out;
}

test("the permission vocabulary is the donor's five kinds and four security classes, frozen", () => {
  assert.deepEqual([...PERMISSION_KINDS], ["filesystem", "repo", "network", "secret", "side-effect"]);
  assert.deepEqual([...SECURITY_CLASSES], ["PUBLIC", "INTERNAL", "SECRET", "GUARDIAN"]);
  assert.equal(Object.isFrozen(PERMISSION_KINDS), true);
  assert.equal(Object.isFrozen(SECURITY_CLASSES), true);
  assert.deepEqual([...DESKTOP_READ_ACTIONS], ["read_page", "find_control", "verify_state", "wait_for_state"]);
});

test("EMPTY_MANIFEST is the donor's five empty scopes", () => {
  assert.deepEqual(Object.keys(EMPTY_MANIFEST), ["filesystem", "repo", "network", "secret", "side-effect"]);
  for (const kind of PERMISSION_KINDS) {
    assert.deepEqual(EMPTY_MANIFEST[kind], { allow: [], deny: [] }, kind);
  }
});

/* ---------------------------------------------------------------- manifestAllows */

test("manifestAllows: an empty allow list denies everything, even a perfect match", () => {
  assert.equal(manifestAllows(EMPTY_MANIFEST, "filesystem", "src/a.ts"), false);
  assert.equal(manifestAllows(manifest({ repo: { deny: ["src"] } }), "repo", "src/a.ts"), false);
});

test("manifestAllows: an exact allow entry is allowed, a non-entry is not", () => {
  const m = manifest({ filesystem: { allow: ["src/a.ts"] } });
  assert.equal(manifestAllows(m, "filesystem", "src/a.ts"), true);
  assert.equal(manifestAllows(m, "filesystem", "src/a.tsx"), false);
  assert.equal(manifestAllows(m, "filesystem", "src"), false);
  assert.equal(manifestAllows(m, "filesystem", ""), false);
});

test("manifestAllows: an entry without a trailing slash is also a directory prefix", () => {
  const m = manifest({ repo: { allow: ["src"] } });
  assert.equal(manifestAllows(m, "repo", "src"), true);
  assert.equal(manifestAllows(m, "repo", "src/a.ts"), true);
  assert.equal(manifestAllows(m, "repo", "src/nested/deep.ts"), true);
  assert.equal(manifestAllows(m, "repo", "src2/a.ts"), false, "the separator is required");
  assert.equal(manifestAllows(m, "repo", "other/src/a.ts"), false);
  assert.equal(manifestAllows(m, "repo", "sr"), false);
});

test("manifestAllows: a deny entry outranks any allow entry", () => {
  const m = manifest({ network: { allow: ["api"], deny: ["api/secret"] } });
  assert.equal(manifestAllows(m, "network", "api/public"), true);
  assert.equal(manifestAllows(m, "network", "api/secret"), false);
  assert.equal(manifestAllows(m, "network", "api/secret/deeper"), false);
  // A deny with no allow list still means no.
  assert.equal(manifestAllows(manifest({ network: { deny: ["api"] } }), "network", "api/x"), false);
});

test("DEFECT PINNED: a trailing-slash entry is not equivalent to the bare entry", () => {
  // The donor appends "/" only when the entry does NOT already end in "/", so the two
  // spellings behave differently:
  //   "src"  → matches "src" exactly AND every "src/…" child;
  //   "src/" → matches "src/…" children AND the literal "src/", but NOT "src" itself.
  // A manifest that means "the src tree" therefore grants nothing to the path "src"
  // when it is spelled with a trailing slash. Preserved, not repaired.
  const bare = manifest({ repo: { allow: ["src"] } });
  assert.equal(manifestAllows(bare, "repo", "src"), true);
  assert.equal(manifestAllows(bare, "repo", "src/a.ts"), true);

  const slash = manifest({ repo: { allow: ["src/"] } });
  assert.equal(manifestAllows(slash, "repo", "src/a.ts"), true, "the prefix does match children");
  assert.equal(manifestAllows(slash, "repo", "src/nested/deep.ts"), true);
  assert.equal(manifestAllows(slash, "repo", "src/"), true, "the literal entry matches");
  assert.equal(manifestAllows(slash, "repo", "src"), false, "the bare entry does NOT — the two spellings differ");

  // The same asymmetry on the deny side: a trailing-slash DENY does block children.
  const denySlash = manifest({ repo: { allow: ["src"], deny: ["src/private/"] } });
  assert.equal(manifestAllows(denySlash, "repo", "src/private/x.ts"), false);
  assert.equal(manifestAllows(denySlash, "repo", "src/private"), true, "but not the bare directory");
});

test("manifestAllows reads only the scope it was asked about", () => {
  const m = manifest({ filesystem: { allow: ["src"] }, network: { allow: ["api"] } });
  assert.equal(manifestAllows(m, "filesystem", "api"), false);
  assert.equal(manifestAllows(m, "network", "src"), false);
  assert.equal(manifestAllows(m, "side-effect", "computer:submit"), false);
});

/* ---------------------------------------------------------------- manifestNarrow */

test("manifestNarrow reports task allow entries the workspace does not allow, as kind:allow:entry", () => {
  const workspace = manifest({ repo: { allow: ["src", "docs/readme.md"] } });
  assert.deepEqual(manifestNarrow(workspace, manifest()), []);
  assert.deepEqual(manifestNarrow(workspace, manifest({ repo: { allow: ["src/lib"] } })), []);
  assert.deepEqual(manifestNarrow(workspace, manifest({ repo: { allow: ["src/lib", "tests"] } })), ["repo:allow:tests"]);
  // Order follows PERMISSION_KINDS, then the task's own allow order.
  const violations = manifestNarrow(workspace, manifest({
    "side-effect": { allow: ["computer:submit", "computer:click_control"] },
    repo: { allow: ["nope"] },
    filesystem: { allow: ["also-nope"] }
  }));
  assert.deepEqual(violations, ["filesystem:allow:also-nope", "repo:allow:nope", "side-effect:allow:computer:submit", "side-effect:allow:computer:click_control"]);
});

test("DEFECT PINNED: manifestNarrow never reports an over-broad task deny", () => {
  // Only `task[kind].allow` is walked, so a task that denies what the workspace
  // allows is reported as within bounds. Preserved as a boundary limit, not repaired.
  const workspace = manifest({ repo: { allow: ["src"] } });
  assert.deepEqual(manifestNarrow(workspace, manifest({ repo: { allow: ["src"], deny: ["src"] } })), []);
});

/* ---------------------------------------------------------------- desktopMutationGate */

test("desktopMutationGate always allows the four read actions, with no manifest at all", () => {
  // Donor line 56: read_page, find_control, verify_state, wait_for_state.
  for (const action of ["read_page", "find_control", "verify_state", "wait_for_state"]) {
    assert.deepEqual(desktopMutationGate(undefined, action), { allowed: true }, action);
    assert.deepEqual(desktopMutationGate(EMPTY_MANIFEST, action), { allowed: true }, action);
  }
  // "open_app" and "focus_window" are NOT in the donor's read set: they are
  // mutations and need a grant.
  for (const action of ["open_app", "focus_window"]) {
    assert.equal(desktopMutationGate(undefined, action).allowed, false, action);
  }
});

test("desktopMutationGate denies a mutation when there is no manifest (fails closed)", () => {
  const verdict = desktopMutationGate(undefined, "click_control");
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "Permission gate denied computer click_control (side-effect computer:click_control not allowed)");
  assert.deepEqual(Object.keys(verdict), ["allowed", "reason"]);
});

test("desktopMutationGate denies a mutation when the manifest has no side-effect allow", () => {
  assert.equal(desktopMutationGate(EMPTY_MANIFEST, "submit").allowed, false);
  assert.equal(desktopMutationGate(manifest({ filesystem: { allow: ["src"] } }), "submit").allowed, false);
  assert.equal(
    desktopMutationGate(manifest({ "side-effect": { allow: ["computer:read_page"] } }), "submit").reason,
    "Permission gate denied computer submit (side-effect computer:submit not allowed)"
  );
});

test("desktopMutationGate allows a mutation only when its computer:<action> entry is allow-listed", () => {
  const granted = manifest({ "side-effect": { allow: ["computer:submit", "computer:enter_text"] } });
  assert.deepEqual(desktopMutationGate(granted, "submit"), { allowed: true });
  assert.deepEqual(desktopMutationGate(granted, "enter_text"), { allowed: true });
  assert.equal(desktopMutationGate(granted, "click_control").allowed, false);
  // The action name is used verbatim in the key: the gate does not lowercase,
  // trim or normalise it.
  assert.equal(desktopMutationGate(granted, "Submit").allowed, false);
  assert.equal(desktopMutationGate(granted, " submit").allowed, false);
  // An allowed parent prefix grants the key, because manifestAllows is prefix-based.
  assert.equal(desktopMutationGate(manifest({ "side-effect": { allow: ["computer:submit/extra"] } }), "submit").allowed, false, "a longer entry is not a prefix of the key");
});

test("desktopMutationGate lets a deny entry beat an allow entry for the same key", () => {
  const conflicting = manifest({ "side-effect": { allow: ["computer:submit", "computer:click_control"], deny: ["computer:submit"] } });
  assert.deepEqual(desktopMutationGate(conflicting, "submit"), { allowed: false, reason: "Permission gate denied computer submit (side-effect computer:submit not allowed)" });
  assert.deepEqual(desktopMutationGate(conflicting, "click_control"), { allowed: true });
});

test("a side-effect prefix entry cannot grant a computer: key, because the entry separator is / and the key separator is :", () => {
  // `manifestAllows` appends "/" to any entry that does not end in "/", so an entry
  // of "computer" becomes the prefix "computer/", which "computer:submit" does not
  // start with. Only the exact key grants. Preserved, not repaired.
  assert.equal(desktopMutationGate(manifest({ "side-effect": { allow: ["computer"] } }), "submit").allowed, false);
  assert.equal(desktopMutationGate(manifest({ "side-effect": { allow: ["computer:"] } }), "submit").allowed, false);
  assert.equal(desktopMutationGate(manifest({ "side-effect": { allow: ["computer:submit"] } }), "submit").allowed, true);
});
test("DEFECT PINNED: a permitted verdict carries no reason key at all", () => {
  const allowed = desktopMutationGate(undefined, "read_page");
  assert.equal("reason" in allowed, false);
  assert.deepEqual(allowed, { allowed: true });
  const granted = desktopMutationGate(manifest({ "side-effect": { allow: ["computer:submit"] } }), "submit");
  assert.equal("reason" in granted, false);
});

test("the read set and the mutation check are the only two paths through the gate", () => {
  // A read action bypasses the manifest entirely — even a manifest that denies
  // computer:read_page cannot block it (reads need no lease).
  const denying = manifest({ "side-effect": { allow: [], deny: ["computer:read_page"] } });
  assert.deepEqual(desktopMutationGate(denying, "read_page"), { allowed: true });
  // Every other name is a mutation to the gate.
  for (const action of ["open_app", "focus_window", "find_control ".trim(), "submit", "enter_text", "click_control", "unknown_action", ""]) {
    if (DESKTOP_READ_ACTIONS.includes(action)) continue;
    assert.equal(desktopMutationGate(undefined, action).allowed, false, JSON.stringify(action));
  }
});
