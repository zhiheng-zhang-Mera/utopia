// EM-005 conformance suite ¡ª attention bridge and current + recent-device delivery.
//
// Acceptance: one attention_id creates one logical question despite multiple projections; the current
// interaction device is always included when eligible/online; only 2¨C3 recent eligible devices receive
// auxiliary projections, ranked by real user interaction recency; first valid acknowledgement wins
// globally; reconnect/refresh/repeated delivery never rings again; quiet policy suppresses sound but
// keeps the notification; informational events do not ring by default; and a response routes back to
// the originating connector whichever device answered.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
 ATTENTION_CODES, ATTENTION_KINDS, ATTENTION_STATUSES, AttentionError, ENGINEERING_ATTENTION_CONTRACT,
 MAX_RECENT_DEVICES, MIN_RECENT_DEVICES, PROJECTION_KINDS, createAttentionBridge,
 rankRecentDevices, soundAllowed, validateAttentionEnvelope
} from '../index.mjs';

const T0 = Date.parse('2026-09-30T12:00:00.000Z');
const ISO = ms => new Date(ms).toISOString();
const MINUTE = 60_000;
const CLOCK = ISO(T0);
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected the call to fail with ${code}`);
};

const attention = (overrides = {}) => ({
  contract_version: 1,
  attention_id: 'attention-1',
  job_ref: 'job-1',
  connector_ref: 'connector-1',
  kind: 'PERMISSION',
  question: 'May the worker run package installs?',
  blocking: true,
  created_at: ISO(T0),
  ...overrides,
});

const device = (ref, minutesAgo, overrides = {}) => ({
  device_ref: ref,
  online: true,
  eligible: true,
  last_interacted_at: ISO(T0 - minutesAgo * MINUTE),
  quiet: false,
  full_screen: false,
  protected_use: false,
  ...overrides,
});

/** The current device plus four eligible peers with clearly ordered interaction recency. */
const devices = () => [
  device('device-current', 0),
  device('device-recent-1', 2),
  device('device-recent-2', 9),
  device('device-recent-3', 30),
  device('device-old', 600),
];

const openBridge = ({ policy = {}, devices: list = devices(), at = T0 } = {}) => {
  const bridge = createAttentionBridge({ clock: () => ISO(at), policy });
  const opened = bridge.open(attention(), { currentDeviceRef: 'device-current', devices: list, at });
  return { bridge, opened };
};

/* --------------------------------------------- 1. one question, several projections */

test('one attention_id is one logical question however many projections it carries', () => {
  const { bridge, opened } = openBridge();
  assert.equal(opened.opened, true);
  assert.equal(opened.event.projections.length, 4, 'the current device plus three recent ones');
  assert.equal(new Set(opened.event.projections.map(entry => entry.device_ref)).size, 4);
  assert.equal(opened.event.question, 'May the worker run package installs?');
  const questions = bridge.logicalQuestions();
  assert.equal(questions.length, 1);
  assert.equal(questions[0].attention_id, 'attention-1');
  assert.equal(questions[0].projections, 4);
  // re-opening the same id is a re-delivery, not a second question
  const reopened = bridge.open(attention(), { currentDeviceRef: 'device-current', devices: devices(), at: T0 + MINUTE });
  assert.equal(reopened.opened, false);
  assert.equal(reopened.reason, 'ALREADY_OPEN');
  assert.equal(bridge.logicalQuestions().length, 1);
  assert.equal(ENGINEERING_ATTENTION_CONTRACT.one_attention_id_one_question, true);
});

test('the current interaction device always carries the actionable projection', () => {
  const { opened } = openBridge();
  const actionable = opened.event.projections.filter(entry => entry.actionable === true);
  assert.equal(actionable.length, 1);
  assert.equal(actionable[0].device_ref, 'device-current');
  assert.equal(actionable[0].projection, 'ACTIONABLE');
  assert.equal(actionable[0].notification_visible, true);
  assert.equal(actionable[0].ringing, false, 'the actionable device shows the question rather than ringing at the user');
  assert.equal(opened.event.projections.filter(entry => entry.actionable === false).length, 3);
  // an ineligible current device is refused rather than silently projected elsewhere
  const bridge = createAttentionBridge({ clock: () => ISO(T0) });
  expectCode(
    () => bridge.open(attention(), { currentDeviceRef: 'device-away', devices: [device('device-away', 1, { online: false })], at: T0 }),
    'CURRENT_DEVICE_NOT_ELIGIBLE',
  );
  assert.equal(ENGINEERING_ATTENTION_CONTRACT.current_interaction_device_always_included, true);
  assert.deepEqual([...PROJECTION_KINDS], ['ACTIONABLE', 'NOTIFY', 'RING']);
});

/* --------------------------------------------- 2. recent device ranking */

test('only the configured 2-3 recent eligible devices receive auxiliary projections', () => {
  const { opened } = openBridge();
  const auxiliary = opened.event.projections.filter(entry => entry.projection !== 'ACTIONABLE').map(entry => entry.device_ref);
  assert.deepEqual(auxiliary, ['device-recent-1', 'device-recent-2', 'device-recent-3']);
  assert.equal(auxiliary.includes('device-old'), false);
  assert.equal(opened.event.recent_device_count, 3);
  // the count is configurable inside the declared 2-3 band and refused outside it
  const two = openBridge({ policy: { recentDeviceCount: 2 } });
  assert.deepEqual(two.opened.event.projections.filter(entry => entry.projection !== 'ACTIONABLE').map(entry => entry.device_ref), ['device-recent-1', 'device-recent-2']);
  expectCode(() => createAttentionBridge({ policy: { recentDeviceCount: 4 } }), 'INVALID_POLICY');
  expectCode(() => createAttentionBridge({ policy: { recentDeviceCount: 1 } }), 'INVALID_POLICY');
  expectCode(() => rankRecentDevices(devices(), { currentDeviceRef: 'device-current', count: 5 }), 'RECENT_DEVICE_LIMIT');
  assert.deepEqual([MIN_RECENT_DEVICES, MAX_RECENT_DEVICES], [2, 3]);
  assert.deepEqual([...ENGINEERING_ATTENTION_CONTRACT.recent_device_alert_count], [2, 3]);
});

test('recent devices are ranked by user interaction, never by uptime or heartbeat', () => {
  const list = [
    device('device-current', 0),
    // a long-running server, touched a week ago
    device('device-server', 10_080, { uptime_days: 90, last_heartbeat_at: ISO(T0) }),
    // a phone the user used five minutes ago, powered on for an hour
    device('device-phone', 5, { uptime_days: 0.04, last_heartbeat_at: ISO(T0 - 120 * MINUTE) }),
    device('device-tablet', 20, { uptime_days: 2, last_heartbeat_at: ISO(T0 - 300 * MINUTE) }),
  ];
  assert.deepEqual([...rankRecentDevices(list, { currentDeviceRef: 'device-current', count: 3 })], ['device-phone', 'device-tablet', 'device-server']);
  // offline or ineligible devices are excluded even when recently used
  const mixed = [...list, device('device-offline', 1, { online: false }), device('device-ineligible', 3, { eligible: false })];
  assert.deepEqual([...rankRecentDevices(mixed, { currentDeviceRef: 'device-current', count: 3 })], ['device-phone', 'device-tablet', 'device-server']);
  assert.equal(ENGINEERING_ATTENTION_CONTRACT.ranks_by_interaction_recency, true);
  assert.equal(ENGINEERING_ATTENTION_CONTRACT.ranks_by_uptime, false);
  // a tie is broken deterministically by device reference
  const tied = [device('device-b', 7), device('device-a', 7)];
  assert.deepEqual([...rankRecentDevices(tied, { currentDeviceRef: null, count: 2 })], ['device-a', 'device-b']);
});

/* --------------------------------------------- 3. acknowledgement */

test('the first valid acknowledgement closes the question globally and withdraws the rest', () => {
  const { bridge } = openBridge();
  const first = bridge.acknowledge('attention-1', { deviceRef: 'device-recent-2', at: T0 + MINUTE });
  assert.equal(first.acknowledged, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.rangAgain, false);
  const event = bridge.get('attention-1');
  assert.equal(event.status, 'ACKNOWLEDGED');
  assert.equal(event.acknowledgement.acknowledged_by, 'device-recent-2');
  assert.equal(event.projections.every(entry => entry.ringing === false && entry.actionable === false), true);
  const other = event.projections.find(entry => entry.device_ref === 'device-recent-1');
  assert.equal(other.notification_visible, false);
  assert.equal(other.withdrawn_reason, 'ANSWERED_ELSEWHERE');
  assert.equal(bridge.listOpen().length, 0);
  // a second answer from another device is a duplicate, not another question
  const second = bridge.acknowledge('attention-1', { deviceRef: 'device-current', at: T0 + 2 * MINUTE });
  assert.equal(second.acknowledged, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.rangAgain, false);
  assert.equal(bridge.get('attention-1').acknowledgement.acknowledged_by, 'device-recent-2');
  expectCode(() => bridge.acknowledge('attention-1', { deviceRef: 'device-unprojected', at: T0 }), 'NOT_PROJECTED_TO_DEVICE');
  assert.equal(ENGINEERING_ATTENTION_CONTRACT.first_acknowledgement_wins, true);
  assert.deepEqual([...ATTENTION_STATUSES], ['PENDING', 'ACKNOWLEDGED', 'EXPIRED', 'WITHDRAWN']);
});

test('a response routes back to the originating connector whichever device answered', () => {
  const { bridge } = openBridge();
  bridge.acknowledge('attention-1', { deviceRef: 'device-recent-1', at: T0 + MINUTE });
  const routed = bridge.respond('attention-1', { deviceRef: 'device-recent-1', response: { granted: true }, at: T0 + 2 * MINUTE });
  assert.deepEqual(routed, {
    attention_id: 'attention-1', job_ref: 'job-1', connector_ref: 'connector-1',
    answered_by_device_ref: 'device-recent-1', routed_to_connector: true, at: ISO(T0 + 2 * MINUTE),
  });
  // a device that never acknowledged cannot inject a second answer
  expectCode(() => bridge.respond('attention-1', { deviceRef: 'device-recent-2', response: { granted: false }, at: T0 + 3 * MINUTE }), 'ALREADY_ANSWERED');
  expectCode(() => bridge.respond('attention-1', { deviceRef: 'device-unprojected' }), 'NOT_PROJECTED_TO_DEVICE');
  const fresh = createAttentionBridge({ clock: () => ISO(T0) });
  fresh.open(attention(), { currentDeviceRef: 'device-current', devices: devices(), at: T0 });
  expectCode(() => fresh.respond('attention-1', { deviceRef: 'device-current' }), 'ALREADY_ANSWERED');
  assert.equal(ENGINEERING_ATTENTION_CONTRACT.response_routes_to_originating_connector, true);
});

/* --------------------------------------------- 4. delivery dedup */

test('reconnect, refresh and repeated delivery never ring the same epoch twice', () => {
  const { bridge } = openBridge();
  const first = bridge.deliver('attention-1', { deviceRef: 'device-recent-1', at: T0 + MINUTE });
  assert.equal(first.delivered, true);
  assert.equal(first.ringing, true);
  // a reconnect, a page refresh, a retried connector delivery: all suppressed
  for (const reason of ['RECONNECT', 'PAGE_REFRESH', 'CONNECTOR_RETRY', 'HEARTBEAT']) {
    const repeat = bridge.deliver('attention-1', { deviceRef: 'device-recent-1', at: T0 + 2 * MINUTE, reason });
    assert.deepEqual(repeat, { delivered: false, ringing: false, actionable: false, suppressed: true, reason: 'ALREADY_DELIVERED' }, reason);
  }
  // the actionable projection is delivered once too, and never rings
  assert.equal(bridge.deliver('attention-1', { deviceRef: 'device-current', at: T0 + MINUTE }).actionable, true);
  assert.equal(bridge.deliver('attention-1', { deviceRef: 'device-current', at: T0 + 3 * MINUTE }).reason, 'ALREADY_DELIVERED');
  // after acknowledgement, nothing rings again at all
  bridge.acknowledge('attention-1', { deviceRef: 'device-current', at: T0 + 4 * MINUTE });
  const afterAnswer = bridge.deliver('attention-1', { deviceRef: 'device-recent-2', at: T0 + 5 * MINUTE });
  assert.equal(afterAnswer.delivered, false);
  assert.equal(afterAnswer.reason, 'ACKNOWLEDGED');
  expectCode(() => bridge.deliver('attention-1', { deviceRef: 'device-unprojected', at: T0 }), 'NOT_PROJECTED_TO_DEVICE');
  assert.equal(ENGINEERING_ATTENTION_CONTRACT.duplicate_delivery_rings_again, false);
});

/* --------------------------------------------- 5. sound policy */

test('quiet, full-screen and protected use suppress sound but keep the notification', () => {
  const list = [
    device('device-current', 0, { quiet: true }),
    device('device-recent-1', 2, { full_screen: true }),
    device('device-recent-2', 9, { protected_use: true }),
    device('device-recent-3', 30),
  ];
  const { opened } = openBridge({ devices: list });
  assert.equal(opened.event.projections.length, 4);
  assert.equal(opened.event.projections.every(entry => entry.notification_visible === true), true, 'a suppressed device still receives the notification');
  assert.equal(opened.event.projections.filter(entry => entry.sound_suppressed === true).every(entry => entry.ringing === false), true, 'a suppressed projection does not ring');
  assert.equal(opened.event.projections.filter(entry => entry.sound_suppressed === true).length, 3);
  assert.equal(opened.event.projections.find(entry => entry.device_ref === 'device-recent-3').ringing, true, 'an unquiet device rings');
  assert.equal(soundAllowed({ quiet: true }, { blocking: true }), false);
  assert.equal(soundAllowed({}, { blocking: true, ringInformational: false }), true);
  assert.equal(soundAllowed({}, { blocking: false, ringInformational: false }), false, 'informational events do not ring by default');
  assert.equal(soundAllowed({}, { blocking: false, ringInformational: true }), true);
  assert.equal(ENGINEERING_ATTENTION_CONTRACT.quiet_policy_suppresses_sound_only, true);
  assert.equal(ENGINEERING_ATTENTION_CONTRACT.rings_for_informational_events_by_default, false);
});

test('a non-blocking informational event is delivered visibly without ringing', () => {
  const list = [device('device-current', 0), device('device-recent-1', 2), device('device-recent-2', 9)];
  const { bridge, opened } = openBridge({ devices: list });
  assert.equal(opened.event.blocking, true);
  assert.equal(opened.event.projections.find(entry => entry.device_ref === 'device-recent-1').ringing, true);

  const informational = createAttentionBridge({ clock: () => ISO(T0) });
  informational.open(attention({ attention_id: 'attention-2', blocking: false, kind: 'QUESTION' }), { currentDeviceRef: 'device-current', devices: list, at: T0 });
  const event = informational.get('attention-2');
  assert.equal(event.projections.every(entry => entry.ringing === false), true);
  assert.equal(event.projections.every(entry => entry.notification_visible === true), true);

  const optedIn = createAttentionBridge({ clock: () => ISO(T0), policy: { ringInformational: true } });
  optedIn.open(attention({ attention_id: 'attention-3', blocking: false }), { currentDeviceRef: 'device-current', devices: list, at: T0 });
  assert.equal(optedIn.get('attention-3').projections.some(entry => entry.ringing === true), true);
});

/* --------------------------------------------- 6. withdrawal and strictness */

test('withdrawal closes a question, and the envelope is strict', () => {
  const { bridge } = openBridge();
  const withdrawn = bridge.withdraw('attention-1', { reason: 'JOB_TERMINAL', at: T0 + MINUTE });
  assert.equal(withdrawn.withdrawn, true);
  assert.equal(bridge.get('attention-1').status, 'WITHDRAWN');
  assert.equal(bridge.get('attention-1').projections.every(entry => entry.notification_visible === false), true);
  assert.equal(bridge.deliver('attention-1', { deviceRef: 'device-current' }).reason, 'WITHDRAWN');
  assert.equal(bridge.acknowledge('attention-1', { deviceRef: 'device-current' }).duplicate, true);
  assert.equal(bridge.withdraw('attention-1', { reason: 'AGAIN' }).withdrawn, false);
  expectCode(() => bridge.get('attention-missing'), 'UNKNOWN_ATTENTION');
  expectCode(() => bridge.deliver('attention-missing', { deviceRef: 'x' }), 'UNKNOWN_ATTENTION');

  assert.equal(validateAttentionEnvelope(attention()).ok, true);
  assert.equal(validateAttentionEnvelope(attention({ kind: 'VIBES' })).ok, false);
  assert.equal(validateAttentionEnvelope(attention({ contract_version: 2 })).ok, false);
  assert.equal(validateAttentionEnvelope(attention({ blocking: 'yes' })).ok, false);
  assert.equal(validateAttentionEnvelope(attention({ created_at: 'yesterday' })).ok, false);
  assert.equal(validateAttentionEnvelope(attention({ extra: 1 })).ok, false);
  expectCode(() => createAttentionBridge({ clock: () => ISO(T0) }).open(attention({ question: '' }), { currentDeviceRef: 'device-current', devices: devices() }), 'INVALID_ATTENTION');
  assert.deepEqual([...ATTENTION_KINDS], ['PERMISSION', 'QUESTION', 'AUTHENTICATION', 'CONFIRMATION', 'DEVICE_ACTION']);
  assert.equal(new Set(ATTENTION_CODES).size, ATTENTION_CODES.length);
  assert.equal(new AttentionError('X', 'y').status, 409);
  // projections are visible per device, which is how a device asks what it should show
  const { bridge: fresh } = openBridge();
  assert.equal(fresh.projectionsFor('device-recent-1').length, 1);
  assert.equal(fresh.projectionsFor('device-unprojected').length, 0);
});

/* --------------------------------- 7. regressions (Correction, host Alien) */
// Every refusal is paired with the legitimate neighbour that must still pass.

import { MAX_CLOCK_SKEW_MS, RECENT_WINDOW_MS, createAttentionBridge as makeBridge } from '../index.mjs';

test('attention fields named after Object.prototype members are refused', () => {
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    const probe = Object.defineProperty({ ...attention() }, name, { value: 'SMUGGLED', enumerable: true, configurable: true, writable: true });
    assert.equal(validateAttentionEnvelope(probe).ok, false, `attention.${name} must not be canonical`);
  }
  const hidden = { ...attention() };
  Object.defineProperty(hidden, 'transport', { value: 'RF', enumerable: false, configurable: true, writable: true });
  assert.equal(validateAttentionEnvelope(hidden).ok, false, 'a non-enumerable own field must be refused too');
  // neighbours: an ordinary unknown field is still refused, and a clean envelope is still accepted
  assert.equal(validateAttentionEnvelope({ ...attention(), transport: 'RF' }).ok, false);
  assert.equal(validateAttentionEnvelope(attention()).ok, true);
  assert.equal(validateAttentionEnvelope(attention()).errors.length, 0);
  assert.equal({}.SMUGGLED, undefined, 'no prototype pollution');
});

test('a "recent" device is bounded on both sides, and never duplicated', () => {
  const farFuture = device('device-future', 0, { last_interacted_at: ISO(T0 + 10 * 365 * 24 * 3600 * 1000) });
  const abandoned = device('device-abandoned', 0, { last_interacted_at: ISO(T0 - 5 * 365 * 24 * 3600 * 1000) });
  const list = [device('device-current', 1), device('device-phone', 2), abandoned, farFuture];
  const ranked = rankRecentDevices(list, { currentDeviceRef: 'device-current', nowMs: T0 });
  assert.deepEqual([...ranked], ['device-phone'], 'an abandoned or future-dated device is not a recent device');
  assert.equal(RECENT_WINDOW_MS > 0, true);
  assert.equal(MAX_CLOCK_SKEW_MS > 0, true);
  // a duplicate device entry produces one projection, not two
  assert.deepEqual([...rankRecentDevices([device('device-dupe', 1), device('device-dupe', 1)], { currentDeviceRef: null, nowMs: T0, count: 2 })], ['device-dupe']);
  // neighbours: devices inside the window are still ranked, and the count bounds are unchanged
  assert.equal(rankRecentDevices(devices(), { currentDeviceRef: 'device-current', count: 3, nowMs: T0 }).length, 3);
  expectCode(() => rankRecentDevices(devices(), { count: 5, nowMs: T0 }), 'RECENT_DEVICE_LIMIT');
  assert.deepEqual([...rankRecentDevices(devices(), { currentDeviceRef: 'device-current', count: 3 })].length, 3, 'without a clock the window is not applied');
});

test('a different question under a live attention id is refused', () => {
  const bridge = makeBridge({ clock: () => T0 });
  bridge.open(attention(), { currentDeviceRef: 'device-current', devices: devices() });
  const originalQuestion = bridge.get('attention-1').question;
  const same = bridge.open(attention(), { currentDeviceRef: 'device-current', devices: devices() });
  assert.equal(same.opened, false);
  assert.equal(same.reason, 'ALREADY_OPEN');
  // the same id carrying a different question must not be silently discarded
  const error = expectCode(() => bridge.open(attention({ question: 'a completely different question' }), { currentDeviceRef: 'device-current', devices: devices() }), 'INVALID_ATTENTION');
  assert.equal(error.message.includes('different question'), true);
  assert.equal(bridge.get('attention-1').question, originalQuestion, 'the original question is untouched');
  // neighbours: a genuinely new id still opens
  assert.equal(bridge.open(attention({ attention_id: 'attention-2' }), { currentDeviceRef: 'device-current', devices: devices() }).opened, true);
});

test('a malformed instant cannot half-apply a transition', () => {
  const bridge = makeBridge({ clock: () => T0 });
  bridge.open(attention(), { currentDeviceRef: 'device-current', devices: devices() });
  expectCode(() => bridge.acknowledge('attention-1', { deviceRef: 'device-current', at: 'nonsense' }), 'INVALID_ATTENTION');
  assert.equal(bridge.get('attention-1').status, 'PENDING', 'the refusal is total');
  assert.equal(bridge.get('attention-1').acknowledgement.acknowledged_by, null);
  expectCode(() => bridge.acknowledge('attention-1', { deviceRef: 'device-current', at: 1e21 }), 'INVALID_ATTENTION');
  assert.equal(bridge.get('attention-1').status, 'PENDING');
  const withdrawn = makeBridge({ clock: () => T0 });
  withdrawn.open(attention(), { currentDeviceRef: 'device-current', devices: devices() });
  expectCode(() => withdrawn.withdraw('attention-1', { at: 'nonsense' }), 'INVALID_ATTENTION');
  assert.equal(withdrawn.get('attention-1').status, 'PENDING');
  // neighbours: honest transitions still apply, and an honest retry after a refusal works
  const acked = bridge.acknowledge('attention-1', { deviceRef: 'device-current', at: T0 + 1000 });
  assert.equal(acked.acknowledged, true);
  assert.equal(bridge.get('attention-1').status, 'ACKNOWLEDGED');
  assert.equal(withdrawn.withdraw('attention-1', { at: T0 }).withdrawn, true);
});

test('a response routes exactly once', () => {
  const bridge = makeBridge({ clock: () => T0 });
  bridge.open(attention(), { currentDeviceRef: 'device-current', devices: devices() });
  bridge.acknowledge('attention-1', { deviceRef: 'device-recent-1', at: T0 });
  const routed = bridge.respond('attention-1', { deviceRef: 'device-recent-1', response: { granted: true }, at: T0 });
  assert.equal(routed.routed_to_connector, true);
  assert.equal(routed.connector_ref, 'connector-1');
  // the same device re-routing used to succeed and silently replace what the connector already had
  expectCode(() => bridge.respond('attention-1', { deviceRef: 'device-recent-1', response: { granted: false }, at: T0 }), 'RESPONSE_ALREADY_ROUTED');
  assert.deepEqual(bridge.get('attention-1').response, { granted: true }, 'the routed response is not replaceable');
  // neighbours: another device is still refused, and an unacknowledged question still refuses a response
  expectCode(() => bridge.respond('attention-1', { deviceRef: 'device-recent-2' }), 'ALREADY_ANSWERED');
  const fresh = makeBridge({ clock: () => T0 });
  fresh.open(attention(), { currentDeviceRef: 'device-current', devices: devices() });
  expectCode(() => fresh.respond('attention-1', { deviceRef: 'device-current' }), 'ALREADY_ANSWERED');
});
test('a response that cannot be stored is refused before the routing is committed', () => {
  const bridge = makeBridge({ clock: () => T0 });
  bridge.open(attention(), { currentDeviceRef: 'device-current', devices: devices() });
  bridge.acknowledge('attention-1', { deviceRef: 'device-current', at: T0 });
  let refused = false;
  try { bridge.respond('attention-1', { deviceRef: 'device-current', response: { fn: () => 1 }, at: T0 }); } catch { refused = true; }
  assert.equal(refused, true, 'an unstorable response is refused');
  assert.equal(bridge.get('attention-1').response_routed ?? false, false, 'the routing was not committed');
  assert.equal(bridge.get('attention-1').response ?? null, null);
  // neighbours: a storable response still routes exactly once
  const routed = bridge.respond('attention-1', { deviceRef: 'device-current', response: { granted: true }, at: T0 });
  assert.equal(routed.routed_to_connector, true);
  assert.deepEqual(bridge.get('attention-1').response, { granted: true });
});