/**
 * UTOPIA · Engineering — restart-recovery-station — request admission tests.
 *
 * Donor: dsh-restart `src/plugin/request-validator.ts`, `src/shared/protocol.ts`
 * and `src/shared/types.ts` @ e20fb6cc43e27cedf6303471e5b8ee18e1383ecd, using the
 * donor's own vectors from `tests/validation.test.js`.
 *
 * The refusal codes and detail strings are asserted verbatim, and the ladder is
 * asserted as a *precedence table*: a cheap structural or policy refusal must beat
 * every later one, because a malformed request must never reach the code that
 * writes files. Every MAX_* bound is checked at its limit and one past it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  MAX_ID_LENGTH,
  MAX_REASON_CODE_LENGTH,
  MAX_SOURCE_LENGTH,
  MAX_SUMMARY_LENGTH,
  refuse,
  requestFingerprint,
  validateRequest,
  validateShape,
} from '../request-validator.mjs';
import {
  PROTOCOL_VERSION,
  RESTART_MODES,
  RESTART_PRIORITIES,
  RESTART_REASON_CODES,
  SELF_REASON_CODES,
  TICKET_SCHEMA_VERSION,
  checkpointPort,
  modeConfig,
  normalizedRequest,
  restartConfig,
  restartRequest,
  shutdownPort,
  systemShutdownPort,
  validateSystemShutdownPort,
  validatorContext,
} from '../contracts.mjs';

const T0 = Date.parse('2026-06-01T00:00:00.000Z');
const EPOCH = '1970-01-01T00:00:00.000Z';
const ALLOWED_SOURCES = ['dsh-health-scheduler', 'dsh-restart-cli'];

/** Deep merge, so a test can deny exactly one thing in the configuration. */
function merge(base, overrides) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value) ? merge(base[key] ?? {}, value) : value;
  }
  return out;
}

/** A complete, permissive configuration; each test denies one thing. */
function baseConfig(overrides = {}) {
  return merge(
    {
      enabled: true,
      applicationRestart: { enabled: true, minIntervalMs: 600_000 },
      systemRestart: { enabled: false, minIntervalMs: 3_600_000 },
      allowedSources: ALLOWED_SOURCES,
      allowedPriorities: ['low', 'normal', 'high', 'emergency'],
      allowSystemReboot: false,
      safety: {
        checkpointRequired: true,
        duplicateSuppression: true,
        crashLoopLimit: 3,
        crashLoopWindowMs: 300_000,
        safeModeOnLoop: true,
        shutdownTimeoutMs: 30_000,
        allowForceTerminate: true,
        allowRestartWithoutSupervisor: false,
      },
      supervisor: {
        heartbeatIntervalMs: 5_000,
        heartbeatTimeoutMs: 15_000,
        relaunchTimeoutMs: 60_000,
        launchCommand: null,
        launchArgs: [],
        launchCwd: null,
        pollIntervalMs: 250,
        ticketTtlMs: 600_000,
        detach: true,
        relaunchBackoffMs: 1_000,
        relaunchBackoffMaxMs: 30_000,
      },
      storage: { directory: null, maxLogBytes: 1_048_576, maxRecentAttempts: 20 },
      knownReasonCodes: RESTART_REASON_CODES,
    },
    overrides,
  );
}

/** A validator context that permits everything, so each test can deny one thing. */
function context(overrides = {}) {
  return {
    nowMs: T0,
    restartInFlight: false,
    cooldowns: { application: 0, system: 0 },
    isDuplicate: false,
    crashLoopTripped: false,
    supervisorPresent: true,
    checkpointPortAvailable: true,
    ...overrides,
  };
}

/** The donor's `validRequest()` helper. */
function validRequest(overrides = {}) {
  return {
    requestId: 'req-1',
    source: 'dsh-health-scheduler',
    mode: 'application',
    reasonCode: 'RUNTIME_PRESSURE',
    reasonSummary: 'health policy requested an application restart',
    checkpointRequired: true,
    priority: 'normal',
    ...overrides,
  };
}

test('accepts a complete request and normalizes it', () => {
  const result = validateShape(validRequest());
  assert.equal(result.valid, true);
  assert.equal(result.code, null);
  assert.equal(result.detail, 'request shape is valid');
  assert.deepEqual(result.request, {
    requestId: 'req-1',
    source: 'dsh-health-scheduler',
    mode: 'application',
    reasonCode: 'RUNTIME_PRESSURE',
    reasonSummary: 'health policy requested an application restart',
    checkpointRequired: true,
    priority: 'normal',
    createdAt: EPOCH,
    acknowledgeSystemReboot: false,
  });

  const accepted = validateRequest(validRequest(), baseConfig(), context());
  assert.equal(accepted.valid, true);
  assert.equal(accepted.code, null);
  assert.equal(accepted.detail, 'request accepted');
  assert.equal(accepted.request.requestId, 'req-1');
});

test('refuses a non-object with the donor message for its type', () => {
  for (const [value, received] of [
    [null, 'object'],
    [undefined, 'undefined'],
    ['x', 'string'],
    [42, 'number'],
  ]) {
    const result = validateShape(value);
    assert.equal(result.valid, false);
    assert.equal(result.code, 'INVALID_REQUEST');
    assert.equal(result.detail, `request must be an object, received ${received}`);
    assert.equal(result.request, null);
  }

  // An array is an object to the donor, so it is refused by the first field check
  // rather than by an invented "array" rule.
  const array = validateShape([]);
  assert.equal(array.code, 'INVALID_REQUEST');
  assert.equal(array.detail, 'requestId must be a non-empty string');
});

test('refuses each missing or blank string field with a field-specific message', () => {
  for (const field of ['requestId', 'source', 'reasonCode', 'reasonSummary']) {
    const missing = validRequest();
    delete missing[field];
    const result = validateShape(missing);
    assert.equal(result.valid, false, `${field} is required`);
    assert.equal(result.code, 'INVALID_REQUEST');
    assert.equal(result.detail, `${field} must be a non-empty string`);

    const blank = validateShape({ ...validRequest(), [field]: '   ' });
    assert.equal(blank.detail, `${field} must be a non-empty string`, `${field} blank is refused`);

    const wrongType = validateShape({ ...validRequest(), [field]: 7 });
    assert.equal(wrongType.detail, `${field} must be a non-empty string`, `${field} non-string is refused`);
  }
});

test('refuses an unknown mode, a non-boolean checkpoint flag and an unknown priority', () => {
  const mode = validateShape({ ...validRequest(), mode: 'partial' });
  assert.equal(mode.code, 'INVALID_REQUEST');
  assert.equal(mode.detail, 'mode must be "application" or "system", received "partial"');
  assert.equal(validateShape({ ...validRequest(), mode: 'system' }).valid, true);

  // A missing mode reaches JSON.stringify(undefined) and is reported as undefined.
  const missingMode = validRequest();
  delete missingMode.mode;
  assert.equal(validateShape(missingMode).detail, 'mode must be "application" or "system", received undefined');

  const checkpoint = validateShape({ ...validRequest(), checkpointRequired: 'yes' });
  assert.equal(checkpoint.code, 'INVALID_REQUEST');
  assert.equal(checkpoint.detail, 'checkpointRequired must be a boolean');
  assert.equal(validateShape({ ...validRequest(), checkpointRequired: false }).valid, true);

  const priority = validateShape({ ...validRequest(), priority: 'urgent' });
  assert.equal(priority.code, 'INVALID_REQUEST');
  assert.equal(priority.detail, 'priority must be low, normal, high or emergency, received "urgent"');
  assert.equal(validateShape({ ...validRequest(), priority: 1 }).detail, 'priority must be low, normal, high or emergency, received 1');
});

test('defaults priority to normal and the acknowledgement to false', () => {
  const request = validRequest();
  delete request.priority;
  delete request.acknowledgeSystemReboot;
  const result = validateShape(request);
  assert.equal(result.valid, true);
  assert.equal(result.request.priority, 'normal');
  assert.equal(result.request.acknowledgeSystemReboot, false);

  assert.equal(validateShape({ ...validRequest(), acknowledgeSystemReboot: true }).request.acknowledgeSystemReboot, true);
  assert.equal(validateShape({ ...validRequest(), priority: 'emergency' }).request.priority, 'emergency');
});

test('defaults createdAt to the epoch and refuses a non-string createdAt', () => {
  assert.equal(validateShape(validRequest()).request.createdAt, EPOCH);

  const kept = validateShape({ ...validRequest(), createdAt: '2026-06-01T00:00:00.000Z' });
  assert.equal(kept.request.createdAt, '2026-06-01T00:00:00.000Z');

  const wrong = validateShape({ ...validRequest(), createdAt: 5 });
  assert.equal(wrong.code, 'INVALID_REQUEST');
  assert.equal(wrong.detail, 'createdAt must be an ISO-8601 string when present');

  const ack = validateShape({ ...validRequest(), acknowledgeSystemReboot: 'true' });
  assert.equal(ack.code, 'INVALID_REQUEST');
  assert.equal(ack.detail, 'acknowledgeSystemReboot must be a boolean when present');
});

test('trims surrounding whitespace instead of accepting it as content', () => {
  // The donor trims first and only then scans for control characters, so a tab or
  // a newline at either end disappears rather than being refused.
  const result = validateShape({
    ...validRequest(),
    requestId: '  req-1  ',
    source: '  dsh-health-scheduler  ',
    reasonCode: '\tRUNTIME_PRESSURE\n',
    reasonSummary: '  health policy requested an application restart  ',
  });
  assert.equal(result.valid, true);
  assert.equal(result.request.requestId, 'req-1');
  assert.equal(result.request.source, 'dsh-health-scheduler');
  assert.equal(result.request.reasonCode, 'RUNTIME_PRESSURE');
  assert.equal(result.request.reasonSummary, 'health policy requested an application restart');

  const trimmed = validateShape({ ...validRequest(), source: '  dsh-health-scheduler  ' });
  assert.equal(trimmed.valid, true);
  assert.equal(trimmed.request.source, 'dsh-health-scheduler');
  assert.equal(validateShape({ ...validRequest(), reasonSummary: '  spaced  ' }).request.reasonSummary, 'spaced');
});

test('enforces each MAX_* bound at its limit and one past it', () => {
  assert.equal(MAX_ID_LENGTH, 128);
  assert.equal(MAX_SOURCE_LENGTH, 64);
  assert.equal(MAX_REASON_CODE_LENGTH, 64);
  assert.equal(MAX_SUMMARY_LENGTH, 500);

  const bounds = [
    ['requestId', MAX_ID_LENGTH],
    ['source', MAX_SOURCE_LENGTH],
    ['reasonCode', MAX_REASON_CODE_LENGTH],
    ['reasonSummary', MAX_SUMMARY_LENGTH],
  ];

  for (const [field, max] of bounds) {
    const atLimit = validateShape({ ...validRequest(), [field]: 'x'.repeat(max) });
    assert.equal(atLimit.valid, true, `${field} of exactly ${max} is accepted`);
    assert.equal(atLimit.request[field], 'x'.repeat(max));

    const pastLimit = validateShape({ ...validRequest(), [field]: 'x'.repeat(max + 1) });
    assert.equal(pastLimit.valid, false, `${field} of ${max + 1} is refused`);
    assert.equal(pastLimit.code, 'INVALID_REQUEST');
    assert.equal(pastLimit.detail, `${field} exceeds ${max} characters`);

    // The bound is measured after trimming, not before.
    const padded = validateShape({ ...validRequest(), [field]: `  ${'x'.repeat(max)}  ` });
    assert.equal(padded.valid, true, `${field} is measured after trimming`);
  }
});

test('refuses control characters by name, after the bound check', () => {
  for (const control of ['\u0000', '\u0007', '\u001f', '\u007f', '\n']) {
    const result = validateShape({ ...validRequest(), reasonSummary: `hold on${control}there` });
    assert.equal(result.valid, false);
    assert.equal(result.code, 'INVALID_REQUEST');
    assert.equal(result.detail, 'reasonSummary contains control characters');
  }

  // Tab and carriage return are inside \u0000-\u001f and are refused too.
  for (const control of ['\t', '\r']) {
    assert.equal(validateShape({ ...validRequest(), source: `dsh${control}source` }).detail, 'source contains control characters');
  }

  // The bound is checked before the control-character scan.
  const oversized = validateShape({ ...validRequest(), reasonSummary: `${'x'.repeat(501)}\u0007` });
  assert.equal(oversized.detail, 'reasonSummary exceeds 500 characters');
});

test('refuses everything when disabled, after the shape check', () => {
  const result = validateRequest(validRequest(), baseConfig({ enabled: false }), context());
  assert.equal(result.valid, false);
  assert.equal(result.code, 'DISABLED');
  assert.equal(result.detail, 'restart execution is disabled by configuration');
  assert.equal(result.request, null);
});

test('refuses an unknown source and names the allowed ones', () => {
  const result = validateRequest(validRequest({ source: 'some-random-app' }), baseConfig(), context());
  assert.equal(result.code, 'UNKNOWN_SOURCE');
  assert.equal(result.detail, 'source "some-random-app" is not allowed; allowed sources: dsh-health-scheduler, dsh-restart-cli');
});

test('refuses a priority the deployment does not accept', () => {
  const result = validateRequest(
    validRequest({ priority: 'emergency' }),
    baseConfig({ allowedPriorities: ['low', 'normal'] }),
    context(),
  );
  assert.equal(result.code, 'INVALID_REQUEST');
  assert.equal(result.detail, 'priority emergency is not accepted by this deployment');
});

test('refuses a disabled mode', () => {
  const result = validateRequest(validRequest(), baseConfig({ applicationRestart: { enabled: false } }), context());
  assert.equal(result.code, 'MODE_NOT_ALLOWED');
  assert.equal(result.detail, 'application restart is disabled by configuration');

  const system = validateRequest(
    validRequest({ mode: 'system', acknowledgeSystemReboot: true }),
    baseConfig({ systemRestart: { enabled: false } }),
    context(),
  );
  assert.equal(system.code, 'MODE_NOT_ALLOWED');
  assert.equal(system.detail, 'system restart is disabled by configuration');
});

test('refuses a system restart unless it is permitted and acknowledged', () => {
  const request = validRequest({ mode: 'system', acknowledgeSystemReboot: true });

  const notPermitted = validateRequest(request, baseConfig({ systemRestart: { enabled: true } }), context());
  assert.equal(notPermitted.code, 'SYSTEM_REBOOT_NOT_PERMITTED');
  assert.equal(notPermitted.detail, 'system restart requires allowSystemReboot = true in the configuration');

  const permitted = baseConfig({ allowSystemReboot: true, systemRestart: { enabled: true } });
  const notAcknowledged = validateRequest(validRequest({ mode: 'system' }), permitted, context());
  assert.equal(notAcknowledged.code, 'SYSTEM_REBOOT_NOT_PERMITTED');
  assert.equal(notAcknowledged.detail, 'system restart requires acknowledgeSystemReboot = true on the request itself');

  assert.equal(validateRequest(request, permitted, context()).valid, true);
});

test('refuses while the crash-loop breaker is tripped', () => {
  const result = validateRequest(validRequest(), baseConfig(), context({ crashLoopTripped: true }));
  assert.equal(result.code, 'CRASH_LOOP');
  assert.equal(result.detail, 'the crash-loop breaker has disabled automatic restart; clear it before requesting another restart');
});

test('refuses a duplicate request id only when duplicate suppression is on', () => {
  const result = validateRequest(validRequest(), baseConfig(), context({ isDuplicate: true }));
  assert.equal(result.code, 'DUPLICATE_REQUEST_ID');
  assert.equal(result.detail, 'request id req-1 has already been processed');

  const unsuppressed = validateRequest(
    validRequest(),
    baseConfig({ safety: { duplicateSuppression: false } }),
    context({ isDuplicate: true }),
  );
  assert.equal(unsuppressed.valid, true, 'with suppression off the repeat is admitted');
});

test('refuses while another restart is in flight', () => {
  const result = validateRequest(validRequest(), baseConfig(), context({ restartInFlight: true }));
  assert.equal(result.code, 'RESTART_IN_FLIGHT');
  assert.equal(result.detail, 'another restart is already in progress');
});

test('refuses inside a cooldown and reports the rounded remaining time', () => {
  const result = validateRequest(
    validRequest(),
    baseConfig(),
    context({ cooldowns: { application: T0 + 600_000, system: 0 } }),
  );
  assert.equal(result.code, 'COOLDOWN_ACTIVE');
  assert.equal(result.detail, 'application restart is in cooldown for another 600s (minimum interval 600s)');

  // Math.ceil on the remaining time and Math.round on the minimum interval.
  const rounded = validateRequest(
    validRequest(),
    baseConfig({ applicationRestart: { minIntervalMs: 1_500 } }),
    context({ cooldowns: { application: T0 + 1, system: 0 } }),
  );
  assert.equal(rounded.detail, 'application restart is in cooldown for another 1s (minimum interval 2s)');

  // 1_499 ms rounds down; 1 ms remaining still counts as 1 s, never 0 s.
  const down = validateRequest(
    validRequest(),
    baseConfig({ applicationRestart: { minIntervalMs: 1_499 } }),
    context({ cooldowns: { application: T0 + 1, system: 0 } }),
  );
  assert.equal(down.detail, 'application restart is in cooldown for another 1s (minimum interval 1s)');

  // The system mode reads the system deadline, not the application one.
  const system = validateRequest(
    validRequest({ mode: 'system', acknowledgeSystemReboot: true }),
    baseConfig({ allowSystemReboot: true, systemRestart: { enabled: true, minIntervalMs: 3_600_000 } }),
    context({ cooldowns: { application: 0, system: T0 + 3_600_000 } }),
  );
  assert.equal(system.detail, 'system restart is in cooldown for another 3600s (minimum interval 3600s)');

  // A deadline exactly now is not "in cooldown": the comparison is strictly `>`.
  const boundary = validateRequest(
    validRequest(),
    baseConfig(),
    context({ cooldowns: { application: T0, system: 0 } }),
  );
  assert.equal(boundary.valid, true);
});

test('refuses when a required checkpoint cannot be verified', () => {
  const strict = validateRequest(validRequest(), baseConfig(), context({ checkpointPortAvailable: false }));
  assert.equal(strict.code, 'CHECKPOINT_FAILED');
  assert.equal(
    strict.detail,
    'no checkpoint port is bound and safety.checkpointRequired is true, so a restart cannot be authorized',
  );

  const relaxed = validateRequest(
    validRequest(),
    baseConfig({ safety: { checkpointRequired: false } }),
    context({ checkpointPortAvailable: false }),
  );
  assert.equal(relaxed.valid, true, 'without the requirement an unbound port is not a refusal');
});

test('refuses when no supervisor has been seen, because exiting is not restarting', () => {
  const result = validateRequest(validRequest(), baseConfig(), context({ supervisorPresent: false }));
  assert.equal(result.code, 'SUPERVISOR_ABSENT');
  assert.equal(
    result.detail,
    'no supervisor heartbeat was seen; set safety.allowRestartWithoutSupervisor = true to restart anyway',
  );

  const permissive = validateRequest(
    validRequest(),
    baseConfig({ safety: { allowRestartWithoutSupervisor: true } }),
    context({ supervisorPresent: false }),
  );
  assert.equal(permissive.valid, true);
});

test('runs the ladder in the donor order: the cheapest refusal wins', () => {
  const vectors = [
    ['shape beats DISABLED', { requestId: '' }, baseConfig({ enabled: false }), context(), 'INVALID_REQUEST'],
    [
      'shape beats every policy refusal',
      { ...validRequest(), priority: 'urgent' },
      baseConfig({ enabled: false, allowedPriorities: [] }),
      context({ crashLoopTripped: true, isDuplicate: true, restartInFlight: true }),
      'INVALID_REQUEST',
    ],
    ['DISABLED beats UNKNOWN_SOURCE', validRequest({ source: 'nobody' }), baseConfig({ enabled: false }), context(), 'DISABLED'],
    [
      'UNKNOWN_SOURCE beats the priority check',
      validRequest({ source: 'nobody', priority: 'emergency' }),
      baseConfig({ allowedPriorities: ['low'] }),
      context(),
      'UNKNOWN_SOURCE',
    ],
    [
      'priority beats MODE_NOT_ALLOWED',
      validRequest({ priority: 'emergency' }),
      baseConfig({ allowedPriorities: ['low'], applicationRestart: { enabled: false } }),
      context(),
      'INVALID_REQUEST',
    ],
    [
      'MODE_NOT_ALLOWED beats SYSTEM_REBOOT_NOT_PERMITTED',
      validRequest({ mode: 'system', acknowledgeSystemReboot: true }),
      baseConfig({ systemRestart: { enabled: false }, allowSystemReboot: false }),
      context(),
      'MODE_NOT_ALLOWED',
    ],
    [
      'SYSTEM_REBOOT_NOT_PERMITTED beats CRASH_LOOP',
      validRequest({ mode: 'system', acknowledgeSystemReboot: true }),
      baseConfig({ systemRestart: { enabled: true } }),
      context({ crashLoopTripped: true }),
      'SYSTEM_REBOOT_NOT_PERMITTED',
    ],
    [
      'CRASH_LOOP beats DUPLICATE_REQUEST_ID',
      validRequest(),
      baseConfig(),
      context({ crashLoopTripped: true, isDuplicate: true }),
      'CRASH_LOOP',
    ],
    [
      'DUPLICATE_REQUEST_ID beats RESTART_IN_FLIGHT',
      validRequest(),
      baseConfig(),
      context({ isDuplicate: true, restartInFlight: true }),
      'DUPLICATE_REQUEST_ID',
    ],
    [
      'RESTART_IN_FLIGHT beats COOLDOWN_ACTIVE',
      validRequest(),
      baseConfig(),
      context({ restartInFlight: true, cooldowns: { application: T0 + 600_000, system: 0 } }),
      'RESTART_IN_FLIGHT',
    ],
    [
      'COOLDOWN_ACTIVE beats CHECKPOINT_FAILED',
      validRequest(),
      baseConfig(),
      context({ cooldowns: { application: T0 + 600_000, system: 0 }, checkpointPortAvailable: false }),
      'COOLDOWN_ACTIVE',
    ],
    [
      'CHECKPOINT_FAILED beats SUPERVISOR_ABSENT',
      validRequest(),
      baseConfig(),
      context({ checkpointPortAvailable: false, supervisorPresent: false }),
      'CHECKPOINT_FAILED',
    ],
  ];

  for (const [name, request, config, state, code] of vectors) {
    const result = validateRequest(request, config, state);
    assert.equal(result.code, code, name);
    assert.equal(result.valid, false, name);
    assert.equal(result.request, null, name);
  }
});

test('documents every code the ladder can raise', () => {
  const codes = [
    'INVALID_REQUEST',
    'DISABLED',
    'UNKNOWN_SOURCE',
    'MODE_NOT_ALLOWED',
    'SYSTEM_REBOOT_NOT_PERMITTED',
    'CRASH_LOOP',
    'DUPLICATE_REQUEST_ID',
    'RESTART_IN_FLIGHT',
    'COOLDOWN_ACTIVE',
    'CHECKPOINT_FAILED',
    'SUPERVISOR_ABSENT',
  ];
  for (const code of codes) {
    assert.equal(typeof SELF_REASON_CODES[code], 'string', `${code} is documented`);
    assert.ok(SELF_REASON_CODES[code].length > 10, `${code} needs a useful explanation`);
  }
  assert.equal(Object.keys(SELF_REASON_CODES).length, 14);
});

test('builds a refusal with no request attached', () => {
  assert.deepEqual(refuse('X', 'y'), { valid: false, code: 'X', detail: 'y', request: null });
});

test('fingerprints the six fingerprinted fields and nothing else', () => {
  const normalized = validateShape(validRequest()).request;
  const expected =
    '{"checkpointRequired":true,"mode":"application","priority":"normal",' +
    '"reasonCode":"RUNTIME_PRESSURE","requestId":"req-1","source":"dsh-health-scheduler"}';

  assert.equal(requestFingerprint(normalized), expected);
  assert.equal(
    createHash('sha256').update(requestFingerprint(normalized), 'utf8').digest('hex'),
    '68d02508a6bec322914108e33b980df121625c6233521182d663fdfa894f77ed',
  );

  // An identical retry fingerprints identically, whatever order it was built in.
  const rebuilt = {
    priority: normalized.priority,
    checkpointRequired: normalized.checkpointRequired,
    reasonCode: normalized.reasonCode,
    mode: normalized.mode,
    source: normalized.source,
    requestId: normalized.requestId,
  };
  assert.equal(requestFingerprint(normalized), requestFingerprint(rebuilt));

  // A different request is a different fingerprint.
  assert.notEqual(requestFingerprint(normalized), requestFingerprint({ ...normalized, reasonCode: 'MEMORY_LEAK' }));
  assert.notEqual(requestFingerprint(normalized), requestFingerprint({ ...normalized, checkpointRequired: false }));

  // reasonSummary, createdAt and acknowledgeSystemReboot are not fingerprinted.
  const ignored = {
    ...normalized,
    reasonSummary: 'something else entirely',
    createdAt: '2030-01-01T00:00:00.000Z',
    acknowledgeSystemReboot: true,
  };
  assert.equal(requestFingerprint(normalized), requestFingerprint(ignored));
});

test('the vocabularies are frozen donor data', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(TICKET_SCHEMA_VERSION, 1);
  assert.deepEqual(RESTART_MODES, ['application', 'system']);
  assert.deepEqual(RESTART_PRIORITIES, ['low', 'normal', 'high', 'emergency']);
  assert.equal(RESTART_REASON_CODES.includes('COMPUTER_USE_STALL'), true);
  for (const value of [RESTART_MODES, RESTART_PRIORITIES, RESTART_REASON_CODES, SELF_REASON_CODES]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test('a contract factory refuses invalid input instead of repairing it', () => {
  assert.equal(restartRequest(validRequest()).requestId, 'req-1');

  // mode is not coerced, priority is not defaulted, required fields are not filled in.
  assert.throws(() => restartRequest({ ...validRequest(), mode: 'partial' }), TypeError);
  const withoutPriority = validRequest();
  delete withoutPriority.priority;
  assert.throws(() => restartRequest(withoutPriority), /RestartRequest\.priority is required/);
  assert.throws(() => restartRequest({ ...validRequest(), reasonSummary: '   ' }), /must be a non-empty string/);

  // The epoch default and `priority: 'normal'` live only in the admission gate.
  const noCreatedAt = validRequest();
  delete noCreatedAt.priority;
  assert.equal(validateShape(noCreatedAt).request.createdAt, EPOCH);
  assert.throws(
    () => normalizedRequest({ ...validateShape(noCreatedAt).request, createdAt: undefined }),
    /NormalizedRequest\.createdAt is required/,
  );

  assert.throws(() => modeConfig({ enabled: true }), /ModeConfig\.minIntervalMs is required/);
  assert.throws(() => modeConfig({ enabled: 'yes', minIntervalMs: 1 }), /must be a boolean/);
});

test('a contract factory copies, freezes and carries only declared fields', () => {
  const source = { ...validRequest(), stray: 'not part of the protocol' };
  const request = restartRequest(source);
  assert.equal(Object.isFrozen(request), true);
  assert.equal('stray' in request, false, 'stray properties are not carried into the copy');
  assert.deepEqual(Object.keys(request), [
    'requestId',
    'source',
    'mode',
    'reasonCode',
    'reasonSummary',
    'checkpointRequired',
    'priority',
  ]);

  source.requestId = 'mutated-later';
  assert.equal(request.requestId, 'req-1', 'the copy does not alias its input');

  const config = restartConfig(baseConfig());
  assert.equal(Object.isFrozen(config.safety), true);
  assert.equal(Object.isFrozen(config.allowedSources), true);
  assert.throws(() => {
    config.safety.checkpointRequired = false;
  }, TypeError);

  const state = validatorContext(context());
  assert.equal(Object.isFrozen(state.cooldowns), true);
  assert.equal(validateRequest(validRequest(), config, state).valid, true, 'the factories interlock with the ladder');
});

test('the three seams are separate, and only the shutdown port asks the host', () => {
  const checkpoint = checkpointPort({
    id: 'harness-checkpoint',
    prepareForRestart: () => ({ safe: true }),
    acknowledgeResume: () => true,
  });
  assert.equal(Object.isFrozen(checkpoint), true);
  assert.throws(() => checkpointPort({ id: 'x', prepareForRestart: () => true }), /CheckpointPort\.acknowledgeResume is required/);

  const shutdown = shutdownPort({ id: 'harness-shutdown', requestShutdown: () => true });
  assert.equal(Object.isFrozen(shutdown), true);

  const system = systemShutdownPort({ id: 'windows-reboot', requestSystemRestart: () => true });
  assert.equal(Object.isFrozen(system), true);

  // A shutdown port is not a system port: application restart must not require one.
  assert.throws(() => validateSystemShutdownPort(shutdown), /SystemShutdownPort\.requestSystemRestart is required/);
  assert.throws(() => shutdownPort(system), /ShutdownPort\.requestShutdown is required/);
});
