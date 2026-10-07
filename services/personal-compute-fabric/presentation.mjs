// PCF-715: the read-only fabric projection for the existing Settings/Advanced surface.
//
// Two properties are load-bearing and were missing:
//
//   * ACTIVE RISK BUBBLES. A canonical task carrying the attention that PCF-704/705 really write for an uncertain side
//     effect (SIDE_EFFECT_UNKNOWN) must reach the overview; a projection that silently drops it shows a calm panel
//     while a task is unresolved.
//   * A PARTIAL CANONICAL READ IS REPORTED, NOT FATAL. If the canonical row is incomplete, the projection says
//     PARTIAL/UNKNOWN upward instead of throwing a raw TypeError that takes the whole overview read down with it.
//
// Nothing here holds execution authority: it is a pure function of a snapshot, it copies what it reads, and it never
// creates a task, an action or a second source of truth.
import {freeze, copy} from './validation.mjs';

export function buildFabricProjection(snapshot, {backendConfigured = false, serviceState = null, tasks = []} = {}) {
  // A snapshot that did not arrive intact is UNKNOWN, not empty: reading a missing array as "zero reservations" would
  // present an unreadable state as an idle one.
  const reservations = Array.isArray(snapshot?.reservations) ? copy(snapshot.reservations) : null;
  const attempts = Array.isArray(snapshot?.attempts) ? copy(snapshot.attempts) : null;
  const partial = reservations === null || attempts === null;
  const rows = tasks.filter(task => task.executionBackendId === 'pcf-v1');
  // Active risk is the canonical attention field itself, carried verbatim rather than re-interpreted.
  const risky = rows.filter(task => typeof task?.pcfAttention === 'string' && task.pcfAttention.length > 0)
    .map(task => freeze({id: task.id, state: task.state ?? null, attention: task.pcfAttention}));
  return freeze({
    version: Number.isSafeInteger(snapshot?.version) ? snapshot.version : null,
    completeness: partial ? 'PARTIAL' : 'COMPLETE',
    unknown: freeze({reservations: reservations === null, attempts: attempts === null, reason: partial ? 'CANONICAL_STATE_INCOMPLETE' : null}),
    state: backendConfigured ? 'CANDIDATE_PENDING_VERIFICATION' : 'NOT_CONFIGURED',
    reservations: (reservations ?? []).length,
    running: (attempts ?? []).filter(attempt => attempt.state === 'RUNNING').length,
    // The bubble PCF-715 line 47 asks for: unknown, stale, partial data and ACTIVE RISK all reach the overview.
    activeRisk: freeze({present: risky.length > 0, count: risky.length, items: freeze(risky.slice(-10)),
      bubblesToOverview: true, definition: 'the canonical task attention field, carried verbatim'}),
    resultReturned: rows.filter(task => task.pcfDeliveredSessionId === task.parentSessionId).length,
    agentConsumed: 'NOT_OBSERVED',
    callerAcknowledged: rows.filter(task => task.pcfConsumedSessionId === task.parentSessionId).length,
    controls: freeze({enabled: backendConfigured && serviceState === 'RUNNING', scope: 'APPROVED_LOCAL_CPU_ONLY',
      reason: backendConfigured ? 'OPPOSITE_HOST_ACCEPTANCE_PENDING' : 'NOT_CONFIGURED'}),
    tasks: freeze(rows.slice(-10).map(task => freeze({id: task.id, appId: task.pcfAppId, state: task.state}))),
    sharingDoesNotImplyExecutionReadiness: true,
  });
}
