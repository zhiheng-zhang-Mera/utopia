/**
 * UTOPIA · 10-automation / Computer Use Runtime — DOM page backend.
 *
 * Donor: `electron/computer/backends/dom-page.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. Pure over an injected surface and
 * unchanged in behaviour.
 *
 * DOM tier of the §8.2 semantic chain: executes click_control / enter_text /
 * submit (and read_page / verify_state) over a visible web page through an
 * injected page surface (production: a provider WebContentsView; tests: a fake
 * evaluator). Targets use the `dom:` prefix with a JSON body, e.g.
 * `dom:{"selector":"#prompt-textarea"}`. Scripts are built from JSON.stringify so
 * selectors/text can never break out of the evaluated script.
 *
 * The donor's `../semantic-runtime` edge is `import type` only and is erased; the
 * shapes this file names (`SemanticAction`, `SemanticBackend`, `SemanticResult`)
 * are declared as typedefs in `./contracts.mjs`, and nothing from the deferred
 * runtime is ported. The two `readinessFromProbe` imports come from
 * `../../src/shared/action-readiness` in the donor and from `./action-readiness.mjs`
 * here — same module, same behaviour.
 *
 * Injections carried over from the donor (recorded in DONOR.json):
 *   - `DomPageSurface.evaluate<T>(script, page?)` is the donor's own injected page
 *     surface; production supplies Electron's `webContents.executeJavaScript`. This
 *     module never evaluates a script itself.
 *   - `DomBackendOptions.readinessIntervalMs` (donor default 200 ms) is the donor's
 *     own injectable bound on the readiness retry `setTimeout`. Tests pass `0`, which
 *     the donor's `interval > 0` guard already turns into "no timer at all", so the
 *     bounded retry stays real and the suite stays fast. `readinessAttempts`
 *     (donor default 2) is injected the same way.
 *
 * Preserved donor defects (pinned by tests, not repaired):
 *   (a) `parseDomTarget`'s providerId check THROWS, and `execute()` calls it at
 *       line 105 — OUTSIDE its own try/catch (which opens at line 109). A malformed
 *       `providerId` therefore rejects `execute()` instead of returning a FAILED
 *       result; a `dom:null` target instead throws inside the try and is reported as
 *       `FAILED: TypeError: …`. Both are pinned rather than normalised.
 *   (b) `parseTarget` accepts any JSON value; `null` reaches the object destructuring
 *       in `parseDomTarget` and throws, while a JSON scalar (`dom:123`) destructures
 *       to all-undefined and is reported as a missing selector.
 *   (c) `read_page` does `outcome?.ok ? … : FAILED`, so a surface that resolves to
 *       `null`/`undefined` reports "read failed" — the `?? { ok: false }` that every
 *       other branch uses is absent there.
 *   (d) `verify_state` treats an absent `expected` AND absent `value` as verified:
 *       `expected === undefined` short-circuits `found` to true.
 *   (e) `execute`'s `_signal` parameter is accepted and never read — cancellation is
 *       the caller's/the runtime's concern, not this tier's. Kept as a parameter.
 *
 * This module is pure: no filesystem, no network, no clock, no randomness, no
 * environment. The only asynchronous primitive is the optional readiness retry
 * timer described above.
 */

import { readinessFromProbe } from "./action-readiness.mjs";
import { DOM_MUTATIONS, DOM_READS } from "./contracts.mjs";

/** Private in the donor (line 25). */
/** @typedef {{selector?: string, text?: string, providerId?: string}} DomTarget */
/** Private in the donor (line 26). */
/** @typedef {{ok: boolean, reason?: string, text?: string}} DomOutcome */

export const DOM_TARGET_PREFIX = "dom:";

/**
 * Parse a `dom:` JSON body, or undefined. Private in the donor (line 32); `null`
 * JSON parses to `null` and is returned as-is (see defect (b)).
 *
 * @param {string} target
 * @returns {DomTarget|null|undefined}
 */
function parseTarget(target) {
  if (!target.startsWith(DOM_TARGET_PREFIX)) return undefined;
  try { return JSON.parse(target.slice(DOM_TARGET_PREFIX.length)); } catch { return undefined; }
}

/**
 * Parses a dom: target and returns it with `providerId` filled when present.
 * Throws `Error("Invalid dom target providerId")` when the providerId is not
 * `[a-zA-Z0-9_-]+`.
 *
 * @param {string} target
 * @returns {{providerId?: string, selector?: string, text?: string}|undefined}
 */
export function parseDomTarget(target) {
  const parsed = parseTarget(target);
  if (!parsed) return undefined;
  const { providerId, selector, text } = parsed;
  if (providerId !== undefined && !/^[a-zA-Z0-9_-]+$/.test(providerId)) throw new Error("Invalid dom target providerId");
  return { providerId, selector, text };
}

/**
 * The DOM tier backend. `kind` is `"dom"` (donor line 56: `readonly kind = "dom" as const`),
 * a class field so the runtime's backend ordering can read it off the instance.
 */
export class DomPageBackend {
  /**
   * @param {import("./contracts.mjs").DomPageSurface} surface
   * @param {{preflightReadiness?: boolean, readinessAttempts?: number, readinessIntervalMs?: number}} [options]
   */
  constructor(surface, options = {}) {
    this.kind = "dom";
    this.surface = surface;
    this.options = options;
  }

  /**
   * @param {import("./contracts.mjs").SemanticAction} action
   * @returns {boolean}
   */
  supports(action) {
    const target = parseTarget(action.target);
    if (!target || !target.selector) return false;
    return DOM_MUTATIONS.includes(action.name) || DOM_READS.includes(action.name);
  }

  /** R-201 (§5.1): probe script returning full readiness facts for a selector. */
  readinessScript(selector) {
    return `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, found: false, readyState: document.readyState };
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const formDisabled = (el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) && el.disabled === true;
      return {
        ok: true,
        readyState: document.readyState,
        found: true,
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none",
        enabled: !formDisabled,
        stableSamples: 1
      };
    })()`;
  }

  /**
   * R-201 (§5.1): bounded pre-action readiness. Probes the ordered chain
   * (DOM ready → target exists → visible → enabled → stable) up to
   * `readinessAttempts` times before ANY high-risk action; when the page is still
   * not ready the action is NOT performed (no premature click/type/send).
   *
   * @param {string} selector
   * @param {import("./contracts.mjs").DomPageRef|undefined} page
   * @returns {Promise<string|null>} the last block reason, or null when ready
   */
  async readyOrBlocked(selector, page) {
    const attempts = Math.max(1, this.options.readinessAttempts ?? 2);
    const interval = this.options.readinessIntervalMs ?? 200;
    let lastBlocked = "page not ready";
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const probe = (await this.surface.evaluate(this.readinessScript(selector), page)) ?? {};
      const verdict = readinessFromProbe({ readyState: probe.readyState, found: probe.found, visible: probe.visible, enabled: probe.enabled, stableSamples: probe.stableSamples });
      if (verdict.ready) return null;
      lastBlocked = `readiness blocked: ${verdict.blockers.join(", ")}`;
      if (attempt + 1 < attempts && interval > 0) await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return lastBlocked;
  }

  /**
   * @param {import("./contracts.mjs").SemanticAction} action
   * @param {AbortSignal} _signal accepted and never read (donor defect (e))
   * @returns {Promise<import("./contracts.mjs").SemanticResult>}
   */
  async execute(action, _signal) {
    const target = parseDomTarget(action.target);
    if (!target || !target.selector) return { status: "UNSUPPORTED", message: `DOM action requires dom: target with a selector (got ${String(action.target).slice(0, 60)})` };
    const selector = target.selector;
    const page = target.providerId ? { providerId: target.providerId } : undefined;
    try {
      // R-201 (§5.1): never act on a page that is not demonstrably ready.
      if (this.options.preflightReadiness && DOM_MUTATIONS.includes(action.name)) {
        const blocked = await this.readyOrBlocked(selector, page);
        if (blocked) return { status: "FAILED", message: blocked };
      }
      if (action.name === "click_control") {
        const outcome = await this.surface.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { ok: false, reason: "not-found" }; el.click(); return { ok: true }; })()`, page) ?? { ok: false };
        return outcome.ok ? { status: "SUCCESS" } : { status: "FAILED", message: outcome.reason ?? "click failed" };
      }
      if (action.name === "enter_text") {
        const value = action.value ?? "";
        const outcome = await this.surface.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, reason: "not-found" };
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
            || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            if (setter) setter.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else if (el.isContentEditable) { el.textContent = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); }
          else return { ok: false, reason: "unsupported-element" };
          return { ok: true };
        })()`, page) ?? { ok: false };
        return outcome.ok ? { status: "SUCCESS" } : { status: "FAILED", message: outcome.reason ?? "enter_text failed" };
      }
      if (action.name === "submit") {
        const outcome = await this.surface.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)}) || document.activeElement;
          if (!el) return { ok: false, reason: "not-found" };
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
          el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
          return { ok: true };
        })()`, page) ?? { ok: false };
        return outcome.ok ? { status: "SUCCESS" } : { status: "FAILED", message: outcome.reason ?? "submit failed" };
      }
      if (action.name === "read_page") {
        const outcome = await this.surface.evaluate(`(() => ({ ok: true, text: (document.body?.innerText ?? "").slice(0, 30000) }))()`, page);
        return outcome?.ok ? { status: "SUCCESS", evidence: { text: outcome.text ?? "" } } : { status: "FAILED", message: outcome?.reason ?? "read failed" };
      }
      if (action.name === "verify_state") {
        const expected = action.expected ?? action.value;
        const outcome = await this.surface.evaluate(`(() => ({ ok: true, text: (document.body?.innerText ?? "") }))()`, page);
        const found = expected === undefined || (outcome?.text ?? "").includes(expected);
        return found ? { status: "SUCCESS", evidence: { verified: true } } : { status: "FAILED", message: `expected state not found: ${expected}` };
      }
      return { status: "UNSUPPORTED", message: `DOM backend does not support ${action.name}` };
    } catch (error) {
      return { status: "FAILED", message: String(error).slice(0, 300) };
    }
  }
}
