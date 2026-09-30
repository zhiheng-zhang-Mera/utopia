// D9 port: DS-Hns eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b / assets/fallback.js
/**
 * Procedural asset fallback (Update-Plan/General-Theme.md 任务 4 / 任务 17).
 *
 * The mandated chain is:
 *
 *   real image generation -> retry -> procedural fallback -> disable that asset
 *
 * This module is the third link, and `asset-factory.js` is its drawing backend:
 * the fallback is not a stub, it is the same deterministic procedural renderer the
 * theme system already shipped, wired per asset kind. Keeping it in its own module
 * is what makes "the generator failed" a *recoverable* outcome instead of a theme
 * build failure: nothing here can throw, and every path returns either a canvas or
 * `null` plus the reason.
 *
 * The fallback deliberately does not try to imitate the model. It produces a real,
 * transparent, placeable asset in the theme's own palette — enough for the theme
 * to remain complete and honest about the degradation.
 */
import * as assets from '../procedural/factory.mjs';

/** Asset kind -> procedural renderer. Every entry returns a canvas. */
const RENDERERS = Object.freeze({
  wallpaper: ({ palette, style, seed, spec }) => assets.renderWallpaper({
    palette,
    style,
    seed,
    width: spec.width,
    height: spec.height
  }),
  panel_texture: ({ palette, seed, spec }) => assets.renderPanel({
    palette,
    seed,
    width: spec.width,
    height: spec.height
  }),
  icon_set: ({ palette, spec }) => assets.renderIconSheet({
    palette,
    width: spec.width,
    height: spec.height
  }),
  overlay_skin: ({ palette, style, seed, spec }) => assets.renderOverlaySkin({
    palette,
    style,
    seed,
    width: spec.width,
    height: spec.height
  }),
  overlay_texture: ({ palette, style, seed, spec }) => assets.renderOverlayTexture({
    palette,
    style,
    seed,
    width: spec.width,
    height: spec.height
  }),
  hud_decoration: ({ palette, style, seed, spec }) => assets.renderHudDecoration({
    palette,
    style,
    seed,
    width: spec.width,
    height: spec.height
  }),
  frame_decoration: ({ palette, style, seed, spec }) => assets.renderFrameDecoration({
    palette,
    style,
    seed,
    width: spec.width,
    height: spec.height
  }),
  surface_character: ({ palette, style, seed, spec, character }) => assets.renderCharacter({
    palette,
    style,
    seed,
    character,
    framing: spec.framing,
    width: spec.width,
    height: spec.height
  }),
  overlay_character: ({ palette, style, seed, spec, character }) => assets.renderCharacter({
    palette,
    style,
    seed,
    character,
    framing: spec.framing,
    width: spec.width,
    height: spec.height
  }),
  persona_avatar: ({ palette, style, seed, spec, character }) => assets.renderCharacter({
    palette,
    style,
    seed,
    character,
    framing: 'avatar',
    width: spec.width,
    height: spec.height
  })
})

/** Asset kinds the fallback can produce. */
const SUPPORTED_KINDS = Object.freeze(Object.keys(RENDERERS))

/**
 * Render one asset procedurally.
 *
 * @param {object} options
 * @param {string} options.kind       asset kind (asset-factory REAL_ASSET_CATALOG key)
 * @param {string} options.surface    target Theme Surface; the protected surface is refused upstream
 * @param {object} options.palette    resolved theme palette
 * @param {object} options.spec       the asset plan entry (width/height/framing/transparent)
 * @param {string} [options.style]    style tag used by the drawing backend
 * @param {string} [options.seed]
 * @param {number} [options.framing]  character framing override
 * @param {string} [options.character]
 * @returns {{canvas: object|null, renderer: string|null, reason: string|null}}
 */
function render({ kind, surface = null, palette = {}, spec = {}, style = 'research', seed = 'fallback', framing = null, character = null } = {}) {
  const name = String(kind || '')
  const renderer = RENDERERS[name]
  if (!renderer) {
    return { canvas: null, renderer: null, reason: `no procedural fallback exists for "${name}"` }
  }
  const resolvedSpec = {
    width: Number(spec.width) || assets.REAL_ASSET_CATALOG[name]?.width || 256,
    height: Number(spec.height) || assets.REAL_ASSET_CATALOG[name]?.height || 256,
    framing: framing || spec.framing || assets.REAL_ASSET_CATALOG[name]?.framing || 'half_body',
    transparent: spec.transparent === true
  }
  try {
    const canvas = renderer({
      palette,
      style,
      // Preserve the pinned donor's seed vocabulary for byte-identical rendering.
      seed: `${seed}:${({surface_character:'hns_character',overlay_character:'official_character',overlay_skin:'official_skin',overlay_texture:'official_overlay_texture'})[name]||name}`,
      spec: resolvedSpec,
      character: character || 'operator_assistant'
    })
    if (!canvas || !canvas.data) {
      return { canvas: null, renderer: name, reason: `the procedural renderer for "${name}" produced no canvas` }
    }
    return { canvas, renderer: name, reason: null }
  } catch (error) {
    return { canvas: null, renderer: name, reason: `procedural fallback for "${name}" failed: ${error?.message || error}` }
  }
}

export {
  RENDERERS,
  SUPPORTED_KINDS,
  render
}
