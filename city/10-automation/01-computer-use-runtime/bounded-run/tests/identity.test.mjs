/**
 * UTOPIA · 10-automation / Computer Use Runtime — bounded-run sibling-identity suite.
 *
 * The donor's `stabilization.cjs` imports `revalidate()` from `target.cjs` and its
 * `recovery.cjs` imports `fallbackChannels` / `CHANNEL_PLANS` from `routing.cjs`.
 * Both of those donor files are owned by *other* rooms in this same building —
 * `target-guard` and `routing-safety` — so `bounded-run` must use their bindings,
 * not a local copy.
 *
 * This suite is deliberately *not* a `deepEqual` test. A deep-equal copy passes a
 * value comparison and still drifts: the moment `target-guard` repairs
 * `revalidate` or `routing-safety` fixes a channel plan, a copy in this room keeps
 * answering the old way and nothing fails. So every assertion here is an identity
 * assertion — `Object.is` / `===` on the shipped binding — which only the sibling's
 * own object can satisfy.
 *
 * Ported-from context: DS-Hns `app/computer-use/target.cjs` and
 * `app/computer-use/routing.cjs` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as index from '../index.mjs';
import * as stabilization from '../stabilization.mjs';
import * as recovery from '../recovery.mjs';
import * as targetGuard from '../../target-guard/target.mjs';
import * as routingSafety from '../../routing-safety/routing.mjs';

test('stabilization re-exports the target-guard room\'s own revalidate', async () => {
  const sibling = (await import('../../target-guard/target.mjs')).revalidate;
  assert.ok(Object.is(stabilization.revalidate, sibling), 'stabilization.revalidate must be target-guard\'s binding');
  assert.equal(stabilization.revalidate, sibling);
  // A copy would pass a value test; it must also fail identity. Prove the two are
  // not merely equal by confirming the module namespace is the one that owns it.
  assert.ok(targetGuard.revalidate === sibling);
  assert.equal(typeof sibling, 'function');
});

test('the barrel re-exports that same revalidate binding', async () => {
  const sibling = (await import('../../target-guard/target.mjs')).revalidate;
  assert.ok(Object.is(index.revalidate, sibling), 'index.revalidate must be target-guard\'s binding');
  assert.ok(Object.is(index.revalidate, stabilization.revalidate));
});

test('recovery uses the routing-safety room\'s own channel plan table', async () => {
  const sibling = (await import('../../routing-safety/routing.mjs')).CHANNEL_PLANS;
  // The donor's `routing.cjs` keeps this table private and `recovery.cjs` only
  // reads it, so this room cannot re-export it: the donor's own surface has no
  // such name, and adding one would be an invented export. What is assertable is
  // that the sibling's table is a frozen object the sibling owns, and that the
  // public behaviour which consumes it matches the donor plan exactly.
  assert.ok(Object.is(routingSafety.CHANNEL_PLANS, sibling));
  assert.ok(Object.isFrozen(sibling));
  assert.equal('CHANNEL_PLANS' in recovery, false, 'the routing table stays private to the module');

  // Behavioural proof on top of the identity proof: the sibling's table is the one
  // that decides the alternative. DOM_TYPE is the rung where a copy would differ
  // if the plan were mistyped — the donor's plan is exactly ['dom', 'accessibility'].
  assert.deepEqual(sibling.DOM_TYPE, ['dom', 'accessibility']);
  const viaAccessibility = recovery.alternativeAction({ type: 'DOM_TYPE', target: { ref: 'n' }, params: {} }, { attempt: 1, usedChannel: 'dom' });
  assert.equal(viaAccessibility.channel, 'accessibility');
  const viaDom = recovery.alternativeAction({ type: 'DOM_TYPE', target: { ref: 'n' }, params: {} }, { attempt: 1, usedChannel: 'accessibility' });
  assert.equal(viaDom.channel, 'dom');
});

test('the routing-safety room\'s fallbackChannels is the function that answers', async () => {
  const sibling = (await import('../../routing-safety/routing.mjs')).fallbackChannels;
  assert.ok(Object.is(routingSafety.fallbackChannels, sibling));
  for (const type of ['CLICK', 'TYPE', 'SCROLL', 'DOM_TYPE', 'SHELL_EXEC', 'SCREENSHOT_FULL']) {
    assert.deepEqual(sibling({ type }), routingSafety.CHANNEL_PLANS[type], `sibling fallback for ${type}`);
  }
  // `fallbackChannels` answers a copy, so a caller mutating the answer cannot
  // reach the frozen plan.
  const answer = sibling({ type: 'CLICK' });
  answer.length = 0;
  assert.deepEqual(routingSafety.CHANNEL_PLANS.CLICK, ['dom', 'accessibility', 'gui', 'vision']);
});

test('the sibling-owned bindings are the donor\'s algorithms, not lookalikes', async () => {
  const { revalidate } = await import('../../target-guard/target.mjs');
  // The four donor verdicts, through the sibling's function.
  assert.equal(revalidate(null, { point: { x: 0, y: 0 } }).verdict, 'unknown');
  assert.equal(revalidate({ point: { x: 0, y: 0 } }, null).verdict, 'missing');
  assert.equal(revalidate({ point: { x: 0, y: 0 } }, { point: { x: 1, y: 0 } }).verdict, 'stable');
  assert.equal(revalidate({ point: { x: 0, y: 0 } }, { point: { x: 5, y: 0 } }).verdict, 'updated');
  assert.equal(revalidate({ point: { x: 0, y: 0 } }, { point: { x: 40, y: 0 } }).verdict, 'stale');

  // And the stabilizer consumes that same function: an injected threshold changes
  // the verdict the sibling computes, not a private copy of it.
  const { createStabilizer } = await import('../stabilization.mjs');
  const stabilizer = createStabilizer({ clock: { now: () => 0, sleep: async () => {} }, thresholds: { stablePx: 5, updatePx: 300 } });
  const settled = await stabilizer.settle({
    world: { revision: 1 },
    action: { stabilization: { minimumMs: 0, maximumMs: 300 } },
    previous: { point: { x: 0, y: 0 } },
    observe: async () => ({ revision: 2 }),
    locateTarget: async () => ({ point: { x: 100, y: 0 } }),
  });
  assert.equal(settled.verdict, 'updated');
  assert.equal(settled.revalidation.movement, 100);
});
