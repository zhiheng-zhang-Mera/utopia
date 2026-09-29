/**
 * UTOPIA · City · Skill Intake — skill sources.
 *
 * Ported from the HNS donor `app/extensions/mega/skills/skill-source.js`
 * (zhiheng-zhang-Mera/DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b),
 * promoted from the D5 incubator room `skill-discovery-lab`.
 *
 * A source is either a local directory (a bundle, a flat `<name>.md`, or a folder
 * holding several skills) or a GitHub reference (repository, `/tree/`, `/blob/`,
 * `raw.githubusercontent.com`, or the `owner/repo@ref` shorthand).
 *
 * Port differences:
 * - CommonJS -> ESM. The GitHub reference parser, the candidate ordering, the
 *   archive URL planner and the tiered directory scanner are unchanged.
 * - Skill documents are validated by this module's own `format.mjs`, never by a
 *   second copy of the parser.
 * - Every filesystem read goes through an injectable adapter, so the scanner is
 *   testable against an in-memory tree as well as the real disk.
 * - Network reads stay injectable (`fetchBuffer`) and are never performed by this
 *   module: resolving a reference is offline work, and this module never downloads.
 * - `describeRef` lives here rather than in the incubator's room wiring, because it
 *   only describes a parsed reference and nothing room-specific.
 */

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { parseSkillText } from './format.mjs';

export const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
export const RAW_HOSTS = new Set(['raw.githubusercontent.com']);
export const DEFAULT_TIMEOUT_MS = 20000;
export const MAX_DOWNLOAD_BYTES = 48 * 1024 * 1024;

/**
 * Directory names that are scaffolding rather than a skill. A repository that
 * ships a starter `template/SKILL.md` beside its real `skills/` collection must
 * not have the template offered instead of the collection.
 */
export const SCAFFOLD_DIRS = new Set([
  'template', 'templates', 'example', 'examples', 'sample', 'samples',
  'spec', 'specs', 'docs', 'doc', 'test', 'tests', 'fixtures', 'fixture',
]);

/**
 * Parse any supported GitHub reference.
 * @returns {{ok: true, ref: object} | {ok: false, reason: string}}
 */
export function parseGithubReference(input) {
  const text = String(input || '').trim();
  if (!text) return { ok: false, reason: 'empty reference' };

  // `owner/repo` shorthand, optionally with `@ref` and a `/sub/path`.
  if (!/^https?:\/\//i.test(text) && !text.includes(':')) {
    const at = text.indexOf('@');
    const repoPart = at === -1 ? text : text.slice(0, at);
    const rest = at === -1 ? '' : text.slice(at + 1);
    const shorthand = repoPart.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!shorthand) return { ok: false, reason: 'not a recognised GitHub reference' };
    let branch = null;
    let subpath = null;
    if (rest) {
      const segments = rest.replace(/^\/+/, '').split('/').filter(Boolean);
      branch = segments.shift() || null;
      subpath = segments.length ? normalizeSubpath(segments.join('/')) : null;
    }
    return {
      ok: true,
      ref: {
        kind: 'repo',
        owner: shorthand[1],
        repo: shorthand[2].replace(/\.git$/, ''),
        branch,
        subpath,
        url: `https://github.com/${shorthand[1]}/${shorthand[2]}`,
      },
    };
  }

  // `git@github.com:owner/repo.git` — the form copied from a clone dialog.
  const scp = text.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (scp) {
    return {
      ok: true,
      ref: { kind: 'repo', owner: scp[1], repo: scp[2], branch: null, subpath: null, url: `https://github.com/${scp[1]}/${scp[2]}` },
    };
  }

  let parsed = null;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'only http(s) URLs are supported' };
  }

  const host = parsed.hostname.toLowerCase();

  if (RAW_HOSTS.has(host)) {
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 4) return { ok: false, reason: 'incomplete raw.githubusercontent.com URL' };
    return {
      ok: true,
      ref: {
        kind: 'rawFile',
        owner: segments[0],
        repo: segments[1],
        branch: segments[2],
        subpath: normalizeSubpath(segments.slice(3).join('/')),
        url: parsed.href,
      },
    };
  }

  if (!GITHUB_HOSTS.has(host)) {
    return { ok: true, ref: { kind: 'url', url: parsed.href } };
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return { ok: false, reason: 'GitHub URL must reference a repository' };
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, '');

  if (segments.length === 2) {
    return { ok: true, ref: { kind: 'repo', owner, repo, branch: null, subpath: null, url: `https://github.com/${owner}/${repo}` } };
  }

  const mode = segments[2];
  if (mode === 'tree' || mode === 'blob') {
    const rest = segments.slice(3);
    if (!rest.length) return { ok: false, reason: `GitHub ${mode} URL is missing a ref` };
    return {
      ok: true,
      ref: {
        kind: mode === 'blob' ? 'blobFile' : 'treeDir',
        owner,
        repo,
        refCandidates: refCandidates(rest),
        url: parsed.href,
      },
    };
  }

  if (mode === 'releases' && segments[3] === 'download') {
    return { ok: true, ref: { kind: 'url', url: parsed.href } };
  }

  return { ok: false, reason: `unsupported GitHub URL form "/${mode}/"; use a repository, /tree/, /blob/ or a raw link` };
}

/** Candidate (ref, subpath) splits, longest ref first. */
export function refCandidates(rest) {
  const candidates = [];
  for (let index = rest.length; index >= 1; index -= 1) {
    candidates.push({
      branch: rest.slice(0, index).join('/'),
      subpath: rest.length > index ? normalizeSubpath(rest.slice(index).join('/')) : null,
    });
  }
  return candidates;
}

/** Normalize a slash path, refusing traversal. Returns null when nothing is left. */
export function normalizeSubpath(value) {
  const text = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = [];
  for (const segment of text.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.length ? segments.join('/') : null;
}

/** Ordered archive URLs to try for a repository reference. */
export function archiveUrls(ref) {
  const base = `https://codeload.github.com/${ref.owner}/${ref.repo}/tar.gz`;
  const urls = [];
  if (ref.branch) urls.push(`${base}/refs/heads/${encodeURIComponent(ref.branch)}`);
  urls.push(`${base}/refs/heads/main`, `${base}/refs/heads/master`);
  if (ref.branch && !refsAsBranch(ref.branch)) urls.push(`${base}/${encodeURIComponent(ref.branch)}`);
  return [...new Set(urls)];
}

function refsAsBranch(branch) {
  return branch === 'main' || branch === 'master';
}

/** Expand a parsed reference into the candidates a resolver should probe. */
export function resolutionPlan(ref) {
  if (!ref || typeof ref !== 'object') return { ok: false, reason: 'no reference' };
  if (ref.kind === 'repo') {
    return {
      ok: true,
      kind: 'archive',
      attempts: archiveUrls(ref).map((url) => ({ url, branch: ref.branch ?? null, subpath: ref.subpath ?? null })),
    };
  }
  if (ref.kind === 'treeDir' || ref.kind === 'blobFile') {
    const attempts = [];
    for (const candidate of ref.refCandidates ?? []) {
      for (const url of archiveUrls({ owner: ref.owner, repo: ref.repo, branch: candidate.branch })) {
        attempts.push({ url, branch: candidate.branch, subpath: candidate.subpath });
      }
    }
    return { ok: true, kind: 'archive', attempts };
  }
  if (ref.kind === 'rawFile') return { ok: true, kind: 'raw', attempts: [{ url: ref.url, subpath: ref.subpath ?? null }] };
  if (ref.kind === 'url') return { ok: true, kind: 'raw', attempts: [{ url: ref.url, subpath: null }] };
  return { ok: false, reason: `unknown reference kind ${ref.kind}` };
}

/** A short human description of a parsed reference, for a surface that shows one. */
export function describeRef(ref) {
  if (!ref || typeof ref !== 'object') return 'unknown reference';
  if (ref.kind === 'repo') return `repository ${ref.owner}/${ref.repo}${ref.branch ? ` @ ${ref.branch}` : ''}${ref.subpath ? ` (${ref.subpath})` : ''}`;
  if (ref.kind === 'treeDir') return `directory ${ref.owner}/${ref.repo} (${ref.refCandidates?.length ?? 0} ref split(s) to probe)`;
  if (ref.kind === 'blobFile') return `file ${ref.owner}/${ref.repo} (${ref.refCandidates?.length ?? 0} ref split(s) to probe)`;
  if (ref.kind === 'rawFile') return `raw file ${ref.owner}/${ref.repo}@${ref.branch}/${ref.subpath ?? ''}`;
  if (ref.kind === 'url') return `direct URL ${ref.url}`;
  return `unknown reference kind ${ref.kind}`;
}

/* --------------------------------------------------------------- scanning */

/** The disk-backed read adapter, for a caller that scans the real filesystem. */
export function diskAdapter() {
  return {
    isDirectory(target) {
      try {
        return nodeFs.statSync(target).isDirectory();
      } catch {
        return false;
      }
    },
    isFile(target) {
      try {
        return nodeFs.statSync(target).isFile();
      } catch {
        return false;
      }
    },
    list(target) {
      try {
        return nodeFs.readdirSync(target, { withFileTypes: true }).map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
      } catch {
        return [];
      }
    },
  };
}

/**
 * Locate skill bundles under one directory, most specific answer only, in the
 * donor's strict order: subpath, "this directory is a skill", a conventional
 * `skills/` collection, sibling skill directories, then flat `<name>.md` files.
 * Scaffolding is skipped at every level.
 */
export function scanDirectory(read, dir, { subpath = null, readSkillFile = readerFor(read) } = {}) {
  if (subpath) {
    const target = nodePath.join(dir, ...subpath.split('/'));
    const own = inspectForBundle(read, target);
    if (own) return { bundles: [{ name: nodePath.basename(target), dir: target, file: own.file }], files: [], isBundle: true };
    const flat = inspectForSkillFile(read, target, readSkillFile);
    if (flat) return { bundles: [], files: [{ name: flat.name, dir: flat.dir, file: flat.file }], isBundle: true };
    const within = scanDirectory(read, target, { readSkillFile });
    if (within.bundles.length || within.files.length) return within;
  }

  if (inspectForBundle(read, dir)) {
    return { bundles: [{ name: nodePath.basename(dir), dir, file: nodePath.join(dir, 'SKILL.md') }], files: [], isBundle: true };
  }

  const collectionRoot = firstDirectory(read, dir, ['skills', 'skill']);
  if (collectionRoot) {
    const collection = collectFrom(read, collectionRoot, { skipScaffold: true, readSkillFile });
    if (collection.bundles.length) return { ...collection, isBundle: false };
  }

  const entries = listDirectories(read, dir).filter((entry) => !SCAFFOLD_DIRS.has(entry.name.toLowerCase()));
  const siblings = entries
    .filter((entry) => nodePath.join(dir, entry.name) !== collectionRoot)
    .flatMap((entry) => collectFrom(read, nodePath.join(dir, entry.name), { skipScaffold: true, readSkillFile }).bundles);
  if (siblings.length) return { bundles: siblings, files: [], isBundle: false };

  return { ...collectFrom(read, dir, { skipScaffold: true, readSkillFile }), isBundle: false };
}

/** Skills directly under `dir`, split into bundles (`<name>/SKILL.md`) and flat `<name>.md`. */
export function collectFrom(read, dir, { skipScaffold = false, readSkillFile = readerFor(read) } = {}) {
  const bundles = [];
  const files = [];
  for (const entry of read.list(dir)) {
    const full = nodePath.join(dir, entry.name);
    if (entry.directory) {
      if (skipScaffold && SCAFFOLD_DIRS.has(entry.name.toLowerCase())) continue;
      const bundle = inspectForBundle(read, full);
      if (bundle) bundles.push({ name: entry.name, dir: full, file: bundle.file });
      continue;
    }
    const flat = inspectForSkillFile(read, full, readSkillFile);
    if (flat) files.push({ name: flat.name, dir, file: full });
  }
  return { bundles, files };
}

/**
 * Locate skill candidates inside an extracted repository root. A candidate root
 * that *is* a skill outranks anything found by descending from an outer directory.
 */
export function locateSkills(read, extractDir, { subpath = null, readSkillFile = readerFor(read) } = {}) {
  const directories = listDirectories(read, extractDir);
  const roots = [extractDir];
  if (directories.length === 1) roots.push(nodePath.join(extractDir, directories[0].name));

  let first = null;
  for (const root of roots) {
    const found = scanDirectory(read, root, { subpath, readSkillFile });
    const candidates = [...found.bundles, ...found.files];
    if (!candidates.length) continue;
    if (found.isBundle) return { candidates, top: root, isBundle: true };
    if (!first) first = { candidates, top: root, isBundle: false };
  }
  return first ? { ...first } : { candidates: [], top: null, isBundle: false };
}

/**
 * Inspect a local path and produce installable candidates. Reading a skill file
 * goes through the injected `readSkillFile` so the caller owns the parser.
 */
export function inspectLocalPath(read, target, { readSkillFile = readerFor(read) } = {}) {
  const resolved = nodePath.resolve(String(target || ''));
  if (read.isFile(resolved)) {
    if (!resolved.toLowerCase().endsWith('.md')) {
      return { ok: false, reason: 'only .md skill files or skill directories can be scanned' };
    }
    const parsed = readSkillFile(resolved);
    if (!parsed.ok) return { ok: false, reason: `not a valid skill file: ${parsed.reason}` };
    return {
      ok: true,
      source: { kind: 'local', path: resolved },
      candidates: [{ name: parsed.skill.name, dir: nodePath.dirname(resolved), file: resolved, skill: parsed.skill }],
    };
  }
  if (!read.isDirectory(resolved)) return { ok: false, reason: `path does not exist: ${resolved}` };

  const found = scanDirectory(read, resolved, { readSkillFile });
  const located = [...found.bundles, ...found.files];
  const candidates = [];
  const rejections = [];
  const noteRejection = (label, reason) => {
    if (!rejections.some((item) => item.reason === reason)) rejections.push({ label, reason });
  };
  for (const item of located) {
    const parsed = readSkillFile(item.file);
    if (parsed.ok) candidates.push({ name: parsed.skill.name, dir: item.dir, file: item.file, skill: parsed.skill });
    else noteRejection(nodePath.relative(resolved, item.file) || nodePath.basename(item.file), parsed.reason);
  }

  if (!candidates.length && read.isFile(nodePath.join(resolved, 'SKILL.md'))) {
    const parsed = readSkillFile(nodePath.join(resolved, 'SKILL.md'));
    if (!parsed.ok) noteRejection('SKILL.md', parsed.reason);
  }

  if (!candidates.length) {
    if (rejections.length) {
      const detail = rejections.map((item) => `${item.label}: ${item.reason}`).join('; ');
      return { ok: false, reason: `the skill files under that path did not validate -> ${detail}`, rejections };
    }
    return { ok: false, reason: 'no skill found: expected SKILL.md, <name>/SKILL.md or <name>.md with a name and description' };
  }
  return { ok: true, source: { kind: 'local', path: resolved }, candidates, isBundle: found.isBundle };
}

/**
 * The skill-file reader that matches a read adapter. An adapter that exposes the
 * file *contents* (`read(file)`, as the in-memory test tree does) is authoritative
 * for its own tree; the disk adapter, which exposes only structure, falls back to
 * `defaultReadSkillFile`. Either way the caller may inject its own parser.
 */
function readerFor(read) {
  const memoryRead = read?.read;
  if (typeof memoryRead !== 'function') return defaultReadSkillFile;
  return (file) => {
    const text = memoryRead.call(read, file);
    if (typeof text === 'string') return parseSkillText(text);
    return defaultReadSkillFile(file);
  };
}

function defaultReadSkillFile(file) {
  let text;
  try {
    const info = nodeFs.statSync(file);
    if (!info.isFile()) return { ok: false, reason: 'not a file' };
    text = nodeFs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, reason: `unreadable: ${error?.message || error}` };
  }
  return parseSkillText(text);
}

function listDirectories(read, dir) {
  return read.list(dir).filter((entry) => entry.directory && !entry.name.startsWith('.'));
}

function firstDirectory(read, root, names) {
  for (const name of names) {
    const candidate = nodePath.join(root, name);
    if (read.isDirectory(candidate)) return candidate;
  }
  return null;
}

function inspectForBundle(read, dir) {
  const file = nodePath.join(dir, 'SKILL.md');
  if (!read.isFile(file)) return null;
  return { dir, file, name: nodePath.basename(dir) };
}

function inspectForSkillFile(read, target, readSkillFile = readerFor(read)) {
  if (!read.isFile(target)) return null;
  if (!target.toLowerCase().endsWith('.md')) return null;
  const parsed = readSkillFile(target);
  if (!parsed.ok) return null;
  return { dir: nodePath.dirname(target), file: target, name: nodePath.basename(target, nodePath.extname(target)) };
}
