// The connection surface, without a browser.
//
// What these tests are for: the Owner's requirement is that a user can reach ANY number of PCs, each by the
// quickest available way, and be told which one should carry the City. That is logic, so it is pinned here;
// the browser suite covers that the same logic is actually on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONNECT_ACTIONS, MAX_CONNECT_ROWS, buildConnectList, capabilityLabel, fallbackRows, recommendedReason, renderConnectList, scopeOf } from '../apps/web/connect-surface.js';

const facts = (over = {}) => ({ cores: 8, memoryFreeBytes: 8e9, memoryTotalBytes: 16e9, attachment: null, metered: null, ...over });
const pc = (over = {}) => ({ cityRef: 'pc-b', displayName: 'PC-B', address: '192.168.1.20', port: 4391, transport: 'lan', carrierFacts: facts(), ...over });

// A translator that behaves like the real one for the two things these tests care about: it SUBSTITUTES named
// parameters, and it keeps the key when the key is unknown. The earlier version of these tests used an identity
// translator, which made every text assertion meaningless - the assertions were reading keys, not sentences.
const dict = {
  'connect.recommend.self': '{name} already runs the City here',
  'connect.recommend.best': '{name} is the best carrier for everyone',
  'connect.recommend.thin': '{name} looks best, but little evidence was reported',
  'connect.recommend.none': 'no City is reachable right now',
  'connect.capability.cores': '{count} cores',
  'connect.capability.memory': '{free}/{total} GB free',
  'connect.capability.unknown': 'capability unknown',
  'connect.thisMachine': 'this machine',
  'connect.none': 'nothing to connect to yet',
  'connect.discarded': '{count} more were not shown',
  'connect.unreachable': 'unreachable',
  'connect.recommended': 'best carrier',
  'connect.noAddress': 'no address',
  'device.unknown': 'unknown',
};
const t = (key, params = {}) => {
  const template = dict[key] ?? key;
  return String(template).replace(/\{(\w+)\}/g, (_, k) => (params[k] === undefined ? `{${k}}` : String(params[k])));
};

test('scope: local, lan, remote and unknown are distinguished, and an address we hold is never called "nearby"', () => {
  assert.equal(scopeOf({ address: '127.0.0.1' }), 'local');
  assert.equal(scopeOf({ cityId: 'c1', selfCityId: 'c1' }), 'local');
  assert.equal(scopeOf({ address: '192.168.1.20', transport: 'lan' }), 'lan');
  assert.equal(scopeOf({ address: '203.0.113.9', transport: 'unknown' }), 'remote', 'a configured path is not a nearby one');
  assert.equal(scopeOf({ address: '192.168.1.20', transport: 'bluetooth' }), 'bluetooth');
  assert.equal(scopeOf({}), 'unknown');
});

test('the list always contains this machine, and offers to use it', () => {
  const list = buildConnectList({ self: { cityRef: 'me', displayName: 'Alien-Win', address: '127.0.0.1', carrierFacts: facts() } });
  assert.equal(list.rows.length, 1);
  assert.equal(list.rows[0].scope, 'local');
  assert.equal(list.rows[0].actions[0].kind, CONNECT_ACTIONS.useSelf);
  assert.equal(list.recommendedRef, 'me');
  assert.match(recommendedReason(list, t), /already runs the City here/);
});

test('the list is NOT fixed at two: any number of PCs is listed, in one list', () => {
  const nearby = ['pc-b', 'pc-c', 'pc-d', 'pc-e'].map((r, i) => pc({ cityRef: r, displayName: r.toUpperCase(), address: `192.168.1.2${i}` }));
  const list = buildConnectList({ self: { cityRef: 'me', address: '127.0.0.1', carrierFacts: facts() }, nearby });
  assert.equal(list.rows.length, 5, 'this machine plus four PCs');
  assert.equal(new Set(list.rows.map(r => r.cityRef)).size, 5, 'and each appears once');
});

test('each PC offers the actions that make sense for it, and none that do not', () => {
  const list = buildConnectList({
    self: { cityRef: 'me', address: '127.0.0.1', carrierFacts: facts() },
    nearby: [pc({ cityRef: 'pc-b' })],
  });
  const self = list.rows.find(r => r.cityRef === 'me');
  const other = list.rows.find(r => r.cityRef === 'pc-b');
  assert.deepEqual(self.actions.map(a => a.kind), [CONNECT_ACTIONS.useSelf], 'inviting ourselves is meaningless');
  assert.deepEqual(other.actions.map(a => a.kind).sort(), [CONNECT_ACTIONS.invite, CONNECT_ACTIONS.join].sort());
  // Every action is data, so the dispatcher can read it back off the DOM after a re-render.
  for (const row of list.rows) for (const a of row.actions) assert.equal(typeof a.id, 'string');
});

test('a remembered PC that discovery did NOT find is still listed, because that is when the address matters', () => {
  const list = buildConnectList({
    self: { cityRef: 'me', address: '127.0.0.1', carrierFacts: facts() },
    nearby: [],
    remembered: [{ cityRef: 'pc-old', displayName: 'PC-Old', address: '203.0.113.9', port: 4391 }],
  });
  const row = list.rows.find(r => r.cityRef === 'pc-old');
  assert.ok(row, 'the row survives');
  assert.equal(row.source, 'remembered');
  assert.equal(row.scope, 'remote');
  assert.equal(row.previouslyJoined, true);
  assert.ok(row.actions.some(a => a.kind === CONNECT_ACTIONS.join), 'and it can still be rejoined');
});

test('discovery and memory overlap constantly, and a PC is never listed twice', () => {
  const list = buildConnectList({
    self: { cityRef: 'me', address: '127.0.0.1', carrierFacts: facts() },
    nearby: [pc({ cityRef: 'pc-b' })],
    remembered: [{ cityRef: 'pc-b', displayName: 'PC-B (remembered)', address: '192.168.1.20', port: 4391 }],
  });
  assert.equal(list.rows.filter(r => r.cityRef === 'pc-b').length, 1);
  assert.equal(list.rows.find(r => r.cityRef === 'pc-b').source, 'discovery', 'the live sighting wins over the memory');
});

test('the recommendation is attached to a row, so the list and the recommendation cannot disagree', () => {
  const strong = pc({ cityRef: 'strong', displayName: 'Strong', carrierFacts: facts({ cores: 32, memoryFreeBytes: 60e9, memoryTotalBytes: 64e9 }) });
  const weak = pc({ cityRef: 'weak', displayName: 'Weak', address: '192.168.1.21', carrierFacts: facts({ cores: 2, memoryFreeBytes: 1e9, memoryTotalBytes: 8e9 }) });
  const list = buildConnectList({ self: null, nearby: [weak, strong] });
  assert.equal(list.recommendedRef, 'strong');
  assert.equal(list.rows.filter(r => r.recommended).length, 1);
  assert.match(recommendedReason(list, t), /Strong/);
});

test('a machine with no telemetry is marked as thin evidence rather than being scored as if it were measured', () => {
  const list = buildConnectList({ self: null, nearby: [pc({ cityRef: 'opaque', carrierFacts: null })] });
  const row = list.rows[0];
  assert.equal(row.capacityKnown, false);
  assert.equal(typeof row.score, 'number', 'it still gets a score, from the parts that exist');
  assert.match(recommendedReason(list, t), /little|thin|evidence/i);
  assert.match(row.summary, /unknown/i);
});

test('row count is bounded and the discarded overlap is stated rather than silently dropped', () => {
  const nearby = Array.from({ length: MAX_CONNECT_ROWS + 3 }, (_, i) => pc({ cityRef: 'pc-' + i, address: `192.168.1.${i + 10}` }));
  const list = buildConnectList({ nearby });
  assert.equal(list.rows.length, MAX_CONNECT_ROWS);
  assert.equal(list.discarded, 3);
  assert.match(renderConnectList(list, { translate: t }), /3/);
});

test('the fallback channels are DESCRIBED, not moved: the entry controls stay where the app renders them', () => {
  const ids = fallbackRows().map(f => f.id);
  assert.deepEqual(ids, ['qr', 'code', 'link', 'manual']);
  const html = renderConnectList(buildConnectList({ self: { cityRef: 'me', address: '127.0.0.1', carrierFacts: facts() } }));
  for (const id of ids) assert.equal(html.includes(`id="${id}"`), false, `the connect list must not render the ${id} control itself`);
});

test('rendering is escaped and carries its action as data', () => {
  const nasty = pc({ cityRef: 'pc-x', displayName: '<img src=x onerror=alert(1)>', address: '192.168.1.99' });
  const html = renderConnectList(buildConnectList({ nearby: [nasty] }), { translate: t });
  assert.equal(html.includes('<img'), false, 'a display name is text, never markup');
  assert.match(html, /data-connect-action="join"/);
  assert.match(html, /data-connect-ref="pc-x"/);
});

test('an empty world renders an honest sentence, not an empty list', () => {
  const list = buildConnectList({});
  assert.deepEqual(list.rows, []);
  assert.equal(list.recommendedRef, null);
  assert.match(renderConnectList(list, { translate: t }), /nothing to connect to yet/);
});

test('capability summaries report only what was measured, and say unknown when nothing was', () => {
  assert.equal(capabilityLabel(null, t), 'capability unknown');
  assert.equal(capabilityLabel({}, t), 'capability unknown');
  const text = capabilityLabel(facts({ cores: 4 }), t);
  assert.match(text, /4 cores/);
  assert.equal(text.includes('connect.capability.memory'), false, 'a missing measurement is absent, not zero');
});
