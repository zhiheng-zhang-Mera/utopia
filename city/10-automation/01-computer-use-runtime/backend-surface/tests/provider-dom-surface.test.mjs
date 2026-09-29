/**
 * Donor-behaviour pin for the production DOM page surface wiring.
 *
 * Donor: `electron/computer/backends/provider-dom-surface.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. That file HAS a donor test
 * (`tests/unit/provider-dom-surface.test.ts`) whose every assertion is reproduced
 * here by value. This file adds the checks the donor test skipped: the lookup is
 * performed freshly per call, `executeJavaScript` receives the script verbatim, no
 * extra argument is passed, and the two preserved message defects (the promised but
 * absent single-pane disambiguation, and the indistinguishable "closed" vs "never
 * existed" case).
 *
 * Both of the donor's edges are `import type` only and are erased, so this port
 * injects the view accessor exactly as the donor does — the test's fakes are the
 * donor test's fakes.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { providerDomSurface } from "../provider-dom-surface.mjs";

/** A fake provider pane (the donor test's FakeView). */
function page(id, executeJavaScript, { destroyed = false, crashed = false } = {}) {
  return { webContents: { id, isDestroyed: () => destroyed, isCrashed: () => crashed, executeJavaScript } };
}

/** A fake `views()` accessor over a fixed map (the donor test's fakeViews). */
function fakeViews(pages) {
  return () => ({ get: (id) => pages[id] });
}

test("evaluates scripts on the named provider WebContentsView and returns its value", async () => {
  const scripts = [];
  const views = fakeViews({ chatgpt: page(1, async (script) => { scripts.push(script); return "page-text"; }) });
  const surface = providerDomSurface(views);
  assert.equal(await surface.evaluate("1+1", { providerId: "chatgpt" }), "page-text");
  assert.deepEqual(scripts, ["1+1"], "the script reaches executeJavaScript verbatim");
});

test("fails closed when the provider pane is closed, crashed, or the target is ambiguous", async () => {
  const views = fakeViews({
    closed: page(2, async () => "nope", { destroyed: true }),
    crashed: page(3, async () => "nope", { crashed: true })
  });
  const surface = providerDomSurface(views);
  await assert.rejects(() => surface.evaluate("1", { providerId: "closed" }), /^Error: Provider page is not open: closed$/);
  await assert.rejects(() => surface.evaluate("1", { providerId: "crashed" }), /^Error: Provider page crashed: crashed$/);
  // No providerId → ambiguous by design (never a silent guess).
  await assert.rejects(() => surface.evaluate("1"), /^Error: DOM action requires a dom: providerId \(or exactly one open provider page to disambiguate\)$/);
});

test("a providerId that was never open reports the same 'not open' message as a closed one", async () => {
  let asked = [];
  const views = () => ({ get: (id) => { asked.push(id); return undefined; } });
  const surface = providerDomSurface(views);
  await assert.rejects(() => surface.evaluate("1", { providerId: "never" }), /^Error: Provider page is not open: never$/);
  assert.deepEqual(asked, ["never"], "the accessor is consulted once per call");
});

test("a destroyed pane short-circuits before the crash check", async () => {
  // `isCrashed()` is never consulted for a destroyed pane: the destroyed check
  // returns first, so a crashed-and-destroyed pane reports "not open".
  let crashChecks = 0;
  const both = {
    webContents: {
      id: 4,
      isDestroyed: () => true,
      isCrashed: () => { crashChecks += 1; return true; },
      executeJavaScript: async () => "nope"
    }
  };
  const surface = providerDomSurface(fakeViews({ both }));
  await assert.rejects(() => surface.evaluate("1", { providerId: "both" }), /not open/);
  assert.equal(crashChecks, 0);
});

test("returns real page content when the named provider pane is open", async () => {
  const views = fakeViews({ chatgpt: page(1, async () => ({ ok: true, text: "visible" })) });
  const surface = providerDomSurface(views);
  const result = await surface.evaluate("(() => ({ ok: true, text: document.body.innerText }))()", { providerId: "chatgpt" });
  assert.equal(result.ok, true);
  assert.equal(result.text, "visible");
});

test("the accessor is called freshly per lookup, so a pane that opens later is found", async () => {
  let opened = false;
  const views = () => ({ get: (id) => (opened && id === "chatgpt" ? page(1, async () => "fresh") : undefined) });
  const surface = providerDomSurface(views);
  await assert.rejects(() => surface.evaluate("1", { providerId: "chatgpt" }), /not open/);
  opened = true;
  assert.equal(await surface.evaluate("1", { providerId: "chatgpt" }), "fresh");
});

test("only the script reaches executeJavaScript, with no extra argument", async () => {
  const calls = [];
  const views = fakeViews({ chatgpt: page(1, async (...args) => { calls.push(args); return "ok"; }) });
  const surface = providerDomSurface(views);
  assert.equal(await surface.evaluate("script", { providerId: "chatgpt" }), "ok");
  // The page ref is consumed by viewFor, never forwarded to the renderer.
  assert.deepEqual(calls, [["script"]]);
  const { DomPageBackend } = await import("../dom-page.mjs");
  await new DomPageBackend(surface).execute({ name: "read_page", target: 'dom:{"selector":"body","providerId":"chatgpt"}' }, new AbortController().signal);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].length, 1);
  assert.match(calls[1][0], /document\.body\?\.innerText/);
});

test("a rejecting executeJavaScript propagates unchanged", async () => {
  const views = fakeViews({ chatgpt: page(1, async () => { throw new Error("ipc down"); }) });
  const surface = providerDomSurface(views);
  await assert.rejects(() => surface.evaluate("1", { providerId: "chatgpt" }), /^Error: ipc down$/);
});

test("the composed surface drives the DOM backend end to end over a fake pane", async () => {
  // The donor's two modules are wired together by nothing in this building — the
  // semantic runtime that used to do it is deferred — so this pins the composition
  // itself: DomPageBackend's script reaches the named pane through
  // providerDomSurface and the pane's answer is the backend's verdict.
  const scripts = [];
  const views = fakeViews({ chatgpt: page(1, async (script) => { scripts.push(script); return { ok: true, text: "page says hi" }; }) });
  const surface = providerDomSurface(views);
  const { DomPageBackend } = await import("../dom-page.mjs");
  const backend = new DomPageBackend(surface);
  const result = await backend.execute({ name: "read_page", target: 'dom:{"selector":"body","providerId":"chatgpt"}' }, new AbortController().signal);
  assert.deepEqual(result, { status: "SUCCESS", evidence: { text: "page says hi" } });
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0], '(() => ({ ok: true, text: (document.body?.innerText ?? "").slice(0, 30000) }))()');
});
