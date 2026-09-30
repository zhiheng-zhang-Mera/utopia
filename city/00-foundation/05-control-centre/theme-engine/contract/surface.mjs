/**
 * UTOPIA · Theme Package Lab — ownership surface model.
 *
 * A theme package does not just answer "which slots may I write?"; it answers
 * "which layer of the product may I touch, and how much?". Four surfaces exist and
 * each carries four independent decisions instead of a single boolean:
 *
 *   owned_surface              the UI this project paints itself: full access to
 *                              tokens, slots, persona and assets.
 *   external_shell             the frame this project draws *around* a foreign
 *                              view: full access to chrome-level styling.
 *   owned_overlay              a visual-only layer above a foreign view: no DOM
 *                              reach into that view, no input, no focus.
 *   protected_external_surface the foreign view itself: never writable, never
 *                              injectable, never captured.
 *
 * `writable` / `assetWritable` are derived from the permission, and
 * `assertWritable` is the single gate every writer goes through. A PROTECTED
 * surface cannot be written even by a caller that skips a higher-level check,
 * because the gate is data-driven and lives here.
 *
 * Boundary honesty: `access.dom === false` on the two foreign-view surfaces is not
 * a temporary limitation to be removed later. It is the architectural contract:
 * the foreign view is owned elsewhere, and this project reaches it only by
 * stacking its own layers around it, never by reaching inside it.
 *
 * Ported from the DS-Hns donor `theme/surface.js`; the surface names and the slot
 * families are Utopia's ownership vocabulary (see `contract.mjs`).
 */

import { SURFACE, SURFACE_PERMISSION } from './contract.mjs';

/** The four canonical surfaces. Order is stable and used by the UI. */
export const SURFACE_IDS = Object.freeze([
  SURFACE.OWNED_SURFACE,
  SURFACE.EXTERNAL_SHELL,
  SURFACE.OWNED_OVERLAY,
  SURFACE.PROTECTED_EXTERNAL_SURFACE,
]);

/**
 * Interaction contract of a surface. The overlay is the interesting one: it must
 * not participate in input at all, which is what keeps the foreign view clickable,
 * typeable and scrollable underneath it.
 */
export const VISUAL_ONLY_INPUT = Object.freeze({
  pointer: false,
  keyboard: false,
  focus: false,
  scroll: false,
  // Always true for a visual layer: it never owns a hit target.
  passthrough: true,
});

export const FULL_INPUT = Object.freeze({
  pointer: true,
  keyboard: true,
  focus: true,
  scroll: true,
  passthrough: false,
});

/** What a surface physically is, which is what a renderer paints. */
export const SURFACES = Object.freeze({
  [SURFACE.OWNED_SURFACE]: Object.freeze({
    id: SURFACE.OWNED_SURFACE,
    label: 'Owned Surface',
    order: 1,
    permission: SURFACE_PERMISSION.FULL,
    writable: true,
    assetWritable: true,
    interactive: true,
    visualOnly: false,
    protected: false,
    owner: 'utopia',
    container: 'own-renderer',
    description: 'The UI this project paints itself: tokens, slot styles, persona and assets all apply here.',
    layers: Object.freeze(['tokens', 'slots', 'persona', 'asset', 'character', 'decoration']),
    input: FULL_INPUT,
    access: Object.freeze({ dom: true, css: true, script: true, capture: true, resize: true }),
  }),
  [SURFACE.EXTERNAL_SHELL]: Object.freeze({
    id: SURFACE.EXTERNAL_SHELL,
    label: 'External Shell',
    order: 2,
    permission: SURFACE_PERMISSION.FULL,
    writable: true,
    assetWritable: true,
    interactive: false,
    visualOnly: false,
    protected: false,
    owner: 'utopia',
    container: 'own-shell-around-foreign-view',
    description: 'The frame drawn around a foreign view: background, border, radius, shadow, separator, frame and outer padding.',
    layers: Object.freeze(['tokens', 'slots', 'asset', 'decoration']),
    // The shell is a frame: it stays input-transparent so the foreign view keeps
    // every pixel it had. Only the frame band itself is ever painted.
    input: VISUAL_ONLY_INPUT,
    access: Object.freeze({ dom: true, css: true, script: true, capture: true, resize: true }),
  }),
  [SURFACE.OWNED_OVERLAY]: Object.freeze({
    id: SURFACE.OWNED_OVERLAY,
    label: 'Owned Overlay',
    order: 3,
    permission: SURFACE_PERMISSION.VISUAL_ONLY,
    writable: true,
    assetWritable: true,
    interactive: false,
    visualOnly: true,
    protected: false,
    owner: 'utopia',
    container: 'own-overlay-above-foreign-view',
    description: 'A transparent visual layer above a foreign view: tint, gradient, texture, skin, vignette, scanline, frame glow, corner decoration and the character.',
    layers: Object.freeze(['tokens', 'slots', 'asset', 'character', 'decoration', 'effect']),
    input: VISUAL_ONLY_INPUT,
    access: Object.freeze({ dom: true, css: true, script: true, capture: true, resize: true }),
  }),
  [SURFACE.PROTECTED_EXTERNAL_SURFACE]: Object.freeze({
    id: SURFACE.PROTECTED_EXTERNAL_SURFACE,
    label: 'Protected External Surface',
    order: 4,
    permission: SURFACE_PERMISSION.PROTECTED,
    writable: false,
    assetWritable: false,
    interactive: true,
    visualOnly: false,
    protected: true,
    owner: 'external',
    container: 'foreign-view',
    description: 'A view owned elsewhere. No DOM, no CSS, no script, no input interception and no capture from a theme package.',
    layers: Object.freeze([]),
    input: FULL_INPUT,
    access: Object.freeze({ dom: false, css: false, script: false, capture: false, resize: false }),
  }),
});

/** Layer vocabulary a package may target, in paint order. */
export const LAYERS = Object.freeze(['tokens', 'slots', 'persona', 'asset', 'character', 'decoration', 'effect', 'layout']);

/** Asset kinds a surface may carry. Empty means "not asset-settable at all". */
export const SURFACE_ASSET_KINDS = Object.freeze({
  [SURFACE.OWNED_SURFACE]: Object.freeze([
    'wallpaper',
    'persona_avatar',
    'surface_character',
    'decoration',
    'panel_texture',
    'icon_set',
    'background_illustration',
    'hud_decoration',
    'frame_decoration',
  ]),
  [SURFACE.EXTERNAL_SHELL]: Object.freeze([
    'shell_frame',
    'frame_decoration',
    'wallpaper',
    'background_illustration',
  ]),
  [SURFACE.OWNED_OVERLAY]: Object.freeze([
    'overlay_skin',
    'overlay_texture',
    'overlay_character',
    'wallpaper',
    'background_illustration',
    'hud_decoration',
    'frame_decoration',
    'decoration',
  ]),
  [SURFACE.PROTECTED_EXTERNAL_SURFACE]: Object.freeze([]),
});

/** Layout modes the owned overlay understands. */
export const LAYOUT_MODES = Object.freeze(['corner', 'edge', 'floating', 'background', 'framed']);

/** Anchors a character or decoration may be placed at. */
export const ANCHORS = Object.freeze([
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
]);

/** Feature switches that only exist on the overlay surface. */
export const OVERLAY_FEATURES = Object.freeze([
  'tint',
  'gradient',
  'texture',
  'skin',
  'vignette',
  'scanline',
  'frame_glow',
  'corner_decoration',
  'character',
]);

/** Surface database as a plain array, in canonical order. */
export const SURFACE_LIST = Object.freeze(SURFACE_IDS.map((id) => SURFACES[id]));

export function getSurface(id) {
  return SURFACES[id] || null;
}

/** Is `id` one of the four canonical surfaces? */
export function isSurface(id) {
  return Object.prototype.hasOwnProperty.call(SURFACES, String(id || ''));
}

export function permissionOf(id) {
  return SURFACES[id]?.permission || null;
}

/** May a generator write tokens, slots or plan entries on this surface? */
export function isWritable(id) {
  return SURFACES[id]?.writable === true;
}

/** May a generator attach an asset to this surface? */
export function isAssetWritable(id) {
  return SURFACES[id]?.assetWritable === true;
}

export function isProtected(id) {
  return SURFACES[id]?.protected === true;
}

/** May this surface be painted over without stealing input? */
export function isVisualOnly(id) {
  return SURFACES[id]?.visualOnly === true;
}

/** Asset kinds this surface accepts (empty for the protected surface). */
export function assetKinds(id) {
  return (SURFACE_ASSET_KINDS[id] || []).slice();
}

export function acceptsAssetKind(id, kind) {
  return (SURFACE_ASSET_KINDS[id] || []).includes(String(kind || ''));
}

/**
 * The single write gate.
 *
 * Every writer calls this before it touches a surface. It returns a *result*
 * rather than throwing, because a caller must be able to degrade (skip that one
 * asset, drop that one overlay module) instead of failing an entire package.
 *
 * @param {string} surfaceId
 * @param {{kind?: 'asset'|'component'|'layout'|'override', assetKind?: string|null, target?: string|null}} [options]
 */
export function assertWritable(surfaceId, { kind = 'component', assetKind = null, target = null } = {}) {
  const id = String(surfaceId || '');
  const surface = SURFACES[id];
  if (!surface) {
    return {
      ok: false,
      surface: id || null,
      permission: null,
      code: 'surface_unknown',
      reason: `"${id}" is not one of the four Theme Surfaces (${SURFACE_IDS.join(', ')})`,
    };
  }
  if (surface.protected || surface.permission === SURFACE_PERMISSION.PROTECTED) {
    return {
      ok: false,
      surface: id,
      permission: surface.permission,
      code: 'surface_protected',
      reason: `${id} is PROTECTED: a theme package never modifies the foreign view`,
      target: target || null,
    };
  }
  if (kind === 'asset') {
    if (!surface.assetWritable) {
      return {
        ok: false,
        surface: id,
        permission: surface.permission,
        code: 'surface_asset_denied',
        reason: `${id} does not accept theme assets`,
        target: target || null,
      };
    }
    if (assetKind && !acceptsAssetKind(id, assetKind)) {
      return {
        ok: false,
        surface: id,
        permission: surface.permission,
        code: 'surface_asset_kind_denied',
        reason: `${id} does not accept a "${assetKind}" asset (accepts: ${assetKinds(id).join(', ') || 'none'})`,
        target: target || null,
      };
    }
  }
  if (!surface.writable) {
    return {
      ok: false,
      surface: id,
      permission: surface.permission,
      code: 'surface_write_denied',
      reason: `${id} is ${surface.permission} and cannot be written by a theme package`,
      target: target || null,
    };
  }
  return { ok: true, surface: id, permission: surface.permission };
}

const SURFACE_REFERENCE_KEYS = Object.freeze(['surface', 'target', 'surface_target', 'target_surface']);

/**
 * Reject a payload that tries to *write* the protected surface.
 *
 * Declaring the protected surface is not a violation — a surface plan is required
 * to describe all four surfaces, including the one it refuses to write. Only a
 * reference that claims a write is rejected, which is the shape a hand-written or
 * imported package would have to use to smuggle one in:
 *
 *   { "surface": "protected_external_surface", "writes": true }   -> rejected
 *   { "target":  "protected_external_surface", "opacity": 0.4 }   -> rejected
 *   { "surface": "protected_external_surface", "writes": false }  -> allowed (honest)
 */
export function violationsIn(value, trail = [], found = []) {
  const visit = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, path.concat(String(index))));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      const entry = node[key];
      if (typeof entry === 'string' && SURFACE_REFERENCE_KEYS.includes(key) && isSurface(entry) && isProtected(entry)) {
        // An explicit `writes: false` is the honest way to name it.
        if (node.writes === false || node.written === false || node.themed === false) continue;
        found.push({ path: path.concat(key).join('.'), value: entry, code: 'surface_protected' });
        continue;
      }
      if (entry && typeof entry === 'object') visit(entry, path.concat(key));
    }
  };
  visit(value, trail);
  return found;
}

/**
 * The surface a slot belongs to. Slot families carry their own surface so the
 * capability description and the package validator agree without a second table.
 */
export function surfaceOfSlot(slotId) {
  const id = String(slotId || '');
  if (id.startsWith('overlay.')) return SURFACE.OWNED_OVERLAY;
  if (id.startsWith('shell.')) return SURFACE.EXTERNAL_SHELL;
  if (id.startsWith('external.')) return SURFACE.PROTECTED_EXTERNAL_SURFACE;
  return SURFACE.OWNED_SURFACE;
}

/** Compact renderer/UI-safe description of every surface. */
export function describe() {
  return SURFACE_LIST.map((surface) => ({
    id: surface.id,
    label: surface.label,
    permission: surface.permission,
    writable: surface.writable,
    assetWritable: surface.assetWritable,
    protected: surface.protected,
    visualOnly: surface.visualOnly,
    interactive: surface.interactive,
    owner: surface.owner,
    container: surface.container,
    layers: surface.layers.slice(),
    assetKinds: assetKinds(surface.id),
    input: { ...surface.input },
    access: { ...surface.access },
    description: surface.description,
  }));
}
