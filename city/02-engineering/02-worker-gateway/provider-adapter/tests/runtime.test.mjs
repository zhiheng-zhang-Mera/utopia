/**
 * UTOPIA · City · Worker Gateway — provider adapter runtime suite.
 *
 * Donor parity suite. The availability rule, the unsupported-capability refusal,
 * the `web:` id rule, the default-role capability merge and the hook delegation
 * restate Codex-Boss `electron/runtimes/runtime.ts`,
 * `electron/runtimes/unsupported-runtime.ts` and
 * `electron/runtimes/web/provider-runtime-adapter.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * Two donor behaviours are asserted as adaptations and are recorded in
 * DONOR.json: `healthCheck` takes the clock as a parameter instead of reading
 * `new Date()`, and every factory refuses malformed input instead of repairing
 * it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  RUNTIME_AVAILABILITY,
  RUNTIME_CAPABILITIES,
  RUNTIME_FAILURE_CODES,
  RUNTIME_KINDS,
  RUNTIME_RESULT_STATUSES,
  UNSUPPORTED_EXECUTE_MESSAGE,
  UNSUPPORTED_HEALTH_MESSAGE,
  WEB_ID_PREFIX_ERROR,
  isRuntimeAvailable,
  providerRuntimeAdapter,
  runtimeCapabilities,
  runtimeFailure,
  runtimeHealth,
  runtimeMetrics,
  runtimeRequest,
  runtimeResult,
  unsupportedRuntime,
  validateAvailability,
} from '../index.mjs';

const CHECKED_AT = '2026-09-29T12:00:00.000Z';
const now = () => CHECKED_AT;

const REQUEST = {
  jobId: 'job-1',
  taskId: 'task-1',
  role: 'planning',
  prompt: 'summarise the district',
};

/**
 * Hooks that answer validly, for the tests that are about the adapter's declared
 * shape rather than about delegation.
 */
function stubHooks(overrides = {}) {
  return {
    healthCheck: async () => ({
      runtimeId: 'web:alpha',
      availability: 'AVAILABLE',
      message: 'ready',
      checkedAt: CHECKED_AT,
    }),
    execute: async (request) => ({ runtimeId: 'web:alpha', jobId: request.jobId, status: 'SUCCESS', content: 'done' }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// the ten-value availability vocabulary
// ---------------------------------------------------------------------------

test('the availability vocabulary is the donor ten, in the donor order', () => {
  assert.deepEqual(RUNTIME_AVAILABILITY, [
    'AVAILABLE',
    'BUSY',
    'AUTH_REQUIRED',
    'RATE_LIMITED',
    'BUDGET_EXHAUSTED',
    'PAGE_CHANGED',
    'USER_ACTION_REQUIRED',
    'UNSUPPORTED',
    'DOWN',
    'UNKNOWN',
  ]);
  assert.equal(RUNTIME_AVAILABILITY.length, 10);
  assert.deepEqual(RUNTIME_KINDS, ['web', 'codex', 'api', 'local']);
  assert.deepEqual(RUNTIME_CAPABILITIES, [
    'planning',
    'research',
    'review',
    'synthesis',
    'coding',
    'validation',
    'critique',
  ]);
  assert.deepEqual(RUNTIME_RESULT_STATUSES, ['SUCCESS', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'CANCELLED']);
  assert.deepEqual(RUNTIME_FAILURE_CODES, [...RUNTIME_AVAILABILITY, 'TIMEOUT', 'UNKNOWN']);
});

test('isRuntimeAvailable: exactly one of the ten values is available', () => {
  const verdicts = RUNTIME_AVAILABILITY.map((availability) => isRuntimeAvailable(availability));
  assert.equal(verdicts.filter(Boolean).length, 1);
  assert.equal(isRuntimeAvailable('AVAILABLE'), true);

  for (const availability of RUNTIME_AVAILABILITY) {
    assert.equal(
      isRuntimeAvailable(availability),
      availability === 'AVAILABLE',
      `${availability} must be ${availability === 'AVAILABLE'}`,
    );
  }

  // UNKNOWN is called out on its own: an unestablished readiness is a refusal.
  assert.equal(isRuntimeAvailable('UNKNOWN'), false);
});

test('isRuntimeAvailable refuses a value outside the ten-value vocabulary', () => {
  assert.throws(() => isRuntimeAvailable('available'), TypeError);
  assert.throws(() => isRuntimeAvailable('READY'), TypeError);
  assert.throws(() => isRuntimeAvailable(undefined), TypeError);
  assert.throws(() => isRuntimeAvailable(null), TypeError);
  assert.throws(() => validateAvailability('READY'), TypeError);
});

// ---------------------------------------------------------------------------
// the unsupported-runtime refusal
// ---------------------------------------------------------------------------

test('unsupportedRuntime keeps the donor identity and capability defaults', () => {
  const runtime = unsupportedRuntime({ id: 'codex:primary', kind: 'codex' });
  assert.equal(runtime.id, 'codex:primary');
  assert.equal(runtime.kind, 'codex');
  assert.deepEqual(runtime.capabilities, {
    roles: [],
    supportsCancellation: false,
    supportsStreaming: false,
  });
  assert.equal('cancel' in runtime, false, 'the donor refusal adapter declares no cancel');

  const scoped = unsupportedRuntime({ id: 'api:secondary', kind: 'api', roles: ['research', 'critique'] });
  assert.deepEqual(scoped.capabilities.roles, ['research', 'critique']);
  assert.throws(() => unsupportedRuntime({ id: 'api:secondary', kind: 'api', roles: ['nope'] }), TypeError);
  assert.throws(() => unsupportedRuntime({ id: 'api:secondary', kind: 'quantum' }), TypeError);
});

test('unsupportedRuntime.healthCheck reports UNSUPPORTED with the donor message and injected time', async () => {
  const runtime = unsupportedRuntime({ id: 'local:worker', kind: 'local', now });
  const health = await runtime.healthCheck();
  assert.deepEqual(health, {
    runtimeId: 'local:worker',
    availability: 'UNSUPPORTED',
    message: 'Runtime is configured but not implemented in v0.5',
    checkedAt: CHECKED_AT,
  });
  assert.equal(health.message, UNSUPPORTED_HEALTH_MESSAGE);
  assert.equal(isRuntimeAvailable(health.availability), false);

  // The clock is a parameter: the same runtime reports the same bytes twice.
  assert.deepEqual(await runtime.healthCheck(), health);

  // Different injected time, different report — the parameter is really read.
  const later = unsupportedRuntime({ id: 'local:worker', kind: 'local', now: () => '2027-01-01T00:00:00.000Z' });
  assert.equal((await later.healthCheck()).checkedAt, '2027-01-01T00:00:00.000Z');

  // Without an injected clock the report is still deterministic (Unix epoch).
  const epoch = unsupportedRuntime({ id: 'local:worker', kind: 'local' });
  assert.equal((await epoch.healthCheck()).checkedAt, new Date(0).toISOString());
});

test('unsupportedRuntime.execute refuses permanently and is not retryable', async () => {
  const runtime = unsupportedRuntime({ id: 'codex:primary', kind: 'codex', now });
  const result = await runtime.execute(REQUEST);
  assert.deepEqual(result, {
    runtimeId: 'codex:primary',
    jobId: 'job-1',
    status: 'PERMANENT_FAILURE',
    failure: {
      code: 'UNSUPPORTED',
      message: 'Runtime is not implemented',
      retryable: false,
    },
  });
  assert.equal(result.status, 'PERMANENT_FAILURE');
  assert.equal(result.failure.retryable, false);
  assert.equal(result.failure.code, 'UNSUPPORTED');
  assert.equal(result.failure.message, UNSUPPORTED_EXECUTE_MESSAGE);
  assert.equal(result.status === 'RETRYABLE_FAILURE', false);
  assert.equal('content' in result, false);
  assert.equal('artifact' in result, false);

  await assert.rejects(runtime.execute({ ...REQUEST, role: 'not-a-role' }), TypeError);
});

// ---------------------------------------------------------------------------
// the web: id rule
// ---------------------------------------------------------------------------

test('providerRuntimeAdapter refuses an id without the web: prefix, with the donor message', () => {
  const hooks = stubHooks();
  for (const id of ['codex:primary', 'web', 'Web:one', '', 'api:web:one']) {
    assert.throws(
      () => providerRuntimeAdapter({ id, hooks }),
      (error) => error instanceof Error && error.message === 'Web runtime id must start with web:',
      `${id} must be refused with the donor message`,
    );
  }
  assert.equal(WEB_ID_PREFIX_ERROR, 'Web runtime id must start with web:');
  assert.throws(() => providerRuntimeAdapter({ id: 'codex:primary', hooks }), { message: WEB_ID_PREFIX_ERROR });
});

test('providerRuntimeAdapter accepts a web: id and declares kind web', () => {
  const runtime = providerRuntimeAdapter({ id: 'web:alpha', hooks: stubHooks() });
  assert.equal(runtime.id, 'web:alpha');
  assert.equal(runtime.kind, 'web');
  assert.equal(runtime.id.startsWith('web:'), true);
  assert.equal('compatibility' in runtime, false, 'the compatibility window is not part of this port');
});

// ---------------------------------------------------------------------------
// the capability merge
// ---------------------------------------------------------------------------

test('providerRuntimeAdapter merges the donor all-seven-role default with no override', () => {
  const runtime = providerRuntimeAdapter({ id: 'web:alpha', hooks: stubHooks() });
  assert.deepEqual(runtime.capabilities, {
    roles: ['planning', 'research', 'review', 'synthesis', 'coding', 'validation', 'critique'],
    supportsCancellation: false,
    supportsStreaming: false,
  });
  assert.deepEqual(runtime.capabilities.roles, [...RUNTIME_CAPABILITIES]);
  assert.notEqual(runtime.capabilities.roles, RUNTIME_CAPABILITIES, 'the roles are a copy, not the frozen vocabulary');

  // The caller's partial object is not mutated and not retained.
  const partial = { supportsStreaming: true };
  const merged = providerRuntimeAdapter({ id: 'web:alpha', hooks: stubHooks(), capabilities: partial });
  assert.deepEqual(partial, { supportsStreaming: true });
  assert.equal(merged.capabilities.supportsStreaming, true);
});

test('providerRuntimeAdapter applies a partial override and keeps the untouched defaults', () => {
  const runtime = providerRuntimeAdapter({
    id: 'web:alpha',
    hooks: stubHooks(),
    capabilities: { roles: ['planning', 'review'], supportsCancellation: true },
  });
  assert.deepEqual(runtime.capabilities, {
    roles: ['planning', 'review'],
    supportsCancellation: true,
    supportsStreaming: false,
  });

  const streaming = providerRuntimeAdapter({
    id: 'web:beta',
    hooks: stubHooks(),
    capabilities: { supportsStreaming: true, consumesModel: true },
  });
  assert.deepEqual(streaming.capabilities, {
    roles: ['planning', 'research', 'review', 'synthesis', 'coding', 'validation', 'critique'],
    supportsCancellation: false,
    supportsStreaming: true,
    consumesModel: true,
  });

  // An empty role list is a caller's choice, not something to repair.
  const roleless = providerRuntimeAdapter({ id: 'web:gamma', hooks: stubHooks(), capabilities: { roles: [] } });
  assert.deepEqual(roleless.capabilities.roles, []);

  // A malformed declaration is refused, never repaired.
  assert.throws(() => providerRuntimeAdapter({ id: 'web:delta', hooks: stubHooks(), capabilities: { roles: ['planning', 'planning'] } }), TypeError);
  assert.throws(() => providerRuntimeAdapter({ id: 'web:delta', hooks: stubHooks(), capabilities: { roles: 'planning' } }), TypeError);
  assert.throws(() => providerRuntimeAdapter({ id: 'web:delta', hooks: stubHooks(), capabilities: { supportsStreaming: 'yes' } }), TypeError);
  assert.throws(() => runtimeCapabilities({ roles: ['unknown-role'] }), TypeError);
});

// ---------------------------------------------------------------------------
// hook delegation
// ---------------------------------------------------------------------------

test('healthCheck and execute delegate to the injected hooks', async () => {
  const seen = [];
  const runtime = providerRuntimeAdapter({
    id: 'web:alpha',
    hooks: {
      healthCheck: async () => {
        seen.push('health');
        return { runtimeId: 'web:alpha', availability: 'BUSY', message: 'working', checkedAt: CHECKED_AT };
      },
      execute: async (request, signal) => {
        seen.push(`execute:${request.jobId}:${signal === undefined ? 'no-signal' : 'signal'}`);
        return {
          runtimeId: 'web:alpha',
          jobId: request.jobId,
          status: 'SUCCESS',
          content: 'done',
          metrics: { startedAt: CHECKED_AT, completedAt: CHECKED_AT, durationMs: 0 },
          usage: { totalTokens: 12 },
        };
      },
    },
  });

  const health = await runtime.healthCheck();
  assert.deepEqual(health, {
    runtimeId: 'web:alpha',
    availability: 'BUSY',
    message: 'working',
    checkedAt: CHECKED_AT,
  });

  const result = await runtime.execute(REQUEST);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.content, 'done');
  assert.deepEqual(result.usage, { totalTokens: 12 });
  assert.deepEqual(seen, ['health', 'execute:job-1:no-signal']);

  const controller = new AbortController();
  const signalled = await runtime.execute({ ...REQUEST, jobId: 'job-2', replaySafe: true }, controller.signal);
  assert.equal(signalled.jobId, 'job-2');
  assert.deepEqual(seen[2], 'execute:job-2:signal');

  // A hook that answers a malformed result is refused at the adapter boundary.
  const broken = providerRuntimeAdapter({
    id: 'web:broken',
    hooks: {
      healthCheck: async () => ({ runtimeId: 'web:broken', availability: 'READY', message: 'ok', checkedAt: CHECKED_AT }),
      execute: async () => ({ runtimeId: 'web:broken', jobId: 'job-1', status: 'MOSTLY_DONE' }),
    },
  });
  await assert.rejects(broken.healthCheck(), TypeError);
  await assert.rejects(broken.execute(REQUEST), TypeError);
});

test('cancel delegates to the hook and resolves when no hook is supplied', async () => {
  const cancelled = [];
  const withHook = providerRuntimeAdapter({
    id: 'web:alpha',
    hooks: {
      healthCheck: async () => ({ runtimeId: 'web:alpha', availability: 'AVAILABLE', message: 'ok', checkedAt: CHECKED_AT }),
      execute: async (request) => ({ runtimeId: 'web:alpha', jobId: request.jobId, status: 'CANCELLED' }),
      cancel: async (jobId) => {
        cancelled.push(jobId);
      },
    },
  });
  assert.equal(await withHook.cancel('job-1'), undefined);
  assert.equal(await withHook.cancel('job-2'), undefined);
  assert.deepEqual(cancelled, ['job-1', 'job-2']);

  const withoutHook = providerRuntimeAdapter({
    id: 'web:alpha',
    hooks: {
      healthCheck: async () => ({ runtimeId: 'web:alpha', availability: 'AVAILABLE', message: 'ok', checkedAt: CHECKED_AT }),
      execute: async (request) => ({ runtimeId: 'web:alpha', jobId: request.jobId, status: 'SUCCESS' }),
    },
  });
  const settled = withoutHook.cancel('job-3');
  assert.equal(settled instanceof Promise, true, 'cancel must resolve, not throw, without a hook');
  assert.equal(await settled, undefined);
});

test('a missing healthCheck/execute hook fails at the call, not at construction', async () => {
  const hooks = stubHooks();
  const runtime = providerRuntimeAdapter({
    id: 'web:alpha',
    hooks: { cancel: hooks.cancel },
  });
  assert.equal(runtime.kind, 'web');
  assert.equal(runtime.id, 'web:alpha');
  await assert.rejects(runtime.healthCheck(), TypeError);
  await assert.rejects(runtime.execute(REQUEST), TypeError);
  assert.equal(await runtime.cancel('job-1'), undefined);
});

// ---------------------------------------------------------------------------
// the value-shape factories
// ---------------------------------------------------------------------------

test('runtimeRequest copies the donor fields and keeps optionals absent when not supplied', () => {
  assert.deepEqual(runtimeRequest(REQUEST), {
    jobId: 'job-1',
    taskId: 'task-1',
    role: 'planning',
    prompt: 'summarise the district',
  });
  assert.deepEqual(
    runtimeRequest({
      sessionId: 'session-1',
      replaySafe: true,
      timeoutMs: 5000,
      context: 'district notes',
      ...REQUEST,
    }),
    {
      jobId: 'job-1',
      taskId: 'task-1',
      role: 'planning',
      prompt: 'summarise the district',
      sessionId: 'session-1',
      replaySafe: true,
      timeoutMs: 5000,
      context: 'district notes',
    },
  );

  const shaped = runtimeRequest(REQUEST);
  assert.equal('sessionId' in shaped, false);
  assert.equal('replaySafe' in shaped, false);
  assert.equal('timeoutMs' in shaped, false);
  assert.equal('context' in shaped, false);

  // Copy-on-construct: later mutation of the caller's object cannot reach in.
  const caller = { ...REQUEST, sessionId: 'session-1' };
  const copy = runtimeRequest(caller);
  caller.jobId = 'job-mutated';
  caller.sessionId = 'session-mutated';
  assert.equal(copy.jobId, 'job-1');
  assert.equal(copy.sessionId, 'session-1');

  assert.throws(() => runtimeRequest({ ...REQUEST, jobId: '' }), TypeError);
  assert.throws(() => runtimeRequest({ ...REQUEST, role: 'planing' }), TypeError);
  assert.throws(() => runtimeRequest({ ...REQUEST, timeoutMs: 'soon' }), TypeError);
  assert.throws(() => runtimeRequest({ ...REQUEST, replaySafe: 'yes' }), TypeError);
});

test('runtimeFailure keeps the donor field shapes and the conditional retryAt', () => {
  const failure = runtimeFailure({ code: 'RATE_LIMITED', message: 'slow down', retryable: true, retryAt: 1000 });
  assert.deepEqual(failure, { code: 'RATE_LIMITED', message: 'slow down', retryable: true, retryAt: 1000 });

  const noDeadline = runtimeFailure({ code: 'TIMEOUT', message: 'too slow', retryable: false });
  assert.deepEqual(noDeadline, { code: 'TIMEOUT', message: 'too slow', retryable: false });
  assert.equal('retryAt' in noDeadline, false, 'retryAt appears only when the caller defined it');

  assert.equal(runtimeFailure({ code: 'UNKNOWN', message: 'no idea', retryable: false }).code, 'UNKNOWN');
  assert.throws(() => runtimeFailure({ code: 'SLOW', message: 'x', retryable: true }), TypeError);
  assert.throws(() => runtimeFailure({ code: 'DOWN', message: '', retryable: true }), TypeError);
  assert.throws(() => runtimeFailure({ code: 'DOWN', message: 'x', retryable: 'no' }), TypeError);
  assert.throws(() => runtimeFailure({ code: 'DOWN', message: 'x', retryable: true, retryAt: 'later' }), TypeError);
});

test('runtimeResult keeps the four statuses and the optional donor fields', () => {
  const minimal = runtimeResult({ runtimeId: 'web:alpha', jobId: 'job-1', status: 'SUCCESS' });
  assert.deepEqual(minimal, { runtimeId: 'web:alpha', jobId: 'job-1', status: 'SUCCESS' });
  for (const field of ['artifact', 'content', 'failure', 'metrics', 'usage']) {
    assert.equal(field in minimal, false, `${field} must stay absent when not supplied`);
  }

  const full = runtimeResult({
    runtimeId: 'web:alpha',
    jobId: 'job-1',
    status: 'RETRYABLE_FAILURE',
    failure: { code: 'BUSY', message: 'busy', retryable: true, retryAt: 42 },
    metrics: { startedAt: CHECKED_AT, completedAt: CHECKED_AT, durationMs: 12 },
    usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    content: 'partial',
  });
  assert.deepEqual(full.failure, { code: 'BUSY', message: 'busy', retryable: true, retryAt: 42 });
  assert.deepEqual(full.metrics, { startedAt: CHECKED_AT, completedAt: CHECKED_AT, durationMs: 12 });
  assert.deepEqual(full.usage, { inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  assert.equal(full.status, 'RETRYABLE_FAILURE');

  for (const status of RUNTIME_RESULT_STATUSES) {
    assert.equal(runtimeResult({ runtimeId: 'web:a', jobId: 'j', status }).status, status);
  }
  assert.throws(() => runtimeResult({ runtimeId: 'web:a', jobId: 'j', status: 'DONE' }), TypeError);
  assert.throws(() => runtimeResult({ runtimeId: 'web:a', jobId: '', status: 'SUCCESS' }), TypeError);
  assert.throws(
    () => runtimeResult({ runtimeId: 'web:a', jobId: 'j', status: 'SUCCESS', metrics: { startedAt: CHECKED_AT, completedAt: CHECKED_AT, durationMs: Number.NaN } }),
    TypeError,
  );
  assert.throws(
    () => runtimeResult({ runtimeId: 'web:a', jobId: 'j', status: 'SUCCESS', failure: { code: 'BUSY', message: 'busy' } }),
    TypeError,
    'a nested failure must satisfy the same shape as a top-level one',
  );
});

test('provider usage never invents a number the provider did not report', () => {
  const reported = runtimeResult({
    runtimeId: 'web:alpha',
    jobId: 'job-1',
    status: 'SUCCESS',
    usage: { outputTokens: 9 },
  });
  assert.deepEqual(reported.usage, { outputTokens: 9 });
  assert.equal('inputTokens' in reported.usage, false, 'an absent field is not zero');
  assert.equal('totalTokens' in reported.usage, false);

  const empty = runtimeResult({ runtimeId: 'web:alpha', jobId: 'job-1', status: 'SUCCESS', usage: {} });
  assert.deepEqual(empty.usage, {});

  assert.throws(
    () => runtimeResult({ runtimeId: 'web:alpha', jobId: 'job-1', status: 'SUCCESS', usage: { totalTokens: '9' } }),
    TypeError,
  );
});

test('runtimeHealth and runtimeMetrics are validated, not repaired', () => {
  const health = runtimeHealth({
    runtimeId: 'web:alpha',
    availability: 'USER_ACTION_REQUIRED',
    message: 'sign in',
    checkedAt: CHECKED_AT,
  });
  assert.deepEqual(health, {
    runtimeId: 'web:alpha',
    availability: 'USER_ACTION_REQUIRED',
    message: 'sign in',
    checkedAt: CHECKED_AT,
  });
  assert.throws(() => runtimeHealth({ runtimeId: 'web:alpha', availability: 'AVAILABLE', message: 'ok' }), TypeError);
  assert.throws(
    () => runtimeHealth({ runtimeId: 'web:alpha', availability: 'FINE', message: 'ok', checkedAt: CHECKED_AT }),
    TypeError,
  );

  assert.deepEqual(runtimeMetrics({ startedAt: CHECKED_AT, completedAt: CHECKED_AT, durationMs: 0 }), {
    startedAt: CHECKED_AT,
    completedAt: CHECKED_AT,
    durationMs: 0,
  });
  assert.throws(() => runtimeMetrics({ startedAt: CHECKED_AT, completedAt: CHECKED_AT }), TypeError);
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

test('the module reads no ambient clock, environment or randomness', async () => {
  const names = ['contracts.mjs', 'runtime.mjs', 'provider-state.mjs', 'index.mjs'];
  const sources = await Promise.all(
    names.map((name) => readFile(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')),
  );
  for (const [index, source] of sources.entries()) {
    assert.equal(typeof source, 'string', `source ${names[index]} was read`);
    // Comments are stripped first: prose is allowed to *name* Date.now while
    // explaining why it is absent, code is not allowed to call it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /Date\.now\s*\(/, `${names[index]} must read no ambient clock`);
    assert.doesNotMatch(code, /Math\.random\s*\(/, `${names[index]} must use no randomness`);
    assert.doesNotMatch(code, /process\.env/, `${names[index]} must read no environment`);
    assert.doesNotMatch(code, /new Date\s*\(\s*\)/, `${names[index]} must not construct a date without an injected number`);
    assert.doesNotMatch(code, /node:(fs|net|http|https|child_process)/, `${names[index]} must perform no ambient I/O`);
  }

  // The donor's message is preserved verbatim, including its v0.5 wording.
  assert.match(sources[1], /Runtime is configured but not implemented in v0\.5/);
});
