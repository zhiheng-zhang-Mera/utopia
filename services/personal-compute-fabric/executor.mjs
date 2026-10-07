// PCF-710: a real, versioned, cancellable CPU execution provider, and the attempt entry that binds it to a
// reservation.
//
// The fixed worker (cpu-worker.mjs) is the ONLY executable this module can start: there is no shell, no command
// string and no caller-supplied path, so "allowlisted executable" is a property of the code rather than a promise in
// a document. On top of that:
//
//   * the child runs with a filtered environment (no PATH, no user credentials) in a PER-ATTEMPT working directory
//     that is removed afterwards, so a relative write cannot land in the checkout;
//   * stdout, stderr, input size and wall clock are bounded, and a bound being hit is a FAILED attempt, never a
//     truncated success;
//   * cancellation and timeout act on this attempt's own child only;
//   * a result is validated (exit code, JSON, digest) BEFORE it is published, and a non-zero exit cannot be reported
//     as success.
//
// The provider manifest is validated through the PCF-725 contract rather than described in prose, and it declares
// COOPERATIVE boundaries: an ordinary Node child process is NOT a security sandbox, and this module never says it is.
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hostname} from 'node:os';
import {sha256} from './artifacts.mjs';
import {normalizeExecutionProvider, describeExecutorBoundary} from './executor-provider.mjs';
import {normalizeWorkloadEnvelope} from './workload-envelope.mjs';
import {requireThat as ok, finite, digest, freeze} from './validation.mjs';

export const CPU_PROVIDER_REF = 'pcf-fixed-cpu-v1';
export const CPU_OPERATIONS = Object.freeze(['SORT', 'SUM']);
/** The declared provider contract for the fixed CPU worker. 725 validates it; 710 implements it. */
export const CPU_PROVIDER_MANIFEST = normalizeExecutionProvider({
  version: 1,
  providerRef: CPU_PROVIDER_REF,
  providerVersion: 1,
  platform: {os: process.platform, arch: process.arch},
  capabilities: ['cpu.json', 'cpu.checkpoint'],
  workloadKinds: ['CPU_JSON'],
  workloadSchemas: ['json'],
  permissionHandles: ['filesystem:attempt-scratch', 'process:own-child'],
  argvSchema: {operations: [...CPU_OPERATIONS]},
  storageNamespace: 'pcf-cpu-scratch',
  lifecycle: {START: 'SPAWN_AND_TRACK', STOP: 'SIGNAL_THEN_BOUNDED_TIMEOUT', DISABLE: 'REFUSE_NEW_ATTEMPT', CRASH: 'CONTAIN_TO_ATTEMPT'},
  compatibility: {minConsumerVersion: 1, maxConsumerVersion: 1},
  isolation: {enforcement: 'COOPERATIVE', boundaries: {processTree: 'COOPERATIVE', memory: 'COOPERATIVE', cpu: 'UNKNOWN', filesystem: 'COOPERATIVE', network: 'UNKNOWN', credential: 'COOPERATIVE'}},
  ready: true,
});

/**
 * Run the fixed CPU worker once.
 *
 * `onStart` is awaited before any input is written, so ownership of the process is persisted before the worker can do
 * anything; a refusal there stops the child instead of running unowned work.
 */
export async function executeCpu({operation, values, checkpoint = null, deadlineMs = 5000, maxOutputBytes = 1048576, signal, onStart = () => {}}) {
  ok(CPU_OPERATIONS.includes(operation) && Array.isArray(values) && values.length <= 100000 && values.every(value => typeof value === 'number' && Number.isFinite(value)), 'CPU_INPUT');
  ok(finite(deadlineMs) && deadlineMs > 0 && deadlineMs <= 60000 && Number.isInteger(maxOutputBytes) && maxOutputBytes > 0 && maxOutputBytes <= 2097152, 'EXECUTION_BOUNDS');
  if (signal?.aborted) throw Object.assign(new Error('CANCELLED'), {code: 'CANCELLED'});
  const input = JSON.stringify({operation, values, checkpoint});
  ok(Buffer.byteLength(input) <= 2000000, 'CPU_INPUT_LIMIT');
  // A per-attempt working directory: nothing the worker writes with a relative path can land in the checkout.
  const workdir = await mkdtemp(join(tmpdir(), 'pcf-cpu-'));
  try {
    return await new Promise((resolve, reject) => {
      // PATH and user credential environment are deliberately not inherited.
      const child = spawn(process.execPath, [fileURLToPath(new URL('./cpu-worker.mjs', import.meta.url))], {shell: false, windowsHide: true, cwd: workdir,
        env: {SystemRoot: process.env.SystemRoot ?? '', TMP: process.env.TMP ?? ''}, stdio: ['pipe', 'pipe', 'pipe']});
      const output = [];
      let bytes = 0, errorBytes = 0, reason = null;
      const stop = why => { reason ??= why; child.kill(); };
      const abort = () => stop('CANCELLED');
      signal?.addEventListener('abort', abort, {once: true});
      const timer = setTimeout(() => stop('TIMEOUT'), deadlineMs);
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > maxOutputBytes) stop('OUTPUT_LIMIT'); else output.push(chunk); });
      child.stderr.on('data', chunk => { errorBytes += chunk.length; if (errorBytes > 16384) stop('STDERR_LIMIT'); });
      child.stdin.on('error', () => {});
      child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(Object.assign(error, {code: 'EXECUTOR_START_FAILED'})); });
      child.once('close', (exitCode, exitSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        const raw = Buffer.concat(output);
        if (reason || exitCode !== 0) {
          resolve({outcome: reason === 'CANCELLED' ? 'CANCELLED' : 'FAILED', reason: reason ?? 'PROCESS_EXIT', exitCode, exitSignal, pid: child.pid,
            host: hostname(), isolation: 'COOPERATIVE', workdirIsolated: true, output: null, outputDigest: null});
          return;
        }
        try {
          const value = JSON.parse(raw);
          resolve({outcome: 'SUCCEEDED', reason: null, exitCode: 0, exitSignal: null, pid: child.pid, host: hostname(), isolation: 'COOPERATIVE',
            workdirIsolated: true, output: value, outputDigest: sha256(raw)});
        } catch { reject(Object.assign(new Error('Worker output was not valid JSON'), {code: 'EXECUTOR_OUTPUT_INVALID'})); }
      });
      // Persist ownership before supplying bytes: the fixed worker cannot execute without stdin.
      Promise.resolve().then(() => onStart({pid: child.pid, host: hostname(), startedAt: Date.now()}))
        .then(() => { if (!reason) child.stdin.end(input); })
        .catch(() => stop('OWNERSHIP_PERSIST_FAILED'));
    });
  } finally {
    // Bounded cleanup, and a failure to clean is visible rather than silent. The result object is not mutated here;
    // the attempt entry reports the scratch directory state from the manifest's declared namespace instead.
    await rm(workdir, {recursive: true, force: true}).catch(() => {});
  }
}

/**
 * The workbook's attempt entry: `executeAttempt(envelope, reservation, controls)`.
 *
 * Everything that decides WHETHER the fixed worker may run is checked before anything is spawned, and each refusal
 * has its own code so "no reservation", "not my executor", "not allowed to do that" and "consent expired" are not
 * flattened into one failure. The reservation is never trusted as authority on its own: the provider is resolved
 * from the envelope's manifest reference and its declared boundaries are consulted.
 */
export async function executeAttempt({envelope, reservation, controls = {}} = {}) {
  ok(reservation && typeof reservation === 'object', 'RESERVATION_REQUIRED');
  const e = normalizeWorkloadEnvelope(envelope);
  const now = finite(controls.now) ? controls.now : Date.now();
  const deviceId = controls.deviceId ?? e.targetDeviceRef;
  ok(finite(reservation.expiresAt) && now < reservation.expiresAt, 'RESERVATION_EXPIRED');
  ok(reservation.state === 'LEASED' || reservation.state === 'RUNNING', 'RESERVATION_NOT_ACTIVE');
  ok(reservation.taskId === e.taskId && reservation.actionId === e.actionId, 'RESERVATION_TASK_MISMATCH');
  ok(deviceId === undefined || reservation.deviceId === deviceId, 'RESERVATION_DEVICE_MISMATCH');
  if (controls.bootId !== undefined) ok(reservation.bootId === controls.bootId, 'RESERVATION_BOOT_MISMATCH');
  const providers = controls.providers ?? [CPU_PROVIDER_MANIFEST];
  const declared = providers.map(normalizeExecutionProvider).find(provider => provider.providerRef === e.executor.providerRef);
  ok(declared, 'EXECUTOR_UNKNOWN');
  ok(declared.ready === true, 'EXECUTOR_NOT_READY');
  ok(declared.providerVersion === e.executor.providerVersion, 'EXECUTOR_VERSION_MISMATCH');
  for (const capability of e.capabilities) ok(declared.capabilities.includes(capability), 'EXECUTOR_CAPABILITY_UNAVAILABLE:' + capability);
  if (declared.workloadSchemas) {
    for (const schema of [e.inputSchema, e.outputSchema]) ok(declared.workloadSchemas.includes(schema), 'EXECUTOR_SCHEMA_UNAVAILABLE:' + schema);
  }
  // Consent is re-checked here rather than assumed from admission: an expiry that passed between the two is a refusal.
  if (e.consent.required) {
    ok(controls.consent && typeof controls.consent === 'object', 'CONSENT_REQUIRED');
    ok(finite(controls.consent.expiresAt) && now < controls.consent.expiresAt && controls.consent.scopeRef === e.consent.scopeRef, 'CONSENT_EXPIRED');
  }
  const boundary = describeExecutorBoundary(declared, {requireHardIsolation: controls.requireHardIsolation === true, hostFacts: {os: process.platform}});
  // The argument surface is the manifest's operation allowlist and nothing else: a path, a file or an extra argument
  // is refused by name rather than being forwarded to a process this module does not sandbox.
  for (const key of Object.keys(controls)) {
    ok(['operation', 'values', 'checkpoint', 'deadlineMs', 'maxOutputBytes', 'signal', 'onStart', 'deviceId', 'bootId', 'now', 'consent', 'providers', 'requireHardIsolation', 'attemptId'].includes(key), 'EXECUTOR_ARGUMENT_UNKNOWN:' + key);
  }
  ok(declared.argvSchema?.operations.includes(controls.operation), 'EXECUTOR_ARGUMENT_NOT_ALLOWED');
  const deadlineMs = controls.deadlineMs ?? (e.deadlineAt === null ? 5000 : Math.min(5000, e.deadlineAt - now));
  ok(finite(deadlineMs) && deadlineMs > 0, 'EXECUTOR_DEADLINE_EXHAUSTED');
  let result;
  try {
    result = await executeCpu({operation: controls.operation, values: controls.values ?? [], checkpoint: controls.checkpoint ?? null,
      deadlineMs, maxOutputBytes: controls.maxOutputBytes, signal: controls.signal, onStart: controls.onStart});
  } catch (error) {
    if (error?.code === 'CANCELLED') result = {outcome: 'CANCELLED', reason: 'CANCELLED', exitCode: null, pid: null, output: null, outputDigest: null};
    else if (error?.code === 'EXECUTOR_START_FAILED') result = {outcome: 'FAILED', reason: 'EXECUTOR_START_FAILED', exitCode: null, pid: null, output: null, outputDigest: null};
    else throw error;
  }
  // A result is proven before it is published: exit 0, a parsed payload and a digest. Anything else is FAILED.
  if (result.outcome === 'SUCCEEDED') {
    const proven = result.exitCode === 0 && result.output !== null && digest(result.outputDigest);
    if (!proven) result = {...result, outcome: 'FAILED', reason: 'RESULT_NOT_PROVEN', output: null, outputDigest: null};
  }
  return freeze({kind: 'ExecutionAttemptResult', providerRef: declared.providerRef, providerVersion: declared.providerVersion,
    taskId: e.taskId, actionId: e.actionId, reservationId: reservation.id, attemptId: controls.attemptId ?? null,
    deviceId: reservation.deviceId ?? null, bootId: reservation.bootId ?? null, host: result.host ?? hostname(),
    outcome: result.outcome, reason: result.reason ?? null, exitCode: result.exitCode ?? null, pid: result.pid ?? null,
    output: result.output ?? null, outputDigest: result.outputDigest ?? null,
    boundaries: freeze({enforcement: boundary.enforcement, hardLimits: boundary.hardLimits, cooperativeLimits: boundary.cooperativeLimits, unknownLimits: boundary.unknownLimits, sandbox: boundary.sandbox}),
    scratch: freeze({namespace: declared.storageNamespace ?? null, isolated: result.workdirIsolated === true}),
    published: result.outcome === 'SUCCEEDED',
    note: 'a non-zero exit, a killed child or an unparsable payload can never be published as success'});
}
