/**
 * UTOPIA · 10-automation / Computer Use Runtime — permission contracts and the
 * desktop side-effect gate.
 *
 * Donor: `src/shared/permission.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. Pure and unchanged in behaviour.
 *
 * Permission scope + security classification contracts (plan §17/§18), and
 * `desktopMutationGate` — the command's most-cited side-effect gate, which is what
 * decides whether a desktop computer action may mutate the workspace at all.
 *
 * The donor file shipped with NO test at all, so the tests in
 * `tests/permission.test.mjs` are the first coverage this behaviour has ever had;
 * every expectation there is derived from the donor source lines quoted below.
 *
 * Preserved donor defects (pinned by tests, not repaired):
 *   (a) `manifestAllows` treats an entry as a directory prefix only when it does NOT
 *       already end in "/", appending one otherwise. The two spellings therefore
 *       differ: `"src"` matches the path `"src"` AND every `"src/…"` child, while
 *       `"src/"` matches `"src/…"` children and the literal `"src/"` but NOT `"src"`
 *       itself. On the deny side a trailing slash does block children. The donor
 *       comment on `manifestAllows` and the `manifestNarrow` rule are unchanged.
 *   (b) `desktopMutationGate` returns `{allowed: true}` with NO `reason` key for a
 *       permitted action, and a `{allowed: false, reason}` pair for a denied one, so
 *       `verdict.reason` is `undefined` rather than absent-vs-empty in any
 *       distinguishable way. Kept.
 *   (c) `manifestNarrow` reports only `kind:allow:entry` strings: it never reports a
 *       task `deny` that the workspace `allow`s, so a task cannot be checked for
 *       over-broad denial at all.
 *   (d) `manifestAllows` ignores the `secret`/… deny scopes of any kind other than
 *       the one asked for, which is by construction, but it also means a `deny` entry
 *       in a scope with an empty `allow` produces the same `false` as no entry at all.
 *
 * This module is pure: no filesystem, no network, no clock, no randomness, no
 * environment.
 */

import { DESKTOP_READ_ACTIONS, PERMISSION_KINDS } from "./contracts.mjs";

/** Empty manifest denies everything — the safe default. */
export const EMPTY_MANIFEST = {
  filesystem: { allow: [], deny: [] },
  repo: { allow: [], deny: [] },
  network: { allow: [], deny: [] },
  secret: { allow: [], deny: [] },
  "side-effect": { allow: [], deny: [] }
};

/**
 * Does this manifest allow `value` in `kind`? A `deny` match beats an `allow`
 * match; an empty `allow` list denies everything.
 *
 * @param {import("./contracts.mjs").PermissionManifest} manifest
 * @param {string} kind one of PERMISSION_KINDS
 * @param {string} value
 * @returns {boolean}
 */
export function manifestAllows(manifest, kind, value) {
  const scope = manifest[kind];
  if (scope.deny.some((entry) => value === entry || value.startsWith(entry.endsWith("/") ? entry : entry + "/"))) return false;
  if (!scope.allow.length) return false;
  return scope.allow.some((entry) => value === entry || value.startsWith(entry.endsWith("/") ? entry : entry + "/"));
}

/**
 * Task permissions must never exceed workspace permissions (plan rule 18). Returns
 * the violations found; empty means the task manifest is within bounds.
 *
 * @param {import("./contracts.mjs").PermissionManifest} workspace
 * @param {import("./contracts.mjs").PermissionManifest} task
 * @returns {string[]}
 */
export function manifestNarrow(workspace, task) {
  const violations = [];
  for (const kind of PERMISSION_KINDS) {
    for (const entry of task[kind].allow) {
      if (!manifestAllows(workspace, kind, entry)) violations.push(`${kind}:allow:${entry}`);
    }
  }
  return violations;
}

/**
 * Private AND unused in the donor (line 45): `permission.ts` defines it and never
 * calls it, and the donor does not export it either. Kept verbatim so the port
 * drops nothing; it is not exported and is not reachable from this module's public
 * surface.
 */
function manifestToString(manifest) {
  return PERMISSION_KINDS.flatMap((kind) => manifest[kind].allow.map((entry) => `${kind}:${entry}`)).join(",");
}

/**
 * Fails closed: a desktop mutation with no allow-listed `computer:<name>`
 * side-effect (or no manifest at all) is denied. Reads always pass — like the
 * software runtime's authorize() (§17/§18), mutations alone need the manifest.
 *
 * @param {import("./contracts.mjs").PermissionManifest|undefined} manifest
 * @param {string} actionName
 * @returns {{allowed: boolean, reason?: string}}
 */
export function desktopMutationGate(manifest, actionName) {
  if (DESKTOP_READ_ACTIONS.includes(actionName)) return { allowed: true };
  const key = `computer:${actionName}`;
  if (manifest && manifestAllows(manifest, "side-effect", key)) return { allowed: true };
  return { allowed: false, reason: `Permission gate denied computer ${actionName} (side-effect ${key} not allowed)` };
}
