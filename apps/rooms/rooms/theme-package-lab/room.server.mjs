/**
 * UTOPIA · Rooms · Room D6 — Theme Package Lab (server).
 *
 * Incubator for the DS-Hns theme contract, surface model, package validator and
 * procedural asset factory: describe the ownership surfaces, validate a package
 * document set, generate deterministic assets and read the readability report.
 *
 * Donor: zhiheng-zhang-Mera/DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b
 *        app/extensions/mega/theme/contract.js, surface.js, validator.js, asset-factory.js
 *
 * This room installs nothing, applies nothing and writes no file: it produces
 * documents, validation reports and PNG bytes as JSON.
 */

import { createHash } from 'node:crypto';
import { createRouter, sendJson } from '../../shared/http.mjs';
import { RoomValidationError } from '../../shared/room-kit.mjs';
import {
  ANIMATION_PRESETS,
  PERMISSION,
  SLOTS,
  STATE_MIN_DISTANCE,
  STATE_VISIBILITY_MIN,
  SUPPORTED_APPS,
  THEME_API_VERSION,
  TOKENS,
  TOKEN_GROUPS,
  TOKEN_NAMES,
  WORKER_STATES,
  defaultTokens,
} from './contract.mjs';
import { LAYOUT_MODES, OVERLAY_FEATURES, SURFACE_IDS, assertWritable, describe as describeSurfaces } from './surface.mjs';
import {
  ASSET_DIRS,
  OVERLAY_LIMITS,
  PACKAGE_DOCUMENTS,
  VALIDATION_REQUIREMENTS,
  validateDocuments,
  validateReadability,
  resolveTokens,
} from './validator.mjs';
import {
  CHARACTER_FRAMINGS,
  REAL_ASSET_CATALOG,
  REAL_ASSET_KINDS,
  buildAssetBundle,
  renderBanner,
  renderCharacter,
  renderDecoration,
  renderFrameDecoration,
  renderHudDecoration,
  renderIconSheet,
  renderOverlaySkin,
  renderOverlayTexture,
  renderPanel,
  renderPersona,
  renderTrayIcon,
  renderWallpaper,
} from './asset-factory.mjs';
import { canvasToDataUri, canvasToPng } from './palette-bridge.mjs';

const DONOR = Object.freeze({
  repository: 'zhiheng-zhang-Mera/DS-Hns',
  commit: 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b',
  sourcePaths: [
    'app/extensions/mega/theme/contract.js',
    'app/extensions/mega/theme/surface.js',
    'app/extensions/mega/theme/validator.js',
    'app/extensions/mega/theme/asset-factory.js',
  ],
});

/** The procedural generators this room exposes, by asset kind. */
const GENERATORS = Object.freeze({
  wallpaper: renderWallpaper,
  panel_texture: renderPanel,
  persona_avatar: renderPersona,
  persona_banner: renderBanner,
  decoration: renderDecoration,
  icon_set: renderIconSheet,
  tray_icon: renderTrayIcon,
  surface_character: renderCharacter,
  overlay_character: renderCharacter,
  overlay_skin: renderOverlaySkin,
  overlay_texture: renderOverlayTexture,
  hud_decoration: renderHudDecoration,
  frame_decoration: renderFrameDecoration,
});

/** Default canvas per generator, used when a request does not size the asset. */
const DEFAULT_SIZE = Object.freeze({
  wallpaper: [640, 400],
  panel_texture: [320, 128],
  persona_avatar: [128, 128],
  persona_banner: [480, 72],
  decoration: [256, 256],
  icon_set: [128, 128],
  tray_icon: [32, 32],
  overlay_texture: [256, 256],
  hud_decoration: [384, 384],
  frame_decoration: [960, 600],
  overlay_skin: [960, 600],
  surface_character: [256, 384],
  overlay_character: [256, 384],
});

/** The palette the generators consume, derived from a token document. */
const PALETTE_TOKENS = Object.freeze({
  base: 'color.bg.base',
  layer1: 'color.bg.layer1',
  layer2: 'color.bg.layer2',
  accent: 'color.accent.primary',
  accent2: 'color.accent.secondary',
  label: 'color.label.primary',
});

function requireObject(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RoomValidationError('payload must be a JSON object');
  }
  return payload;
}

function optionalDocument(payload, key) {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RoomValidationError(`${key} must be a JSON object`);
  }
  return value;
}

/** A token document validated as a document: string values only, keys may be unknown. */
function optionalTokens(payload) {
  const tokens = optionalDocument(payload, 'tokens');
  if (!tokens) return null;
  const out = {};
  for (const [name, value] of Object.entries(tokens)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') throw new RoomValidationError(`token ${name} must be a scalar value`);
    out[name] = String(value);
  }
  return out;
}

/** Build the generator palette from a token document, with the schema fallback. */
export function paletteFromTokens(tokens) {
  const resolved = resolveTokens(tokens || {}, defaultTokens());
  const palette = {};
  for (const [key, tokenName] of Object.entries(PALETTE_TOKENS)) palette[key] = resolved[tokenName];
  palette.state = {};
  for (const state of WORKER_STATES) palette.state[state] = resolved[`state.${state}`];
  return palette;
}

function clampSize(value, fallback) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(8, Math.min(1024, numeric));
}

/** Render one procedural asset and describe the bytes it produced. */
export function generateAsset(payload) {
  const kind = String(payload.kind || 'wallpaper');
  const render = GENERATORS[kind];
  if (typeof render !== 'function') {
    throw new RoomValidationError(`unknown asset kind "${kind}" (known: ${Object.keys(GENERATORS).sort().join(', ')})`);
  }
  const fallback = DEFAULT_SIZE[kind] || [256, 256];
  const width = clampSize(payload.width, fallback[0]);
  const height = clampSize(payload.height, fallback[1]);
  const palette = paletteFromTokens(optionalTokens(payload));
  const style = String(payload.style || 'research');
  const seed = String(payload.seed || `${kind}:${style}`);
  const framing = String(payload.framing || REAL_ASSET_CATALOG[kind]?.framing || 'half_body');
  const wantsFraming = kind === 'surface_character' || kind === 'overlay_character';
  const canvas = render({
    palette,
    style,
    seed,
    width,
    height,
    ...(wantsFraming ? { framing, character: String(payload.character || style) } : {}),
  });
  const png = canvasToPng(canvas);
  return {
    kind,
    style,
    seed,
    width,
    height,
    requested: { width: payload.width ?? null, height: payload.height ?? null },
    bytes: png.length,
    opaque: kind === 'wallpaper' || kind === 'panel_texture',
    dataUri: canvasToDataUri(canvas),
    sha256: createSha256(png),
  };
}

function createSha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Create the Theme Package Lab route handler (no durable store). */
export function createThemePackageRoom() {
  const route = createRouter([
    {
      method: 'GET',
      pattern: '/capabilities',
      handle: async ({ res }) => {
        sendJson(res, 200, {
          room: 'theme-package-lab',
          theme_api_version: THEME_API_VERSION,
          installs: false,
          applies: false,
          writes_files: false,
          donor: DONOR,
          reuse: {
            color: 'city/11-entertainment/01-entertainment-centre/theme-engine/color/color.mjs',
            raster: 'city/11-entertainment/01-entertainment-centre/theme-engine/raster/png.mjs',
            note: 'wave 1 already ported the colour and raster helpers; this room never copies them',
          },
          contract: {
            surfaces: SURFACE_IDS,
            permissions: Object.values(PERMISSION),
            tokens: TOKEN_NAMES.length,
            slots: Object.keys(SLOTS).length,
            worker_states: WORKER_STATES.length,
            supported_apps: SUPPORTED_APPS,
          },
          validation: {
            documents: PACKAGE_DOCUMENTS,
            asset_dirs: ASSET_DIRS,
            overlay_limits: OVERLAY_LIMITS,
            requirements: VALIDATION_REQUIREMENTS,
          },
          assets: {
            kinds: REAL_ASSET_KINDS,
            generators: Object.keys(GENERATORS).sort(),
            framings: CHARACTER_FRAMINGS,
          },
        });
      },
    },
    {
      method: 'GET',
      pattern: '/contract',
      handle: async ({ res }) => {
        sendJson(res, 200, {
          ok: true,
          theme_api_version: THEME_API_VERSION,
          surfaces: describeSurfaces(),
          permission_model: {
            permissions: Object.values(PERMISSION),
            generator_permissions: [PERMISSION.SAFE, PERMISSION.STYLE],
            protected: SURFACE_IDS.filter((id) => !assertWritable(id).ok),
          },
          slots: Object.entries(SLOTS).map(([id, definition]) => ({
            id,
            type: definition.type,
            permission: definition.permission,
            properties: [...definition.properties],
          })),
          tokens: TOKEN_NAMES.map((name) => ({ name, css: TOKENS[name].css, kind: TOKENS[name].kind, group: TOKENS[name].group })),
          token_groups: TOKEN_GROUPS,
          worker_states: WORKER_STATES,
          animation_presets: ANIMATION_PRESETS,
          layout_modes: LAYOUT_MODES,
          overlay_features: OVERLAY_FEATURES,
          readability: { state_visibility_min: STATE_VISIBILITY_MIN, state_min_distance: STATE_MIN_DISTANCE },
          asset_kinds: REAL_ASSET_CATALOG,
        });
      },
    },
    {
      method: 'POST',
      pattern: '/package/validate',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const tokens = optionalTokens(payload);
        const files = Array.isArray(payload.files) ? payload.files.map(String) : null;
        const assets = Array.isArray(payload.assets) ? payload.assets.map(String) : null;
        const report = validateDocuments({
          manifest: optionalDocument(payload, 'manifest'),
          tokens,
          components: optionalDocument(payload, 'components'),
          persona: optionalDocument(payload, 'persona'),
          surfacePlan: optionalDocument(payload, 'surfacePlan'),
          overlayPlan: optionalDocument(payload, 'overlayPlan'),
          files,
          assets,
          fallbackTokens: defaultTokens(),
          expectedId: payload.expectedId ? String(payload.expectedId) : null,
        });
        sendJson(res, 200, {
          ok: report.ok,
          errors: report.errors,
          warnings: report.warnings,
          metadata: report.metadata,
          animation: report.animation,
          declared_assets: report.declaredAssets,
          report: exportReport(report),
        });
      },
    },
    {
      method: 'POST',
      pattern: '/readability',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const resolved = resolveTokens(optionalTokens(payload) || {}, defaultTokens());
        const issues = validateReadability(resolved);
        const pairs = Object.entries(PALETTE_TOKENS).map(([key, tokenName]) => ({ key, token: tokenName, value: resolved[tokenName] }));
        sendJson(res, 200, {
          ok: issues.length === 0,
          issues,
          primary: pairs,
          worker_states: WORKER_STATES.map((state) => ({ state, color: resolved[`state.${state}`] })),
          resolved,
        });
      },
    },
    {
      method: 'POST',
      pattern: '/assets/generate',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        sendJson(res, 200, { ok: true, asset: generateAsset(payload) });
      },
    },
    {
      method: 'POST',
      pattern: '/assets/bundle',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const palette = paletteFromTokens(optionalTokens(payload));
        const style = String(payload.style || 'research');
        const seed = String(payload.seed || 'bundle');
        const persona = optionalDocument(payload, 'persona');
        const bundle = buildAssetBundle({ palette, style, seed, persona: persona || { enabled: false } });
        const files = Object.entries(bundle).map(([path, buffer]) => ({
          path,
          bytes: buffer.length,
          sha256: createSha256(buffer),
          dataUri: `data:image/png;base64,${buffer.toString('base64')}`,
        }));
        sendJson(res, 200, { ok: true, style, seed, count: files.length, files });
      },
    },
    {
      method: 'POST',
      pattern: '/surface/write-check',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const surface = String(payload.surface || '');
        const kind = String(payload.kind || 'component');
        const assetKind = payload.assetKind ? String(payload.assetKind) : null;
        const verdict = assertWritable(surface, { kind, assetKind });
        sendJson(res, 200, { ok: verdict.ok, verdict });
      },
    },
  ]);

  return { id: 'theme-package-lab', handle: route };
}

/** The exported validation report: a plain, paste-anywhere document. */
export function exportReport(report) {
  return {
    report_version: 1,
    theme_api_version: THEME_API_VERSION,
    donor: DONOR,
    ok: report.ok,
    metadata: report.metadata,
    animation: report.animation,
    declared_assets: report.declaredAssets || [],
    counts: {
      errors: report.errors.length,
      warnings: report.warnings.length,
      issues: report.issues.length,
    },
    errors: report.errors.map((entry) => ({ code: entry.code, message: entry.message, detail: entry.detail })),
    warnings: report.warnings.map((entry) => ({ code: entry.code, message: entry.message, detail: entry.detail })),
  };
}
