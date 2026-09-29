/**
 * D5 — Skill Discovery Lab focused tests, including donor parity.
 *
 * The reference-parsing vectors, the archive URL order, the tiered scanner order
 * and the catalog search behaviour restate the DS-Hns donor modules
 * (`skill-source.js`, `skill-catalog.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b).
 * The scanner runs against both an in-memory tree and the real sandbox samples.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath, { join } from 'node:path';
import { startTestHub } from './harness.mjs';
import { parseSkillText } from '../../../city/02-engineering/02-worker-gateway/skill-intake/format.mjs';
import {
  BUNDLED_SKILLS,
  CURATED_COLLECTIONS,
  SAFE_SCAN_ROOT,
  archiveUrls,
  createCatalog,
  describeRef,
  diskAdapter,
  inspectLocalPath,
  locateSkills,
  normalizeSubpath,
  parseGithubReference,
  refCandidates,
  renderCatalogSkill,
  resolutionPlan,
  scanDirectory,
} from '../rooms/skill-discovery-lab/discovery-core.mjs';

const API = '/local-rooms/v1/skill-discovery-lab';
const DONOR_COMMIT = 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b';

/** An in-memory read adapter: keys are slash paths, values are file contents. */
function memoryAdapter(tree) {
  // The scanner joins directory names with the host separator, so the adapter
  // normalises its keys the same way instead of assuming POSIX.
  const key = (path) => nodePath.normalize(path);
  const contents = new Map(Object.entries(tree).map(([path, text]) => [key(path), text]));
  const paths = new Set(contents.keys());
  const directories = new Set();
  for (const path of paths) {
    const parts = path.split(nodePath.sep);
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join(nodePath.sep));
  }
  const list = (dir) => {
    const root = key(dir);
    const prefix = root.endsWith(nodePath.sep) ? root : `${root}${nodePath.sep}`;
    const direct = new Set();
    for (const path of [...paths, ...directories]) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest || rest.includes(nodePath.sep)) continue;
      direct.add(rest);
    }
    return [...direct].map((name) => ({ name, directory: directories.has(`${prefix}${name}`) }));
  };
  return {
    isDirectory: (dir) => directories.has(key(dir)),
    isFile: (file) => paths.has(key(file)),
    list,
    read: (file) => contents.get(key(file)) ?? null,
  };
}

function skillDoc(name, description, extra = '') {
  return `---\nname: ${name}\ndescription: ${description}\n${extra ? `${extra}\n` : ''}---\n\n# ${name}\n`;
}

test('GitHub reference parsing matches the donor', () => {
  assert.deepEqual(parseGithubReference('owner/repo').ref, {
    kind: 'repo',
    owner: 'owner',
    repo: 'repo',
    branch: null,
    subpath: null,
    url: 'https://github.com/owner/repo',
  });
  assert.equal(parseGithubReference('owner/repo.git').ref.repo, 'repo');
  assert.equal(parseGithubReference('owner/repo@main').ref.branch, 'main');
  assert.equal(parseGithubReference('owner/repo@main/skills/docx').ref.subpath, 'skills/docx');
  assert.equal(parseGithubReference('git@github.com:owner/repo.git').ref.repo, 'repo');
  assert.equal(parseGithubReference('https://github.com/owner/repo').ref.kind, 'repo');
  assert.equal(parseGithubReference('https://github.com/owner/repo/tree/main/skills').ref.kind, 'treeDir');
  assert.equal(parseGithubReference('https://github.com/owner/repo/blob/main/x/SKILL.md').ref.kind, 'blobFile');
  assert.equal(parseGithubReference('https://raw.githubusercontent.com/o/r/main/x/SKILL.md').ref.kind, 'rawFile');
  assert.equal(parseGithubReference('https://raw.githubusercontent.com/o/r/main/x/SKILL.md').ref.subpath, 'x/SKILL.md');
  assert.equal(parseGithubReference('https://example.com/skill.md').ref.kind, 'url');
  assert.equal(parseGithubReference('https://github.com/owner/repo/releases/download/v1/skill.md').ref.kind, 'url');

  for (const bad of ['', '   ', 'not a ref', 'https://github.com/owneronly', 'https://github.com/o/r/commits/main', 'ftp://example.com/x']) {
    const result = parseGithubReference(bad);
    assert.equal(result.ok, false, String(bad));
    assert.ok(result.reason.length > 0, String(bad));
  }
  assert.equal(parseGithubReference('owner/repo@main/../../etc').ref.subpath, null, 'traversal is rejected inside a subpath');
  assert.equal(normalizeSubpath('a/./b/../c'), null);
  assert.equal(normalizeSubpath('/a/b/'), 'a/b');
  assert.equal(refCandidates(['main', 'skills'])[0].branch, 'main/skills', 'the longest ref is tried first');
  assert.equal(refCandidates(['main', 'skills'])[1].subpath, 'skills');
});

test('archive planning and the resolution plan match the donor ordering', () => {
  const urls = archiveUrls({ owner: 'o', repo: 'r', branch: 'dev' });
  assert.equal(urls[0], 'https://codeload.github.com/o/r/tar.gz/refs/heads/dev');
  assert.ok(urls.includes('https://codeload.github.com/o/r/tar.gz/refs/heads/main'));
  assert.ok(urls.includes('https://codeload.github.com/o/r/tar.gz/refs/heads/master'));
  assert.equal(new Set(urls).size, urls.length, 'no duplicate attempts');
  assert.equal(archiveUrls({ owner: 'o', repo: 'r', branch: 'main' }).length, 2, 'a branch that is main does not add a third form');

  const repoPlan = resolutionPlan(parseGithubReference('o/r@dev/sub').ref);
  assert.equal(repoPlan.kind, 'archive');
  assert.equal(repoPlan.attempts[0].branch, 'dev');
  assert.equal(repoPlan.attempts[0].subpath, 'sub');
  const treePlan = resolutionPlan(parseGithubReference('https://github.com/o/r/tree/main/skills/docx').ref);
  assert.ok(treePlan.attempts.length >= 2, 'a tree URL probes several ref splits');
  assert.equal(resolutionPlan(parseGithubReference('https://example.com/x.md').ref).kind, 'raw');
  assert.equal(resolutionPlan(null).ok, false);
  assert.match(describeRef(parseGithubReference('o/r').ref), /repository o\/r/);
});

test('the tiered scanner resolves bundles, collections, siblings and flat files', () => {
  const read = diskAdapter();

  const collection = inspectLocalPath(read, join(SAFE_SCAN_ROOT, 'skills'));
  assert.equal(collection.ok, true);
  assert.deepEqual(collection.candidates.map((candidate) => candidate.name).sort(), ['alpha-skill', 'beta-skill']);
  assert.ok(!collection.candidates.some((candidate) => candidate.name.includes('template')), 'scaffolding is skipped inside a collection');

  const single = inspectLocalPath(read, join(SAFE_SCAN_ROOT, 'single'));
  assert.equal(single.ok, true);
  assert.deepEqual(single.candidates.map((candidate) => candidate.name), ['single-skill']);
  assert.equal(single.isBundle, true, 'a directory that is itself a skill reports as a bundle');

  const flat = inspectLocalPath(read, join(SAFE_SCAN_ROOT, 'flat'));
  assert.equal(flat.ok, true);
  assert.deepEqual(flat.candidates.map((candidate) => candidate.name), ['gamma'], 'the unparseable flat file is not offered');

  const siblings = inspectLocalPath(read, join(SAFE_SCAN_ROOT, 'multi'));
  assert.equal(siblings.ok, true);
  assert.deepEqual(siblings.candidates.map((candidate) => candidate.name).sort(), ['multi-one', 'multi-two']);

  const empty = inspectLocalPath(read, join(SAFE_SCAN_ROOT, 'empty'));
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /no skill found/);

  const missing = inspectLocalPath(read, join(SAFE_SCAN_ROOT, 'does-not-exist'));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /does not exist/);

  const notMarkdown = inspectLocalPath(read, join(SAFE_SCAN_ROOT, 'skills', 'template', 'SKILL.md'));
  assert.equal(notMarkdown.ok, true, 'a direct file path is still readable when it validates');
});

test('the scanner is deterministic over an injected in-memory tree', () => {
  // Absolute, host-native memory paths: `inspectLocalPath` resolves what it is given,
  // so an in-memory root has to look like a real one on this host.
  const MEM = nodePath.resolve('utopia-memory-tree');
  const mem = (...parts) => nodePath.join(MEM, ...parts);

  // The collection is deliberately *not* named `skills`, because a directory with
  // that name is scaffolding-skipped when scanning a repository root: only the
  // conventional collection probe may look inside it.
  const tree = {
    [mem('root', 'collection', 'alpha', 'SKILL.md')]: skillDoc('alpha', 'Alpha'),
    [mem('root', 'collection', 'beta', 'SKILL.md')]: skillDoc('beta', 'Beta'),
    [mem('root', 'collection', 'tests', 'SKILL.md')]: skillDoc('tests', 'Must be skipped'),
    [mem('root', 'notes.md')]: skillDoc('notes', 'A flat skill'),
  };
  const read = memoryAdapter(tree);
  const found = scanDirectory(read, mem('root'));
  assert.deepEqual(found.bundles.map((bundle) => bundle.name).sort(), ['alpha', 'beta']);
  assert.equal(found.isBundle, false);
  // Donor parity: sibling skill directories are the most specific answer, so loose
  // flat `<name>.md` files beside them are not also offered.
  assert.deepEqual(found.files, [], 'sibling bundles outrank loose flat files');

  const subpath = scanDirectory(read, mem('root'), { subpath: 'collection/beta' });
  assert.deepEqual(subpath.bundles.map((bundle) => bundle.name), ['beta']);
  assert.equal(subpath.isBundle, true);

  const located = locateSkills(read, mem('root'));
  assert.deepEqual(located.candidates.map((candidate) => candidate.name).sort(), ['alpha', 'beta']);
  assert.deepEqual(locateSkills(read, mem('nowhere')), { candidates: [], top: null, isBundle: false });

  // flat `<name>.md` files are the answer when no sibling bundle exists
  const flatOnly = memoryAdapter({ [mem('flat', 'notes.md')]: skillDoc('notes', 'A flat skill') });
  const flatFound = scanDirectory(flatOnly, mem('flat'));
  assert.deepEqual(flatFound.files.map((file) => file.name), ['notes']);
  assert.deepEqual(flatFound.bundles, []);

  // A directory whose own SKILL.md outranks a nested one. `locateSkills` reports the
  // scanner's own names (the directory / file names); parsing the frontmatter and
  // taking the skill's declared name happens later, in `inspectLocalPath`.
  const nested = memoryAdapter({
    [mem('wrap', 'SKILL.md')]: skillDoc('wrapper', 'Wrapper skill'),
    [mem('wrap', 'inner', 'SKILL.md')]: skillDoc('inner', 'Nested'),
  });
  const outerWins = locateSkills(nested, mem('wrap'));
  assert.deepEqual(outerWins.candidates.map((candidate) => candidate.name), ['wrap'], 'the outer skill wins');
  assert.equal(outerWins.isBundle, true, 'a directory that is a skill answers as a bundle');
  assert.ok(!outerWins.candidates.some((candidate) => candidate.name === 'inner'), 'the nested skill is never offered');
  const parsedWinner = inspectLocalPath(nested, mem('wrap'), {
    readSkillFile: (file) => parseSkillText(nested.read(file) ?? ''),
  });
  assert.deepEqual(parsedWinner.candidates.map((candidate) => candidate.name), ['wrapper'], 'parsing the winner reports the name it declares');

  // the conventional `skills/` collection is still probed on a repository root
  const conventional = memoryAdapter({
    [mem('repo', 'skills', 'alpha', 'SKILL.md')]: skillDoc('alpha', 'Alpha'),
    [mem('repo', 'skills', 'template', 'SKILL.md')]: skillDoc('template-skill', 'Scaffolding'),
  });
  const fromRepo = scanDirectory(conventional, mem('repo'));
  assert.deepEqual(fromRepo.bundles.map((bundle) => bundle.name), ['alpha'], 'the conventional collection is found and filtered');
});

test('the curated catalog searches offline and degrades a failed live search', async () => {
  const catalog = createCatalog();
  assert.ok(CURATED_COLLECTIONS.length >= 2);
  assert.ok(BUNDLED_SKILLS.length >= 4);

  const all = await catalog.search({});
  assert.equal(all.ok, true);
  assert.equal(all.offline.total, CURATED_COLLECTIONS.length + BUNDLED_SKILLS.length, 'every offline entry matches an empty query');
  assert.equal(all.liveStatus, 'not-requested');

  const byName = await catalog.search({ query: 'repo-tour' });
  assert.equal(byName.offline.entries[0].name, 'repo-tour', 'a name hit ranks first');
  assert.equal(byName.offline.entries[0].origin, 'bundled');

  const byTag = await catalog.search({ tags: ['offline'] });
  assert.ok(byTag.offline.entries.length >= 3);
  assert.ok(byTag.offline.entries.every((entry) => entry.tags.includes('offline')));

  const none = await catalog.search({ query: 'definitely-not-present' });
  assert.equal(none.offline.total, 0);

  const unavailable = await catalog.search({ query: '', includeLive: true });
  assert.equal(unavailable.liveStatus, 'unavailable', 'no injected fetch means live search is unavailable');
  assert.equal(unavailable.offline.total, CURATED_COLLECTIONS.length + BUNDLED_SKILLS.length, 'curated results still stand');

  const failing = createCatalog({ fetchJson: async () => { throw new Error('network down'); } });
  const failed = await failing.search({ query: 'repo', includeLive: true });
  assert.equal(failed.liveStatus, 'failed');
  assert.match(failed.notices.join(' '), /network down/);
  assert.ok(failed.offline.total > 0, 'a live failure never removes the offline answer');

  const working = createCatalog({
    fetchJson: async (url) => {
      assert.match(url, /api\.github\.com\/search\/code\?/);
      assert.match(decodeURIComponent(url), /filename:SKILL\.md/);
      return {
        items: [
          { path: 'skills/docx/SKILL.md', repository: { name: 'skills', owner: { login: 'anthropics' }, description: 'Official skills', stargazers_count: 42, html_url: 'https://github.com/anthropics/skills' } },
          { path: 'other/SKILL.md', repository: { name: 'skills', owner: { login: 'anthropics' } } },
        ],
      };
    },
  });
  const live = await working.search({ query: 'docx', includeLive: true });
  assert.equal(live.liveStatus, 'ok');
  assert.equal(live.live.length, 1, 'one entry per repository');
  assert.equal(live.live[0].subpath, 'skills/docx');
  assert.equal(live.live[0].stars, 42);
  assert.ok(working.tags().length > 0, 'tag chips come from the offline catalog');

  const bundled = catalog.get('bundled-code-review');
  assert.equal(bundled.origin, 'bundled');
  const rendered = renderCatalogSkill(bundled);
  assert.match(rendered, /name: code-review/);
  assert.match(rendered, /source: utopia bundled skill catalog/, 'a rendered bundled skill is a real SKILL.md');
  assert.match(rendered, /tags: review, quality, offline/);
  assert.equal(renderCatalogSkill({ name: 'Bad Name' }), null, 'an invalid bundled name renders nothing');
  assert.equal(catalog.get('nope'), null);
});

test('the room exposes reference parsing, scanning, resolution and catalog search', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const capabilities = await hub.api('GET', `${API}/capabilities`);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.payload.installs, false);
  assert.equal(capabilities.payload.downloads, false);
  assert.equal(capabilities.payload.donor.commit, DONOR_COMMIT);
  assert.deepEqual(capabilities.payload.donor.sourcePaths, [
    'app/extensions/mega/skills/skill-source.js',
    'app/extensions/mega/skills/skill-catalog.js',
  ]);
  assert.match(capabilities.payload.reuse.note, /never copies/);

  const parsed = await hub.api('POST', `${API}/reference/parse`, { reference: 'o/r@main/sub' });
  assert.equal(parsed.payload.ok, true);
  assert.equal(parsed.payload.ref.branch, 'main');
  assert.equal(parsed.payload.plan.attempts.length >= 2, true);
  const badRef = await hub.api('POST', `${API}/reference/parse`, { reference: 'nonsense !!' });
  assert.equal(badRef.payload.ok, false);

  const scanned = await hub.api('POST', `${API}/source/scan`, { path: 'samples/skills' });
  assert.equal(scanned.payload.ok, true);
  assert.deepEqual(scanned.payload.candidates.map((candidate) => candidate.name).sort(), ['alpha-skill', 'beta-skill']);
  assert.equal(scanned.payload.isBundle, false);

  const subScanned = await hub.api('POST', `${API}/source/scan`, { path: 'samples', subpath: 'single' });
  assert.equal(subScanned.payload.ok, true);
  assert.deepEqual(subScanned.payload.bundles.map((bundle) => bundle.name), ['single']);

  for (const bad of [{ path: 'samples/../..' }, { path: 'samples', subpath: '../etc' }]) {
    const response = await hub.api('POST', `${API}/source/scan`, bad);
    assert.equal(response.status, 400, JSON.stringify(bad));
  }

  const preview = await hub.api('POST', `${API}/source/preview`, { catalogEntry: 'anthropic-skills' });
  assert.equal(preview.payload.ok, true);
  assert.equal(preview.payload.kind, 'curated');
  assert.match(preview.payload.reference, /anthropics\/skills/);
  assert.equal((await hub.api('POST', `${API}/source/preview`, { catalogEntry: 'nope' })).payload.ok, false);

  const referencePreview = await hub.api('POST', `${API}/source/preview`, { reference: 'anthropics/skills@main' });
  assert.equal(referencePreview.payload.kind, 'repo');
  assert.ok(referencePreview.payload.plan.attempts.length >= 1);

  const search = await hub.api('POST', `${API}/catalog/search`, { query: 'review' });
  assert.equal(search.payload.ok, true);
  assert.ok(search.payload.offline.total >= 1);
  assert.ok(Array.isArray(search.payload.tags));

  const liveWithoutEndpoint = await hub.api('POST', `${API}/catalog/search`, { query: '', includeLive: true });
  assert.equal(liveWithoutEndpoint.payload.liveStatus, 'unavailable', 'the room never calls out without an injected endpoint');
  assert.equal((await hub.api('POST', `${API}/catalog/live`, { query: 'x' })).status, 400);

  const entry = await hub.api('POST', `${API}/catalog/preview`, { id: 'bundled-repo-tour' });
  assert.equal(entry.payload.ok, true);
  assert.equal(entry.payload.entry.origin, 'bundled');
});

test('the room never writes a runtime file and never installs or downloads', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  const { readdir, readFile } = await import('node:fs/promises');
  await hub.api('POST', `${API}/source/scan`, { path: 'samples/skills' });
  assert.deepEqual(await readdir(hub.runtimeDir), [], 'the lab has no durable file');

  const roomDir = join(import.meta.dirname, '..', 'rooms', 'skill-discovery-lab');
  for (const file of ['source.mjs', 'catalog.mjs', 'discovery-core.mjs']) {
    const code = (await readFile(join(roomDir, file), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ["require('", 'from "app/', "from 'app/", 'child_process', 'writeFileSync', 'extractTar']) {
      assert.ok(!code.includes(forbidden), `${file} must not ${forbidden}`);
    }
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
    }
  }
  // the format parser comes from the promoted city module, never a second copy
  const bridge = await readFile(join(roomDir, 'format-bridge.mjs'), 'utf8');
  assert.match(bridge, /skill-intake\/format\.mjs/, 'the SKILL.md parser is reused from the city core');
  for (const file of ['source.mjs', 'catalog.mjs']) {
    const code = await readFile(join(roomDir, file), 'utf8');
    assert.match(code, /from '\.\/format-bridge\.mjs'/, `${file} reaches the city core through the one bridge`);
  }
});
