/**
 * UTOPIA · Theme Package Lab - theme package validator.
 *
 * Everything a theme package must satisfy before it may be accepted lives here:
 *
 *   1. the manifest parses and carries the required fields;
 *   2. the declared Theme Package API version is compatible;
 *   3. no executable payload is present anywhere in the package;
 *   4. no cross-package path and no parent-package dependency field;
 *   5. every written slot exists, is generator-writable, and uses allowed properties;
 *   6. tokens match the token schema;
 *   7. declared assets exist inside the package itself;
 *   8. a protected surface is never claimed as written;
 *   9. overlay strengths stay inside the engineering ceilings;
 *  10. readability, contrast and worker-state separability hold.
 *
 * Two entry points, one implementation:
 *
 *   validateDocuments({ manifest, tokens, components, persona, files, ... })
 *     validates documents that are already in memory. This is what the incubator
 *     room uses, because the room never writes a package to disk.
 *   validatePackage({ dir, ... })
 *     reads exactly the same documents (plus the file list) from a directory and
 *     delegates, so the two entry points can never disagree.
 *
 * A result is always a plain data object - it never throws - because a broken
 * candidate package must degrade to "rejected", never to "validator down".
 *
 * Ported from the DS-Hns donor `theme/validator.js`; the surface names, slot
 * families and asset directory vocabulary are Utopia's (see `contract.mjs`).
 */

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import {
  ANIMATION_MAX_INTENSITY,
  ANIMATION_PRESETS,
  CONTRAST_REQUIREMENTS,
  GENERATOR_PERMISSIONS,
  PERMISSION,
  PROPERTY_KIND,
  SLOTS,
  STATE_MIN_DISTANCE,
  STATE_VISIBILITY_MIN,
  SUPPORTED_APPS,
  THEME_API_VERSION,
  TOKENS,
  TOKEN_NAMES,
  WORKER_STATES,
} from '../contract/contract.mjs';
import { contrastRatio, distance, parseColor } from '../color/color.mjs';
import { isProtected, isSurface, isWritable, permissionOf, violationsIn } from '../contract/surface.mjs';

/** Fields no theme package may ever declare (runtime package dependencies). */
export const FORBIDDEN_MANIFEST_FIELDS = Object.freeze([
  'parent_theme',
  'required_theme',
  'extends',
  'inherits',
  'base_theme',
  'depends_on',
]);

/** File patterns that would make a package executable rather than declarative. */
export const FORBIDDEN_FILE_PATTERNS = Object.freeze([
  /\.(?:js|cjs|mjs|ts|tsx|jsx|py|rb|sh|ps1|psm1|bat|cmd|exe|dll|node|jar|vbs|wsf)$/i,
]);

/** Asset sub-directories a self-contained package may carry. */
export const ASSET_DIRS = Object.freeze([
  'wallpapers',
  'icons',
  'panels',
  'persona',
  'decorations',
  'characters',
  'overlay',
]);

export const REQUIRED_MANIFEST_FIELDS = Object.freeze([
  'id',
  'name',
  'version',
  'source',
  'theme_api_version',
  'supported_apps',
]);

/** Document names a package may carry beside its manifest. */
export const PACKAGE_DOCUMENTS = Object.freeze([
  'manifest.json',
  'tokens.json',
  'components.json',
  'persona.json',
  'surface-plan.json',
  'overlay-plan.json',
]);

/** The published list of what a package is checked against, in report order. */
export const VALIDATION_REQUIREMENTS = Object.freeze([
  { id: 'manifest', label: 'the manifest parses and carries the required fields' },
  { id: 'api_version', label: 'the declared Theme Package API version is compatible' },
  { id: 'declarative_only', label: 'no executable payload is present anywhere in the package' },
  { id: 'self_contained', label: 'no cross-package path and no parent-package dependency field' },
  { id: 'slots', label: 'every written slot exists, is writable, and uses allowed properties' },
  { id: 'tokens', label: 'tokens match the token schema' },
  { id: 'assets', label: 'declared assets exist inside the package itself' },
  { id: 'protected_surface', label: 'a protected surface is never claimed as written' },
  { id: 'overlay_ceilings', label: 'overlay strengths stay inside the engineering ceilings' },
  { id: 'readability', label: 'readability, contrast and worker-state separability hold' },
]);

/**
 * Engineering ceilings for the owned overlay, measured on the plan that would
 * actually be painted. These are the spec numbers, not tunables.
 */
export const OVERLAY_LIMITS = Object.freeze({
  overlay_opacity: 0.22,
  vignette: 0.15,
  scanline: 0.05,
  character_coverage: 0.22,
  total_overlay_opacity: 0.55,
});

function issue(severity, code, message, detail) {
  return { severity, code, message, detail: detail === undefined ? null : detail };
}

export function error(code, message, detail) {
  return issue('error', code, message, detail);
}

export function warn(code, message, detail) {
  return issue('warning', code, message, detail);
}

/** Shape a raw issue list into the validator result contract. */
export function summarize(issues) {
  const errors = issues.filter((entry) => entry.severity === 'error');
  return {
    ok: errors.length === 0,
    errors,
    warnings: issues.filter((entry) => entry.severity === 'warning'),
    issues,
  };
}

/** Compare two dotted numeric versions. Returns -1 / 0 / 1, or null when invalid. */
export function compareVersions(a, b) {
  const parse = (value) => {
    const match = String(value || '').trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

/**
 * Compatibility check. A package declaring an older API than this module exposes
 * is accepted (missing tokens fall back to their schema value); a package asking
 * for a newer API is refused, which is what makes "incompatible -> refused" an
 * honest outcome instead of a silent downgrade.
 */
export function checkApiVersion(declared) {
  if (!declared || typeof declared !== 'string') {
    return error('api_version_missing', 'manifest.theme_api_version is required', { declared: declared ?? null });
  }
  const forward = compareVersions(declared, THEME_API_VERSION);
  if (forward === null) {
    return error('api_version_invalid', `theme_api_version "${declared}" is not a dotted numeric version`);
  }
  if (forward > 0) {
    return error(
      'api_version_unsupported',
      `package requires Theme API ${declared} but this module exposes ${THEME_API_VERSION}`,
      { required: declared, supported: THEME_API_VERSION },
    );
  }
  return null;
}

/** Validate one slot payload against the slot table and the permission model. */
export function validateSlots(slots, { allowStructural = false } = {}) {
  const issues = [];
  if (slots === undefined || slots === null) return issues;
  if (typeof slots !== 'object' || Array.isArray(slots)) {
    issues.push(error('slots_invalid', 'components.slots must be an object keyed by slot id'));
    return issues;
  }
  const writable = allowStructural
    ? [PERMISSION.SAFE, PERMISSION.STYLE, PERMISSION.STRUCTURAL]
    : GENERATOR_PERMISSIONS;

  for (const [slotId, payload] of Object.entries(slots)) {
    const definition = SLOTS[slotId];
    if (!definition) {
      issues.push(error('slot_unknown', `slot "${slotId}" is not exposed by the Theme Package API`, { slot: slotId }));
      continue;
    }
    if (!writable.includes(definition.permission)) {
      issues.push(error(
        'slot_permission_denied',
        `slot "${slotId}" is ${definition.permission} and may not be themed automatically`,
        { slot: slotId, permission: definition.permission },
      ));
      continue;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      issues.push(error('slot_payload_invalid', `slot "${slotId}" payload must be an object`, { slot: slotId }));
      continue;
    }
    for (const property of Object.keys(payload)) {
      if (property === 'derived_from') continue;
      if (!definition.properties.includes(property)) {
        issues.push(error(
          'slot_property_denied',
          `slot "${slotId}" does not allow property "${property}"`,
          { slot: slotId, property, allowed: definition.properties },
        ));
      }
    }
  }
  return issues;
}

function isAssetReference(value) {
  return typeof value === 'string' && value.startsWith('assets/');
}

/**
 * Detect a package that reaches outside itself. Cross-package resolution is
 * illegal, so any path escaping the package, pointing at another package's
 * directory, or naming a remote location is rejected.
 */
export function crossPackageReferences(value, trail = []) {
  const found = [];
  const visit = (node, trailPath) => {
    if (typeof node === 'string') {
      if (/^themes[\\/]/i.test(node) || /\.\.[\\/]/.test(node) || /^[a-z]:[\\/]/i.test(node) || /^https?:\/\//i.test(node)) {
        found.push({ path: trailPath.join('.'), value: node });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, trailPath.concat(String(index))));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, entry] of Object.entries(node)) visit(entry, trailPath.concat(key));
    }
  };
  visit(value, trail);
  return found;
}

/** Validate the token document against the token schema. */
export function validateTokens(tokens) {
  const issues = [];
  if (tokens === undefined || tokens === null) return issues;
  if (typeof tokens !== 'object' || Array.isArray(tokens)) {
    issues.push(error('tokens_invalid', 'the token document must be an object keyed by token name'));
    return issues;
  }
  for (const [name, value] of Object.entries(tokens)) {
    const definition = TOKENS[name];
    if (!definition) {
      issues.push(error('token_unknown', `token "${name}" is not part of the Theme Package API schema`, { token: name }));
      continue;
    }
    if (value === null || value === undefined) {
      issues.push(error('token_empty', `token "${name}" has no value`, { token: name }));
      continue;
    }
    if (definition.kind === PROPERTY_KIND.COLOR) {
      if (!parseColor(value)) {
        issues.push(error('token_color_invalid', `token "${name}" is not a valid CSS colour: ${JSON.stringify(value)}`, { token: name }));
      }
      continue;
    }
    if (definition.kind === PROPERTY_KIND.LENGTH) {
      if (!/^-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|pt|ch)?$/.test(String(value).trim())) {
        issues.push(error('token_length_invalid', `token "${name}" is not a valid CSS length: ${JSON.stringify(value)}`, { token: name }));
      }
      continue;
    }
    if (definition.kind === PROPERTY_KIND.NUMBER) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        issues.push(error('token_number_invalid', `token "${name}" is not numeric: ${JSON.stringify(value)}`, { token: name }));
      }
      continue;
    }
    if (definition.kind === PROPERTY_KIND.ASSET) {
      const text = String(value);
      if (text !== 'none' && !text.startsWith('data:image/') && !isAssetReference(text)) {
        issues.push(error('token_asset_invalid', `token "${name}" must be "none", an assets/ reference or an inline data:image`, { token: name }));
      }
      continue;
    }
    if (definition.kind === PROPERTY_KIND.SHADOW) {
      if (typeof value !== 'string' || !value.trim()) {
        issues.push(error('token_shadow_invalid', `token "${name}" must be a CSS shadow string`, { token: name }));
      }
    }
  }
  if (!Object.keys(tokens).length) {
    issues.push(warn('tokens_empty', 'the package declares no tokens; every token falls back to the schema value'));
  }
  return issues;
}

/**
 * Resolve a token map over the fallback tokens so validation and preview always
 * operate on a complete token set.
 */
export function resolveTokens(tokens, fallbackTokens) {
  const resolved = {};
  for (const name of TOKEN_NAMES) {
    const value = tokens && Object.prototype.hasOwnProperty.call(tokens, name) ? tokens[name] : undefined;
    if (value !== undefined && value !== null && value !== '') resolved[name] = value;
    else if (fallbackTokens && fallbackTokens[name] !== undefined) resolved[name] = fallbackTokens[name];
    else resolved[name] = TOKENS[name].fallback;
  }
  return resolved;
}

/** Readability / contrast / state-separability checks over a resolved token set. */
export function validateReadability(resolvedTokens, { stateMinDistance = STATE_MIN_DISTANCE } = {}) {
  const issues = [];
  for (const requirement of CONTRAST_REQUIREMENTS) {
    const foreground = resolvedTokens[requirement.foreground];
    const background = resolvedTokens[requirement.background];
    const ratio = contrastRatio(foreground, background);
    if (ratio === null) {
      issues.push(error('contrast_unmeasurable', `cannot measure contrast for ${requirement.label}`, { foreground, background }));
      continue;
    }
    if (ratio + 1e-6 < requirement.min) {
      issues.push(error(
        'contrast_too_low',
        `${requirement.label} contrast ${ratio.toFixed(2)}:1 is below the required ${requirement.min}:1`,
        { foreground: requirement.foreground, background: requirement.background, ratio: Number(ratio.toFixed(3)), min: requirement.min },
      ));
    }
  }

  // Worker state visuals must stay mutually distinguishable: a package may restyle
  // a state, but it may never make two states look the same.
  const stateBackground = resolvedTokens['color.bg.layer1'];
  for (const state of WORKER_STATES) {
    const ratio = contrastRatio(resolvedTokens[`state.${state}`], stateBackground);
    if (ratio !== null && ratio + 1e-6 < STATE_VISIBILITY_MIN) {
      issues.push(error(
        'state_invisible',
        `state "${state}" is indistinguishable from the content layer (contrast ${ratio.toFixed(2)}:1 < ${STATE_VISIBILITY_MIN}:1)`,
        { state, ratio: Number(ratio.toFixed(3)), min: STATE_VISIBILITY_MIN },
      ));
    }
  }
  for (let i = 0; i < WORKER_STATES.length; i += 1) {
    for (let j = i + 1; j < WORKER_STATES.length; j += 1) {
      const a = WORKER_STATES[i];
      const b = WORKER_STATES[j];
      const spread = distance(resolvedTokens[`state.${a}`], resolvedTokens[`state.${b}`]);
      if (spread === null) {
        issues.push(error('state_unmeasurable', `cannot measure distance between states "${a}" and "${b}"`));
        continue;
      }
      if (spread < stateMinDistance) {
        issues.push(error(
          'state_indistinguishable',
          `worker states "${a}" and "${b}" are too similar (distance ${spread.toFixed(1)} < ${stateMinDistance})`,
          { states: [a, b], distance: Number(spread.toFixed(2)), min: stateMinDistance },
        ));
      }
    }
  }
  return issues;
}

/** Clamp a declared animation block into the allowed envelope. */
export function normalizeAnimation(animation) {
  if (!animation || typeof animation !== 'object') return { type: 'none', intensity: 0 };
  const supported = ANIMATION_PRESETS.includes(animation.type);
  const type = supported ? animation.type : 'none';
  const max = ANIMATION_MAX_INTENSITY[type] ?? 0;
  const requested = Number(animation.intensity);
  const intensity = Number.isFinite(requested) ? Math.max(0, Math.min(max, requested)) : 0;
  return {
    type,
    intensity: Number(intensity.toFixed(3)),
    clamped: supported && Number.isFinite(requested) && requested > max,
  };
}

/**
 * Overlay strength ceilings, measured on the declared plan.
 *
 * An overlay is a visual layer over a view this project does not own, so "it looked
 * fine" is not an acceptable safety argument: the numbers are checked instead.
 */
export function validateOverlayPlan(overlayPlan, { limits = {} } = {}) {
  const issues = [];
  if (!overlayPlan) return issues;
  if (typeof overlayPlan !== 'object' || Array.isArray(overlayPlan)) {
    issues.push(error('overlay_plan_invalid', 'overlay-plan must be an object'));
    return issues;
  }
  const ceiling = { ...OVERLAY_LIMITS, ...(limits || {}), ...(overlayPlan.limits || {}) };
  const components = overlayPlan.components || {};
  const strengths = [
    ['global_tint', 'overlay_opacity', components.global_tint?.opacity],
    ['texture', 'overlay_opacity', components.texture?.opacity],
    ['gradient', 'overlay_opacity', components.gradient?.opacity],
    ['skin', 'overlay_opacity', components.skin?.opacity],
    ['vignette', 'vignette', components.vignette?.opacity],
    ['scanline', 'scanline', components.scanline?.opacity],
  ];
  let total = 0;
  for (const [name, limitKey, value] of strengths) {
    const actual = Number(value) || 0;
    total += actual;
    const limit = ceiling[limitKey];
    if (actual > limit + 1e-9) {
      issues.push(error(
        'overlay_strength_exceeded',
        `overlay ${name} opacity ${actual} exceeds the ${limit} ceiling`,
        { layer: name, actual, limit },
      ));
    }
  }
  if (total > ceiling.total_overlay_opacity + 1e-9) {
    issues.push(error(
      'overlay_total_exceeded',
      `stacked overlay opacity ${Number(total.toFixed(3))} exceeds the ${ceiling.total_overlay_opacity} ceiling`,
      { actual: Number(total.toFixed(3)), limit: ceiling.total_overlay_opacity },
    ));
  }
  if (overlayPlan.enabled === true) {
    for (const key of ['pointer', 'keyboard', 'focus', 'scroll']) {
      const value = overlayPlan.input?.[key];
      if (value !== 'passthrough' && value !== 'none') {
        issues.push(error(
          'overlay_input_not_passthrough',
          `overlay-plan declares ${key}="${value}"; the overlay is visual-only and must pass every input through`,
          { input: key, value: value ?? null },
        ));
      }
    }
  }
  return issues;
}

/** Validate a surface plan: known surfaces, honest write claims, protected untouched. */
export function validateSurfacePlan(surfacePlan) {
  const issues = [];
  if (!surfacePlan) return issues;
  if (typeof surfacePlan !== 'object' || Array.isArray(surfacePlan)) {
    issues.push(error('surface_plan_invalid', 'surface-plan must be an object'));
    return issues;
  }
  const entries = Array.isArray(surfacePlan.surfaces) ? surfacePlan.surfaces : [];
  for (const entry of entries) {
    const id = entry?.surface;
    if (!isSurface(id)) {
      issues.push(error('surface_unknown', `surface-plan declares an unknown surface "${id}"`, { surface: id ?? null }));
      continue;
    }
    if (entry.writes === true && !isWritable(id)) {
      issues.push(error(
        'surface_write_denied',
        `surface-plan claims to write "${id}", which is ${permissionOf(id)}`,
        { surface: id },
      ));
    }
    if (isProtected(id) && entry.writes !== false) {
      issues.push(error(
        'surface_protected',
        `surface-plan must record "${id}" as not written`,
        { surface: id },
      ));
    }
  }
  for (const hit of violationsIn(surfacePlan, [])) {
    issues.push(error(
      'surface_protected',
      `surface-plan.${hit.path} targets the PROTECTED surface (${hit.value})`,
      hit,
    ));
  }
  return issues;
}

/** Every `assets/...` reference inside the given documents. */
export function collectAssetReferences(documents) {
  const found = [];
  const visit = (node) => {
    if (typeof node === 'string') {
      if (isAssetReference(node)) found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === 'object') Object.values(node).forEach(visit);
  };
  for (const document of documents) visit(document);
  return found;
}

/**
 * Validate package documents that are already in memory.
 *
 * @param {object} documents
 * @param {object|null} [documents.manifest]
 * @param {object|null} [documents.tokens]
 * @param {object|null} [documents.components]
 * @param {object|null} [documents.persona]
 * @param {object|null} [documents.surfacePlan]
 * @param {object|null} [documents.overlayPlan]
 * @param {string[]} [documents.files]        package-relative file paths
 * @param {string[]} [documents.assets]       declared asset references
 * @param {object} [documents.fallbackTokens]
 * @param {string} [documents.expectedId]
 * @param {object} [documents.overlayLimits]
 */
export function validateDocuments({
  manifest = null,
  tokens = null,
  components = null,
  persona = null,
  surfacePlan = null,
  overlayPlan = null,
  files = null,
  assets = null,
  fallbackTokens = null,
  expectedId = null,
  overlayLimits = null,
  requireManifest = true,
} = {}) {
  const issues = [];

  // ---- manifest ----
  if (manifest === null || manifest === undefined) {
    if (requireManifest) issues.push(error('manifest_missing', 'the package has no manifest'));
  } else if (typeof manifest !== 'object' || Array.isArray(manifest)) {
    issues.push(error('manifest_invalid', 'the manifest must be a JSON object'));
    manifest = null;
  }

  if (manifest) {
    for (const field of REQUIRED_MANIFEST_FIELDS) {
      if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
        issues.push(error('manifest_field_missing', `manifest.${field} is required`, { field }));
      }
    }
    if (manifest.id !== undefined && !/^[a-z0-9][a-z0-9._-]*$/i.test(String(manifest.id))) {
      issues.push(error('manifest_id_invalid', `manifest.id "${manifest.id}" must be a slug`, { id: manifest.id }));
    }
    if (expectedId && manifest.id && manifest.id !== expectedId) {
      issues.push(error('manifest_id_mismatch', `manifest.id "${manifest.id}" does not match the expected id "${expectedId}"`, {
        manifestId: manifest.id, expectedId,
      }));
    }
    for (const field of FORBIDDEN_MANIFEST_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(manifest, field)) {
        issues.push(error('manifest_forbidden_dependency', `manifest declares forbidden runtime dependency field "${field}"`, {
          field, value: manifest[field],
        }));
      }
    }
    if (Array.isArray(manifest.supported_apps) && !manifest.supported_apps.some((app) => SUPPORTED_APPS.includes(app))) {
      issues.push(error('manifest_app_unsupported', `package supports none of ${SUPPORTED_APPS.join(', ')}: ${JSON.stringify(manifest.supported_apps)}`));
    }
    const apiIssue = checkApiVersion(manifest.theme_api_version);
    if (apiIssue) issues.push(apiIssue);
    if (manifest.protected === true && manifest.source !== 'system') {
      issues.push(warn('protected_non_system', 'a non-system package declares protected=true; the flag is honoured but it is unusual'));
    }
  }

  // ---- tokens ----
  if (tokens !== null && tokens !== undefined && (typeof tokens !== 'object' || Array.isArray(tokens))) {
    issues.push(error('tokens_invalid', 'the token document must be an object keyed by token name'));
    tokens = null;
  }
  if (tokens) issues.push(...validateTokens(tokens));
  else if (tokens === null) issues.push(warn('tokens_missing', 'the package has no tokens; every token falls back to the schema value'));

  // ---- components ----
  if (components !== null && components !== undefined) {
    if (typeof components !== 'object' || Array.isArray(components)) {
      issues.push(error('components_invalid', 'the components document must be an object'));
    } else {
      const slots = components.slots || components;
      issues.push(...validateSlots(slots));
      if (components.animation) {
        const normalized = normalizeAnimation(components.animation);
        if (normalized.clamped) {
          issues.push(warn('animation_clamped', `animation intensity was clamped to ${normalized.intensity} for preset "${normalized.type}"`));
        }
      }
    }
  }

  // ---- persona ----
  if (persona && typeof persona === 'object' && !Array.isArray(persona) && persona.enabled === true) {
    const prominence = Number(persona.prominence);
    if (Number.isFinite(prominence) && prominence > 0.4) {
      issues.push(error(
        'persona_prominence_excessive',
        `a lightweight persona is required; prominence ${prominence} exceeds the 0.4 ceiling`,
        { prominence },
      ));
    }
    if (Number.isFinite(prominence) && prominence < 0) {
      issues.push(error('persona_prominence_invalid', 'persona.prominence must be >= 0', { prominence }));
    }
    if (persona.overlay_main === true) {
      issues.push(error('persona_overlay_forbidden', 'a large character overlay covering the main UI is forbidden'));
    }
    if (Array.isArray(persona.occludes)) {
      const forbidden = persona.occludes.filter((region) => ['log', 'process', 'hardware', 'worker'].includes(String(region)));
      if (forbidden.length) {
        issues.push(error('persona_occludes_critical_region', `persona must not occlude ${forbidden.join(', ')}`, { regions: forbidden }));
      }
    }
  }

  // ---- files: declarative only ----
  if (Array.isArray(files)) {
    for (const file of files) {
      if (FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(file))) {
        issues.push(error('executable_payload', `a theme package must be declarative; found executable file "${file}"`, { file }));
      }
    }
  }

  // ---- plans ----
  issues.push(...validateSurfacePlan(surfacePlan));
  issues.push(...validateOverlayPlan(overlayPlan, { limits: overlayLimits || {} }));

  // ---- declared assets exist inside the package ----
  const declaredAssets = Array.isArray(assets) ? assets : collectAssetReferences([tokens, components]);
  if (Array.isArray(files)) {
    const known = new Set(files.map((file) => String(file).replace(/\\/g, '/')));
    for (const reference of declaredAssets) {
      const relative = reference.slice('assets/'.length);
      if (!known.has(reference) && !known.has(`assets/${relative}`)) {
        issues.push(error('asset_missing', `declared asset is missing from the package: ${reference}`, { asset: reference }));
      }
    }
  }

  // ---- cross-package references ----
  for (const [name, document] of [['tokens', tokens], ['components', components]]) {
    if (!document) continue;
    for (const hit of crossPackageReferences(document, [name])) {
      issues.push(error('cross_package_reference', `${name}.${hit.path} resolves outside the package: ${hit.value}`, hit));
    }
  }

  // ---- readability ----
  const resolvedTokens = resolveTokens(tokens || {}, fallbackTokens);
  issues.push(...validateReadability(resolvedTokens));

  const result = summarize(issues);
  result.metadata = manifest
    ? {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        source: manifest.source,
        protected: manifest.protected === true,
        theme_api_version: manifest.theme_api_version,
        supported_apps: Array.isArray(manifest.supported_apps) ? manifest.supported_apps.slice() : [],
      }
    : null;
  result.resolvedTokens = resolvedTokens;
  result.animation = normalizeAnimation(components && components.animation);
  result.declaredAssets = declaredAssets;
  result.files = Array.isArray(files) ? files.slice() : null;
  return result;
}

/** List every file in a directory tree, relative to the root, POSIX-style. */
export function listFiles(root, { maxFiles = 4096 } = {}) {
  const out = [];
  const walk = (dir) => {
    if (out.length > maxFiles) return;
    let entries = [];
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(nodePath.relative(root, full).split(nodePath.sep).join('/'));
    }
  };
  walk(root);
  return out;
}

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(nodeFs.readFileSync(file, 'utf8')) };
  } catch (parseError) {
    return { ok: false, reason: parseError.message };
  }
}

/**
 * Validate a materialized package directory. Reads the documents, then delegates to
 * `validateDocuments` with the real file list.
 */
export function validatePackage({ dir, fallbackTokens = null, expectedId = null, overlayLimits = null } = {}) {
  if (!dir || typeof dir !== 'string') {
    return summarize([error('package_missing', 'no package directory was supplied')]);
  }
  let stat = null;
  try {
    stat = nodeFs.statSync(dir);
  } catch {
    return summarize([error('package_missing', `package directory does not exist: ${dir}`, { dir })]);
  }
  if (!stat.isDirectory()) return summarize([error('package_not_directory', `package path is not a directory: ${dir}`, { dir })]);

  const issues = [];
  const documents = {};
  for (const name of PACKAGE_DOCUMENTS) {
    const file = nodePath.join(dir, name);
    if (!nodeFs.existsSync(file)) {
      documents[name] = null;
      continue;
    }
    const parsed = readJson(file);
    if (!parsed.ok) {
      issues.push(error(`${name.replace(/[-.]/g, '_')}_unparsable`, `${name} is not valid JSON: ${parsed.reason}`));
      documents[name] = null;
      continue;
    }
    documents[name] = parsed.value;
  }
  if (!nodeFs.existsSync(nodePath.join(dir, 'tokens.json'))) {
    issues.push(warn('tokens_missing', 'the package has no tokens.json; every token falls back to the schema value'));
  }

  const report = validateDocuments({
    manifest: documents['manifest.json'],
    tokens: documents['tokens.json'],
    components: documents['components.json'],
    persona: documents['persona.json'],
    surfacePlan: documents['surface-plan.json'],
    overlayPlan: documents['overlay-plan.json'],
    files: listFiles(dir),
    fallbackTokens,
    expectedId,
    overlayLimits,
  });
  report.issues = [...issues, ...report.issues];
  report.errors = report.issues.filter((entry) => entry.severity === 'error');
  report.warnings = report.issues.filter((entry) => entry.severity === 'warning');
  report.ok = report.errors.length === 0;
  return report;
}

/** Structural slot styles must never be generated, whatever the caller does. */
export function assertNoStructuralWrites(theme) {
  const slots = theme?.components?.slots || {};
  const violations = [];
  for (const slotId of Object.keys(slots)) {
    const definition = SLOTS[slotId];
    if (!definition) {
      violations.push({ slot: slotId, reason: 'not exposed by the Theme Package API' });
      continue;
    }
    if (definition.permission === PERMISSION.STRUCTURAL) {
      violations.push({ slot: slotId, reason: 'STRUCTURAL slots are never written by a generator' });
    }
  }
  return violations;
}
