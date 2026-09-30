// Generic managed-process runtime (EM-002).
//
// Hosts Node/Python/EXE/CLI-style workers through an injected process port. The runtime knows
// about processes, transports, capabilities and budgets — never about what a worker *means*, so
// it stays business-agnostic and a new connector is a manifest, not a runtime change.
//
// Bounded by construction: startup, heartbeat freshness, log size and restart count are all
// limited, and exhausting the restart budget ends in a terminal safe mode.
import { ConnectorError, assertConnectorManifest, authorizeInvocation, mediateConnectorPermissions } from './manifest.mjs';

/**
 * Coerce a caller- or clock-supplied instant to epoch milliseconds, or `null` when it is genuinely
 * absent.
 *
 * Freshness used to compare `Date.parse(last)` against the raw `now` value, and the runtime's own
 * clock returns an ISO string — so `'2026-…' - 1759…` was NaN, `stale` was false forever, and the
 * whole HEARTBEAT_LOST -> DEGRADED path was dead code. A three-hour-old heartbeat was reported
 * fresh against a thirty-second budget. Both sides are numbers now.
 */
export function toEpochMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export const RUNTIME_STATES = Object.freeze(['STOPPED', 'STARTING', 'READY', 'DEGRADED', 'SAFE_MODE']);
export const LOG_STREAMS = Object.freeze(['STDOUT', 'STDERR', 'RUNTIME']);
export const DEFAULT_HOST = 'local';

/**
 * Deterministic process port double. `script` decides how each spawn behaves:
 *   {ready: true}                 → process starts and is ready
 *   {ready: false, reason}        → process never becomes ready (bounded-startup path)
 *   {throws: 'CODE'}              → the spawn itself fails
 * Invocations are recorded, and `responses` can script their outcome.
 */
export function createProcessPortDouble({ script = [], responses = {} } = {}) {
  const spawned = [];
  const invoked = [];
  let cursor = 0;
  return Object.freeze({
    spawn(request) {
      const step = script[cursor] ?? { ready: true };
      cursor += 1;
      spawned.push({ request: { ...request }, step: { ...step } });
      if (step.throws) throw Object.assign(new Error(step.throws), { code: step.throws });
      return { handle_ref: `handle-${cursor}`, ready: step.ready !== false, reason: step.reason ?? null, pid: 1000 + cursor };
    },
    invoke({ handle_ref, capability_id, method, input }) {
      invoked.push({ handle_ref, capability_id, method, input });
      const key = `${capability_id}.${method}`;
      const scripted = responses[key];
      if (scripted === undefined) return { ok: true, output: `${key} completed` };
      if (scripted.throws) throw Object.assign(new Error(scripted.throws), { code: scripted.throws });
      return { ...scripted };
    },
    kill({ handle_ref }) { return { handle_ref, killed: true }; },
    __spawned: spawned,
    __invoked: invoked,
  });
}

/** Default RedactionPolicy: no patterns, so nothing is redacted unless the caller asks for it. */
export const DEFAULT_REDACTION_POLICY = Object.freeze({ patterns: Object.freeze([]), replacement: '[redacted]' });

function applyRedaction(text, policy) {
  let output = String(text);
  for (const pattern of policy.patterns ?? []) {
    if (pattern instanceof RegExp) output = output.replace(pattern, policy.replacement ?? '[redacted]');
    else if (typeof pattern === 'string' && pattern !== '') output = output.split(pattern).join(policy.replacement ?? '[redacted]');
  }
  return output;
}

export function createManagedProcessRuntime({ spawnProcess, clock = () => null, host = DEFAULT_HOST } = {}) {
  if (!spawnProcess || typeof spawnProcess.spawn !== 'function') throw new ConnectorError('PROCESS_SPAWN_FAILED', 'a process port with spawn() is required');
  const instances = new Map();

  const requireInstance = instanceRef => {
    const instance = instances.get(instanceRef);
    if (!instance) throw new ConnectorError('RUNTIME_NOT_STARTED', String(instanceRef));
    return instance;
  };

  const writeLog = (instance, { stream, text, at }) => {
    if (!LOG_STREAMS.includes(stream)) throw new ConnectorError('INVALID_CONNECTOR_MANIFEST', `unknown log stream ${stream}`);
    const budget = instance.manifest.limits.max_log_bytes;
    const redacted = applyRedaction(text, instance.redaction);
    const remaining = budget - instance.log_bytes;
    if (remaining <= 0) { instance.log_truncated = true; return { appended: false, truncated: true }; }
    const slice = redacted.slice(0, remaining);
    instance.logs.push({ at: at ?? null, stream, text: slice });
    instance.log_bytes += slice.length;
    if (slice.length < redacted.length) instance.log_truncated = true;
    return { appended: true, truncated: slice.length < redacted.length };
  };

  /**
   * Kill a handle and require the port to confirm it.
   *
   * Kill was fire-and-forget: a port answering `{killed:false}` was never inspected, so a process
   * that refused to die was treated as gone. The handle is cleared only on a confirmed kill, and an
   * unconfirmed one is recorded as data rather than assumed away.
   */
  const killHandle = (instance, at) => {
    if (!instance.handle_ref) return { attempted: false, confirmed: false, code: null };
    let result = null;
    try {
      result = spawnProcess.kill({ handle_ref: instance.handle_ref });
    } catch (error) {
      instance.failures.push({ code: 'KILL_FAILED', detail: String(error?.message ?? error).slice(0, 160) });
      writeLog(instance, { stream: 'RUNTIME', text: `kill failed: ${error?.code ?? error?.message}`, at });
      return { attempted: true, confirmed: false, code: 'KILL_FAILED' };
    }
    if (result?.killed === true) {
      instance.handle_ref = null;
      return { attempted: true, confirmed: true, code: null };
    }
    instance.failures.push({ code: 'KILL_NOT_CONFIRMED', detail: 'the process port did not confirm the kill' });
    writeLog(instance, { stream: 'RUNTIME', text: 'kill was not confirmed by the process port', at });
    return { attempted: true, confirmed: false, code: 'KILL_NOT_CONFIRMED' };
  };

  const runtime = {
    start({ manifest, instanceRef, policyDecision = { granted: [], refused: [] } } = {}) {
      const declared = assertConnectorManifest(manifest);
      if (typeof instanceRef !== 'string' || instanceRef.trim() === '') throw new ConnectorError('INVALID_CONNECTOR_MANIFEST', 'instanceRef is required');
      const existing = instances.get(instanceRef);
      if (existing?.state === 'SAFE_MODE') throw new ConnectorError('RUNTIME_IN_SAFE_MODE', `${instanceRef} is in terminal safe mode`);
      const granted = Array.isArray(policyDecision.granted) ? policyDecision.granted : [];
      const refused = Array.isArray(policyDecision.refused) ? policyDecision.refused : [];
      // The effective set is the *intersection* the mediator computes, not whatever the caller
      // passed. `start` copied `policyDecision.granted` verbatim and never called the mediator, so an
      // undeclared grant was neither refused nor dropped and duplicates survived into provenance -
      // while the same decision through `mediateConnectorPermissions` was refused.
      const mediated = mediateConnectorPermissions(declared, { granted, refused });
      const instance = existing ?? {
        instance_ref: instanceRef,
        manifest: declared,
        state: 'STOPPED',
        handle_ref: null,
        restarts: 0,
        safe_mode: false,
        logs: [],
        log_bytes: 0,
        log_truncated: false,
        redaction: DEFAULT_REDACTION_POLICY,
        started_at: null,
        last_heartbeat_at: null,
        last_heartbeat_ms: null,
        degrade_reason: null,
        permission: { granted: [], refused: [] },
        failures: [],
      };
      instance.manifest = declared;
      instance.permission = {
        granted: [...mediated.granted],
        refused: mediated.refused.map((entry) => ({ ...entry })),
        undecided: [...mediated.undecided],
      };
      instance.state = 'STARTING';
      instance.degrade_reason = null;
      let spawned;
      try {
        // The execution bounds travel with the request. The runtime used to hand the port only
        // `{entry_ref, runtime_kind, host}`, so nothing downstream was told the startup budget, the
        // log budget, or the stdio/shell contract - an unbounded request. The port owns enforcement
        // (a synchronous module cannot own a timer), but it can no longer claim it was not told.
        spawned = spawnProcess.spawn({
          entry_ref: declared.entry_ref,
          runtime_kind: declared.runtime_kind,
          host,
          startup_timeout_ms: declared.limits.startup_timeout_ms,
          max_log_bytes: declared.limits.max_log_bytes,
          stdio: 'pipe',
          shell: false,
        });
      } catch (error) {
        // A process that will not start is data, not a crash.
        instance.state = 'DEGRADED';
        instance.degrade_reason = 'PROCESS_SPAWN_FAILED';
        instance.failures.push({ code: 'PROCESS_SPAWN_FAILED', detail: String(error?.code ?? error?.message ?? error).slice(0, 160) });
        writeLog(instance, { stream: 'RUNTIME', text: `spawn failed: ${error?.code ?? error?.message}`, at: clock() });
        instances.set(instanceRef, instance);
        return { instanceRef, state: instance.state, started: false, code: 'PROCESS_SPAWN_FAILED' };
      }
      instance.handle_ref = spawned?.handle_ref ?? null;
      instance.started_at = clock() ?? null;
      instance.last_heartbeat_at = instance.started_at;
      instance.last_heartbeat_ms = toEpochMs(instance.started_at);
      if (spawned?.ready !== true) {
        // Bounded startup: an unready process is stopped, never waited on forever.
        instance.state = 'DEGRADED';
        instance.degrade_reason = 'STARTUP_TIMEOUT';
        instance.failures.push({ code: 'STARTUP_TIMEOUT', detail: `startup budget ${declared.limits.startup_timeout_ms}ms was not met${spawned?.reason ? `: ${spawned.reason}` : ''}` });
        killHandle(instance, instance.started_at);
        instances.set(instanceRef, instance);
        return { instanceRef, state: instance.state, started: false, code: 'STARTUP_TIMEOUT' };
      }
      instance.state = 'READY';
      instances.set(instanceRef, instance);
      writeLog(instance, { stream: 'RUNTIME', text: `${declared.connector_kind} started as ${declared.runtime_kind}`, at: instance.started_at });
      return { instanceRef, state: instance.state, started: true, code: null, handle_ref: instance.handle_ref };
    },

    heartbeat(instanceRef, { at = clock() } = {}) {
      const instance = requireInstance(instanceRef);
      if (instance.state === 'SAFE_MODE') throw new ConnectorError('RUNTIME_IN_SAFE_MODE', `${instanceRef} is in terminal safe mode`);
      instance.last_heartbeat_at = at ?? null;
      instance.last_heartbeat_ms = toEpochMs(at);
      // Only a *heartbeat loss* may be cleared by a heartbeat. One DEGRADED bucket held two
      // incompatible causes, so a process that had been killed by its startup timeout was promoted
      // to READY with no process, no new spawn, and a dead handle — and the next invoke reported
      // ok against it. A spawn failure is recovered by a spawn-verified restart, not by a pulse.
      if (instance.state === 'DEGRADED' && instance.degrade_reason === 'HEARTBEAT_LOST') {
        instance.state = instance.handle_ref ? 'READY' : 'DEGRADED';
        if (instance.state === 'READY') instance.degrade_reason = null;
      }
      return { instanceRef, state: instance.state, last_heartbeat_at: instance.last_heartbeat_at, degrade_reason: instance.degrade_reason ?? null };
    },

    /** Freshness is measured against the manifest's declared interval, not a global constant. */
    checkHealth(instanceRef, { now = clock() } = {}) {
      const instance = requireInstance(instanceRef);
      if (instance.state === 'SAFE_MODE') return { instanceRef, state: 'SAFE_MODE', stale: false, code: 'RUNTIME_IN_SAFE_MODE' };
      if (instance.state === 'STOPPED' || instance.state === 'STARTING') return { instanceRef, state: instance.state, stale: false, code: null };
      const last = instance.last_heartbeat_ms ?? toEpochMs(instance.last_heartbeat_at);
      const nowMs = toEpochMs(now);
      // An instant that was supplied but cannot be read is refused rather than treated as "fresh":
      // failing open on an unreadable clock is how a stale instance stays READY forever.
      if (now !== null && now !== undefined && nowMs === null) {
        throw new ConnectorError('INVALID_TIMESTAMP', `now ${JSON.stringify(now)} is not a readable instant`);
      }
      if (instance.last_heartbeat_at !== null && instance.last_heartbeat_at !== undefined && last === null) {
        throw new ConnectorError('INVALID_TIMESTAMP', `heartbeat ${JSON.stringify(instance.last_heartbeat_at)} is not a readable instant`);
      }
      const budget = instance.manifest.limits.heartbeat_interval_ms;
      const stale = last !== null && nowMs !== null && (nowMs - last) > budget;
      if (stale) {
        instance.state = 'DEGRADED';
        instance.degrade_reason = 'HEARTBEAT_LOST';
        instance.failures.push({ code: 'HEARTBEAT_LOST', detail: `no heartbeat within ${budget}ms` });
        return { instanceRef, state: 'DEGRADED', stale: true, code: 'HEARTBEAT_LOST' };
      }
      return { instanceRef, state: instance.state, stale: false, code: null };
    },

    invoke(instanceRef, { capabilityId, method, input = {}, at = clock() } = {}) {
      const instance = requireInstance(instanceRef);
      if (instance.state === 'SAFE_MODE') throw new ConnectorError('RUNTIME_IN_SAFE_MODE', `${instanceRef} is in terminal safe mode`);
      if (instance.state !== 'READY') throw new ConnectorError('RUNTIME_NOT_STARTED', `${instanceRef} is ${instance.state}`);
      // Undeclared capability/method/need calls are refused before the process is touched.
      const authorization = authorizeInvocation(instance.manifest, { granted: instance.permission.granted, refused: instance.permission.refused }, { capabilityId, method });
      try {
        const response = spawnProcess.invoke({ handle_ref: instance.handle_ref, capability_id: capabilityId, method, input });
        writeLog(instance, { stream: 'STDOUT', text: `${capabilityId}.${method} -> ${response?.ok === false ? 'failed' : 'ok'}`, at });
        return { instanceRef, authorization, ok: response?.ok !== false, output: response?.output ?? null, code: response?.code ?? null };
      } catch (error) {
        const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'PROCESS_SPAWN_FAILED';
        instance.failures.push({ code, detail: String(error?.message ?? error).slice(0, 160) });
        writeLog(instance, { stream: 'STDERR', text: `${capabilityId}.${method} failed: ${code}`, at });
        return { instanceRef, authorization, ok: false, output: null, code };
      }
    },

    /** Restart budget is bounded; exhaustion is terminal, not a loop. */
    restart(instanceRef, { reason = 'requested', at = clock() } = {}) {
      const instance = requireInstance(instanceRef);
      if (instance.state === 'SAFE_MODE') return { instanceRef, state: 'SAFE_MODE', restarted: false, code: 'RUNTIME_IN_SAFE_MODE' };
      instance.restarts += 1;
      if (instance.restarts > instance.manifest.limits.max_restarts) {
        instance.state = 'SAFE_MODE';
        instance.safe_mode = true;
        instance.safe_mode_at = at ?? null;
        instance.safe_mode_reason = `restart budget ${instance.manifest.limits.max_restarts} exhausted (${reason})`;
        killHandle(instance, at);
        writeLog(instance, { stream: 'RUNTIME', text: `entered terminal safe mode: ${instance.safe_mode_reason}`, at });
        return { instanceRef, state: 'SAFE_MODE', restarted: false, code: 'RESTART_BUDGET_EXHAUSTED', restarts: instance.restarts };
      }
      const started = runtime.start({ manifest: instance.manifest, instanceRef, policyDecision: instance.permission });
      if (!started.started) {
        // A failed restart still consumes budget, so a crash loop cannot spin forever.
        return { instanceRef, state: instance.state, restarted: false, code: started.code, restarts: instance.restarts };
      }
      return { instanceRef, state: instance.state, restarted: true, code: null, restarts: instance.restarts };
    },

    stop(instanceRef) {
      const instance = requireInstance(instanceRef);
      const kill = killHandle(instance, clock());
      instance.state = 'STOPPED';
      instance.degrade_reason = null;
      return { instanceRef, state: instance.state, stopped: true, kill_confirmed: kill.confirmed, kill_code: kill.code };
    },

    setRedactionPolicy(instanceRef, policy) {
      const instance = requireInstance(instanceRef);
      if (policy !== null && typeof policy !== 'object') throw new ConnectorError('INVALID_CONNECTOR_MANIFEST', 'a redaction policy must be an object');
      instance.redaction = { patterns: [...(policy?.patterns ?? [])], replacement: policy?.replacement ?? '[redacted]' };
      return { instanceRef, patterns: instance.redaction.patterns.length };
    },

    appendLog(instanceRef, entry) { return writeLog(requireInstance(instanceRef), entry ?? {}); },

    getLogs(instanceRef) {
      const instance = requireInstance(instanceRef);
      return { instanceRef, entries: instance.logs.map(entry => ({ ...entry })), truncated: instance.log_truncated, bytes: instance.log_bytes, budget: instance.manifest.limits.max_log_bytes };
    },

    state(instanceRef) { const instance = requireInstance(instanceRef); return { instanceRef, state: instance.state, restarts: instance.restarts, safe_mode: instance.safe_mode, failures: instance.failures.map(failure => ({ ...failure })) }; },

    /** Terminal safe mode is cleared only by an explicit operator action, never by a retry. */
    clearSafeMode(instanceRef, { operatorRef, at = clock() } = {}) {
      const instance = requireInstance(instanceRef);
      if (!instance.safe_mode) throw new ConnectorError('RUNTIME_IN_SAFE_MODE', `${instanceRef} is not in safe mode`);
      if (typeof operatorRef !== 'string' || operatorRef.trim() === '') throw new ConnectorError('RUNTIME_IN_SAFE_MODE', 'clearing safe mode requires an operator reference');
      instance.safe_mode = false;
      instance.state = 'STOPPED';
      instance.restarts = 0;
      instance.restarts_cleared_at = at ?? null;
      instance.restarts_cleared_by = operatorRef;
      return { instanceRef, state: instance.state, cleared_by: operatorRef };
    },

    /** Provenance: detection evidence, selected adapter, granted/refused permissions, runtime kind. */
    provenance(instanceRef) {
      const instance = requireInstance(instanceRef);
      return {
        instance_ref: instanceRef,
        connector_kind: instance.manifest.connector_kind,
        runtime_kind: instance.manifest.runtime_kind,
        entry_ref: instance.manifest.entry_ref,
        detection_evidence: instance.manifest.provenance.detection_evidence,
        selected_adapter_ref: instance.manifest.provenance.selected_adapter_ref,
        granted_permissions: [...instance.permission.granted].sort(),
        refused_permissions: instance.permission.refused.map(entry => ({ ...entry })),
        state: instance.state,
        restarts: instance.restarts,
        safe_mode: instance.safe_mode,
        host,
      };
    },

    listInstances() { return [...instances.keys()].sort(); },
  };

  return Object.freeze(runtime);
}
