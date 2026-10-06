// WBC-604: the runtime Execution Profile switch.
//
// WHAT THIS REPLACES. Until now the profile was frozen at startup by CITY_EXECUTION_PROFILE and any non-default value was
// refused, so enabling a future Workbench would have needed a code change and a redeploy. This module makes the profile a
// runtime, persisted, reversible decision with a typed control surface, which is what the workbook's "direct switch"
// section requires: no code submission to cut over, and a rollback that needs no database downgrade.
//
// THE FOUR RULES IT KEEPS:
//   1. STANDARD_DEVICES is the default AND the rollback profile; it can never be refused, because refusing it would leave
//      a City with no working backend.
//   2. WORKER_POOL/HYBRID may only be entered when the registry reports the backend READY. A failed activation leaves the
//      CURRENT profile in place and answers a typed rejection - it never half-switches and never crashes the City.
//   3. Persistence is trusted only when it parses to a known profile. Anything else (missing, corrupt, unknown value) is
//      recovered conservatively to STANDARD_DEVICES with the reason recorded, because a City that cannot read its own
//      profile must still start.
//   4. A change is a single decision: readiness is read once, the receipt states what was decided and why, and a rejected
//      change writes nothing.
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {EXECUTION_PROFILES, DEFAULT_EXECUTION_PROFILE, assertProfile} from '../../contracts/execution-backend-v1/execution-backend.mjs';

/** Typed refusals. A caller can tell "I don't know that profile" from "that profile is not ready right now". */
export const PROFILE_CODES = Object.freeze({
  UNKNOWN_PROFILE: 'PROFILE_UNKNOWN',
  NOT_READY: 'PROFILE_NOT_READY',
  RECOVERY_REQUIRED: 'PROFILE_RECOVERY_REQUIRED',
});

export class ProfileChangeError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ProfileChangeError';
    this.code = code;
    this.detail = detail;
  }
}

const stateOf = readiness => (typeof readiness === 'string' ? readiness : readiness?.state ?? 'UNKNOWN');
const reasonOf = readiness => (typeof readiness === 'string' ? null : readiness?.reason ?? null);

export function createExecutionProfileController({dir, registry = null, readinessOf = null, initial = DEFAULT_EXECUTION_PROFILE, clock = () => Date.now()} = {}) {
  const readProfile = readinessOf ?? (candidate => registry?.readiness?.(candidate));
  if (typeof readProfile !== 'function') throw new TypeError('An execution backend registry or a readinessOf function is required');
  const file = resolve(dir, 'execution-profile.json');

  // --- how this City's profile was decided, and why ---------------------------------------------------------------
  let recovery = null;
  let profile = DEFAULT_EXECUTION_PROFILE;
  if (EXECUTION_PROFILES.includes(initial)) profile = initial;
  else recovery = {code: PROFILE_CODES.UNKNOWN_PROFILE, detail: `initial ${String(initial)} is not a known profile`};

  /** Read the persisted selection. A file that cannot be trusted is NOT obeyed - it is replaced by the safe default. */
  function load() {
    if (!existsSync(file)) return {source: 'DEFAULT'};
    try {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      if (!record || !EXECUTION_PROFILES.includes(record.profile)) {
        recovery = {code: PROFILE_CODES.UNKNOWN_PROFILE, detail: `persisted value ${JSON.stringify(record?.profile ?? null)} is not a known profile`};
        return {source: 'RECOVERED'};
      }
      profile = record.profile;
      return {source: 'PERSISTED', changedAt: Number.isFinite(record.changedAt) ? record.changedAt : null};
    } catch (error) {
      recovery = {code: PROFILE_CODES.RECOVERY_REQUIRED, detail: `persisted selection unreadable: ${error.message}`};
      return {source: 'RECOVERED'};
    }
  }
  const loaded = load();
  if (loaded.source === 'RECOVERED') profile = DEFAULT_EXECUTION_PROFILE;

  /** Write through a temporary file, so a crash mid-write cannot leave half a profile behind. */
  function persist() {
    mkdirSync(dir, {recursive: true});
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify({profile, changedAt: clock()}), {mode: 0o600});
    renameSync(temporary, file);
  }

  /** Readiness of every profile, so a control surface can show what is switchable before anyone tries. */
  function readiness() {
    return EXECUTION_PROFILES.map(candidate => {
      if (candidate === DEFAULT_EXECUTION_PROFILE) return {profile: candidate, state: 'READY', reason: 'ROLLBACK_PROFILE', activatable: true};
      let state = 'UNKNOWN';
      let reason = null;
      try {
        const report = readProfile(candidate);
        state = stateOf(report);
        reason = reasonOf(report);
      } catch (error) {
        state = 'UNAVAILABLE';
        reason = `readiness failed: ${error.message}`;
      }
      return {profile: candidate, state, reason, activatable: state === 'READY'};
    });
  }

  function state() {
    return {
      profile,
      defaultProfile: DEFAULT_EXECUTION_PROFILE,
      profiles: readiness(),
      selection: loaded.source === 'RECOVERED' ? 'RECOVERED_TO_DEFAULT' : loaded.source,
      recovery,
      changedAt: loaded.changedAt ?? null,
    };
  }

  /**
   * Request a change. Order matters and is the contract: unknown profile -> refused; not-ready non-default -> refused and
   * NOTHING is written; unchanged -> answered as a no-op receipt rather than a silent success.
   */
  function change(requested) {
    if (!EXECUTION_PROFILES.includes(requested)) {
      throw new ProfileChangeError(PROFILE_CODES.UNKNOWN_PROFILE, `Unknown execution profile ${String(requested)}`, {supported: [...EXECUTION_PROFILES]});
    }
    const from = profile;
    if (requested === from) return {changed: false, from, to: from, reason: 'ALREADY_SELECTED', readiness: readiness()};
    if (requested !== DEFAULT_EXECUTION_PROFILE) {
      const report = readiness().find(entry => entry.profile === requested);
      if (!report?.activatable) {
        throw new ProfileChangeError(PROFILE_CODES.NOT_READY, `Execution profile ${requested} is not ready (${report?.state ?? 'UNKNOWN'}${report?.reason ? ': ' + report.reason : ''})`, {profile: requested, state: report?.state ?? 'UNKNOWN', reason: report?.reason ?? null, kept: from});
      }
    }
    profile = requested;
    recovery = null;
    persist();
    loaded.source = 'PERSISTED';
    loaded.changedAt = clock();
    return {changed: true, from, to: requested, reason: 'ACTIVATED', readiness: readiness()};
  }

  /** STANDARD_DEVICES is always enterable: this is the rollback the workbook requires, and it needs no schema change. */
  const rollback = () => change(DEFAULT_EXECUTION_PROFILE);

  return {state, readiness, change, rollback, profile: () => profile, file};
}

/**
 * HYBRID candidate choice, as an explicit precedence rather than a score.
 *
 * The workbook lists seven rules; they are encoded in this order because a later rule may never override an earlier one:
 *   1. an explicit strict target outranks any general routing;
 *   2. a hard platform/capability requirement outranks a performance preference;
 *   3. trust and readiness outrank load;
 *   4. a task that declares no requirements keeps the legacy default and is not rerouted by the new model;
 *   5. only a task whose policy allows it may fall back to STANDARD_DEVICES when the pool is unavailable;
 *   6. a platform-validation workload goes to a matching real validation node;
 *   7. "faster" never crosses a user/permission/trust gate.
 * The return value always says which rule decided, so a path can be explained instead of inferred.
 */
export function chooseHybridTarget({task = {}, candidates = [], poolAvailable = true} = {}) {
  const allowed = candidates.filter(candidate => candidate?.trusted !== false);

  if (task.strictTargetRef) {
    const strict = candidates.find(candidate => candidate.nodeId === task.strictTargetRef);
    if (!strict) return {chosen: null, rule: 'STRICT_TARGET_ABSENT', reason: 'the explicit target is not registered; hybrid must not reinterpret it'};
    if (strict.trusted === false) return {chosen: null, rule: 'STRICT_TARGET_UNTRUSTED', reason: 'the explicit target is not trusted'};
    return {chosen: strict.nodeId, rule: 'STRICT_TARGET', reason: 'an explicit target outranks every general rule'};
  }

  const required = [...(task.requiredCapabilities ?? [])];
  const requiredPlatform = task.requiredPlatform ?? null;
  if (required.length > 0 || requiredPlatform) {
    const capable = allowed.filter(candidate => {
      const capabilities = candidate.capabilities ?? [];
      const hasCapabilities = required.every(capability => capabilities.includes(capability));
      const hasPlatform = !requiredPlatform || candidate.platform === requiredPlatform;
      return hasCapabilities && hasPlatform && candidate.ready !== false;
    });
    if (capable.length === 0) {
      return poolAvailable
        ? {chosen: null, rule: 'NO_CAPABLE_NODE', reason: 'no trusted, ready node satisfies the hard requirements'}
        : {chosen: null, rule: 'POOL_UNAVAILABLE', reason: 'the pool is unavailable and this task has hard requirements'};
    }
    const validation = capable.find(candidate => candidate.roles?.includes('VALIDATION_NODE') && candidate.validationCapable === true);
    if (validation) return {chosen: validation.nodeId, rule: 'VALIDATION_NODE', reason: 'a platform-validation workload goes to a matching real validation node'};
    const best = capable.slice().sort((a, b) => (b.freeSlots ?? 0) - (a.freeSlots ?? 0))[0];
    return {chosen: best.nodeId, rule: 'HARD_REQUIREMENT', reason: 'a hard platform/capability requirement decided this, not load'};
  }

  // Rule 4 + 5: a legacy task that declares nothing keeps the compatible default unless policy explicitly allows a switch.
  if (task.policyAllowsFallback !== true) {
    return {chosen: null, rule: 'LEGACY_DEFAULT', reason: 'this task declares no requirements, so it keeps the compatible default path'};
  }
  if (!poolAvailable) {
    return {chosen: null, rule: 'POOL_UNAVAILABLE', reason: 'the pool is unavailable; the caller may use STANDARD_DEVICES because policy allows it'};
  }
  const ready = allowed.filter(candidate => candidate.ready !== false);
  if (ready.length === 0) return {chosen: null, rule: 'NO_READY_NODE', reason: 'no trusted, ready node is available'};
  const best = ready.slice().sort((a, b) => (b.freeSlots ?? 0) - (a.freeSlots ?? 0))[0];
  return {chosen: best.nodeId, rule: 'LOAD_PREFERENCE', reason: 'no hard requirement applied, so the least loaded ready node is chosen'};
}
