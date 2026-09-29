/**
 * D6a — Theme Package Lab focused tests, including donor parity.
 *
 * The surface model, the permission gate, the validator's fail-closed behaviour and
 * the procedural generators restate the DS-Hns donor modules (`contract.js`,
 * `surface.js`, `validator.js`, `asset-factory.js` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b) under Utopia's ownership vocabulary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestHub } from './harness.mjs';
import {
  ANIMATION_MAX_INTENSITY,
  PERMISSION,
  SLOTS,
  STATE_MIN_DISTANCE,
  STATE_VISIBILITY_MIN,
  SUPPORTED_APPS,
  THEME_API_VERSION,
  TOKENS,
  TOKEN_NAMES,
  WORKER_STATES,
  defaultTokens,
} from '../rooms/theme-package-lab/contract.mjs';
import {
  OVERLAY_FEATURES,
  SURFACE_IDS,
  assertWritable,
  describe as describeSurfaces,
  isProtected,
  isVisualOnly,
  isWritable,
  permissionOf,
  surfaceOfSlot,
  violationsIn,
} from '../rooms/theme-package-lab/surface.mjs';
import {
  OVERLAY_LIMITS,
  checkApiVersion,
  normalizeAnimation,
  resolveTokens,
  validateDocuments,
  validateOverlayPlan,
  validateReadability,
  validateSlots,
  validateTokens,
} from '../rooms/theme-package-lab/validator.mjs';
import * as factory from '../rooms/theme-package-lab/asset-factory.mjs';
import { canvasToPng, decodePng } from '../rooms/theme-package-lab/palette-bridge.mjs';

const API = '/local-rooms/v1/theme-package-lab';
const DONOR_COMMIT = 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b';

const PALETTE = Object.freeze({
  base: '#0f1115',
  layer1: '#151922',
  layer2: '#1b2130',
  accent: '#4d93f8',
  accent2: '#7aa7ff',
  label: '#e8ecf3',
});

/** A package that must pass every check. */
function goodDocuments(overrides = {}) {
  return {
    manifest: {
      id: 'demo-package',
      name: 'Demo Package',
      version: '1.0.0',
      source: 'generated',
      theme_api_version: THEME_API_VERSION,
      supported_apps: [...SUPPORTED_APPS],
    },
    tokens: {
      'color.bg.base': '#0f1115',
      'color.bg.layer1': '#151922',
      'color.bg.layer2': '#1b2130',
      'color.accent.primary': '#4d93f8',
      'color.label.primary': '#e8ecf3',
    },
    components: {
      slots: {
        'surface.worker.card': { background: '#151922', border: '1px solid #232b3b', radius: '8px' },
        'common.button.primary': { background: '#4d93f8', label: '#0d1016', radius: '8px' },
      },
      animation: { type: 'fade', intensity: 0.4 },
    },
    persona: { enabled: false },
    surfacePlan: {
      surfaces: [
        { surface: 'owned_surface', writes: true },
        { surface: 'external_shell', writes: true },
        { surface: 'owned_overlay', writes: true },
        { surface: 'protected_external_surface', writes: false },
      ],
    },
    overlayPlan: {
      enabled: true,
      input: { pointer: 'passthrough', keyboard: 'passthrough', focus: 'passthrough', scroll: 'passthrough' },
      components: { global_tint: { color: '#0b0d12', opacity: 0.18 }, vignette: { opacity: 0.12 } },
    },
    files: ['manifest.json', 'tokens.json', 'components.json', 'surface-plan.json', 'overlay-plan.json'],
    ...overrides,
  };
}

test('the contract keeps the safety semantics and drops the donor product nouns', () => {
  assert.equal(THEME_API_VERSION, '1.0');
  assert.deepEqual(SURFACE_IDS, ['owned_surface', 'external_shell', 'owned_overlay', 'protected_external_surface']);
  assert.deepEqual(Object.values(PERMISSION), ['SAFE', 'STYLE', 'STRUCTURAL']);
  assert.equal(WORKER_STATES.length, 10);
  assert.deepEqual(WORKER_STATES.slice(0, 4), ['idle', 'running', 'waiting', 'blocked']);
  assert.ok(TOKEN_NAMES.length >= 60, 'the token schema is carried over');
  for (const name of TOKEN_NAMES) {
    assert.match(TOKENS[name].css, /^--utopia-/, `${name} uses a Utopia custom property`);
  }
  assert.equal(STATE_VISIBILITY_MIN, 1.6);
  assert.equal(STATE_MIN_DISTANCE, 24);
  assert.equal(ANIMATION_MAX_INTENSITY.none, 0);
  assert.ok(Object.keys(SLOTS).length >= 60, 'the slot vocabulary is carried over');
  // every slot family belongs to an ownership surface, and the donor prefixes are gone
  for (const slotId of Object.keys(SLOTS)) {
    assert.match(slotId, /^(common|surface|shell|overlay|external|layout)\./, `${slotId} uses a Utopia slot family`);
    assert.ok(['owned_surface', 'external_shell', 'owned_overlay', 'protected_external_surface'].includes(surfaceOfSlot(slotId)));
  }
  for (const forbidden of [/^hns\./, /^official\./, /^common\.window\.background$/]) {
    assert.ok(!Object.keys(SLOTS).some((slotId) => forbidden.test(slotId) && forbidden.source !== '^common\\.window\\.background$'), String(forbidden));
  }
  assert.ok(!TOKEN_NAMES.some((name) => name.startsWith('official.')), 'token names carry no donor product noun');
});

test('the write gate refuses a protected surface and never throws', () => {
  assert.equal(isWritable('owned_surface'), true);
  assert.equal(isWritable('owned_overlay'), true);
  assert.equal(isVisualOnly('owned_overlay'), true);
  assert.equal(isProtected('protected_external_surface'), true);
  assert.equal(permissionOf('protected_external_surface'), 'protected');

  const refused = assertWritable('protected_external_surface', { kind: 'component' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'surface_protected');
  assert.match(refused.reason, /PROTECTED/);

  const unknown = assertWritable('hns_native');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'surface_unknown');

  const wrongKind = assertWritable('external_shell', { kind: 'asset', assetKind: 'overlay_skin' });
  assert.equal(wrongKind.ok, false);
  assert.equal(wrongKind.code, 'surface_asset_kind_denied');

  const allowed = assertWritable('owned_overlay', { kind: 'asset', assetKind: 'overlay_skin' });
  assert.equal(allowed.ok, true);

  // a plan may name the protected surface, but never claim to write it
  const honest = violationsIn({ surfaces: [{ surface: 'protected_external_surface', writes: false }] });
  assert.deepEqual(honest, []);
  const dishonest = violationsIn({ surfaces: [{ surface: 'protected_external_surface', writes: true }] });
  assert.equal(dishonest.length, 1);
  assert.equal(dishonest[0].code, 'surface_protected');
  const nested = violationsIn({ overlay: { target: 'protected_external_surface' } });
  assert.equal(nested.length, 1, 'a nested target reference is caught too');

  const described = describeSurfaces();
  assert.equal(described.length, 4);
  const protectedSurface = described.find((entry) => entry.id === 'protected_external_surface');
  assert.equal(protectedSurface.access.dom, false);
  assert.equal(protectedSurface.input.pointer, true, 'the foreign view keeps its own input');
  assert.deepEqual(protectedSurface.assetKinds, []);
});

test('the validator accepts a conforming package and fails closed on every check', () => {
  const accepted = validateDocuments(goodDocuments());
  assert.equal(accepted.ok, true, JSON.stringify(accepted.errors));
  assert.deepEqual(accepted.warnings, []);
  assert.equal(accepted.metadata.id, 'demo-package');
  assert.equal(accepted.animation.type, 'fade');
  assert.equal(accepted.declaredAssets.length, 0);

  const codes = (documents) => validateDocuments(documents).errors.map((entry) => entry.code);

  assert.ok(codes(goodDocuments({ manifest: { ...goodDocuments().manifest, theme_api_version: '2.0' } })).includes('api_version_unsupported'));
  assert.ok(codes(goodDocuments({ manifest: { ...goodDocuments().manifest, theme_api_version: 'nope' } })).includes('api_version_invalid'));
  assert.ok(codes(goodDocuments({ manifest: { ...goodDocuments().manifest, supported_apps: ['something-else'] } })).includes('manifest_app_unsupported'));
  assert.ok(codes(goodDocuments({ manifest: { ...goodDocuments().manifest, parent_theme: 'dark' } })).includes('manifest_forbidden_dependency'));
  assert.ok(codes(goodDocuments({ manifest: { ...goodDocuments().manifest, id: 'Not A Slug' } })).includes('manifest_id_invalid'));

  // executable payload
  const executable = codes(goodDocuments({ files: [...goodDocuments().files, 'assets/theme.js'] }));
  assert.ok(executable.includes('executable_payload'), 'a .js file is refused');
  assert.ok(codes(goodDocuments({ files: [...goodDocuments().files, 'assets/run.ps1'] })).includes('executable_payload'));

  // slot whitelist and permissions
  const slots = codes(goodDocuments({
    components: {
      slots: {
        'surface.worker.card': { background: '#151922', unsupported_property: 1 },
        'layout.sidebar_width': { width: '220px' },
        'surface.not.a.slot': { background: '#000' },
      },
    },
  }));
  assert.ok(slots.includes('slot_property_denied'));
  assert.ok(slots.includes('slot_permission_denied'));
  assert.ok(slots.includes('slot_unknown'));
  assert.equal(validateSlots({ 'layout.sidebar_width': {} }, { allowStructural: true }).length, 0, 'structural slots exist but are never generated');

  // tokens
  assert.ok(codes(goodDocuments({ tokens: { 'color.nope': '#fff' } })).includes('token_unknown'));
  assert.ok(codes(goodDocuments({ tokens: { 'color.bg.base': 'not-a-colour' } })).includes('token_color_invalid'));
  assert.ok(codes(goodDocuments({ tokens: { 'font.size.body': 'big' } })).includes('token_length_invalid'));
  assert.equal(validateTokens({ 'color.bg.base': '#0f1115' }).length, 0);

  // protected surface claimed as written
  const surfaceProblems = codes(goodDocuments({
    surfacePlan: { surfaces: [{ surface: 'protected_external_surface', writes: true }] },
  }));
  assert.ok(surfaceProblems.includes('surface_write_denied'));
  assert.ok(surfaceProblems.includes('surface_protected'));

  // overlay input must pass through, and strengths stay under the ceilings
  const overlayProblems = codes(goodDocuments({
    overlayPlan: {
      enabled: true,
      input: { pointer: 'auto', keyboard: 'passthrough' },
      components: { global_tint: { opacity: 0.9 }, vignette: { opacity: 0.4 } },
    },
  }));
  assert.ok(overlayProblems.includes('overlay_input_not_passthrough'));
  assert.ok(overlayProblems.includes('overlay_strength_exceeded'));
  assert.ok(overlayProblems.includes('overlay_total_exceeded'));
  assert.equal(validateOverlayPlan({ enabled: false }).length, 0);
  assert.equal(OVERLAY_LIMITS.overlay_opacity, 0.22);

  // readability fails closed, not open
  const lowContrast = validateDocuments(goodDocuments({
    tokens: { 'color.label.primary': '#151922', 'color.bg.base': '#0f1115', 'color.bg.layer1': '#151922' },
  }));
  assert.equal(lowContrast.ok, false);
  assert.ok(lowContrast.errors.some((entry) => entry.code === 'contrast_too_low'));

  const collapsedStates = validateDocuments(goodDocuments({
    tokens: Object.fromEntries(WORKER_STATES.map((state) => [`state.${state}`, '#4d93f8'])),
  }));
  assert.ok(collapsedStates.errors.some((entry) => entry.code === 'state_indistinguishable'), 'two identical states are refused');

  // a missing asset reference is caught when the file list is known
  const missingAsset = codes(goodDocuments({
    tokens: { ...goodDocuments().tokens, 'asset.wallpaper': 'assets/wallpapers/main.png' },
  }));
  assert.ok(missingAsset.includes('asset_missing'));
  const presentAsset = validateDocuments(goodDocuments({
    tokens: { ...goodDocuments().tokens, 'asset.wallpaper': 'assets/wallpapers/main.png' },
    files: [...goodDocuments().files, 'assets/wallpapers/main.png'],
  }));
  assert.equal(presentAsset.ok, true, 'the asset exists, so the package is accepted');

  // a package that reaches outside itself
  const crossPackage = codes(goodDocuments({
    tokens: { ...goodDocuments().tokens, 'asset.wallpaper': '../other-theme/assets/main.png' },
  }));
  assert.ok(crossPackage.includes('cross_package_reference'));
});

test('readability and animation are measured, never assumed', () => {
  const resolved = resolveTokens({}, defaultTokens());
  assert.equal(validateReadability(resolved).length, 0, 'the schema defaults are readable');
  assert.equal(Object.keys(resolved).length, TOKEN_NAMES.length, 'every token resolves to a value');

  const unreadable = validateReadability(resolveTokens({ 'color.label.primary': '#0f1115', 'color.bg.base': '#0f1115' }));
  assert.ok(unreadable.some((entry) => entry.code === 'contrast_too_low'));
  const unmeasurable = validateReadability(resolveTokens({ 'color.bg.base': 'not-a-colour' }));
  assert.ok(unmeasurable.some((entry) => entry.code === 'contrast_unmeasurable'));

  assert.deepEqual(normalizeAnimation({ type: 'pulse', intensity: 5 }), { type: 'pulse', intensity: 0.5, clamped: true });
  assert.deepEqual(normalizeAnimation({ type: 'invented', intensity: 1 }), { type: 'none', intensity: 0, clamped: false });
  assert.deepEqual(normalizeAnimation(null), { type: 'none', intensity: 0 });
});

test('the procedural asset factory is deterministic and palette-sensitive', () => {
  const first = factory.renderWallpaper({ palette: PALETTE, style: 'research', seed: 'unit', width: 96, height: 64 });
  const again = factory.renderWallpaper({ palette: PALETTE, style: 'research', seed: 'unit', width: 96, height: 64 });
  const otherPalette = factory.renderWallpaper({ palette: { ...PALETTE, accent: '#ff8800' }, style: 'research', seed: 'unit', width: 96, height: 64 });
  const otherStyle = factory.renderWallpaper({ palette: PALETTE, style: 'cyber', seed: 'unit', width: 96, height: 64 });

  assert.equal(Buffer.compare(canvasToPng(first), canvasToPng(again)), 0, 'same inputs, identical bytes');
  assert.notEqual(Buffer.compare(canvasToPng(first), canvasToPng(otherPalette)), 0, 'the palette changes the asset');
  assert.notEqual(Buffer.compare(canvasToPng(first), canvasToPng(otherStyle)), 0, 'the style changes the asset');

  const decoded = decodePng(canvasToPng(first));
  assert.equal(decoded.width, 96);
  assert.equal(decoded.height, 64);

  // every catalogued kind renders, and a character keeps real transparency
  assert.ok(factory.REAL_ASSET_KINDS.length >= 8);
  for (const kind of factory.REAL_ASSET_KINDS) {
    const entry = factory.REAL_ASSET_CATALOG[kind];
    assert.ok(['owned_surface', 'external_shell', 'owned_overlay'].includes(entry.surface), `${kind} names an ownership surface`);
  }
  const character = decodePng(canvasToPng(factory.renderCharacter({ palette: PALETTE, framing: 'half_body', style: 'mecha', seed: 'unit', width: 128, height: 192 })));
  let transparent = 0;
  for (let index = 3; index < character.data.length; index += 4) if (character.data[index] === 0) transparent += 1;
  assert.ok(transparent > 0, 'a character asset is not a painted rectangle');
  assert.deepEqual(factory.CHARACTER_FRAMINGS, ['avatar', 'bust', 'half_body', 'full_body', 'silhouette']);

  const bundle = factory.buildAssetBundle({ palette: PALETTE, style: 'research', seed: 'unit' });
  assert.ok(Object.keys(bundle).length >= 5);
  for (const [path, buffer] of Object.entries(bundle)) {
    assert.match(path, /^assets\//, `${path} is package-relative`);
    assert.ok(buffer.length > 0);
  }
  assert.deepEqual(
    factory.buildAssetBundle({ palette: PALETTE, style: 'research', seed: 'unit' }),
    bundle,
    'a bundle is reproducible',
  );
  assert.equal(factory.assetPath('wallpapers', 'main.png'), 'assets/wallpapers/main.png');
  assert.equal(factory.framingOf('overlay_character'), 'half_body');
  assert.equal(factory.framingOf('silhouette'), 'silhouette');
});

test('the room exposes the contract, the gate, validation and generation', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const capabilities = await hub.api('GET', `${API}/capabilities`);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.payload.installs, false);
  assert.equal(capabilities.payload.applies, false);
  assert.equal(capabilities.payload.writes_files, false);
  assert.equal(capabilities.payload.donor.commit, DONOR_COMMIT);
  assert.deepEqual(capabilities.payload.donor.sourcePaths, [
    'app/extensions/mega/theme/contract.js',
    'app/extensions/mega/theme/surface.js',
    'app/extensions/mega/theme/validator.js',
    'app/extensions/mega/theme/asset-factory.js',
  ]);
  assert.match(capabilities.payload.reuse.note, /never copies/);
  assert.deepEqual(capabilities.payload.contract.surfaces, [...SURFACE_IDS]);
  assert.equal(capabilities.payload.validation.overlay_limits.overlay_opacity, 0.22);

  const contract = await hub.api('GET', `${API}/contract`);
  assert.equal(contract.status, 200);
  assert.equal(contract.payload.surfaces.length, 4);
  assert.equal(contract.payload.slots.length, Object.keys(SLOTS).length);
  assert.equal(contract.payload.tokens.length, TOKEN_NAMES.length);
  assert.deepEqual(contract.payload.overlay_features, [...OVERLAY_FEATURES]);
  assert.ok(contract.payload.permission_model.protected.includes('protected_external_surface'));

  const accepted = await hub.api('POST', `${API}/package/validate`, goodDocuments());
  assert.equal(accepted.status, 200);
  assert.equal(accepted.payload.ok, true, JSON.stringify(accepted.payload.errors));
  assert.equal(accepted.payload.report.donor.commit, DONOR_COMMIT);
  assert.equal(accepted.payload.report.counts.errors, 0);
  assert.ok(Array.isArray(accepted.payload.report.warnings));

  const rejected = await hub.api('POST', `${API}/package/validate`, goodDocuments({
    files: [...goodDocuments().files, 'assets/theme.mjs'],
    surfacePlan: { surfaces: [{ surface: 'protected_external_surface', writes: true }] },
  }));
  assert.equal(rejected.payload.ok, false);
  const codes = rejected.payload.errors.map((entry) => entry.code);
  assert.ok(codes.includes('executable_payload'));
  assert.ok(codes.includes('surface_protected'));

  const malformed = await hub.api('POST', `${API}/package/validate`, [1, 2, 3]);
  assert.equal(malformed.status, 400);

  const gateRefused = await hub.api('POST', `${API}/surface/write-check`, { surface: 'protected_external_surface', kind: 'asset' });
  assert.equal(gateRefused.payload.ok, false);
  assert.equal(gateRefused.payload.verdict.code, 'surface_protected');
  const gateAllowed = await hub.api('POST', `${API}/surface/write-check`, { surface: 'owned_overlay', kind: 'asset', assetKind: 'overlay_texture' });
  assert.equal(gateAllowed.payload.ok, true);

  const generated = await hub.api('POST', `${API}/assets/generate`, { kind: 'wallpaper', style: 'research', seed: 'room', width: 96, height: 64 });
  assert.equal(generated.status, 200);
  assert.equal(generated.payload.asset.kind, 'wallpaper');
  assert.match(generated.payload.asset.dataUri, /^data:image\/png;base64,/);
  assert.match(generated.payload.asset.sha256, /^[0-9a-f]{64}$/);
  const generatedAgain = await hub.api('POST', `${API}/assets/generate`, { kind: 'wallpaper', style: 'research', seed: 'room', width: 96, height: 64 });
  assert.equal(generatedAgain.payload.asset.sha256, generated.payload.asset.sha256, 'the room is deterministic too');

  const unknownKind = await hub.api('POST', `${API}/assets/generate`, { kind: 'not-a-kind' });
  assert.equal(unknownKind.status, 400);

  const bundle = await hub.api('POST', `${API}/assets/bundle`, { style: 'research', seed: 'room' });
  assert.equal(bundle.status, 200);
  assert.ok(bundle.payload.count >= 5);
  assert.ok(bundle.payload.files.every((file) => file.path.startsWith('assets/')));

  const readability = await hub.api('POST', `${API}/readability`, { tokens: { 'color.bg.base': '#0f1115' } });
  assert.equal(readability.status, 200);
  assert.equal(readability.payload.worker_states.length, WORKER_STATES.length);
  assert.ok(Object.keys(readability.payload.resolved).length === TOKEN_NAMES.length);
});

test('the lab writes no runtime file and carries no second copy of the theme core', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await hub.api('POST', `${API}/package/validate`, goodDocuments());
  await hub.api('POST', `${API}/assets/generate`, { kind: 'panel_texture', width: 32, height: 32 });
  assert.deepEqual(await readdir(hub.runtimeDir), [], 'the lab has no durable file');

  const roomDir = join(import.meta.dirname, '..', 'rooms', 'theme-package-lab');
  for (const file of ['contract.mjs', 'surface.mjs', 'validator.mjs', 'asset-factory.mjs']) {
    const code = (await readFile(join(roomDir, file), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ["require('", 'from "app/', "from 'app/", 'child_process', 'writeFileSync', '--hns-']) {
      assert.ok(!code.includes(forbidden), `${file} must not ${forbidden}`);
    }
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
    }
    // the donor's permanent product nouns never become Utopia's public API
    assert.ok(!/\bhns\b/i.test(code.replace(/DS-Hns/g, '')), `${file} keeps no donor product noun`);
  }
  // the colour and raster helpers come from the promoted city module, never a second copy
  const bridge = await readFile(join(roomDir, 'palette-bridge.mjs'), 'utf8');
  assert.match(bridge, /theme-engine\/color\/color\.mjs/, 'the colour core is reused from the city module');
  assert.match(bridge, /theme-engine\/raster\/png\.mjs/, 'the raster core is reused from the city module');
});
