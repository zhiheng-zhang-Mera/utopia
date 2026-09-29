/**
 * Donor covering suite, extracted verbatim from DS-Hns
 * `tests/unit/engineering-wiring.test.js` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b.
 *
 * The donor file is a wiring suite that pulls in the whole public entry point
 * (`app/engineering/index.cjs`), which is another agent's module and outside this
 * migration's scope. Its `a workspace is locked while an episode runs, and never
 * stolen from a live owner` case is the donor's only coverage for
 * `app/engineering/locking.cjs`, so that single case was lifted out unchanged:
 * the body, title and every assertion are the donor's, and the only edit is the
 * import specifier plus the donor's one-line `require` moved to a static import.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWorkspaceLock } from '../../locking.mjs';

test('a workspace is locked while an episode runs, and never stolen from a live owner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-lock-'))
  try {
    const first = createWorkspaceLock({ root: dir })
    const taken = first.acquire({ episode: 'episode-a' })
    assert.equal(taken.ok, true)
    assert.equal(fs.existsSync(first.file), true, 'the lock must be on disk, because the excluded writer is another process')

    // A second writer in the same workspace is refused, and told who holds it.
    const second = createWorkspaceLock({ root: dir })
    const blocked = second.acquire({ episode: 'episode-b' })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'held')
    assert.equal(blocked.lock.episode, 'episode-a')

    // A live owner's lock is never stolen, however old it is.
    const aged = second.acquire({ episode: 'episode-b', stealStale: true })
    assert.equal(aged.ok, false, 'a lock whose owner is alive must not be reclaimed')

    // Release is verified: only the holder may remove it.
    assert.equal(second.release().ok, false, 'a non-holder must not delete the lock')
    assert.equal(first.heartbeat().ok, true, 'the holder can refresh its own lock')
    assert.equal(first.release().ok, true)
    assert.equal(fs.existsSync(first.file), false, 'the lock is gone once released')

    // A lock whose owner is gone is *reported* as stale, and only reclaimed when
    // the caller says so.
    fs.mkdirSync(path.dirname(first.file), { recursive: true })
    fs.writeFileSync(first.file, JSON.stringify({ version: 1, episode: 'dead', pid: 999999999, token: 'x', at: Date.now() - 10 * 60_000 }), 'utf8')
    const third = createWorkspaceLock({ root: dir })
    const stale = third.acquire({ episode: 'episode-c' })
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'stale')
    assert.match(stale.reason, /pass stealStale/)
    const reclaimed = third.acquire({ episode: 'episode-c', stealStale: true })
    assert.equal(reclaimed.ok, true)
    assert.equal(reclaimed.lock.episode, 'episode-c')
    third.release()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
