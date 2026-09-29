/**
 * UTOPIA · City Service Network — the stable outcome model.
 *
 * Two questions that must never be conflated:
 *
 *   RuntimeOutcome   did the CALL work?      (SUCCESS / TIMEOUT / AUTH_REQUIRED …)
 *   SemanticOutcome  did the OUTPUT fulfil the goal?
 *                                            (FULL_COMPLETION / HARD_REFUSAL …)
 *
 * A runtime-layer fault — a timeout, an authentication prompt, a rate limit —
 * must never be recorded as evidence about what a provider is able to do, and an
 * explicit refusal inside a perfectly successful call must never be recorded as
 * a runtime failure. Getting this wrong is not a cosmetic bug: it silently
 * teaches the City that a provider is restricted when the network was merely
 * slow.
 *
 * Donor provenance: Codex-Boss `src/shared/provider-outcome.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. Parts ported verbatim in meaning:
 * the runtime/semantic split, the ordered classifier, the continuous behaviour
 * axes, the `runtimeAttributable` / `penalizesSemanticProfile` gates, the
 * deterministic goal-drift detector and the append-only evaluator revision.
 *
 * Two adaptations, recorded in DONOR.json:
 *
 *  1. The donor's runtime vocabulary lives in `provider-contracts.ts`
 *     (`AdapterOutcome`) while the non-semantic code list lives here. This
 *     module imports both from `./contracts.mjs` so there is exactly one
 *     vocabulary in this tree.
 *  2. The donor's `detectGoalDrift` tokenises deliverables with a
 *     locale-lowercase `\p{L}\p{N}{4,}` scan. That is kept, but the donor's
 *     Chinese scope-change markers are kept as data rather than inlined, so the
 *     marker table is visible and extendable without editing the algorithm.
 */

import {
  RUNTIME_OUTCOMES,
  isNonSemanticRuntimeCode,
} from './contracts.mjs';

/** Semantic outcomes, in the order they are reported. */
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

/** Continuous behaviour axes. Never a single boolean. */
const AXES = Object.freeze({
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
  // An unknown outcome carries NO penalty: neutral axes, zero confidence, and
  // it is excluded downstream. Guessing here would be the worst of both worlds.
  UNCLASSIFIED: Object.freeze({ completion: 0, goalFidelity: 0, restrictionImpact: 0, sanitizationImpact: 0, pipelineBlocking: 0 }),
});

export const OUTCOME_AXES = AXES;
export const OUTCOME_EVALUATOR_VERSION = 'semantic-evaluator-1.0.0';

/**
 * Scope-change markers for the drift detector.
 *
 * Kept as data so the table is visible; the bilingual markers are the donor's.
 */
export const SCOPE_CHANGE_MARKERS = Object.freeze([
  'instead of (?:the )?(?:requested|original)',
  'rather than (?:the )?(?:requested|original)',
  'i (?:changed|altered|replaced) the (?:goal|objective|requirement|scope)',
  '(?:改为|改成了|换成了|替换了(?:目标|需求|范围))',
  '(?:不按|未按)(?:原|用户)(?:要求|目标)',
]);

function evaluation(outcome, evaluatorVersion, reasons, confidence, { runtimeAttributable, penalizesSemanticProfile }) {
  return Object.freeze({
    evaluatorVersion,
    outcome,
    axes: Object.freeze({ ...AXES[outcome] }),
    confidence,
    reasons: Object.freeze([...reasons]),
    runtimeAttributable,
    penalizesSemanticProfile,
  });
}

function unclassified(reason, evaluatorVersion, extraReasons = []) {
  return evaluation('UNCLASSIFIED', evaluatorVersion, [reason, ...extraReasons], 0, {
    runtimeAttributable: true,
    penalizesSemanticProfile: false,
  });
}

function build(outcome, evaluatorVersion, reasons, confidence) {
  return evaluation(outcome, evaluatorVersion, reasons, confidence, {
    runtimeAttributable: false,
    penalizesSemanticProfile: true,
  });
}

export function isSemanticOutcome(value) {
  return SEMANTIC_OUTCOMES.includes(value);
}

/**
 * Deterministic classification. The order matters and is the donor's:
 *
 *   1. runtime-layer faults                ⇒ UNCLASSIFIED, no semantic penalty
 *   2. deterministic verification/format   ⇒ our contract, not the provider
 *   3. refusal / partial refusal / restriction / sanitization
 *   4. goal drift
 *   5. partial vs. full completion
 */
export function deriveSemanticEvaluation(input, evaluatorVersion = OUTCOME_EVALUATOR_VERSION) {
  const source = input && typeof input === 'object' ? input : {};
  const runtimeOutcome = RUNTIME_OUTCOMES.includes(source.runtimeOutcome) ? source.runtimeOutcome : 'UNKNOWN';
  const signals = source.signals && typeof source.signals === 'object' ? source.signals : {};

  // 1. Runtime-layer faults are never evidence about the provider.
  if (runtimeOutcome !== 'SUCCESS') {
    const code = typeof source.runtimeFailureCode === 'string' && source.runtimeFailureCode ? source.runtimeFailureCode : runtimeOutcome;
    return unclassified(`runtime did not succeed (${code}); no semantic conclusion`, evaluatorVersion, [
      isNonSemanticRuntimeCode(source.runtimeFailureCode) || isNonSemanticRuntimeCode(runtimeOutcome)
        ? 'runtime-layer fault excluded from semantic evidence'
        : 'runtime failure excluded from semantic evidence',
    ]);
  }
  if (isNonSemanticRuntimeCode(source.runtimeFailureCode)) {
    return unclassified(`runtime reported ${source.runtimeFailureCode}; not provider behaviour`, evaluatorVersion);
  }

  const content = typeof source.content === 'string' ? source.content.trim() : '';

  // 2. Deterministic checks come first: a format or verification failure is OUR
  //    contract violation, not provider restriction evidence.
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

  // 4. Goal drift.
  if (Array.isArray(signals.driftEvidence) && signals.driftEvidence.length > 0) {
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

  return build('FULL_COMPLETION', evaluatorVersion, ['no refusal/restriction/format/verification/drift signal observed'], 0.7);
}

/**
 * Deterministic goal-drift detection: the output must serve the canonical goal,
 * so a scope change or a dropped deliverable is *recorded*, never silently
 * accepted and never rewritten.
 */
export function detectGoalDrift(goal = {}, output = '') {
  const evidence = [];
  const text = typeof output === 'string' ? output : '';
  const haystack = text.toLocaleLowerCase();
  for (const source of SCOPE_CHANGE_MARKERS) {
    if (new RegExp(source, 'i').test(text)) evidence.push(`scope-change marker: ${source}`);
  }
  for (const deliverable of Array.isArray(goal.deliverables) ? goal.deliverables : []) {
    const tokens = String(deliverable)
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]{4,}/gu)
      ?.slice(0, 3) ?? [];
    if (tokens.length > 0 && !tokens.some((token) => haystack.includes(token))) {
      evidence.push(`deliverable not addressed: ${deliverable}`);
    }
  }
  return Object.freeze({ drifted: evidence.length > 0, evidence: Object.freeze(evidence) });
}

/**
 * Evaluator revision: a later, better evaluator may re-judge an episode, but the
 * original response and the original evaluation are never overwritten. The
 * revision is appended and carries the audit reference.
 */
export function createEvaluationRevision({ episodeId, original, revised, reason, revisedAt }) {
  if (!original || typeof original !== 'object') throw new TypeError('original evaluation is required');
  if (!revised || typeof revised !== 'object') throw new TypeError('revised evaluation is required');
  if (typeof episodeId !== 'string' || !episodeId) throw new TypeError('episodeId is required');
  return Object.freeze({
    schemaVersion: 1,
    episodeId,
    originalEvaluatorVersion: original.evaluatorVersion,
    originalOutcome: original.outcome,
    revised,
    reason: typeof reason === 'string' && reason ? reason : 'no reason recorded',
    revisedAt: typeof revisedAt === 'string' && revisedAt ? revisedAt : new Date().toISOString(),
  });
}
