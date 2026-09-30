/**
 * UTOPIA · Research Institute — research protocol module.
 *
 * One export site for the frozen research vocabularies, the validated research IR
 * state machine, the protocol freeze + amendment rules, the research contract and its
 * sufficiency gate, the stage → role/artifact router, and the structured research
 * command spec.
 *
 * Ported from the Codex-Boss donor `src/shared/research-ir.ts`,
 * `src/shared/research-protocol.ts`, `src/shared/research-contract.ts`,
 * `src/shared/research-roles.ts` and `src/shared/research-command.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * This module is pure and self-contained: no fs, no network, no clock, no randomness,
 * no process environment, and no import outside this directory. A digest, a clock
 * and an id are always parameters (see `./ir.mjs`, `./protocol.mjs`, `./roles.mjs`).
 */

export {
  ALLOWED_EXECUTABLES,
  AUTO_FIXABLE_FIELDS,
  AUTONOMY_MODES,
  BASELINE_PROVENANCE_KINDS,
  CITATION_POLICIES,
  DECLARABLE_BASELINE_SOURCES,
  FROZEN_FIELDS,
  PROVIDER_POLICIES,
  RESEARCH_ARTIFACT_KINDS,
  RESEARCH_CONTROL_STATES,
  RESEARCH_MAIN_STATES,
  RESEARCH_PURPOSES,
  RESEARCH_ROLE_NAMES,
  RESEARCH_STATES,
  protocolAmendment,
  researchBudget,
  researchCommandSpec,
  researchContract,
  researchIR,
  researchProtocol,
  researchScope,
} from './contracts.mjs';

export {
  RESEARCH_NEXT,
  canAdvance,
  nextResearchState,
  validateResearchIR,
} from './ir.mjs';

export {
  canonicalStableProtocol,
  diffProtocol,
  hashProtocol,
  inferBaselineProvenance,
  scientificCore,
  validateAmendment,
} from './protocol.mjs';

export {
  expandSectionPromptsFromContract,
  sufficiencyAudit,
  violatesContract,
} from './contract.mjs';

export {
  artifactKindForStage,
  roleForStage,
  stageArtifact,
} from './roles.mjs';

export {
  executableAllowed,
  validateCommandSpec,
} from './command.mjs';
