/**
 * UTOPIA · 10-automation / Computer Use Runtime — semantic action validator.
 *
 * Donor: `src/shared/semantic.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. Pure and unchanged in behaviour.
 *
 * This is the validator `electron/computer/semantic-runtime.ts` calls before it
 * routes an action to any backend (`validateSemanticAction(action)`, donor line 19
 * of that file), and the goal-text translator for the donor's `desktop {…}` command
 * form. The donor file shipped with NO test at all, so the tests in
 * `tests/semantic.test.mjs` are the first coverage this behaviour has ever had;
 * every expectation there is derived from the donor source lines quoted below.
 *
 * Precedence, exactly the donor's (line 4-8): the `Invalid semantic action` check
 * runs first and covers name membership, `target` type/emptiness/length and unknown
 * keys; then `value`/`expected` type + length; then `enter_text` requires a string
 * value; then `verify_state`/`wait_for_state` require an expected string; then the
 * timeout bounds. The first failing check throws, so an action that fails two checks
 * reports only the first.
 *
 * Preserved donor defects (pinned by tests, not repaired):
 *   (a) `target` is only checked for being a non-empty string of at most 2000
 *       characters — no format, scheme or prefix rule at all.
 *   (b) `computerIntent` cannot reach its own `/^读取 VS Code 状态/` Chinese
 *       alternative with the natural key sequence: the donor wrote a literal ASCII
 *       space in `读取 VS Code 状态`, so "读取 VSCode 状态" or any run without that
 *       exact single space does not match.
 *   (c) `computerIntent`'s leading `app` match calls `.toLowerCase()` inside
 *       `/记事本|notepad/` and `/vs code/` tests, so the vs-code branch is reached
 *       only via a case-insensitive `VS Code` match that the same lowercase step then
 *       satisfies — the two regexes look redundant but the donor's ordering is kept.
 *   (d) `JSON.parse` failures in the `desktop {…}` branch propagate as SyntaxError
 *       out of `computerIntent`; they are not converted into `undefined`.
 *
 * This module is pure: no filesystem, no network, no clock, no randomness, no
 * environment.
 */

import { SEMANTIC_ACTION_NAMES } from "./contracts.mjs";

/**
 * The donor's `SemanticActionName` union is `SEMANTIC_ACTION_NAMES`
 * (`semantic.ts` line 1). The donor repeated the nine strings inline in the
 * `includes(...)` test; the list is identical, and `tests/semantic.test.mjs`
 * asserts the nine values and their order against the donor's line-1 literal.
 *
 * @param {import("./contracts.mjs").SemanticAction} value
 * @returns {void} throws `Error("Invalid semantic action")` and friends
 */
export function validateSemanticAction(value) {
  if (!value || !SEMANTIC_ACTION_NAMES.includes(value.name) || typeof value.target !== "string" || !value.target || value.target.length > 2000 || Object.keys(value).some((key) => !["name", "target", "value", "expected", "timeoutMs"].includes(key))) throw new Error("Invalid semantic action");
  for (const key of ["value", "expected"]) if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 100000)) throw new Error("Invalid semantic value");
  if (value.name === "enter_text" && typeof value.value !== "string") throw new Error("Text value required");
  if (["verify_state", "wait_for_state"].includes(value.name) && typeof (value.expected ?? value.value) !== "string") throw new Error("Expected state required");
  if (value.timeoutMs !== undefined && (!Number.isFinite(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 120000)) throw new Error("Invalid semantic timeout");
}

/**
 * Translates the donor's goal-text command forms into a semantic action, or
 * `undefined` when the goal is not one of them. Order is the donor's, so the
 * `desktop {…}` form is tried last.
 *
 * @param {string} goal
 * @returns {import("./contracts.mjs").SemanticAction|undefined}
 */
export function computerIntent(goal) {
  const text = goal.trim();
  const app = /^(?:打开|open)\s*(记事本|notepad|文件资源管理器|file explorer|VS Code)$/i.exec(text)?.[1].toLowerCase();
  if (app) return { name: "open_app", target: /记事本|notepad/.test(app) ? "notepad" : /vs code/.test(app) ? "vscode" : "explorer" };
  if (/^(?:查看项目目录|read workspace directory)$/i.test(text)) return { name: "read_page", target: "explorer:." };
  if (/^(?:查看 VS Code 状态|read VS Code status)$/i.test(text)) return { name: "read_page", target: "vscode:status" };
  const log = /^(?:读取终端日志|read terminal log)\s+(.+)$/i.exec(text)?.[1];
  if (log) return { name: "read_page", target: "terminal:" + log };
  const browser = /^(?:查看网页状态|read browser state)\s+([a-z0-9_-]+)$/i.exec(text)?.[1];
  if (browser) return { name: "read_page", target: "browser:" + browser };
  if (/^desktop\s+\{/.test(text)) { const action = JSON.parse(text.slice(8)); validateSemanticAction(action); return action; }
  return undefined;
}
