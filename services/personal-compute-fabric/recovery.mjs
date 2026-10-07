// PCF-705: the recovery proposal. A proposal ONLY - the caller must re-authorize and obtain a new canonical fenced
// attempt. Nothing here restarts anything.
//
// The workbook's sub-task 2 names the checks that must be made before a recovery is even proposed: data location,
// executor/schema/model compatibility, target eligibility, consent, RETRY BUDGET and cooldown. Sub-task 3 adds the
// economics: a migration must be worth more than the transfer, the cold start and the work it discards, with hysteresis
// so two machines cannot trade the same task back and forth.
import {requireThat as ok, finite, freeze} from './validation.mjs';

/** The three costs a migration must beat. Each is a real measurement or it is UNKNOWN - never 0 by omission. */
export const MIGRATION_COSTS = Object.freeze(['transferMs', 'coldStartMs', 'discardedWorkMs']);
// A migration has to win by a margin, not by a rounding error, or the fleet oscillates between two hosts.
export const MIGRATION_HYSTERESIS_MS = 5000;

const attention = (workload, reason, extra = {}) => freeze({action: 'ATTENTION', reason, taskId: workload.taskId ?? null, ...extra});

/**
 * Is moving this work to another machine worth it?
 *
 * Unknown inputs are REFUSED rather than assumed: an unmeasured transfer cost is not a free transfer, and a missing
 * benefit is not a benefit. Every component is reported so the caller can see the arithmetic rather than trust a verdict.
 */
export function migrationBenefit({costs, benefitMs, hysteresisMs = MIGRATION_HYSTERESIS_MS} = {}) {
  ok(costs && typeof costs === 'object' && !Array.isArray(costs), 'MIGRATION_COSTS_REQUIRED');
  ok(finite(benefitMs), 'MIGRATION_BENEFIT_REQUIRED');
  ok(finite(hysteresisMs), 'MIGRATION_HYSTERESIS_REQUIRED');
  const missing = MIGRATION_COSTS.filter(name => !finite(costs[name]));
  if (missing.length) {
    return freeze({kind: 'MigrationBenefit', proposed: false, reason: 'MIGRATION_COST_UNKNOWN', costs: freeze({...costs}), benefitMs,
      totalCostMs: null, netMs: null, hysteresisMs, missing: freeze([...missing]), note: 'an unmeasured cost is not a free cost'});
  }
  const totalCostMs = MIGRATION_COSTS.reduce((sum, name) => sum + costs[name], 0);
  const netMs = benefitMs - totalCostMs;
  if (netMs <= hysteresisMs) {
    return freeze({kind: 'MigrationBenefit', proposed: false, reason: netMs <= 0 ? 'MIGRATION_BENEFIT_INSUFFICIENT' : 'MIGRATION_BENEFIT_BELOW_HYSTERESIS',
      costs: freeze({...costs}), benefitMs, totalCostMs, netMs, hysteresisMs, missing: freeze([]),
      note: netMs <= 0 ? 'the saving does not cover transfer, cold start and discarded work' : 'the saving is real but inside the hysteresis margin, so moving would risk oscillation'});
  }
  return freeze({kind: 'MigrationBenefit', proposed: true, reason: null, costs: freeze({...costs}), benefitMs, totalCostMs, netMs, hysteresisMs,
    missing: freeze([]), note: 'the saving covers the full cost with the hysteresis margin left over'});
}

/** The retry budget check: a per-task ceiling, because a task that keeps failing must not consume the fleet forever. */
function budgetCheck(workload, context) {
  const budget = context.retryBudget;
  if (budget === undefined || budget === null) return null;
  const used = budget.used ?? 0;
  if (!Number.isSafeInteger(budget.maxAttempts) || budget.maxAttempts < 1 || !Number.isSafeInteger(used) || used < 0) {
    return attention(workload, 'RETRY_BUDGET_INVALID', {budget: freeze({maxAttempts: budget.maxAttempts ?? null, used: budget.used ?? null})});
  }
  if (budget.maxAttempts - used <= 0) return attention(workload, 'RETRY_BUDGET_EXHAUSTED', {budget: freeze({maxAttempts: budget.maxAttempts, used, remaining: 0})});
  return freeze({maxAttempts: budget.maxAttempts, used, remaining: budget.maxAttempts - used});
}

/** The recovery proposal. Order matters: authority, stop proof, strict target, data location, budget, cooldown, class. */
export function planRecovery(workload, context) {
  if (context.authorized !== true) return attention(workload, 'AUTHORITY_REQUIRED');
  if (context.previousStopped !== true) return attention(workload, 'OLD_HOLDER_STOP_NOT_PROVEN');
  if (workload.strictTargetDeviceId && context.newDeviceId !== workload.strictTargetDeviceId) return attention(workload, 'STRICT_TARGET_NEW_APPROVAL_REQUIRED');
  // Data location is a hard input: recovering onto a device that cannot reach the inputs is not a recovery.
  if (context.dataLocationCompatible === false) return attention(workload, 'DATA_LOCATION_INCOMPATIBLE');
  const budget = budgetCheck(workload, context);
  if (budget?.action === 'ATTENTION') return budget;
  if (context.now < context.cooldownUntil) return freeze({action: 'WAIT', until: context.cooldownUntil, ...(budget ? {budget} : {})});
  // A migration to a DIFFERENT device must pay for itself, with hysteresis, before it is proposed at all. A workload
  // that declares no origin device is not "moving away from" anything, so there is no migration to price.
  const migrating = typeof workload.originDeviceId === 'string' && context.newDeviceId !== undefined && context.newDeviceId !== workload.originDeviceId;
  let migration = null;
  if (migrating) {
    ok(context.migration !== undefined, 'MIGRATION_BENEFIT_REQUIRED');
    migration = migrationBenefit(context.migration);
    if (!migration.proposed) return attention(workload, migration.reason, {migration});
  }
  const shared = {taskId: workload.taskId ?? null, newAttemptRequired: true, ...(budget ? {budget} : {}), ...(migration ? {migration} : {})};
  if (['PURE', 'IDEMPOTENT'].includes(workload.retryClass)) return freeze({action: 'RETRY', ...shared});
  if (workload.retryClass === 'CHECKPOINTABLE' && context.checkpointCompatible === true) return freeze({action: 'RESTORE', ...shared});
  // The refusal names the class AND which of the two reasons produced it, so a caller is not left guessing whether the
  // plan was asked to distinguish them.
  return attention(workload, 'SIDE_EFFECT_OR_COMPATIBILITY_UNKNOWN', {retryClass: workload.retryClass ?? null,
    distinguisher: workload.retryClass === 'NON_RETRYABLE' ? 'NON_RETRYABLE_BY_CLASS' : 'SIDE_EFFECT_UNKNOWN_BY_OBSERVATION'});
}
