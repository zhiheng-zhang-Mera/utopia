/**
 * UTOPIA · Engineering — checkpoint gate suite.
 *
 * The unbound-port answer, the fail-closed authorization rule, the throw path and the
 * bounded timeout restate the donor `src/plugin/checkpoint-gate.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd, with `CheckpointOutcome` and
 * `CheckpointPort` from `src/shared/types.ts` at the same commit.
 *
 * The timeout path is exercised with a real short timeout (10 ms) rather than a fake
 * timer: `setTimeout` / `clearTimeout` are the donor's one ambient dependency that this
 * port keeps, and the clock used for `elapsedMs` is injected throughout.
 *
 * The last case proves the shared layer stayed a single source: the outcome shape this
 * gate validates is the sibling `restart-protocol` module's own constructor, by
 * identity, and the port contract it is judged against is that module's port shape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GATE_FAILURE_REASONS,
  NO_CHECKPOINT_PORT,
  UNBOUND_PORT_ID,
  UNBOUND_PORT_REASON,
  CheckpointGate,
  CheckpointTimeoutError,
  checkpointFailure,
  checkpointGate,
  checkpointOutcome,
  createFixedClock,
  gateResult,
  isUnboundPort,
  throwDetail,
  timeoutMessage,
  unboundCheckpointPort,
  UnboundCheckpointPort,
} from '../checkpoint-gate.mjs';
import * as gateContracts from '../contracts.mjs';
import * as sharedContracts from '../../restart-protocol/contracts.mjs';

/** An injectable clock, advanced by the test. */
function clockAt(startMs = 1000) {
  const clock = { at: startMs };
  return {
    now: () => clock.at,
    advance(ms) {
      clock.at += ms;
      return clock.at;
    },
  };
}

/** A real, short wait: the timeout path is tested against a genuine timer. */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** A safe, completed checkpoint outcome. */
function outcome(overrides = {}) {
  return {
    safe: true,
    reason: 'ok',
    checkpointId: 'checkpoint-1',
    resumeToken: 'resume-1',
    completed: true,
    detail: 'the harness checkpointed the session',
    ...overrides,
  };
}

/** A port that answers immediately and honours the token it is handed. */
function stubPort(overrides = {}) {
  return {
    id: 'checkpoint-stub',
    calls: [],
    acknowledged: [],
    prepareForRestart(mode) {
      this.calls.push(mode);
      return outcome();
    },
    acknowledgeResume(resumeToken) {
      this.acknowledged.push(resumeToken);
      return true;
    },
    ...overrides,
  };
}

test('the unbound port cannot verify anything, and acknowledges nothing', async () => {
  const port = unboundCheckpointPort();
  assert.equal(port.id, 'checkpoint-unbound');
  assert.equal(port.id, UNBOUND_PORT_ID);
  assert.equal(port.reason, 'no checkpoint port is bound in this profile');
  assert.equal(port.reason, UNBOUND_PORT_REASON);
  assert.equal(UnboundCheckpointPort, unboundCheckpointPort, 'the donor name and the factory are the same port');

  assert.deepEqual(port.prepareForRestart('application'), {
    safe: false,
    reason: 'no_checkpoint_port',
    checkpointId: null,
    resumeToken: null,
    completed: false,
    detail: 'no checkpoint port is bound in this profile',
  });
  assert.equal(port.prepareForRestart('system').reason, NO_CHECKPOINT_PORT);
  assert.equal(port.acknowledgeResume(), false);
  assert.equal(port.acknowledgeResume(null), false);
  assert.equal(port.acknowledgeResume('resume-1'), false);
  assert.equal(Object.isFrozen(port), true);

  const custom = unboundCheckpointPort('the profile disables checkpointing');
  assert.equal(custom.reason, 'the profile disables checkpointing');
  assert.equal(custom.prepareForRestart('application').detail, 'the profile disables checkpointing');
  assert.throws(() => unboundCheckpointPort(''), TypeError);

  // the gate over an unbound port refuses to authorize anything it is asked to require
  const gate = checkpointGate({ port, timeoutMs: 0, now: clockAt().now });
  assert.equal(gate.portId, UNBOUND_PORT_ID);
  const required = await gate.prepare('application', true);
  assert.equal(required.authorized, false);
  assert.equal(required.outcome.safe, false);
  assert.equal(required.outcome.completed, false);
  assert.equal(required.outcome.reason, NO_CHECKPOINT_PORT);
  assert.equal(required.outcome.detail, UNBOUND_PORT_REASON, 'a required outcome keeps the port detail verbatim');
  assert.equal(await gate.acknowledgeResume(null), false);
});

test('available is false exactly when the bound port is an unbound one', () => {
  const unbound = unboundCheckpointPort();
  assert.equal(isUnboundPort(unbound), true);
  assert.equal(checkpointGate({ port: unbound, timeoutMs: 0, now: createFixedClock() }).available, false);
  assert.equal(checkpointGate({ port: unboundCheckpointPort('nothing bound here'), timeoutMs: 1000, now: createFixedClock() }).available, false);
  assert.deepEqual(UnboundCheckpointPort().prepareForRestart('application'), unbound.prepareForRestart('application'));

  const real = stubPort();
  assert.equal(isUnboundPort(real), false);
  assert.equal(checkpointGate({ port: real, timeoutMs: 1000, now: createFixedClock() }).available, true);
  assert.equal(checkpointGate({ port: stubPort({ id: 'checkpoint-harness' }), timeoutMs: 0, now: createFixedClock() }).available, true);
  assert.equal(CheckpointGate, checkpointGate, 'the donor name and the factory are the same gate');
});

test('a required checkpoint authorizes only when it is safe AND completed', async () => {
  const time = clockAt(1000);
  const port = stubPort();
  const gate = checkpointGate({ port, timeoutMs: 1000, now: time.now });

  const good = await gate.prepare('application', true);
  assert.equal(good.authorized, true);
  assert.equal(good.outcome.safe, true);
  assert.equal(good.outcome.completed, true);
  assert.deepEqual(port.calls, ['application'], 'the requested mode is what the port is asked about');
  assert.equal(Object.isFrozen(good), true);
  assert.equal(Object.isFrozen(good.outcome), true);

  // required, unsafely reported: the detail is kept verbatim and nothing is appended
  const unsafe = await checkpointGate({
    port: stubPort({ prepareForRestart: () => outcome({ safe: false, reason: 'git_commit_in_progress', detail: 'a commit is in progress' }) }),
    timeoutMs: 1000,
    now: time.now,
  }).prepare('system', true);
  assert.equal(unsafe.authorized, false);
  assert.equal(unsafe.outcome.detail, 'a commit is in progress');
  assert.equal(unsafe.outcome.reason, 'git_commit_in_progress');

  // required, safe but not completed
  const unfinished = await checkpointGate({
    port: stubPort({ prepareForRestart: () => outcome({ completed: false, detail: 'the harness did not finish' }) }),
    timeoutMs: 1000,
    now: time.now,
  }).prepare('application', true);
  assert.equal(unfinished.authorized, false);
  assert.equal(unfinished.outcome.safe, true);
  assert.equal(unfinished.outcome.completed, false);
  assert.equal(unfinished.outcome.detail, 'the harness did not finish');

  // required, neither
  const neither = await checkpointGate({
    port: stubPort({ prepareForRestart: () => outcome({ safe: false, completed: false }) }),
    timeoutMs: 1000,
    now: time.now,
  }).prepare('application', true);
  assert.equal(neither.authorized, false);
});

test('a checkpoint that is NOT required always authorizes, and says so when it was not safe', async () => {
  const time = clockAt(1000);

  const unsafe = await checkpointGate({
    port: stubPort({ prepareForRestart: () => outcome({ safe: false, reason: 'git_commit_in_progress', detail: 'a commit is in progress' }) }),
    timeoutMs: 1000,
    now: time.now,
  }).prepare('application', false);
  assert.equal(unsafe.authorized, true, 'the caller did not require a checkpoint, so a refusal is not fatal');
  assert.equal(unsafe.outcome.safe, false);
  assert.equal(unsafe.outcome.reason, 'git_commit_in_progress', 'the port reason is never rewritten');
  assert.equal(unsafe.outcome.checkpointId, 'checkpoint-1', 'the answer is reported as the port gave it');
  assert.equal(unsafe.outcome.resumeToken, 'resume-1');
  assert.equal(unsafe.outcome.detail, 'a commit is in progress (checkpoint not required for this request)');

  const safe = await checkpointGate({ port: stubPort(), timeoutMs: 1000, now: time.now }).prepare('application', false);
  assert.equal(safe.authorized, true);
  assert.equal(safe.outcome.detail, 'the harness checkpointed the session', 'a safe outcome needs no suffix');

  const unbound = await checkpointGate({ port: unboundCheckpointPort(), timeoutMs: 1000, now: time.now }).prepare('application', false);
  assert.equal(unbound.authorized, true);
  assert.equal(unbound.outcome.detail, `${UNBOUND_PORT_REASON} (checkpoint not required for this request)`);
});

test('a throwing port becomes checkpoint_threw and never authorizes', async () => {
  const time = clockAt(1000);
  const throwing = checkpointGate({
    port: stubPort({
      prepareForRestart() {
        throw new Error('harness unavailable');
      },
    }),
    timeoutMs: 1000,
    now: time.now,
  });

  const result = await throwing.prepare('application', true);
  assert.equal(result.authorized, false);
  assert.deepEqual(result.outcome, {
    safe: false,
    reason: 'checkpoint_threw',
    checkpointId: null,
    resumeToken: null,
    completed: false,
    detail: 'prepareForRestart threw: harness unavailable',
  });
  assert.equal(throwDetail(new Error('harness unavailable')), 'prepareForRestart threw: harness unavailable');
  assert.equal(throwDetail('boom'), 'prepareForRestart threw: boom');

  // the same throw with no requirement still records why, and still authorizes
  const optional = await throwing.prepare('system', false);
  assert.equal(optional.authorized, true);
  assert.equal(optional.outcome.reason, 'checkpoint_threw');
  assert.equal(optional.outcome.detail, 'prepareForRestart threw: harness unavailable (checkpoint not required for this request)');

  // a rejected promise is the same failure as a throw
  const rejecting = checkpointGate({
    port: stubPort({ prepareForRestart: () => Promise.reject(new Error('harness refused')) }),
    timeoutMs: 1000,
    now: time.now,
  });
  const rejected = await rejecting.prepare('application', true);
  assert.equal(rejected.authorized, false);
  assert.equal(rejected.outcome.reason, 'checkpoint_threw');
  assert.equal(rejected.outcome.detail, 'prepareForRestart threw: harness refused');

  // a port that throws while acknowledging reports false rather than propagating
  const ackThrows = checkpointGate({
    port: stubPort({
      acknowledgeResume() {
        throw new Error('harness went away');
      },
    }),
    timeoutMs: 1000,
    now: time.now,
  });
  assert.equal(await ackThrows.acknowledgeResume('resume-1'), false);
  assert.equal(await ackThrows.acknowledgeResume(null), false);

  const ackPort = stubPort();
  const ackGate = checkpointGate({ port: ackPort, timeoutMs: 1000, now: time.now });
  assert.equal(await ackGate.acknowledgeResume('resume-7'), true);
  assert.deepEqual(ackPort.acknowledged, ['resume-7'], 'the token is handed through unchanged');
});

test('a slow port is bounded by a real timeout, and authorizes nothing', async () => {
  const time = clockAt(1000);
  const slow = checkpointGate({
    port: stubPort({ prepareForRestart: async () => (await delay(60), outcome({ checkpointId: 'too-late' })) }),
    timeoutMs: 10,
    now: time.now,
  });

  const result = await slow.prepare('application', true);
  assert.equal(result.authorized, false);
  assert.equal(result.outcome.reason, 'checkpoint_threw');
  assert.equal(
    result.outcome.detail,
    `prepareForRestart threw: checkpoint port checkpoint-stub did not answer within 10 ms`,
  );
  assert.match(result.outcome.detail, /did not answer within 10 ms/);
  assert.equal(result.outcome.checkpointId, null, 'a late checkpoint is not carried into the result');
  assert.equal(result.outcome.completed, false);

  const message = timeoutMessage('checkpoint-stub', 10);
  assert.equal(message, 'checkpoint port checkpoint-stub did not answer within 10 ms');
  const error = new CheckpointTimeoutError('checkpoint-stub', 10);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'CheckpointTimeoutError');
  assert.equal(error.message, message);
  assert.equal(error.portId, 'checkpoint-stub');
  assert.equal(error.timeoutMs, 10);

  // acknowledging a port that does not answer is false, not a rejection
  const slowAck = checkpointGate({
    port: stubPort({ acknowledgeResume: async () => (await delay(60), true) }),
    timeoutMs: 10,
    now: time.now,
  });
  assert.equal(await slowAck.acknowledgeResume('resume-1'), false);

  // a port that answers inside the budget is not timed out
  const brisk = checkpointGate({
    port: stubPort({ prepareForRestart: async () => (await delay(1), outcome({ checkpointId: 'in-time' })) }),
    timeoutMs: 2000,
    now: time.now,
  });
  const onTime = await brisk.prepare('application', true);
  assert.equal(onTime.authorized, true);
  assert.equal(onTime.outcome.checkpointId, 'in-time');
});

test('timeoutMs <= 0 means no timeout at all', async () => {
  const time = clockAt(1000);
  for (const timeoutMs of [0, -1]) {
    const gate = checkpointGate({
      port: stubPort({ prepareForRestart: async () => (await delay(30), outcome({ checkpointId: 'eventually' })) }),
      timeoutMs,
      now: time.now,
    });
    const result = await gate.prepare('application', true);
    assert.equal(result.authorized, true, `timeoutMs ${timeoutMs} must not bound the wait`);
    assert.equal(result.outcome.reason, 'ok');
    assert.equal(result.outcome.checkpointId, 'eventually');
    assert.equal(gate.timeoutMs, timeoutMs);

    const ack = checkpointGate({
      port: stubPort({ acknowledgeResume: async () => (await delay(30), true) }),
      timeoutMs,
      now: time.now,
    });
    assert.equal(await ack.acknowledgeResume('resume-1'), true);
  }
});

test('elapsedMs is measured from the injected clock, not from the wall clock', async () => {
  const time = clockAt(1000);
  const port = stubPort({
    prepareForRestart: async () => {
      time.advance(275);
      return outcome();
    },
  });
  const gate = checkpointGate({ port, timeoutMs: 0, now: time.now });

  assert.equal(await gate.acknowledgeResume('resume-1'), true);
  const result = await gate.prepare('application', true);
  assert.equal(result.elapsedMs, 275, 'the two clock reads bracket the port call');
  assert.equal(result.authorized, true);
  assert.equal(result.elapsedMs, time.now() - 1000, 'elapsed is exactly what the injected clock moved');
  assert.equal(time.now(), 1275);

  const still = checkpointGate({ port: stubPort(), timeoutMs: 0, now: createFixedClock(500) });
  assert.equal((await still.prepare('application', true)).elapsedMs, 0);

  assert.throws(() => checkpointGate({}), TypeError, 'a port is required');
  assert.throws(() => checkpointGate({ port: stubPort({ id: '' }), timeoutMs: 0 }), TypeError);
  assert.throws(() => checkpointGate({ port: { id: 'x' }, timeoutMs: 0 }), TypeError);
  assert.throws(() => checkpointGate({ port: stubPort(), timeoutMs: 'soon' }), TypeError);
  assert.throws(() => checkpointGate({ port: stubPort(), timeoutMs: 0, now: 0 }), TypeError);
});

test('the contracts validate and copy every value they hand back', () => {
  const failure = checkpointFailure('checkpoint_threw', 'prepareForRestart threw: boom');
  assert.deepEqual(failure, {
    safe: false,
    reason: 'checkpoint_threw',
    checkpointId: null,
    resumeToken: null,
    completed: false,
    detail: 'prepareForRestart threw: boom',
  });
  assert.equal(Object.isFrozen(failure), true);
  assert.throws(() => checkpointFailure('', 'detail'), TypeError);
  assert.throws(() => checkpointFailure('checkpoint_threw', null), TypeError);

  const copied = checkpointOutcome({ ...outcome(), extra: 'not part of the shape' });
  assert.deepEqual(copied, outcome(), 'exactly the six declared fields survive');
  assert.deepEqual(Object.keys(copied).sort(), ['checkpointId', 'completed', 'detail', 'reason', 'resumeToken', 'safe']);
  assert.equal(Object.isFrozen(copied), true);

  // The donor declares all six fields as required and no donor path omits one, so the
  // constructor refuses an incomplete outcome rather than repairing it: an absent
  // checkpointId is a missing required field, not a null one.
  assert.throws(() => checkpointOutcome({ ...outcome(), checkpointId: undefined }), TypeError);
  assert.throws(() => checkpointOutcome({ ...outcome(), detail: '' }), TypeError);
  assert.throws(() => checkpointOutcome({ ...outcome(), safe: 'yes' }), TypeError);
  assert.throws(() => checkpointOutcome({ ...outcome(), completed: null }), TypeError);
  assert.throws(() => checkpointOutcome({ ...outcome(), checkpointId: 7 }), TypeError);
  assert.throws(() => checkpointOutcome(null), TypeError);

  // ...and it is still usable, not merely strict: the unbound port's own literal is a
  // complete outcome, so it constructs, comes back frozen and keeps every member.
  const unboundAnswer = unboundCheckpointPort().prepareForRestart('application');
  const constructed = checkpointOutcome(unboundAnswer);
  assert.deepEqual(constructed, unboundAnswer);
  assert.deepEqual(Object.keys(constructed).sort(), ['checkpointId', 'completed', 'detail', 'reason', 'resumeToken', 'safe']);
  assert.equal(constructed.reason, 'no_checkpoint_port');
  assert.equal(constructed.checkpointId, null);
  assert.equal(constructed.resumeToken, null);
  assert.equal(constructed.detail, 'no checkpoint port is bound in this profile');
  assert.equal(constructed.completed, false);
  assert.equal(Object.isFrozen(constructed), true);
  assert.equal(Object.isFrozen(checkpointOutcome(outcome())), true, 'a complete safe answer constructs too');

  const result = gateResult({ outcome: outcome(), elapsedMs: 12, authorized: true });
  assert.equal(result.elapsedMs, 12);
  assert.equal(result.authorized, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.outcome), true);
  assert.throws(() => gateResult({ outcome: outcome(), elapsedMs: Number.NaN, authorized: true }), TypeError);
  assert.throws(() => gateResult({ outcome: outcome(), elapsedMs: 0, authorized: 'yes' }), TypeError);
  assert.deepEqual(GATE_FAILURE_REASONS, ['checkpoint_threw', 'checkpoint_timeout']);
});

test('the module is self-contained: timers are the only ambient dependency', async () => {
  const moduleDir = join(import.meta.dirname, '..');
  for (const file of ['contracts.mjs', 'checkpoint-gate.mjs', 'index.mjs']) {
    const code = (await readFile(join(moduleDir, file), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ["from 'node:", "require('", "from 'app/", 'writeFileSync', 'process.env', 'Math.random']) {
      assert.ok(!code.includes(forbidden), `${file} must not carry a runtime dependency (${forbidden})`);
    }
    assert.ok(!/Date\.now/.test(code), `${file} must never read the ambient clock`);
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('.'), `${file} imports ${specifier}`);
    }
  }

  // the one ambient dependency is the real timer, and it is used in both directions
  const gate = await readFile(join(moduleDir, 'checkpoint-gate.mjs'), 'utf8');
  assert.match(gate, /setTimeout\(/);
  assert.match(gate, /clearTimeout\(/);
  assert.match(gate, /\.unref\?\.\(\)/, 'the timer is unref\u2019d when the runtime supports it');
});

test('the outcome shape has one declaration: this gate imports it from the shared layer', async () => {
  // Identity, not equality: the gate must validate answers with the shared layer's own
  // constructor, so a drift between the two is impossible rather than unlikely.
  assert.equal(checkpointOutcome, sharedContracts.checkpointOutcome);
  assert.equal(gateContracts.checkpointOutcome, sharedContracts.checkpointOutcome);
  assert.equal(typeof sharedContracts.checkpointPort, 'function', 'the shared layer also carries the CheckpointPort contract');

  // the members the gate depends on are exactly the donor's six, from that one source
  const shared = sharedContracts.checkpointOutcome(outcome());
  assert.deepEqual(Object.keys(shared).sort(), ['checkpointId', 'completed', 'detail', 'reason', 'resumeToken', 'safe']);
  assert.deepEqual(shared, outcome());

  // the unbound port is a valid CheckpointPort under the shared seam: id plus both seams
  const port = unboundCheckpointPort();
  const seam = sharedContracts.checkpointPort(port);
  assert.equal(seam.id, UNBOUND_PORT_ID);
  assert.equal(seam.prepareForRestart, port.prepareForRestart);
  assert.equal(seam.acknowledgeResume, port.acknowledgeResume);
  assert.equal(isUnboundPort(seam), true, 'a copy of the unbound port is still the unbound port');

  // a re-declared copy would pass deepEqual but fail this: the module must not
  // construct its own outcome shape anywhere in its source
  const moduleDir = join(import.meta.dirname, '..');
  const code = (await readFile(join(moduleDir, 'contracts.mjs'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  assert.ok(!/export function checkpointOutcome/.test(code), 'checkpointOutcome must not be declared here');
  assert.match(code, /from '\.\.\/restart-protocol\/contracts\.mjs'/, 'the outcome shape comes from the sibling shared layer');
});
