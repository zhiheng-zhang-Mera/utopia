/**
 * UTOPIA · City — independent verification: V0.3 derivation parity.
 *
 * Written by the MB-002 VERIFICATION host (`Alien`), not by the migration host, as part of
 * the independent review required by mission-book rule 9. It is a supplementary test
 * (rule 10) for the one thing this migration actually changed on the live product surface.
 *
 * WHY THIS EXISTS. MB-002 rewired `services/capability-bridge/registry.mjs` — the file that
 * produces the capability descriptors Web and Android both read — so that the descriptor is
 * now derived by this module's `describeOwnership` instead of by an inline expression in the
 * registry. The accepted V0.3 behaviour (five AVAILABLE services, BRIDGE_PENDING for a module
 * nobody wired, DEGRADED when an owner is not PROMOTED/ACTIVE, UNAVAILABLE when deprecated)
 * is an acceptance surface. Nothing in the migration's own suite compared the new derivation
 * against the rule it replaced, so a drift would have been invisible until it reached a
 * client.
 *
 * The oracle below is the pre-migration expression, transcribed verbatim from
 * `services/capability-bridge/registry.mjs` at the merge-base `c7ef3cd1`:
 *
 *   states.includes('DEPRECATED') ? 'UNAVAILABLE'
 *   : states.some(s => ['PLANNED','INCUBATING'].includes(s)) ? 'BRIDGE_PENDING'
 *   : states.some(s => !['PROMOTED','ACTIVE'].includes(s)) ? 'DEGRADED'
 *   : hasAdapter ? 'AVAILABLE' : 'BRIDGE_PENDING'
 *
 * Every combination of one to three module lifecycles is walked, because a capability may be
 * backed by several modules and the mixture is exactly where a rule like this drifts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { describeOwnership } from '../routing.mjs';

/** The accepted V0.3 rule, as the oracle. Do not "tidy" this: it must stay the old rule. */
function legacyBridgeState(states, hasAdapter) {
  return states.includes('DEPRECATED')
    ? 'UNAVAILABLE'
    : states.some((state) => ['PLANNED', 'INCUBATING'].includes(state))
      ? 'BRIDGE_PENDING'
      : states.some((state) => !['PROMOTED', 'ACTIVE'].includes(state))
        ? 'DEGRADED'
        : hasAdapter
          ? 'AVAILABLE'
          : 'BRIDGE_PENDING';
}

/** The accepted V0.3 city-lifecycle rule, as the oracle. */
function legacyCityLifecycle(states) {
  return new Set(states).size === 1 ? states[0] : 'MIXED';
}

const LIFECYCLES = ['PROMOTED', 'ACTIVE', 'PLANNED', 'INCUBATING', 'DEPRECATED', 'UNAVAILABLE'];
const ref = (index) => ({ districtId: 'd', buildingId: 'b', moduleId: `m${index}` });

/** Every lifecycle combination of length 1..3, paired with both adapter states. */
function* cases() {
  const lengths = [1, 2, 3];
  for (const length of lengths) {
    const indices = Array.from({ length }, () => 0);
    while (true) {
      const states = indices.map((value) => LIFECYCLES[value]);
      yield { states, hasAdapter: true };
      yield { states, hasAdapter: false };
      let position = length - 1;
      while (position >= 0) {
        indices[position] += 1;
        if (indices[position] < LIFECYCLES.length) break;
        indices[position] = 0;
        position -= 1;
      }
      if (position < 0) break;
    }
  }
}

test('the live bridgeState derivation is identical to the accepted V0.3 rule for every lifecycle mixture', () => {
  let checked = 0;
  for (const { states, hasAdapter } of cases()) {
    const moduleRefs = states.map((_, index) => ref(index));
    const lifecycleFor = (moduleRef) => states[Number(moduleRef.moduleId.slice(1))];
    const ownership = describeOwnership({ moduleRefs, lifecycleFor, hasAdapter });
    assert.equal(
      ownership.bridgeState,
      legacyBridgeState(states, hasAdapter),
      `bridgeState drifted for [${states.join(',')}] hasAdapter=${hasAdapter}`,
    );
    checked += 1;
  }
  assert.equal(checked, (6 + 36 + 216) * 2, 'every 1..3 lifecycle mixture was walked, in both adapter states');
});

test('the live cityLifecycle derivation is identical to the accepted V0.3 rule for every backed capability', () => {
  let checked = 0;
  for (const { states } of cases()) {
    const moduleRefs = states.map((_, index) => ref(index));
    const lifecycleFor = (moduleRef) => states[Number(moduleRef.moduleId.slice(1))];
    const ownership = describeOwnership({ moduleRefs, lifecycleFor, hasAdapter: true });
    assert.equal(
      ownership.cityLifecycle,
      legacyCityLifecycle(states),
      `cityLifecycle drifted for [${states.join(',')}]`,
    );
    checked += 1;
  }
  // The generator yields both adapter states for each mixture; cityLifecycle does not depend
  // on hasAdapter, so each mixture is honestly checked twice rather than deduplicated.
  assert.equal(checked, (6 + 36 + 216) * 2);
});

/**
 * A capability is only ever described from a non-empty moduleRefs list in the live registry:
 * the five providers each name at least one module, and every unwired module is described
 * from a single-element list. So the empty case is unreachable through the product surface.
 *
 * It is nevertheless NOT equivalent, and this test records that rather than hiding it:
 * the old rule answered 'MIXED' for an empty state set (`new Set([]).size === 1` is false),
 * while the new one answers 'UNAVAILABLE'. Verified 2026-09-29 by the MB-002 verification
 * host. If a future caller can pass an empty list, this assertion is the tripwire.
 */
test('the empty-moduleRefs case differs from the old rule and is unreachable from the live registry', () => {
  const ownership = describeOwnership({ moduleRefs: [], lifecycleFor: () => 'ACTIVE', hasAdapter: true });
  assert.equal(legacyCityLifecycle([]), 'MIXED', 'the old rule answered MIXED');
  assert.equal(ownership.cityLifecycle, 'UNAVAILABLE', 'the new rule answers UNAVAILABLE');
  assert.equal(ownership.bridgeState, legacyBridgeState([], true), 'bridgeState still agrees in the empty case');
});
