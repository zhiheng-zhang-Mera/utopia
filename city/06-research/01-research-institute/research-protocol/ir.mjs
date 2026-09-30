/**
 * UTOPIA · Research Institute — research IR + state machine.
 *
 * The supervisor drives a research run through the plan's state list
 * (SCOPING → … → READY) with the control states RECOVERING /
 * WAITING_FOR_PROVIDER / WAITING_FOR_USER / FAILED. This module owns the states,
 * the deterministic transition graph and the validated ResearchIR (goal + workspace
 * + reviewer policy) that the protocol freeze has a schema to live on.
 *
 * Ported from the Codex-Boss donor `src/shared/research-ir.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. Pure: no clock, no fs, no network, no
 * randomness — the successor of a state is a lookup, never a decision.
 *
 * Rules that must not be softened:
 *   - READY and FAILED have no successor at all, and a control state has none unless
 *     the caller explicitly allows control transitions;
 *   - a pending stage must be a MAIN stage: the run resumes into work, never into
 *     another control state;
 *   - the validation gate is `researchIR` (contracts.mjs); nothing here repairs an
 *     invalid IR.
 */

import { RESEARCH_MAIN_STATES, researchIR } from './contracts.mjs';

export { RESEARCH_MAIN_STATES, RESEARCH_STATES, researchIR } from './contracts.mjs';

/** Main-flow successors in the plan order. */
export const RESEARCH_NEXT = Object.freeze({
  SCOPING: 'PROJECT_INSPECTION',
  PROJECT_INSPECTION: 'LITERATURE_REVIEW',
  LITERATURE_REVIEW: 'QUESTION_FORMULATION',
  QUESTION_FORMULATION: 'PROTOCOL_DRAFT',
  PROTOCOL_DRAFT: 'PROTOCOL_FROZEN',
  PROTOCOL_FROZEN: 'EXPERIMENT_GENERATION',
  EXPERIMENT_GENERATION: 'EXPERIMENT_EXECUTION',
  EXPERIMENT_EXECUTION: 'ANALYSIS',
  ANALYSIS: 'REPLICATION',
  REPLICATION: 'CLAIM_REVIEW',
  CLAIM_REVIEW: 'MANUSCRIPT',
  MANUSCRIPT: 'CITATION_AUDIT',
  CITATION_AUDIT: 'REPRO_AUDIT',
  REPRO_AUDIT: 'BUILD',
  BUILD: 'READY',
  READY: 'READY',
  RECOVERING: 'SCOPING',
  WAITING_FOR_PROVIDER: 'SCOPING',
  WAITING_FOR_USER: 'SCOPING',
  FAILED: 'FAILED',
});

export function canAdvance(state) {
  return state !== 'FAILED' && state !== 'READY' && state !== 'WAITING_FOR_PROVIDER' && state !== 'WAITING_FOR_USER';
}

/**
 * Validate a research IR. The single gate: every refusal carries the donor's exact
 * message.
 *
 * @throws {Error} see `researchIR` (contracts.mjs)
 */
export function validateResearchIR(ir) {
  researchIR(ir);
}

/** Deterministic successor: control states return to SCOPING on resume unless FAILED/READY. */
export function nextResearchState(current, allowControl = false) {
  if (current === 'FAILED' || current === 'READY') return null;
  if (!allowControl && ['RECOVERING', 'WAITING_FOR_PROVIDER', 'WAITING_FOR_USER'].includes(current)) return null;
  return RESEARCH_NEXT[current];
}
