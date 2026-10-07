// PCF-702 (placement half): feasibility first, ranking second, and a proposal that explains itself.
//
// The workbook's order is not cosmetic. A candidate is filtered for trust, authorisation, data scope, strict target,
// platform, capability, observation freshness, isolation capability and hard resource demand BEFORE anything is
// ranked, because ranking an infeasible machine is how "the fastest node" wins a job it is not allowed to run. An
// unknown hard requirement is refused under its own name - it is neither 0 nor sufficient, and it is not guessed.
//
// The proposal is a PlacementProposal: a frozen, versioned record of the winner, every feasible candidate with the
// key it was ranked on, the sanitised rejection reason of everything else, the ranking rule that was used, the
// policy/state/observation refs it was computed from, and the expiry it is valid until. It is the ONLY thing this
// module produces, and 704 admission is its only consumer.
import {assertPolicy} from './policy.mjs';
import {describeExecutorBoundary} from './executor-provider.mjs';
import {estimateCost, COST_COMPONENTS} from './cost-model.mjs';
import {finite, freeze} from './validation.mjs';

export const PLACEMENT_PROPOSAL_VERSION = 1;
export const PLACEMENT_STRATEGIES = Object.freeze(['FIXED', 'CAPABILITY', 'LOAD', 'COMPOSITE']);
export const FEASIBILITY_REFUSALS = Object.freeze({
  NOT_AUTHORIZED: 'EXECUTOR_NOT_AUTHORIZED_OR_READY',
  STRICT_TARGET: 'STRICT_TARGET',
  PLATFORM: 'PLATFORM',
  STALE_OBSERVATION: 'REMEASURE',
  CAPABILITY: 'CAPABILITY',
  ISOLATION: 'ISOLATION',
  RESOURCE_UNKNOWN: 'RESOURCE_UNKNOWN',
  RESOURCE_INSUFFICIENT: 'RESOURCE_INSUFFICIENT',
  FIXED_PRIORITY_UNDECLARED: 'FIXED_PRIORITY_UNDECLARED',
  COST_INCOMPLETE: 'COST_INCOMPLETE',
  COST_UNKNOWN: 'COST_UNKNOWN',
});
export const CANDIDATE_LIMIT = 128;
// What the caller has to do about a refusal. It is a distinct field so a UI cannot present "unknown" as "broken".
const REMEDY = Object.freeze({
  [FEASIBILITY_REFUSALS.NOT_AUTHORIZED]: 'REQUEST_AUTHORISATION',
  [FEASIBILITY_REFUSALS.STRICT_TARGET]: 'NONE',
  [FEASIBILITY_REFUSALS.PLATFORM]: 'NONE',
  [FEASIBILITY_REFUSALS.STALE_OBSERVATION]: 'REMEASURE_REQUIRED',
  [FEASIBILITY_REFUSALS.CAPABILITY]: 'NONE',
  [FEASIBILITY_REFUSALS.ISOLATION]: 'NONE',
  [FEASIBILITY_REFUSALS.RESOURCE_UNKNOWN]: 'REMEASURE_REQUIRED',
  [FEASIBILITY_REFUSALS.RESOURCE_INSUFFICIENT]: 'NONE',
  [FEASIBILITY_REFUSALS.FIXED_PRIORITY_UNDECLARED]: 'DECLARE_PRIORITY',
  [FEASIBILITY_REFUSALS.COST_INCOMPLETE]: 'REMEASURE_REQUIRED',
  [FEASIBILITY_REFUSALS.COST_UNKNOWN]: 'REMEASURE_REQUIRED',
  // The policy module's own refusal codes pass through unchanged; each one is answered by an authorisation, never by
  // a retry, so they are named here rather than flattened into "unknown failure".
  AUTHORITY_EXPIRED_OR_REVOKED: 'REQUEST_AUTHORISATION',
  DEVICE_NOT_APPROVED: 'REQUEST_AUTHORISATION',
  SCOPE_NOT_APPROVED: 'REQUEST_AUTHORISATION',
  SHARING_NOT_APPROVED: 'REQUEST_AUTHORISATION',
  BUDGET_NOT_APPROVED: 'REQUEST_AUTHORISATION',
  CLOUD_NOT_APPROVED: 'REQUEST_AUTHORISATION',
});
const RANKING_RULE = Object.freeze({
  FIXED: 'DECLARED_PRIORITY_ASC_THEN_LOCAL_FIRST_THEN_DEVICE_ID',
  CAPABILITY: 'NO_NUMERIC_FIT_LOCAL_FIRST_THEN_DEVICE_ID',
  LOAD: 'QUEUE_MS_ASC_LOCAL_FIRST_THEN_DEVICE_ID',
  COMPOSITE: 'COST_RANKING_BOUND_ASC_LOCAL_FIRST_THEN_DEVICE_ID',
});

/**
 * The feasibility gate. Returns null when the candidate may be RANKED, or the name of the refusal otherwise.
 * Every check is a declared fact about the candidate; nothing is inferred from "the device is online".
 */
export function feasibility(workload, candidate, policy, now) {
  try { assertPolicy(policy, {deviceId: candidate.deviceId, dataScope: workload.dataScope, fee: candidate.fee ?? 0, cloud: candidate.cloud ?? false}, now); }
  catch (error) { return error.code ?? 'POLICY_REFUSED'; }
  if (!candidate.trusted || !candidate.authorized || !candidate.executorReady || !candidate.sharing) return FEASIBILITY_REFUSALS.NOT_AUTHORIZED;
  if (workload.strictTargetDeviceId && workload.strictTargetDeviceId !== candidate.deviceId) return FEASIBILITY_REFUSALS.STRICT_TARGET;
  if (workload.platform && workload.platform !== candidate.platform) return FEASIBILITY_REFUSALS.PLATFORM;
  // Freshness is a hard requirement: an observation that is stale, future-dated or unversioned is re-measured.
  if (!finite(candidate.observedAt) || candidate.observedAt > now || !finite(candidate.validUntil) || now >= candidate.validUntil || !Number.isSafeInteger(candidate.observationVersion)) return FEASIBILITY_REFUSALS.STALE_OBSERVATION;
  if (!candidate.provider?.ready || !workload.capabilities.every(name => candidate.provider.capabilities?.includes(name)) || !candidate.provider.workloadKinds?.includes(workload.kind)) return FEASIBILITY_REFUSALS.CAPABILITY;
  if (workload.requireHardIsolation) { try { describeExecutorBoundary(candidate.provider, {requireHardIsolation: true}); } catch { return FEASIBILITY_REFUSALS.ISOLATION; } }
  for (const [name, need] of Object.entries(workload.resources ?? {})) {
    // A demand that is not a measured number cannot be checked, so it is UNKNOWN - not insufficient, and certainly
    // not satisfied. The same holds for a resource the candidate never reported.
    if (!finite(need) || !finite(candidate.free?.[name])) return FEASIBILITY_REFUSALS.RESOURCE_UNKNOWN;
    if (candidate.free[name] < need) return FEASIBILITY_REFUSALS.RESOURCE_INSUFFICIENT;
  }
  return null;
}

/** FIXED ordering needs a DECLARED priority; there is no honest way to invent one, so an undeclared one is refused. */
function declaredPriority(workload, candidate) {
  const order = Array.isArray(workload.fixedPriority) ? workload.fixedPriority.indexOf(candidate.deviceId) : -1;
  if (order >= 0) return order;
  if (Number.isSafeInteger(candidate.priority) && candidate.priority >= 0) return candidate.priority;
  return null;
}

const reason = (candidate, code, extra = {}) => freeze({deviceId: candidate.deviceId, code, remedy: REMEDY[code] ?? 'NONE', ...extra});

/**
 * Produce a PlacementProposal. Pure: the same workload, candidates, policy and clock produce the same proposal,
 * byte for byte, because the tie-break is the device identity and no candidate order is trusted.
 */
export function planPlacement(workload, candidates, policy, now, {strategy = 'COMPOSITE', limit = 32, stateRef = null} = {}) {
  if (!PLACEMENT_STRATEGIES.includes(strategy) || !Number.isInteger(limit) || limit < 1 || limit > CANDIDATE_LIMIT) throw new RangeError('PLACEMENT_OPTIONS');
  if (!Array.isArray(candidates) || candidates.length > CANDIDATE_LIMIT) throw new RangeError('CANDIDATE_LIMIT');
  const refused = [];
  const eligible = [];
  for (const candidate of candidates) {
    const code = feasibility(workload, candidate, policy, now);
    if (code) { refused.push(reason(candidate, code)); continue; }
    if (strategy === 'FIXED' && declaredPriority(workload, candidate) === null) { refused.push(reason(candidate, FEASIBILITY_REFUSALS.FIXED_PRIORITY_UNDECLARED)); continue; }
    const cost = estimateCost(candidate);
    if (strategy === 'COMPOSITE' && cost.state === 'UNKNOWN') {
      refused.push(reason(candidate, cost.missing.length === COST_COMPONENTS.length ? FEASIBILITY_REFUSALS.COST_UNKNOWN : FEASIBILITY_REFUSALS.COST_INCOMPLETE, {missing: cost.missing}));
      continue;
    }
    eligible.push({candidate, cost});
  }
  const localFirst = candidate => candidate.deviceId === workload.originDeviceId ? 0 : 1;
  const keyOf = ({candidate, cost}) => strategy === 'FIXED' ? declaredPriority(workload, candidate)
    : strategy === 'LOAD' ? (finite(candidate.queueMs) ? candidate.queueMs : Infinity)
      : strategy === 'COMPOSITE' ? cost.rankingMs
        : 0;
  // Local-first is the default policy and outranks the strategy key; the device id is the stable tie-break, so the
  // result never depends on the order the candidates arrived in. FIXED is the one exception: an order the caller
  // declared explicitly is more specific than the default, so there it ranks first and local-first only breaks ties.
  eligible.sort((left, right) => (strategy === 'FIXED' ? keyOf(left) - keyOf(right) : 0)
    || localFirst(left.candidate) - localFirst(right.candidate)
    || keyOf(left) - keyOf(right)
    || left.candidate.deviceId.localeCompare(right.candidate.deviceId));
  const ranked = eligible.map((entry, index) => freeze({rank: index + 1, deviceId: entry.candidate.deviceId, bootId: entry.candidate.bootId,
    providerId: entry.candidate.provider?.id, observationVersion: entry.candidate.observationVersion, rankingKey: keyOf(entry),
    cost: entry.cost}));
  const winner = eligible[0] ?? null;
  const declared = [winner?.candidate.validUntil, policy?.expiresAt, workload?.deadlineAt].filter(finite);
  // No declared expiry stays null on purpose: 704 admission then refuses the proposal instead of running work forever.
  const validUntil = declared.length ? Math.min(...declared) : null;
  const common = freeze({kind: 'PlacementProposal', proposalVersion: PLACEMENT_PROPOSAL_VERSION, taskId: workload.taskId ?? null,
    actionId: workload.actionId ?? null, strategy, rankingRule: RANKING_RULE[strategy], computedAt: now,
    refs: freeze({policyRef: 'policy:' + policy?.version, stateRef: stateRef ?? null,
      observationRef: winner ? 'observation:' + winner.candidate.deviceId + '@' + winner.candidate.observationVersion : null,
      stateRefNote: stateRef === null ? 'placement is pure; canonical state is bound by 704 admission under CAS, not guessed here' : null}),
    expiry: freeze({validUntil, source: declared.length ? 'MIN_OF_CANDIDATE_VALIDITY_POLICY_EXPIRY_AND_WORKLOAD_DEADLINE' : 'UNDECLARED'}),
    policyVersion: policy?.version, feasible: freeze(ranked.slice(0, limit)), candidates: freeze(eligible.slice(0, limit).map(entry => entry.candidate.deviceId)),
    decisions: freeze(refused.slice(0, limit)), reasons: freeze(refused.slice(0, limit)),
    counts: freeze({offered: candidates.length, feasible: eligible.length, refused: refused.length}),
    truncated: freeze({feasible: eligible.length > limit, decisions: refused.length > limit})});
  if (!winner) return freeze({...common, state: 'REFUSED', deviceId: null, bootId: null, providerId: null, observationVersion: null, cost: null});
  return freeze({...common, state: 'PROPOSED', deviceId: winner.candidate.deviceId, bootId: winner.candidate.bootId,
    providerId: winner.candidate.provider?.id, observationVersion: winner.candidate.observationVersion, validUntil, cost: winner.cost});
}
