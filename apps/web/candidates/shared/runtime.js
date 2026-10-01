/**
 * UI-000 · shared candidate runtime.
 *
 * The candidates are prototypes, but a control that does nothing is not a
 * prototype — it is a false affordance, and it directly contradicts the workbook
 * rule that the three directions "share the same functional facts". Review found
 * 17 such controls across the three directions.
 *
 * This module is the single local model behind every action the candidates
 * expose. It is deliberately:
 *
 *   - SHARED — all three directions import it, so an action produces the same
 *     fact no matter which visual language renders it. Presentation differs;
 *     behaviour does not.
 *   - LOCAL AND DETERMINISTIC — no network, no clock dependence in the produced
 *     facts (ids are sequence-based, not random), so the parity runner and the
 *     screenshots are reproducible.
 *   - HONEST — it never pretends to talk to the Gateway. `openRoom()` opens the
 *     real Room Hub deep link; everything else is a clearly local simulation of
 *     the same state transitions the real product performs.
 *
 * TEMPORARY: deleted with the rest of apps/web/candidates/.
 */
import { DEMO } from './facts.js';

const FINISHED = ['COMPLETED', 'FAILED', 'CANCELLED'];

/** Actions every candidate must offer, in the same order. Enforced by the test. */
export const ACTIONS = [
  'openRoom',
  'openHub',
  'invoke',
  'createDemoTask',
  'cancelTask',
  'startPairing',
  'disconnect',
];

export function createRuntime({ open = true } = {}) {
  const state = {
    tasks: DEMO.city.tasks.map((t) => ({ ...t })),
    invocations: DEMO.city.invocations.map((i) => ({ ...i })),
    events: DEMO.city.events.map((e) => ({ ...e })),
    pairing: null,
    connected: true,
    openedRoom: null,
    openedHub: false,
    taskSeq: 100,
    invocationSeq: 10,
    eventSeq: 41,
    /* The last action performed, so a reviewer (and the parity runner) can see
       that a control is live rather than decorative. */
    lastAction: null,
  };

  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(state));
  const set = (action, patch) => {
    Object.assign(state, patch);
    state.lastAction = action;
    emit();
  };

  const pushEvent = (type, taskId) => {
    state.eventSeq += 1;
    state.events.push({ seq: state.eventSeq, type, taskId, timestamp: DEMO.city.updatedAt, payload: {} });
  };

  const api = {
    get state() { return state; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    activeTasks: () => state.tasks.filter((t) => !FINISHED.includes(t.state)),

    /** Real behaviour: deep-link into the Room Hub at the room's own hash route. */
    openRoom(roomId) {
      const url = `${DEMO.rooms.hubUrl}#/${roomId}`;
      if (state.connected && open && typeof window !== 'undefined') {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      set('openRoom', { openedRoom: { id: roomId, url } });
      return url;
    },

    /** The hub itself, with no room selected. */
    openHub() {
      if (state.connected && open && typeof window !== 'undefined') {
        window.open(DEMO.rooms.hubUrl, '_blank', 'noopener,noreferrer');
      }
      set('openHub', { openedHub: true });
      return DEMO.rooms.hubUrl;
    },

    /** Mirrors a capability invocation: a new history row with a retained digest. */
    invoke(capabilityId) {
      state.invocationSeq += 1;
      const invocationId = `inv-${state.invocationSeq}`;
      state.invocations.push({
        invocationId,
        capabilityId,
        status: 'COMPLETED',
        resultDigest: `sha256:${String(state.invocationSeq).repeat(4).slice(0, 4)}…${capabilityId.slice(0, 4)}`,
        errorCode: null,
      });
      set('invoke', {});
      return invocationId;
    },

    /** Mirrors the product's CHECKPOINT_DEMO task: a running task plus an event. */
    createDemoTask() {
      state.taskSeq += 1;
      const id = `tsk-${state.taskSeq}`;
      state.tasks.push({
        id,
        type: 'CHECKPOINT_DEMO',
        state: 'RUNNING',
        progress: 45,
        assignedNodeId: DEMO.city.nodes[0].id,
        lastCheckpoint: { step: 'hash', at: DEMO.city.updatedAt },
        result: null,
        error: null,
      });
      pushEvent('task.progress', id);
      set('createDemoTask', {});
      return id;
    },

    cancelTask(id) {
      const task = state.tasks.find((t) => t.id === id);
      if (!task || FINISHED.includes(task.state)) return false;
      task.state = 'CANCELLED';
      pushEvent('task.cancelled', id);
      set('cancelTask', {});
      return true;
    },

    /** Mirrors an ephemeral pairing session: short code plus a bounded window. */
    startPairing() {
      const pairing = { shortCode: '4821', expiresInSeconds: 120, cityId: DEMO.city.cityId };
      set('startPairing', { pairing });
      return pairing;
    },

    disconnect() {
      set('disconnect', { connected: false, pairing: null });
    },
  };

  return api;
}

export default { createRuntime, ACTIONS };
