// Auxiliary reservations and attempts share the existing canonical SQLite owner.
// No PCF task table, replica, token database or separate writer exists.
import {requireThat as ok} from './validation.mjs';
const KEY = 'pcf.execution.v1';
const empty = () => ({version: 0, epoch: 0, reservations: [], attempts: [], completedKeys: []});

/**
 * The bound on a snapshot is the STORE's own, not the untrusted-input guard.
 *
 * `validation.copy()` bounds an incoming payload at 64 KiB, which is right for something a caller handed us and wrong
 * for the state we produced ourselves: PCF-704 admission permits 256 reservations, and 256 real records serialise well
 * past 64 KiB, so the old snapshot() threw PAYLOAD_LIMIT at exactly the queue depth admission allows - the observer
 * side of "queue full is explicitly disclosed" could not read the state at all. The limit here is declared, generous
 * and typed, and the state is bounded by construction because admission enforces the reservation/attempt ceilings.
 */
export const SNAPSHOT_LIMITS = Object.freeze({maxBytes: 4 * 1024 * 1024});
export function createCanonicalStateAdapter(store) {
  const read = () => {
    const row = store.db.prepare('SELECT value FROM settings WHERE key=?').get(KEY);
    return row ? JSON.parse(row.value) : empty();
  };
  return {
    snapshot: ({maxBytes = SNAPSHOT_LIMITS.maxBytes} = {}) => {
      const state = read();
      const bytes = Buffer.byteLength(JSON.stringify(state));
      ok(bytes <= maxBytes, 'SNAPSHOT_LIMIT:' + bytes + '>' + maxBytes);
      return structuredClone(state);
    },
    transaction(expectedVersion, mutate) {
      return store.atomic(() => {
        const state = read();
        if (expectedVersion !== undefined) ok(state.version === expectedVersion, 'STALE_CANONICAL_VERSION');
        const result = mutate(state, {getTask: id => store.get('tasks', id), putTask: t => store.put('tasks', t)});
        state.version++;
        store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, JSON.stringify(state));
        return {...result, version: state.version};
      });
    },
  };
}
