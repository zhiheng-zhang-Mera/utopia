/**
 * FIRST coverage of `src/shared/semantic.ts`.
 *
 * Donor: `src/shared/semantic.ts` @ 8df428eaa437a409368401e95194e40266b83080.
 * The donor file ships with NO test at all — `tests/unit/` has no `semantic.test.ts`,
 * and the donor only exercises this validator indirectly through
 * `electron/computer/semantic-runtime.ts`. Every expectation below is therefore
 * derived from the donor source: the nine-name literal and its order (line 1), the
 * `Invalid semantic action` condition (line 4), the `value`/`expected` length check
 * (line 5), the `enter_text` / `verify_state` requirements (lines 6-7), the timeout
 * bounds (line 8), and the six `computerIntent` branches (lines 10-21).
 *
 * The four preserved defects this file pins are documented in the module header of
 * `../semantic.mjs`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { SEMANTIC_ACTION_NAMES } from "../contracts.mjs";
import { computerIntent, validateSemanticAction } from "../semantic.mjs";

const NINE = ["open_app", "focus_window", "find_control", "click_control", "enter_text", "read_page", "submit", "wait_for_state", "verify_state"];

test("the nine action names are the donor's line-1 union, in order, frozen", () => {
  assert.deepEqual([...SEMANTIC_ACTION_NAMES], NINE);
  assert.equal(SEMANTIC_ACTION_NAMES.length, 9);
  assert.equal(Object.isFrozen(SEMANTIC_ACTION_NAMES), true);
});

/* ---------------------------------------------------------------- accept paths */

test("the six unconditional action names are accepted with just a name and target", () => {
  // The other three (enter_text / verify_state / wait_for_state) reach their own
  // required-field checks; see the two tests below.
  for (const name of ["open_app", "focus_window", "find_control", "click_control", "read_page", "submit"]) {
    assert.doesNotThrow(() => validateSemanticAction({ name, target: "t" }), name);
  }
});

test("every one of the nine action names passes the membership check itself", () => {
  // The donor's line-4 condition tests membership first; give the three conditional
  // names the field their later check needs and all nine are accepted.
  for (const name of NINE) {
    const action = { name, target: "t" };
    if (name === "enter_text") action.value = "x";
    if (name === "verify_state" || name === "wait_for_state") action.expected = "x";
    assert.doesNotThrow(() => validateSemanticAction(action), name);
  }
});

test("a fully-populated action is accepted", () => {
  assert.doesNotThrow(() => validateSemanticAction({ name: "enter_text", target: "dom:{...}", value: "hello", expected: "hello", timeoutMs: 15000 }));
  assert.doesNotThrow(() => validateSemanticAction({ name: "verify_state", target: "dom:{...}", expected: "saved" }));
  assert.doesNotThrow(() => validateSemanticAction({ name: "wait_for_state", target: "dom:{...}", value: "saved" }));
  // The timeout bounds are inclusive at both ends.
  assert.doesNotThrow(() => validateSemanticAction({ name: "read_page", target: "t", timeoutMs: 1 }));
  assert.doesNotThrow(() => validateSemanticAction({ name: "read_page", target: "t", timeoutMs: 120000 }));
  // A 2000-character target is still acceptable (the check is `> 2000`).
  assert.doesNotThrow(() => validateSemanticAction({ name: "read_page", target: "x".repeat(2000) }));
  // 100000-character value/expected are still acceptable.
  assert.doesNotThrow(() => validateSemanticAction({ name: "enter_text", target: "t", value: "x".repeat(100000) }));
});

/* ---------------------------------------------------------------- refuse paths */

test("Invalid semantic action: a missing value, an unknown name, a bad or missing target, unknown keys", () => {
  for (const value of [undefined, null, 0, "", "nope", [], [1]]) {
    assert.throws(() => validateSemanticAction(value), { message: "Invalid semantic action" }, String(value));
  }
  assert.throws(() => validateSemanticAction({ name: "click", target: "t" }), { message: "Invalid semantic action" });
  assert.throws(() => validateSemanticAction({ name: "Click_Control", target: "t" }), { message: "Invalid semantic action" });
  assert.throws(() => validateSemanticAction({ name: "click_control" }), { message: "Invalid semantic action" }, "no target");
  assert.throws(() => validateSemanticAction({ name: "click_control", target: "" }), { message: "Invalid semantic action" }, "empty target");
  assert.throws(() => validateSemanticAction({ name: "click_control", target: 42 }), { message: "Invalid semantic action" }, "non-string target");
  assert.throws(() => validateSemanticAction({ name: "click_control", target: null }), { message: "Invalid semantic action" });
  // `target` has no format rule at all — only length. 2001 characters is the limit.
  assert.throws(() => validateSemanticAction({ name: "read_page", target: "x".repeat(2001) }), { message: "Invalid semantic action" });
  // Unknown keys are refused, in any position.
  assert.throws(() => validateSemanticAction({ name: "read_page", target: "t", extra: 1 }), { message: "Invalid semantic action" });
  assert.throws(() => validateSemanticAction({ extra: 1, name: "read_page", target: "t" }), { message: "Invalid semantic action" });
  assert.throws(() => validateSemanticAction({ name: "read_page", target: "t", name2: "x" }), { message: "Invalid semantic action" });
});

test("Invalid semantic value: value/expected must be strings of at most 100000 characters", () => {
  assert.throws(() => validateSemanticAction({ name: "read_page", target: "t", value: 5 }), { message: "Invalid semantic value" });
  assert.throws(() => validateSemanticAction({ name: "read_page", target: "t", value: null }), { message: "Invalid semantic value" });
  assert.throws(() => validateSemanticAction({ name: "read_page", target: "t", expected: {} }), { message: "Invalid semantic value" });
  assert.throws(() => validateSemanticAction({ name: "read_page", target: "t", value: "x".repeat(100001) }), { message: "Invalid semantic value" });
  assert.throws(() => validateSemanticAction({ name: "read_page", target: "t", expected: "x".repeat(100001) }), { message: "Invalid semantic value" });
  // `undefined` is the only accepted absence.
  assert.doesNotThrow(() => validateSemanticAction({ name: "read_page", target: "t", value: undefined, expected: undefined }));
});

test("Text value required: enter_text needs a string value", () => {
  assert.throws(() => validateSemanticAction({ name: "enter_text", target: "t" }), { message: "Text value required" });
  assert.throws(() => validateSemanticAction({ name: "enter_text", target: "t", value: 7 }), { message: "Invalid semantic value" }, "a non-string value fails the earlier check");
  assert.throws(() => validateSemanticAction({ name: "enter_text", target: "t", value: undefined }), { message: "Text value required" });
  assert.doesNotThrow(() => validateSemanticAction({ name: "enter_text", target: "t", value: "" }), "an empty string IS a string value");
});

test("Expected state required: verify_state and wait_for_state need expected or value", () => {
  for (const name of ["verify_state", "wait_for_state"]) {
    assert.throws(() => validateSemanticAction({ name, target: "t" }), { message: "Expected state required" }, name);
    assert.throws(() => validateSemanticAction({ name, target: "t", expected: undefined, value: undefined }), { message: "Expected state required" }, name);
    assert.doesNotThrow(() => validateSemanticAction({ name, target: "t", expected: "saved" }), name);
    assert.doesNotThrow(() => validateSemanticAction({ name, target: "t", value: "saved" }), `${name} falls back to value`);
  }
  // A non-string expected is caught by the earlier check, not this one.
  assert.throws(() => validateSemanticAction({ name: "verify_state", target: "t", expected: 3 }), { message: "Invalid semantic value" });
});

test("Invalid semantic timeout: only finite numbers in [1, 120000]", () => {
  for (const timeoutMs of [0, -1, 120001, Number.NaN, Number.POSITIVE_INFINITY, "5000", null]) {
    assert.throws(() => validateSemanticAction({ name: "read_page", target: "t", timeoutMs }), { message: "Invalid semantic timeout" }, String(timeoutMs));
  }
  assert.doesNotThrow(() => validateSemanticAction({ name: "read_page", target: "t", timeoutMs: undefined }));
});

test("precedence: the first failing check is the one reported", () => {
  // Unknown name AND a bad timeout → the action check wins.
  assert.throws(() => validateSemanticAction({ name: "nope", target: "t", timeoutMs: 0 }), { message: "Invalid semantic action" });
  // Unknown key AND a bad value → the action check wins.
  assert.throws(() => validateSemanticAction({ name: "read_page", target: "t", value: 1, extra: 2 }), { message: "Invalid semantic action" });
  // enter_text with no value AND a bad timeout → the text check wins.
  assert.throws(() => validateSemanticAction({ name: "enter_text", target: "t", timeoutMs: 0 }), { message: "Text value required" });
});

/* ---------------------------------------------------------------- computerIntent */

test("computerIntent opens the three apps it names, in both languages", () => {
  assert.deepEqual(computerIntent("打开记事本"), { name: "open_app", target: "notepad" });
  assert.deepEqual(computerIntent("open notepad"), { name: "open_app", target: "notepad" });
  assert.deepEqual(computerIntent("OPEN NOTEPAD"), { name: "open_app", target: "notepad" });
  assert.deepEqual(computerIntent("打开文件资源管理器"), { name: "open_app", target: "explorer" });
  assert.deepEqual(computerIntent("open file explorer"), { name: "open_app", target: "explorer" });
  assert.deepEqual(computerIntent("打开VS Code"), { name: "open_app", target: "vscode" });
  assert.deepEqual(computerIntent("open VS Code"), { name: "open_app", target: "vscode" });
  // Optional whitespace between the verb and the app name.
  assert.deepEqual(computerIntent("  open   notepad  "), { name: "open_app", target: "notepad" });
});

test("computerIntent reads the four fixed read commands", () => {
  assert.deepEqual(computerIntent("查看项目目录"), { name: "read_page", target: "explorer:." });
  assert.deepEqual(computerIntent("read workspace directory"), { name: "read_page", target: "explorer:." });
  assert.deepEqual(computerIntent("查看 VS Code 状态"), { name: "read_page", target: "vscode:status" });
  assert.deepEqual(computerIntent("read VS Code status"), { name: "read_page", target: "vscode:status" });
});

test("computerIntent parameterises the terminal-log and browser-state forms", () => {
  assert.deepEqual(computerIntent("读取终端日志 build-42"), { name: "read_page", target: "terminal:build-42" });
  assert.deepEqual(computerIntent("read terminal log build-42"), { name: "read_page", target: "terminal:build-42" });
  assert.deepEqual(computerIntent("查看网页状态 chatgpt"), { name: "read_page", target: "browser:chatgpt" });
  assert.deepEqual(computerIntent("read browser state chatgpt"), { name: "read_page", target: "browser:chatgpt" });
  // The browser id class is [a-z0-9_-]+ but the pattern is /i, so the capture keeps
  // the caller's case after the case-insensitive match on the literal part.
  assert.deepEqual(computerIntent("read browser state Chat_GPT-2"), { name: "read_page", target: "browser:Chat_GPT-2" });
  // A space is required before the log/browser argument.
  assert.equal(computerIntent("read terminal logbuild-42"), undefined);
  // The browser id cannot contain a dot or a space.
  assert.equal(computerIntent("查看网页状态 chat.gpt"), undefined);
  assert.deepEqual(computerIntent("读取终端日志 with spaces allowed"), { name: "read_page", target: "terminal:with spaces allowed" });
});

test("computerIntent parses the desktop {…} JSON form and validates it", () => {
  assert.deepEqual(computerIntent('desktop {"name":"read_page","target":"explorer:."}'), { name: "read_page", target: "explorer:." });
  assert.deepEqual(computerIntent('desktop  {"name":"click_control","target":"uia:x","timeoutMs":500}'), { name: "click_control", target: "uia:x", timeoutMs: 500 });
  // The JSON body is validated by validateSemanticAction, so a bad one throws.
  assert.throws(() => computerIntent('desktop {"name":"nope","target":"x"}'), { message: "Invalid semantic action" });
  assert.throws(() => computerIntent('desktop {"name":"enter_text","target":"x"}'), { message: "Text value required" });
});

test("DEFECT PINNED: a malformed desktop {…} body throws SyntaxError, it is not turned into undefined", () => {
  assert.throws(() => computerIntent("desktop {not json}"), SyntaxError);
  assert.throws(() => computerIntent("desktop {"), SyntaxError);
  // The lowercase-key check on the remaining JSON body: outer whitespace is
  // trimmed before the prefix test, but the body starts at the fixed offset 8.
  assert.throws(() => computerIntent("desktop {  }"), Error);
});

test("computerIntent returns undefined for anything it does not recognise", () => {
  for (const goal of [
    "",
    "   ",
    "notepad",
    "open chrome",
    "打开浏览器",
    "read the page",
    "read workspace directory now",
    "Desktop {\"name\":\"read_page\",\"target\":\"x\"}",
    "desktop{\"name\":\"read_page\",\"target\":\"x\"}",
    "查看项目目录 extra",
    "read VS Code status now"
  ]) {
    assert.equal(computerIntent(goal), undefined, JSON.stringify(goal));
  }
});

test("DEFECT PINNED: the Chinese VS Code status form needs the donor's exact ASCII space", () => {
  // The donor wrote `查看 VS Code 状态` with a literal ASCII space, and the whole
  // alternative is one literal, so variants with no space or a full-width space are
  // not recognised. Preserved, not loosened.
  assert.deepEqual(computerIntent("查看 VS Code 状态"), { name: "read_page", target: "vscode:status" });
  assert.equal(computerIntent("查看VS Code 状态"), undefined);
  assert.equal(computerIntent("查看\u3000VS Code 状态"), undefined);
  assert.equal(computerIntent("read VSCode status"), undefined);
  assert.equal(computerIntent("read VS Code 状态"), undefined, "the two literals are not mixed");
});
