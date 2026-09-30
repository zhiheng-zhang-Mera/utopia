/**
 * Donor-behaviour pin for the DOM semantic tier.
 *
 * Donor: `electron/computer/backends/dom-page.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. That file HAS a donor test
 * (`tests/unit/dom-page.test.ts`) whose every assertion is reproduced here by
 * value, minus the two that route through `SemanticRuntime` — the runtime owns a
 * durable-JSON state file and a clock-driven AbortController, so it is out of this
 * building's purity boundary and only its two action shapes are declared here as
 * doc-only typedefs. `DomPageBackend` itself is pure over the injected surface, so
 * everything the donor actually asserted about the backend is covered directly.
 *
 * Beyond the donor test this file pins: the readiness ladder's retry bound
 * (`readinessAttempts`), the retry interval's effect, the refusal that happens
 * instead of the action, the page-ref forwarding on probes, the emitted script
 * fixtures, and the preserved defects (malformed providerId rejecting `execute`,
 * `dom:null`, `read_page`'s missing `?? { ok: false }`, and verify_state's
 * undefined-expected short circuit).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { DOM_READS, DOM_MUTATIONS } from "../contracts.mjs";
import { DOM_TARGET_PREFIX, DomPageBackend, parseDomTarget } from "../dom-page.mjs";

/** A surface that answers every evaluate with one canned value and records calls. */
function surfaceOf(...answers) {
  const calls = [];
  let index = 0;
  const surface = {
    calls,
    async evaluate(script, page) {
      calls.push({ script, page });
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return typeof answer === "function" ? answer() : answer;
    }
  };
  return surface;
}

/** The donor's own abort signal usage: `new AbortController().signal`. */
const signal = () => new AbortController().signal;

/* ---------------------------------------------------------------- module constants */

test("DOM_TARGET_PREFIX is the donor's literal and the read/mutation sets are its neighbours", () => {
  assert.equal(DOM_TARGET_PREFIX, "dom:");
  assert.deepEqual([...DOM_MUTATIONS], ["click_control", "enter_text", "submit"]);
  assert.deepEqual([...DOM_READS], ["read_page", "verify_state"]);
});

/* ---------------------------------------------------------------- parseDomTarget */

test("parseDomTarget returns the parsed fields and undefined for non-dom or unparsable targets", () => {
  assert.deepEqual(parseDomTarget('dom:{"selector":"#send"}'), { providerId: undefined, selector: "#send", text: undefined });
  assert.deepEqual(parseDomTarget('dom:{"selector":"#send","providerId":"chatgpt"}'), { providerId: "chatgpt", selector: "#send", text: undefined });
  assert.deepEqual(parseDomTarget('dom:{"selector":"#send","providerId":"ok_1","text":"hi"}'), { providerId: "ok_1", selector: "#send", text: "hi" });
  assert.equal(parseDomTarget('uia:{"selector":"#send"}'), undefined);
  assert.equal(parseDomTarget("notepad"), undefined);
  assert.equal(parseDomTarget(""), undefined);
  assert.equal(parseDomTarget("dom:not json"), undefined);
  assert.equal(parseDomTarget("dom:"), undefined);
});

test("parseDomTarget throws on a malformed providerId and accepts the [a-zA-Z0-9_-] class", () => {
  for (const providerId of ["../escape", "a b", "a/b", "a.b", "ünicode", "chat gpt"]) {
    assert.throws(() => parseDomTarget(`dom:{"selector":"#s","providerId":${JSON.stringify(providerId)}}`), { message: "Invalid dom target providerId" }, providerId);
  }
  for (const providerId of ["ok_1", "chatgpt", "A-B_c9"]) {
    assert.equal(parseDomTarget(`dom:{"selector":"#s","providerId":${JSON.stringify(providerId)}}`).providerId, providerId);
  }
  // A non-string providerId fails the same regex test (numbers stringify through
  // the RegExp test, objects do not).
  assert.throws(() => parseDomTarget('dom:{"selector":"#s","providerId":{"a":1}}'), { message: "Invalid dom target providerId" });
});

/* ---------------------------------------------------------------- supports */

test("supports: dom: targets with a selector for mutations and reads, nothing else", () => {
  const backend = new DomPageBackend(surfaceOf({ ok: true }));
  assert.equal(backend.kind, "dom");
  assert.equal(backend.supports({ name: "click_control", target: 'dom:{"selector":"#send"}' }), true);
  assert.equal(backend.supports({ name: "enter_text", target: 'dom:{"selector":"#input"}' }), true);
  assert.equal(backend.supports({ name: "submit", target: 'dom:{"selector":"#input"}' }), true);
  assert.equal(backend.supports({ name: "read_page", target: 'dom:{"selector":"*"}' }), true);
  assert.equal(backend.supports({ name: "verify_state", target: 'dom:{"selector":"*"}' }), true);
  assert.equal(backend.supports({ name: "click_control", target: 'dom:{"selector":"#send","providerId":"chatgpt"}' }), true);
  // Unsupported action names.
  assert.equal(backend.supports({ name: "open_app", target: "notepad" }), false);
  assert.equal(backend.supports({ name: "focus_window", target: 'dom:{"selector":"#s"}' }), false);
  assert.equal(backend.supports({ name: "find_control", target: 'dom:{"selector":"#s"}' }), false);
  assert.equal(backend.supports({ name: "wait_for_state", target: 'dom:{"selector":"#s"}' }), false);
  // Unsupported targets.
  assert.equal(backend.supports({ name: "click_control", target: 'uia:{"processId":1}' }), false);
  assert.equal(backend.supports({ name: "click_control", target: 'dom:{"providerId":"chatgpt"}' }), false, "no selector");
  assert.equal(backend.supports({ name: "click_control", target: 'dom:{"selector":""}' }), false, "empty selector");
  assert.equal(backend.supports({ name: "click_control", target: "dom:not json" }), false);
});

test("supports does not throw on a malformed providerId (the parse it uses is the lenient one)", () => {
  // `supports` calls the donor's private `parseTarget`, not `parseDomTarget`, so the
  // providerId regex never runs there. The throw happens only in `execute`.
  const backend = new DomPageBackend(surfaceOf({ ok: true }));
  assert.equal(backend.supports({ name: "click_control", target: 'dom:{"selector":"#s","providerId":"../escape"}' }), true);
  assert.throws(() => parseDomTarget('dom:{"selector":"#s","providerId":"../escape"}'), { message: "Invalid dom target providerId" });
});

/* ---------------------------------------------------------------- readiness script */

test("readinessScript is the donor's probe: found / visible / enabled / stableSamples from the live page", () => {
  const backend = new DomPageBackend(surfaceOf({ ok: true }));
  const script = backend.readinessScript("#prompt");
  assert.equal(typeof script, "string");
  assert.match(script, /^\(\(\) => \{/);
  assert.match(script, /document\.querySelector\("#prompt"\)/);
  assert.match(script, /getBoundingClientRect\(\)/);
  assert.match(script, /window\.getComputedStyle\(el\)/);
  assert.match(script, /HTMLButtonElement/);
  assert.match(script, /HTMLInputElement/);
  assert.match(script, /HTMLTextAreaElement/);
  assert.match(script, /HTMLSelectElement/);
  assert.match(script, /el\.disabled === true/);
  assert.match(script, /rect\.width > 0 && rect\.height > 0/);
  assert.match(script, /style\.visibility !== "hidden" && style\.display !== "none"/);
  assert.match(script, /stableSamples: 1/);
  assert.match(script, /readyState: document\.readyState/);
  assert.match(script, /if \(!el\) return \{ ok: false, found: false, readyState: document\.readyState \}/);
  // The selector is JSON-embedded, so a quote cannot break out of the script.
  assert.match(backend.readinessScript('a"b'), /document\.querySelector\("a\\"b"\)/);
});

/* ---------------------------------------------------------------- readiness retry bound */

test("readyOrBlocked returns null when the first probe is ready and probes exactly once", async () => {
  const surface = surfaceOf({ readyState: "complete", found: true, visible: true, enabled: true, stableSamples: 1 });
  const backend = new DomPageBackend(surface, { preflightReadiness: true, readinessAttempts: 3, readinessIntervalMs: 0 });
  assert.equal(await backend.readyOrBlocked("#prompt", undefined), null);
  assert.equal(surface.calls.length, 1);
  assert.equal(surface.calls[0].page, undefined);
});

test("readyOrBlocked uses the donor's default of 2 attempts and reports the last block reason", async () => {
  const surface = surfaceOf({ readyState: "loading", found: false });
  const backend = new DomPageBackend(surface, { readinessIntervalMs: 0 });
  assert.equal(await backend.readyOrBlocked("#prompt", undefined), "readiness blocked: DOM_READY, TARGET_EXISTS");
  assert.equal(surface.calls.length, 2, "the donor's default readinessAttempts is 2");
});

test("readinessAttempts is honoured as a lower bound of 1, and the retry stops as soon as a probe is ready", async () => {
  const never = surfaceOf({ readyState: "loading" });
  assert.equal(await new DomPageBackend(never, { readinessAttempts: 5, readinessIntervalMs: 0 }).readyOrBlocked("#s", undefined), "readiness blocked: DOM_READY");
  assert.equal(never.calls.length, 5);
  // Math.max(1, attempts): 0 and -1 both mean one attempt.
  const zero = surfaceOf({ readyState: "loading" });
  assert.equal(await new DomPageBackend(zero, { readinessAttempts: 0, readinessIntervalMs: 0 }).readyOrBlocked("#s", undefined), "readiness blocked: DOM_READY");
  assert.equal(zero.calls.length, 1);
  // A probe that becomes ready on the third attempt stops there.
  let n = 0;
  const flaky = {
    calls: [],
    async evaluate(script, page) {
      flaky.calls.push({ script, page });
      n += 1;
      return n < 3 ? { readyState: "loading" } : { readyState: "complete", found: true, visible: true, enabled: true, stableSamples: 1 };
    }
  };
  assert.equal(await new DomPageBackend(flaky, { readinessAttempts: 5, readinessIntervalMs: 0 }).readyOrBlocked("#s", undefined), null);
  assert.equal(flaky.calls.length, 3);
});

test("a null/undefined probe answer is treated as no facts, which is ready ('unknown ⇒ pass')", async () => {
  const surface = surfaceOf(null);
  const backend = new DomPageBackend(surface, { readinessAttempts: 2, readinessIntervalMs: 0 });
  assert.equal(await backend.readyOrBlocked("#s", undefined), null);
  assert.equal(surface.calls.length, 1);
});

test("the retry interval only delays when it is positive, and the page ref reaches every probe", async () => {
  const blocked = surfaceOf({ readyState: "loading" });
  const started = Date.now();
  await new DomPageBackend(blocked, { readinessAttempts: 2, readinessIntervalMs: 0 }).readyOrBlocked("#s", { providerId: "chatgpt" });
  assert.ok(Date.now() - started < 1000, "interval 0 must not wait for the donor's 200 ms default");
  assert.deepEqual(blocked.calls.map((call) => call.page), [{ providerId: "chatgpt" }, { providerId: "chatgpt" }]);
  // A positive, tiny interval is injected by the caller; the donor's own timer runs.
  const tiny = surfaceOf({ readyState: "loading" });
  const before = Date.now();
  await new DomPageBackend(tiny, { readinessAttempts: 2, readinessIntervalMs: 5 }).readyOrBlocked("#s", undefined);
  assert.ok(Date.now() - before >= 4, "a positive interval really waits");
  assert.equal(tiny.calls.length, 2);
});

/* ---------------------------------------------------------------- execute */

test("execute refuses an action without a dom: selector", async () => {
  const backend = new DomPageBackend(surfaceOf({ ok: true }));
  assert.deepEqual(await backend.execute({ name: "read_page", target: "notepad" }, signal()), {
    status: "UNSUPPORTED",
    message: "DOM action requires dom: target with a selector (got notepad)"
  });
  assert.equal((await backend.execute({ name: "read_page", target: 'dom:{"providerId":"x"}' }, signal())).status, "UNSUPPORTED");
  // The donor truncates the offending target to 60 characters.
  const long = "uia:" + "x".repeat(100);
  assert.equal((await backend.execute({ name: "read_page", target: long }, signal())).message, `DOM action requires dom: target with a selector (got ${long.slice(0, 60)})`);
});

test("execute reports a supported-but-unhandled action as UNSUPPORTED", async () => {
  // Only the five implemented action names are handled inside the try; every other
  // name reaches the donor's final UNSUPPORTED return.
  const backend = new DomPageBackend(surfaceOf({ ok: true }));
  assert.deepEqual(await backend.execute({ name: "find_control", target: 'dom:{"selector":"#s"}' }, signal()), {
    status: "UNSUPPORTED",
    message: "DOM backend does not support find_control"
  });
  assert.deepEqual(await backend.execute({ name: "wait_for_state", target: 'dom:{"selector":"#s"}' }, signal()), {
    status: "UNSUPPORTED",
    message: "DOM backend does not support wait_for_state"
  });
});

test("click_control reports SUCCESS on ok and FAILED with the surface's reason otherwise", async () => {
  const found = new DomPageBackend(surfaceOf({ ok: true }));
  assert.deepEqual(await found.execute({ name: "click_control", target: 'dom:{"selector":"#send"}' }, signal()), { status: "SUCCESS" });
  const missing = new DomPageBackend(surfaceOf({ ok: false, reason: "not-found" }));
  assert.deepEqual(await missing.execute({ name: "click_control", target: 'dom:{"selector":"#send"}' }, signal()), { status: "FAILED", message: "not-found" });
  // `?? { ok: false }` covers a null answer, and the default message is "click failed".
  const nulled = new DomPageBackend(surfaceOf(null));
  assert.deepEqual(await nulled.execute({ name: "click_control", target: 'dom:{"selector":"#send"}' }, signal()), { status: "FAILED", message: "click failed" });
});

test("enter_text reports the donor's three outcomes: sent, not-found, unsupported-element", async () => {
  const sent = new DomPageBackend(surfaceOf({ ok: true }));
  assert.deepEqual(await sent.execute({ name: "enter_text", target: 'dom:{"selector":"#prompt"}', value: "hi" }, signal()), { status: "SUCCESS" });
  const missing = new DomPageBackend(surfaceOf({ ok: false, reason: "not-found" }));
  assert.deepEqual(await missing.execute({ name: "enter_text", target: 'dom:{"selector":"#prompt"}', value: "hi" }, signal()), { status: "FAILED", message: "not-found" });
  const bad = new DomPageBackend(surfaceOf({ ok: false, reason: "unsupported-element" }));
  assert.deepEqual(await bad.execute({ name: "enter_text", target: 'dom:{"selector":"#prompt"}', value: "hi" }, signal()), { status: "FAILED", message: "unsupported-element" });
  const nulled = new DomPageBackend(surfaceOf(null));
  assert.deepEqual(await nulled.execute({ name: "enter_text", target: 'dom:{"selector":"#prompt"}' }, signal()), { status: "FAILED", message: "enter_text failed" });
});

test("submit reports SUCCESS on ok and FAILED with the surface's reason otherwise", async () => {
  const ok = new DomPageBackend(surfaceOf({ ok: true }));
  assert.deepEqual(await ok.execute({ name: "submit", target: 'dom:{"selector":"#prompt"}' }, signal()), { status: "SUCCESS" });
  const bad = new DomPageBackend(surfaceOf({ ok: false, reason: "not-found" }));
  assert.deepEqual(await bad.execute({ name: "submit", target: 'dom:{"selector":"#prompt"}' }, signal()), { status: "FAILED", message: "not-found" });
  const nulled = new DomPageBackend(surfaceOf(null));
  assert.deepEqual(await nulled.execute({ name: "submit", target: 'dom:{"selector":"#prompt"}' }, signal()), { status: "FAILED", message: "submit failed" });
});

test("read_page returns the text as evidence", async () => {
  const surface = surfaceOf({ ok: true, text: "saved: ok" });
  const backend = new DomPageBackend(surface);
  assert.deepEqual(await backend.execute({ name: "read_page", target: 'dom:{"selector":"body"}' }, signal()), { status: "SUCCESS", evidence: { text: "saved: ok" } });
  // A missing text field becomes the empty string.
  const noText = new DomPageBackend(surfaceOf({ ok: true }));
  assert.deepEqual(await noText.execute({ name: "read_page", target: 'dom:{"selector":"body"}' }, signal()), { status: "SUCCESS", evidence: { text: "" } });
  const failing = new DomPageBackend(surfaceOf({ ok: false, reason: "read failed" }));
  assert.deepEqual(await failing.execute({ name: "read_page", target: 'dom:{"selector":"body"}' }, signal()), { status: "FAILED", message: "read failed" });
});

test("DEFECT PINNED: read_page lacks the `?? { ok: false }` guard the other branches have", async () => {
  // Every other branch coalesces a null surface answer; read_page does not, so it
  // reports the donor's generic "read failed" instead of the branch's own default.
  for (const answer of [null, undefined]) {
    const backend = new DomPageBackend(surfaceOf(answer));
    assert.deepEqual(await backend.execute({ name: "read_page", target: 'dom:{"selector":"body"}' }, signal()), { status: "FAILED", message: "read failed" });
  }
});

test("verify_state checks expected ?? value against the page text", async () => {
  const hit = new DomPageBackend(surfaceOf({ ok: true, text: "answer: saved: ok" }));
  assert.deepEqual(await hit.execute({ name: "verify_state", target: 'dom:{"selector":"body"}', expected: "saved: ok" }, signal()), { status: "SUCCESS", evidence: { verified: true } });
  const miss = new DomPageBackend(surfaceOf({ ok: true, text: "nothing here" }));
  assert.deepEqual(await miss.execute({ name: "verify_state", target: 'dom:{"selector":"body"}', expected: "saved: ok" }, signal()), { status: "FAILED", message: "expected state not found: saved: ok" });
  // `expected` wins over `value` when both are present.
  const both = new DomPageBackend(surfaceOf({ ok: true, text: "value-text" }));
  assert.equal((await both.execute({ name: "verify_state", target: 'dom:{"selector":"body"}', expected: "nope", value: "value-text" }, signal())).status, "FAILED");
  // A null surface answer reads as empty text and therefore fails a named expectation.
  const nulled = new DomPageBackend(surfaceOf(null));
  assert.deepEqual(await nulled.execute({ name: "verify_state", target: 'dom:{"selector":"body"}', expected: "x" }, signal()), { status: "FAILED", message: "expected state not found: x" });
});

test("DEFECT PINNED: verify_state with no expected AND no value is a free SUCCESS", async () => {
  // `expected === undefined` short-circuits `found` to true, so a verify with no
  // expectation is reported as verified without reading anything meaningful.
  const backend = new DomPageBackend(surfaceOf(null));
  assert.deepEqual(await backend.execute({ name: "verify_state", target: 'dom:{"selector":"body"}' }, signal()), { status: "SUCCESS", evidence: { verified: true } });
  // An empty-string value is NOT undefined, so it takes the real comparison path.
  assert.equal((await backend.execute({ name: "verify_state", target: 'dom:{"selector":"body"}', value: "" }, signal())).status, "SUCCESS", "every text includes the empty string");
});

test("scripts embed JSON-escaped selectors and values, so nothing can break out", async () => {
  const surface = surfaceOf({ ok: true }, { ok: true }, { ok: true, text: "t" }, { ok: true, text: "t" });
  const backend = new DomPageBackend(surface);
  await backend.execute({ name: "click_control", target: 'dom:{"selector":"#send"}' }, signal());
  await backend.execute({ name: "enter_text", target: 'dom:{"selector":"#prompt"}', value: 'a"b' }, signal());
  await backend.execute({ name: "submit", target: 'dom:{"selector":"#prompt"}' }, signal());
  await backend.execute({ name: "read_page", target: 'dom:{"selector":"body"}' }, signal());

  const click = surface.calls[0].script;
  assert.equal(click, '(() => { const el = document.querySelector("#send"); if (!el) return { ok: false, reason: "not-found" }; el.click(); return { ok: true }; })()');
  const enter = surface.calls[1].script;
  assert.match(enter, /document\.querySelector\("#prompt"\)/);
  assert.match(enter, /Object\.getOwnPropertyDescriptor\(window\.HTMLInputElement\.prototype, "value"\)\?\.set/);
  assert.match(enter, /Object\.getOwnPropertyDescriptor\(window\.HTMLTextAreaElement\.prototype, "value"\)\?\.set/);
  assert.match(enter, /setter\.call\(el, "a\\"b"\)/, "the value is JSON-escaped, not interpolated raw");
  assert.doesNotMatch(enter, /setter\.call\(el, "a"b"\)/, "the raw quote never reaches the script unescaped");
  assert.match(enter, /new Event\("input", \{ bubbles: true \}\)/);
  assert.match(enter, /new Event\("change", \{ bubbles: true \}\)/);
  assert.match(enter, /el\.isContentEditable/);
  assert.match(enter, /reason: "unsupported-element"/);
  const submit = surface.calls[2].script;
  assert.match(submit, /document\.querySelector\("#prompt"\) \|\| document\.activeElement/);
  assert.match(submit, /new KeyboardEvent\("keydown", \{ key: "Enter", code: "Enter", bubbles: true, cancelable: true \}\)/);
  assert.match(submit, /new KeyboardEvent\("keyup", \{ key: "Enter", code: "Enter", bubbles: true, cancelable: true \}\)/);
  const read = surface.calls[3].script;
  assert.equal(read, '(() => ({ ok: true, text: (document.body?.innerText ?? "").slice(0, 30000) }))()');
  // A missing value on enter_text becomes the empty string, never `undefined`.
  const empty = surfaceOf({ ok: true });
  await new DomPageBackend(empty).execute({ name: "enter_text", target: 'dom:{"selector":"#p"}' }, signal());
  assert.match(empty.calls[0].script, /setter\.call\(el, ""\)/);
});

test("a dom: providerId is forwarded to the page surface, and a provider-less target sends no page ref", async () => {
  const surface = surfaceOf({ ok: true }, { ok: true });
  const backend = new DomPageBackend(surface);
  await backend.execute({ name: "click_control", target: 'dom:{"selector":"#send","providerId":"chatgpt"}' }, signal());
  await backend.execute({ name: "read_page", target: 'dom:{"selector":"body","providerId":"gemini"}' }, signal());
  assert.deepEqual(surface.calls.map((call) => call.page), [{ providerId: "chatgpt" }, { providerId: "gemini" }]);
  assert.equal(surface.calls[0].page.providerId, "chatgpt");
  // No providerId → the page argument is undefined, as the donor's own test asserts.
  const plain = surfaceOf({ ok: false, reason: "not-found" });
  await new DomPageBackend(plain).execute({ name: "click_control", target: 'dom:{"selector":"#send"}' }, signal());
  assert.equal(plain.calls[0].page, undefined);
});

test("a surface that rejects is caught and truncated to 300 characters", async () => {
  const rejecting = {
    async evaluate() {
      throw new Error("boom " + "x".repeat(400));
    }
  };
  const result = await new DomPageBackend(rejecting).execute({ name: "click_control", target: 'dom:{"selector":"#s"}' }, signal());
  assert.equal(result.status, "FAILED");
  assert.equal(result.message.length, 300);
  assert.match(result.message, /^Error: boom x/);
});

test("DEFECT PINNED: an invalid providerId rejects execute() instead of returning FAILED", async () => {
  // `parseDomTarget` is called OUTSIDE execute()'s try/catch, so its throw escapes
  // the promise. The donor's own test asserts this rejection; it is preserved.
  const backend = new DomPageBackend(surfaceOf({ ok: true }));
  await assert.rejects(() => backend.execute({ name: "click_control", target: 'dom:{"selector":"#send","providerId":"../escape"}' }, signal()), { message: "Invalid dom target providerId" });
  assert.equal((await backend.execute({ name: "click_control", target: 'dom:{"selector":"#send","providerId":"ok_1"}' }, signal())).status, "SUCCESS");
});

test("DEFECT PINNED: a JSON scalar in a dom: target destructures to all-undefined, and null is UNSUPPORTED", async () => {
  // `parseTarget` returns whatever JSON.parse produced. `null` is falsy, so
  // `parseDomTarget` returns undefined and execute answers UNSUPPORTED — the
  // destructuring is never reached. A JSON scalar (number/string) is NOT falsy, so it
  // reaches the destructuring, which boxes it and yields three undefined fields: the
  // target is then reported as "no selector" rather than as malformed. The donor's
  // `parseDomTarget` never throws a TypeError; only the providerId regex throws.
  const backend = new DomPageBackend(surfaceOf({ ok: true }));
  assert.deepEqual(await backend.execute({ name: "click_control", target: "dom:null" }, signal()), {
    status: "UNSUPPORTED",
    message: 'DOM action requires dom: target with a selector (got dom:null)'
  });
  assert.equal((await backend.execute({ name: "click_control", target: "dom:123" }, signal())).status, "UNSUPPORTED");
  assert.equal((await backend.execute({ name: "click_control", target: 'dom:"#send"' }, signal())).status, "UNSUPPORTED", "a bare string carries no selector field");
  assert.equal((await backend.execute({ name: "click_control", target: "dom:[1,2]" }, signal())).status, "UNSUPPORTED", "an array has no selector field");
  assert.equal((await backend.execute({ name: "click_control", target: 'dom:["#send"]' }, signal())).status, "UNSUPPORTED", "even with a selector-looking element, the donor reads fields, not shapes");
  assert.equal((await backend.execute({ name: "click_control", target: 'dom:{"selector":"#send"}' }, signal())).status, "SUCCESS");
});

/* ---------------------------------------------------------------- preflight readiness */

test("preflightReadiness is OFF by default: a mutation proceeds without any probe", async () => {
  const surface = surfaceOf({ ok: true });
  await new DomPageBackend(surface).execute({ name: "click_control", target: 'dom:{"selector":"#send"}' }, signal());
  assert.equal(surface.calls.length, 1, "only the action script ran");
  assert.match(surface.calls[0].script, /el\.click\(\)/);
});

test("preflightReadiness probes before a mutation and refuses it while the page is not ready", async () => {
  const alwaysNotReady = surfaceOf({ readyState: "loading", found: false });
  const backend = new DomPageBackend(alwaysNotReady, { preflightReadiness: true, readinessAttempts: 2, readinessIntervalMs: 0 });
  const result = await backend.execute({ name: "click_control", target: 'dom:{"selector":"#send"}' }, signal());
  assert.deepEqual(result, { status: "FAILED", message: "readiness blocked: DOM_READY, TARGET_EXISTS" });
  assert.equal(alwaysNotReady.calls.length, 2, "two probes and NO click script");
  for (const call of alwaysNotReady.calls) assert.match(call.script, /getBoundingClientRect/);
});

test("preflightReadiness lets a ready page through and then performs the action", async () => {
  const surface = surfaceOf({ readyState: "complete", found: true, visible: true, enabled: true, stableSamples: 1 }, { ok: true });
  const backend = new DomPageBackend(surface, { preflightReadiness: true, readinessAttempts: 2, readinessIntervalMs: 0 });
  assert.deepEqual(await backend.execute({ name: "enter_text", target: 'dom:{"selector":"#prompt"}', value: "hi" }, signal()), { status: "SUCCESS" });
  assert.equal(surface.calls.length, 2);
  assert.match(surface.calls[0].script, /getComputedStyle/);
  assert.match(surface.calls[1].script, /setter\.call\(el, "hi"\)/);
});

test("preflightReadiness applies to the three mutations only, never to a read", async () => {
  for (const name of ["click_control", "enter_text", "submit"]) {
    const surface = surfaceOf({ readyState: "loading", found: false });
    const backend = new DomPageBackend(surface, { preflightReadiness: true, readinessAttempts: 1, readinessIntervalMs: 0 });
    const result = await backend.execute({ name, target: 'dom:{"selector":"#s"}' }, signal());
    assert.equal(result.status, "FAILED", name);
    assert.equal(surface.calls.length, 1, `${name} probed once and stopped`);
  }
  for (const name of ["read_page", "verify_state"]) {
    const surface = surfaceOf({ ok: true, text: "t" });
    const backend = new DomPageBackend(surface, { preflightReadiness: true, readinessAttempts: 1, readinessIntervalMs: 0 });
    assert.equal((await backend.execute({ name, target: 'dom:{"selector":"#s"}' }, signal())).status, "SUCCESS", name);
    assert.equal(surface.calls.length, 1, `${name} was not probed`);
    assert.doesNotMatch(surface.calls[0].script, /getBoundingClientRect/);
  }
});

test("the preflight probe carries the target's provider page ref", async () => {
  const surface = surfaceOf({ readyState: "loading", found: false });
  const backend = new DomPageBackend(surface, { preflightReadiness: true, readinessAttempts: 1, readinessIntervalMs: 0 });
  await backend.execute({ name: "submit", target: 'dom:{"selector":"#s","providerId":"chatgpt"}' }, signal());
  assert.deepEqual(surface.calls[0].page, { providerId: "chatgpt" });
});

test("the abort signal is accepted and ignored, exactly as the donor does", async () => {
  const controller = new AbortController();
  controller.abort();
  const surface = surfaceOf({ ok: true });
  const backend = new DomPageBackend(surface);
  assert.deepEqual(await backend.execute({ name: "click_control", target: 'dom:{"selector":"#s"}' }, controller.signal), { status: "SUCCESS" });
  assert.deepEqual(await backend.execute({ name: "click_control", target: 'dom:{"selector":"#s"}' }), { status: "SUCCESS" }, "even an omitted signal");
});
