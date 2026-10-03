// JOIN-501 — pairing session lifecycle (unit level).
//
// The Owner rule this file pins down:
//
//   NO CLICK = NO CODE
//   IDLE --generate--> ACTIVE --consumed--> CONSUMED --generate--> ACTIVE (new)
//                        \--expires-----> EXPIRED  --generate--> ACTIVE (new)
//
// and, at every step, the ONLY operation that can produce pairing material is `create()` - which is only ever
// called from the click handler. The tests below therefore assert two different kinds of thing:
//   1. the transition table itself (including that an ACTIVE session cannot be rotated), and
//   2. that the read-only paths (snapshot / restore / expireIfDue / persist) never produce material.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairingLifecycle, STORAGE_KEY, REASON_EXPIRED, REASON_USED, REASON_REVOKED } from '../apps/web/pairing-lifecycle.js';

// A stand-in for sessionStorage: same shape, plus counters so a test can prove what was and was not written.
function fakeStorage(initial = null) {
  const map = new Map(initial ? [[STORAGE_KEY, initial]] : []);
  const writes = { set: 0, remove: 0 };
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { writes.set++; map.set(k, String(v)); },
    removeItem: k => { writes.remove++; map.delete(k); },
    raw: () => (map.has(STORAGE_KEY) ? map.get(STORAGE_KEY) : null),
    writes,
  };
}

// A clock the test drives, so expiry is deterministic rather than timing-dependent.
function clock(start = Date.parse('2026-10-03T10:00:00.000Z')) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; }, at: () => new Date(t).toISOString() };
}

// Exactly the shape the City's POST /api/v0/pairing/session returns.
function sessionResult(c, { id = 'sess-1', code = '123456', ttlMs = 300000, secret = 'sec-1' } = {}) {
  return {
    descriptor: { pairingSessionId: id, expiresAt: new Date(c.now() + ttlMs).toISOString() },
    pairingSessionId: id,
    shortCode: code,
    createdAt: c.at(),
    expiresAt: new Date(c.now() + ttlMs).toISOString(),
    qrPayload: `utopia://pair?v=1&host=http%3A%2F%2F127.0.0.1%3A4310&city=city-1&session=${id}&expires=${encodeURIComponent(new Date(c.now() + ttlMs).toISOString())}&secret=${secret}`,
    qrSvg: '<svg></svg>',
  };
}

test('IDLE: no session exists until create() is called, and a read never changes that', () => {
  const c = clock(), store = fakeStorage();
  const life = createPairingLifecycle({ storage: store, now: c.now });
  const idle = life.snapshot();
  assert.equal(idle.state, 'IDLE');
  assert.equal(idle.session, null);
  assert.equal(idle.generate.available, true, 'the generate action is offered while idle');
  assert.equal(idle.generate.label, 'pairing.generate');
  assert.equal(life.ownerSessionId(), null);
  assert.equal(store.raw(), null, 'nothing was written just by looking');

  // Rendering, refreshing, reconnecting and counting down are all reads. Run them repeatedly.
  for (let i = 0; i < 5; i++) {
    life.snapshot();
    life.expireIfDue();
    life.persist();
    life.clearOnSessionChanged(null);
  }
  assert.equal(life.snapshot().state, 'IDLE');
  assert.equal(store.writes.set, 0, 'no pairing material was ever stored by a read path');
});

test('generate once: exactly one ACTIVE session with the City payload kept verbatim', () => {
  const c = clock(), store = fakeStorage();
  const life = createPairingLifecycle({ storage: store, now: c.now });
  const result = sessionResult(c);
  const created = life.create(result);
  assert.equal(created.created, true);

  const active = life.snapshot();
  assert.equal(active.state, 'ACTIVE');
  assert.equal(active.session.pairingSessionId, 'sess-1');
  assert.equal(active.session.shortCode, '123456');
  assert.equal(active.session.qrPayload, result.qrPayload);
  assert.equal(active.remainingSeconds, 300);
  assert.equal(active.generate.available, false, 'ACTIVE offers no generation action at all');
  assert.equal(active.generate.enabled, false);
  assert.equal(active.generate.label, 'pairing.active');
  assert.equal(store.writes.set, 1, 'the active session is persisted for a same-tab reload');
});

test('ACTIVE is FINAL against re-generation: a second create() cannot rotate the code', () => {
  const c = clock();
  const life = createPairingLifecycle({ storage: fakeStorage(), now: c.now });
  life.create(sessionResult(c, { id: 'sess-1', code: '111111' }));
  c.advance(1000);
  const second = life.create(sessionResult(c, { id: 'sess-2', code: '222222' }));
  assert.deepEqual(second, { created: false, reason: 'SESSION_ALREADY_ACTIVE' });
  const active = life.snapshot();
  assert.equal(active.state, 'ACTIVE');
  assert.equal(active.session.pairingSessionId, 'sess-1', 'the original session id survived');
  assert.equal(active.session.shortCode, '111111', 'the original code survived');
});

test('ordinary reads keep the SAME id, code and payload', () => {
  const c = clock();
  const life = createPairingLifecycle({ storage: fakeStorage(), now: c.now });
  const result = life.create(sessionResult(c)).session;
  for (let i = 0; i < 10; i++) {
    c.advance(1000);
    life.snapshot();
    life.expireIfDue();
    life.clearOnSessionChanged('sess-1'); // the City still reports OUR session as the active one
    const s = life.snapshot();
    assert.equal(s.session.pairingSessionId, result.pairingSessionId);
    assert.equal(s.session.shortCode, result.shortCode);
    assert.equal(s.session.qrPayload, result.qrPayload);
    assert.equal(s.remainingSeconds, 300 - (i + 1));
  }
});

test('CONSUMED: the City reporting a different canonical session ends ACTIVE as USED, not as a mystery', () => {
  const c = clock();
  const life = createPairingLifecycle({ storage: fakeStorage(), now: c.now });
  life.create(sessionResult(c));
  c.advance(5000);
  // Another device exchanged the code: the canonical active session is now gone (null).
  const changed = life.clearOnSessionChanged(null);
  assert.deepEqual(changed, { changed: true, reason: REASON_USED });
  const after = life.snapshot();
  assert.equal(after.state, 'ENDED');
  assert.equal(after.notice, REASON_USED, 'the terminal reason is USED, not EXPIRED');
  assert.equal(after.session, null, 'material is off the page');
  assert.equal(after.generate.available, true, 'generate is offered again');
});

test('EXPIRED: the countdown tick ends the session, names it EXPIRED, and creates nothing', () => {
  const c = clock(), store = fakeStorage();
  const life = createPairingLifecycle({ storage: store, now: c.now });
  life.create(sessionResult(c, { ttlMs: 300000 }));
  const writesAfterCreate = store.writes.set;
  c.advance(300000);
  assert.equal(life.expireIfDue(), true);
  const after = life.snapshot();
  assert.equal(after.state, 'ENDED');
  assert.equal(after.notice, REASON_EXPIRED);
  assert.equal(after.session, null);
  assert.equal(after.generate.available, true);
  assert.equal(store.writes.set, writesAfterCreate, 'expiry wrote no new session, it only removed material');
  assert.equal(store.raw(), null);
});

test('a second EXPLICIT generate after expiry produces a new, different session', () => {
  const c = clock();
  const life = createPairingLifecycle({ storage: fakeStorage(), now: c.now });
  const first = life.create(sessionResult(c, { id: 'sess-1', code: '111111' })).session;
  c.advance(300000);
  life.expireIfDue();
  c.advance(1000);
  const second = life.create(sessionResult(c, { id: 'sess-2', code: '222222' })).session;
  assert.notEqual(second.pairingSessionId, first.pairingSessionId);
  assert.notEqual(second.shortCode, first.shortCode);
  assert.equal(life.snapshot().state, 'ACTIVE');
});

test('a malformed session response creates nothing (a half-session is not rendered)', () => {
  const c = clock(), store = fakeStorage();
  const life = createPairingLifecycle({ storage: store, now: c.now });
  for (const bad of [null, {}, { pairingSessionId: 'x' }, { pairingSessionId: 'x', shortCode: '1' }, { pairingSessionId: 'x', shortCode: '1', expiresAt: 'not-a-date' }]) {
    const out = life.create(bad);
    assert.equal(out.created, false, `${JSON.stringify(bad)} must not create a session`);
  }
  assert.equal(life.snapshot().state, 'IDLE');
  assert.equal(store.writes.set, 0);
});

test('reload persistence: the SAME valid session is restored, with its original expiry', () => {
  const c = clock(), store = fakeStorage();
  const first = createPairingLifecycle({ storage: store, now: c.now });
  first.create(sessionResult(c));
  c.advance(60000); // 60s later the tab reloads
  const restored = createPairingLifecycle({ storage: store, now: c.now });
  const session = restored.restore();
  assert.equal(session.pairingSessionId, 'sess-1');
  assert.equal(session.shortCode, '123456');
  const s = restored.snapshot();
  assert.equal(s.state, 'ACTIVE');
  assert.equal(s.remainingSeconds, 240, 'the countdown continues from the real expiry, not a fresh TTL');
});

test('a stored session that expired while the page was away comes back EXPIRED, never as a new code', () => {
  const c = clock(), store = fakeStorage();
  createPairingLifecycle({ storage: store, now: c.now }).create(sessionResult(c, { ttlMs: 300000 }));
  const before = store.raw();
  c.advance(300001);
  const reopened = createPairingLifecycle({ storage: store, now: c.now });
  assert.equal(reopened.restore(), null);
  const s = reopened.snapshot();
  assert.equal(s.state, 'ENDED');
  assert.equal(s.notice, REASON_EXPIRED);
  assert.equal(s.generate.available, true);
  assert.notEqual(store.raw(), before, 'the stale record was dropped');
  assert.equal(store.raw(), null);
});

test('a corrupt or foreign storage record is dropped rather than half-rendered', () => {
  const c = clock();
  for (const bad of ['not json', '{}', JSON.stringify({ version: 99, cityId: 'x', pairingSessionId: 'y', shortCode: 'z', expiresAt: c.at(), qrPayload: 'p' }),
    JSON.stringify({ version: 1, cityId: 'x', pairingSessionId: 'y', shortCode: '', expiresAt: c.at(), qrPayload: 'p' }),
    JSON.stringify({ version: 1, cityId: 'x', pairingSessionId: 'y', shortCode: 'z', expiresAt: 'garbage', qrPayload: 'p' }),
    JSON.stringify({ version: 1, cityId: 'x', pairingSessionId: 'y', shortCode: 'z', expiresAt: c.at(), qrPayload: '' })]) {
    const store = fakeStorage(bad);
    const life = createPairingLifecycle({ storage: store, now: c.now });
    assert.equal(life.restore(), null, `${bad} must not restore`);
    assert.equal(life.snapshot().state, 'IDLE', 'a dropped record leaves the page idle, it does not fabricate a session');
  }
});

test('an explicit user clear names its reason and still creates nothing', () => {
  const c = clock(), store = fakeStorage();
  const life = createPairingLifecycle({ storage: store, now: c.now });
  life.create(sessionResult(c));
  const writes = store.writes.set;
  life.clear(REASON_REVOKED);
  assert.equal(life.snapshot().notice, REASON_REVOKED);
  assert.equal(life.snapshot().session, null);
  assert.equal(store.writes.set, writes, 'clearing does not write a session');
  assert.equal(store.raw(), null);
});

test('clearOnSessionChanged is a no-op while the City still reports our own session', () => {
  const c = clock();
  const life = createPairingLifecycle({ storage: fakeStorage(), now: c.now });
  life.create(sessionResult(c, { id: 'sess-1' }));
  assert.deepEqual(life.clearOnSessionChanged('sess-1'), { changed: false });
  assert.equal(life.snapshot().state, 'ACTIVE');
  assert.deepEqual(life.clearOnSessionChanged(null), { changed: true, reason: REASON_USED });
});

test('when the City session vanished AND ours is past expiry, the reason reported is EXPIRED', () => {
  const c = clock();
  const life = createPairingLifecycle({ storage: fakeStorage(), now: c.now });
  life.create(sessionResult(c, { ttlMs: 300000 }));
  c.advance(300001);
  assert.deepEqual(life.clearOnSessionChanged('some-other-session'), { changed: true, reason: REASON_EXPIRED });
});

test('a new session after a terminal state is a full fresh display, and generate stays offered only when idle', () => {
  const c = clock();
  const life = createPairingLifecycle({ storage: fakeStorage(), now: c.now });
  life.create(sessionResult(c, { id: 'sess-1' }));
  assert.equal(life.snapshot().generate.available, false);
  c.advance(300000);
  life.expireIfDue();
  assert.equal(life.snapshot().generate.available, true);
  const fresh = life.create(sessionResult(c, { id: 'sess-9', code: '999999' }));
  assert.equal(fresh.created, true);
  assert.equal(life.snapshot().session.shortCode, '999999');
});
