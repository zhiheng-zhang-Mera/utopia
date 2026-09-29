/**
 * UTOPIA · City Core — self-healing / recovery, one model (§33).
 *
 * Ported from the Codex-Boss donor `src/shared/recovery.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * The donor's doctrine is the whole reason this file is carried over rather than
 * re-invented, and it is preserved here one for one:
 *
 *   - a class is decided from real evidence — a tool's own output, a gate, a
 *     host-verified workspace fact — never from a guess, and the evidence that
 *     decided it is reported in `signals` so the classification is auditable;
 *   - the ladder may not be short-circuited: a step is only skipped when the plan
 *     says so with the reason recorded, inapplicable steps are listed rather than
 *     hidden, and the plan always ends at a Hard Blocker rather than stopping
 *     silently;
 *   - a prohibited action is never retried. A Guardian/policy refusal is decided
 *     before any prose, and it is the only class with no applicable step at all;
 *   - "we did not look" is not a pass: an unclassifiable failure is UNKNOWN with a
 *     low confidence, not the most convenient class.
 *
 * The donor file also carries §33.3's HNS external-executor integration
 * (`planHnsFallback`, `recordHnsUsage`, `HNS_ROLES`, `MAX_CONSECUTIVE_HNS_CALLS`).
 * That is deliberately NOT ported: it is a named third-party product's invocation
 * budget and improvement-backlog wiring, not a recovery primitive. See
 * `./DONOR.json` `knownDifferences` / `classification.DEFERRED`.
 *
 * Pure: no fs, no network, no clock, no process. No function here reads a clock —
 * nothing in the ported surface needs a time input, so none is added.
 */

import {
  FAILURE_CLASSES,
  RECOVERY_ORDER,
  THEME_RECOVERY_STEPS,
  assertFailureClassification,
  failureClassification,
} from './contracts.mjs';

export { FAILURE_CLASSES, RECOVERY_ORDER, THEME_RECOVERY_STEPS };

/** The donor's `RECOVERY_VERSION`; it rides every plan as its `version`. */
const RECOVERY_VERSION = 'recovery-1';

/* ------------------------------------------------------------------ *
 * §33.1 failure classification
 * ------------------------------------------------------------------ */

/**
 * §33.1's rule ladder. Each rule carries the patterns it answers to, the class it
 * assigns, the host-verified fact that must also hold before it may fire
 * (`requires`), and its confidence, severity and reason.
 *
 * The donor declared this as a TypeScript `interface ClassRule`; a shape with no
 * runtime existence has nothing to port, so the rule objects below are plain.
 *
 * Ordered most-authoritative first. A refusal or a security finding must never be
 * reclassified as "transient" by a stray word in the output, so TERMINAL is
 * decided before anything else, and host-verified facts decide before prose.
 */
const CLASS_RULES = [
  {
    failure_class: 'TERMINAL', confidence: 1, severity: 'CRITICAL',
    reason: 'a policy/Guardian refusal or a security finding: the action is prohibited, so retrying it is not recovery',
    patterns: [/guardian (denied|refused)/i, /policy refusal/i, /prohibited/i, /destructive (change|action)/i, /secret exposure/i, /不得|禁止|拒绝执行/],
  },
  {
    failure_class: 'AUTH', confidence: 0.95, severity: 'HIGH',
    reason: 'credentials are missing, expired or rejected: no local retry can substitute for signing in',
    patterns: [/AUTH_REQUIRED/i, /\b401\b/, /unauthori[sz]ed/i, /login (required|expired)/i, /session expired/i, /登录|凭证|认证失败/],
  },
  {
    failure_class: 'RATE_LIMIT', confidence: 0.95, severity: 'MEDIUM',
    reason: 'the provider is rate limited: wait, then use a different provider',
    patterns: [/RATE_LIMITED/i, /\b429\b/, /rate ?limit/i, /too many requests/i, /限流|请求过多/],
  },
  {
    failure_class: 'PROVIDER_PAGE', confidence: 0.9, severity: 'MEDIUM',
    reason: 'the provider page changed under us: re-read the page and patch the adapter',
    patterns: [/PAGE_CHANGED/i, /selector not found/i, /找不到选择器/, /send button not found/i, /dom (drift|changed)/i],
  },
  {
    failure_class: 'DEPENDENCY', confidence: 0.9, severity: 'MEDIUM',
    reason: 'a required module/package is missing: install or declare it, no provider can supply it',
    patterns: [/cannot find module/i, /ERR_MODULE_NOT_FOUND/i, /TS2307/, /is not recognized as an internal/i, /missing (package|dependency)/i, /依赖(缺失|未安装)/],
    requires: (observation) => (observation.workspace?.missing_modules?.length ?? 0) > 0 || !observation.workspace,
  },
  {
    failure_class: 'ENVIRONMENT', confidence: 0.85, severity: 'HIGH',
    reason: 'the host environment refused the operation: permissions, disk or sandbox',
    patterns: [/ENOSPC/i, /EACCES/i, /EPERM/i, /no space left/i, /permission denied/i, /sandbox/i, /磁盘|权限不足/],
  },
  {
    failure_class: 'WORKSPACE', confidence: 0.9, severity: 'HIGH',
    reason: 'the workspace refused the write: the scope or the path was not allowed',
    patterns: [/escapes workspace/i, /symlink escapes/i, /protected workspace metadata/i, /outside the granted scope/i, /not a git repository/i, /越界|不在授予/],
    requires: (observation) => observation.workspace?.scope_refused === true || observation.workspace?.escaped_path === true || observation.workspace?.protected_path === true || observation.workspace === undefined,
  },
  {
    failure_class: 'THEME', confidence: 0.9, severity: 'MEDIUM',
    reason: 'the theme package failed validation or the active theme is unusable: disable, fall back to built-in, record the diagnostic',
    patterns: [/theme (validation|registry)/i, /UNKNOWN_TOKEN/i, /UNSAFE_URL/i, /SCRIPT_INJECTION/i, /主题(校验|注册表)/],
    requires: (observation) => (observation.theme_error_diagnostics ?? 0) > 0 || observation.gate === undefined,
  },
  {
    failure_class: 'UI', confidence: 0.85, severity: 'MEDIUM',
    reason: 'the visual/runtime gate failed: this is interface engineering, not a retry',
    patterns: [/MAJOR_SURFACE_VISIBLE/i, /TEXT_READABLE/i, /overflow/i, /not visible/i, /布局|溢出|不可见/],
    requires: (observation) => observation.visual_failed === true || observation.gate === 'VISUAL' || observation.gate === 'BLACKBOX' || observation.gate === 'RUNTIME',
  },
  {
    failure_class: 'BUILD', confidence: 0.85, severity: 'MEDIUM',
    reason: 'the code does not compile: repair the source, not the pipeline',
    patterns: [/error TS\d{4}/, /\bTS\d{4}\b/, /build failed/i, /vite.*error/i, /编译失败/],
  },
  {
    failure_class: 'TEST', confidence: 0.85, severity: 'MEDIUM',
    reason: 'an executed test failed: repair the behaviour or the test, both inside the scope',
    patterns: [/\bfail(ed|ing)?\b.*test/i, /assertionerror/i, /expected .* to (be|equal)/i, /✗|×/, /测试失败/],
  },
  {
    failure_class: 'TRANSIENT', confidence: 0.7, severity: 'LOW',
    reason: 'a transient runtime fault: retrying is worth one bounded attempt',
    patterns: [/TIMEOUT/i, /timed out/i, /ECONNRESET/i, /ECONNREFUSED/i, /\b50[234]\b/, /temporarily unavailable/i, /超时|暂时/],
  },
];

/** Runs one observable command's result through the ladder of classes. */
export function classifyFailure(observation = {}) {
  const haystack = [observation.detail ?? '', observation.runtime_code ?? '', observation.policy_refusal ?? '', observation.semantic_outcome ?? ''].join('\n');
  const runtime = observation.runtime_code ?? '';
  const signals = [];

  // §33.3 / §2.3: a refusal is decided from the refusal itself, before any prose.
  if (observation.policy_refusal) {
    return failureClassification({
      failure_class: 'TERMINAL',
      confidence: 1,
      reason: 'a policy/Guardian refusal: the action is prohibited, so retrying it is not recovery',
      signals: [`policy_refusal:${observation.policy_refusal}`],
      severity: 'CRITICAL',
    });
  }

  for (const rule of CLASS_RULES) {
    if (rule.requires && !rule.requires(observation)) continue;
    const matched = rule.patterns.filter((pattern) => pattern.test(haystack) || pattern.test(runtime));
    if (!matched.length) continue;
    for (const pattern of matched.slice(0, 3)) signals.push(`output:${pattern.source.slice(0, 40)}`);
    if (observation.workspace?.missing_modules?.length) signals.push(`workspace:missing_modules=${observation.workspace.missing_modules.slice(0, 3).join(',')}`);
    if (observation.workspace?.scope_refused) signals.push('workspace:scope_refused');
    if ((observation.theme_error_diagnostics ?? 0) > 0) signals.push(`theme:error_diagnostics=${observation.theme_error_diagnostics}`);
    return failureClassification({ failure_class: rule.failure_class, confidence: rule.confidence, reason: rule.reason, signals, severity: rule.severity });
  }

  // A gate that failed with no recognisable signal is still classifiable: the gate
  // itself is evidence, and the honest answer for a benchmark miss is UNKNOWN
  // because §33.1 has no PERFORMANCE class.
  if (observation.gate) {
    const gateClass = {
      SYNTAX: 'BUILD', TYPECHECK: 'BUILD', BUILD: 'BUILD',
      UNIT: 'TEST', MODULE: 'TEST', INTEGRATION: 'TEST', FULL: 'TEST',
      VISUAL: 'UI', RUNTIME: 'UI', BLACKBOX: 'UI',
    };
    const mapped = gateClass[observation.gate];
    if (mapped) {
      return failureClassification({
        failure_class: mapped,
        confidence: 0.5,
        reason: `the ${observation.gate} gate failed without a recognisable error signature; the gate itself is the evidence`,
        signals: [`gate:${observation.gate}`],
        severity: 'MEDIUM',
      });
    }
    return failureClassification({
      failure_class: 'UNKNOWN',
      confidence: 0.3,
      reason: `the ${observation.gate} gate failed and §33.1 has no class for it; recorded as UNKNOWN rather than guessed`,
      signals: [`gate:${observation.gate}`],
      severity: 'MEDIUM',
    });
  }
  return failureClassification({ failure_class: 'UNKNOWN', confidence: 0.1, reason: 'no gate, runtime code or output signal was available to classify this failure', signals: [], severity: 'MEDIUM' });
}

/* ------------------------------------------------------------------ *
 * §33.2 recovery order
 * ------------------------------------------------------------------ */

const STEP_ORDER_REASON = {
  NATIVE_RETRY: '§33.2 native retry (the same path, bounded)',
  LOCAL_RECOVERY: '§33.2 local recovery (repair what is inside our own authority)',
  ALTERNATE_INTERNAL_PATH: '§33.2 alternate internal path (another way through our own machinery)',
  ALTERNATE_PROVIDER: '§33.2 alternate provider',
  DEGRADED_MODE: '§33.2 degraded mode (deliver less, honestly labelled)',
  HNS_FALLBACK: '§33.3 HNS fallback (an external executor, and a CapabilityGap)',
  HARD_BLOCKER: '§33.2 Hard Blocker (stop and hand the decision to the Owner)',
};

const RECOVERY_RULES = {
  TRANSIENT: { attempts: { NATIVE_RETRY: 2, LOCAL_RECOVERY: 1 }, inapplicable: {}, hns_allowed: true },
  TERMINAL: {
    attempts: {},
    inapplicable: {
      NATIVE_RETRY: 'the action is prohibited; repeating it is not recovery',
      LOCAL_RECOVERY: 'no local repair makes a prohibited action allowed',
      ALTERNATE_INTERNAL_PATH: 'no internal path may do what is prohibited',
      ALTERNATE_PROVIDER: 'a different provider does not make the action allowed',
      DEGRADED_MODE: 'there is no degraded version of a prohibited action',
      HNS_FALLBACK: '§33.3 forbids delegating a prohibited action to HNS',
    },
    hns_allowed: false,
    requires_owner: { kind: 'AUTHORIZATION', reason: 'the request was refused by policy; only the Owner can change the goal or authorize it' },
  },
  DEPENDENCY: {
    attempts: { LOCAL_RECOVERY: 2, ALTERNATE_INTERNAL_PATH: 1 },
    inapplicable: {
      NATIVE_RETRY: 'retrying cannot conjure a missing module',
      ALTERNATE_PROVIDER: 'a provider cannot supply a missing local module',
    },
    hns_allowed: true,
  },
  AUTH: {
    attempts: { ALTERNATE_PROVIDER: 1 },
    inapplicable: {
      NATIVE_RETRY: 'the same credentials will fail again',
      LOCAL_RECOVERY: 'signing in is the Owner\'s action, not a local repair',
      ALTERNATE_INTERNAL_PATH: 'no internal path bypasses authentication',
    },
    hns_allowed: false,
    requires_owner: { kind: 'SIGN_IN', reason: 'credentials are expired or rejected; the Owner must sign in' },
  },
  RATE_LIMIT: {
    attempts: { NATIVE_RETRY: 1, ALTERNATE_PROVIDER: 2, DEGRADED_MODE: 1 },
    inapplicable: { LOCAL_RECOVERY: 'rate limits are not a local fault' },
    hns_allowed: true,
  },
  PROVIDER_PAGE: {
    attempts: { LOCAL_RECOVERY: 2, ALTERNATE_INTERNAL_PATH: 1, ALTERNATE_PROVIDER: 1 },
    inapplicable: { NATIVE_RETRY: 'the page will look the same until the adapter is patched' },
    hns_allowed: true,
  },
  WORKSPACE: {
    attempts: { LOCAL_RECOVERY: 2 },
    inapplicable: {
      NATIVE_RETRY: 'the same path will be refused again',
      ALTERNATE_PROVIDER: 'a provider cannot widen the granted scope',
      DEGRADED_MODE: 'writing outside the scope is not a degraded mode',
    },
    hns_allowed: false,
    requires_owner: { kind: 'AUTHORIZATION', reason: 'the granted scope must change; only the Owner can widen it' },
  },
  BUILD: { attempts: { LOCAL_RECOVERY: 3 }, inapplicable: { NATIVE_RETRY: 'the same source will not compile', ALTERNATE_PROVIDER: 'a provider cannot fix a compile error in our tree' }, hns_allowed: true },
  TEST: { attempts: { LOCAL_RECOVERY: 3 }, inapplicable: { NATIVE_RETRY: 'a deterministic test failure repeats', ALTERNATE_PROVIDER: 'a provider cannot fix our failing test' }, hns_allowed: true },
  ENVIRONMENT: {
    attempts: { LOCAL_RECOVERY: 2, DEGRADED_MODE: 1 },
    inapplicable: { ALTERNATE_PROVIDER: 'the environment, not the provider, refused' },
    hns_allowed: true,
  },
  THEME: {
    attempts: { LOCAL_RECOVERY: 2, DEGRADED_MODE: 1 },
    inapplicable: { ALTERNATE_PROVIDER: 'a theme is our own package, not a provider\'s work' },
    hns_allowed: true,
    theme: true,
  },
  UI: {
    attempts: { LOCAL_RECOVERY: 3 },
    inapplicable: { NATIVE_RETRY: 'the same layout will fail the same check', ALTERNATE_PROVIDER: 'a provider cannot fix our interface' },
    hns_allowed: true,
    requires_owner: undefined,
  },
  UNKNOWN: { attempts: { NATIVE_RETRY: 1, LOCAL_RECOVERY: 1, ALTERNATE_INTERNAL_PATH: 1 }, inapplicable: {}, hns_allowed: true },
};

/**
 * §33.2: the recovery plan for a classified failure.
 *
 * The plan never hides a step: inapplicable steps are listed with their reason, so
 * "we went straight to HNS" is visible in the record rather than implied. The last
 * step is always HARD_BLOCKER.
 */
export function planRecovery(classification) {
  assertFailureClassification(classification);
  const rule = RECOVERY_RULES[classification.failure_class];
  const diagnostics = [];
  const steps = RECOVERY_ORDER.map((step) => {
    const gap = rule.inapplicable[step];
    if (gap) return { step, applicable: false, reason: gap, budget: 0 };
    if (step === 'HARD_BLOCKER') return { step, applicable: true, reason: STEP_ORDER_REASON[step], budget: 1 };
    if (step === 'HNS_FALLBACK' && !rule.hns_allowed) return { step, applicable: false, reason: '§33.3: HNS is not a recovery route for this failure class', budget: 0 };
    // §33.3: when HNS is allowed at all it is a fallback, tried once — never the
    // first move, and never repeatedly.
    const budget = step === 'HNS_FALLBACK' ? 1 : rule.attempts[step] ?? 0;
    return budget > 0
      ? { step, applicable: true, reason: STEP_ORDER_REASON[step], budget }
      : { step, applicable: false, reason: 'not needed for this failure class', budget: 0 };
  });
  const next = steps.find((step) => step.applicable && step.step !== 'HARD_BLOCKER')?.step;
  if (!next) diagnostics.push('no recovery step applies; the plan goes straight to the Hard Blocker');
  if (rule.theme) diagnostics.push('§33.2 theme ladder: disable → fall back to the built-in theme → record the diagnostic');
  const plan = {
    schemaVersion: 1,
    version: RECOVERY_VERSION,
    failure_class: classification.failure_class,
    severity: classification.severity,
    steps,
    next,
    hns_allowed: rule.hns_allowed,
    ends_at_hard_blocker: true,
    diagnostics,
  };
  if (rule.requires_owner) plan.requires_owner = rule.requires_owner;
  if (rule.theme) plan.theme_steps = [...THEME_RECOVERY_STEPS];
  return plan;
}

/**
 * §33.2: where a run stands after its attempts.
 *
 * The order is not advisory: a later step is only offered once every applicable
 * earlier step has used its budget. HNS in particular cannot be reached while a
 * cheaper step is still available, and a prohibited (TERMINAL) failure has no
 * steps at all.
 */
export function advanceRecovery(plan, attempts = []) {
  for (const step of plan.steps) {
    if (!step.applicable) continue;
    if (step.step === 'HARD_BLOCKER') break;
    const used = attempts.filter((attempt) => attempt.step === step.step && attempt.outcome !== 'NOT_APPLICABLE').length;
    if (used < step.budget) {
      return {
        next: step.step,
        exhausted: false,
        hard_blocker: false,
        reason: `${STEP_ORDER_REASON[step.step]} — attempt ${used + 1} of ${step.budget}`,
      };
    }
  }
  const firstSkipped = plan.steps.find((step) => !step.applicable && step.step !== 'HARD_BLOCKER');
  return {
    hard_blocker: true,
    exhausted: true,
    reason: firstSkipped && plan.next === undefined
      ? `§33.2 Hard Blocker: no step applies (${firstSkipped.reason})`
      : '§33.2 Hard Blocker: every applicable recovery step is exhausted',
  };
}
