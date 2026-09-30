/**
 * UTOPIA · Research Institute — research capability registry.
 *
 * A research run must not mechanically invoke every manuscript/analysis module for
 * every study. Each capability (module) is declared with the questions it answers
 * and when it is needed; a deterministic planner marks each capability
 * AVAILABLE / NEEDED / NOT_NEEDED / FAILED for a given run so only required modules
 * are called, and the audit records which modules actually ran.
 *
 * Ported from the Codex-Boss donor `src/shared/research-capability-registry.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * The rules that must never be softened:
 *   - the plan always carries every registered capability id, in registry order;
 *   - a capability is NEEDED exactly when its trigger matches the profile, and
 *     NOT_NEEDED otherwise — the plan never guesses AVAILABLE, and no capability is
 *     ever skipped out of the record;
 *   - the always-on capabilities are literature-scout, section-planner,
 *     section-writer, skeptical-reviewer and latex-compiler;
 *   - the donor's asymmetry is kept: `bindsCitations` and
 *     `hasFormalProtocol`/`hasQuantitativeExperiments` are truthiness tests, while
 *     `architecture-diagram-builder` is a `Boolean(...)` test and
 *     `evidence-adjudicator`'s `hasMultipleReviewers` is a strict `=== true` test;
 *   - an unknown status is refused rather than coerced.
 *
 * The donor's `ResearchCapabilityRunRow` interface declares a row with its final
 * execution outcome; it holds no behaviour and is not reproduced here.
 */

import {
  RESEARCH_CAPABILITIES,
  RESEARCH_CAPABILITY_IDS,
  RESEARCH_CAPABILITY_STATUSES,
  isResearchCapabilityStatus,
} from './contracts.mjs';

export { isResearchCapabilityStatus };

/**
 * Deterministic NEEDED/NOT_NEEDED plan over the capability registry. The host
 * decides what a study needs; a capability is NEEDED when its trigger matches the
 * profile and NOT_NEEDED otherwise. This registry is the audit + guard-rail
 * surface: only-needed invocation, never a shotgun.
 */
export function planResearchCapabilities(profile) {
  const plan = Object.fromEntries(RESEARCH_CAPABILITY_IDS.map((id) => [id, 'AVAILABLE']));
  const need = (id, condition) => { plan[id] = condition ? 'NEEDED' : 'NOT_NEEDED'; };
  need('literature-scout', true); // contextual background is always scouted
  need('citation-verifier', profile.bindsCitations);
  need('methodology-critic', profile.hasFormalProtocol || profile.hasQuantitativeExperiments);
  need('experiment-designer', profile.hasQuantitativeExperiments);
  need('statistics-engine', profile.hasQuantitativeExperiments);
  need('replication-runner', profile.hasQuantitativeExperiments);
  need('figure-planner', profile.hasQuantitativeExperiments);
  need('chart-renderer', profile.hasQuantitativeExperiments);
  need('table-builder', profile.hasQuantitativeExperiments);
  need('architecture-diagram-builder', Boolean(profile.hasArchitecture));
  need('evidence-adjudicator', profile.hasMultipleReviewers === true || profile.hasQuantitativeExperiments);
  need('section-planner', true); // any manuscript needs an outline
  need('section-writer', true);
  need('skeptical-reviewer', true);
  need('reproducibility-auditor', profile.hasQuantitativeExperiments);
  need('latex-compiler', true);
  return plan;
}

/**
 * The registry rows are exposed so a host can render the audit and a test can pin
 * them; they are the donor's frozen vocabulary, in the donor's order.
 */
export { RESEARCH_CAPABILITIES, RESEARCH_CAPABILITY_IDS, RESEARCH_CAPABILITY_STATUSES };
