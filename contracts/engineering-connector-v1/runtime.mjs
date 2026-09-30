// Generic managed-process runtime (EM-002).
//
// Hosts Node/Python/EXE/CLI-style workers through an injected process port. The runtime knows
// about processes, transports, capabilities and budgets — never about what a worker *means*, so
// it stays business-agnostic and a new connector is a manifest, not a runtime change.
//
// Bounded by construction: startup, heartbeat freshness, log size and restart count are all
// limited, and exhausting the restart budget ends in a terminal safe mode.
import { ConnectorError, assertConnectorManifest, authorizeInvocation } from './manifest.mjs';

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

  const runtime = {
    start({ manifest, instanceRef, policyDecision = { granted: [], refused: [] } } = {}) {
      const declared = assertConnectorManifest(manifest);
      if (typeof instanceRef !== 'string' || instanceRef.trim() === '') throw new ConnectorError('INVALID_CONNECTOR_MANIFEST', 'instanceRef is required');
      const existing = instances.get(instanceRef);
      if (existing?.state === 'SAFE_MODE') throw new ConnectorError('RUNTIME_IN_SAFE_MODE', `${instanceRef} is in terminal safe mode`);
      const granted = Array.isArray(policyDecision.granted) ? policyDecision.granted : [];
      const refused = Array.isArray(policyDecision.refused) ? policyDecision.refused : [];
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
        permission: { granted: [...granted], refused: [...refused] },
        failures: [],
      };
      instance.manifest = declared;
      instance.permission = { granted: [...granted], refused: [...refused] };
      instance.state = 'STARTING';
      let spawned;
      try {
        spawned = spawnProcess.spawn({ entry_ref: declared.entry_ref, runtime_kind: declared.runtime_kind, host });
      } catch (error) {
        // A process that will not start is data, not a crash.
        instance.state = 'DEGRADED';
        instance.failures.push({ code: 'PROCESS_SPAWN_FAILED', detail: String(error?.code ?? error?.message ?? error).slice(0, 160) });
        writeLog(instance, { stream: 'RUNTIME', text: `spawn failed: ${error?.code ?? error?.message}`, at: clock() });
        instances.set(instanceRef, instance);
        return { instanceRef, state: instance.state, started: false, code: 'PROCESS_SPAWN_FAILED' };
      }
      instance.handle_ref = spawned?.handle_ref ?? null;
      instance.started_at = clock() ?? null;
      instance.last_heartbeat_at = instance.started_at;
      if (spawned?.ready !== true) {
        // Bounded startup: an unready process is stopped, never waited on forever.
        instance.state = 'DEGRADED';
        instance.failures.push({ code: 'STARTUP_TIMEOUT', detail: `startup budget ${declared.limits.startup_timeout_ms}ms was not met${spawned?.reason ? `: ${spawned.reason}` : ''}` });
        if (instance.handle_ref) spawnProcess.kill({ handle_ref: instance.handle_ref });
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
      if (instance.state === 'DEGRADED') instance.state = 'READY';
      return { instanceRef, state: instance.state, last_heartbeat_at: instance.last_heartbeat_at };
    },

    /** Freshness is measured against the manifest's declared interval, not a global constant. */
    checkHealth(instanceRef, { now = clock() } = {}) {
      const instance = requireInstance(instanceRef);
      if (instance.state === 'SAFE_MODE') return { instanceRef, state: 'SAFE_MODE', stale: false, code: 'RUNTIME_IN_SAFE_MODE' };
      if (instance.state === 'STOPPED' || instance.state === 'STARTING') return { instanceRef, state: instance.state, stale: false, code: null };
      const last = instance.last_heartbeat_at ? Date.parse(instance.last_heartbeat_at) : null;
      const budget = instance.manifest.limits.heartbeat_interval_ms;
      const stale = last !== null && now !== null && (now - last) > budget;
      if (stale) {
        instance.state = 'DEGRADED';
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
        if (instance.handle_ref) spawnProcess.kill({ handle_ref: instance.handle_ref });
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
      if (instance.handle_ref) spawnProcess.kill({ handle_ref: instance.handle_ref });
      instance.state = 'STOPPED';
      instance.handle_ref = null;
      return { instanceRef, state: instance.state, stopped: true };
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
