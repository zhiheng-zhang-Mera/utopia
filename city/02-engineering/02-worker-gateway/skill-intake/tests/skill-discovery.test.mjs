/**
 * UTOPIA · City · Skill Intake — skill discovery suite (D5 promotion).
 *
 * The reference-parsing vectors, the archive URL order, the tiered scanner order
 * and the catalog search behaviour restate the DS-Hns donor modules
 * (`skill-source.js`, `skill-catalog.js` @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b).
 * The scanner runs against both an in-memory tree and the real sample fixtures,
 * and the SKILL.md parser used throughout is this module's own `format.mjs`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import nodePath, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillText } from '../format.mjs';
import {
  archiveUrls,
  describeRef,
  diskAdapter,
  inspectLocalPath,
  locateSkills,
  normalizeSubpath,
  parseGithubReference,
  refCandidates,
  resolutionPlan,
  scanDirectory,
} from '../source.mjs';
import {
  BUNDLED_SKILLS,
  CURATED_COLLECTIONS,
  createCatalog,
  renderCatalogSkill,
} from '../catalog.mjs';

/** The only directory tree this suite scans: its own fixtures. */
const SAMPLE_ROOT = join(fileURLToPath(new URL('./samples', import.meta.url)));

/** An in-memory read adapter: keys are host paths, values are file contents. */
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
  assert.equal(describeRef(null), 'unknown reference');
});

test('a resolved plan is offline only: no download happens and none is planned', () => {
  const plan = resolutionPlan(parseGithubReference('anthropics/skills@main/skills/docx').ref);
  assert.equal(plan.kind, 'archive');
  assert.ok(plan.attempts.length >= 1);
  for (const attempt of plan.attempts) {
    assert.match(attempt.url, /^https:\/\/(codeload\.github\.com|raw\.githubusercontent\.com)\//);
    assert.equal(typeof attempt.branch === 'string' || typeof attempt.subpath === 'string', true);
  }
  // the plan is data: resolving it is the caller's job, and this module has no
  // fetch, request or download entry point at all
  const source = diskAdapter();
  assert.equal(typeof source.fetch, 'undefined');
});

test('the tiered scanner resolves bundles, collections, siblings and flat files', () => {
  const read = diskAdapter();

  const collection = inspectLocalPath(read, join(SAMPLE_ROOT, 'skills'));
  assert.equal(collection.ok, true);
  assert.deepEqual(collection.candidates.map((candidate) => candidate.name).sort(), ['alpha-skill', 'beta-skill']);
  assert.ok(!collection.candidates.some((candidate) => candidate.name.includes('template')), 'scaffolding is skipped inside a collection');

  const single = inspectLocalPath(read, join(SAMPLE_ROOT, 'single'));
  assert.equal(single.ok, true);
  assert.deepEqual(single.candidates.map((candidate) => candidate.name), ['single-skill']);
  assert.equal(single.isBundle, true, 'a directory that is itself a skill reports as a bundle');

  const flat = inspectLocalPath(read, join(SAMPLE_ROOT, 'flat'));
  assert.equal(flat.ok, true);
  assert.deepEqual(flat.candidates.map((candidate) => candidate.name), ['gamma'], 'the unparseable flat file is not offered');

  const siblings = inspectLocalPath(read, join(SAMPLE_ROOT, 'multi'));
  assert.equal(siblings.ok, true);
  assert.deepEqual(siblings.candidates.map((candidate) => candidate.name).sort(), ['multi-one', 'multi-two']);

  const empty = inspectLocalPath(read, join(SAMPLE_ROOT, 'empty'));
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /no skill found/);

  const missing = inspectLocalPath(read, join(SAMPLE_ROOT, 'does-not-exist'));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /does not exist/);

  const notMarkdown = inspectLocalPath(read, join(SAMPLE_ROOT, 'skills', 'template', 'SKILL.md'));
  assert.equal(notMarkdown.ok, true, 'a direct file path is still readable when it validates');
});

test('the scanner is deterministic over an injected in-memory tree', () => {
  // Absolute, host-native memory paths: `inspectLocalPath` resolves what it is given,
  // so an in-memory root has to look like a real one on this host.
  const MEM = nodePath.resolve('skill-intake-memory-tree');
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

test('a scanned skill is validated by this module\'s own parser', () => {
  const read = diskAdapter();
  const collection = inspectLocalPath(read, join(SAMPLE_ROOT, 'skills'));
  const alpha = collection.candidates.find((candidate) => candidate.name === 'alpha-skill');
  assert.equal(alpha.skill.description, 'Alpha skill from a bundle');
  assert.equal(alpha.skill.body.trim(), 'Do alpha things.');
  const beta = collection.candidates.find((candidate) => candidate.name === 'beta-skill');
  assert.equal(beta.skill.whenToUse, 'when beta is needed');
  // the fixture that does not parse is refused with a reason, not offered
  const flat = inspectLocalPath(read, join(SAMPLE_ROOT, 'flat'));
  assert.ok(!flat.candidates.some((candidate) => candidate.name === 'broken'));
  const broken = inspectLocalPath(read, join(SAMPLE_ROOT, 'flat', 'broken.md'));
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /not a valid skill file/);
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

test('the module never writes a runtime file and never installs or downloads', async () => {
  const { readFile } = await import('node:fs/promises');
  const moduleDir = join(import.meta.dirname, '..');
  for (const file of ['source.mjs', 'catalog.mjs']) {
    const code = (await readFile(join(moduleDir, file), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ["require('", 'from "app/', "from 'app/", 'child_process', 'writeFileSync', 'extractTar', 'node:http', 'fetch(']) {
      assert.ok(!code.includes(forbidden), `${file} must not ${forbidden}`);
    }
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
    }
  }
  // the format parser is this module's own, never a second copy of it
  const source = await readFile(join(moduleDir, 'source.mjs'), 'utf8');
  assert.match(source, /from '\.\/format\.mjs'/, 'the SKILL.md parser is this module\'s own');
});
