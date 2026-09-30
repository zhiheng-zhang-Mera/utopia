/**
 * UTOPIA · Engineering — restart-recovery-station — request admission.
 *
 * Donor: dsh-restart `src/plugin/request-validator.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd, ported field for field. The refusal
 * codes, the detail strings, the field bounds, the control-character pattern and
 * — most importantly — the *order* of the ladder are the donor's, unchanged.
 *
 * `dsh-restart` does not parse business meaning. It checks exactly the things the
 * design lists — id uniqueness, source permission, mode permission, cooldown,
 * pending restart, checkpoint requirement — and refuses everything else with a
 * machine-readable code.
 *
 * The order of the checks matters: cheap, structural refusals come first, so a
 * malformed request never reaches the code that writes files. `validateShape` is
 * the single admission gate and the only place a request is normalized; the
 * shape constructors in `contracts.mjs` refuse rather than repair, so nothing
 * here may delegate its defaults to them and nothing here may be bypassed.
 *
 * Determinism: the module is pure. `nowMs` and every other worldly fact arrive in
 * the `ValidatorContext`; no clock, filesystem, environment or randomness is read.
 * The one instant this module creates is the donor's `new Date(0).toISOString()`
 * epoch default, which is a constant, not a reading.
 *
 * @module dsh-restart/request-validator
 */

import { canonicalJson } from './canonical-json.mjs';

/** Upper bounds that keep a request from being used as a log-injection vector. */
export const MAX_ID_LENGTH = 128;

/** Upper bound of `RestartRequest.source` (donor `MAX_SOURCE_LENGTH`). */
export const MAX_SOURCE_LENGTH = 64;

/** Upper bound of `RestartRequest.reasonCode` (donor `MAX_REASON_CODE_LENGTH`). */
export const MAX_REASON_CODE_LENGTH = 64;

/** Upper bound of `RestartRequest.reasonSummary` (donor `MAX_SUMMARY_LENGTH`). */
export const MAX_SUMMARY_LENGTH = 500;

/** The four priorities the shape accepts; `priority` defaults to `normal`. */
const PRIORITIES = Object.freeze(['low', 'normal', 'high', 'emergency']);

/**
 * Field-level shape validation, before any policy check.
 *
 * Every string field must be a non-empty string after trimming, no longer than its
 * bound *after trimming*, and free of control characters. The normalized request
 * carries the trimmed text, `priority: request.priority ?? 'normal'`,
 * `createdAt: request.createdAt ?? new Date(0).toISOString()` and
 * `acknowledgeSystemReboot: request.acknowledgeSystemReboot === true`.
 *
 * @donor dsh-restart src/plugin/request-validator.ts `validateShape` @ e20fb6cc43e27cedf6303471e5b8ee18e1383ecd
 * @param {unknown} value - the untrusted request.
 * @returns {{valid: boolean, code: string|null, detail: string, request: object|null}}
 */
export function validateShape(value) {
  if (typeof value !== 'object' || value === null) {
    return refuse('INVALID_REQUEST', `request must be an object, received ${typeof value}`);
  }
  const request = value;

  const stringField = (field, entry, max) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return { ok: false, result: refuse('INVALID_REQUEST', `${String(field)} must be a non-empty string`) };
    }
    const trimmed = entry.trim();
    if (trimmed.length > max) {
      return { ok: false, result: refuse('INVALID_REQUEST', `${String(field)} exceeds ${max} characters`) };
    }
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      return { ok: false, result: refuse('INVALID_REQUEST', `${String(field)} contains control characters`) };
    }
    return { ok: true, value: trimmed };
  };

  const requestId = stringField('requestId', request.requestId, MAX_ID_LENGTH);
  if (!requestId.ok) return requestId.result;
  const source = stringField('source', request.source, MAX_SOURCE_LENGTH);
  if (!source.ok) return source.result;
  const reasonCode = stringField('reasonCode', request.reasonCode, MAX_REASON_CODE_LENGTH);
  if (!reasonCode.ok) return reasonCode.result;
  const reasonSummary = stringField('reasonSummary', request.reasonSummary, MAX_SUMMARY_LENGTH);
  if (!reasonSummary.ok) return reasonSummary.result;

  if (request.mode !== 'application' && request.mode !== 'system') {
    return refuse('INVALID_REQUEST', `mode must be "application" or "system", received ${JSON.stringify(request.mode)}`);
  }
  if (typeof request.checkpointRequired !== 'boolean') {
    return refuse('INVALID_REQUEST', 'checkpointRequired must be a boolean');
  }
  const priority = request.priority ?? 'normal';
  if (!PRIORITIES.includes(priority)) {
    return refuse('INVALID_REQUEST', `priority must be low, normal, high or emergency, received ${JSON.stringify(priority)}`);
  }
  if (request.createdAt !== undefined && typeof request.createdAt !== 'string') {
    return refuse('INVALID_REQUEST', 'createdAt must be an ISO-8601 string when present');
  }
  if (request.acknowledgeSystemReboot !== undefined && typeof request.acknowledgeSystemReboot !== 'boolean') {
    return refuse('INVALID_REQUEST', 'acknowledgeSystemReboot must be a boolean when present');
  }

  return {
    valid: true,
    code: null,
    detail: 'request shape is valid',
    request: {
      requestId: requestId.value,
      source: source.value,
      mode: request.mode,
      reasonCode: reasonCode.value,
      reasonSummary: reasonSummary.value,
      checkpointRequired: request.checkpointRequired,
      priority,
      createdAt: request.createdAt ?? new Date(0).toISOString(),
      acknowledgeSystemReboot: request.acknowledgeSystemReboot === true,
    },
  };
}

/**
 * Validate a request against configuration and world state.
 *
 * The ladder, in the donor's exact order, stopping at the first refusal:
 *
 *   1. shape                                    INVALID_REQUEST
 *   2. `config.enabled`                         DISABLED
 *   3. `config.allowedSources`                  UNKNOWN_SOURCE
 *   4. `config.allowedPriorities`               INVALID_REQUEST
 *   5. mode enabled (`applicationRestart` /
 *      `systemRestart`)                         MODE_NOT_ALLOWED
 *   6. `mode: "system"` only:
 *      `config.allowSystemReboot`               SYSTEM_REBOOT_NOT_PERMITTED
 *      `request.acknowledgeSystemReboot`        SYSTEM_REBOOT_NOT_PERMITTED
 *   7. `context.crashLoopTripped`               CRASH_LOOP
 *   8. `context.isDuplicate` and
 *      `safety.duplicateSuppression`            DUPLICATE_REQUEST_ID
 *   9. `context.restartInFlight`                RESTART_IN_FLIGHT
 *  10. mode cooldown deadline                   COOLDOWN_ACTIVE
 *  11. no checkpoint port and
 *      `safety.checkpointRequired`              CHECKPOINT_FAILED
 *  12. no supervisor and not
 *      `safety.allowRestartWithoutSupervisor`   SUPERVISOR_ABSENT
 *
 * @donor dsh-restart src/plugin/request-validator.ts `validateRequest` @ e20fb6cc43e27cedf6303471e5b8ee18e1383ecd
 * @param {unknown} value - the untrusted request.
 * @param {object} config - resolved configuration (`RestartConfig`).
 * @param {object} context - current world state (`ValidatorContext`).
 * @returns {{valid: boolean, code: string|null, detail: string, request: object|null}}
 */
export function validateRequest(value, config, context) {
  const shape = validateShape(value);
  if (!shape.valid || shape.request === null) return shape;
  const request = shape.request;

  if (!config.enabled) {
    return refuse('DISABLED', 'restart execution is disabled by configuration');
  }

  if (!config.allowedSources.includes(request.source)) {
    return refuse(
      'UNKNOWN_SOURCE',
      `source ${JSON.stringify(request.source)} is not allowed; allowed sources: ${config.allowedSources.join(', ')}`,
    );
  }

  if (!config.allowedPriorities.includes(request.priority)) {
    return refuse('INVALID_REQUEST', `priority ${request.priority} is not accepted by this deployment`);
  }

  const mode = request.mode === 'system' ? config.systemRestart : config.applicationRestart;
  if (!mode.enabled) {
    return refuse('MODE_NOT_ALLOWED', `${request.mode} restart is disabled by configuration`);
  }

  if (request.mode === 'system') {
    if (!config.allowSystemReboot) {
      return refuse(
        'SYSTEM_REBOOT_NOT_PERMITTED',
        'system restart requires allowSystemReboot = true in the configuration',
      );
    }
    if (!request.acknowledgeSystemReboot) {
      return refuse(
        'SYSTEM_REBOOT_NOT_PERMITTED',
        'system restart requires acknowledgeSystemReboot = true on the request itself',
      );
    }
  }

  if (context.crashLoopTripped) {
    return refuse(
      'CRASH_LOOP',
      'the crash-loop breaker has disabled automatic restart; clear it before requesting another restart',
    );
  }

  if (context.isDuplicate && config.safety.duplicateSuppression) {
    return refuse('DUPLICATE_REQUEST_ID', `request id ${request.requestId} has already been processed`);
  }

  if (context.restartInFlight) {
    return refuse('RESTART_IN_FLIGHT', 'another restart is already in progress');
  }

  const cooldown = request.mode === 'system' ? context.cooldowns.system : context.cooldowns.application;
  if (cooldown > context.nowMs) {
    const remaining = Math.ceil((cooldown - context.nowMs) / 1000);
    return refuse(
      'COOLDOWN_ACTIVE',
      `${request.mode} restart is in cooldown for another ${remaining}s (minimum interval ${Math.round(
        mode.minIntervalMs / 1000,
      )}s)`,
    );
  }

  if (!context.checkpointPortAvailable) {
    /*
     * No checkpoint port means the plugin cannot verify that a restart is safe.
     * When the deployment says a checkpoint is required, that is a refusal: the
     * design is explicit that a checkpoint that cannot be confirmed defaults to
     * aborting, and "no port" is the strongest form of "not confirmed".
     */
    if (config.safety.checkpointRequired) {
      return refuse(
        'CHECKPOINT_FAILED',
        'no checkpoint port is bound and safety.checkpointRequired is true, so a restart cannot be authorized',
      );
    }
  }

  if (!context.supervisorPresent && !config.safety.allowRestartWithoutSupervisor) {
    return refuse(
      'SUPERVISOR_ABSENT',
      'no supervisor heartbeat was seen; set safety.allowRestartWithoutSupervisor = true to restart anyway',
    );
  }

  return { valid: true, code: null, detail: 'request accepted', request };
}

/**
 * Build a refusal result.
 *
 * @donor dsh-restart src/plugin/request-validator.ts `refuse` @ e20fb6cc43e27cedf6303471e5b8ee18e1383ecd
 * @param {string} code - machine-readable refusal code.
 * @param {string} detail - human-readable explanation.
 * @returns {{valid: false, code: string, detail: string, request: null}}
 */
export function refuse(code, detail) {
  return { valid: false, code, detail, request: null };
}

/**
 * A stable identity for a request's *content*, used to tell a genuine retry from a
 * different request that happens to reuse an id.
 *
 * The fingerprint is canonical JSON over exactly the six fields the donor lists —
 * `requestId`, `source`, `mode`, `reasonCode`, `checkpointRequired`, `priority` —
 * so `reasonSummary`, `createdAt` and `acknowledgeSystemReboot` deliberately do
 * not affect it.
 *
 * @donor dsh-restart src/plugin/request-validator.ts `requestFingerprint` @ e20fb6cc43e27cedf6303471e5b8ee18e1383ecd
 * @param {object} request - a normalized request.
 * @returns {string} canonical JSON over the six fingerprinted fields.
 */
export function requestFingerprint(request) {
  return canonicalJson({
    requestId: request.requestId,
    source: request.source,
    mode: request.mode,
    reasonCode: request.reasonCode,
    checkpointRequired: request.checkpointRequired,
    priority: request.priority,
  });
}
