/**
 * Finalizer acceptance-basis tests.
 *
 * The closeout engineering book requires the finalizer's two acceptance modes to be pinned by
 * tests, because `owner-override` is the one path that can emit a verified episode without the
 * migration host's own `MIGRATION_COMPLETE`. These tests drive the real script end to end
 * against a throwaway scratch repo, so they exercise the actual CLI contract rather than a
 * re-implementation of it.
 *
 * Cases required by the book (§2.2):
 *   - old host-pass happy path;
 *   - owner-override happy path;
 *   - no migration blocker -> FAIL;
 *   - no Owner ruling -> FAIL;
 *   - ruling/intervention mismatch -> FAIL;
 *   - no verifier finding -> FAIL;
 *   - final CI not PASS -> FAIL;
 *   - same host -> FAIL.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const FINALIZER = fileURLToPath(new URL('../scripts/finalize-mission-episode.mjs', import.meta.url));
const RULING = 'Digital-City/mission-book/response-9-29.md#R6';

/** One event, with the fields the finalizer validates. */
const event = (over) => ({
  schemaVersion: 1,
  eventId: `MB-900:${String(over.seq).padStart(16, '0')}`,
  missionId: 'MB-900',
  role: 'VERIFICATION',
  hostId: 'Mech',
  eventType: 'ATTEMPT_STARTED',
  timestamp: '2026-09-30T00:00:00.000Z',
  outcome: 'INFO',
  summary: 'synthetic event for the finalizer acceptance tests',
  evidence: [],
  ...(({ seq, ...rest }) => rest)(over),
});

/** A host-pass inbox: exactly what the original contract expects. */
const hostPassEvents = () => [
  event({ seq: 1, role: 'MIGRATION', hostId: 'Alien', eventType: 'MISSION_CLAIMED' }),
  event({ seq: 2, role: 'MIGRATION', hostId: 'Alien', eventType: 'MIGRATION_COMPLETE', outcome: 'PASS' }),
  event({ seq: 3, eventType: 'VERIFIER_FINDING', outcome: 'BLOCKED' }),
  event({ seq: 4, eventType: 'CI_RESULT', outcome: 'PASS' }),
  event({ seq: 5, eventType: 'VERIFICATION_COMPLETE', outcome: 'PASS' }),
];

/** An owner-override inbox: a real migration blocker, an Owner intervention citing the ruling. */
const ownerOverrideEvents = () => [
  event({ seq: 1, role: 'MIGRATION', hostId: 'Alien', eventType: 'MISSION_CLAIMED' }),
  event({ seq: 2, role: 'MIGRATION', hostId: 'Alien', eventType: 'RUNTIME_FAIL', outcome: 'BLOCKED' }),
  event({ seq: 3, eventType: 'OWNER_INTERVENTION', outcome: 'INFO', evidence: [RULING] }),
  event({ seq: 4, eventType: 'VERIFIER_FINDING', outcome: 'BLOCKED' }),
  event({ seq: 5, eventType: 'CI_RESULT', outcome: 'PASS' }),
  event({ seq: 6, eventType: 'VERIFICATION_COMPLETE', outcome: 'PASS' }),
];

/** Build a scratch repo containing just the inbox the finalizer reads, and run it there. */
async function finalize(events, extraArgs = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mb-finalize-'));
  try {
    const inboxDir = path.join(dir, 'data-records', 'evolution', 'inbox', 'mission-book', 'MB-900');
    await mkdir(inboxDir, { recursive: true });
    await writeFile(path.join(inboxDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const args = [
      FINALIZER,
      '--mission', 'MB-900',
      '--migration-host', 'Alien',
      '--verification-host', 'Mech',
      '--branch-sha', 'abcdef1234567890',
      '--ci-run', '12345',
      ...extraArgs,
    ];
    try {
      const { stdout } = await run(process.execPath, args, { cwd: dir });
      const episodePath = path.join(dir, 'data-records', 'evolution', 'episodes', 'mission-book', 'MB-900', 'episode.json');
      const episode = JSON.parse(await readFile(episodePath, 'utf8'));
      const inboxExists = await readFile(path.join(inboxDir, 'events.jsonl'), 'utf8').then(() => true, () => false);
      return { ok: true, episode, inboxExists, stdout };
    } catch (error) {
      return { ok: false, stderr: String(error.stderr ?? error.message), code: error.code };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('host-pass: the original contract still works and is labelled HOST_PASS', async () => {
  const result = await finalize(hostPassEvents());
  assert.equal(result.ok, true, result.stderr);
  assert.deepEqual(result.episode.migrationAcceptance, { mode: 'HOST_PASS' });
  assert.equal(result.episode.status, 'VERIFIED');
  assert.equal(result.inboxExists, false, 'the inbox is consumed');
});

test('owner-override: an Owner ruling over a real blocker produces a VERIFIED episode', async () => {
  const result = await finalize(ownerOverrideEvents(), ['--migration-acceptance', 'owner-override', '--owner-ruling', RULING]);
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.episode.migrationAcceptance.mode, 'OWNER_OVERRIDE');
  assert.equal(result.episode.migrationAcceptance.ownerRuling, RULING);
  assert.match(String(result.episode.migrationAcceptance.migrationBlockerEventId), /^MB-900:/);
  assert.match(String(result.episode.migrationAcceptance.ownerInterventionEventId), /^MB-900:/);
  // The original blocker must survive in the timeline: no fabricated history.
  assert.ok(
    result.episode.timeline.some((e) => e.eventType === 'RUNTIME_FAIL' && e.outcome === 'BLOCKED'),
    'the migration blocker stays in the timeline',
  );
  assert.equal(
    result.episode.timeline.some((e) => e.eventType === 'MIGRATION_COMPLETE'),
    false,
    'no MIGRATION_COMPLETE is invented',
  );
});

test('owner-override without a migration blocker fails', async () => {
  const events = ownerOverrideEvents().filter((e) => e.eventType !== 'RUNTIME_FAIL');
  const result = await finalize(events, ['--migration-acceptance', 'owner-override', '--owner-ruling', RULING]);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /real BLOCKED\/FAIL migration event/);
});

test('owner-override without an owner ruling argument fails', async () => {
  const result = await finalize(ownerOverrideEvents(), ['--migration-acceptance', 'owner-override']);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /requires --owner-ruling/);
});

test('owner-override whose intervention does not cite the ruling fails', async () => {
  const events = ownerOverrideEvents().map((e) => (
    e.eventType === 'OWNER_INTERVENTION'
      ? { ...e, evidence: ['Digital-City/mission-book/response-9-29.md#R99'] }
      : e
  ));
  const result = await finalize(events, ['--migration-acceptance', 'owner-override', '--owner-ruling', RULING]);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /does not reference the owner ruling/);
});

test('owner-override without a verifier finding fails', async () => {
  const events = ownerOverrideEvents().filter((e) => e.eventType !== 'VERIFIER_FINDING');
  const result = await finalize(events, ['--migration-acceptance', 'owner-override', '--owner-ruling', RULING]);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /VERIFIER_FINDING/);
});

test('owner-override whose verifier finding precedes the blocker fails', async () => {
  const events = ownerOverrideEvents();
  const finding = events.find((e) => e.eventType === 'VERIFIER_FINDING');
  const rest = events.filter((e) => e.eventType !== 'VERIFIER_FINDING');
  // Put the finding first, before the recorded blocker.
  const result = await finalize([finding, ...rest], ['--migration-acceptance', 'owner-override', '--owner-ruling', RULING]);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /after the recorded migration blocker/);
});

test('a final CI that is not PASS fails in owner-override too', async () => {
  const events = ownerOverrideEvents().map((e) => (e.eventType === 'CI_RESULT' ? { ...e, outcome: 'FAIL' } : e));
  const result = await finalize(events, ['--migration-acceptance', 'owner-override', '--owner-ruling', RULING]);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /CI_RESULT is not PASS/);
});

test('the same host for both roles fails', async () => {
  const result = await finalize(ownerOverrideEvents(), ['--migration-acceptance', 'owner-override', '--owner-ruling', RULING]);
  assert.equal(result.ok, true, 'sanity: the baseline passes');
  const dir = await mkdtemp(path.join(tmpdir(), 'mb-finalize-'));
  try {
    const inboxDir = path.join(dir, 'data-records', 'evolution', 'inbox', 'mission-book', 'MB-900');
    await mkdir(inboxDir, { recursive: true });
    await writeFile(path.join(inboxDir, 'events.jsonl'), ownerOverrideEvents().map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    await assert.rejects(
      run(process.execPath, [
        FINALIZER, '--mission', 'MB-900', '--migration-host', 'Mech', '--verification-host', 'Mech',
        '--branch-sha', 'abcdef1234567890', '--ci-run', '12345',
        '--migration-acceptance', 'owner-override', '--owner-ruling', RULING,
      ], { cwd: dir }),
      (error) => /must differ/.test(String(error.stderr)),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an inbox that already has a host PASS cannot use owner-override', async () => {
  const result = await finalize(hostPassEvents(), ['--migration-acceptance', 'owner-override', '--owner-ruling', RULING]);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /already contains a host PASS/);
});

test('--owner-ruling is rejected in host-pass mode', async () => {
  const result = await finalize(hostPassEvents(), ['--owner-ruling', RULING]);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /only valid with --migration-acceptance owner-override/);
});
