/**
 * Donor covering suite, copied verbatim from DS-Hns
 * `tests/unit/engineering-process-identity.test.js` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b.
 *
 * Only the require specifiers were rewritten to ESM imports; the bodies, titles
 * and assertions are the donor's, unchanged.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createProcessOwner, probeProcessOwner } from '../../process-identity.mjs'

test('an owner contains a stable process identity in addition to its PID', () => {
  const owner = createProcessOwner({ instanceId: 'runtime-a', pid: 123, processIdentity: 'start-a' })
  assert.deepEqual(owner, { instanceId: 'runtime-a', pid: 123, processIdentity: 'start-a' })
})

test('a matching process-creation identity proves the owner is live', () => {
  const owner = { instanceId: 'runtime-a', pid: 123, processIdentity: 'win-filetime:1000' }
  assert.equal(probeProcessOwner(owner, { getProcessIdentity: () => ({ known: true, exists: true, identity: 'win-filetime:1000' }) }), true)
})

test('a reused PID with a different process identity is stale, but an unknown probe stays unknown', () => {
  const owner = { instanceId: 'runtime-old', pid: 123, processIdentity: 'win-filetime:1000' }
  assert.equal(probeProcessOwner(owner, { getProcessIdentity: () => ({ known: true, exists: true, identity: 'win-filetime:2000' }) }), false)
  assert.equal(probeProcessOwner(owner, { getProcessIdentity: () => ({ known: false, exists: false, identity: null }) }), null)
  assert.equal(probeProcessOwner(owner, { getProcessIdentity: () => ({ known: true, exists: false, identity: null }) }), false)
})

test('an unverified runtime-start fallback never becomes a false stale proof when an OS probe later succeeds', () => {
  const owner = { instanceId: 'runtime-a', pid: 123, processIdentity: 'runtime-start:123:1000:opaque' }
  assert.equal(probeProcessOwner(owner, { getProcessIdentity: () => ({ known: true, exists: true, identity: 'win-filetime:2000' }) }), null)
})
