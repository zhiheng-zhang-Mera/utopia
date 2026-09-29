/**
 * UTOPIA · City Core — fleet node model and deterministic routing.
 *
 * Ported from the Codex-Boss donor `src/shared/fleet.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * Pure and platform-neutral: every field is a plain serializable string, number or
 * array, and every input — including `now` — is a parameter, so two honest runs over
 * the same inputs produce the same assignment.
 *
 * Node lifecycle: READY → (heartbeat missed) DEGRADED → OFFLINE; FAILED/DISABLED never
 * accept work. Routing only ever places work on a node whose observed state can accept
 * it AND that exposes every required capability. Dropout handling keeps unrelated work
 * untouched and checkpointed work transferable.
 *
 * The donor's `nodeStateFor` is exported here as `fleetNodeStateFor`, because the
 * donor's `src/shared/node-capabilities.ts` exports a different function with the same
 * name; that one lives in `./capability-routing.mjs` as `probeNodeStateFor` and is
 * never merged with this one.
 */

import {
  DEGRADED_AFTER_MS,
  DROPOUT_FAILED_PREFIX,
  DROPOUT_FAILED_SUFFIX,
  DROPOUT_REASSIGN_PREFIX,
  DROPOUT_TRANSFERRED_PREFIX,
  DROPOUT_TRANSFERRED_SUFFIX,
  FLEET_NODE_STATES_REFUSING_WORK,
  OFFLINE_AFTER_MS,
  ROUTE_QUEUED_HISTORY,
  ROUTE_QUEUED_NOTE,
} from './contracts.mjs';

/**
 * Deterministic node state from the last observed heartbeat.
 *
 * The window is closed at both thresholds and checked offline-first: an age of exactly
 * OFFLINE_AFTER_MS is OFFLINE, an age of exactly DEGRADED_AFTER_MS is DEGRADED, and
 * anything below is READY.
 *
 * @param {number} now              caller-supplied clock (ms)
 * @param {{lastHeartbeatAt: number}} node
 * @returns {"READY" | "DEGRADED" | "OFFLINE"}
 */
export function fleetNodeStateFor(now, node) {
  const age = now - node.lastHeartbeatAt;
  if (age >= OFFLINE_AFTER_MS) return 'OFFLINE';
  if (age >= DEGRADED_AFTER_MS) return 'DEGRADED';
  return 'READY';
}

/**
 * Can this node accept this task?
 *
 * A refused state is refused whatever capabilities are listed, and every required
 * capability must be present — a missing one is never assumed.
 *
 * @param {{state: string, capabilities: string[]}} node
 * @param {{requiredCapabilities: string[]}} task
 */
export function acceptsWork(node, task) {
  if (FLEET_NODE_STATES_REFUSING_WORK.includes(node.state)) return false;
  return task.requiredCapabilities.every((capability) => node.capabilities.includes(capability));
}

/**
 * Deterministic first-fit routing over nodes in join order.
 *
 * A candidate produces an ASSIGNED assignment naming it. No candidate produces a
 * QUEUED assignment with `attempts: 0` and the queue reason in its history plus a
 * top-level `note`, so a task that was never placed never looks like it was.
 *
 * @param {{taskId: string, requiredCapabilities?: string[], checkpoint?: unknown, replaySafe?: boolean}} task
 * @param {Array<{nodeId: string, state: string, capabilities: string[], lastHeartbeatAt: number, seq?: number}>} nodes
 * @returns {{assignment: object, note?: string}}
 */
export function routeTask(task, nodes) {
  const candidate = nodes.find((node) => acceptsWork(node, task));
  if (!candidate) {
    return {
      assignment: { ...task, state: 'QUEUED', attempts: 0, history: [ROUTE_QUEUED_HISTORY] },
      note: ROUTE_QUEUED_NOTE,
    };
  }
  return {
    assignment: {
      ...task,
      state: 'ASSIGNED',
      nodeId: candidate.nodeId,
      attempts: 0,
      history: [`assigned:${candidate.nodeId}`],
    },
  };
}

/**
 * Node dropout handling.
 *
 * Work that belongs to another node, or that already COMPLETED, is returned as the
 * very same object (identity-preserving), so a dropout can never disturb it.
 *
 * Work owned by the lost node is resolved honestly:
 *   - CHECKPOINTED   → QUEUED, placement cleared, attempts + 1, transfer recorded;
 *   - replay-safe    → QUEUED, placement cleared, attempts + 1, reassignment recorded;
 *   - otherwise      → FAILED, placement cleared, attempts unchanged, failure recorded.
 *
 * The donor's replay-safety test is `replaySafe !== false`, so omitted means safe.
 *
 * @param {object[]} assignments
 * @param {string} nodeId
 * @returns {object[]}
 */
export function handleNodeDropout(assignments, nodeId) {
  return assignments.map((assignment) => {
    if (assignment.nodeId !== nodeId || assignment.state === 'COMPLETED') return assignment;
    if (assignment.state === 'CHECKPOINTED') {
      return {
        ...assignment,
        state: 'QUEUED',
        nodeId: undefined,
        attempts: assignment.attempts + 1,
        history: [...assignment.history, `${DROPOUT_TRANSFERRED_PREFIX}${nodeId}${DROPOUT_TRANSFERRED_SUFFIX}`],
      };
    }
    if (assignment.replaySafe !== false) {
      return {
        ...assignment,
        state: 'QUEUED',
        nodeId: undefined,
        attempts: assignment.attempts + 1,
        history: [...assignment.history, `${DROPOUT_REASSIGN_PREFIX}${nodeId}`],
      };
    }
    return {
      ...assignment,
      state: 'FAILED',
      nodeId: undefined,
      history: [...assignment.history, `${DROPOUT_FAILED_PREFIX}${nodeId}${DROPOUT_FAILED_SUFFIX}`],
    };
  });
}
