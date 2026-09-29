/**
 * checkpoint-1 §33 (checkpoint-10): failure classification, the recovery order
 * and §33.3's HNS positioning.
 *
 * The cases pin the rules that keep recovery honest: classification from real
 * evidence (and the signals that decided it), a ladder whose order cannot be
 * short-circuited, a plan that always ends at the Hard Blocker, and an HNS
 * fallback that cannot happen without a CapabilityGap.
 *
 * Donor test, copied verbatim from `Codex-Boss` @
 * 8df428eaa437a409368401e95194e40266b83080 `tests/unit/recovery-model.test.ts`.
 * Only the import specifier changed: `"vitest"` became `"./_vitest-shim.mjs"` and
 * `"../../src/shared/recovery"` became `"../../failure-recovery.mjs"`.
 * `./_vitest-shim.mjs` is the test-only `describe`/`it`/`expect` adapter that
 * re-implements the donor's matchers on `node:test` + `node:assert/strict`, so no
 * assertion had to be rewritten. The TypeScript type-only imports were dropped,
 * which is a syntax change with no runtime effect, as were the five inline type
 * annotations (`: string`, `: RecoveryAttempt[]`, `as FailureClass`, `as never`).
 * Every title, body and assertion below is the donor's.
 */
import { describe, expect, it } from "./_vitest-shim.mjs";
import {
  advanceRecovery,
  classifyFailure,
  FAILURE_CLASSES,
  HNS_ROLES,
  MAX_CONSECUTIVE_HNS_CALLS,
  planHnsFallback,
  planRecovery,
  RECOVERY_ORDER,
  recordHnsUsage,
  THEME_RECOVERY_STEPS
} from "../../failure-recovery.mjs";

const classified = (detail, extra = {}) => classifyFailure({ detail, ...extra });

describe("checkpoint-10 §33.1 failure classification", () => {
  it("covers at least the twelve classes the plan names", () => {
    expect(FAILURE_CLASSES.length).toBeGreaterThanOrEqual(12);
    for (const expected of ["TRANSIENT", "TERMINAL", "DEPENDENCY", "AUTH", "RATE_LIMIT", "PROVIDER_PAGE", "WORKSPACE", "BUILD", "TEST", "ENVIRONMENT", "THEME", "UI", "UNKNOWN"]) {
      expect(FAILURE_CLASSES).toContain(expected);
    }
  });

  it("classifies from the tool's own output, not from a guess", () => {
    expect(classified("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.").failure_class).toBe("BUILD");
    expect(classified("AssertionError: expected 1 to equal 2").failure_class).toBe("TEST");
    expect(classified("Error: Cannot find module 'left-pad'", { workspace: { missing_modules: ["left-pad"] } }).failure_class).toBe("DEPENDENCY");
    expect(classified("429 Too Many Requests", { runtime_code: "RATE_LIMITED" }).failure_class).toBe("RATE_LIMIT");
    expect(classified("login expired", { runtime_code: "AUTH_REQUIRED" }).failure_class).toBe("AUTH");
    expect(classified("selector not found for the send button", { runtime_code: "PAGE_CHANGED" }).failure_class).toBe("PROVIDER_PAGE");
    expect(classified("EPERM: operation not permitted", {}).failure_class).toBe("ENVIRONMENT");
    expect(classified("Timeout awaiting response", { runtime_code: "TIMEOUT" }).failure_class).toBe("TRANSIENT");
  });

  it("reports the signals that decided the class", () => {
    const result = classified("Error: Cannot find module 'left-pad'", { workspace: { missing_modules: ["left-pad"] } });
    expect(result.signals.some((signal) => signal.startsWith("output:"))).toBe(true);
    expect(result.signals).toContain("workspace:missing_modules=left-pad");
  });

  it("never reclassifies a refusal as something retryable", () => {
    const result = classifyFailure({ detail: "timed out while submitting", policy_refusal: "GUARDIAN_DENIED" });
    expect(result.failure_class).toBe("TERMINAL");
    expect(result.severity).toBe("CRITICAL");
    expect(result.signals[0]).toContain("policy_refusal");
  });

  it("refuses a dependency class when the host verified the module is present", () => {
    const result = classified("Cannot find module 'left-pad'", { workspace: { missing_modules: [] }, gate: "TYPECHECK" });
    expect(result.failure_class).toBe("BUILD");
    expect(result.reason).toContain("the TYPECHECK gate failed");
  });

  it("classifies a scope refusal as a workspace failure", () => {
    const result = classified("src/x.ts is outside the granted scope", { workspace: { scope_refused: true } });
    expect(result.failure_class).toBe("WORKSPACE");
  });

  it("classifies theme and visual failures from their own evidence", () => {
    expect(classifyFailure({ detail: "theme validation failed: SCRIPT_INJECTION", theme_error_diagnostics: 2 }).failure_class).toBe("THEME");
    expect(classifyFailure({ detail: "NO_CATASTROPHIC_OVERFLOW failed", visual_failed: true, gate: "VISUAL" }).failure_class).toBe("UI");
  });

  it("says UNKNOWN rather than guessing when nothing matched", () => {
    const benchmark = classifyFailure({ gate: "BENCHMARK", detail: "p95 240ms > 100ms budget" });
    expect(benchmark.failure_class).toBe("UNKNOWN");
    expect(benchmark.reason).toContain("no class for it");
    const empty = classifyFailure({});
    expect(empty.failure_class).toBe("UNKNOWN");
    expect(empty.confidence).toBeLessThan(0.2);
  });
});

describe("checkpoint-10 §33.2 recovery order", () => {
  it("is the plan's order, ending at the Hard Blocker", () => {
    expect([...RECOVERY_ORDER]).toEqual([
      "NATIVE_RETRY", "LOCAL_RECOVERY", "ALTERNATE_INTERNAL_PATH", "ALTERNATE_PROVIDER",
      "DEGRADED_MODE", "HNS_FALLBACK", "HARD_BLOCKER"
    ]);
  });

  it("lists every step with a reason, applicable or not", () => {
    const plan = planRecovery(classified("error TS2322: type mismatch"));
    expect(plan.steps.map((step) => step.step)).toEqual([...RECOVERY_ORDER]);
    expect(plan.steps.every((step) => step.reason.length > 0)).toBe(true);
    expect(plan.steps.at(-1)?.step).toBe("HARD_BLOCKER");
    expect(plan.ends_at_hard_blocker).toBe(true);
    expect(plan.next).toBe("LOCAL_RECOVERY");
  });

  it("goes straight to the Hard Blocker for a prohibited action and forbids HNS", () => {
    const plan = planRecovery(classifyFailure({ policy_refusal: "GUARDIAN_DENIED" }));
    expect(plan.next).toBeUndefined();
    expect(plan.hns_allowed).toBe(false);
    expect(plan.requires_owner?.kind).toBe("AUTHORIZATION");
    expect(plan.steps.find((step) => step.step === "HNS_FALLBACK")?.reason).toContain("prohibited");
    expect(plan.diagnostics.some((line) => line.includes("straight to the Hard Blocker"))).toBe(true);
  });

  it("sends an auth failure to the Owner instead of retrying", () => {
    const plan = planRecovery(classified("", { runtime_code: "AUTH_REQUIRED", detail: "401 unauthorized" }));
    expect(plan.failure_class).toBe("AUTH");
    expect(plan.requires_owner?.kind).toBe("SIGN_IN");
    expect(plan.next).toBe("ALTERNATE_PROVIDER");
    expect(plan.steps.find((step) => step.step === "NATIVE_RETRY")?.applicable).toBe(false);
    expect(plan.hns_allowed).toBe(false);
  });

  it("gives a theme failure its own §33.2 ladder", () => {
    const plan = planRecovery(classifyFailure({ detail: "theme validation failed", theme_error_diagnostics: 1 }));
    expect(plan.theme_steps).toEqual([...THEME_RECOVERY_STEPS]);
    expect(plan.diagnostics.some((line) => line.includes("theme ladder"))).toBe(true);
  });

  it("will not reach HNS while a cheaper applicable step has budget left", () => {
    const plan = planRecovery(classifyFailure({ detail: "error TS2322" }));
    const none = [];
    expect(advanceRecovery(plan, none).next).toBe("LOCAL_RECOVERY");
    const used = [{ step: "LOCAL_RECOVERY", outcome: "FAIL" }, { step: "LOCAL_RECOVERY", outcome: "FAIL" }, { step: "LOCAL_RECOVERY", outcome: "FAIL" }];
    const progress = advanceRecovery(plan, used);
    expect(progress.next).toBe("HNS_FALLBACK");
    expect(progress.hard_blocker).toBe(false);
  });

  it("escalates to the Hard Blocker once every applicable step is exhausted", () => {
    const plan = planRecovery(classifyFailure({ detail: "error TS2322" }));
    const all = [
      { step: "LOCAL_RECOVERY", outcome: "FAIL" }, { step: "LOCAL_RECOVERY", outcome: "FAIL" }, { step: "LOCAL_RECOVERY", outcome: "FAIL" },
      { step: "HNS_FALLBACK", outcome: "FAIL" }, { step: "HNS_FALLBACK", outcome: "FAIL" }
    ];
    const progress = advanceRecovery(plan, all);
    expect(progress.exhausted).toBe(true);
    expect(progress.hard_blocker).toBe(true);
    expect(progress.next).toBeUndefined();
    expect(progress.reason).toContain("Hard Blocker");
  });

  it("treats a prohibited failure as immediately hard-blocked", () => {
    const plan = planRecovery(classifyFailure({ policy_refusal: "POLICY" }));
    const progress = advanceRecovery(plan, []);
    expect(progress.hard_blocker).toBe(true);
    expect(progress.reason).toContain("no step applies");
  });
});

describe("checkpoint-10 §33.3 HNS positioning and the mandatory gap", () => {
  const buildClassification = classifyFailure({ detail: "error TS2322: type mismatch" });

  it("allows a first fallback but always produces a CapabilityGap", () => {
    const decision = planHnsFallback({
      classification: buildClassification,
      plan: { hns_allowed: true },
      task: "repair the gateway",
      missing_capability: "multi-file refactor planning",
      workaround: "HNS rewrites the two files and Boss verifies them",
      now: "2026-01-01T00:00:00.000Z"
    });
    expect(decision.allowed).toBe(true);
    expect(decision.capability_gap.missing_capability).toBe("multi-file refactor planning");
    expect(decision.capability_gap.severity).toBe("LOW");
    expect(decision.backlog.stage).toBe("IMPROVEMENT_TASK");
    expect(decision.backlog.from_failure_class).toBe("BUILD");
    expect(decision.reason).toContain("gap is recorded");
  });

  it("refuses a fallback with no named missing capability — and still records the gap", () => {
    const decision = planHnsFallback({
      classification: buildClassification,
      plan: { hns_allowed: true },
      task: "t",
      missing_capability: "   ",
      workaround: "w"
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("must name the capability");
    expect(decision.backlog.missing_capability).toBe("");
  });

  it("refuses to delegate a prohibited action to HNS", () => {
    const terminal = classifyFailure({ policy_refusal: "GUARDIAN_DENIED" });
    const decision = planHnsFallback({ classification: terminal, plan: { hns_allowed: false }, task: "t", missing_capability: "c", workaround: "w" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("not a recovery route");
    expect(decision.capability_gap.failure_class).toBe("TERMINAL");
  });

  it("stops HNS becoming a permanent crutch after the consecutive ceiling", () => {
    const decision = planHnsFallback({
      classification: buildClassification,
      plan: { hns_allowed: true },
      task: "t",
      missing_capability: "c",
      workaround: "w",
      history: { hns_calls: 5, consecutive_hns_calls: MAX_CONSECUTIVE_HNS_CALLS }
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("permanent crutch");
    expect(decision.capability_gap.severity).toBe("HIGH");
  });

  it("raises the gap's severity with its frequency", () => {
    const once = planHnsFallback({ classification: buildClassification, plan: { hns_allowed: true }, task: "t", missing_capability: "c", workaround: "w", history: { hns_calls: 1, consecutive_hns_calls: 0, gap_frequency: 1 } });
    const often = planHnsFallback({ classification: buildClassification, plan: { hns_allowed: true }, task: "t", missing_capability: "c", workaround: "w", history: { hns_calls: 9, consecutive_hns_calls: 0, gap_frequency: 6 } });
    expect(once.capability_gap.severity).toBe("LOW");
    expect(often.capability_gap.severity).toBe("HIGH");
    expect(often.capability_gap.frequency).toBe(6);
  });

  it("records only the four §33.3 roles, and never without a gap", () => {
    expect([...HNS_ROLES]).toEqual(["fallback", "diagnostic", "recovery", "external_executor"]);
    const decision = planHnsFallback({ classification: buildClassification, plan: { hns_allowed: true }, task: "t", missing_capability: "c", workaround: "w", now: "2026-01-01T00:00:00.000Z" });
    const record = recordHnsUsage(decision, "external_executor", "2026-01-01T00:00:01.000Z");
    expect(record.role).toBe("external_executor");
    expect(record.capability_gap.missing_capability).toBe("c");
    expect(record.recorded_at).toBe("2026-01-01T00:00:01.000Z");
    expect(() => recordHnsUsage(decision, "magic")).toThrow(/not an HNS role/);
    const gapless = { ...decision, capability_gap: { ...decision.capability_gap, missing_capability: "" } };
    expect(() => recordHnsUsage(gapless, "fallback")).toThrow(/without a named missing capability/);
  });
});
