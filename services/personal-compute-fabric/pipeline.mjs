// PCF-703 (plan half): the explicit, versioned, acyclic execution plan, and the canonical stage runner.
//
// The workbook is blunt about what this must NOT be: not an LLM splitting an arbitrary program into steps. A plan is
// DECLARED BY THE CALLER, and version 2 makes every stage describe itself - its input/output schema, its resources and
// units, its permissions, its side effects, its deadline, its checkpoint capability, its placement preference and the
// executor it needs. A stage that leaves any of those out is refused by name, and an unknown stage field is refused
// too, so a generated plan cannot smuggle an undeclared field into execution.
//
// Version 1 (the legacy shape: id/dependsOn/writeScope) still compiles, exactly as PCF-708 requires of legacy inputs,
// but it is LABELLED as not self-describing and it is REFUSED by the canonical runner: a stage whose resources and
// placement were never declared cannot be admitted or executed on a real machine.
//
// The canonical runner keeps ONE task truth. PCF-704 admits one reservation per canonical task, so stages run
// sequentially under the SAME task/action/origin/session: only the attempt changes. Stage inputs and outputs travel
// through PCF-709 as content-addressed artifacts, and the worker is the PCF-710 executor. No second scheduler, no
// second task record.
import {requireThat as ok, text, strings, finite, copy, freeze} from './validation.mjs';
import {normalizeWorkload} from './workload.mjs';
import {planPlacement, PLACEMENT_STRATEGIES} from './placement.mjs';
import {admit, claimAttempt, commitResult, commitStageResult} from './admission.mjs';
import {normalizeWorkloadEnvelope} from './workload-envelope.mjs';
import {executeAttempt} from './executor.mjs';
import {sha256} from './artifacts.mjs';

export const EXECUTION_PLAN_VERSION = 2;
export const LEGACY_PLAN_VERSION = 1;
export const SIDE_EFFECTS = Object.freeze(['NONE', 'IDEMPOTENT_KEYED', 'NON_IDEMPOTENT']);
/** The declarations a self-describing stage owes. Missing any of them is a refusal, not a default. */
export const STAGE_DECLARATIONS = Object.freeze(['inputSchema', 'outputSchema', 'resources', 'permissions', 'sideEffects', 'deadlineAt', 'checkpoint', 'placement', 'executor']);
const STAGE_KEYS = Object.freeze(['id', 'dependsOn', 'writeScope', ...STAGE_DECLARATIONS]);
const RESOURCE_UNITS = Object.freeze({cpu: 'millicores', memory: 'bytes', disk: 'bytes', vram: 'bytes'});
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
// A permission is a handle reference, not a bare word: 'process:own-child' and 'filesystem:attempt-scratch' are the
// shape the provider manifest uses, so the same ref alphabet is accepted here.
const PERMISSION_REF = /^[A-Za-z0-9_./:@#-]{1,180}$/;

/** Describe one version-2 stage. Every field the workbook names is required and validated. */
function compileStage(stage) {
  ok(isPlainObject(stage), 'STAGE_INVALID');
  for (const key of Object.keys(stage)) ok(STAGE_KEYS.includes(key), 'STAGE_UNKNOWN_FIELD:' + key);
  ok(text(stage.id), 'STAGE_ID');
  ok(strings(stage.dependsOn), 'STAGE_DEPENDS_ON');
  ok(strings(stage.writeScope), 'STAGE_WRITE_SCOPE');
  ok(text(stage.inputSchema) && text(stage.outputSchema), 'STAGE_SCHEMA_REQUIRED');
  // Resources carry their unit, and a unit that disagrees with the published table is a conflict, not a conversion.
  ok(isPlainObject(stage.resources) && Object.keys(stage.resources).length > 0, 'STAGE_RESOURCES_REQUIRED');
  const resources = {};
  for (const [kind, requirement] of Object.entries(stage.resources)) {
    ok(Object.hasOwn(RESOURCE_UNITS, kind), 'STAGE_RESOURCE_KIND_UNKNOWN:' + kind);
    ok(isPlainObject(requirement) && finite(requirement.amount), 'STAGE_RESOURCE_AMOUNT_INVALID:' + kind);
    ok(requirement.unit === RESOURCE_UNITS[kind], 'STAGE_RESOURCE_UNIT_CONFLICT:' + kind + ':expected ' + RESOURCE_UNITS[kind]);
    resources[kind] = {amount: requirement.amount, unit: requirement.unit};
  }
  ok(strings(stage.permissions) && stage.permissions.every(permission => PERMISSION_REF.test(permission)), 'STAGE_PERMISSIONS_REQUIRED');
  ok(SIDE_EFFECTS.includes(stage.sideEffects), 'STAGE_SIDE_EFFECTS_UNKNOWN');
  ok(stage.deadlineAt === null || finite(stage.deadlineAt), 'STAGE_DEADLINE_INVALID');
  // A resumable claim needs a capability reference: a stage claiming "I can checkpoint" is not evidence.
  ok(isPlainObject(stage.checkpoint) && typeof stage.checkpoint.resumable === 'boolean'
    && (stage.checkpoint.resumable ? text(stage.checkpoint.capabilityRef) : stage.checkpoint.capabilityRef === null), 'STAGE_CHECKPOINT_INVALID');
  ok(isPlainObject(stage.placement) && PLACEMENT_STRATEGIES.includes(stage.placement.strategy), 'STAGE_PLACEMENT_UNKNOWN');
  ok(stage.placement.strictTargetDeviceRef === undefined || stage.placement.strictTargetDeviceRef === null || text(stage.placement.strictTargetDeviceRef), 'STAGE_PLACEMENT_TARGET_INVALID');
  ok(isPlainObject(stage.executor) && text(stage.executor.providerRef) && Number.isSafeInteger(stage.executor.providerVersion) && stage.executor.providerVersion > 0, 'STAGE_EXECUTOR_REQUIRED');
  return freeze({id: stage.id, dependsOn: [...stage.dependsOn], writeScope: [...stage.writeScope], inputSchema: stage.inputSchema, outputSchema: stage.outputSchema,
    resources: freeze(resources), permissions: [...stage.permissions], sideEffects: stage.sideEffects, deadlineAt: stage.deadlineAt,
    checkpoint: freeze({resumable: stage.checkpoint.resumable, capabilityRef: stage.checkpoint.capabilityRef}),
    placement: freeze({strategy: stage.placement.strategy, strictTargetDeviceRef: stage.placement.strictTargetDeviceRef ?? null}),
    executor: freeze({providerRef: stage.executor.providerRef, providerVersion: stage.executor.providerVersion})});
}

/** Which stage declarations a legacy version-1 plan is missing. Reported, never assumed away. */
function missingDeclarations(stage) {
  const missing = [];
  for (const key of ['inputSchema', 'outputSchema', 'resources', 'permissions', 'sideEffects', 'deadlineAt', 'checkpoint', 'placement', 'executor']) {
    if (!Object.hasOwn(stage, key)) missing.push(key);
  }
  return missing;
}

/**
 * Compile a plan. The DAG rules are the same for both versions; only the per-stage declarations differ, and a legacy
 * plan says out loud that it does not describe itself.
 */
export function compileExecutionPlan(spec) {
  const p = copy(spec);
  ok(isPlainObject(p), 'DAG_SHAPE');
  ok(p.version === EXECUTION_PLAN_VERSION || p.version === LEGACY_PLAN_VERSION, 'DAG_VERSION_OR_LIMIT');
  ok(Array.isArray(p.stages) && p.stages.length > 0 && p.stages.length <= 64, 'DAG_VERSION_OR_LIMIT');
  const legacy = p.version === LEGACY_PLAN_VERSION;
  const stages = [];
  const seen = new Map();
  for (const raw of p.stages) {
    const stage = legacy ? (ok(isPlainObject(raw) && text(raw.id) && strings(raw.dependsOn) && strings(raw.writeScope), 'STAGE_INVALID'), freeze({...raw})) : compileStage(raw);
    ok(!seen.has(stage.id), 'STAGE_DUPLICATE:' + stage.id);
    seen.set(stage.id, legacy ? missingDeclarations(raw) : []);
    stages.push(stage);
  }
  // A stage may not declare the same write scope as a stage it does not depend on: two writers, one path, no order.
  const ancestors = new Map();
  const visit = (id, path = new Set()) => {
    ok(seen.has(id) && !path.has(id), 'DAG_CYCLE_OR_MISSING');
    if (ancestors.has(id)) return ancestors.get(id);
    path.add(id);
    const result = new Set();
    for (const parent of stages.find(stage => stage.id === id).dependsOn) { result.add(parent); for (const inherited of visit(parent, path)) result.add(inherited); }
    path.delete(id);
    ancestors.set(id, result);
    return result;
  };
  for (const stage of stages) visit(stage.id);
  for (const left of stages) for (const right of stages) {
    if (left.id >= right.id || ancestors.get(left.id).has(right.id) || ancestors.get(right.id).has(left.id)) continue;
    ok(!left.writeScope.some(x => right.writeScope.some(y => x === y || x.startsWith(y + '/') || y.startsWith(x + '/'))), 'PARALLEL_WRITE_CONFLICT');
  }
  const notSelfDescribing = stages.filter(stage => seen.get(stage.id).length > 0).map(stage => freeze({stageId: stage.id, missing: freeze(seen.get(stage.id))}));
  return freeze({...p, version: p.version, stages: freeze(stages), declaration: legacy ? 'LEGACY_V1_NOT_SELF_DESCRIBING' : 'SELF_DESCRIBING_V2',
    selfDescribing: !legacy, notSelfDescribing: freeze(notSelfDescribing)});
}

/** A deterministic topological order: dependencies first, then the declared order, so the sequence is reproducible. */
export function stageOrder(plan) {
  const p = compileExecutionPlan(plan);
  const order = [];
  const done = new Set();
  while (order.length < p.stages.length) {
    const next = p.stages.find(stage => !done.has(stage.id) && stage.dependsOn.every(parent => done.has(parent)));
    ok(next, 'DAG_CYCLE_OR_MISSING');
    done.add(next.id);
    order.push(next);
  }
  return freeze(order);
}

/**
 * The canonical stage runner: PCF-704 admission -> PCF-710 execution -> PCF-709 artifacts, stage by stage, under ONE
 * task truth.
 *
 * Stages are sequential by construction. PCF-704 permits a single active reservation per canonical task, so parallel
 * stages would require a second reservation identity for the same task - which is exactly the second scheduler and the
 * second task truth this workbook forbids. Only the attempt changes per stage; task/action/origin/session never do.
 */
export async function executeStages({plan, owner, artifacts, workload, policy, candidate, envelope, deviceId, bootId, holder,
  stages, now = Date.now(), idempotencyKeyPrefix = 'stage', appQuota = {cpu: 2, memory: 512 * 1024 * 1024}, ttlMs = 30000, signal} = {}) {
  const p = compileExecutionPlan(plan);
  // A legacy plan cannot be executed on a real machine: nothing declared what it needs or where it may run.
  ok(p.version === EXECUTION_PLAN_VERSION, 'PLAN_NOT_SELF_DESCRIBING');
  ok(Array.isArray(stages) && stages.length === p.stages.length, 'STAGE_INPUTS_REQUIRED');
  const w = normalizeWorkload(workload);
  ok(deviceId === w.originDeviceId, 'STAGE_RUNNER_CANNOT_EXECUTE_REMOTE');
  const declared = stageOrder(p);
  const executed = [];
  let previousOutput = null;
  for (const stage of declared) {
    const provided = stages.find(entry => entry.stageId === stage.id);
    ok(provided && typeof provided.operation === 'string', 'STAGE_INPUTS_REQUIRED:' + stage.id);
    const inputRequest = {operation: provided.operation, values: provided.values ?? [], checkpoint: provided.checkpoint ?? null};
    // PCF-709: the stage input is content-addressed and its digest is verified before a worker may read it.
    const inputBytes = Buffer.from(JSON.stringify(inputRequest));
    const inputRef = await artifacts.publish(inputBytes, {owner: w.parentSessionId, dataScope: w.dataScope, expiresAt: w.deadlineAt, schema: stage.inputSchema}, now);
    // The bytes the worker will actually receive are read back from PCF-709 and digest-verified first: a reference is
    // a claim about content, and the claim is checked rather than assumed.
    const stored = await artifacts.read(inputRef, {caller: w.parentSessionId}, now);
    ok(sha256(stored) === inputRef.digest, 'STAGE_INPUT_DIGEST_MISMATCH:' + stage.id);
    const proposal = planPlacement(w, [candidate], policy, now, {strategy: stage.placement.strategy});
    ok(proposal.state === 'PROPOSED', 'STAGE_PLACEMENT_REFUSED:' + stage.id);
    const reservation = admit(owner, {workload: w, proposal, policy, candidate, idempotencyKey: idempotencyKeyPrefix + ':' + stage.id, ttlMs, appQuota, now}).reservation;
    const attempt = claimAttempt(owner, {reservationId: reservation.id, holder: holder ?? deviceId, bootId, now});
    // The stage envelope carries the SAME canonical identity as the parent workload; only the stage declaration and the
    // reserved resources differ. The provider manifest reference is the one the plan declared.
    const stageEnvelope = normalizeWorkloadEnvelope({...envelope, taskId: w.taskId, actionId: w.actionId, originDeviceId: w.originDeviceId,
      parentSessionId: w.parentSessionId, targetDeviceRef: deviceId, inputSchema: stage.inputSchema, outputSchema: stage.outputSchema,
      resources: stage.resources, deadlineAt: stage.deadlineAt ?? envelope.deadlineAt, labels: {...(envelope.labels ?? {}), stageId: stage.id}});
    const result = await executeAttempt({envelope: stageEnvelope, reservation, controls: {operation: inputRequest.operation, values: inputRequest.values,
      checkpoint: inputRequest.checkpoint, deviceId, bootId, now, attemptId: attempt.id, signal}});
    // The attempt is committed on the canonical task either way: a failed stage is a FACT, not a missing record.
    // A stage that SUCCEEDED while later stages are still pending is committed as stage PROGRESS, because committing
    // SUCCEEDED would publish the whole task as COMPLETED with work still outstanding.
    const isFinalStage = executed.length + 1 === declared.length;
    if (result.outcome === 'SUCCEEDED' && !isFinalStage) {
      commitStageResult(owner, {taskId: w.taskId, attemptId: attempt.id, epoch: attempt.epoch, holder: attempt.holder, bootId,
        stageId: stage.id, outputDigest: result.outputDigest, now: Date.now()});
    } else {
      commitResult(owner, {taskId: w.taskId, attemptId: attempt.id, epoch: attempt.epoch, holder: attempt.holder, bootId,
        outcome: result.outcome, outputDigest: result.outputDigest, reason: result.reason ?? null, now: Date.now()});
    }
    const outputRef = result.outcome === 'SUCCEEDED' ? await artifacts.publish(Buffer.from(JSON.stringify(result.output)),
      {owner: w.parentSessionId, dataScope: w.dataScope, expiresAt: now + 86400000, schema: stage.outputSchema}, Date.now()) : null;
    executed.push(freeze({stageId: stage.id, reservationId: reservation.id, attemptId: attempt.id, epoch: attempt.epoch, outcome: result.outcome,
      reason: result.reason ?? null, output: result.output ?? null, outputDigest: result.outputDigest ?? null, inputDigest: inputRef.digest,
      outputRef: outputRef ? freeze({digest: outputRef.digest, schema: stage.outputSchema}) : null, sideEffects: stage.sideEffects,
      resources: stage.resources, placementStrategy: stage.placement.strategy}));
    if (result.outcome !== 'SUCCEEDED') {
      // Everything downstream is NOT_RUN. A stopped pipeline is never reported as a completed one.
      for (const pending of declared.slice(executed.length)) executed.push(freeze({stageId: pending.id, reservationId: null, attemptId: null, epoch: null,
        outcome: 'NOT_RUN', reason: 'UPSTREAM_STAGE_FAILED:' + stage.id, output: null, outputDigest: null, inputDigest: null, outputRef: null, sideEffects: pending.sideEffects}));
      break;
    }
    previousOutput = result.output;
  }
  const succeeded = executed.every(entry => entry.outcome === 'SUCCEEDED');
  return freeze({kind: 'StageExecutionReport', planVersion: p.version, declaration: p.declaration,
    canonical: freeze({taskId: w.taskId, actionId: w.actionId, originDeviceId: w.originDeviceId, parentSessionId: w.parentSessionId}),
    stages: freeze(executed), state: succeeded ? 'COMPLETED' : 'FAILED', completedStages: executed.filter(entry => entry.outcome === 'SUCCEEDED').length,
    notRunStages: executed.filter(entry => entry.outcome === 'NOT_RUN').length, finalOutput: succeeded ? previousOutput : null,
    oneTaskTruth: true, concurrentStages: false,
    note: 'one canonical task, one reservation at a time; only the attempt changes per stage'});
}

/**
 * The legacy callback runner. Unchanged in behaviour: it is the unit-test seam and the counterfactual path, NOT the
 * real execution path - real execution goes through executeStages and the canonical admission above.
 */
export async function runExecutionPlan(plan, execute, {concurrency = 2, signal} = {}) {
  const p = compileExecutionPlan(plan);
  ok(typeof execute === 'function' && Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 16, 'PIPELINE_CONFIG');
  const output = Object.create(null), pending = new Map(p.stages.map(stage => [stage.id, stage])), running = new Map();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) abort();
  let failure;
  try {
    while (pending.size || running.size) {
      if (controller.signal.aborted) throw failure ?? new Error('CANCELLED');
      for (const [id, stage] of pending) {
        if (running.size >= concurrency) break;
        if (!stage.dependsOn.every(dependency => Object.hasOwn(output, dependency))) continue;
        pending.delete(id);
        const inputs = Object.fromEntries(stage.dependsOn.map(dependency => [dependency, output[dependency]]));
        const job = Promise.resolve().then(() => execute(stage, inputs, controller.signal)).then(value => { output[id] = value; running.delete(id); },
          error => { failure = error; controller.abort(); running.delete(id); });
        running.set(id, job);
      }
      ok(running.size > 0 || pending.size === 0, 'PIPELINE_STALLED');
      if (running.size) await Promise.race(running.values());
    }
    if (controller.signal.aborted) throw failure ?? new Error('CANCELLED');
    return output;
  } finally {
    controller.abort();
    signal?.removeEventListener('abort', abort);
    await Promise.allSettled(running.values());
  }
}
