// CEX-704 · OPPOSITE-HOST REVIEW probes (Mech) — backend pairing-authority half.
//
// The workbook's Formal Review section requires an on-device matrix (generate, share, second-device consume, incoming
// approve, reject, expiry, double click, app background/resume, existing join paths regression). This file attacks the
// half that can be decided without a handset and that decides what the handset is allowed to do: the guarded
// POST /api/v0/pairing/session route added by this commit, and the JOIN-501 invariants it must not break (a session
// created only on an explicit user action, fixed while ACTIVE, and never rotated in the background).
// Verdict and findings: mission-book/reports/CEX-704/REVIEW_REPORT.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';

const H = { 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', Authorization: 'Bearer owner' };

async function city(fn, options = {}) {
  const dir = await mkdtemp(resolve('.scratch-cex704-review-'));
  let app, clock = Date.now();
  try {
    app = await createGateway({ dir, port: 0, token: 'owner', nodeToken: 'node', pairingClock: () => clock, pairingTtlMs: 5000, roomsDisabled: true, ...options });
    const req = async (path, body, auth = 'owner') => { const r = await fetch(app.url + '/api/v0/' + path, { method: body === undefined ? 'GET' : 'POST', headers: auth === null ? { 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' } : { ...H, Authorization: 'Bearer ' + auth }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    await fn({ app, req, tick: ms => { clock += ms; }, state: () => app.join ? null : null, info: async () => (await req('pairing/info', undefined, null)).body });
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
}

test('PROBE 1: the guard refuses an unknown expected state and an unauthenticated generate', () => city(async ({ req, info }) => {
  assert.equal((await req('pairing/session', { expectedSessionState: 'IDLE' }, null)).status, 401, 'generating pairing material requires the owner credential');
  for (const bogus of ['ACTIVE', 'idle', 'DRAINING', '', 'USED ']) {
    const attempt = await req('pairing/session', { expectedSessionState: bogus });
    assert.equal(attempt.status, 400, `${JSON.stringify(bogus)} must be refused as an unknown state`);
    assert.equal(attempt.body.errorCode ?? attempt.body.error, 'PAIRING_STATE_INVALID');
  }
  // Nothing was created by any of those refusals. (The descriptor reports "no session" as null, not undefined - an
  // earlier draft asserted undefined and failed on its own assumption rather than on a product defect.)
  assert.ok((await info()).descriptor.pairingSessionId == null, 'a refused generate must not have created a session');
}));

test('PROBE 2: a live session is FIXED - the guarded path cannot rotate it, and says why', () => city(async ({ req, info }) => {
  const first = await req('pairing/session', { expectedSessionState: 'IDLE' });
  assert.equal(first.status, 200);
  const id = first.body.pairingSessionId;
  assert.ok(typeof id === 'string' && id.length > 0);
  // Every terminal expectation a client could hold while a session is live is refused with the SAME typed reason,
  // so a stale client cannot rotate by guessing a different state.
  for (const stale of ['IDLE', 'USED', 'EXPIRED', 'LOCKED']) {
    const attempt = await req('pairing/session', { expectedSessionState: stale });
    assert.equal(attempt.status, 409, `expecting ${stale} while ACTIVE must be refused`);
    assert.equal(attempt.body.errorCode ?? attempt.body.error, 'PAIRING_STATE_CHANGED');
  }
  assert.equal((await info()).descriptor.pairingSessionId, id, 'the ACTIVE session must not have been rotated by any of those attempts');
}));

test('PROBE 3: generation is possible exactly from a terminal state, and each generation is a NEW session', () => city(async ({ req, tick, info }) => {
  const first = (await req('pairing/session', { expectedSessionState: 'IDLE' })).body;
  // Expiry is the clock's business: while it has not passed, IDLE is not the current state.
  tick(5001);
  assert.equal((await info()).sessionState, 'EXPIRED');
  assert.equal((await req('pairing/session', { expectedSessionState: 'IDLE' })).status, 409, 'a stale IDLE expectation must not generate');
  const second = await req('pairing/session', { expectedSessionState: 'EXPIRED' });
  assert.equal(second.status, 200);
  assert.notEqual(second.body.pairingSessionId, first.pairingSessionId, 'a new user action must mint a new session, not replay the old one');
  // Consume it, then confirm regeneration is allowed from USED - the workbook's "consumed/expired then generate again".
  const consumed = await req('pairing/exchange', { cityId: second.body.descriptor.cityId, sessionId: second.body.pairingSessionId, method: 'mdns', shortCode: second.body.shortCode }, null);
  assert.equal(consumed.status, 200);
  assert.equal((await info()).sessionState, 'USED');
  assert.equal((await req('pairing/session', { expectedSessionState: 'IDLE' })).status, 409);
  const third = await req('pairing/session', { expectedSessionState: 'USED' });
  assert.equal(third.status, 200, 'after a consume the user may generate again');
  assert.notEqual(third.body.pairingSessionId, second.body.pairingSessionId);
}));

test('PROBE 4: the guard is optional, so existing clients keep working unchanged', () => city(async ({ req, info }) => {
  // The reviewed commit adds a guard; it must not become a new mandatory field that breaks a client that never sends it.
  const legacy = await req('pairing/session', {});
  assert.equal(legacy.status, 200, 'a request without expectedSessionState must still generate');
  assert.ok(legacy.body.pairingSessionId);
  // And it is the unguarded path that can still rotate, which is exactly why the guard exists: recorded, not judged.
  const again = await req('pairing/session', {});
  assert.equal(again.status, 200);
  assert.notEqual(again.body.pairingSessionId, legacy.body.pairingSessionId, 'the legacy path still rotates a live session; the guard is what prevents it');
  assert.equal((await info()).descriptor.pairingSessionId, again.body.pairingSessionId);
}));

test('PROBE 5: a burst of simultaneous guarded generations cannot create two sessions', () => city(async ({ req, info }) => {
  // The workbook names "double click" among the scenarios, and the guard is a read-then-act sequence across an await.
  // This is the race the guard has to survive, and the invariant is the same one JOIN-501 established: an ACTIVE
  // session is fixed, so at most one of a simultaneous burst may win.
  const burst = await Promise.all(Array.from({ length: 8 }, () => req('pairing/session', { expectedSessionState: 'IDLE' })));
  const accepted = burst.filter(r => r.status === 200);
  assert.equal(accepted.length, 1, `exactly one simultaneous generation may succeed, saw ${accepted.length}`);
  assert.equal(burst.filter(r => r.status === 409).length, 7, 'every loser must be told the state changed');
  const live = await info();
  assert.equal(live.descriptor.pairingSessionId, accepted[0].body.pairingSessionId, 'the session that survived the burst must be the one that was accepted');
  assert.equal(live.sessionState, 'ACTIVE');
}));
