/**
 * UTOPIA · City · Project Foreman — the public entry point.
 *
 * One call, one episode: give it a repository and a goal, and it establishes the
 * workspace, discovers the project, captures a baseline, plans bounded work,
 * executes it, verifies it with fresh evidence and reports what happened.
 *
 * This module is the *only* seam a host needs, and it is deliberately narrow so
 * that the runtime can be embedded anywhere — a shell, a CLI, a service, a test
 * harness — without the host knowing how the loop works. It also re-exports the
 * pieces a host may legitimately want to inspect (the phase vocabulary, the
 * failure classes, the adapters, the ladders) without exposing the mutable
 * internals of a running episode.
 *
 * Donor provenance: DS-Hns `app/engineering/index.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b, plus the Boss half of the Engineering
 * union where the mission is a union rather than a winner. See `DONOR.json`.
 *
 * @module project-foreman
 */

import { createEngineeringSupervisor, runEpisode, STEP_OUTCOMES, EPISODE_DEFAULTS } from './supervisor.mjs';
import { EPISODE_PHASES, EPISODE_TRANSITIONS, isTerminalPhase } from './episode.mjs';
import { FAILURE_CLASSES, CLASS_POLICY, classify } from './failure.mjs';
import { VERIFICATION_LEVELS } from './verifier.mjs';
import { PLAN_KINDS } from './plan.mjs';
import { WAKE_REASONS, deadlineState } from './scheduler.mjs';
import { OPERATIONS, CONFIDENCE, defaultAdapters } from './adapters.mjs';
import { verifyWorkspace, gitState, fingerprint, diffFingerprint } from './repository.mjs';
import { detectProject, discoverCommands, discover } from './discovery.mjs';
import { createCheckpointStore, verifyResume, truncateOutput, summarizeTestOutput } from './checkpoint.mjs';
import { createRecoveryStore, RECOVERY_INDEX_VERSION, RECOVERY_STATES } from './recovery-store.mjs';
import { computePlanDigest, validateRecoveryDescriptor, RECOVERY_DESCRIPTOR_VERSION, RECOVERY_PLAN_VERSION, EXECUTOR_COMPATIBILITY } from './recovery-schema.mjs';
import { createResultValidator, collectLeaks } from './result.mjs';
import { createMutationLog, MUTATION_RESULTS } from './mutation.mjs';
import { createProcessSupervisor, PROCESS_CLASS, READINESS } from './process.mjs';
import { createGitController } from './git.mjs';
import { createEpisodeContext } from './context.mjs';
import { createVerifier } from './verifier.mjs';
import { createCrossVolumeTempRegistry } from './cross-volume-cleanup.mjs';
import { createEngineeringAutonomy } from './autonomy.mjs';
import { createRepairTracker } from './failure.mjs';

/* --------------------------------------------------------------------- Boss union half */

/**
 * The Boss half of the union is imported through one seam rather than eagerly.
 *
 * Two of its modules exist today (`failure-recovery.mjs` from the §33 recovery
 * ladder, `ci-repair.mjs`, `correction.mjs`). A third — the requirements-driven
 * Execution DAG in `src/shared/execution-planner.ts` — is **not ported**, because
 * its `planExecution` consumes a Boss `RequirementsGraph` that this tree has no
 * producer for; porting it without that producer would mean inventing behaviour,
 * which MODE=MIGRATION_ONLY forbids. It is therefore declared here as a boundary
 * rather than faked: the union's DAG half is recorded as deferred in `DONOR.json`
 * and no re-export pretends otherwise.
 */
export { classifyFailure, planRecovery, advanceRecovery } from './failure-recovery.mjs';
export { parseCiFailure, classifyCiFailure, planCiRepair, ciVerdict, loopOutcome } from './ci-repair.mjs';
export { applyCorrections } from './correction.mjs';

/**
 * Run one engineering episode.
 *
 * @param {object} input
 * @param {string} input.workspace the repository the episode is confined to
 * @param {string} input.goal what the episode is for
 * @param {object} [input.contract] commands, tests, patches, policies and bounds
 * @param {number} [input.deadlineMs] how long the episode may run (default 24h)
 * @param {Function} [input.now]
 * @param {Function} [input.sleep]
 * @param {object} [input.processes] a shared process registry
 * @param {Function} [input.log]
 * @returns {Promise<object>} the episode report
 */
export function run(input = {}) {
  return runEpisode(input);
}

export {
  createEngineeringSupervisor,
  runEpisode,
  /** The vocabularies a host may switch on. */
  EPISODE_PHASES,
  EPISODE_TRANSITIONS,
  FAILURE_CLASSES,
  CLASS_POLICY,
  VERIFICATION_LEVELS,
  PLAN_KINDS,
  WAKE_REASONS,
  OPERATIONS,
  CONFIDENCE,
  PROCESS_CLASS,
  READINESS,
  MUTATION_RESULTS,
  STEP_OUTCOMES,
  EPISODE_DEFAULTS,
  /** The read-only inspectors and helpers. */
  isTerminalPhase,
  classify,
  deadlineState,
  defaultAdapters,
  verifyWorkspace,
  gitState,
  fingerprint,
  diffFingerprint,
  detectProject,
  discoverCommands,
  discover,
  createCheckpointStore,
  verifyResume,
  truncateOutput,
  summarizeTestOutput,
  createRecoveryStore,
  RECOVERY_INDEX_VERSION,
  RECOVERY_STATES,
  computePlanDigest,
  validateRecoveryDescriptor,
  RECOVERY_DESCRIPTOR_VERSION,
  RECOVERY_PLAN_VERSION,
  EXECUTOR_COMPATIBILITY,
  createResultValidator,
  collectLeaks,
  createMutationLog,
  createProcessSupervisor,
  createGitController,
  createEpisodeContext,
  createVerifier,
  createCrossVolumeTempRegistry,
  createEngineeringAutonomy,
  createRepairTracker,
};
