/**
 * UTOPIA · City — Worker Gateway / Worker Task Contract: lifecycle behaviour.
 *
 * Behaviour-identical port of the DS-Hns donor
 * `app/extensions/mega/scheduler/lifecycle.js`
 * (zhiheng-zhang-Mera/DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b).
 *
 * The donor's lifecycle:
 *
 *   QUEUED -> RUNNING -> SUSPENDED -> RUNNING -> TERMINAL
 *   TERMINAL = COMPLETED | FAILED_FINAL | CANCELLED
 *
 * One deliberate adaptation: the donor called `Date.now()` as the `completedAt`
 * fallback inside `buildTerminalEvent`. The clock is now the caller's `now` option, so
 * this module stays pure and deterministic; `now` is consulted only when
 * `task.endedAt` is falsy, exactly where the donor's `||` short-circuited to
 * `Date.now()`. With no clock supplied the fallback is 0, not the current time.
 *
 * Every other function keeps the donor's behaviour, including its quirks: raw
 * (un-normalized) comparison in `statusLabel` and `persistedStatusFor`, the
 * `Math.max(1, max - 1)` ellipsis rule in `truncate`, the `|| null` collapse of a
 * zero `createdAt` / `startedAt` in the terminal payload, and the `JSON.stringify`
 * fallback in `errorSummary` that must never throw.
 */

import {
  ACTIVE_STATUSES,
  CANONICAL_TERMINAL,
  QUEUED_STATUSES,
  TERMINAL_EVENT,
  TERMINAL_STATUSES,
} from './contracts.mjs';

/**
 * Normalize a status spelling: stringify, trim, upper case.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`normalizeStatus`).
 */
export function normalizeStatus(status) {
  return String(status ?? '').trim().toUpperCase();
}

/**
 * Is a worker holding this task right now?
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`isActiveStatus`).
 */
export function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(normalizeStatus(status));
}

/**
 * Is this task waiting for its turn?
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`isQueuedStatus`).
 */
export function isQueuedStatus(status) {
  return QUEUED_STATUSES.includes(normalizeStatus(status));
}

/**
 * Will this task never run again?
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`isTerminalStatus`).
 */
export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(normalizeStatus(status));
}

/**
 * Maps any accepted status (persisted or canonical) onto the canonical terminal
 * vocabulary. Returns null for non-terminal statuses.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`terminalState`).
 */
export function terminalState(status) {
  const s = normalizeStatus(status);
  if (s === CANONICAL_TERMINAL.COMPLETED) return CANONICAL_TERMINAL.COMPLETED;
  if (s === CANONICAL_TERMINAL.FAILED_FINAL || s === 'FAILED') return CANONICAL_TERMINAL.FAILED_FINAL;
  if (s === CANONICAL_TERMINAL.CANCELLED || s === 'CANCELED' || s === 'INTERRUPTED') return CANONICAL_TERMINAL.CANCELLED;
  return null;
}

/**
 * The persisted status a canonical terminal state should be stored as.
 *
 * The donor compares `state` raw (no normalization) and normalizes only the
 * `fallback`; an INTERRUPTED fallback is the one persisted value a CANCELLED state may
 * take instead of CANCELED.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`persistedStatusFor`).
 */
export function persistedStatusFor(state, fallback = 'CANCELED') {
  if (state === CANONICAL_TERMINAL.COMPLETED) return 'COMPLETED';
  if (state === CANONICAL_TERMINAL.FAILED_FINAL) return 'FAILED';
  if (state === CANONICAL_TERMINAL.CANCELLED) return normalizeStatus(fallback) === 'INTERRUPTED' ? 'INTERRUPTED' : 'CANCELED';
  return normalizeStatus(fallback);
}

/**
 * Human readable status label used in notification bodies.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`statusLabel`).
 */
export function statusLabel(state) {
  if (state === CANONICAL_TERMINAL.COMPLETED) return 'Completed';
  if (state === CANONICAL_TERMINAL.FAILED_FINAL) return 'Failed';
  if (state === CANONICAL_TERMINAL.CANCELLED) return 'Cancelled';
  return 'Terminated';
}

/**
 * The first non-empty, trimmed line of a text block.
 * The donor defined this but did not export it.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`firstLine`).
 */
export function firstLine(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

/**
 * Collapse whitespace to single spaces and cut to `max` characters, ending with an
 * ellipsis when the value had to be cut. The donor reserves one character for the
 * ellipsis (`Math.max(1, max - 1)`), so `max: 1` yields one character plus `…`.
 * The donor defined this but did not export it.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`truncate`).
 */
export function truncate(text, max = 72) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Short, notification-safe task name derived from a task record or event.
 *
 * Candidate order, exactly as the donor: `name`, `taskName`, `displayName`, then the
 * first non-empty prompt line, then `id` / `taskId`, then the literal `'task'`. The
 * last rung is returned raw (not truncated), like the donor.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`taskDisplayName`).
 */
export function taskDisplayName(task) {
  if (!task || typeof task !== 'object') return 'task';
  for (const candidate of [task.name, task.taskName, task.displayName]) {
    if (typeof candidate === 'string' && candidate.trim()) return truncate(candidate, 72);
  }
  const line = firstLine(task.prompt);
  if (line) return truncate(line, 72);
  return String(task.id || task.taskId || 'task');
}

/**
 * Short error summary for the terminal event payload (never throws).
 *
 * A `code` and a `message` are joined as `code: message`; an object with neither is
 * serialized as JSON; an object that cannot be serialized (a cycle, a throwing
 * getter at stringify time) yields null instead of throwing.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`errorSummary`).
 */
export function errorSummary(error, max = 160) {
  if (error == null) return null;
  if (typeof error === 'string') return truncate(error, max) || null;
  if (typeof error === 'object') {
    const code = error.code ? String(error.code) : '';
    const message = error.message ? String(error.message) : '';
    const joined = [code, message].filter(Boolean).join(': ');
    if (joined) return truncate(joined, max);
    try {
      return truncate(JSON.stringify(error), max);
    } catch {
      return null;
    }
  }
  return truncate(String(error), max) || null;
}

/**
 * Short positive result summary (duration + delivery target).
 *
 * Formats, exactly as the donor: `Xs`, `Xm Ys` and `Xh Ym`. Returns null when the
 * task is not an object, when either endpoint is missing or zero, or when the end
 * precedes the start. The donor defined this but did not export it.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`shortResult`).
 */
export function shortResult(task, { endedAt } = {}) {
  if (!task || typeof task !== 'object') return null;
  const end = Number(endedAt ?? task.endedAt) || null;
  const start = Number(task.startedAt ?? task.createdAt) || null;
  if (!end || !start || end < start) return null;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Idempotency epoch for one terminal transition of one task. Together with the
 * task id and the canonical final status it forms the notification dedup key.
 * A non-finite, zero or negative candidate collapses to 0; a positive one is
 * truncated towards zero.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`terminalEpoch`).
 */
export function terminalEpoch(task) {
  if (!task || typeof task !== 'object') return 0;
  const candidate = Number(task.endedAt ?? task.terminalEpoch);
  return Number.isFinite(candidate) && candidate > 0 ? Math.trunc(candidate) : 0;
}

/**
 * The notification dedup key, shaped `<id>#<state>#<epoch>`.
 * The state falls back to the normalized final status and then to `'TERMINAL'`.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`terminalKey`).
 */
export function terminalKey(task, finalStatus) {
  const id = String(task?.id ?? task?.taskId ?? 'task');
  const state = terminalState(finalStatus) || normalizeStatus(finalStatus) || 'TERMINAL';
  const epoch = terminalEpoch(task) || Number(task?.terminalEpoch) || 0;
  return `${id}#${state}#${epoch}`;
}

/**
 * Resolve the injected clock to milliseconds. `now` may be a number or a function
 * returning one (e.g. `Date.now`); the injected clock is the only time source this
 * module has. An unusable clock is refused rather than silently replaced.
 *
 * Adaptation: this replaces the donor's `Date.now()` fallback for `completedAt`.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (the one ambient clock read).
 */
function clockMs(now) {
  if (now === undefined || now === null) return 0;
  const value = Number(typeof now === 'function' ? now() : now);
  if (!Number.isFinite(value)) throw new TypeError('buildTerminalEvent now must resolve to a finite number of milliseconds');
  return value;
}

/**
 * Builds the single terminal event payload (TASK_TERMINATED) shared by the
 * scheduler, the notifier and the UI.
 *
 * Payload shape, exactly as the donor's, including:
 *   - `statusLabel` derived from the canonical state, not from the persisted status;
 *   - `shortResult` only for a COMPLETED task, null otherwise;
 *   - null-vs-zero: `exitCode: 0` survives as 0 while a zero `createdAt` / `startedAt`
 *     collapses to null, and `attempts` collapses to 0;
 *   - `source` defaults to `'official-session'` when `task.deliveryMode` is
 *     `'official-session'`, else `'queue'`;
 *   - `reason` is carried verbatim (stringified) and is never restricted to REASONS;
 *   - the canonical state falls back to CANCELLED for a non-terminal or missing status.
 *
 * Adaptation: `options.now` is the injected clock (see the module header) and replaces
 * the donor's `Date.now()` fallback for `completedAt`.
 * Donor: `lifecycle.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b (`buildTerminalEvent`).
 *
 * @param {object} task the task record, or anything else (it degrades like the donor's)
 * @param {{finalStatus?: string, status?: string, reason?: unknown, source?: string|null,
 *          exitCode?: number|null, now?: number|(() => number)}} [options]
 */
export function buildTerminalEvent(task, { finalStatus, status, reason = null, source = null, exitCode = null, now } = {}) {
  const id = String(task?.id ?? task?.taskId ?? 'task');
  const state = terminalState(finalStatus || status) || CANONICAL_TERMINAL.CANCELLED;
  const completedAt = Number(task?.endedAt) || clockMs(now);
  const taskName = taskDisplayName(task);
  const summary = errorSummary(task?.error);
  return {
    type: TERMINAL_EVENT,
    taskId: id,
    id,
    taskName,
    displayName: taskName,
    finalStatus: state,
    status: normalizeStatus(status || finalStatus),
    statusLabel: statusLabel(state),
    terminalEpoch: terminalEpoch(task),
    terminalKey: terminalKey(task, state),
    completedAt,
    endedAt: completedAt,
    shortResult: state === CANONICAL_TERMINAL.COMPLETED ? shortResult(task, { endedAt: completedAt }) : null,
    errorSummary: summary,
    reason: reason == null ? null : String(reason),
    source: source || (task?.deliveryMode === 'official-session' ? 'official-session' : 'queue'),
    exitCode: exitCode == null ? null : Number(exitCode),
    deliveryMode: task?.deliveryMode || null,
    officialSessionId: task?.officialSessionId || null,
    attempts: Number(task?.attempts || 0),
    createdAt: Number(task?.createdAt) || null,
    startedAt: Number(task?.startedAt) || null,
    promptPreview: typeof task?.prompt === 'string' ? truncate(task.prompt, 160) : null
  };
}
