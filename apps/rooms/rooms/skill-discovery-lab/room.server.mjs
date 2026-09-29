/**
 * UTOPIA · Rooms · Room 15 — Skill Discovery Lab (server).
 *
 * Incubator for the DS-Hns skill source and catalog cores: parse a GitHub
 * reference into an offline resolution plan, scan an allowed local root for skill
 * candidates, search a curated catalog with an optional injectable live search,
 * and preview a resolved source. This wave still does not install skills, and this
 * room never downloads anything.
 *
 * Donor: zhiheng-zhang-Mera/DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b
 *        app/extensions/mega/skills/skill-source.js, app/extensions/mega/skills/skill-catalog.js
 */

import { createRouter, sendJson } from '../../shared/http.mjs';
import { RoomValidationError } from '../../shared/room-kit.mjs';
import { isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SAFE_SCAN_ROOT,
  createCatalog,
  describeRef,
  diskAdapter,
  inspectLocalPath,
  locateSkills,
  parseGithubReference,
  resolutionPlan,
  scanDirectory,
} from './discovery-core.mjs';

// Keep the re-export so tests and callers have one discovery surface.
export { locateSkills };

/** This room's own directory: the base for a relative scan path. */
const ROOM_DIR = fileURLToPath(new URL('.', import.meta.url));

function requireObject(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RoomValidationError('payload must be a JSON object');
  }
  return payload;
}

/**
 * The room only ever scans inside its documented sandbox root. A relative path is
 * read the way it appears in this room's tree (`samples/skills`), so it resolves
 * from the room directory; the result still has to stay inside the sandbox root.
 */
function requireAllowedPath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return SAFE_SCAN_ROOT;
  if (raw.includes('\u0000')) throw new RoomValidationError('path must not contain NUL');
  const words = raw.toLowerCase().split(/[\\/]+/);
  if (words.includes('..')) throw new RoomValidationError('path must not traverse upward');
  const resolved = isAbsolute(raw) ? resolve(raw) : resolve(ROOM_DIR, raw);
  if (resolved !== SAFE_SCAN_ROOT && !resolved.startsWith(`${SAFE_SCAN_ROOT}${sep}`)) {
    throw new RoomValidationError(`path must stay inside the sandbox root ${SAFE_SCAN_ROOT}`);
  }
  return resolved;
}

/** Resolve an entry id (or a raw reference) to a source preview. */
export function resolveSource({ reference, catalogEntry = null, fetchJson = null }) {
  if (catalogEntry) {
    const catalog = createCatalog({ fetchJson });
    const entry = catalog.get(catalogEntry);
    if (!entry) return { ok: false, reason: `unknown catalog entry ${catalogEntry}` };
    if (entry.origin === 'bundled') {
      return {
        ok: true,
        kind: 'bundled',
        entry: { id: entry.id, name: entry.name, summary: entry.summary, tags: entry.tags, origin: entry.origin },
        document: entry.body ? null : null,
      };
    }
    return {
      ok: true,
      kind: 'curated',
      entry: { id: entry.id, name: entry.name, owner: entry.owner, repo: entry.repo, subpath: entry.subpath, tags: entry.tags },
      reference: `${entry.owner}/${entry.repo}${entry.subpath ? `/${entry.subpath}` : ''}`,
      plan: resolutionPlan({ kind: 'repo', owner: entry.owner, repo: entry.repo, branch: null, subpath: entry.subpath ?? null }),
    };
  }

  const parsed = parseGithubReference(reference);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return {
    ok: true,
    kind: parsed.ref.kind,
    describe: describeRef(parsed.ref),
    plan: resolutionPlan(parsed.ref),
  };
}

/** Create the Skill Discovery Lab route handler (no durable store). */
export function createSkillDiscoveryRoom() {
  const route = createRouter([
    {
      method: 'GET',
      pattern: '/capabilities',
      handle: async ({ res }) => {
        sendJson(res, 200, {
          room: 'skill-discovery-lab',
          installs: false,
          downloads: false,
          donor: {
            repository: 'zhiheng-zhang-Mera/DS-Hns',
            commit: 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b',
            sourcePaths: ['app/extensions/mega/skills/skill-source.js', 'app/extensions/mega/skills/skill-catalog.js'],
          },
          reuse: {
            format: 'city/02-engineering/02-worker-gateway/skill-intake/format.mjs',
            archive: 'city/02-engineering/02-worker-gateway/skill-intake/archive.mjs',
            note: 'wave 1 already ported the SKILL.md parser and tar reader; this room never copies them',
          },
          sandbox: { scanRoot: SAFE_SCAN_ROOT },
          accepts: ['owner/repo@ref', 'owner/repo/sub/path', 'github.com URLs', '/tree/', '/blob/', 'raw URLs', 'local paths under the sandbox root'],
        });
      },
    },
    {
      method: 'POST',
      pattern: '/reference/parse',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const parsed = parseGithubReference(payload.reference);
        if (!parsed.ok) {
          sendJson(res, 200, { ok: false, reason: parsed.reason });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          ref: parsed.ref,
          describe: describeRef(parsed.ref),
          plan: resolutionPlan(parsed.ref),
        });
      },
    },
    {
      method: 'POST',
      pattern: '/source/scan',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const requested = requireAllowedPath(payload.path ?? SAFE_SCAN_ROOT);
        const read = diskAdapter();
        if (payload.subpath !== undefined && payload.subpath !== null && payload.subpath !== '') {
          const subpath = normalizeSubpath(payload.subpath);
          if (!subpath) throw new RoomValidationError('subpath must not traverse upward or be empty');
          if (!read.isDirectory(requested)) {
            sendJson(res, 200, { ok: false, reason: `path does not exist: ${requested}` });
            return;
          }
          const found = scanDirectory(read, requested, { subpath });
          sendJson(res, 200, {
            ok: true,
            path: requested,
            subpath,
            isBundle: found.isBundle,
            bundles: found.bundles.map((bundle) => ({ name: bundle.name, dir: bundle.dir })),
            files: found.files.map((file) => ({ name: file.name, file: file.file })),
          });
          return;
        }

        const inspected = inspectLocalPath(read, requested);
        if (!inspected.ok) {
          sendJson(res, 200, { ok: false, reason: inspected.reason, rejections: inspected.rejections ?? [] });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          path: inspected.source.path,
          isBundle: inspected.isBundle ?? false,
          candidates: inspected.candidates.map((candidate) => ({
            name: candidate.name,
            description: candidate.skill?.description ?? null,
            whenToUse: candidate.skill?.whenToUse ?? null,
            file: candidate.file,
            dir: candidate.dir,
          })),
        });
      },
    },
    {
      method: 'POST',
      pattern: '/source/preview',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const result = resolveSource({ reference: payload.reference, catalogEntry: payload.catalogEntry ?? null });
        sendJson(res, 200, result);
      },
    },
    {
      method: 'POST',
      pattern: '/catalog/search',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const catalog = createCatalog({ fetchJson: null });
        const result = await catalog.search({
          query: typeof payload.query === 'string' ? payload.query : '',
          tags: Array.isArray(payload.tags) ? payload.tags.map(String) : [],
          includeLive: payload.includeLive === true,
        });
        sendJson(res, 200, { ...result, tags: catalog.tags() });
      },
    },
    {
      method: 'POST',
      pattern: '/catalog/live',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        if (typeof payload.endpoint !== 'string' || !payload.endpoint.trim()) {
          throw new RoomValidationError('endpoint is required: live search is injectable and never defaulted');
        }
        // The endpoint is injected by the caller (a test or an operator-provided
        // local service). Without one the room simply reports "unavailable".
        const fetchJson = async (url) => {
          const response = await fetch(url, { headers: { accept: 'application/vnd.github+json' } });
          if (!response.ok) throw new Error(`live search responded ${response.status}`);
          return response.json();
        };
        const catalog = createCatalog({ fetchJson, searchLimit: Number.isInteger(payload.limit) ? payload.limit : undefined });
        try {
          const entries = await catalog.liveSearch({ query: typeof payload.query === 'string' ? payload.query : '' });
          sendJson(res, 200, { ok: true, total: entries.length, entries });
        } catch (error) {
          sendJson(res, 200, { ok: false, reason: String(error?.message ?? error) });
        }
      },
    },
    {
      method: 'POST',
      pattern: '/catalog/preview',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const catalog = createCatalog({ fetchJson: null });
        const entry = catalog.get(String(payload.id ?? ''));
        if (!entry) {
          sendJson(res, 200, { ok: false, reason: `unknown catalog entry ${payload.id}` });
          return;
        }
        sendJson(res, 200, { ok: true, entry: { id: entry.id, name: entry.name, origin: entry.origin, tags: entry.tags ?? [] } });
      },
    },
  ]);

  return { id: 'skill-discovery-lab', handle: (context) => route(context), persistent: false };
}

function normalizeSubpath(value) {
  const segments = String(value).replace(/\\/g, '/').split('/').filter((segment) => segment && segment !== '.');
  if (segments.some((segment) => segment === '..')) return null;
  return segments.length ? segments.join('/') : null;
}
