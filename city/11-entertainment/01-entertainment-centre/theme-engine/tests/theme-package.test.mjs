/**
 * UTOPIA · City · Theme Engine — theme package suite (D6a promotion).
 *
 * The surface model, the permission gate, the validator's fail-closed behaviour and
 * the procedural generators restate the DS-Hns donor modules (`contract.js`,
 * `surface.js`, `validator.js`, `asset-factory.js` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b) under Utopia's ownership vocabulary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
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
} from '../contract/contract.mjs';
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
} from '../contract/surface.mjs';
import {
  OVERLAY_LIMITS,
  VALIDATION_REQUIREMENTS,
  normalizeAnimation,
  resolveTokens,
  validateDocuments,
  validateOverlayPlan,
  validateReadability,
  validateSlots,
  validateTokens,
} from '../validation/validator.mjs';
import * as factory from '../assets/procedural/factory.mjs';
import { canvasToPng, decodePng } from '../raster/png.mjs';

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
  const base = {
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
  };
  return { ...base, ...overrides };
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
  for (const slotId of Object.keys(SLOTS)) {
    assert.match(slotId, /^(common|surface|shell|overlay|external|layout)\./, `${slotId} uses a Utopia slot family`);
    assert.ok(SURFACE_IDS.includes(surfaceOfSlot(slotId)), `${slotId} belongs to an ownership surface`);
  }
  assert.ok(!TOKEN_NAMES.some((name) => name.startsWith('official.')), 'token names carry no donor product noun');
  assert.ok(!Object.keys(SLOTS).some((slotId) => /^(hns|official)\./.test(slotId)), 'slot families carry no donor product noun');
  assert.equal(VALIDATION_REQUIREMENTS.length, 10, 'the published check list is complete');
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

  assert.deepEqual(violationsIn({ surfaces: [{ surface: 'protected_external_surface', writes: false }] }), []);
  const dishonest = violationsIn({ surfaces: [{ surface: 'protected_external_surface', writes: true }] });
  assert.equal(dishonest.length, 1);
  assert.equal(dishonest[0].code, 'surface_protected');
  assert.equal(violationsIn({ overlay: { target: 'protected_external_surface' } }).length, 1, 'a nested target reference is caught too');

  const described = describeSurfaces();
  assert.equal(described.length, 4);
  const guarded = described.find((entry) => entry.id === 'protected_external_surface');
  assert.equal(guarded.access.dom, false);
  assert.equal(guarded.input.pointer, true, 'the foreign view keeps its own input');
  assert.deepEqual(guarded.assetKinds, []);
  assert.deepEqual(described.map((entry) => entry.id), [...SURFACE_IDS]);
  assert.ok(OVERLAY_FEATURES.includes('character'));
});

test('the validator accepts a conforming package and fails closed on every check', () => {
  const accepted = validateDocuments(goodDocuments());
  assert.equal(accepted.ok, true, JSON.stringify(accepted.errors));
  assert.deepEqual(accepted.warnings, []);
  assert.equal(accepted.metadata.id, 'demo-package');
  assert.equal(accepted.animation.type, 'fade');

  const codes = (documents) => validateDocuments(documents).errors.map((entry) => entry.code);

  assert.ok(codes(goodDocuments({ manifest: { ...goodDocuments().manifest, theme_api_version: '2.0' } })).includes('api_version_unsupported'));
  assert.ok(codes(goodDocuments({ manifest: { ...goodDocuments().manifest, theme_api_version: 'nope' } })).includes('api_version_invalid'));
  assert.ok(codes(goodDocuments({ manifest: { ...goodDocuments().manifest, supported_apps: ['other-app'] } })).includes('manifest_app_unsupported'));
  assert.ok(codes(goodDocuments({ manifest: { ...goodDocuments().manifest, parent_theme: 'dark' } })).includes('manifest_forbidden_dependency'));
  assert.ok(codes(goodDocuments({ manifest: { ...goodDocuments().manifest, id: 'Not A Slug' } })).includes('manifest_id_invalid'));

  const executable = codes(goodDocuments({ files: [...goodDocuments().files, 'assets/theme.js'] }));
  assert.ok(executable.includes('executable_payload'), 'a .js file is refused');
  assert.ok(codes(goodDocuments({ files: [...goodDocuments().files, 'assets/run.ps1'] })).includes('executable_payload'));

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

  assert.ok(codes(goodDocuments({ tokens: { 'color.nope': '#fff' } })).includes('token_unknown'));
  assert.ok(codes(goodDocuments({ tokens: { 'color.bg.base': 'not-a-colour' } })).includes('token_color_invalid'));
  assert.ok(codes(goodDocuments({ tokens: { 'font.size.body': 'big' } })).includes('token_length_invalid'));
  assert.equal(validateTokens({ 'color.bg.base': '#0f1115' }).length, 0);

  const surfaceProblems = codes(goodDocuments({
    surfacePlan: { surfaces: [{ surface: 'protected_external_surface', writes: true }] },
  }));
  assert.ok(surfaceProblems.includes('surface_write_denied'));
  assert.ok(surfaceProblems.includes('surface_protected'));

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

  const lowContrast = validateDocuments(goodDocuments({
    tokens: { 'color.label.primary': '#151922', 'color.bg.base': '#0f1115', 'color.bg.layer1': '#151922' },
  }));
  assert.equal(lowContrast.ok, false);
  assert.ok(lowContrast.errors.some((entry) => entry.code === 'contrast_too_low'));

  const collapsedStates = validateDocuments(goodDocuments({
    tokens: Object.fromEntries(WORKER_STATES.map((state) => [`state.${state}`, '#4d93f8'])),
  }));
  assert.ok(collapsedStates.errors.some((entry) => entry.code === 'state_indistinguishable'), 'two identical states are refused');

  const missingAsset = codes(goodDocuments({
    tokens: { ...goodDocuments().tokens, 'asset.wallpaper': 'assets/wallpapers/main.png' },
  }));
  assert.ok(missingAsset.includes('asset_missing'));
  const presentAsset = validateDocuments(goodDocuments({
    tokens: { ...goodDocuments().tokens, 'asset.wallpaper': 'assets/wallpapers/main.png' },
    files: [...goodDocuments().files, 'assets/wallpapers/main.png'],
  }));
  assert.equal(presentAsset.ok, true, 'the asset exists, so the package is accepted');

  const crossPackage = codes(goodDocuments({
    tokens: { ...goodDocuments().tokens, 'asset.wallpaper': '../other-theme/assets/main.png' },
  }));
  assert.ok(crossPackage.includes('cross_package_reference'));
});

test('readability and animation are measured, never assumed', () => {
  const resolved = resolveTokens({}, defaultTokens());
  assert.equal(validateReadability(resolved).length, 0, 'the schema defaults are readable');
  assert.equal(Object.keys(resolved).length, TOKEN_NAMES.length, 'every token resolves to a value');

  assert.ok(validateReadability(resolveTokens({ 'color.label.primary': '#0f1115', 'color.bg.base': '#0f1115' }))
    .some((entry) => entry.code === 'contrast_too_low'));
  assert.ok(validateReadability(resolveTokens({ 'color.bg.base': 'not-a-colour' }))
    .some((entry) => entry.code === 'contrast_unmeasurable'));

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
  assert.deepEqual(factory.buildAssetBundle({ palette: PALETTE, style: 'research', seed: 'unit' }), bundle, 'a bundle is reproducible');
  assert.equal(factory.assetPath('wallpapers', 'main.png'), 'assets/wallpapers/main.png');
  assert.equal(factory.framingOf('overlay_character'), 'half_body');
});

test('the module is self-contained: built-ins only, no donor checkout dependency', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const moduleDir = join(import.meta.dirname, '..');
  for (const file of ['contract/contract.mjs', 'contract/surface.mjs', 'validation/validator.mjs', 'assets/procedural/factory.mjs']) {
    const code = (await readFile(join(moduleDir, file), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ['require(', "from 'app/", "from 'node_modules", 'from "app/', '--hns-']) {
      assert.ok(!code.includes(forbidden), `${file} must not depend on the donor checkout (${forbidden})`);
    }
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
    }
    assert.ok(!/\bhns\b/i.test(code.replace(/DS-Hns/g, '')), `${file} keeps no donor product noun`);
  }
});

test('provenance stays honest: DONOR.json records both waves of this module', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const donor = JSON.parse(await readFile(join(import.meta.dirname, '..', 'DONOR.json'), 'utf8'));
  assert.equal(donor.repository, 'zhiheng-zhang-Mera/DS-Hns');
  assert.equal(donor.commit, 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b');
  assert.equal(donor.cityPath, 'city/11-entertainment/01-entertainment-centre/theme-engine');
  assert.deepEqual(donor.incubationRooms, ['theme-engine-lab', 'theme-package-lab']);
  assert.deepEqual(donor.waves.map((entry) => [entry.wave, entry.room]), [['D2', 'theme-engine-lab'], ['D6', 'theme-package-lab']]);
  assert.deepEqual(donor.waves[0].sourcePaths, ['app/extensions/mega/theme/color.js', 'app/extensions/mega/theme/png.js']);
  assert.deepEqual(donor.waves[1].sourcePaths, [
    'app/extensions/mega/theme/contract.js',
    'app/extensions/mega/theme/surface.js',
    'app/extensions/mega/theme/validator.js',
    'app/extensions/mega/theme/asset-factory.js',
  ]);
  assert.deepEqual(Object.values(donor.portedFiles).sort(), [
    'assets/procedural/factory.mjs',
    'color/color.mjs',
    'contract/contract.mjs',
    'contract/surface.mjs',
    'raster/png.mjs',
    'validation/validator.mjs',
  ]);
  assert.ok(donor.adaptation.length >= 3);
  assert.ok(donor.knownDifferences.length >= 1);
  assert.ok(donor.parity.vectors.length >= 8);
});
