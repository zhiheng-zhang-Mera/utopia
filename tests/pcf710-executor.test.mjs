// PCF-710 acceptance: the real headless CPU executor and the attempt entry that binds it to a reservation.
//
// The workbook names these counterexamples: a missing reservation, expired consent, an unknown executor, an illegal
// argument, an out-of-bounds file, a surviving child, unlimited log, a cancellation race, a timeout, a wrong exit and
// an insufficient capability. Every one of them runs against the real fixed worker; nothing here is a stub callback.
import test from 'node:test';
import assert from 'node:assert/strict';
import {executeAttempt, executeCpu, CPU_PROVIDER_MANIFEST, CPU_PROVIDER_REF} from '../services/personal-compute-fabric/executor.mjs';
import {normalizeExecutionProvider} from '../services/personal-compute-fabric/executor-provider.mjs';

const envelope = (extra = {}) => ({envelopeVersion: 2, taskId: 'T-1', actionId: 'A-1', originDeviceId: 'alien', parentSessionId: 'S-1', appId: 'one',
  targetDeviceRef: 'alien', executor: {providerRef: CPU_PROVIDER_REF, providerVersion: 1, providerManifestRef: 'manifest:' + CPU_PROVIDER_REF},
  inputSchema: 'json', outputSchema: 'json', capabilities: ['cpu.json'], inputRefs: [], writeScope: [], platform: {os: [process.platform], arch: [process.arch]},
  qos: 'BATCH', retrySafety: 'SIDE_EFFECT_FREE', dataScope: 'PUBLIC', consent: {required: false, scopeRef: null},
  resources: {cpu: {amount: 1, unit: 'millicores'}}, deadlineAt: null, missPolicy: null, privilegeRequests: [], ...extra});
const reservation = (extra = {}) => ({id: 'RES-1', state: 'LEASED', taskId: 'T-1', actionId: 'A-1', deviceId: 'alien', bootId: 'boot-1', expiresAt: Date.now() + 60000, ...extra});
const controls = (extra = {}) => ({operation: 'SORT', values: [5, 1, 3], deviceId: 'alien', bootId: 'boot-1', ...extra});
const childGone = async pid => { for (let attempt = 0; attempt < 120; attempt++) { try { process.kill(pid, 0); } catch { return true; } await new Promise(resolve => setTimeout(resolve, 50)); } return false; };

test('PCF710-01 a real CPU job runs through the attempt entry and its result is proven before publication', async () => {
  const result = await executeAttempt({envelope: envelope(), reservation: reservation(), controls: controls({maxOutputBytes: 4096})});
  assert.equal(result.outcome, 'SUCCEEDED');
  assert.equal(result.published, true);
  assert.deepEqual(result.output.values, [1, 3, 5]);
  assert.equal(result.outputDigest.length, 64);
  assert.ok(result.pid > 0);
  assert.equal(result.providerRef, CPU_PROVIDER_REF);
  assert.equal(result.reservationId, 'RES-1');
  assert.equal(result.taskId, 'T-1');
  // The isolation story is the honest one: cooperative, explicitly not a sandbox, with the unenforced boundaries named.
  assert.equal(result.boundaries.enforcement, 'COOPERATIVE');
  assert.equal(result.boundaries.sandbox, 'NOT_A_SANDBOX');
  assert.ok(result.boundaries.unknownLimits.includes('memory') === false);
  assert.ok(result.boundaries.cooperativeLimits.includes('memory'));
  assert.equal(result.scratch.namespace, 'pcf-cpu-scratch');
  // LIMITATION, stated rather than papered over: `isolated` means the child was started in a per-attempt working
  // directory. Proving it CANNOT write outside would need an OS-level sandbox, which this provider does not claim.
  assert.equal(result.scratch.isolated, true);
  // A checkpointed SUM resumes from the supplied cursor.
  const resumed = await executeAttempt({envelope: envelope(), reservation: reservation(), controls: controls({operation: 'SUM', values: [1, 2, 3, 4], checkpoint: {cursor: 2, sum: 3}})});
  assert.equal(resumed.output.sum, 10);
});

test('PCF710-02 a missing, inactive, expired or mismatched reservation is refused before anything spawns', async () => {
  await assert.rejects(() => executeAttempt({envelope: envelope(), controls: controls()}), /RESERVATION_REQUIRED/);
  await assert.rejects(() => executeAttempt({envelope: envelope(), reservation: null, controls: controls()}), /RESERVATION_REQUIRED/);
  await assert.rejects(() => executeAttempt({envelope: envelope(), reservation: reservation({state: 'RELEASED'}), controls: controls()}), /RESERVATION_NOT_ACTIVE/);
  await assert.rejects(() => executeAttempt({envelope: envelope(), reservation: reservation({expiresAt: Date.now() - 1}), controls: controls()}), /RESERVATION_EXPIRED/);
  await assert.rejects(() => executeAttempt({envelope: envelope(), reservation: reservation({taskId: 'OTHER'}), controls: controls()}), /RESERVATION_TASK_MISMATCH/);
  await assert.rejects(() => executeAttempt({envelope: envelope(), reservation: reservation({actionId: 'OTHER'}), controls: controls()}), /RESERVATION_TASK_MISMATCH/);
  await assert.rejects(() => executeAttempt({envelope: envelope(), reservation: reservation({deviceId: 'mech'}), controls: controls()}), /RESERVATION_DEVICE_MISMATCH/);
  await assert.rejects(() => executeAttempt({envelope: envelope(), reservation: reservation({bootId: 'old-boot'}), controls: controls()}), /RESERVATION_BOOT_MISMATCH/);
});

test('PCF710-03 an unknown executor, a version mismatch, an unready provider and a missing capability are refused', async () => {
  await assert.rejects(() => executeAttempt({envelope: envelope({executor: {providerRef: 'ghost', providerVersion: 1, providerManifestRef: 'manifest:ghost'}}), reservation: reservation(), controls: controls()}), /EXECUTOR_UNKNOWN/);
  await assert.rejects(() => executeAttempt({envelope: envelope({executor: {providerRef: CPU_PROVIDER_REF, providerVersion: 2, providerManifestRef: 'manifest:x'}}), reservation: reservation(), controls: controls()}), /EXECUTOR_VERSION_MISMATCH/);
  await assert.rejects(() => executeAttempt({envelope: envelope({capabilities: ['cpu.json', 'gpu.cuda']}), reservation: reservation(), controls: controls()}), /EXECUTOR_CAPABILITY_UNAVAILABLE:gpu\.cuda/);
  await assert.rejects(() => executeAttempt({envelope: envelope({inputSchema: 'xml'}), reservation: reservation(), controls: controls()}), /EXECUTOR_SCHEMA_UNAVAILABLE:xml/);
  const unready = normalizeExecutionProvider({...CPU_PROVIDER_MANIFEST, ready: false});
  await assert.rejects(() => executeAttempt({envelope: envelope(), reservation: reservation(), controls: controls({providers: [unready]})}), /EXECUTOR_NOT_READY/);
  // ...and the isolation requirement the provider cannot meet is refused here too, not silently downgraded.
  await assert.rejects(() => executeAttempt({envelope: envelope(), reservation: reservation(), controls: controls({requireHardIsolation: true})}), /HARD_ISOLATION_UNAVAILABLE/);
});

test('PCF710-04 illegal arguments, an extra command and an out-of-bounds file path are refused by name', async () => {
  await assert.rejects(() => executeAttempt({envelope: envelope(), reservation: reservation(), controls: controls({operation: 'SHELL'})}), /EXECUTOR_ARGUMENT_NOT_ALLOWED/);
  await assert.rejects(() => executeAttempt({envelope: envelope(), reservation: reservation(), controls: controls({operation: 'EVAL'})}), /EXECUTOR_ARGUMENT_NOT_ALLOWED/);
  // The worker has no file input surface at all, so a path is an unknown argument rather than a file to read.
  await assert.rejects(() => executeAttempt({envelope: envelope(), reservation: reservation(), controls: controls({inputPath: 'C:/Windows/System32/config/SAM'})}), /EXECUTOR_ARGUMENT_UNKNOWN:inputPath/);
  await assert.rejects(() => executeAttempt({envelope: envelope(), reservation: reservation(), controls: controls({command: 'rm -rf /'})}), /EXECUTOR_ARGUMENT_UNKNOWN:command/);
  await assert.rejects(() => executeAttempt({envelope: envelope(), reservation: reservation(), controls: controls({args: ['--shell']})}), /EXECUTOR_ARGUMENT_UNKNOWN:args/);
  // The low-level entry refuses anything outside the fixed worker's input contract as well.
  await assert.rejects(() => executeCpu({operation: 'SHELL', values: []}), /CPU_INPUT/);
  await assert.rejects(() => executeCpu({operation: 'SORT', values: ['not-a-number']}), /CPU_INPUT/);
});

test('PCF710-05 consent is re-checked at the executor, and an expiry that passed is a refusal', async () => {
  const required = envelope({consent: {required: true, scopeRef: 'consent:one'}});
  await assert.rejects(() => executeAttempt({envelope: required, reservation: reservation(), controls: controls()}), /CONSENT_REQUIRED/);
  await assert.rejects(() => executeAttempt({envelope: required, reservation: reservation(), controls: controls({consent: {scopeRef: 'consent:one', expiresAt: Date.now() - 1}})}), /CONSENT_EXPIRED/);
  await assert.rejects(() => executeAttempt({envelope: required, reservation: reservation(), controls: controls({consent: {scopeRef: 'consent:other', expiresAt: Date.now() + 60000}})}), /CONSENT_EXPIRED/);
  const granted = await executeAttempt({envelope: required, reservation: reservation(), controls: controls({consent: {scopeRef: 'consent:one', expiresAt: Date.now() + 60000}})});
  assert.equal(granted.outcome, 'SUCCEEDED');
});

test('PCF710-06 an unbounded log, a timeout and a non-zero exit all fail rather than half-succeed', async () => {
  // Output bound: the child is stopped as soon as it exceeds the limit, and no truncated payload is published.
  const tooMuch = await executeAttempt({envelope: envelope(), reservation: reservation(), controls: controls({values: Array.from({length: 500}, (_, index) => 500 - index), maxOutputBytes: 64})});
  assert.equal(tooMuch.outcome, 'FAILED');
  assert.equal(tooMuch.reason, 'OUTPUT_LIMIT');
  assert.equal(tooMuch.published, false);
  assert.equal(tooMuch.output, null);
  assert.equal(tooMuch.outputDigest, null);
  // Timeout: a real CPU job that cannot finish in 1 ms is stopped, and the child is really gone afterwards.
  const timedOut = await executeAttempt({envelope: envelope(), reservation: reservation(), controls: controls({operation: 'SUM', values: Array.from({length: 100000}, (_, index) => index), deadlineMs: 1})});
  assert.equal(timedOut.outcome, 'FAILED');
  assert.equal(timedOut.reason, 'TIMEOUT');
  assert.equal(timedOut.published, false);
  assert.equal(await childGone(timedOut.pid), true, 'the timed-out child must not still be running');
  // A non-zero exit is never a success: the worker's own overflow check makes the process fail.
  const wrongExit = await executeAttempt({envelope: envelope(), reservation: reservation(), controls: controls({operation: 'SUM', values: [1e308, 1e308]})});
  assert.equal(wrongExit.outcome, 'FAILED');
  assert.equal(wrongExit.reason, 'PROCESS_EXIT');
  assert.notEqual(wrongExit.exitCode, 0);
  assert.equal(wrongExit.published, false);
  assert.equal(wrongExit.output, null);
  // A deadline that has already passed is refused before spawning anything.
  const expired = envelope({deadlineAt: Date.now() - 1000, missPolicy: 'REFUSE'});
  await assert.rejects(() => executeAttempt({envelope: expired, reservation: reservation(), controls: controls()}), /EXECUTOR_DEADLINE_EXHAUSTED/);
});

test('PCF710-07 the cancellation race has one honest outcome and never publishes output after cancellation', async () => {
  const raced = [];
  for (let round = 0; round < 3; round++) {
    const controller = new AbortController();
    const result = await executeAttempt({envelope: envelope(), reservation: reservation(), controls: controls({operation: 'SUM', values: Array.from({length: 100000}, (_, index) => index), signal: controller.signal, onStart: () => controller.abort()})});
    if (result.outcome === 'CANCELLED') {
      assert.equal(result.output, null, 'a cancelled attempt cannot publish output');
      assert.equal(result.published, false);
    } else {
      assert.equal(result.outcome, 'SUCCEEDED');
      assert.equal(result.published, true);
      assert.equal(result.outputDigest.length, 64);
    }
    assert.ok(['CANCELLED', 'SUCCEEDED'].includes(result.outcome), 'a race settles as one of the two honest outcomes');
    raced.push(result.outcome);
    if (result.pid) assert.equal(await childGone(result.pid), true, 'a cancelled child does not outlive the attempt');
  }
  assert.ok(raced.length === 3);
  // Already aborted before the call: nothing is spawned at all.
  const preAborted = new AbortController();
  preAborted.abort();
  const never = await executeAttempt({envelope: envelope(), reservation: reservation(), controls: controls({signal: preAborted.signal})});
  assert.equal(never.outcome, 'CANCELLED');
  assert.equal(never.pid, null, 'no process was created for an attempt cancelled before it started');
  assert.equal(never.published, false);
});

test('PCF710-08 the worker is owned before it can run, and a failed ownership record stops it', async () => {
  let recorded = null;
  const owned = await executeAttempt({envelope: envelope(), reservation: reservation(), controls: controls({operation: 'SUM', values: [3, 5], onStart: identity => { recorded = identity; }})});
  assert.equal(owned.outcome, 'SUCCEEDED');
  assert.equal(owned.output.sum, 8);
  assert.equal(recorded.pid, owned.pid);
  assert.equal(typeof recorded.host, 'string');
  assert.ok(recorded.startedAt <= Date.now());
  // If ownership cannot be persisted the child is stopped before it ever receives input, and nothing is published.
  const refused = await executeAttempt({envelope: envelope(), reservation: reservation(), controls: controls({operation: 'SUM', values: [3, 5], onStart: () => { throw Object.assign(new Error('DISK_REFUSED'), {code: 'DISK_REFUSED'}); }})});
  assert.equal(refused.outcome, 'FAILED');
  assert.equal(refused.reason, 'OWNERSHIP_PERSIST_FAILED');
  assert.equal(refused.published, false);
  assert.equal(refused.output, null);
});
