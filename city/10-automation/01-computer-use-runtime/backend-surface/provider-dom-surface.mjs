/**
 * UTOPIA · 10-automation / Computer Use Runtime — provider DOM page surface.
 *
 * Donor: `electron/computer/backends/provider-dom-surface.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. Pure over an injected view accessor
 * and unchanged in behaviour.
 *
 * Production §8.2 DOM page surface bound to the visible provider panes. The
 * DomPageBackend evaluates scripts through whichever provider WebContentsView the
 * action names.
 *
 * Both donor edges are `import type` only and are erased: `ProviderViews` from
 * `../../provider-views` and `DomPageRef`/`DomPageSurface` from `./dom-page`. The
 * view accessor and the page surface shape are declared as typedefs here and in
 * `./contracts.mjs`; no Electron, no `WebContentsView` and no provider runtime is
 * ported. The accessor receives the donor's own contract — `get(providerId)` — and
 * a view is anything with a `webContents` exposing `executeJavaScript`,
 * `isDestroyed()` and `isCrashed()`.
 *
 * Preserved donor defects (pinned by tests, not repaired):
 *   (a) The no-`providerId` error message promises that "exactly one open provider
 *       page" can disambiguate, but `viewFor` never counts open pages — it throws
 *       unconditionally when `providerId` is absent. The message is kept verbatim
 *       and the missing fallback is pinned as the defect it is.
 *   (b) The `isDestroyed()` check also fires for a `providerId` that simply is not
 *       open, so "closed" and "never existed" report the same message.
 *   (c) The `isCrashed()` check is skipped when the pane is destroyed (the destroyed
 *       check returns first), and a crashed-but-destroyed pane reports "not open".
 *
 * This module is pure: no filesystem, no network, no clock, no randomness, no
 * environment. `evaluate` performs no work of its own beyond delegating the script
 * to the named view's `webContents.executeJavaScript`.
 */

/**
 * One open provider pane, as much of it as this surface touches. Production passes
 * a real Electron view; the donor's own test passes exactly this shape.
 * @typedef {object} ProviderView
 * @property {{isDestroyed: () => boolean, isCrashed: () => boolean, executeJavaScript: (script: string) => Promise<unknown>}} webContents
 */

/**
 * The donor's `ProviderViews`: `get(providerId)` returns the open pane or undefined.
 * @typedef {{get: (providerId: string) => ProviderView|undefined}} ProviderViewsAccessor
 */

/**
 * @param {() => ProviderViewsAccessor} views the injected view accessor, called freshly per lookup
 * @returns {import("./contracts.mjs").DomPageSurface}
 */
export function providerDomSurface(views) {
  const viewFor = (page) => {
    const providerId = page?.providerId;
    const open = providerId ? views().get(providerId) : undefined;
    if (providerId && (!open || open.webContents.isDestroyed())) throw new Error(`Provider page is not open: ${providerId}`);
    if (!providerId) throw new Error("DOM action requires a dom: providerId (or exactly one open provider page to disambiguate)");
    if (open.webContents.isCrashed()) throw new Error(`Provider page crashed: ${providerId}`);
    return open;
  };
  return {
    /**
     * @template T
     * @param {string} script
     * @param {import("./contracts.mjs").DomPageRef} [page]
     * @returns {Promise<T>}
     */
    async evaluate(script, page) {
      const view = viewFor(page);
      return view.webContents.executeJavaScript(script);
    }
  };
}
