/**
 * UTOPIA · City — implementation manifest loader and validator.
 *
 * `city/CITY_IMPLEMENTATION_MANIFEST.json` records what really exists in this
 * tree. It is not a wish list: a module is only registered once its code has been
 * promoted from the Room Pack incubator, and `DEFERRED` work is never written as
 * ACTIVE. District → Building → Module is the ownership order; a Room is an
 * incubator, never a Building.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CITY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
export const MANIFEST_PATH = join(CITY_ROOT, 'CITY_IMPLEMENTATION_MANIFEST.json');

/** District kinds. `infrastructure` districts own the runtime kernel, not capabilities. */
export const DISTRICT_KINDS = ['infrastructure', 'domain'];

/** Lifecycles a city module may declare. */
export const CITY_LIFECYCLES = ['PLANNED', 'INCUBATING', 'PROMOTED', 'ACTIVE', 'DEPRECATED'];

/** Lifecycles that mean "code is present in this tree". */
export const IMPLEMENTED_LIFECYCLES = ['PROMOTED', 'ACTIVE', 'DEPRECATED'];

/** Manifest schema version owned by this tree. */
export const MANIFEST_SCHEMA_VERSION = 2;

export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** Read and structurally validate the manifest. */
export async function loadManifest(path = MANIFEST_PATH) {
  let raw;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new ManifestError(`cannot read ${path}: ${error.message}`);
  }
  return validateManifest(raw, path);
}

/** Structural validation of a parsed manifest. */
export function validateManifest(raw, source = 'manifest') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError(`${source}: root must be a JSON object`);
  }
  if (raw.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ManifestError(`${source}: schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.districts) || raw.districts.length === 0) {
    throw new ManifestError(`${source}: districts must be a non-empty array`);
  }
  const districtIds = new Set();
  const paths = new Set();
  const rooms = new Set();
  for (const district of raw.districts) {
    requireText(district?.id, `${source}: district id`, source);
    requireText(district?.zh, `${source}: district ${district.id} zh`, source);
    requireText(district?.en, `${source}: district ${district.id} en`, source);
    if (districtIds.has(district.id)) throw new ManifestError(`${source}: duplicate district ${district.id}`);
    districtIds.add(district.id);
    if (!/^\d{2}-[a-z0-9-]+$/.test(district.id)) {
      throw new ManifestError(`${source}: district id ${district.id} must look like 02-engineering`);
    }
    if (district.kind !== undefined && !DISTRICT_KINDS.includes(district.kind)) {
      throw new ManifestError(`${source}: district ${district.id} kind ${district.kind} is not a city district kind`);
    }
    if (!Array.isArray(district.buildings) || district.buildings.length === 0) {
      throw new ManifestError(`${source}: district ${district.id} needs at least one building`);
    }
    const buildingIds = new Set();
    for (const building of district.buildings) {
      requireText(building?.id, `${source}: building id`, source);
      requireText(building?.zh, `${source}: building ${building.id} zh`, source);
      requireText(building?.en, `${source}: building ${building.id} en`, source);
      if (buildingIds.has(building.id)) throw new ManifestError(`${source}: duplicate building ${building.id}`);
      buildingIds.add(building.id);
      if (!Array.isArray(building.modules) || building.modules.length === 0) {
        throw new ManifestError(`${source}: building ${building.id} needs at least one module`);
      }
      const moduleIds = new Set();
      for (const module of building.modules) {
        requireText(module?.id, `${source}: module id`, source);
        requireText(module?.path, `${source}: module ${module.id} path`, source);
        if (moduleIds.has(module.id)) throw new ManifestError(`${source}: duplicate module ${module.id}`);
        moduleIds.add(module.id);
        if (!CITY_LIFECYCLES.includes(module.lifecycle)) {
          throw new ManifestError(`${source}: module ${module.id} lifecycle ${module.lifecycle} is not a city lifecycle`);
        }
        const expected = `city/${district.id}/${building.id}/${module.id}`;
        if (module.path !== expected) {
          throw new ManifestError(`${source}: module ${module.id} path must be ${expected}`);
        }
        if (paths.has(module.path)) throw new ManifestError(`${source}: duplicate module path ${module.path}`);
        paths.add(module.path);

        // A module may be strengthened by several incubation rooms over time, so
        // it records a list. The same room may not be claimed by two modules.
        const incubationRooms = module.incubationRooms ?? (module.roomId ? [module.roomId] : []);
        if (!Array.isArray(incubationRooms)) {
          throw new ManifestError(`${source}: module ${module.id} incubationRooms must be an array`);
        }
        const uniqueRooms = new Set();
        for (const room of incubationRooms) {
          requireText(room, `${source}: module ${module.id} incubationRooms entry`, source);
          if (uniqueRooms.has(room)) throw new ManifestError(`${source}: module ${module.id} lists room ${room} twice`);
          uniqueRooms.add(room);
          if (rooms.has(room)) throw new ManifestError(`${source}: incubation room ${room} is claimed by two modules`);
          rooms.add(room);
        }
        if (IMPLEMENTED_LIFECYCLES.includes(module.lifecycle) && uniqueRooms.size === 0) {
          throw new ManifestError(
            `${source}: implemented module ${module.id} must name at least one incubator room`,
          );
        }
        if (module.donor !== null && module.donor !== undefined) {
          requireText(module.donor.repository, `${source}: module ${module.id} donor.repository`, source);
          requireText(module.donor.commit, `${source}: module ${module.id} donor.commit`, source);
          if (!/^[0-9a-f]{7,40}$/i.test(module.donor.commit)) {
            throw new ManifestError(`${source}: module ${module.id} donor.commit must be a git SHA`);
          }
        }
      }
    }
  }
  return raw;
}

function requireText(value, field, source) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ManifestError(`${source}: ${field} must be a non-empty string`);
  }
}

/** The incubation rooms a module records (schema v2 list, or a legacy roomId). */
export function moduleIncubationRooms(module) {
  if (Array.isArray(module.incubationRooms)) return [...module.incubationRooms];
  return module.roomId ? [module.roomId] : [];
}

/** Flatten the manifest into module records with their district and building. */
export function flattenModules(manifest) {
  const out = [];
  for (const district of manifest.districts) {
    for (const building of district.buildings) {
      for (const module of building.modules) {
        out.push({ district, building, module, incubationRooms: moduleIncubationRooms(module) });
      }
    }
  }
  return out;
}

/** Every module whose lifecycle says its code should be present in this tree. */
export function implementedModules(manifest) {
  return flattenModules(manifest).filter((entry) => IMPLEMENTED_LIFECYCLES.includes(entry.module.lifecycle));
}

/**
 * Verify the tree matches the manifest:
 * - implemented modules exist on disk;
 * - modules that only claim PLANNED or INCUBATING have no directory yet.
 * @returns {Promise<string[]>} problems (empty when consistent)
 */
export async function checkManifestAgainstTree(manifest, cityRoot = CITY_ROOT) {
  const problems = [];
  for (const { module } of flattenModules(manifest)) {
    const absolute = resolve(cityRoot, module.path.replace(/^city\//, ''));
    let exists = true;
    try {
      const info = await stat(absolute);
      exists = info.isDirectory();
    } catch {
      exists = false;
    }
    if (IMPLEMENTED_LIFECYCLES.includes(module.lifecycle) && !exists) {
      problems.push(`${module.id}: lifecycle ${module.lifecycle} but ${module.path} does not exist`);
    }
    if (!IMPLEMENTED_LIFECYCLES.includes(module.lifecycle) && exists) {
      problems.push(`${module.id}: ${module.path} exists but lifecycle is only ${module.lifecycle}`);
    }
  }
  return problems;
}

/** Recursively collect every `*.test.mjs` under a root (used by test-all.mjs). */
export async function discoverTests(root = CITY_ROOT, { skip = ['node_modules'] } = {}) {
  const found = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (skip.includes(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.name.endsWith('.test.mjs')) found.push(absolute);
    }
  }
  await walk(root);
  return found;
}
