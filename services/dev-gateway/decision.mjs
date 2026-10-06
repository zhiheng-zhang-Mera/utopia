// MON-903: the event-triggered decision overlay.
//
// WHAT THIS IS. The City's canonical task/event stream already records what happened. This module adds the missing
// layer the programme asks for: when a CANONICAL EVENT is one of the few that genuinely require a choice, decide - or
// escalate - and leave a bounded, provenance-complete receipt. Nothing else. The overlay is a PROJECTION of the event
// stream plus a decision record set; it is not a second task truth.
//
// THE SEVEN RULES THAT SHAPE THE CODE:
//   1. EVENT-TRIGGERED, NOT REPORT-TRIGGERED. Heartbeats, ordinary progress, resource observations and logs never
//      enter this path. Only the trigger kinds the programme names do, and each one is derived from a specific
//      canonical event type (see TRIGGER_SOURCES).
//   2. RULE FIRST, MODEL LAST. A deterministic rule that resolves the case must resolve it; a model is asked only when
//      no rule applies. A model is therefore never invoked "for intelligence".
//   3. THE OWNER BOUNDARY IS NOT NEGOTIABLE. Scope changes, merge/release gates, review readiness and owner-decision
//      candidates escalate to the owner WITHOUT any model being consulted, because those are owner matters, not
//      inference problems.
//   4. PER-TASK QUEUES, NO GLOBAL BARRIER. Decisions for one task are serialised and bounded; decisions for different
//      tasks run in parallel. There is no city-wide lock anywhere in this module - the queue map is keyed by task.
//   5. BOUNDED FALLBACK. Every resolver stage has a timeout and every resolver output is validated against a bounded
//      contract. A resolver that hangs, throws or returns free text is a FALLBACK, never an authority.
//   6. THE OVERLAY CANNOT BREAK THE CITY. `observe()` never throws and never awaits the canonical path; a failure is
//      recorded as a decision-receipt failure instead of propagating into task execution.
//   7. NO TASK MUTATION, NO WIDENED AUTHORITY. This module receives a READER (`tasks`) and no writer. It records what
//      should happen; it never assigns, retries, cancels, merges or completes anything. `appliedBy` stays null so a
//      reader cannot mistake a recommendation for a performed action.
//
// PURITY. Clock injected, no randomness in any decision value (ids are the only random element), no network.
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';

/** The trigger vocabulary, exactly as the programme board names it. */
export const TRIGGER_KINDS = Object.freeze(['FAILED', 'BLOCKED', 'READY_FOR_REVIEW', 'RETRY_REQUESTED', 'RESOURCE_CONFLICT', 'SCOPE_CHANGE', 'MERGE_READY', 'OWNER_DECISION_CANDIDATE']);
/** Which canonical event produces which trigger. Anything not listed here is NOT a decision trigger. */
export const TRIGGER_SOURCES = Object.freeze({
  TASK_FAILED: 'FAILED',
  TASK_TARGET_WAITING: 'BLOCKED',
  TASK_HANDOFF_REFUSED: 'RESOURCE_CONFLICT',
  NODE_OFFLINE: 'RESOURCE_CONFLICT',
  NODE_SHARING_CHANGED: 'RESOURCE_CONFLICT',
  JOIN_REQUEST_CREATED: 'OWNER_DECISION_CANDIDATE',
  RESEARCH_EXPERIMENT_REJECTED: 'OWNER_DECISION_CANDIDATE',
});
/** Trigger kinds with no canonical event source yet; they exist in the vocabulary and may be SUBMITTED explicitly. */
export const SUBMITTED_ONLY_KINDS = Object.freeze(['READY_FOR_REVIEW', 'RETRY_REQUESTED', 'SCOPE_CHANGE', 'MERGE_READY']);
/** Kinds that always escalate to the owner, with no resolver consulted. */
export const OWNER_BOUNDARY_KINDS = Object.freeze(['SCOPE_CHANGE', 'MERGE_READY', 'READY_FOR_REVIEW', 'OWNER_DECISION_CANDIDATE']);
export const DECISION_SOURCES = Object.freeze(['RULE', 'FAST_MODEL', 'CRITIC', 'OWNER']);
/** The complete set of actions a decision may carry. A resolver may not invent one. */
export const DECISION_ACTIONS = Object.freeze([
  'RETRY_RECOMMENDED', 'WAIT_FOR_TARGET_RECOVERY', 'DEFER_TO_SCHEDULER', 'RETRY_ADVISORY',
  'AWAIT_OWNER_APPROVAL', 'AWAIT_OWNER_REVIEW', 'AWAIT_OWNER_MERGE', 'AWAIT_OWNER_SCOPE_DECISION',
  'OWNER_REQUIRED', 'NO_ACTION_RECORDED',
]);
export const DECISION_CODES = Object.freeze({
  INVALID_TRIGGER: 'DECISION_TRIGGER_INVALID',
  UNKNOWN_DECISION: 'DECISION_NOT_FOUND',
  QUEUE_FULL: 'DECISION_QUEUE_FULL',
  RESOLVER_TIMEOUT: 'RESOLVER_TIMEOUT',
  RESOLVER_NOT_CONFIGURED: 'RESOLVER_NOT_CONFIGURED',
  RESOLVER_INVALID_OUTPUT: 'RESOLVER_INVALID_OUTPUT',
  RESOLVER_FAILED: 'RESOLVER_FAILED',
  RECEIPT_WRITE_FAILED: 'DECISION_RECEIPT_WRITE_FAILED',
  STORE_UNAVAILABLE: 'DECISION_STORE_UNAVAILABLE',
  OVERLAY_CLOSED: 'DECISION_OVERLAY_CLOSED',
});
const MAX_QUEUE_DEPTH = 16;
const RECEIPT_FILE = /^decision-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const bounded = value => typeof value === 'string' && value.trim().length > 0;
const ref = value => (bounded(value) ? String(value).slice(0, 160) : null);
const copy = value => JSON.parse(JSON.stringify(value));

export class DecisionError extends Error {
  constructor(code, message, detail = null, status = 400) {
    super(message);
    this.name = 'DecisionError';
    this.code = code;
    this.detail = detail;
    this.status = code === DECISION_CODES.UNKNOWN_DECISION ? 404 : status;
  }
}

/**
 * The deterministic rule layer. Returns a resolved decision, an escalation, or `null` for "no rule applies".
 * A rule NEVER returns a confidence: a deterministic rule is not a probability, and writing one would be a number
 * nobody measured.
 */
export function resolveByRule({kind, task, priorFailures = 0, node, retryBudget = 1}) {
  if (OWNER_BOUNDARY_KINDS.includes(kind)) return {source: 'RULE', boundary: true, action: 'OWNER_REQUIRED', escalationReason: 'OWNER_BOUNDARY_KIND', reason: `${kind} is an owner matter`};
  if (kind === 'FAILED') {
    // AN UNEXPLAINED FAILURE IS GENUINELY UNCERTAIN, so no rule claims it. When the canonical task records why it
    // failed, the failure is attributable and a deterministic rule can choose; when the record carries no cause, the
    // choice between "retry it" and "ask the owner" is a judgement, which is exactly the case the ladder's model stage
    // exists for. Without this distinction the model stage would be unreachable and the rule layer would be pretending
    // to know something the canonical record does not say.
    if (!(typeof task?.error === 'string' && task.error.trim().length > 0)) return null;
    if (priorFailures >= 2) return {source: 'RULE', action: 'OWNER_REQUIRED', escalationReason: 'REPEATED_FAILURE', reason: `repeated failure (${priorFailures})`};
    if (retryBudget > 0) return {source: 'RULE', action: 'RETRY_RECOMMENDED', reason: 'first attributable failure with retry budget remaining'};
    return {source: 'RULE', action: 'OWNER_REQUIRED', escalationReason: 'RETRY_BUDGET_EXHAUSTED', reason: 'no retry budget remains'};
  }
  if (kind === 'BLOCKED') {
    // The canonical vocabulary has no BLOCKED state; a task waiting for its target IS the canonical expression of
    // being blocked, so the rule distinguishes "the target is merely away" from "the target is here and ineligible".
    const state = node?.online;
    if (state === false) return {source: 'RULE', action: 'WAIT_FOR_TARGET_RECOVERY', reason: 'declared target is offline; the City already holds the task for it'};
    if (state === undefined || state === null) return {source: 'RULE', action: 'WAIT_FOR_TARGET_RECOVERY', reason: 'declared target state is not observable from the canonical record'};
    return {source: 'RULE', action: 'OWNER_REQUIRED', escalationReason: 'TARGET_PRESENT_BUT_INELIGIBLE', reason: 'target is online yet the task is still waiting for it'};
  }
  if (kind === 'RESOURCE_CONFLICT') return {source: 'RULE', action: 'DEFER_TO_SCHEDULER', reason: 'placement is the scheduler\'s decision, not this overlay\'s'};
  if (kind === 'RETRY_REQUESTED') {
    if (retryBudget > 0) return {source: 'RULE', action: 'RETRY_ADVISORY', reason: 'retry budget remains; the request is recorded for the component that owns retries'};
    return {source: 'RULE', action: 'OWNER_REQUIRED', escalationReason: 'RETRY_BUDGET_EXHAUSTED', reason: 'no retry budget remains'};
  }
  return null;
}

/**
 * @param {object} deps
 * @param {string} deps.dir                 where decision receipts are kept
 * @param {() => object[]} deps.tasks       a READER of canonical tasks (this module has no writer)
 * @param {string[]} [deps.ownerBoundaryKinds]
 * @param {function} [deps.fastModel]       optional bounded resolver
 * @param {function} [deps.critic]          optional bounded resolver
 * @param {function} [deps.clock]
 * @param {number} [deps.stageTimeoutMs]
 * @param {number} [deps.retentionLimit]
 * @param {function} [deps.onDecision]      notification hook (never awaited, never authoritative)
 */
export function createDecisionOverlay({dir, tasks, fastModel = null, critic = null, clock = () => Date.now(), stageTimeoutMs = 1500, retentionLimit = 200, onDecision = null, retryBudget = 1} = {}) {
  if (typeof tasks !== 'function') throw new TypeError('a canonical task READER is required: the overlay never writes tasks');
  // THE OVERLAY MUST NOT BE ABLE TO STOP THE CITY. An unusable receipt store means "decisions are recorded in memory
  // only, and every surface says so", never "the City does not start". This mirrors what the REX-804 opposite-host
  // review demanded of the fault module: a research-side storage problem is degraded, reported and survivable. Finding
  // M-1 of this task's own adversarial pass: the first version called mkdirSync unguarded and one stray file at
  // <runtime>/monitor made createGateway throw.
  let persistenceState = 'READY';
  let persistenceReason = null;
  try {
    mkdirSync(dir, {recursive: true});
    mkdirSync(resolve(dir, 'decisions'), {recursive: true});
  } catch (error) {
    persistenceState = 'UNAVAILABLE';
    persistenceReason = String(error?.code ?? error?.message ?? 'DECISION_STORE_UNWRITABLE').slice(0, 120);
  }
  const receiptDir = resolve(dir, 'decisions');
  let receipts = [];
  const queues = new Map();
  const failures = [];
  let observed = 0;
  let retentionTruncated = false;

  const noteFailure = code => { failures.push({code: typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'DECISION_OVERLAY_FAILURE', at: new Date(clock()).toISOString()}); if (failures.length > 16) failures.shift(); };

  // Existing receipts are read back so a restart keeps the same history and the repeated-failure rule keeps counting.
  // An unreadable receipt is REPORTED, never fatal: the REX-804 review found a sibling module that turned one bad file
  // into a City that would not start, and this module must not repeat that.
  const broken = [];
  if (persistenceState === 'READY') {
    for (const name of readdirSync(receiptDir)) {
      if (!RECEIPT_FILE.test(name)) continue;
      try {
        const row = JSON.parse(readFileSync(resolve(receiptDir, name), 'utf8'));
        if (!row || typeof row !== 'object' || typeof row.decisionId !== 'string' || row.decisionId + '.json' !== name) { broken.push({file: name, reason: 'RECEIPT_SHAPE_MISMATCH'}); continue; }
        receipts.push(row);
      } catch { broken.push({file: name, reason: 'UNREADABLE_RECEIPT'}); }
    }
  }
  receipts.sort((left, right) => Date.parse(left.decidedAt) - Date.parse(right.decidedAt));
  if (receipts.length > retentionLimit) { receipts = receipts.slice(-retentionLimit); retentionTruncated = true; }

  function persist(row) {
    // With an unusable store the decision is still recorded in memory and the receipt is simply absent; the caller
    // reports that through `receiptFailure`, so nothing is lost silently and nothing is invented.
    if (persistenceState !== 'READY') throw Object.assign(new Error(DECISION_CODES.STORE_UNAVAILABLE), {code: DECISION_CODES.STORE_UNAVAILABLE});
    const target = resolve(receiptDir, `${row.decisionId}.json`);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(row, null, 2), {mode: 0o600});
    renameSync(temporary, target);
    // Retention is applied to FILES as well as to the in-memory window, oldest first, and a failed prune is recorded
    // rather than thrown: the receipt that matters has already been written.
    const files = readdirSync(receiptDir).filter(name => RECEIPT_FILE.test(name)).sort();
    if (files.length > retentionLimit) {
      for (const name of files.slice(0, files.length - retentionLimit)) {
        try { rmSync(resolve(receiptDir, name)); retentionTruncated = true; } catch { noteFailure('DECISION_RETENTION_PRUNE_FAILED'); }
      }
    }
    return target;
  }

  const priorFailuresFor = taskRef => receipts.filter(row => row.taskRef === taskRef && row.triggerEvent?.kind === 'FAILED').length;
  const taskFor = taskRef => (taskRef === null ? null : (tasks() ?? []).find(task => task?.id === taskRef) ?? null);

  /** A resolver output is a BOUNDED CONTRACT. Free text is not an action, and an unknown action is not a decision. */
  function validateResolverOutput(stage, output) {
    if (output === null || typeof output !== 'object') return {ok: false, reason: `${stage} returned no decision object`};
    if (!DECISION_ACTIONS.includes(output.action)) return {ok: false, reason: `${stage} returned an action outside the declared vocabulary`};
    if (output.confidence !== null && output.confidence !== undefined && (typeof output.confidence !== 'number' || !Number.isFinite(output.confidence) || output.confidence < 0 || output.confidence > 1)) return {ok: false, reason: `${stage} returned a confidence outside 0..1`};
    if (output.reason !== undefined && output.reason !== null && !(typeof output.reason === 'string' && output.reason.length <= 120)) return {ok: false, reason: `${stage} returned an unbounded reason`};
    return {ok: true, value: {source: stage, action: output.action, confidence: output.confidence ?? null, reason: typeof output.reason === 'string' ? output.reason : null}};
  }

  async function ask(stage, resolver, input) {
    if (typeof resolver !== 'function') return {stage, status: 'NOT_CONFIGURED', code: DECISION_CODES.RESOLVER_NOT_CONFIGURED};
    let timer = null;
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(() => resolver(input)),
        new Promise((_yes, no) => { timer = setTimeout(() => no(Object.assign(new Error('resolver timed out'), {code: DECISION_CODES.RESOLVER_TIMEOUT})), stageTimeoutMs); }),
      ]);
      const verdict = validateResolverOutput(stage, outcome);
      if (!verdict.ok) return {stage, status: 'INVALID', code: DECISION_CODES.RESOLVER_INVALID_OUTPUT, detail: verdict.reason};
      return {stage, status: 'RESOLVED', value: verdict.value};
    } catch (error) {
      return {stage, status: error?.code === DECISION_CODES.RESOLVER_TIMEOUT ? 'TIMEOUT' : 'FAILED', code: error?.code === DECISION_CODES.RESOLVER_TIMEOUT ? DECISION_CODES.RESOLVER_TIMEOUT : DECISION_CODES.RESOLVER_FAILED, detail: String(error?.message ?? error).slice(0, 120)};
    } finally { clearTimeout(timer); }
  }

  /** The ladder: rules, then the owner boundary, then a model, then a critic, then the owner. */
  async function decide(trigger, enqueuedAt, decisionId) {
    const startedAt = clock();
    const task = taskFor(trigger.taskRef);
    const node = trigger.nodeRef ? (trigger.node ?? null) : null;
    const trace = [{stage: 'OBSERVATION', at: new Date(startedAt).toISOString(), detail: `trigger ${trigger.kind} from ${trigger.origin}`}];
    let outcome = null;
    let scored = null;

    const rule = resolveByRule({kind: trigger.kind, task, priorFailures: priorFailuresFor(trigger.taskRef), node, retryBudget});
    if (rule && rule.boundary === true) {
      outcome = {source: 'RULE', action: rule.action, confidence: null, reason: rule.reason, escalated: true, escalationReason: rule.escalationReason, escalationTarget: 'OWNER'};
      trace.push({stage: 'RULE', at: new Date(clock()).toISOString(), detail: 'owner boundary: no resolver consulted'});
    } else if (rule) {
      // A rule may escalate too (repeated failure, exhausted retry budget, a target that is present but ineligible).
      // The first version of this branch hardcoded `escalated: false` and dropped the rule's reason, so those
      // escalations were silently recorded as ordinary resolutions - caught by this task's own probe.
      const escalated = rule.escalationReason !== undefined && rule.escalationReason !== null || rule.action === 'OWNER_REQUIRED';
      outcome = {source: 'RULE', action: rule.action, confidence: null, reason: rule.reason, escalated, escalationReason: rule.escalationReason ?? null, escalationTarget: escalated ? 'OWNER' : null};
      trace.push({stage: 'RULE', at: new Date(clock()).toISOString(), detail: `${rule.reason}${escalated ? ` -> OWNER (${rule.escalationReason})` : ''}`});
    } else {
      trace.push({stage: 'RULE', at: new Date(clock()).toISOString(), detail: 'no deterministic rule applied'});
      const input = {kind: trigger.kind, taskRef: trigger.taskRef, reason: trigger.reason, preState: task?.state ?? null, priorFailures: priorFailuresFor(trigger.taskRef)};
      const fast = await ask('FAST_MODEL', fastModel, input);
      trace.push({stage: 'FAST_MODEL', at: new Date(clock()).toISOString(), detail: `${fast.status}${fast.code ? `:${fast.code}` : ''}`});
      if (fast.status === 'RESOLVED') scored = fast.value;
      else {
        const review = await ask('CRITIC', critic, {...input, unresolvedBy: fast.status});
        trace.push({stage: 'CRITIC', at: new Date(clock()).toISOString(), detail: `${review.status}${review.code ? `:${review.code}` : ''}`});
        if (review.status === 'RESOLVED') scored = review.value;
        else outcome = {source: 'OWNER', action: 'OWNER_REQUIRED', confidence: null, reason: `no resolver could decide: ${fast.code ?? fast.status}`, escalated: true, escalationReason: fast.code ?? 'NO_RESOLVER', escalationTarget: 'OWNER', resolverFailures: [fast, review].filter(entry => entry.code).map(entry => entry.code)};
      }
      if (scored) outcome = {source: scored.source, action: scored.action, confidence: scored.confidence, reason: scored.reason, escalated: false, escalationReason: null, escalationTarget: null};
    }

    const decidedAt = clock();
    const after = taskFor(trigger.taskRef);
    const row = {
      schemaVersion: 1,
      decisionId,
      taskRef: trigger.taskRef ?? null,
      triggerEvent: {kind: trigger.kind, origin: trigger.origin, eventId: trigger.eventId ?? null, eventSeq: trigger.eventSeq ?? null, eventType: trigger.eventType ?? null, reason: trigger.reason ?? null},
      preState: task?.state ?? null,
      postState: after?.state ?? null,
      source: outcome.source,
      action: outcome.action,
      confidence: outcome.confidence,
      confidenceReason: outcome.confidence === null ? 'NOT_AVAILABLE: a deterministic rule is not a probability and no resolver reported one' : null,
      queueWaitMs: Math.max(0, startedAt - enqueuedAt),
      decisionLatencyMs: Math.max(0, decidedAt - startedAt),
      timeoutOrFallback: outcome.resolverFailures ?? [],
      escalationTarget: outcome.escalationTarget,
      escalationReason: outcome.escalationReason,
      ownerRequired: outcome.escalated === true,
      evidenceRefs: trigger.eventId ? [{canonicalEventId: trigger.eventId, seq: trigger.eventSeq ?? null, source: 'CANONICAL_GATEWAY_STORE', path: '/api/v0/events'}] : [],
      // The overlay has no writer and applies nothing. Saying so on every receipt is what stops a recommendation from
      // reading like a performed action.
      appliedBy: null,
      application: 'RECORDED_ONLY',
      applicationReason: 'NOT_APPLICABLE: this overlay owns no task writer and grants no authority',
      decisionTrace: trace,
      decidedAt: new Date(decidedAt).toISOString(),
      brokerNote: 'decision recorded by the MON-903 overlay; canonical task state remains the City\'s own',
    };
    try { persist(row); } catch (error) {
      // The reason the receipt is missing travels with the decision: "the store is unusable" and "this one write
      // failed" are different facts, and a reader deciding whether to trust the window needs to know which one it is.
      const code = typeof error?.code === 'string' ? error.code : DECISION_CODES.RECEIPT_WRITE_FAILED;
      noteFailure(code);
      row.receiptFailure = code;
    }
    receipts.push(row);
    if (receipts.length > retentionLimit) { receipts = receipts.slice(-retentionLimit); retentionTruncated = true; }
    if (typeof onDecision === 'function') { try { onDecision(copy(row)); } catch { noteFailure('DECISION_NOTIFICATION_FAILED'); } }
    return row;
  }

  /**
   * Submit one trigger. Returns IMMEDIATELY with the decision id and the queue position: the caller - in production the
   * canonical event path - must never wait for a decision, or the monitor would become the city-wide barrier this
   * programme forbids.
   */
  function submit(trigger) {
    const kind = trigger?.kind;
    if (!TRIGGER_KINDS.includes(kind)) throw new DecisionError(DECISION_CODES.INVALID_TRIGGER, `unknown trigger kind ${String(kind)}`, {known: [...TRIGGER_KINDS]});
    const taskRef = ref(trigger.taskRef);
    const key = taskRef ?? '<city>';
    const queue = queues.get(key) ?? {tail: Promise.resolve(), depth: 0, decisions: 0};
    const enqueuedAt = clock();
    const id = `decision-${randomUUID()}`;
    if (queue.depth >= MAX_QUEUE_DEPTH) {
      noteFailure(DECISION_CODES.QUEUE_FULL);
      // A full per-task queue is itself a decision fact: recorded, attributed, and NOT allowed to spill into other tasks.
      const rejected = {schemaVersion: 1, decisionId: id, taskRef, triggerEvent: {kind, origin: trigger.origin ?? 'SUBMITTED', eventId: trigger.eventId ?? null, eventSeq: trigger.eventSeq ?? null, eventType: trigger.eventType ?? null, reason: trigger.reason ?? null}, preState: taskFor(taskRef)?.state ?? null, postState: null, source: 'OWNER', action: 'OWNER_REQUIRED', confidence: null, confidenceReason: null, queueWaitMs: Math.max(0, clock() - enqueuedAt), decisionLatencyMs: 0, timeoutOrFallback: [DECISION_CODES.QUEUE_FULL], escalationTarget: 'OWNER', escalationReason: DECISION_CODES.QUEUE_FULL, ownerRequired: true, evidenceRefs: [], appliedBy: null, application: 'RECORDED_ONLY', applicationReason: 'NOT_APPLICABLE: this overlay owns no task writer and grants no authority', decisionTrace: [{stage: 'QUEUE', at: new Date(clock()).toISOString(), detail: `per-task queue depth ${queue.depth} reached the bound`}], decidedAt: new Date(clock()).toISOString()};
      try { persist(rejected); } catch { /* reported through failures */ }
      receipts.push(rejected);
      if (receipts.length > retentionLimit) { receipts = receipts.slice(-retentionLimit); retentionTruncated = true; }
      return {decisionId: id, queued: false, queueDepth: queue.depth, queueFull: true};
    }
    queue.depth += 1;
    queue.decisions += 1;
    queues.set(key, queue);
    const run = queue.tail.then(() => decide({...trigger, kind, taskRef}, enqueuedAt, id));
    // The tail must never reject, or one bad decision would poison every later decision for this task.
    queue.tail = run.then(() => { queue.depth -= 1; }, () => { queue.depth -= 1; noteFailure('DECISION_RUN_FAILED'); });
    void queue.tail.then(() => { if (queue.depth === 0) queues.delete(key); });
    run.catch(() => { noteFailure('DECISION_UNHANDLED_REJECTION'); });
    return {decisionId: id, queued: true, queueDepth: queue.depth};
  }

  /**
   * The canonical-path entry point. It classifies ONE event and, if that event is a decision trigger, submits it.
   * It NEVER throws and NEVER awaits: a broken overlay must not be able to stop a task from completing.
   */
  function observe(event) {
    try {
      observed += 1;
      if (!event || typeof event.type !== 'string') return null;
      const kind = TRIGGER_SOURCES[event.type];
      if (!kind) return null;
      const taskRef = ref(event.taskId);
      if (kind === 'RESOURCE_CONFLICT' && (event.type === 'NODE_OFFLINE' || event.type === 'NODE_SHARING_CHANGED')) {
        // A node going away is only a decision when work is actually waiting on it; otherwise it is an observation.
        const nodeRef = ref(event.payload?.nodeId);
        const waiting = (tasks() ?? []).filter(task => task?.assignedNodeId === nodeRef && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.state));
        if (waiting.length === 0) return null;
        return submit({kind, taskRef: waiting[0].id, nodeRef, node: {online: false}, origin: 'CANONICAL_EVENT', eventId: event.id, eventSeq: event.seq, eventType: event.type, reason: `${waiting.length} task(s) were assigned to ${nodeRef}`});
      }
      return submit({kind, taskRef, origin: 'CANONICAL_EVENT', eventId: event.id, eventSeq: event.seq, eventType: event.type, reason: null});
    } catch (error) { noteFailure(error?.code ?? 'DECISION_OBSERVE_FAILED'); return null; }
  }

  /** The recent decisions a projection or a surface may read. Read-only, bounded, and honest about its window. */
  function snapshot(limit = 50) {
    const size = Number.isInteger(limit) && limit > 0 && limit <= retentionLimit ? limit : 50;
    const rows = [...receipts].slice(-size).reverse().map(copy);
    const window = receipts.length === 0 ? {firstSeq: null, lastSeq: null} : {firstSeq: receipts[0].triggerEvent?.eventSeq ?? null, lastSeq: receipts.at(-1)?.triggerEvent?.eventSeq ?? null};
    return {schemaVersion: 1, authoritative: false, persistence: persistenceState, persistenceReason, decisions: rows, retained: receipts.length, retainedLimit: retentionLimit, retentionTruncated, broken, failures: copy(failures), observedEvents: observed, window, unsupportedSources: ['model/provider identity (a resolver is a seam, not an identified model)', 'hidden reasoning (never requested, never stored)']};
  }

  /** Metrics for the research protocol. A number is only reported where it was actually counted. */
  function metrics() {
    const total = receipts.length;
    const bySource = Object.fromEntries(DECISION_SOURCES.map(source => [source, receipts.filter(row => row.source === source).length]));
    const ownerRequired = receipts.filter(row => row.ownerRequired).length;
    const timeouts = receipts.filter(row => (row.timeoutOrFallback ?? []).some(code => code === DECISION_CODES.RESOLVER_TIMEOUT)).length;
    const latencies = receipts.map(row => row.decisionLatencyMs).filter(value => Number.isFinite(value));
    const waits = receipts.map(row => row.queueWaitMs).filter(value => Number.isFinite(value));
    const mean = values => (values.length === 0 ? null : Math.round(values.reduce((totalValue, value) => totalValue + value, 0) / values.length));
    return {
      decisions: total,
      bySource,
      ownerRequired,
      autoResolved: total - ownerRequired,
      autoResolutionRate: total === 0 ? null : Number(((total - ownerRequired) / total).toFixed(4)),
      autoResolutionRateReason: total === 0 ? 'NOT_MEASURED: no decision has been recorded in this window' : null,
      timeouts,
      meanDecisionLatencyMs: mean(latencies),
      meanQueueWaitMs: mean(waits),
      // The programme asks whether a decision ever blocked an UNRELATED task. This overlay has no city-wide lock and no
      // shared mutex, so the honest statement is a structural one plus the observation that the overlay is never
      // awaited by the canonical path - not a fabricated zero.
      unrelatedTaskBlocking: 'ABSENT_BY_CONSTRUCTION',
      unrelatedTaskBlockingBasis: 'the queue map is keyed by task and observe() is never awaited on the canonical path',
      concurrentDecisionTasks: queues.size,
      persistence: persistenceState,
      persistenceReason,
      resolverFailures: copy(failures),
      unsupportedSources: ['wrong auto-decision and repair (requires an independent judge, not this overlay)', 'confidence versus final review outcome (no resolver is configured in this City)'],
    };
  }

  function receipt(decisionId) {
    const id = String(decisionId ?? '');
    if (!RECEIPT_FILE.test(`${id}.json`)) throw new DecisionError(DECISION_CODES.UNKNOWN_DECISION, `no decision ${id} is recorded here`, {decisionId: id});
    const path = resolve(receiptDir, `${id}.json`);
    if (!existsSync(path)) {
      // A decision recorded while the store was unavailable still exists in the window, and is answered from there
      // rather than reported as missing.
      const inWindow = receipts.find(row => row.decisionId === id);
      if (inWindow) return copy(inWindow);
      throw new DecisionError(DECISION_CODES.UNKNOWN_DECISION, `no decision ${id} is recorded here`, {decisionId: id});
    }
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new DecisionError(DECISION_CODES.UNKNOWN_DECISION, `decision ${id} is unreadable`, {decisionId: id}); }
  }

  /** Bounded close: stop accepting work and let the per-task queues drain, without waiting forever. */
  async function close({timeoutMs = 500} = {}) {
    closed = true;
    const until = clock() + Math.max(1, Math.min(Number(timeoutMs) || 1, 5000));
    while (queues.size > 0 && clock() < until) await new Promise(r => setTimeout(r, 5));
    return {drained: queues.size === 0, pendingTasks: queues.size};
  }

  let closed = false;
  return Object.freeze({
    submit: trigger => { if (closed) throw new DecisionError(DECISION_CODES.OVERLAY_CLOSED, 'the decision overlay is closing and accepts no new triggers', null, 409); return submit(trigger); },
    observe, snapshot, metrics, receipt, close,
    kinds: TRIGGER_KINDS, sources: DECISION_SOURCES, actions: DECISION_ACTIONS,
    persistence: () => persistenceState,
    // Diagnostics for the review: what this module is NOT.
    ownsTaskState: false,
    mutatesTasks: false,
    hasGlobalLock: false,
    decidesOnReports: false,
  });
}
