/**
 * UTOPIA · Theme Package Lab — theme package contract.
 *
 * The single source of truth for:
 *   - the Theme Package API version every package must declare,
 *   - the semantic UI slot vocabulary and its per-slot permission level,
 *   - the design-token schema (colour / typography / spacing / radius / shadow),
 *   - the canonical worker-state vocabulary,
 *   - the four ownership surfaces a package may name.
 *
 * Ported from the DS-Hns donor `theme/contract.js`
 * (zhiheng-zhang-Mera/DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b).
 *
 * Port differences — the donor's permanent product nouns are not Utopia's public
 * API, so the ownership surfaces and the slot families were renamed while every
 * safety semantic was preserved:
 *
 *   hns_native        -> owned_surface              (the UI Utopia owns and paints)
 *   official_shell    -> external_shell             (the frame Utopia draws around a foreign view)
 *   official_overlay  -> owned_overlay              (a visual-only layer above a foreign view)
 *   official_renderer -> protected_external_surface (never writable, never injectable)
 *
 *   hns.*      slots -> surface.*
 *   official.shell.* -> shell.*
 *   official.overlay.* -> overlay.*
 *   official.renderer.* -> external.renderer.*
 *   CSS custom properties `--hns-*` -> `--utopia-*`
 *
 * Hard rules carried by this file:
 *   - Slot permissions are declarative data. STRUCTURAL slots are described so a
 *     package can state what it does not touch, and are never writable by a
 *     generator.
 *   - A theme package is declarative data only. No executable payload is
 *     representable in this schema, so no package can smuggle code into a runtime.
 *   - Worker state visuals are a protected capability: every canonical state must
 *     stay distinguishable, so state colours are measured by the validator instead
 *     of being trusted.
 */

/** Theme Package API version exposed by this module. */
export const THEME_API_VERSION = '1.0';

/** Minimum API version a package may declare and still be loaded. */
export const THEME_API_MIN_SUPPORTED = '1.0';

/** Permission levels, ordered by how much a generator may touch. */
export const PERMISSION = Object.freeze({
  SAFE: 'SAFE',
  STYLE: 'STYLE',
  STRUCTURAL: 'STRUCTURAL',
});

/** Generator-writable permission levels. */
export const GENERATOR_PERMISSIONS = Object.freeze([PERMISSION.SAFE, PERMISSION.STYLE]);

/**
 * The four ownership surfaces.
 *
 * Declared here — the contract layer — because they are part of the package API
 * vocabulary, exactly like slots and tokens. `surface.mjs` owns the behaviour
 * (permissions, the write gate, the layout vocabulary); this file owns the names,
 * so a package that declares a surface is validated against the same constant the
 * rest of the module uses.
 */
export const SURFACE = Object.freeze({
  OWNED_SURFACE: 'owned_surface',
  EXTERNAL_SHELL: 'external_shell',
  OWNED_OVERLAY: 'owned_overlay',
  PROTECTED_EXTERNAL_SURFACE: 'protected_external_surface',
});

/** How much of a surface a theme package may write. */
export const SURFACE_PERMISSION = Object.freeze({
  FULL: 'full',
  VISUAL_ONLY: 'visual-only',
  PROTECTED: 'protected',
});

/** The protected surface is never writable by any theme writer. */
export const PROTECTED_SURFACES = Object.freeze([SURFACE.PROTECTED_EXTERNAL_SURFACE]);

/** Property categories understood by this contract. */
export const PROPERTY_KIND = Object.freeze({
  COLOR: 'color',
  LENGTH: 'length',
  NUMBER: 'number',
  SHADOW: 'shadow',
  FONT: 'font',
  ASSET: 'asset',
  ENUM: 'enum',
});

/**
 * Canonical worker/process states. A theme may restyle them but must keep them
 * mutually distinguishable, which is what makes a theme safe to read at a glance.
 */
export const WORKER_STATES = Object.freeze([
  'idle',
  'running',
  'waiting',
  'blocked',
  'warning',
  'failed',
  'completed',
  'resource_limit',
  'primary_worker',
  'sub_worker',
]);

/** Canonical UI views a theme package may describe. */
export const UI_VIEWS = Object.freeze([
  { id: 'dashboard', name: 'Dashboard', surface: 'surface' },
  { id: 'worker', name: 'Worker View', surface: 'surface' },
  { id: 'process', name: 'Process View', surface: 'surface' },
  { id: 'hardware', name: 'Hardware Monitor', surface: 'surface' },
  { id: 'log', name: 'Log View', surface: 'surface' },
  { id: 'skills', name: 'Skills', surface: 'surface' },
  { id: 'settings', name: 'Settings', surface: 'surface' },
  { id: 'tray', name: 'Tray / Popup', surface: 'shell' },
  { id: 'external', name: 'External Surface', surface: 'external' },
]);

function slot(type, permission, properties) {
  return Object.freeze({
    type,
    permission,
    properties: Object.freeze(properties.slice()),
  });
}

/**
 * Slot table. `type` describes what a renderer accepts, `permission` what a
 * generator is allowed to do, `properties` the writable property names.
 *
 * Naming is `<family>.<domain>.<component>[.<property>]`, where `<family>` is one
 * of `common`, `surface` (the owned surface), `shell`, `overlay` (the owned
 * overlay) or `external` (the protected surface, described only).
 */
export const SLOTS = Object.freeze({
  // ---- common / generic slots ----
  'common.window.background': slot('image_or_color', PERMISSION.SAFE, ['background', 'overlay']),
  'common.window.overlay': slot('image_or_color', PERMISSION.STYLE, ['background', 'opacity', 'blur', 'blend']),
  'common.navigation.sidebar': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'radius']),
  'common.navigation.topbar': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'label']),
  'common.panel.background': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'radius', 'shadow']),
  'common.panel.border': slot('color', PERMISSION.SAFE, ['border']),
  'common.button.primary': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius', 'shadow', 'glow']),
  'common.button.secondary': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius']),
  'common.input.default': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius', 'placeholder']),
  'common.dialog.default': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'radius', 'shadow', 'overlay']),
  'common.notification.default': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'label', 'radius']),
  'common.status.success': slot('color', PERMISSION.SAFE, ['color']),
  'common.status.warning': slot('color', PERMISSION.SAFE, ['color']),
  'common.status.error': slot('color', PERMISSION.SAFE, ['color']),
  'common.tooltip.default': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius']),
  'common.scrollbar.default': slot('component_style', PERMISSION.SAFE, ['thumb', 'track', 'width']),

  // ---- the owned surface (the UI this project paints itself) ----
  'surface.window.background': slot('image_or_color', PERMISSION.SAFE, ['background', 'overlay']),
  'surface.window.overlay': slot('image_or_color', PERMISSION.STYLE, ['background', 'opacity', 'blur', 'blend']),
  'surface.window.shell': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius']),
  'surface.worker.card': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'radius', 'shadow', 'label']),
  'surface.worker.header': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border']),
  'surface.worker.status': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'color']),
  'surface.process.panel': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'radius', 'shadow']),
  'surface.process.queue': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'radius', 'label']),
  'surface.hardware.cpu': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'color']),
  'surface.hardware.gpu': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'color']),
  'surface.hardware.memory': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'color']),
  'surface.hardware.power': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'color']),
  'surface.log.panel': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'radius', 'label']),
  'surface.log.level': slot('component_style', PERMISSION.SAFE, ['color', 'label', 'weight']),
  'surface.status.badge': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius']),
  'surface.tray.icon': slot('asset_ref', PERMISSION.SAFE, ['asset']),
  'surface.operator.avatar': slot('asset_ref', PERMISSION.SAFE, ['asset', 'size']),
  'surface.operator.widget': slot('component_style', PERMISSION.STYLE, ['background', 'opacity', 'position', 'size', 'animation']),

  // ---- the skills surface ----
  'surface.skill.card': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'radius', 'shadow', 'label']),
  'surface.skill.header': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border']),
  'surface.skill.badge': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius']),
  'surface.skill.tag': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius']),
  'surface.skill.search': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius', 'placeholder']),
  'surface.skill.danger': slot('color', PERMISSION.SAFE, ['color']),

  // ---- the persona layer ----
  'surface.persona.banner': slot('asset_ref', PERMISSION.STYLE, ['asset', 'opacity', 'position', 'height']),
  'surface.persona.status_avatar': slot('asset_ref', PERMISSION.STYLE, ['asset', 'size', 'position']),
  'surface.persona.decoration': slot('image_or_color', PERMISSION.STYLE, ['asset', 'opacity', 'animation', 'position']),
  // The real character asset: a transparent bust / half body / full body placed by
  // the layout vocabulary, not a small abstract avatar.
  'surface.character.primary': slot('asset_ref', PERMISSION.STYLE, ['asset', 'opacity', 'position', 'scale', 'anchor', 'crop', 'layout']),

  // ---- external shell (the frame drawn around a foreign view) ----
  'shell.background': slot('image_or_color', PERMISSION.SAFE, ['background', 'overlay']),
  'shell.border': slot('component_style', PERMISSION.SAFE, ['border', 'radius']),
  'shell.radius': slot('component_style', PERMISSION.SAFE, ['radius', 'background']),
  'shell.shadow': slot('component_style', PERMISSION.STYLE, ['shadow', 'background']),
  'shell.separator': slot('component_style', PERMISSION.SAFE, ['border', 'color']),
  'shell.frame': slot('component_style', PERMISSION.STYLE, ['border', 'radius', 'padding', 'shadow', 'background']),
  'shell.padding': slot('component_style', PERMISSION.SAFE, ['padding', 'background']),

  // ---- owned overlay (a visual-only layer above a foreign view) ----
  'overlay.global_tint': slot('image_or_color', PERMISSION.STYLE, ['color', 'opacity', 'blend']),
  'overlay.gradient': slot('component_style', PERMISSION.STYLE, ['angle', 'stops', 'opacity']),
  'overlay.texture': slot('image_or_color', PERMISSION.STYLE, ['asset', 'opacity', 'scale', 'blend', 'tile']),
  'overlay.skin': slot('image_or_color', PERMISSION.STYLE, ['asset', 'opacity', 'blend', 'layout', 'inset']),
  'overlay.vignette': slot('component_style', PERMISSION.STYLE, ['opacity', 'color', 'size']),
  'overlay.scanline': slot('component_style', PERMISSION.STYLE, ['opacity', 'color', 'spacing', 'width']),
  'overlay.frame_glow': slot('component_style', PERMISSION.STYLE, ['opacity', 'color', 'glow', 'width']),
  'overlay.corner_decoration': slot('image_or_color', PERMISSION.STYLE, ['asset', 'opacity', 'position', 'scale', 'anchor']),
  'overlay.character_primary': slot('asset_ref', PERMISSION.STYLE, ['asset', 'opacity', 'position', 'scale', 'anchor', 'crop', 'layout']),
  'overlay.character_secondary': slot('asset_ref', PERMISSION.STYLE, ['asset', 'opacity', 'position', 'scale', 'anchor', 'crop', 'layout']),

  // ---- protected external surface: described, never written ----
  'external.renderer.dom': slot('struct', PERMISSION.STRUCTURAL, []),
  'external.renderer.stylesheet': slot('struct', PERMISSION.STRUCTURAL, []),
  'external.renderer.script': slot('struct', PERMISSION.STRUCTURAL, []),
  'external.renderer.events': slot('struct', PERMISSION.STRUCTURAL, []),

  // ---- structural slots: described, never generated ----
  'layout.sidebar_width': slot('struct', PERMISSION.STRUCTURAL, []),
  'layout.navigation_hierarchy': slot('struct', PERMISSION.STRUCTURAL, []),
  'layout.critical_button_position': slot('struct', PERMISSION.STRUCTURAL, []),
  'layout.information_hierarchy': slot('struct', PERMISSION.STRUCTURAL, []),
});

/** Slot id list, stable order. */
export const SLOT_IDS = Object.freeze(Object.keys(SLOTS));

/**
 * Motion presets. Intensity is clamped by the validator; a package can never
 * request a custom easing or keyframe payload.
 */
export const ANIMATION_PRESETS = Object.freeze(['none', 'fade', 'pulse', 'glow', 'slide', 'soft_blur']);

/** Maximum accepted animation intensity per preset. */
export const ANIMATION_MAX_INTENSITY = Object.freeze({
  none: 0,
  fade: 0.6,
  pulse: 0.5,
  glow: 0.6,
  slide: 0.4,
  soft_blur: 0.35,
});

function token(css, kind, group, fallback) {
  return Object.freeze({ css, kind, group, fallback });
}

/**
 * Token schema. Each entry maps a semantic token name to the CSS custom property
 * it binds to, its validation kind, its group and the value used whenever a
 * package omits it.
 */
export const TOKENS = Object.freeze({
  'color.bg.base': token('--utopia-color-bg-base', PROPERTY_KIND.COLOR, 'color', '#0f1115'),
  'color.bg.layer1': token('--utopia-color-bg-layer1', PROPERTY_KIND.COLOR, 'color', '#151922'),
  'color.bg.layer2': token('--utopia-color-bg-layer2', PROPERTY_KIND.COLOR, 'color', '#1b2130'),
  'color.bg.overlay': token('--utopia-color-bg-overlay', PROPERTY_KIND.COLOR, 'color', '#0b0d12'),
  'color.bg.raised': token('--utopia-color-bg-raised', PROPERTY_KIND.COLOR, 'color', '#222a3a'),
  'color.label.primary': token('--utopia-color-label-primary', PROPERTY_KIND.COLOR, 'color', '#e8ecf3'),
  'color.label.secondary': token('--utopia-color-label-secondary', PROPERTY_KIND.COLOR, 'color', '#a7b1c2'),
  'color.label.tertiary': token('--utopia-color-label-tertiary', PROPERTY_KIND.COLOR, 'color', '#7b8698'),
  'color.label.inverse': token('--utopia-color-label-inverse', PROPERTY_KIND.COLOR, 'color', '#0d1016'),
  'color.border.l1': token('--utopia-color-border-l1', PROPERTY_KIND.COLOR, 'color', '#232b3b'),
  'color.border.l2': token('--utopia-color-border-l2', PROPERTY_KIND.COLOR, 'color', '#2f3a4e'),
  'color.accent.primary': token('--utopia-color-accent-primary', PROPERTY_KIND.COLOR, 'color', '#4d93f8'),
  'color.accent.secondary': token('--utopia-color-accent-secondary', PROPERTY_KIND.COLOR, 'color', '#7aa7ff'),
  'color.accent.contrast': token('--utopia-color-accent-contrast', PROPERTY_KIND.COLOR, 'color', '#0d1016'),
  'color.accent.subtle': token('--utopia-color-accent-subtle', PROPERTY_KIND.COLOR, 'color', '#1a2740'),

  'state.idle': token('--utopia-state-idle', PROPERTY_KIND.COLOR, 'state', '#8b93a1'),
  'state.running': token('--utopia-state-running', PROPERTY_KIND.COLOR, 'state', '#4d93f8'),
  'state.waiting': token('--utopia-state-waiting', PROPERTY_KIND.COLOR, 'state', '#c9a227'),
  'state.blocked': token('--utopia-state-blocked', PROPERTY_KIND.COLOR, 'state', '#b06bd6'),
  'state.warning': token('--utopia-state-warning', PROPERTY_KIND.COLOR, 'state', '#f0a63a'),
  'state.failed': token('--utopia-state-failed', PROPERTY_KIND.COLOR, 'state', '#ef5d5d'),
  'state.completed': token('--utopia-state-completed', PROPERTY_KIND.COLOR, 'state', '#3fbf7f'),
  'state.resource_limit': token('--utopia-state-resource-limit', PROPERTY_KIND.COLOR, 'state', '#d9553f'),
  'state.primary_worker': token('--utopia-state-primary-worker', PROPERTY_KIND.COLOR, 'state', '#4ea8de'),
  'state.sub_worker': token('--utopia-state-sub-worker', PROPERTY_KIND.COLOR, 'state', '#6fa8a0'),

  'font.family': token('--utopia-font-family', PROPERTY_KIND.FONT, 'typography', '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'),
  'font.family.mono': token('--utopia-font-family-mono', PROPERTY_KIND.FONT, 'typography', 'Consolas, "SF Mono", monospace'),
  'font.size.body': token('--utopia-font-size-body', PROPERTY_KIND.LENGTH, 'typography', '13px'),
  'font.size.caption': token('--utopia-font-size-caption', PROPERTY_KIND.LENGTH, 'typography', '11px'),
  'font.size.title': token('--utopia-font-size-title', PROPERTY_KIND.LENGTH, 'typography', '16px'),
  'font.weight.body': token('--utopia-font-weight-body', PROPERTY_KIND.NUMBER, 'typography', '400'),
  'font.weight.title': token('--utopia-font-weight-title', PROPERTY_KIND.NUMBER, 'typography', '600'),

  'space.unit': token('--utopia-space-unit', PROPERTY_KIND.LENGTH, 'spacing', '4px'),
  'space.gap': token('--utopia-space-gap', PROPERTY_KIND.LENGTH, 'spacing', '8px'),
  'space.panel': token('--utopia-space-panel', PROPERTY_KIND.LENGTH, 'spacing', '12px'),

  'radius.sm': token('--utopia-radius-sm', PROPERTY_KIND.LENGTH, 'radius', '4px'),
  'radius.md': token('--utopia-radius-md', PROPERTY_KIND.LENGTH, 'radius', '8px'),
  'radius.lg': token('--utopia-radius-lg', PROPERTY_KIND.LENGTH, 'radius', '14px'),

  'shadow.l1': token('--utopia-shadow-l1', PROPERTY_KIND.SHADOW, 'shadow', '0 1px 3px rgba(0,0,0,.4)'),
  'shadow.l2': token('--utopia-shadow-l2', PROPERTY_KIND.SHADOW, 'shadow', '0 4px 14px rgba(0,0,0,.45)'),

  'opacity.panel': token('--utopia-opacity-panel', PROPERTY_KIND.NUMBER, 'effect', '0.96'),
  'effect.blur': token('--utopia-effect-blur', PROPERTY_KIND.LENGTH, 'effect', '0px'),
  'effect.glow': token('--utopia-effect-glow', PROPERTY_KIND.NUMBER, 'effect', '0'),

  'asset.wallpaper': token('--utopia-asset-wallpaper', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.overlay': token('--utopia-asset-overlay', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.panel_texture': token('--utopia-asset-panel-texture', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.icon_set': token('--utopia-asset-icon-set', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.persona_avatar': token('--utopia-asset-persona-avatar', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.persona_banner': token('--utopia-asset-persona-banner', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.decoration': token('--utopia-asset-decoration', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.surface_character': token('--utopia-asset-surface-character', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.overlay_character': token('--utopia-asset-overlay-character', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.overlay_character_secondary': token('--utopia-asset-overlay-character-secondary', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.overlay_skin': token('--utopia-asset-overlay-skin', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.overlay_texture': token('--utopia-asset-overlay-texture', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.shell_frame': token('--utopia-asset-shell-frame', PROPERTY_KIND.ASSET, 'asset', 'none'),

  // Overlay effect strengths. Validated against the ceiling table in
  // `validation/validator.mjs`, so a package cannot invent an effect.
  'overlay.tint.opacity': token('--utopia-overlay-tint-opacity', PROPERTY_KIND.NUMBER, 'effect', '0'),
  'overlay.vignette.opacity': token('--utopia-overlay-vignette-opacity', PROPERTY_KIND.NUMBER, 'effect', '0'),
  'overlay.scanline.opacity': token('--utopia-overlay-scanline-opacity', PROPERTY_KIND.NUMBER, 'effect', '0'),
  'overlay.frame_glow.opacity': token('--utopia-overlay-frame-glow-opacity', PROPERTY_KIND.NUMBER, 'effect', '0'),
  'overlay.texture.opacity': token('--utopia-overlay-texture-opacity', PROPERTY_KIND.NUMBER, 'effect', '0'),
  'overlay.character.opacity': token('--utopia-overlay-character-opacity', PROPERTY_KIND.NUMBER, 'effect', '0'),
  'overlay.character.coverage': token('--utopia-overlay-character-coverage', PROPERTY_KIND.NUMBER, 'effect', '0'),

  // External shell chrome strengths.
  'shell.padding': token('--utopia-shell-padding', PROPERTY_KIND.LENGTH, 'spacing', '0px'),
  'shell.border_width': token('--utopia-shell-border-width', PROPERTY_KIND.LENGTH, 'spacing', '0px'),
  'shell.radius': token('--utopia-shell-radius', PROPERTY_KIND.LENGTH, 'radius', '0px'),
});

export const TOKEN_NAMES = Object.freeze(Object.keys(TOKENS));

/** Token groups, exposed for the UI. */
export const TOKEN_GROUPS = Object.freeze(
  TOKEN_NAMES.reduce((acc, name) => {
    const group = TOKENS[name].group;
    if (!acc[group]) acc[group] = [];
    acc[group].push(name);
    return acc;
  }, {}),
);

/**
 * Pairs validated for readability. `min` is the minimum contrast ratio the package
 * validator enforces before a package is accepted.
 *
 * Canonical state colours are deliberately absent: they are swatches, not text, so
 * forcing each of the ten onto a text-grade ratio would collapse them into two
 * identical extremes. State legibility is enforced by `STATE_VISIBILITY_MIN` (a
 * swatch must be visible at all) plus `STATE_MIN_DISTANCE` (states must stay
 * distinguishable).
 */
export const CONTRAST_REQUIREMENTS = Object.freeze([
  { foreground: 'color.label.primary', background: 'color.bg.base', min: 4.5, label: 'primary label on base' },
  { foreground: 'color.label.primary', background: 'color.bg.layer1', min: 4.5, label: 'primary label on layer1' },
  { foreground: 'color.label.primary', background: 'color.bg.layer2', min: 4.5, label: 'primary label on layer2' },
  { foreground: 'color.label.secondary', background: 'color.bg.layer1', min: 3, label: 'secondary label on layer1' },
  { foreground: 'color.label.tertiary', background: 'color.bg.layer1', min: 2, label: 'tertiary label on layer1' },
  { foreground: 'color.label.inverse', background: 'color.accent.primary', min: 3, label: 'inverse label on accent' },
]);

/**
 * Minimum contrast a state swatch needs against the content layer to be legible at
 * all: the requirement is "you can see the state", not "the state is body text".
 */
export const STATE_VISIBILITY_MIN = 1.6;

/** Minimum perceptual spacing required between two canonical state colours. */
export const STATE_MIN_DISTANCE = 24;

/** The apps a package may declare support for. */
export const SUPPORTED_APPS = Object.freeze(['utopia']);

/** Built-in token document: every token at its fallback value. */
export function defaultTokens() {
  const tokens = {};
  for (const name of TOKEN_NAMES) tokens[name] = TOKENS[name].fallback;
  return tokens;
}
