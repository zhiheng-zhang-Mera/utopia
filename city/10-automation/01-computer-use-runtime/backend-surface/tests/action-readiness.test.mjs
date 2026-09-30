/**
 * Donor-behaviour pin for the R-201 readiness ladder.
 *
 * Donor: `src/shared/action-readiness.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. That file HAS a donor test
 * (`tests/unit/action-readiness.test.ts`); every expectation there is reproduced
 * here by value, plus the cases it never reached: every gate against every fact
 * value, the "unknown ⇒ pass" rule, `ACTION_ALLOWED` never blocking, and both
 * edges of the bounded retry arithmetic.
 *
 * Every expectation is the donor's literal output.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { READINESS_GATES, escalationAfterFailure, postActionVerified, readinessFromProbe } from "../action-readiness.mjs";

test("the ordered gate chain is the donor's seven-value literal, in order, frozen", () => {
  assert.deepEqual([...READINESS_GATES], [
    "NAVIGATION_ACCEPTED", "DOM_READY", "TARGET_EXISTS", "TARGET_VISIBLE", "TARGET_ENABLED", "TARGET_STABLE", "ACTION_ALLOWED"
  ]);
  assert.equal(READINESS_GATES.length, 7);
  assert.equal(Object.isFrozen(READINESS_GATES), true);
});

test("a fully-ready probe is ready with no blockers and echoes the caller's facts", () => {
  const facts = { readyState: "complete", found: true, visible: true, enabled: true, stableSamples: 1 };
  const verdict = readinessFromProbe(facts);
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.blockers, []);
  assert.equal(verdict.observed, facts, "observed is the caller's own object, by reference");
});

test("a non-ready DOM blocks with exactly the failing gates, in gate order", () => {
  const verdict = readinessFromProbe({ readyState: "loading", found: true, visible: false, enabled: true });
  assert.equal(verdict.ready, false);
  assert.deepEqual(verdict.blockers, ["DOM_READY", "TARGET_VISIBLE"]);
  assert.equal(verdict.blockers.includes("TARGET_ENABLED"), false);
  assert.equal(verdict.blockers.includes("NAVIGATION_ACCEPTED"), false);
});

test("an empty probe is ready: absence of every fact is 'unknown ⇒ pass'", () => {
  const verdict = readinessFromProbe({});
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.blockers, []);
});

test("each gate blocks only on its own explicit failing fact", () => {
  // DOM_READY blocks on a present-but-not-complete readyState; undefined passes,
  // "complete" passes, "interactive" blocks.
  assert.deepEqual(readinessFromProbe({ readyState: undefined }).blockers, []);
  assert.deepEqual(readinessFromProbe({ readyState: "complete" }).blockers, []);
  assert.deepEqual(readinessFromProbe({ readyState: "interactive" }).blockers, ["DOM_READY"]);

  // TARGET_EXISTS / TARGET_VISIBLE / TARGET_ENABLED: false blocks, true and
  // undefined pass.
  assert.deepEqual(readinessFromProbe({ found: false }).blockers, ["TARGET_EXISTS"]);
  assert.deepEqual(readinessFromProbe({ found: true }).blockers, []);
  assert.deepEqual(readinessFromProbe({ visible: false }).blockers, ["TARGET_VISIBLE"]);
  assert.deepEqual(readinessFromProbe({ visible: true }).blockers, []);
  assert.deepEqual(readinessFromProbe({ enabled: false }).blockers, ["TARGET_ENABLED"]);
  assert.deepEqual(readinessFromProbe({ enabled: true }).blockers, []);

  // NAVIGATION_ACCEPTED: only an explicit rejection blocks.
  assert.deepEqual(readinessFromProbe({ navigationAccepted: false }).blockers, ["NAVIGATION_ACCEPTED"]);
  assert.deepEqual(readinessFromProbe({ navigationAccepted: true }).blockers, []);

  // TARGET_STABLE: fewer than 1 stable sample blocks; 0 blocks, 1 and 2 pass.
  assert.deepEqual(readinessFromProbe({ stableSamples: 0 }).blockers, ["TARGET_STABLE"]);
  assert.deepEqual(readinessFromProbe({ stableSamples: 1 }).blockers, []);
  assert.deepEqual(readinessFromProbe({ stableSamples: 2 }).blockers, []);
  assert.deepEqual(readinessFromProbe({ stableSamples: -1 }).blockers, ["TARGET_STABLE"]);

  // ACTION_ALLOWED never blocks — permission is the executor's gate.
  assert.deepEqual(readinessFromProbe({}).blockers, []);
  assert.equal(READINESS_GATES.at(-1), "ACTION_ALLOWED");
});

test("blockers accumulate in gate order across all seven gates at once", () => {
  const verdict = readinessFromProbe({
    readyState: "loading",
    found: false,
    visible: false,
    enabled: false,
    navigationAccepted: false,
    stableSamples: 0
  });
  assert.deepEqual(verdict.blockers, [
    "NAVIGATION_ACCEPTED", "DOM_READY", "TARGET_EXISTS", "TARGET_VISIBLE", "TARGET_ENABLED", "TARGET_STABLE"
  ]);
  assert.equal(verdict.ready, false);
});

test("post-action verification never assumes a change happened", () => {
  assert.equal(postActionVerified({}), false);
  assert.equal(postActionVerified({ changed: true }), true);
  assert.equal(postActionVerified({ changed: false }), false);
  assert.equal(postActionVerified({ expected: "QWEN-OK", text: "answer QWEN-OK" }), true);
  assert.equal(postActionVerified({ expected: "QWEN-OK", text: "no marker" }), false);
  // `changed` wins over `expected` when both are present.
  assert.equal(postActionVerified({ changed: true, expected: "nope", text: "other" }), true);
  assert.equal(postActionVerified({ changed: false, expected: "QWEN-OK", text: "answer QWEN-OK" }), false);
  // `expected` without `text` is NOT verified.
  assert.equal(postActionVerified({ expected: "QWEN-OK" }), false);
  // An empty expected string is still a present expected string, and every text
  // includes "".
  assert.equal(postActionVerified({ expected: "", text: "anything" }), true);
});

test("bounded escalation: bounded retry → selector refresh → alternate strategy", () => {
  assert.equal(escalationAfterFailure(0, 1), "BOUNDED_RETRY");
  assert.equal(escalationAfterFailure(1, 1), "SELECTOR_REFRESH");
  assert.equal(escalationAfterFailure(2, 1), "ALTERNATE_STRATEGY");
});

test("the retry bounds are the donor's arithmetic for every maxBoundedRetries", () => {
  for (const max of [0, 1, 2, 3]) {
    for (let attempts = 0; attempts <= max + 2; attempts += 1) {
      const expected = attempts < max ? "BOUNDED_RETRY" : attempts < max + 1 ? "SELECTOR_REFRESH" : "ALTERNATE_STRATEGY";
      assert.equal(escalationAfterFailure(attempts, max), expected, `attempts=${attempts} max=${max}`);
    }
  }
  // max = 0 means no bounded retry at all: a single refresh, then alternate.
  assert.equal(escalationAfterFailure(0, 0), "SELECTOR_REFRESH");
  assert.equal(escalationAfterFailure(1, 0), "ALTERNATE_STRATEGY");
  // The donor's declared "FAILED" is unreachable: the third branch is the floor.
  assert.equal(escalationAfterFailure(Number.MAX_SAFE_INTEGER, 1), "ALTERNATE_STRATEGY");
});
