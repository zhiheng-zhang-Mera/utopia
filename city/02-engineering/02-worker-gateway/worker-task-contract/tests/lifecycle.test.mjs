/**
 * UTOPIA · City — Worker Gateway / Worker Task Contract: lifecycle suite.
 *
 * Every assertion here restates behaviour of the DS-Hns donor
 * `app/extensions/mega/scheduler/lifecycle.js`
 * (zhiheng-zhang-Mera/DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b).
 *
 * The one deliberate adaptation is asserted too: `buildTerminalEvent` takes its clock
 * as an injected option instead of calling `Date.now()`, so the payload is
 * deterministic and no test here has to freeze the global clock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVE_STATUSES,
  CANONICAL_TERMINAL,
  QUEUED_STATUSES,
  REASONS,
  TERMINAL_EVENT,
  TERMINAL_STATUSES,
  activeStatuses,
  canonicalTerminal,
  isCanonicalTerminal,
  isKnownReason,
  isKnownStatus,
  queuedStatuses,
  reasons,
  requireCanonicalTerminal,
  requireKnownReason,
  requireKnownStatus,
  terminalStatuses,
} from '../contracts.mjs';

import {
  buildTerminalEvent,
  errorSummary,
  firstLine,
  isActiveStatus,
  isQueuedStatus,
  isTerminalStatus,
  normalizeStatus,
  persistedStatusFor,
  shortResult,
  statusLabel,
  taskDisplayName,
  terminalEpoch,
  terminalKey,
  terminalState,
  truncate,
} from '../lifecycle.mjs';

import * as publicSurface from '../index.mjs';

/** A clock that must never be read, for the cases where `task.endedAt` decides. */
function forbiddenClock() {
  throw new Error('the injected clock must not be read when task.endedAt is set');
}

test('the contract carries the donor vocabulary, in the donor order', () => {
  assert.equal(TERMINAL_EVENT, 'TASK_TERMINATED');

  assert.deepEqual(Object.keys(CANONICAL_TERMINAL), ['COMPLETED', 'FAILED_FINAL', 'CANCELLED']);
  assert.deepEqual(canonicalTerminal(), { COMPLETED: 'COMPLETED', FAILED_FINAL: 'FAILED_FINAL', CANCELLED: 'CANCELLED' });

  assert.deepEqual([...TERMINAL_STATUSES], ['COMPLETED', 'FAILED', 'FAILED_FINAL', 'CANCELED', 'CANCELLED', 'INTERRUPTED']);
  assert.deepEqual([...ACTIVE_STATUSES], ['DISPATCHING', 'RUNNING']);
  assert.deepEqual([...QUEUED_STATUSES], ['PENDING', 'SUSPENDED']);
  assert.deepEqual(reasons(), {
    USER_CANCEL: 'user-cancel',
    QUEUE_CLEARED: 'queue-cleared',
    REMOVED: 'removed',
    APP_QUIT: 'app-quit',
    APP_RESTART: 'app-restart',
    PEAK_PAUSE: 'peak-pause',
    STALL_RETRY: 'stall-retry',
  });
  assert.deepEqual(Object.values(REASONS), [
    'user-cancel',
    'queue-cleared',
    'removed',
    'app-quit',
    'app-restart',
    'peak-pause',
    'stall-retry',
  ]);

  for (const list of [TERMINAL_STATUSES, ACTIVE_STATUSES, QUEUED_STATUSES]) {
    assert.ok(Object.isFrozen(list), 'the donor vocabularies are frozen');
    assert.throws(() => list.push('NOPE'), TypeError);
  }
  assert.ok(Object.isFrozen(CANONICAL_TERMINAL));
  assert.ok(Object.isFrozen(REASONS));
});

test('factories copy on construct: mutating a result never touches the vocabulary', () => {
  const statuses = terminalStatuses();
  statuses.push('INVENTED');
  assert.deepEqual([...TERMINAL_STATUSES], ['COMPLETED', 'FAILED', 'FAILED_FINAL', 'CANCELED', 'CANCELLED', 'INTERRUPTED']);
  assert.notEqual(statuses, TERMINAL_STATUSES);

  const actives = activeStatuses();
  actives.length = 0;
  assert.deepEqual([...ACTIVE_STATUSES], ['DISPATCHING', 'RUNNING']);

  const queued = queuedStatuses();
  queued[0] = 'INVENTED';
  assert.deepEqual([...QUEUED_STATUSES], ['PENDING', 'SUSPENDED']);

  const canonical = canonicalTerminal();
  canonical.COMPLETED = 'INVENTED';
  assert.equal(CANONICAL_TERMINAL.COMPLETED, 'COMPLETED');

  const vocabulary = reasons();
  vocabulary.USER_CANCEL = 'invented';
  assert.equal(REASONS.USER_CANCEL, 'user-cancel');
  assert.equal(reasons().USER_CANCEL, 'user-cancel');
});

test('validators refuse invalid input instead of turning it into valid input', () => {
  assert.equal(isCanonicalTerminal('COMPLETED'), true);
  assert.equal(isCanonicalTerminal('FAILED_FINAL'), true);
  assert.equal(isCanonicalTerminal('CANCELLED'), true);
  assert.equal(isCanonicalTerminal('completed'), false, 'no normalization');
  assert.equal(isCanonicalTerminal(' CANCELLED'), false, 'no trimming');
  assert.equal(isCanonicalTerminal('FAILED'), false, 'the persisted spelling is not canonical');
  assert.equal(isCanonicalTerminal(undefined), false);

  assert.equal(requireCanonicalTerminal('FAILED_FINAL'), 'FAILED_FINAL');
  assert.throws(() => requireCanonicalTerminal('failed_final'), TypeError);
  assert.throws(() => requireCanonicalTerminal('FAILED'), TypeError);
  assert.throws(() => requireCanonicalTerminal(''), TypeError);

  assert.equal(isKnownStatus('RUNNING'), true);
  assert.equal(isKnownStatus('INTERRUPTED'), true);
  assert.equal(isKnownStatus('FAILED_FINAL'), true);
  assert.equal(isKnownStatus('running'), false);
  assert.equal(isKnownStatus('PAUSED'), false);
  assert.equal(requireKnownStatus('PENDING'), 'PENDING');
  assert.throws(() => requireKnownStatus('pending'), TypeError);
  assert.throws(() => requireKnownStatus('RUNNING '), TypeError);

  assert.equal(isKnownReason('user-cancel'), true);
  assert.equal(isKnownReason('USER_CANCEL'), false, 'the key is not the value');
  assert.equal(requireKnownReason('stall-retry'), 'stall-retry');
  assert.throws(() => requireKnownReason('made-up'), TypeError);
});

test('every status lands in exactly one of the three status classes', () => {
  const expectations = {
    PENDING: [false, true, false],
    SUSPENDED: [false, true, false],
    DISPATCHING: [true, false, false],
    RUNNING: [true, false, false],
    COMPLETED: [false, false, true],
    FAILED: [false, false, true],
    FAILED_FINAL: [false, false, true],
    CANCELED: [false, false, true],
    CANCELLED: [false, false, true],
    INTERRUPTED: [false, false, true],
    PAUSED: [false, false, false],
  };

  for (const [status, [active, queued, terminal]] of Object.entries(expectations)) {
    assert.equal(isActiveStatus(status), active, `${status} active`);
    assert.equal(isQueuedStatus(status), queued, `${status} queued`);
    assert.equal(isTerminalStatus(status), terminal, `${status} terminal`);
  }

  // The donor's predicates normalize their input; the unknown spellings stay unknown.
  assert.equal(isActiveStatus('  running '), true);
  assert.equal(isQueuedStatus('pending'), true);
  assert.equal(isTerminalStatus('interrupted'), true);
  assert.equal(isActiveStatus(null), false);
  assert.equal(isQueuedStatus(undefined), false);
  assert.equal(isTerminalStatus({}), false);
});

test('normalizeStatus trims and upper-cases', () => {
  assert.equal(normalizeStatus('  running '), 'RUNNING');
  assert.equal(normalizeStatus('Failed_Final'), 'FAILED_FINAL');
  assert.equal(normalizeStatus('\tPENDING\r\n'), 'PENDING');
  assert.equal(normalizeStatus(''), '');
  assert.equal(normalizeStatus(null), '');
  assert.equal(normalizeStatus(undefined), '');
  assert.equal(normalizeStatus(7), '7');
});

test('terminalState classifies all six persisted spellings and refuses the rest', () => {
  assert.equal(terminalState('COMPLETED'), CANONICAL_TERMINAL.COMPLETED);
  assert.equal(terminalState('FAILED_FINAL'), CANONICAL_TERMINAL.FAILED_FINAL);
  assert.equal(terminalState('FAILED'), CANONICAL_TERMINAL.FAILED_FINAL, 'FAILED => FAILED_FINAL');
  assert.equal(terminalState('CANCELLED'), CANONICAL_TERMINAL.CANCELLED);
  assert.equal(terminalState('CANCELED'), CANONICAL_TERMINAL.CANCELLED, 'CANCELED => CANCELLED');
  assert.equal(terminalState('INTERRUPTED'), CANONICAL_TERMINAL.CANCELLED, 'INTERRUPTED => CANCELLED');
  assert.equal(terminalState('  failed '), CANONICAL_TERMINAL.FAILED_FINAL, 'input is normalized first');

  assert.equal(terminalState('RUNNING'), null);
  assert.equal(terminalState('DISPATCHING'), null);
  assert.equal(terminalState('PENDING'), null);
  assert.equal(terminalState('SUSPENDED'), null);
  assert.equal(terminalState(''), null);
  assert.equal(terminalState(null), null);
  assert.equal(terminalState(undefined), null);
});

test('persistedStatusFor keeps the persisted vocabulary backward compatible', () => {
  assert.equal(persistedStatusFor(CANONICAL_TERMINAL.COMPLETED), 'COMPLETED');
  assert.equal(persistedStatusFor(CANONICAL_TERMINAL.FAILED_FINAL), 'FAILED');
  assert.equal(persistedStatusFor(CANONICAL_TERMINAL.CANCELLED), 'CANCELED', 'the default fallback');

  assert.equal(persistedStatusFor(CANONICAL_TERMINAL.CANCELLED, 'INTERRUPTED'), 'INTERRUPTED');
  assert.equal(persistedStatusFor(CANONICAL_TERMINAL.CANCELLED, ' interrupted '), 'INTERRUPTED', 'the fallback is normalized');
  assert.equal(persistedStatusFor(CANONICAL_TERMINAL.CANCELLED, 'COMPLETED'), 'CANCELED', 'only INTERRUPTED is special');
  assert.equal(persistedStatusFor(CANONICAL_TERMINAL.CANCELLED, null), 'CANCELED');

  assert.equal(persistedStatusFor('PENDING'), 'CANCELED', 'an unknown state returns the default fallback');
  assert.equal(persistedStatusFor('PENDING', 'FAILED'), 'FAILED');
  assert.equal(persistedStatusFor('PENDING', ' interrupted '), 'INTERRUPTED');
  assert.equal(persistedStatusFor('completed'), 'CANCELED', 'the state is compared raw, not normalized');
});

test('statusLabel names the three canonical states and falls back to Terminated', () => {
  assert.equal(statusLabel(CANONICAL_TERMINAL.COMPLETED), 'Completed');
  assert.equal(statusLabel(CANONICAL_TERMINAL.FAILED_FINAL), 'Failed');
  assert.equal(statusLabel(CANONICAL_TERMINAL.CANCELLED), 'Cancelled');
  assert.equal(statusLabel('PENDING'), 'Terminated');
  assert.equal(statusLabel('FAILED'), 'Terminated', 'the persisted spelling is not the canonical state');
  assert.equal(statusLabel('completed'), 'Terminated', 'raw comparison only');
  assert.equal(statusLabel(null), 'Terminated');
  assert.equal(statusLabel(undefined), 'Terminated');
});

test('firstLine returns the first non-empty trimmed line', () => {
  assert.equal(firstLine('\n\n   hello  \nsecond line'), 'hello');
  assert.equal(firstLine('one line'), 'one line');
  assert.equal(firstLine('first\r\nsecond'), 'first');
  assert.equal(firstLine('   \n\t\n'), '');
  assert.equal(firstLine(''), '');
  assert.equal(firstLine(null), '');
  assert.equal(firstLine(undefined), '');
  assert.equal(firstLine(42), '42');
});

test('truncate collapses whitespace and reserves one character for the ellipsis', () => {
  assert.equal(truncate('abcd', 5), 'abcd', 'below the limit');
  assert.equal(truncate('abcde', 5), 'abcde', 'exactly at the limit: the limit is inclusive, no ellipsis');
  assert.equal(truncate('abcdef', 5), 'abcd…', 'above the limit: max-1 characters then the ellipsis');
  assert.equal(truncate('abcde', 6), 'abcde');
  assert.equal(truncate('abcdef', 6), 'abcdef', 'six characters still fit a limit of six');
  assert.equal(truncate('abcdefg', 6), 'abcde…', 'one character above the limit cuts to max-1');
  assert.equal(truncate('abcdef', 1), 'a…', 'Math.max(1, max-1) never produces an empty head');
  assert.equal(truncate('  a\n\n\tb  ', 10), 'a b', 'whitespace collapses to single spaces');
  assert.equal(truncate('', 10), '');
  assert.equal(truncate(null, 10), '');
  assert.equal(truncate(undefined, 10), '');
  assert.equal(truncate(42, 10), '42');

  assert.equal(truncate('x'.repeat(72), 72), 'x'.repeat(72), 'the default limit is 72');
  assert.equal(truncate('x'.repeat(73), 72), `${'x'.repeat(71)}…`);
  assert.equal(truncate('x'.repeat(73)).length, 72);
  assert.equal(truncate('x'.repeat(500), 160), `${'x'.repeat(159)}…`);
});

test('taskDisplayName walks the donor candidate order', () => {
  assert.equal(taskDisplayName({ name: '  My   Task ', id: 'x' }), 'My Task', 'name first, collapsed');
  assert.equal(taskDisplayName({ taskName: 'Task name', displayName: 'Display', id: 'x' }), 'Task name');
  assert.equal(taskDisplayName({ displayName: 'Display name', prompt: 'prompt line', id: 'x' }), 'Display name');
  assert.equal(taskDisplayName({ name: '   ', taskName: ' From taskName ', id: 'x' }), 'From taskName', 'blank name is skipped');
  assert.equal(taskDisplayName({ name: 7, taskName: 'From taskName' }), 'From taskName', 'a non-string candidate is skipped');
  assert.equal(
    taskDisplayName({ prompt: '\n\n  first real line\nsecond line', id: 'x' }),
    'first real line',
    'prompt falls back to its first non-empty line',
  );
  assert.equal(taskDisplayName({ prompt: '   \n  ', id: 'task-9' }), 'task-9', 'an empty prompt falls through to id');
  assert.equal(taskDisplayName({ taskId: 'task-8' }), 'task-8');
  assert.equal(taskDisplayName({ name: 'named', id: 'task-7' }), 'named', 'id is only reached last');
  assert.equal(taskDisplayName({}), 'task', 'the literal fallback');
  assert.equal(taskDisplayName({ id: '' }), 'task');
  assert.equal(taskDisplayName(null), 'task');
  assert.equal(taskDisplayName(undefined), 'task');
  assert.equal(taskDisplayName('a string task'), 'task', 'a non-object is not a task record');
  assert.equal(taskDisplayName({ name: 'y'.repeat(100) }), `${'y'.repeat(71)}…`, 'the chosen name is truncated to 72');
  assert.equal(taskDisplayName({ id: 'y'.repeat(100) }), 'y'.repeat(100), 'the id rung is returned raw, like the donor');
});

test('errorSummary joins code and message, degrades to JSON, and never throws', () => {
  assert.equal(errorSummary(null), null);
  assert.equal(errorSummary(undefined), null);
  assert.equal(errorSummary('boom'), 'boom');
  assert.equal(errorSummary('   '), null, 'an empty summary is null, not an empty string');
  assert.equal(errorSummary('multi\nline  error'), 'multi line error');
  assert.equal(errorSummary(42), '42');
  assert.equal(errorSummary(false), 'false');
  assert.equal(errorSummary(true), 'true');

  assert.equal(errorSummary({ code: 'E_SPAWN', message: 'spawn failed' }), 'E_SPAWN: spawn failed');
  assert.equal(errorSummary({ code: 'E_SPAWN' }), 'E_SPAWN');
  assert.equal(errorSummary({ message: 'only a message' }), 'only a message');
  assert.equal(errorSummary({ code: 'E_SPAWN', message: '' }), 'E_SPAWN', 'an empty message is dropped from the join');
  assert.equal(
    errorSummary({ code: 'E_SPAWN', message: '  ' }),
    'E_SPAWN:',
    'a blank message is not empty, so the join still happens and truncate then trims the separator',
  );
  assert.equal(errorSummary({ message: 42 }), '42', 'the message is stringified');

  assert.equal(errorSummary({ code: '', message: '' }), '{"code":"","message":""}', 'JSON fallback for an object with neither');
  assert.equal(errorSummary({ detail: 'x' }), '{"detail":"x"}');
  assert.equal(errorSummary([{ detail: 'x' }]), '[{"detail":"x"}]');

  const circular = { detail: 'x' };
  circular.self = circular;
  assert.doesNotThrow(() => errorSummary(circular));
  assert.equal(errorSummary(circular), null, 'an unserializable object cannot become a summary');

  const hostile = {};
  Object.defineProperty(hostile, 'detail', {
    enumerable: true,
    get() {
      throw new Error('cannot read');
    },
  });
  assert.doesNotThrow(() => errorSummary(hostile));
  assert.equal(errorSummary(hostile), null);

  assert.equal(errorSummary('e'.repeat(50), 10), `${'e'.repeat(9)}…`, 'max is honoured');
  assert.equal(errorSummary({ code: 'C'.repeat(100), message: 'M'.repeat(100) }), `${`${'C'.repeat(100)}: ${'M'.repeat(100)}`.slice(0, 159)}…`);
});

test('shortResult formats Xs / Xm Ys / Xh Ym and refuses incomplete tasks', () => {
  const base = { createdAt: 1_000_000, startedAt: 1_000_000 };

  assert.equal(shortResult({ ...base, endedAt: 1_000_000 }), '0s');
  assert.equal(shortResult({ ...base, endedAt: 1_005_000 }), '5s');
  assert.equal(shortResult({ ...base, endedAt: 1_059_000 }), '59s');
  assert.equal(shortResult({ ...base, endedAt: 1_060_000 }), '1m 0s');
  assert.equal(shortResult({ ...base, endedAt: 1_065_000 }), '1m 5s');
  assert.equal(shortResult({ ...base, endedAt: 1_000_000 + 3_599_000 }), '59m 59s');
  assert.equal(shortResult({ ...base, endedAt: 1_000_000 + 3_600_000 }), '1h 0m');
  assert.equal(shortResult({ ...base, endedAt: 1_000_000 + 3_660_000 }), '1h 1m');
  assert.equal(shortResult({ ...base, endedAt: 1_000_000 + 7_500_000 }), '2h 5m');
  assert.equal(shortResult({ ...base, endedAt: 1_000_000 + 2_500 }), '3s', 'sub-second durations round');
  assert.equal(shortResult({ createdAt: 1_000_000, endedAt: 1_002_000 }), '2s', 'startedAt falls back to createdAt');

  assert.equal(shortResult({ endedAt: 1_002_000, startedAt: 1_000_000 }, { endedAt: 1_010_000 }), '10s', 'the endedAt option wins');
  assert.equal(shortResult({ endedAt: 1_002_000, startedAt: 1_000_000 }, { endedAt: 0 }), null, 'a zero override is not an end time');

  assert.equal(shortResult(null), null);
  assert.equal(shortResult(undefined), null);
  assert.equal(shortResult('task'), null);
  assert.equal(shortResult({}), null);
  assert.equal(shortResult({ endedAt: 1_000_000 }), null, 'no start');
  assert.equal(shortResult({ startedAt: 1_000_000 }), null, 'no end');
  assert.equal(shortResult({ startedAt: 0, endedAt: 1_000_000 }), null, 'a zero start is not a start time');
  assert.equal(shortResult({ startedAt: 2_000_000, endedAt: 1_000_000 }), null, 'an end before the start is refused');
});

test('terminalEpoch truncates a positive instant and collapses everything else to 0', () => {
  assert.equal(terminalEpoch({ endedAt: 1_700_000_000_123 }), 1_700_000_000_123);
  assert.equal(terminalEpoch({ endedAt: 1_700_000_000_123.9 }), 1_700_000_000_123, 'Math.trunc, not round');
  assert.equal(terminalEpoch({ endedAt: '1700000000000' }), 1_700_000_000_000);
  assert.equal(terminalEpoch({ terminalEpoch: 555 }), 555, 'the donor falls back to terminalEpoch');
  assert.equal(terminalEpoch({ endedAt: 0 }), 0);
  assert.equal(terminalEpoch({ endedAt: 0, terminalEpoch: 555 }), 0, 'endedAt wins even when it is 0');
  assert.equal(terminalEpoch({ endedAt: -5 }), 0);
  assert.equal(terminalEpoch({ endedAt: 'not a time' }), 0);
  assert.equal(terminalEpoch({}), 0);
  assert.equal(terminalEpoch(null), 0);
  assert.equal(terminalEpoch(undefined), 0);
  assert.equal(terminalEpoch('task'), 0);
});

test('terminalKey is <id>#<state>#<epoch>, including the epoch-0 case', () => {
  assert.equal(terminalKey({ id: 'task-1', endedAt: 1_700_000_000_000 }, 'FAILED'), 'task-1#FAILED_FINAL#1700000000000');
  assert.equal(terminalKey({ id: 'task-1', endedAt: 1_700_000_000_000 }, 'COMPLETED'), 'task-1#COMPLETED#1700000000000');
  assert.equal(terminalKey({ id: 'task-1', endedAt: 0 }, 'COMPLETED'), 'task-1#COMPLETED#0', 'zero epoch is a real key');
  assert.equal(terminalKey({ id: 'task-1' }, 'COMPLETED'), 'task-1#COMPLETED#0');
  assert.equal(terminalKey({ taskId: 'task-2' }, 'INTERRUPTED'), 'task-2#CANCELLED#0', 'the persisted spelling classifies');
  assert.equal(terminalKey({}, 'COMPLETED'), 'task#COMPLETED#0');
  assert.equal(terminalKey({ id: 't', terminalEpoch: 99 }, 'CANCELLED'), 't#CANCELLED#99');
  assert.equal(terminalKey({ id: 't', terminalEpoch: 99.7 }, 'CANCELLED'), 't#CANCELLED#99');
  assert.equal(terminalKey({ id: 't' }, 'PENDING'), 't#PENDING#0', 'a non-terminal status is kept, normalized');
  assert.equal(terminalKey({ id: 't' }, ' pending '), 't#PENDING#0');
  assert.equal(terminalKey({ id: 't' }), 't#TERMINAL#0', 'no status at all');
  assert.equal(terminalKey(null, 'COMPLETED'), 'task#COMPLETED#0');
});

test('buildTerminalEvent builds the full COMPLETED payload', () => {
  const task = {
    id: 'task-1',
    name: 'Fix   the\nworker gateway',
    prompt: 'Fix the worker gateway\nmore detail here',
    status: 'RUNNING',
    deliveryMode: 'queue',
    officialSessionId: null,
    attempts: 1,
    createdAt: 1_000_000,
    startedAt: 1_000_500,
    endedAt: 1_006_500,
    error: null,
  };

  const event = buildTerminalEvent(task, {
    finalStatus: CANONICAL_TERMINAL.COMPLETED,
    status: 'COMPLETED',
    exitCode: 0,
    now: forbiddenClock,
  });

  assert.deepEqual(event, {
    type: TERMINAL_EVENT,
    taskId: 'task-1',
    id: 'task-1',
    taskName: 'Fix the worker gateway',
    displayName: 'Fix the worker gateway',
    finalStatus: 'COMPLETED',
    status: 'COMPLETED',
    statusLabel: 'Completed',
    terminalEpoch: 1_006_500,
    terminalKey: 'task-1#COMPLETED#1006500',
    completedAt: 1_006_500,
    endedAt: 1_006_500,
    shortResult: '6s',
    errorSummary: null,
    reason: null,
    source: 'queue',
    exitCode: 0,
    deliveryMode: 'queue',
    officialSessionId: null,
    attempts: 1,
    createdAt: 1_000_000,
    startedAt: 1_000_500,
    promptPreview: 'Fix the worker gateway more detail here',
  });
});

test('buildTerminalEvent builds the full FAILED_FINAL payload with its error', () => {
  const task = {
    id: 'task-2',
    taskName: '  Deploy  worker  ',
    status: 'FAILED',
    deliveryMode: 'official-session',
    officialSessionId: 'session-9',
    attempts: 3,
    createdAt: 2_000_000,
    startedAt: 2_000_100,
    endedAt: 2_040_100,
    error: { code: 'E_SPAWN', message: 'spawn failed' },
  };

  const event = buildTerminalEvent(task, {
    finalStatus: CANONICAL_TERMINAL.FAILED_FINAL,
    status: 'FAILED',
    reason: REASONS.STALL_RETRY,
    exitCode: 1,
    now: forbiddenClock,
  });

  assert.deepEqual(event, {
    type: TERMINAL_EVENT,
    taskId: 'task-2',
    id: 'task-2',
    taskName: 'Deploy worker',
    displayName: 'Deploy worker',
    finalStatus: 'FAILED_FINAL',
    status: 'FAILED',
    statusLabel: 'Failed',
    terminalEpoch: 2_040_100,
    terminalKey: 'task-2#FAILED_FINAL#2040100',
    completedAt: 2_040_100,
    endedAt: 2_040_100,
    shortResult: null,
    errorSummary: 'E_SPAWN: spawn failed',
    reason: 'stall-retry',
    source: 'official-session',
    exitCode: 1,
    deliveryMode: 'official-session',
    officialSessionId: 'session-9',
    attempts: 3,
    createdAt: 2_000_000,
    startedAt: 2_000_100,
    promptPreview: null,
  });
});

test('buildTerminalEvent keeps the null-vs-zero distinctions of the donor', () => {
  const event = buildTerminalEvent(
    { id: 'task-3', createdAt: 0, startedAt: 0, attempts: '3', exitCode: 0 },
    { finalStatus: 'CANCELLED', exitCode: 0, now: 1 },
  );

  assert.equal(event.exitCode, 0, 'exitCode 0 survives as 0');
  assert.equal(event.createdAt, null, 'createdAt 0 collapses to null');
  assert.equal(event.startedAt, null, 'startedAt 0 collapses to null');
  assert.equal(event.attempts, 3, 'attempts is numeric');
  assert.equal(event.deliveryMode, null);
  assert.equal(event.officialSessionId, null);
  assert.equal(event.promptPreview, null);
  assert.equal(event.shortResult, null);

  const missing = buildTerminalEvent({ id: 'task-3b' }, { finalStatus: 'CANCELLED' });
  assert.equal(missing.exitCode, null, 'a missing exitCode is null');
  assert.equal(missing.attempts, 0, 'a missing attempts is 0');
  assert.equal(missing.createdAt, null);
  assert.equal(missing.startedAt, null);

  const stringy = buildTerminalEvent({ id: 'task-3c' }, { finalStatus: 'CANCELLED', exitCode: '1' });
  assert.equal(stringy.exitCode, 1);
  assert.equal(stringy.source, 'queue', 'the source default');
});

test('buildTerminalEvent defaults the source and lets the caller override it', () => {
  assert.equal(buildTerminalEvent({ id: 't' }, { finalStatus: 'COMPLETED' }).source, 'queue');
  assert.equal(buildTerminalEvent({ id: 't', deliveryMode: 'official-session' }, { finalStatus: 'COMPLETED' }).source, 'official-session');
  assert.equal(buildTerminalEvent({ id: 't', deliveryMode: 'other' }, { finalStatus: 'COMPLETED' }).source, 'queue');
  assert.equal(buildTerminalEvent({ id: 't' }, { finalStatus: 'COMPLETED', source: 'manual' }).source, 'manual');
  assert.equal(buildTerminalEvent({ id: 't', deliveryMode: 'official-session' }, { finalStatus: 'COMPLETED', source: 'queue' }).source, 'queue');
  assert.equal(buildTerminalEvent({ id: 't' }, { finalStatus: 'COMPLETED', source: '' }).source, 'queue', 'an empty source is not a source');
});

test('buildTerminalEvent takes its clock as a parameter and is deterministic without one', () => {
  // No endedAt: the injected clock is the completedAt fallback.
  const withFunction = buildTerminalEvent(
    { id: 'task-4', createdAt: 5_000, startedAt: 6_000 },
    { finalStatus: 'COMPLETED', now: () => 9_000 },
  );
  assert.equal(withFunction.completedAt, 9_000);
  assert.equal(withFunction.endedAt, 9_000);
  assert.equal(withFunction.terminalEpoch, 0, 'the epoch still comes from the task, not the clock');
  assert.equal(withFunction.terminalKey, 'task-4#COMPLETED#0');
  assert.equal(withFunction.shortResult, '3s', 'the duration is measured to completedAt');

  const withNumber = buildTerminalEvent({ id: 'task-4' }, { finalStatus: 'CANCELLED', now: 12_345 });
  assert.equal(withNumber.completedAt, 12_345);

  // No clock at all: the fallback is 0, never the current time.
  const first = buildTerminalEvent({ id: 'task-4' }, { finalStatus: 'CANCELLED' });
  const second = buildTerminalEvent({ id: 'task-4' }, { finalStatus: 'CANCELLED' });
  assert.equal(first.completedAt, 0);
  assert.equal(first.endedAt, 0);
  assert.equal(first.shortResult, null);
  assert.deepEqual(second, first, 'no hidden clock: the same input yields the same payload');

  assert.throws(() => buildTerminalEvent({ id: 'task-4' }, { finalStatus: 'CANCELLED', now: 'later' }), TypeError);
  assert.throws(() => buildTerminalEvent({ id: 'task-4' }, { finalStatus: 'CANCELLED', now: () => Number.NaN }), TypeError);
});

test('buildTerminalEvent falls back to CANCELLED and carries the reason verbatim', () => {
  const pending = buildTerminalEvent({ id: 'task-5', status: 'PENDING' }, { finalStatus: 'PENDING', status: 'PENDING' });
  assert.equal(pending.finalStatus, 'CANCELLED', 'a non-terminal status cannot be a terminal state');
  assert.equal(pending.status, 'PENDING', 'the persisted status is reported as it is');
  assert.equal(pending.statusLabel, 'Cancelled');
  assert.equal(pending.terminalKey, 'task-5#CANCELLED#0', 'the key is built from the canonical state, not the persisted status');
  assert.equal(pending.shortResult, null);

  const bare = buildTerminalEvent({ id: 'task-5b' });
  assert.equal(bare.finalStatus, 'CANCELLED');
  assert.equal(bare.status, '', 'there was no status to report');
  assert.equal(bare.statusLabel, 'Cancelled');
  assert.equal(bare.terminalKey, 'task-5b#CANCELLED#0', 'the event key never uses the TERMINAL fallback: the state is already canonical');

  assert.equal(buildTerminalEvent({ id: 't' }, { reason: 42 }).reason, '42', 'the reason is stringified, not validated');
  assert.equal(buildTerminalEvent({ id: 't' }, { reason: '' }).reason, '', 'an empty reason stays an empty string');
  assert.equal(buildTerminalEvent({ id: 't' }).reason, null);
  assert.equal(buildTerminalEvent({ id: 't' }, { reason: null }).reason, null);
});

test('buildTerminalEvent tolerates a non-task and always names one', () => {
  const event = buildTerminalEvent(undefined, { finalStatus: 'COMPLETED' });
  assert.equal(event.taskId, 'task');
  assert.equal(event.id, 'task');
  assert.equal(event.taskName, 'task');
  assert.equal(event.finalStatus, 'COMPLETED');
  assert.equal(event.terminalKey, 'task#COMPLETED#0');

  const named = buildTerminalEvent({ taskId: 'task-6' }, { finalStatus: 'COMPLETED', status: 'COMPLETED' });
  assert.equal(named.taskId, 'task-6');
  assert.equal(named.id, 'task-6');
});

test('index.mjs is the one export site for this module', () => {
  const expected = [
    'ACTIVE_STATUSES',
    'CANONICAL_TERMINAL',
    'QUEUED_STATUSES',
    'REASONS',
    'TERMINAL_EVENT',
    'TERMINAL_STATUSES',
    'activeStatuses',
    'buildTerminalEvent',
    'canonicalTerminal',
    'errorSummary',
    'firstLine',
    'isActiveStatus',
    'isCanonicalTerminal',
    'isKnownReason',
    'isKnownStatus',
    'isQueuedStatus',
    'isTerminalStatus',
    'normalizeStatus',
    'persistedStatusFor',
    'queuedStatuses',
    'reasons',
    'requireCanonicalTerminal',
    'requireKnownReason',
    'requireKnownStatus',
    'shortResult',
    'statusLabel',
    'taskDisplayName',
    'terminalEpoch',
    'terminalKey',
    'terminalState',
    'terminalStatuses',
    'truncate',
  ];
  assert.deepEqual(Object.keys(publicSurface).sort(), [...expected].sort());
  assert.equal(publicSurface.TERMINAL_EVENT, TERMINAL_EVENT);
  assert.equal(publicSurface.buildTerminalEvent, buildTerminalEvent);
  assert.equal(publicSurface.terminalState, terminalState);
});
