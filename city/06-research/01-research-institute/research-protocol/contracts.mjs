/**
 * UTOPIA · Research Institute — research protocol contracts.
 *
 * The frozen vocabularies and value shapes a research run is described with,
 * expressed as copy-on-construct factories plus strict validators. Nothing here is a
 * runtime: there is no supervisor, no scheduler, no experiment runner and no model
 * caller, because a protocol must be readable, years later, without the machinery
 * that produced it.
 *
 * Ported from the Codex-Boss donor `src/shared/research-ir.ts`,
 * `src/shared/research-protocol.ts`, `src/shared/research-contract.ts`,
 * `src/shared/research-roles.ts` and `src/shared/research-command.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * Every version constant, ordering and member is the donor's. A vocabulary is a
 * frozen array in the donor's declaration order; a factory validates and then copies
 * — it never repairs invalid input into valid input, so validation is the single gate
 * and a rejected value is rejected for the donor's reason and no other.
 *
 * Vocabulary:
 *   ResearchState           the run's position: main flow, then the control states
 *   ResearchIR              goal + scope + state + the frozen protocol hash
 *   ResearchProtocol        the scientific core and the mechanical fields
 *   ProtocolAmendment       one approved change to a frozen protocol
 *   ResearchContract        the anchor a paper may not rewrite
 *   ResearchCommandSpec     one spawn(executable, args), never a shell string
 *   BaselineProvenance      why a baseline number is what it is
 */

/* ------------------------------------------- research states (research-ir.ts) */

/** The main flow, in the plan's order (research-ir.ts RESEARCH_MAIN_STATES). */
export const RESEARCH_MAIN_STATES = Object.freeze([
  'SCOPING', 'PROJECT_INSPECTION', 'LITERATURE_REVIEW', 'QUESTION_FORMULATION',
  'PROTOCOL_DRAFT', 'PROTOCOL_FROZEN', 'EXPERIMENT_GENERATION', 'EXPERIMENT_EXECUTION',
  'ANALYSIS', 'REPLICATION', 'CLAIM_REVIEW', 'MANUSCRIPT', 'CITATION_AUDIT', 'REPRO_AUDIT', 'BUILD', 'READY',
]);

/** The control states that live beside the main flow, in the donor's order. */
export const RESEARCH_CONTROL_STATES = Object.freeze(['RECOVERING', 'WAITING_FOR_PROVIDER', 'WAITING_FOR_USER', 'FAILED']);

/** The full state vocabulary: the main flow, then the control states. */
export const RESEARCH_STATES = Object.freeze([...RESEARCH_MAIN_STATES, ...RESEARCH_CONTROL_STATES]);

/** How much the run may decide on its own. */
export const AUTONOMY_MODES = Object.freeze(['AUTOPILOT', 'GUIDED']);

/** Whether the Boss may switch providers away from the declared reviewer set. */
export const PROVIDER_POLICIES = Object.freeze(['AUTO', 'FIXED']);

/* --------------------------------------- protocol fields (research-protocol.ts) */

/** Mechanical fields that may be auto-fixed after freeze, still recorded. */
export const AUTO_FIXABLE_FIELDS = Object.freeze(['syntax', 'path', 'environment', 'package', 'runtime-error']);

/** Scientific fields that must not change silently after freeze. */
export const FROZEN_FIELDS = Object.freeze(['hypothesis', 'primary-metric', 'baseline', 'sample-definition', 'exclusion-rule', 'evaluation-criterion']);

/** Where the provenance of a baseline number may come from. */
export const BASELINE_PROVENANCE_KINDS = Object.freeze([
  'known-benchmark', 'control-implementation', 'random-chance',
  'previous-system', 'ablation', 'literature', 'implementation-declared', 'host-heuristic',
]);

/** The provenance kinds an implementation may DECLARE (host-heuristic is host-only). */
export const DECLARABLE_BASELINE_SOURCES = Object.freeze([
  'known-benchmark', 'control-implementation', 'random-chance',
  'previous-system', 'ablation', 'literature', 'implementation-declared',
]);

/* ------------------------------------ research contract (research-contract.ts) */

/** Citation policies a contract may freeze. */
export const CITATION_POLICIES = Object.freeze(['strict-verbatim', 'strict-summary', 'manual']);

/* ---------------------------------------- research roles (research-roles.ts) */

/** The research roles a stage can route to. */
export const RESEARCH_ROLE_NAMES = Object.freeze(['literature', 'planner', 'experiment', 'coder', 'analyst', 'reviewer', 'reporter']);

/** The typed artifact kinds a stage may emit (evidence > prose). */
export const RESEARCH_ARTIFACT_KINDS = Object.freeze([
  'repo-scan', 'literature-notes', 'research-question', 'protocol', 'experiment-design',
  'experiment-run', 'statistic', 'analysis', 'claim', 'manuscript-section', 'citation-audit',
  'repro-audit', 'build-artifact',
]);

/* -------------------------------------- research command (research-command.ts) */

/** Purposes a research command may declare. */
export const RESEARCH_PURPOSES = Object.freeze(['EXPERIMENT', 'ANALYSIS', 'TEST', 'BUILD', 'DATA_PROCESSING']);

/** Executable families a research run may spawn (base names), in the donor's order. */
export const ALLOWED_EXECUTABLES = Object.freeze(['python', 'python3', 'py', 'node', 'npm', 'pnpm', 'git', 'pytest', 'tsx', 'npx', 'electron']);

/* ------------------------------------------------------------ value shapes */

/**
 * Validate and copy a research budget. `maxProviderCalls` / `maxRuntimeMinutes` are
 * optional and are carried through untouched: the donor does not judge them.
 *
 * @throws {Error} "Invalid research budget"
 */
export function researchBudget(budget) {
  if (
    !budget
    || !Number.isInteger(budget.maxExperiments) || budget.maxExperiments < 1
    || !Number.isInteger(budget.maxSteps) || budget.maxSteps < 1
  ) throw new Error('Invalid research budget');
  const out = { maxExperiments: budget.maxExperiments, maxSteps: budget.maxSteps };
  if (budget.maxProviderCalls !== undefined) out.maxProviderCalls = budget.maxProviderCalls;
  if (budget.maxRuntimeMinutes !== undefined) out.maxRuntimeMinutes = budget.maxRuntimeMinutes;
  return out;
}

/**
 * Validate and copy a research scope.
 *
 * @throws {Error} "Research requires a workspace" | "Invalid allowedDomains"
 *                 | "Research requires 1–5 reviewers" | "Invalid autonomy mode"
 *                 | "Invalid research budget"
 */
export function researchScope(scope) {
  if (!scope || typeof scope.workspace !== 'string' || !scope.workspace.trim()) throw new Error('Research requires a workspace');
  if (!Array.isArray(scope.allowedDomains) || scope.allowedDomains.length > 50) throw new Error('Invalid allowedDomains');
  if (!Array.isArray(scope.reviewers) || scope.reviewers.length < 1 || scope.reviewers.length > 5) throw new Error('Research requires 1–5 reviewers');
  if (!AUTONOMY_MODES.includes(scope.autonomy)) throw new Error('Invalid autonomy mode');
  const out = {
    workspace: scope.workspace,
    allowedDomains: [...scope.allowedDomains],
    reviewers: [...scope.reviewers],
    autonomy: scope.autonomy,
    budget: researchBudget(scope.budget),
  };
  if (scope.providerPolicy !== undefined) out.providerPolicy = scope.providerPolicy;
  return out;
}

/**
 * Validate and copy a research IR.
 *
 * @throws {Error} "Invalid research IR id" | "Research goal must be 1–20000
 *                 characters" | the scope errors | "Invalid research state"
 *                 | "Invalid pending research stage"
 */
export function researchIR(ir) {
  if (!ir || ir.schemaVersion !== 1 || typeof ir.id !== 'string' || !ir.id.trim()) throw new Error('Invalid research IR id');
  if (typeof ir.goal !== 'string' || !ir.goal.trim() || ir.goal.length > 20000) throw new Error('Research goal must be 1–20000 characters');
  const scope = researchScope(ir.scope);
  if (!RESEARCH_STATES.includes(ir.state)) throw new Error('Invalid research state');
  if (ir.pendingStage !== undefined && !RESEARCH_MAIN_STATES.includes(ir.pendingStage)) throw new Error('Invalid pending research stage');
  const out = {
    schemaVersion: 1,
    id: ir.id,
    goal: ir.goal,
    scope,
    state: ir.state,
  };
  if (ir.pendingStage !== undefined) out.pendingStage = ir.pendingStage;
  if (ir.protocolHash !== undefined) out.protocolHash = ir.protocolHash;
  out.researchQuestions = Array.isArray(ir.researchQuestions) ? [...ir.researchQuestions] : [];
  out.hypotheses = Array.isArray(ir.hypotheses) ? [...ir.hypotheses] : [];
  out.createdAt = ir.createdAt;
  out.updatedAt = ir.updatedAt;
  return out;
}

/**
 * Validate and copy a research protocol.
 *
 * @throws {Error} "Research protocol must be an object" | "Research protocol <field>
 *                 must be a string"
 */
export function researchProtocol(protocol) {
  if (protocol === null || typeof protocol !== 'object' || Array.isArray(protocol)) throw new Error('Research protocol must be an object');
  const scientific = {
    hypothesis: protocol.hypothesis,
    primaryMetric: protocol.primaryMetric,
    baseline: protocol.baseline,
    sampleDefinition: protocol.sampleDefinition,
    evaluationCriterion: protocol.evaluationCriterion,
  };
  for (const [field, value] of Object.entries(scientific)) {
    if (typeof value !== 'string') throw new Error(`Research protocol ${field} must be a string`);
  }
  const out = {
    schemaVersion: 1,
    hypothesis: protocol.hypothesis,
    primaryMetric: protocol.primaryMetric,
    baseline: protocol.baseline,
    sampleDefinition: protocol.sampleDefinition,
  };
  if (protocol.exclusionRule !== undefined) out.exclusionRule = protocol.exclusionRule;
  out.evaluationCriterion = protocol.evaluationCriterion;
  if (protocol.syntax !== undefined) out.syntax = protocol.syntax;
  if (protocol.environment !== undefined) out.environment = protocol.environment;
  out.createdAt = protocol.createdAt;
  return out;
}

/**
 * Validate and copy a protocol amendment.
 *
 * @throws {Error} "Amendment requires an id" | "Amendment requires the frozen
 *                 protocol hash" | "Amendment requires changes" | "Amendment touches
 *                 non-frozen field: <field>" | "Amendment change requires a reason"
 */
export function protocolAmendment(amendment) {
  if (!amendment || typeof amendment.id !== 'string' || !amendment.id) throw new Error('Amendment requires an id');
  if (typeof amendment.protocolHash !== 'string' || !amendment.protocolHash) throw new Error('Amendment requires the frozen protocol hash');
  if (!Array.isArray(amendment.changes) || amendment.changes.length < 1) throw new Error('Amendment requires changes');
  const changes = [];
  for (const change of amendment.changes) {
    if (!FROZEN_FIELDS.includes(change.field)) throw new Error(`Amendment touches non-frozen field: ${change.field}`);
    if (typeof change.reason !== 'string' || !change.reason.trim()) throw new Error('Amendment change requires a reason');
    changes.push({ field: change.field, before: change.before, after: change.after, reason: change.reason });
  }
  return { id: amendment.id, protocolHash: amendment.protocolHash, changes, approved: amendment.approved, createdAt: amendment.createdAt };
}

/**
 * Validate and copy a research contract.
 *
 * @throws {Error} for a non-object contract, a missing research question / hypotheses
 *                 / claims / experiment plan / evaluation criterion / sections /
 *                 acceptance gates, or an invalid citation policy
 */
export function researchContract(contract) {
  if (contract === null || typeof contract !== 'object' || Array.isArray(contract)) throw new Error('Research contract must be an object');
  if (typeof contract.researchQuestion !== 'string') throw new Error('Research contract requires a research question');
  if (!Array.isArray(contract.hypotheses)) throw new Error('Research contract requires hypotheses');
  if (!Array.isArray(contract.claims)) throw new Error('Research contract requires claims');
  if (!contract.experimentPlan || typeof contract.experimentPlan !== 'object' || Array.isArray(contract.experimentPlan)) throw new Error('Research contract requires an experiment plan');
  if (typeof contract.evaluationCriterion !== 'string') throw new Error('Research contract requires an evaluation criterion');
  if (!CITATION_POLICIES.includes(contract.citationPolicy)) throw new Error('Invalid citation policy');
  if (!Array.isArray(contract.sections)) throw new Error('Research contract requires sections');
  if (!Array.isArray(contract.acceptanceGates)) throw new Error('Research contract requires acceptance gates');
  return {
    researchQuestion: contract.researchQuestion,
    hypotheses: [...contract.hypotheses],
    claims: contract.claims,
    experimentPlan: {
      runsPerHypothesis: contract.experimentPlan.runsPerHypothesis,
      metric: contract.experimentPlan.metric,
      baseline: contract.experimentPlan.baseline,
    },
    evaluationCriterion: contract.evaluationCriterion,
    citationPolicy: contract.citationPolicy,
    sections: [...contract.sections],
    acceptanceGates: [...contract.acceptanceGates],
    frozenAt: contract.frozenAt,
  };
}

/**
 * Validate and copy a research command spec.
 *
 * @throws {Error} "Research command requires an executable" | "Research executable
 *                 must be a bare path/name (no shell metacharacters)" | "Invalid
 *                 research args" | "Research command requires a cwd" | "Invalid
 *                 research purpose" | "Invalid research timeout" | "Invalid expected
 *                 outputs"
 */
export function researchCommandSpec(spec) {
  if (!spec || typeof spec.executable !== 'string' || !spec.executable.trim()) throw new Error('Research command requires an executable');
  if (/\s|[\r\n]/.test(spec.executable)) throw new Error('Research executable must be a bare path/name (no shell metacharacters)');
  if (!Array.isArray(spec.args) || spec.args.length > 100 || spec.args.some((arg) => typeof arg !== 'string' || arg.length > 4000)) throw new Error('Invalid research args');
  if (typeof spec.cwd !== 'string' || !spec.cwd.trim()) throw new Error('Research command requires a cwd');
  if (!RESEARCH_PURPOSES.includes(spec.purpose)) throw new Error('Invalid research purpose');
  if (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 1000 || spec.timeoutMs > 3600000) throw new Error('Invalid research timeout');
  if (spec.expectedOutputs && (spec.expectedOutputs.length > 20 || spec.expectedOutputs.some((marker) => typeof marker !== 'string' || !marker || marker.length > 500))) throw new Error('Invalid expected outputs');
  const out = {
    executable: spec.executable,
    args: [...spec.args],
    cwd: spec.cwd,
    purpose: spec.purpose,
    timeoutMs: spec.timeoutMs,
  };
  if (spec.expectedOutputs !== undefined) out.expectedOutputs = [...spec.expectedOutputs];
  if (spec.environment !== undefined) out.environment = spec.environment;
  return out;
}
