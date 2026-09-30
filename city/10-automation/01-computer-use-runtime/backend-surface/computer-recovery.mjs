/**
 * UTOPIA · 10-automation / Computer Use Runtime — computer-recovery.
 *
 * Donor: `src/shared/computer-recovery.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. Pure and unchanged in behaviour.
 *
 * Computer-Use provider recovery planner (Owner-Result.md Rev.2 §24–§29, §41).
 * Decides WHAT to repair on a provider page and in WHAT order, and whether the
 * repair is permitted — execution stays in Electron.
 *
 * §26: page failures (send-button-not-found / input-not-found /
 * enter-did-not-submit / response-selector-drift) must not immediately pause for
 * a human; they trigger a bounded Computer-Use chain: DOM inspect → read page →
 * locate composer/send affordance → native interaction → verify submission. §24
 * tiers T0–T6 rank the affordance strategies; §28 adds ICON / POINT targets that
 * REQUIRE a frame-revision check + bounded region + post-condition (never bare,
 * long-lived coordinates); §29 gates every mutation behind a task-scoped
 * `computer:<action>` grant; §25 forbids repeating a mutation when the
 * post-condition is UNCERTAIN.
 *
 * Every string, ordering, threshold and precedence rule below is the donor's,
 * including the two defects this port preserves on purpose:
 *   (a) `verdictForOutcome` returns "UNCERTAIN" on every reachable path, so its
 *       exported "ACTED" status is unreachable;
 *   (b) `buildRepairPlan`'s "read_page not granted" branch is unreachable,
 *       because `allowed()` puts COMPUTER_READ_ACTIONS first (see the comment at
 *       that branch).
 * Both are pinned by `tests/computer-recovery.test.mjs` rather than repaired.
 *
 * `now` is a parameter defaulting to `0`, exactly as in the donor, so this module
 * is deterministic. No filesystem, network, clock or randomness.
 */

/**
 * The `ComputerActionName` union, donor order.
 * @typedef {"read_page"|"find_control"|"click_control"|"enter_text"|"submit"|"verify_state"} ComputerActionName
 */

/** @type {readonly ComputerActionName[]} donor line 19 */
export const COMPUTER_READ_ACTIONS = Object.freeze(["read_page", "find_control", "verify_state"]);

/** @type {readonly ComputerActionName[]} donor line 20 */
export const COMPUTER_MUTATION_ACTIONS = Object.freeze(["click_control", "enter_text", "submit"]);

/**
 * §26 failure phrases that are CU-repairable. Private in the donor (line 70), so
 * private here: it is read only by the `PAGE_STRUCTURE_CHANGED` fallthrough.
 * @type {readonly string[]}
 */
const CU_REPAIR_PHRASES = Object.freeze([
  "send-button-not-found", "send button not found", "input-not-found", "input not found",
  "enter-did-not-submit", "enter did not submit", "response selector", "selector drift",
  "找不到发送", "找不到输入", "发送按钮", "未找到发送", "发送失败", "提交未生效"
]);

/** Private in the donor (line 75). @type {readonly string[]} */
const HUMAN_PHRASES = Object.freeze([
  "login", "log in", "sign in", "captcha", "verification code", "验证码", "登录", "登陆", "credential", "凭据", "权限"
]);

/**
 * §26 classification: which page failures the Computer-Use chain may repair.
 * Human-gated pages (login/CAPTCHA) are never CU-repaired; unknown structural
 * failures are NOT_REPAIRABLE (recorded, never guessed into a mutation).
 *
 * @param {{outcome?: string|null, reason: string, probe?: {loginLikely?: boolean, sendFound?: boolean, inputFound?: boolean, responseVisible?: boolean}}} input
 * @returns {{verdict: "CU_REPAIR"|"HUMAN_REQUIRED"|"NOT_REPAIRABLE", need?: "SEND_AFFORDANCE_MISSING"|"INPUT_AFFORDANCE_MISSING"|"RESPONSE_SELECTOR_DRIFT"|"PAGE_STRUCTURE_CHANGED"}}
 */
export function classifyRepairNeed(input) {
  const text = String(input.reason ?? "").toLocaleLowerCase();
  const probe = input.probe ?? {};
  if (probe.loginLikely || HUMAN_PHRASES.some((phrase) => text.includes(phrase))) {
    return { verdict: "HUMAN_REQUIRED" };
  }
  if (probe.sendFound === false || /send-button-not-found|enter-did-not-submit|找不到发送|发送按钮|提交未生效/.test(text)) {
    return { verdict: "CU_REPAIR", need: "SEND_AFFORDANCE_MISSING" };
  }
  if (probe.inputFound === false || /input-not-found|input not found|找不到输入/.test(text)) {
    return { verdict: "CU_REPAIR", need: "INPUT_AFFORDANCE_MISSING" };
  }
  if (/response selector|selector drift|response-selector-drift/.test(text)) {
    return { verdict: "CU_REPAIR", need: "RESPONSE_SELECTOR_DRIFT" };
  }
  if (CU_REPAIR_PHRASES.some((phrase) => text.includes(phrase))) {
    return { verdict: "CU_REPAIR", need: "PAGE_STRUCTURE_CHANGED" };
  }
  return { verdict: "NOT_REPAIRABLE" };
}

/**
 * §24 tier label for a target kind (cost rises down the ladder). An unknown kind
 * falls to the donor's `default`, tier 6.
 *
 * @param {"TEXT"|"ROLE"|"ACCESSIBILITY"|"ICON"|"REGION"|"POINT"} kind
 * @returns {0|1|2|3|4|5|6}
 */
export function tierForTarget(kind) {
  switch (kind) {
    case "TEXT": return 0;
    case "ROLE": return 1;
    case "ACCESSIBILITY": return 2;
    case "REGION": return 3;
    case "ICON": return 4;
    case "POINT": return 5;
    default: return 6;
  }
}

/**
 * §28 guard: risky geometry targets require frame revision + bounded region.
 * `frameRevisionAt` must be truthy AND finite, so `0` — the donor's own `now`
 * default — is NOT a usable revision and makes a SEND plan UNCERTAIN.
 *
 * @param {{kind: string, frameRevisionAt?: number, boundedRegion?: object}} target
 * @returns {boolean}
 */
export function geometryTargetValid(target) {
  if (target.kind !== "ICON" && target.kind !== "POINT") return true;
  return Boolean(target.frameRevisionAt && Number.isFinite(target.frameRevisionAt) && target.boundedRegion);
}

/** Private in the donor (line 141). */
function step(action, target, postCondition, rationale) {
  return { action, target, postCondition: { description: postCondition }, rationale };
}

/**
 * Builds the §26 repair chain for a need. T0/T1/T2 semantic targets first;
 * geometry-based ICON/POINT steps only survive when they carry a frame revision +
 * bounded region (§28). A plan that cannot reach a verifiable submission step is
 * UNCERTAIN — never executed blindly.
 *
 * @param {"SEND_AFFORDANCE_MISSING"|"INPUT_AFFORDANCE_MISSING"|"RESPONSE_SELECTOR_DRIFT"|"PAGE_STRUCTURE_CHANGED"} need
 * @param {number} [now] the donor's `now`, defaulting to 0
 * @param {ReadonlySet<ComputerActionName>} [grants]
 * @returns {import("./contracts.mjs").RepairPlan}
 */
export function buildRepairPlan(need, now = 0, grants = new Set()) {
  const allowed = (action) => COMPUTER_READ_ACTIONS.includes(action) || grants.has(action);
  const plan = { need, verdict: "READY", steps: [] };

  // Donor defect, preserved: `allowed()` returns true for every
  // COMPUTER_READ_ACTIONS member before it ever consults `grants`, so this branch
  // is unreachable and "computer:read_page not granted" can never be the reason a
  // plan is DENIED. Pinned by a test; not repaired.
  if (!allowed("read_page")) {
    return { ...plan, verdict: "DENIED", reason: "computer:read_page not granted for this task/workspace" };
  }
  plan.steps.push(step("read_page", { kind: "ROLE", hint: "document/body" }, "page read succeeded and DOM shape is observable", "§26 DOM inspect + read page"));

  const clickOrText = need === "INPUT_AFFORDANCE_MISSING" ? "enter_text" : "click_control";
  const affordanceTarget =
    need === "SEND_AFFORDANCE_MISSING"
      ? { kind: "ICON", hint: "send", frameRevisionAt: now, boundedRegion: { x: 0, y: 0, width: 0, height: 0 } }
      : need === "INPUT_AFFORDANCE_MISSING"
        ? { kind: "TEXT", hint: "composer/textarea/contenteditable" }
        : { kind: "ROLE", hint: "conversation/output region" };

  if (!geometryTargetValid(affordanceTarget)) {
    return { ...plan, verdict: "UNCERTAIN", reason: "ICON/POINT target lacks frame revision + bounded region (§28) — cannot act blindly" };
  }
  if (!allowed(clickOrText)) {
    return { ...plan, verdict: "DENIED", reason: `computer:${clickOrText} not granted for this task/workspace` };
  }
  plan.steps.push(step(clickOrText, affordanceTarget, "affordance acted on and page observable state changed or submission started", "§26 locate + act on the composer/send affordance"));

  if (need === "INPUT_AFFORDANCE_MISSING" && allowed("submit")) {
    plan.steps.push(step("submit", { kind: "ROLE", hint: "form/composer" }, "user message is visible in the conversation or generation started", "§26 perform native interaction → submit"));
  }
  // verify_state is a read (§29 read actions are always allowed), so the chain
  // always ends on a verifiable submission step when the mutations were granted.
  plan.steps.push(step("verify_state", { kind: "ROLE", hint: "conversation/output" }, "user message or fresh generation observed — submission verified", "§26 verify submission (post-condition)"));
  if (plan.steps.length < 3) {
    return { ...plan, verdict: "UNCERTAIN", reason: "repair chain incomplete — no verifiable submission step" };
  }
  return plan;
}

/**
 * §29: which `computer:<action>` grants a task manifest carries (mutations only).
 *
 * @param {readonly string[]} allowList
 * @returns {Set<ComputerActionName>}
 */
export function grantedComputerActions(allowList) {
  const granted = new Set();
  for (const entry of allowList) {
    const match = /^computer:(read_page|find_control|click_control|enter_text|submit|verify_state)$/.exec(entry.trim());
    if (match) granted.add(match[1]);
  }
  return granted;
}

/**
 * §25 post-condition discipline. An ACTED step whose post-condition cannot be
 * confirmed is UNCERTAIN — the caller must NOT repeat the mutation; it must stop
 * and take the recovery/fallback path.
 *
 * Donor defect, preserved: both non-VERIFIED paths answer "UNCERTAIN", so
 * `observed.acted` is read but changes nothing and the exported "ACTED" status can
 * never be returned. Pinned by a test; not repaired.
 *
 * @param {import("./contracts.mjs").RepairStep} step
 * @param {{postConditionSeen?: boolean, acted?: boolean}} observed
 * @returns {"VERIFIED"|"ACTED"|"UNCERTAIN"}
 */
export function verdictForOutcome(step, observed) {
  if (observed.postConditionSeen === true) return "VERIFIED";
  if (observed.acted === false) return "UNCERTAIN";
  return "UNCERTAIN";
}

/**
 * One-page summary used by the decision ledger (§38). `reason` is present only
 * when the plan carries one, and keeps the donor's spread order.
 *
 * @param {import("./contracts.mjs").RepairPlan} plan
 * @returns {{need: string, verdict: string, steps: number, actions: string[], reason?: string}}
 */
export function planSummary(plan) {
  return {
    need: plan.need,
    verdict: plan.verdict,
    steps: plan.steps.length,
    actions: plan.steps.map((item) => item.action),
    ...(plan.reason ? { reason: plan.reason } : {})
  };
}
