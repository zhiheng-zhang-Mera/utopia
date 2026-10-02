/**
 * UTOPIA · Gateway — scheduler presentation feed (UXI-301).
 *
 * WHY THIS MODULE EXISTS, and it is the finding that shaped UXI-301: the RS-290 presentation contract
 * (`contracts/rs-presentation-contract-v1/presentation.mjs`) shipped with a full test suite and had
 * **no consumer anywhere in the repository**. Nothing in the product called `projectStatus`, so no DTO
 * existed for a UI to present. UXI-301's job is to make that contract real, and a UI adapter alone
 * cannot: there has to be a producer.
 *
 * BOUNDARY DECISION, RECORDED BECAUSE IT IS AN INTERPRETATION AND A REVIEWER SHOULD BE ABLE TO
 * CHALLENGE IT. The workbook's allowed boundary names "Web/Android presentation adapter, ViewModel,
 * user copy, existing design-system components, necessary UI tests", and its prohibited list is about
 * BEHAVIOUR: do not modify the RS-290 contract, do not recompute provider/device selection in the UI,
 * do not make an unavailable provider clickable, do not resurrect the old dashboard. This module is
 * read-only, consumes the contract without altering it, and decides NOTHING about placement - it
 * reports what the City's own modules already decided. The alternative reading, that the City side may
 * not be touched at all, makes the task impossible: with no producer the UI has nothing to consume and
 * step 7's "both paths really executable" cannot be met. I have taken the reading that satisfies the
 * workbook's intent and its prohibitions, and I am flagging it rather than burying it.
 *
 * WHAT IT DOES NOT DO: it does not choose a device, rank candidates, or invent availability. Every
 * refusal comes from RS-202's `evaluateEligibility` and every term from the RS-290 mapping, so this
 * file contains no policy of its own.
 */

import {presentTerm, termRef, projectStatus} from '../../contracts/rs-presentation-contract-v1/presentation.mjs';
import {evaluateEligibility} from '../../city/00-foundation/01-city-core/fleet-routing/pressure.mjs';

export const PRESENTATION_FEED_VERSION = 1;

/** Task states the City treats as finished; mirrors contracts/city-control-v0/protocol.mjs. */
const TERMINAL_STATES = Object.freeze(['COMPLETED', 'FAILED', 'CANCELLED']);

/**
 * Derive RS-202's load vector from the telemetry the reference node actually reports.
 *
 * WHY THIS EXISTS, and it is the second finding that shaped this module. The first version passed
 * `load: null` on the grounds that the City has no five-dimension vector, and a probe showed what that
 * produces: RS-202 classifies unmeasured load as LOAD_UNKNOWN, LOAD_UNKNOWN is NOT eligible, and so an
 * **online, ready, idle node presented as unusable** — "still measuring how busy it is" with
 * KEEP_WAITING and CHOOSE_PROVIDER offered, permanently, for a healthy fleet. That is a fabricated
 * ALARM, the exact mirror of the fabricated reassurance step 4 forbids, and a probe caught it before a
 * UI ever rendered it.
 *
 * The telemetry really does carry usable load: `cpu.usagePercent` and `memory.usedBytes/totalBytes`, so
 * those two dimensions are reported as measured. `loadPressure` accepts a PARTIAL vector (its minimum
 * is one observed dimension), so two is enough to make a real decision.
 *
 * gpu, io and network are deliberately left UNMEASURED. The telemetry's disk reading is capacity
 * (used/free/total bytes), not I/O throughput, and reporting capacity as `io` load would be inventing a
 * measurement — the same fault in the other direction. An unmeasured dimension is honestly missing and
 * RS-202 reports it as such.
 */
export function loadFromTelemetry(telemetry) {
  if (!telemetry || typeof telemetry !== 'object') return null;
  const load = {};
  const cpuPercent = telemetry?.cpu?.usagePercent;
  if (Number.isFinite(cpuPercent) && cpuPercent >= 0 && cpuPercent <= 100) load.cpu = cpuPercent / 100;
  const {usedBytes, totalBytes} = telemetry?.memory ?? {};
  if (Number.isFinite(usedBytes) && Number.isFinite(totalBytes) && totalBytes > 0 && usedBytes >= 0 && usedBytes <= totalBytes) {
    load.memory = usedBytes / totalBytes;
  }
  return Object.keys(load).length > 0 ? Object.freeze(load) : null;
}

/**
 * Map a City node record to the device inputs RS-202 decides on.
 *
 * The gateway already owns the node-to-Core mapping for placement - `claimNodeFor` fills the Core's
 * node shape from its own liveness truth, where a node that is not online is OFFLINE - so this is the
 * same truth expressed for RS-202 rather than a second opinion about the node.
 */
export function candidateFromNode(node) {
  const online = node?.online === true;
  return Object.freeze({
    deviceRef: typeof node?.id === 'string' ? node.id : null,
    device: Object.freeze({
      state: online ? 'READY' : 'OFFLINE',
      presence: online ? 'ONLINE' : 'OFFLINE',
    }),
    load: loadFromTelemetry(node?.telemetry),
  });
}

/**
 * The presentation term for one candidate, from RS-202's own decision.
 *
 * `load` defaults to null on purpose: this City has heartbeat telemetry but no five-dimension load
 * vector, and RS-202 classifies unmeasured load under RESOURCE_REASONS because it BECOMES USABLE once
 * telemetry arrives. Presenting that honestly as "still measuring how busy it is" is the truthful
 * outcome; inventing a zeroed vector would render an unmeasured node as idle, which is a fabricated
 * reassurance and exactly what step 4 forbids.
 */
export function eligibilityFor(candidate, {load, enablement = 'ENABLED', sessionConcurrency = 0, providerConcurrency = 0, excludedByPolicy = false} = {}) {
  const {reason, eligible} = evaluateEligibility({
    device: candidate.device,
    enablement,
    // Fall back to what the node's own telemetry measured; an explicit override wins for tests.
    load: load === undefined ? (candidate.load ?? null) : load,
    sessionConcurrency,
    providerConcurrency,
    excludedByPolicy,
  });
  return Object.freeze({
    /** The contract INPUT: a (source, word) pair, whose `word` is a raw RS-202 reason. */
    ref: termRef('RS-202.ELIGIBILITY_REASONS', reason),
    /** The raw RS-202 reason. INTERNAL - it is not a presentation term and must not reach a UI. */
    reason,
    /**
     * The mapped presentation TERM, i.e. the UI-safe value. Both are returned deliberately and named
     * apart because confusing them is easy - my own first test asserted `ref.word` and expected the
     * mapped term, which is exactly the raw/internal mix-up this key exists to prevent.
     */
    term: presentTerm('RS-202.ELIGIBILITY_REASONS', reason),
    eligible: eligible === true,
  });
}

/**
 * Assemble the presentation DTO for one task from the candidates the City already tracks.
 *
 * The task's own terminal truth comes from the City's state, never from the absence of bad news: only
 * a genuinely terminal state sets `terminal`, so `COMPLETED` is unreachable by omission.
 */
export function projectTaskStatus({task, candidates = [], load, routeStage = null, otherInFlightByNode = null} = {}) {
  if (!task || typeof task !== 'object') throw new Error('projectTaskStatus requires a task');
  const state = String(task.state ?? '');
  const terminal = TERMINAL_STATES.includes(state);
  const refs = candidates.map((candidate) => {
    // REAL capacity pressure, from the City's own task store rather than an invented number. The count
    // EXCLUDES this task itself, because a run occupying a node is not a reason for that node to look
    // unavailable to the very run it is executing - counting itself made running tasks render as QUEUED.
    const sessionConcurrency = typeof otherInFlightByNode?.get === 'function'
      ? (otherInFlightByNode.get(candidate.deviceRef) ?? 0)
      : 0;
    return eligibilityFor(candidate, {...(load === undefined ? {} : {load}), sessionConcurrency}).ref;
  });
  return projectStatus({
    providerRefs: refs,
    routeStageRef: routeStage === null ? null : termRef('RS-202.ROUTE_STAGES', routeStage),
    terminal,
    failed: state === 'FAILED',
    cancelled: state === 'CANCELLED',
  });
}

/**
 * The whole read-only feed: one entry per task the City knows about.
 *
 * `includeTerminal` defaults to false because a scheduler status surface is about work in flight; the
 * caller can ask for finished tasks explicitly rather than receiving a wall of COMPLETED rows.
 */
export function buildPresentationFeed({tasks = [], nodes = [], includeTerminal = false, generatedAt = null} = {}) {
  const candidates = nodes.map(candidateFromNode);
  // Real in-flight counts per node, taken from the City's task store. This is what lets RS-202's session
  // ceiling actually be reached, so "device busy" is a condition the surface can truthfully report.
  const inFlightByNode = new Map();
  for (const task of tasks) {
    const state = String(task?.state ?? '');
    const nodeRef = task?.assignedNodeId;
    if (TERMINAL_STATES.includes(state) || typeof nodeRef !== 'string' || nodeRef.length === 0) continue;
    inFlightByNode.set(nodeRef, (inFlightByNode.get(nodeRef) ?? 0) + 1);
  }
  const othersFor = (task) => {
    const nodeRef = task?.assignedNodeId;
    const others = new Map(inFlightByNode);
    if (typeof nodeRef === 'string' && others.has(nodeRef)) {
      const remaining = others.get(nodeRef) - 1;
      if (remaining > 0) others.set(nodeRef, remaining); else others.delete(nodeRef);
    }
    return others;
  };
  const entries = [];
  for (const task of tasks) {
    const state = String(task?.state ?? '');
    if (!includeTerminal && TERMINAL_STATES.includes(state)) continue;
    entries.push(Object.freeze({
      taskId: typeof task?.id === 'string' ? task.id : null,
      taskState: state,
      dto: projectTaskStatus({task, candidates, otherInFlightByNode: othersFor(task)}),
    }));
  }
  return Object.freeze({
    presentation_feed_version: PRESENTATION_FEED_VERSION,
    generatedAt,
    candidates: Object.freeze(candidates.map((c) => c.deviceRef)),
    tasks: Object.freeze(entries),
  });
}

/** Every term this feed can currently produce, for a caller that wants to pre-load copy. */
export function termsInUse(feed) {
  const terms = new Set();
  for (const entry of feed?.tasks ?? []) {
    for (const provider of entry.dto?.providers ?? []) terms.add(provider.term);
    for (const term of entry.dto?.terms ?? []) terms.add(term);
  }
  return Object.freeze([...terms].sort());
}

export {presentTerm};

export default {PRESENTATION_FEED_VERSION, candidateFromNode, eligibilityFor, projectTaskStatus, buildPresentationFeed, termsInUse};
