/**
 * First coverage of some donor behaviour, and an exact-behaviour pin for the rest.
 *
 * Donor: `src/shared/computer-recovery.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. That file HAS a donor test
 * (`tests/unit/computer-recovery.test.ts`), and every expectation there is
 * reproduced here by value. This file additionally derives, from the donor source
 * itself, the cases the donor test never reached: every RepairVerdict, the ICON /
 * POINT geometry guards at their boundaries, both grant-denial reasons, the retry
 * arithmetic of the ladder, and the two preserved defects (`verdictForOutcome`'s
 * unreachable ACTED, `buildRepairPlan`'s unreachable read_page denial).
 *
 * Nothing here is asserted against the port; every expectation is the donor's
 * literal output, computed from the donor file's own text.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPUTER_MUTATION_ACTIONS,
  COMPUTER_READ_ACTIONS,
  buildRepairPlan,
  classifyRepairNeed,
  geometryTargetValid,
  grantedComputerActions,
  planSummary,
  tierForTarget,
  verdictForOutcome
} from "../computer-recovery.mjs";

const GRANTS_SEND = new Set(["read_page", "click_control", "verify_state"]);
const GRANTS_INPUT = new Set(["read_page", "enter_text", "verify_state"]);
const GRANTS_INPUT_SUBMIT = new Set(["read_page", "enter_text", "submit", "verify_state"]);

test("the read and mutation action lists are the donor's literals, in order, frozen", () => {
  assert.deepEqual([...COMPUTER_READ_ACTIONS], ["read_page", "find_control", "verify_state"]);
  assert.deepEqual([...COMPUTER_MUTATION_ACTIONS], ["click_control", "enter_text", "submit"]);
  assert.equal(Object.isFrozen(COMPUTER_READ_ACTIONS), true);
  assert.equal(Object.isFrozen(COMPUTER_MUTATION_ACTIONS), true);
});

/* ---------------------------------------------------------------- §26 verdicts */

test("§26 every CU_REPAIR need is classified from the donor's phrase sets", () => {
  // SEND_AFFORDANCE_MISSING — reason regex (donor line 90) and probe fact.
  for (const reason of ["send-button-not-found", "enter-did-not-submit", "找不到发送", "发送按钮", "提交未生效"]) {
    assert.deepEqual(classifyRepairNeed({ reason }), { verdict: "CU_REPAIR", need: "SEND_AFFORDANCE_MISSING" }, reason);
  }
  assert.deepEqual(classifyRepairNeed({ reason: "anything", probe: { sendFound: false } }), { verdict: "CU_REPAIR", need: "SEND_AFFORDANCE_MISSING" });

  // INPUT_AFFORDANCE_MISSING — reason regex (donor line 93) and probe fact.
  for (const reason of ["input-not-found", "input not found", "找不到输入"]) {
    assert.deepEqual(classifyRepairNeed({ reason }), { verdict: "CU_REPAIR", need: "INPUT_AFFORDANCE_MISSING" }, reason);
  }
  assert.deepEqual(classifyRepairNeed({ reason: "anything", probe: { inputFound: false } }), { verdict: "CU_REPAIR", need: "INPUT_AFFORDANCE_MISSING" });

  // RESPONSE_SELECTOR_DRIFT — reason regex (donor line 96), including the phrase
  // that is also in CU_REPAIR_PHRASES, which must reach the drift branch first.
  for (const reason of ["response selector", "selector drift", "response-selector-drift"]) {
    assert.deepEqual(classifyRepairNeed({ reason }), { verdict: "CU_REPAIR", need: "RESPONSE_SELECTOR_DRIFT" }, reason);
  }

  // PAGE_STRUCTURE_CHANGED — the CU_REPAIR_PHRASES fallthrough (donor line 99).
  for (const reason of ["send button not found", "enter did not submit", "未找到发送", "发送失败"]) {
    assert.deepEqual(classifyRepairNeed({ reason }), { verdict: "CU_REPAIR", need: "PAGE_STRUCTURE_CHANGED" }, reason);
  }
});

test("§26 every HUMAN_REQUIRED phrase gates the page away from CU repair", () => {
  // Donor HUMAN_PHRASES, line 75-77, all eleven.
  const phrases = ["login", "log in", "sign in", "captcha", "verification code", "验证码", "登录", "登陆", "credential", "凭据", "权限"];
  for (const phrase of phrases) {
    assert.deepEqual(classifyRepairNeed({ reason: `page says ${phrase} now` }), { verdict: "HUMAN_REQUIRED" }, phrase);
  }
  // probe.loginLikely short-circuits even with an empty reason.
  assert.deepEqual(classifyRepairNeed({ reason: "", probe: { loginLikely: true } }), { verdict: "HUMAN_REQUIRED" });
  // The human gate wins over a send-failure probe fact (precedence, donor line 87).
  assert.deepEqual(classifyRepairNeed({ reason: "send-button-not-found", probe: { loginLikely: true, sendFound: false } }), { verdict: "HUMAN_REQUIRED" });
});

test("§26 NOT_REPAIRABLE is the fallthrough: unknown failures are never guessed into a mutation", () => {
  assert.deepEqual(classifyRepairNeed({ reason: "runtime crashed unexpectedly" }), { verdict: "NOT_REPAIRABLE" });
  assert.deepEqual(classifyRepairNeed({ reason: "" }), { verdict: "NOT_REPAIRABLE" });
  // A present-but-true probe fact adds nothing.
  assert.deepEqual(classifyRepairNeed({ reason: "no idea", probe: { sendFound: true, inputFound: true, responseVisible: true } }), { verdict: "NOT_REPAIRABLE" });
});

test("§26 classification lowercases the reason with toLocaleLowerCase, as the donor does", () => {
  assert.deepEqual(classifyRepairNeed({ reason: "SEND-BUTTON-NOT-FOUND" }), { verdict: "CU_REPAIR", need: "SEND_AFFORDANCE_MISSING" });
  assert.deepEqual(classifyRepairNeed({ reason: "INPUT NOT FOUND" }), { verdict: "CU_REPAIR", need: "INPUT_AFFORDANCE_MISSING" });
  assert.deepEqual(classifyRepairNeed({ reason: "RESPONSE SELECTOR DRIFT" }), { verdict: "CU_REPAIR", need: "RESPONSE_SELECTOR_DRIFT" });
  assert.deepEqual(classifyRepairNeed({ reason: "Please LOG IN" }), { verdict: "HUMAN_REQUIRED" });
  // `String(input.reason ?? "")` — a missing reason reads as the empty string.
  assert.deepEqual(classifyRepairNeed({}), { verdict: "NOT_REPAIRABLE" });
});

/* ---------------------------------------------------------------- §24 tiers */

test("§24 tierForTarget maps every kind to the donor's tier, unknown kinds to 6", () => {
  assert.equal(tierForTarget("TEXT"), 0);
  assert.equal(tierForTarget("ROLE"), 1);
  assert.equal(tierForTarget("ACCESSIBILITY"), 2);
  assert.equal(tierForTarget("REGION"), 3);
  assert.equal(tierForTarget("ICON"), 4);
  assert.equal(tierForTarget("POINT"), 5);
  assert.equal(tierForTarget("NOPE"), 6);
  assert.equal(tierForTarget(undefined), 6);
  // The ordering the donor's comment claims ("cost rises down the ladder").
  const ladder = ["TEXT", "ROLE", "ACCESSIBILITY", "REGION", "ICON", "POINT"].map(tierForTarget);
  assert.deepEqual(ladder, [0, 1, 2, 3, 4, 5]);
});

/* ---------------------------------------------------------------- §28 geometry guards */

test("§28 geometryTargetValid only guards ICON and POINT, and needs truthy finite frameRevisionAt + boundedRegion", () => {
  // Non-geometry kinds are always valid, whatever else is missing.
  for (const kind of ["TEXT", "ROLE", "ACCESSIBILITY", "REGION"]) {
    assert.equal(geometryTargetValid({ kind }), true, kind);
    assert.equal(geometryTargetValid({ kind, frameRevisionAt: 0 }), true, kind);
  }
  // ICON/POINT without both facts are invalid.
  assert.equal(geometryTargetValid({ kind: "ICON", hint: "send" }), false);
  assert.equal(geometryTargetValid({ kind: "POINT" }), false);
  assert.equal(geometryTargetValid({ kind: "ICON", frameRevisionAt: 10 }), false);
  assert.equal(geometryTargetValid({ kind: "POINT", boundedRegion: { x: 0, y: 0, width: 0, height: 0 } }), false);
  // Valid when both are present — the donor's test's own vector.
  assert.equal(geometryTargetValid({ kind: "ICON", hint: "send", frameRevisionAt: 10, boundedRegion: { x: 1, y: 2, width: 3, height: 4 } }), true);
  // Boundary: frameRevisionAt === 0 is FALSY, so it is not a usable revision even
  // though Number.isFinite(0) is true. This is what makes now === 0 UNCERTAIN.
  assert.equal(Number.isFinite(0), true);
  assert.equal(geometryTargetValid({ kind: "POINT", frameRevisionAt: 0, boundedRegion: { x: 0, y: 0, width: 0, height: 0 } }), false);
  // Non-finite revisions are rejected even though they are truthy.
  assert.equal(geometryTargetValid({ kind: "ICON", frameRevisionAt: Number.NaN, boundedRegion: { x: 0, y: 0, width: 0, height: 0 } }), false);
  assert.equal(geometryTargetValid({ kind: "ICON", frameRevisionAt: Number.POSITIVE_INFINITY, boundedRegion: { x: 0, y: 0, width: 0, height: 0 } }), false);
  assert.equal(geometryTargetValid({ kind: "ICON", frameRevisionAt: -1, boundedRegion: { x: 0, y: 0, width: 0, height: 0 } }), true);
});

/* ---------------------------------------------------------------- plan building */

test("§26 READY: a SEND plan is read_page → click_control → verify_state with a revisioned ICON affordance", () => {
  const plan = buildRepairPlan("SEND_AFFORDANCE_MISSING", 1000, GRANTS_SEND);
  assert.equal(plan.verdict, "READY");
  assert.equal(plan.need, "SEND_AFFORDANCE_MISSING");
  assert.equal(plan.reason, undefined);
  assert.deepEqual(plan.steps.map((s) => s.action), ["read_page", "click_control", "verify_state"]);
  assert.deepEqual(plan.steps.map((s) => s.target.kind), ["ROLE", "ICON", "ROLE"]);
  assert.deepEqual(plan.steps[1].target, { kind: "ICON", hint: "send", frameRevisionAt: 1000, boundedRegion: { x: 0, y: 0, width: 0, height: 0 } });
  // Post-conditions and rationales are the donor's strings.
  assert.equal(plan.steps[0].postCondition.description, "page read succeeded and DOM shape is observable");
  assert.equal(plan.steps[0].rationale, "§26 DOM inspect + read page");
  assert.equal(plan.steps[1].postCondition.description, "affordance acted on and page observable state changed or submission started");
  assert.equal(plan.steps[1].rationale, "§26 locate + act on the composer/send affordance");
  assert.equal(plan.steps[2].postCondition.description, "user message or fresh generation observed — submission verified");
  assert.equal(plan.steps[2].rationale, "§26 verify submission (post-condition)");
  assert.equal(plan.steps[0].target.hint, "document/body");
});

test("§26 READY: an INPUT plan inserts submit when the submit grant is present", () => {
  const plan = buildRepairPlan("INPUT_AFFORDANCE_MISSING", 1000, GRANTS_INPUT_SUBMIT);
  assert.equal(plan.verdict, "READY");
  assert.deepEqual(plan.steps.map((s) => s.action), ["read_page", "enter_text", "submit", "verify_state"]);
  assert.deepEqual(plan.steps[1].target, { kind: "TEXT", hint: "composer/textarea/contenteditable" });
  assert.deepEqual(plan.steps[2].target, { kind: "ROLE", hint: "form/composer" });
  assert.equal(plan.steps[2].postCondition.description, "user message is visible in the conversation or generation started");
});

test("§26 the INPUT chain is still READY without the submit grant (3 steps is the donor's floor)", () => {
  const plan = buildRepairPlan("INPUT_AFFORDANCE_MISSING", 1000, GRANTS_INPUT);
  assert.equal(plan.verdict, "READY");
  assert.deepEqual(plan.steps.map((s) => s.action), ["read_page", "enter_text", "verify_state"]);
});

test("§26 DRIFT and STRUCTURE plans are ROLE-targeted and never geometry", () => {
  for (const need of ["RESPONSE_SELECTOR_DRIFT", "PAGE_STRUCTURE_CHANGED"]) {
    const plan = buildRepairPlan(need, 1000, GRANTS_SEND);
    assert.equal(plan.verdict, "READY", need);
    assert.equal(plan.need, need);
    assert.deepEqual(plan.steps.map((s) => s.action), ["read_page", "click_control", "verify_state"], need);
    assert.deepEqual(plan.steps.map((s) => s.target.kind), ["ROLE", "ROLE", "ROLE"], need);
    assert.equal(plan.steps[1].target.hint, "conversation/output region");
  }
});

test("§26 DENIED when the required mutation grant is missing, naming the action (fail closed)", () => {
  const send = buildRepairPlan("SEND_AFFORDANCE_MISSING", 1000, new Set());
  assert.equal(send.verdict, "DENIED");
  assert.equal(send.reason, "computer:click_control not granted for this task/workspace");
  assert.deepEqual(send.steps.map((s) => s.action), ["read_page"], "the read step is planned before the denial");

  const input = buildRepairPlan("INPUT_AFFORDANCE_MISSING", 1000, new Set(["read_page", "verify_state"]));
  assert.equal(input.verdict, "DENIED");
  assert.equal(input.reason, "computer:enter_text not granted for this task/workspace");
});

test("§28 UNCERTAIN when the ICON affordance has no usable frame revision (the now === 0 default)", () => {
  const plan = buildRepairPlan("SEND_AFFORDANCE_MISSING", 0, GRANTS_SEND);
  assert.equal(plan.verdict, "UNCERTAIN");
  assert.equal(plan.reason, "ICON/POINT target lacks frame revision + bounded region (§28) — cannot act blindly");
  // The geometry guard runs BEFORE the mutation grant check, so a revision-less
  // SEND plan is UNCERTAIN even with no grants at all — never DENIED.
  assert.equal(buildRepairPlan("SEND_AFFORDANCE_MISSING").verdict, "UNCERTAIN");
});

test("DEFECT PINNED: the read_page denial branch of buildRepairPlan is unreachable", () => {
  // `allowed()` returns true for every COMPUTER_READ_ACTIONS member before it looks
  // at `grants`, so `!allowed("read_page")` can never be true and the donor's
  // "computer:read_page not granted" reason can never be produced. The branch is
  // preserved verbatim rather than repaired.
  for (const grants of [new Set(), new Set(["submit"]), new Set(["read_page"])]) {
    const plan = buildRepairPlan("RESPONSE_SELECTOR_DRIFT", 1000, grants);
    assert.notEqual(plan.reason, "computer:read_page not granted for this task/workspace");
    assert.equal(plan.steps[0].action, "read_page", "read_page is always planned");
  }
  // The reachable DENIED reason is always the mutation one.
  assert.equal(buildRepairPlan("RESPONSE_SELECTOR_DRIFT", 1000, new Set()).reason, "computer:click_control not granted for this task/workspace");
});

test("§29 grantedComputerActions maps only exact computer:<action> entries, trimming surrounding space", () => {
  const grants = grantedComputerActions(["computer:read_page", "computer:click_control", "computer:submit", "filesystem:repo"]);
  assert.deepEqual([...grants].sort(), ["click_control", "read_page", "submit"]);
  assert.equal(grants.has("enter_text"), false);
  assert.equal(grants.has("verify_state"), false);

  // All six known actions are recognised.
  assert.deepEqual(
    [...grantedComputerActions(["computer:read_page", "computer:find_control", "computer:click_control", "computer:enter_text", "computer:submit", "computer:verify_state"])].sort(),
    ["click_control", "enter_text", "find_control", "read_page", "submit", "verify_state"]
  );
  // Near misses are NOT grants: the regex is anchored and requires the exact token.
  const near = grantedComputerActions([" computer:submit ", "computer:submit ", "computer:Submit", "computer:submit2", "computer:", "computer:read_page/extra", "xcomputer:submit"]);
  assert.deepEqual([...near], ["submit"], "only the whitespace-trimmed exact entry survives");
  // Duplicates collapse into the Set.
  assert.equal(grantedComputerActions(["computer:submit", "computer:submit"]).size, 1);
});

test("§29 a granted read action alone never unlocks a mutation", () => {
  const plan = buildRepairPlan("RESPONSE_SELECTOR_DRIFT", 1000, grantedComputerActions(["computer:read_page", "computer:verify_state"]));
  assert.equal(plan.verdict, "DENIED");
  const unlocked = buildRepairPlan("RESPONSE_SELECTOR_DRIFT", 1000, grantedComputerActions(["computer:click_control"]));
  assert.equal(unlocked.verdict, "READY");
});

/* ---------------------------------------------------------------- §25 outcome discipline */

test("§25 verdictForOutcome is VERIFIED only when the post-condition was observed", () => {
  const step = { action: "click_control", target: { kind: "ICON" }, postCondition: { description: "x" }, rationale: "r" };
  assert.equal(verdictForOutcome(step, { postConditionSeen: true }), "VERIFIED");
  assert.equal(verdictForOutcome(step, { acted: true, postConditionSeen: false }), "UNCERTAIN");
  assert.equal(verdictForOutcome(step, { acted: false }), "UNCERTAIN");
  assert.equal(verdictForOutcome(step, {}), "UNCERTAIN");
});

test("DEFECT PINNED: verdictForOutcome can never return its exported ACTED status", () => {
  // Both non-VERIFIED paths answer "UNCERTAIN", so the documented "ACTED" value is
  // unreachable: `observed.acted` is read and discarded. Preserved, not repaired.
  const step = { action: "click_control", target: { kind: "ICON" }, postCondition: { description: "x" }, rationale: "r" };
  const seen = new Set();
  for (const observed of [{}, { acted: true }, { acted: false }, { postConditionSeen: false }, { acted: true, postConditionSeen: true }]) {
    seen.add(verdictForOutcome(step, observed));
  }
  assert.deepEqual([...seen].sort(), ["UNCERTAIN", "VERIFIED"]);
  assert.equal(seen.has("ACTED"), false);
});

/* ---------------------------------------------------------------- §38 summary */

test("§38 planSummary reports steps, actions and only a present reason, in the donor's key order", () => {
  const ready = buildRepairPlan("SEND_AFFORDANCE_MISSING", 1000, GRANTS_SEND);
  const summary = planSummary(ready);
  assert.deepEqual(Object.keys(summary), ["need", "verdict", "steps", "actions"]);
  assert.equal(summary.need, "SEND_AFFORDANCE_MISSING");
  assert.equal(summary.verdict, "READY");
  assert.equal(summary.steps, 3);
  assert.deepEqual(summary.actions, ["read_page", "click_control", "verify_state"]);
  assert.deepEqual(summary, { need: "SEND_AFFORDANCE_MISSING", verdict: "READY", steps: 3, actions: ["read_page", "click_control", "verify_state"] });

  const denied = planSummary(buildRepairPlan("SEND_AFFORDANCE_MISSING", 1000, new Set()));
  assert.deepEqual(Object.keys(denied), ["need", "verdict", "steps", "actions", "reason"]);
  assert.equal(denied.verdict, "DENIED");
  assert.equal(denied.steps, 1);
  assert.deepEqual(denied.actions, ["read_page"]);
  assert.equal(denied.reason, "computer:click_control not granted for this task/workspace");

  // A falsy reason is omitted, not written as undefined (the donor spreads it).
  assert.equal("reason" in planSummary({ need: "PAGE_STRUCTURE_CHANGED", verdict: "EMPTY", steps: [], reason: "" }), false);
  assert.deepEqual(planSummary({ need: "PAGE_STRUCTURE_CHANGED", verdict: "EMPTY", steps: [] }), {
    need: "PAGE_STRUCTURE_CHANGED",
    verdict: "EMPTY",
    steps: 0,
    actions: []
  });
});
