/**
 * UTOPIA · Worker Gateway — provider outcome semantics.
 *
 * Port of Codex-Boss `src/shared/provider-outcome.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * The donor file is self-contained: it has no `import`, no `require`, no dynamic
 * `import()` and no runtime coupling of any kind — the only names it reaches for
 * are ECMAScript intrinsics (`Set`-free array `includes`, `RegExp`, `String`) and
 * its own module-level constants. Every export is therefore carried over whole.
 * The `type` declarations become plain JSDoc typedefs and the interfaces become
 * factory-validated value shapes (see `contracts.mjs` for the vocabulary view).
 *
 * The split the donor insists on (Engine book §5) is preserved exactly:
 *
 *   runtime layer : did the CALL work?      SUCCESS / TIMEOUT / AUTH_REQUIRED …
 *   semantic layer: did the OUTPUT serve the goal?
 *                                            FULL_COMPLETION / HARD_REFUSAL / GOAL_DRIFT …
 *
 * A runtime-layer fault (auth, timeout, page change, rate limit, budget) must
 * never be recorded as a model capability/restriction signal, and an explicit
 * provider refusal inside a perfectly successful call must never be recorded as
 * a runtime failure. Everything here is deterministic, file-free, clock-free and
 * replayable.
 */

/* ------------------------------------------------------------------ *
 * Runtime-layer vocabulary
 * ------------------------------------------------------------------ */

/** Runtime-layer status vocabulary (unchanged from the donor's `RuntimeStatus`). */
export const RUNTIME_STATUSES = Object.freeze(['SUCCESS', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'CANCELLED']);

/**
 * Runtime-layer failure codes that are NOT evidence about the model.
 *
 * The donor declares this list module-private; it is exported here so a caller
 * can enumerate the codes instead of only testing one at a time. Membership is
 * unchanged, order included.
 */
export const NON_SEMANTIC_RUNTIME_CODES = Object.freeze([
  'TIMEOUT',
  'AUTH_REQUIRED',
  'PAGE_CHANGED',
  'RATE_LIMITED',
  'BUDGET_EXHAUSTED',
  'USER_ACTION_REQUIRED',
  'UNSUPPORTED',
  'DOWN',
  'BUSY',
  'UNKNOWN',
]);

/* ------------------------------------------------------------------ *
 * Semantic vocabulary and axis table
 * ------------------------------------------------------------------ */

/** The eleven semantic outcomes, in the donor's order. */
export const SEMANTIC_OUTCOMES = Object.freeze([
  'FULL_COMPLETION',
  'PARTIAL_COMPLETION',
  'GOAL_DRIFT',
  'SOFT_RESTRICTION',
  'HEAVY_SANITIZATION',
  'PARTIAL_REFUSAL',
  'HARD_REFUSAL',
  'BAD_QUALITY',
  'FORMAT_FAILURE',
  'VERIFICATION_FAILURE',
  'UNCLASSIFIED',
]);

/** `SEMANTIC_OUTCOMES` as a lookup Set. */
export const SEMANTIC_OUTCOME_SET = Object.freeze(new Set(SEMANTIC_OUTCOMES));

/** True when `value` is one of the eleven semantic outcomes. */
export function isSemanticOutcome(value) {
  return typeof value === 'string' && SEMANTIC_OUTCOME_SET.has(value);
}

/**
 * Continuous behaviour axes (donor Engine book §6) — never a single boolean.
 *
 * @typedef {object} BehaviourAxes
 * @property {number} completion          0..1
 * @property {number} goalFidelity        0..1
 * @property {number} restrictionImpact   0..1
 * @property {number} sanitizationImpact  0..1
 * @property {number} pipelineBlocking    0..1
 * @property {number} [quality]           0..1, only where the outcome has one
 * @property {number} [verificationScore] 0..1, only where the outcome has one
 */

/**
 * Axis table: outcome → continuous axes (donor Engine book §6). Values are
 * copied from the donor verbatim; the table is documented there as
 * "Configurable, not gospel".
 *
 * @type {Readonly<Record<string, BehaviourAxes>>}
 */
export const OUTCOME_AXES = Object.freeze({
  FULL_COMPLETION: Object.freeze({ completion: 1, goalFidelity: 1, restrictionImpact: 0, sanitizationImpact: 0, pipelineBlocking: 0 }),
  PARTIAL_COMPLETION: Object.freeze({ completion: 0.5, goalFidelity: 0.6, restrictionImpact: 0.05, sanitizationImpact: 0.05, pipelineBlocking: 0.2 }),
  GOAL_DRIFT: Object.freeze({ completion: 0.3, goalFidelity: 0.2, restrictionImpact: 0, sanitizationImpact: 0, pipelineBlocking: 0.5 }),
  SOFT_RESTRICTION: Object.freeze({ completion: 0.7, goalFidelity: 0.8, restrictionImpact: 0.2, sanitizationImpact: 0.1, pipelineBlocking: 0.1 }),
  HEAVY_SANITIZATION: Object.freeze({ completion: 0.6, goalFidelity: 0.5, restrictionImpact: 0.5, sanitizationImpact: 0.7, pipelineBlocking: 0.2 }),
  PARTIAL_REFUSAL: Object.freeze({ completion: 0.25, goalFidelity: 0.3, restrictionImpact: 0.75, sanitizationImpact: 0.2, pipelineBlocking: 0.7 }),
  HARD_REFUSAL: Object.freeze({ completion: 0, goalFidelity: 0, restrictionImpact: 1, sanitizationImpact: 0.1, pipelineBlocking: 1 }),
  BAD_QUALITY: Object.freeze({ completion: 0.4, goalFidelity: 0.6, restrictionImpact: 0, sanitizationImpact: 0, pipelineBlocking: 0.3, quality: 0.2 }),
  FORMAT_FAILURE: Object.freeze({ completion: 0.2, goalFidelity: 0.5, restrictionImpact: 0, sanitizationImpact: 0, pipelineBlocking: 0.6, quality: 0.3 }),
  VERIFICATION_FAILURE: Object.freeze({ completion: 0.5, goalFidelity: 0.7, restrictionImpact: 0, sanitizationImpact: 0, pipelineBlocking: 0.7, verificationScore: 0 }),
  // Unknown ⇒ NO penalty: neutral impact axes, zero confidence, excluded downstream.
  UNCLASSIFIED: Object.freeze({ completion: 0, goalFidelity: 0, restrictionImpact: 0, sanitizationImpact: 0, pipelineBlocking: 0 }),
});

/** The five axes every outcome must carry. */
export const REQUIRED_AXIS_KEYS = Object.freeze(['completion', 'goalFidelity', 'restrictionImpact', 'sanitizationImpact', 'pipelineBlocking']);

/** Every axis key the table may carry, in donor order. */
export const AXIS_KEYS = Object.freeze([...REQUIRED_AXIS_KEYS, 'quality', 'verificationScore']);

/** Evaluator version stamped on every evaluation this module produces. */
export const OUTCOME_EVALUATOR_VERSION = 'semantic-evaluator-1.0.0';

/** Schema version of an appended evaluation revision. */
export const REVISION_SCHEMA_VERSION = 1;

/**
 * @typedef {object} SemanticEvaluation
 * @property {string} evaluatorVersion
 * @property {string} outcome               one of `SEMANTIC_OUTCOMES`
 * @property {BehaviourAxes} axes
 * @property {number} confidence            0..1
 * @property {string[]} reasons
 * @property {boolean} runtimeAttributable  true when the runtime/host layer explains
 *                                          the outcome — such evaluations MUST NOT
 *                                          feed restriction/capability aggregates
 *                                          (donor Engine book §5, A05/A06/A07)
 * @property {boolean} penalizesSemanticProfile  explicit gate for profile builders:
 *                                          false ⇒ exclude from semantic profiles
 */

/**
 * @typedef {object} OutcomeEvaluationInput
 * @property {string} runtimeStatus
 * @property {string} [runtimeFailureCode]
 * @property {string} [content]             extracted response text, when there is one
 * @property {object} [signals]             see `deriveSemanticEvaluation`
 */

/* ------------------------------------------------------------------ *
 * Axis validation
 * ------------------------------------------------------------------ */

function requireAxisValue(value, key) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`axes.${key} must be a finite number`);
  }
  if (value < 0 || value > 1) throw new RangeError(`axes.${key} must be within 0..1`);
  return value;
}

/**
 * Validate and copy one axes object. Unknown keys are refused rather than
 * dropped, and an out-of-range or non-numeric axis throws: nothing here turns an
 * invalid reading into a valid one.
 *
 * Copy-on-construct: the returned object is frozen and detached from the input.
 *
 * @param {Partial<BehaviourAxes>} axes
 * @returns {Readonly<BehaviourAxes>}
 */
export function axeValues(axes) {
  if (axes === null || typeof axes !== 'object' || Array.isArray(axes)) throw new TypeError('axes must be an object');
  for (const key of Object.keys(axes)) {
    if (!AXIS_KEYS.includes(key)) throw new TypeError(`axes has no ${key} axis`);
  }
  for (const key of REQUIRED_AXIS_KEYS) {
    if (axes[key] === undefined) throw new TypeError(`axes.${key} is required`);
  }
  const copy = {};
  for (const key of AXIS_KEYS) {
    if (axes[key] === undefined) continue;
    copy[key] = requireAxisValue(axes[key], key);
  }
  return Object.freeze(copy);
}

/**
 * Validate and copy one semantic evaluation. Copy-on-construct: the input axes
 * array and reasons array are never adopted, so a later mutation of the caller's
 * object cannot rewrite a recorded evaluation.
 *
 * @param {SemanticEvaluation} evaluation
 * @returns {Readonly<SemanticEvaluation>}
 */
export function semanticEvaluation(evaluation) {
  if (evaluation === null || typeof evaluation !== 'object' || Array.isArray(evaluation)) {
    throw new TypeError('semantic evaluation must be an object');
  }
  if (typeof evaluation.evaluatorVersion !== 'string' || evaluation.evaluatorVersion === '') {
    throw new TypeError('evaluation.evaluatorVersion must be a non-empty string');
  }
  if (!isSemanticOutcome(evaluation.outcome)) {
    throw new TypeError(`evaluation.outcome must be one of ${SEMANTIC_OUTCOMES.join(', ')}`);
  }
  const confidence = requireAxisValue(evaluation.confidence, 'confidence');
  const reasons = Array.isArray(evaluation.reasons) ? evaluation.reasons.map((reason) => String(reason)) : [];
  if (!Array.isArray(evaluation.reasons)) throw new TypeError('evaluation.reasons must be an array');
  return Object.freeze({
    evaluatorVersion: evaluation.evaluatorVersion,
    outcome: evaluation.outcome,
    axes: axeValues(evaluation.axes),
    confidence,
    reasons: Object.freeze(reasons),
    runtimeAttributable: evaluation.runtimeAttributable === true,
    penalizesSemanticProfile: evaluation.penalizesSemanticProfile === true,
  });
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

function unclassified(reason, evaluatorVersion, extraReasons = []) {
  return {
    evaluatorVersion,
    outcome: 'UNCLASSIFIED',
    axes: { ...OUTCOME_AXES.UNCLASSIFIED },
    confidence: 0,
    reasons: [reason, ...extraReasons],
    runtimeAttributable: true,
    penalizesSemanticProfile: false,
  };
}

/** Is this runtime code a host/runtime problem rather than model behaviour? */
export function isNonSemanticRuntimeCode(code) {
  if (!code) return false;
  return NON_SEMANTIC_RUNTIME_CODES.includes(code);
}

/**
 * Deterministic classification. Order matters, exactly as in the donor:
 *  1. runtime-layer faults ⇒ UNCLASSIFIED (no semantic penalty)
 *  2. deterministic verification/format failures (not provider restriction)
 *  3. explicit refusal / partial refusal / restriction / sanitization
 *  4. goal drift
 *  5. partial vs full completion
 *
 * @param {OutcomeEvaluationInput} input
 * @param {string} [evaluatorVersion]
 * @returns {SemanticEvaluation}
 */
export function deriveSemanticEvaluation(input, evaluatorVersion = OUTCOME_EVALUATOR_VERSION) {
  const reasons = [];
  const signals = input.signals ?? {};

  // 1. Runtime-layer faults: never model evidence (A05/A06/A07).
  if (input.runtimeStatus !== 'SUCCESS') {
    const code = input.runtimeFailureCode ?? input.runtimeStatus;
    return unclassified(`runtime did not succeed (${code}); no semantic conclusion`, evaluatorVersion, [
      isNonSemanticRuntimeCode(input.runtimeFailureCode)
        ? 'runtime-layer fault excluded from semantic evidence'
        : 'runtime failure excluded from semantic evidence',
    ]);
  }
  if (isNonSemanticRuntimeCode(input.runtimeFailureCode)) {
    return unclassified(`runtime reported ${input.runtimeFailureCode}; not model behaviour`, evaluatorVersion);
  }

  const content = (input.content ?? '').trim();

  // 2. Deterministic checks first: format / verification failures are OUR
  //    contract violations, not provider restriction evidence.
  if (signals.verificationPassed === false) {
    return build('VERIFICATION_FAILURE', evaluatorVersion, ['deterministic verification failed'], 0.9);
  }
  if (signals.formatOk === false) {
    return build('FORMAT_FAILURE', evaluatorVersion, ['response did not match the requested format'], 0.8);
  }

  // 3. Provider behaviour signals.
  if (signals.refusal === true) {
    return build('HARD_REFUSAL', evaluatorVersion, ['explicit refusal observed inside a successful call'], 0.85);
  }
  if (signals.partialRefusal === true) {
    return build('PARTIAL_REFUSAL', evaluatorVersion, ['partial refusal observed'], 0.7);
  }
  if (signals.heavySanitization === true) {
    return build('HEAVY_SANITIZATION', evaluatorVersion, ['heavy sanitization observed'], 0.6);
  }
  if (signals.softRestriction === true) {
    return build('SOFT_RESTRICTION', evaluatorVersion, ['soft restriction observed'], 0.6);
  }

  // 4. Goal drift (A08).
  if (signals.driftEvidence?.length) {
    return build('GOAL_DRIFT', evaluatorVersion, ['goal drift evidence recorded', ...signals.driftEvidence], 0.7);
  }

  // 5. Completion coverage.
  const covered = signals.deliverablesCovered;
  if (typeof covered === 'number' && covered < 1) {
    if (signals.badQuality === true || (typeof signals.quality === 'number' && signals.quality < 0.35)) {
      return build('BAD_QUALITY', evaluatorVersion, [`deliverables covered ${covered}`, 'quality below threshold'], 0.6);
    }
    return build('PARTIAL_COMPLETION', evaluatorVersion, [`deliverables covered ${covered}`], 0.7);
  }
  if (signals.badQuality === true) {
    return build('BAD_QUALITY', evaluatorVersion, ['content judged unusable by deterministic checker'], 0.6);
  }
  if (typeof signals.quality === 'number' && signals.quality < 0.35) {
    return build('BAD_QUALITY', evaluatorVersion, [`quality ${signals.quality}`], 0.5);
  }

  if (!content) {
    return unclassified('call succeeded but produced no content to evaluate', evaluatorVersion);
  }

  reasons.push('no refusal/restriction/format/verification/drift signal observed');
  return build('FULL_COMPLETION', evaluatorVersion, reasons, 0.7);
}

function build(outcome, evaluatorVersion, reasons, confidence) {
  return {
    evaluatorVersion,
    outcome,
    axes: { ...OUTCOME_AXES[outcome] },
    confidence,
    reasons,
    runtimeAttributable: false,
    penalizesSemanticProfile: true,
  };
}

/* ------------------------------------------------------------------ *
 * Goal drift
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} GoalDriftInput
 * @property {string[]} [deliverables]
 * @property {string[]} [constraints]
 *
 * @typedef {object} GoalDriftResult
 * @property {boolean} drifted
 * @property {string[]} evidence
 */

const SCOPE_CHANGE_MARKERS = [
  /instead of (?:the )?(?:requested|original)/i,
  /rather than (?:the )?(?:requested|original)/i,
  /i (?:changed|altered|replaced) the (?:goal|objective|requirement|scope)/i,
  /(?:改为|改成了|换成了|替换了(?:目标|需求|范围))/,
  /(?:不按|未按)(?:原|用户)(?:要求|目标)/,
];

/** Marker + coverage based drift evidence. Never rewrites the goal — only reports.
 *
 * @param {GoalDriftInput} goal
 * @param {string} output
 * @returns {GoalDriftResult}
 */
export function detectGoalDrift(goal, output) {
  const evidence = [];
  const text = output ?? '';
  for (const marker of SCOPE_CHANGE_MARKERS) {
    if (marker.test(text)) evidence.push(`scope-change marker: ${marker.source}`);
  }
  for (const deliverable of goal.deliverables ?? []) {
    const tokens = deliverable
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]{4,}/gu)
      ?.slice(0, 3) ?? [];
    if (tokens.length && !tokens.some((token) => text.toLocaleLowerCase().includes(token))) {
      evidence.push(`deliverable not addressed: ${deliverable}`);
    }
  }
  return { drifted: evidence.length > 0, evidence };
}

/* ------------------------------------------------------------------ *
 * Evaluation revision
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} SemanticEvaluationRevision
 * @property {1} schemaVersion
 * @property {string} episodeId
 * @property {string} originalEvaluatorVersion
 * @property {string} originalOutcome
 * @property {SemanticEvaluation} revised
 * @property {string} reason
 * @property {string} revisedAt
 */

/**
 * Evaluator revision (donor Engine §10): a later, better evaluator may re-judge
 * an episode, but the original response/artifact and the original evaluation are
 * never overwritten — the revision is appended and carries the audit reference.
 *
 * @param {{episodeId: string, original: SemanticEvaluation, revised: SemanticEvaluation,
 *          reason: string, revisedAt: string}} input
 * @returns {SemanticEvaluationRevision}
 */
export function createEvaluationRevision(input) {
  return {
    schemaVersion: REVISION_SCHEMA_VERSION,
    episodeId: input.episodeId,
    originalEvaluatorVersion: input.original.evaluatorVersion,
    originalOutcome: input.original.outcome,
    revised: input.revised,
    reason: input.reason,
    revisedAt: input.revisedAt,
  };
}
