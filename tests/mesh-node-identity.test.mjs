// MESH-301 — the OWNER'S NAMING RULE, guarded.
//
// "本主机加入网络时设备名称默认为 Alien-Win；应用中的设备显示名称可以自定义，但实体指定物理机器不变。"
//
// Mech measured that the mechanism behind this existed only in a record and one local worktree, never on a
// branch, so the guarantee really rested on every caller passing the same node id. These tests are what makes
// the rule a property of the code rather than of the caller's memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_NODE_IDENTITY, resolveNodeIdentity} from '../scripts/mesh-node-identity.mjs';

/** An in-memory stand-in for `.city-node-identity.json`. */
function machine(initial = null) {
  let stored = initial;
  return {
    read: () => stored,
    write: (id) => { stored = id; },
    current: () => stored,
  };
}

test('MESH-301 naming: a fresh machine joins as Alien-Win, and that name is persisted', () => {
  const m = machine(null);
  const r = resolveNodeIdentity({argv: [], env: {}, readIdentity: m.read, writeIdentity: m.write});
  assert.equal(r.identity, DEFAULT_NODE_IDENTITY, 'the default identity is the Owner rule');
  assert.equal(r.displayName, DEFAULT_NODE_IDENTITY, 'with no display name given, the label is the identity');
  assert.equal(m.current(), DEFAULT_NODE_IDENTITY, 'the identity is persisted on first use');
});

test('MESH-301 naming: RENAMING changes the label and never the physical identity', () => {
  const m = machine('Alien-Win');
  const r = resolveNodeIdentity({argv: ['Living-Room-PC'], env: {}, readIdentity: m.read, writeIdentity: m.write});
  assert.equal(r.displayName, 'Living-Room-PC', 'the display name is customisable');
  assert.equal(r.identity, 'Alien-Win', 'the physical identity did NOT move');
  assert.equal(m.current(), 'Alien-Win', 'and nothing rewrote the persisted identity');
  assert.equal(r.renamed, true, 'the rename is reported rather than silent');
});

test('MESH-301 naming: the persisted identity beats the default even with no arguments at all', () => {
  const m = machine('Workstation-7');
  const r = resolveNodeIdentity({argv: [], env: {}, readIdentity: m.read, writeIdentity: m.write});
  assert.equal(r.identity, 'Workstation-7', 'a machine that already has an identity keeps it');
  assert.equal(r.displayName, 'Workstation-7');
  assert.equal(r.renamed, false);
});

test('MESH-301 naming: an explicit environment identity wins and is persisted', () => {
  const m = machine('Alien-Win');
  const r = resolveNodeIdentity({argv: [], env: {CITY_NODE_ID: 'Lab-Box', CITY_NODE_DISPLAY_NAME: '实验室'}, readIdentity: m.read, writeIdentity: m.write});
  assert.equal(r.identity, 'Lab-Box');
  assert.equal(r.displayName, '实验室', 'the display name comes from its own variable, independently');
  assert.equal(m.current(), 'Lab-Box', 'an explicit identity becomes this machine\'s persisted identity');
});

test('MESH-301 naming: --id wins, and the flag does NOT swallow the display name', () => {
  // The bug this guards: with no --id, `indexOf` returned -1 and the filter dropped argv[0], so a rename did
  // nothing. Measured live before the fix, so the assertion is here permanently.
  const m = machine(null);
  const withFlag = resolveNodeIdentity({argv: ['Display-Name', '--id', 'Stable-Id'], env: {}, readIdentity: m.read, writeIdentity: m.write});
  assert.equal(withFlag.identity, 'Stable-Id');
  assert.equal(withFlag.displayName, 'Display-Name', 'the positional argument on either side of --id still counts');

  const m2 = machine(null);
  const noFlag = resolveNodeIdentity({argv: ['Only-A-Display-Name'], env: {}, readIdentity: m2.read, writeIdentity: m2.write});
  assert.equal(noFlag.displayName, 'Only-A-Display-Name');
  assert.equal(noFlag.identity, DEFAULT_NODE_IDENTITY, 'with no id source, the identity falls back to the rule');
});

test('MESH-301 naming: an unreadable identity store does not stop the node, and the default still applies', () => {
  const r = resolveNodeIdentity({
    argv: [], env: {},
    readIdentity: () => { throw new Error('permission denied'); },
    writeIdentity: () => { throw new Error('read-only workspace'); },
  });
  assert.equal(r.identity, DEFAULT_NODE_IDENTITY, 'a broken store degrades to the rule rather than failing the node');
});
