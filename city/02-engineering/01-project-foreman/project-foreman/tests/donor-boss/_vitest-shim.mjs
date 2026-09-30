/**
 * UTOPIA · City · Project Foreman — the assertion surface the donor tests use.
 *
 * The donor covering tests below (`tests/donor-boss/*.test.mjs`, copied from
 * `Codex-Boss` @ 8df428eaa437a409368401e95194e40266b83080) are written for
 * `vitest`'s `describe`/`it`/`expect`. The port must keep their test bodies,
 * titles and assertions byte-identical — only the import specifier may change —
 * so rather than rewrite 26 assertions into `node:assert` calls (or weaken the
 * `toThrow(/.../)` cases, whose argument is a regex and not a string) this file
 * re-implements exactly the matchers those tests call, in strict form, on top of
 * `node:assert/strict` and `node:test`. Nothing here is a production seam: it is
 * a test-only adapter, and an unimplemented matcher throws instead of passing.
 *
 * Vitest semantics preserved on purpose:
 *  * `toBe`/`toEqual`/`toContain` delegate to Node's strict deep equality, which
 *    is equal-or-stricter than vitest's for the plain data these tests use;
 *  * `toThrow(/re/)` matches the thrown error's `message` (vitest's fallback),
 *    and a non-throwing call fails;
 *  * `at(-1)` on arrays is the donor's own use of standard ES2022, not a matcher.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

export { describe, it };

/** `expect(actual)` — the donor tests' only entry point. */
export function expect(actual) {
  return {
    /** Strict identity, as vitest's `toBe` for primitives; deep-equal for objects. */
    toBe(expected) {
      assert.deepStrictEqual(actual, expected);
    },
    /** Structural equality. */
    toEqual(expected) {
      assert.deepStrictEqual(actual, expected);
    },
    toBeUndefined() {
      assert.strictEqual(actual, undefined);
    },
    toBeGreaterThanOrEqual(expected) {
      assert.ok(actual >= expected, `expected ${actual} >= ${expected}`);
    },
    toBeLessThan(expected) {
      assert.ok(actual < expected, `expected ${actual} < ${expected}`);
    },
    toContain(expected) {
      assert.ok(actual.includes(expected), `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`);
    },
    /**
     * The donor passes a regex (vitest tests it against the error message); a
     * string is matched against the message too, which is the stricter reading.
     * Anything else, or a call that does not throw, is a failure.
     */
    toThrow(expected) {
      assert.strictEqual(typeof actual, 'function', 'toThrow needs a function');
      let thrown;
      let threw = false;
      try {
        actual();
      } catch (error) {
        threw = true;
        thrown = error;
      }
      if (!threw) assert.fail(`expected the call to throw ${String(expected)}`);
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      if (expected instanceof RegExp) {
        assert.ok(expected.test(message), `expected thrown message ${JSON.stringify(message)} to match ${String(expected)}`);
        return;
      }
      if (typeof expected === 'string') {
        assert.ok(message.includes(expected), `expected thrown message ${JSON.stringify(message)} to include ${JSON.stringify(expected)}`);
        return;
      }
      assert.fail(`toThrow needs a RegExp or a string, got ${String(expected)}`);
    },
  };
}
