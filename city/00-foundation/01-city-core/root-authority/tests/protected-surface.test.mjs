/**
 * UTOPIA · City Core — protected surface classifier suite.
 *
 * Every vector here restates the Codex-Boss donor
 * `src/shared/root-authority/protected-surface.ts` @
 * 8df428eaa437a409368401e95194e40266b83080: the CODEOWNERS subset grammar, the
 * normalization rules, the one-rule-per-path evidence rule and the escape rule.
 *
 * The manifest is caller-supplied (see DONOR.json): the donor's own list is only
 * present as inert data, so the first test states that no protected-path policy is
 * active by default.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DONOR_COMMIT,
  DONOR_REPOSITORY,
  DONOR_ROOT_PROTECTED_MANIFEST,
  assessProtectedPaths,
  codeownersPatternToRegExp,
  compileProtectedSurface,
  isProtectedPath,
  normalizeRepoPath,
  parseCodeownersPatterns,
} from '../protected-surface.mjs';

/** A small caller-supplied immutable manifest, in the donor's pattern style. */
const MANIFEST = ['/.github/CODEOWNERS', '/.github/workflows/', '/src/**/authority/', '/package.json'];

/** The donor's grammar vectors: [pattern, matching paths, non-matching paths]. */
const GRAMMAR_VECTORS = [
  // leading `/` anchors the pattern at the repository root
  ['/package.json', ['package.json'], ['sub/package.json']],
  // a pattern containing an internal `/` is root-anchored even without a leading slash
  ['src/main.ts', ['src/main.ts'], ['app/src/main.ts']],
  // a pattern with no `/` matches the basename at any depth
  ['CODEOWNERS', ['CODEOWNERS', '.github/CODEOWNERS', 'a/b/CODEOWNERS'], ['CODEOWNERS.bak']],
  // a trailing `/` matches the directory entry itself and everything beneath it
  ['/build/', ['build', 'build/out.js', 'build/a/b/c.js'], ['rebuild/out.js', 'buildx']],
  // `*` matches within a path segment
  ['/src/*.ts', ['src/a.ts', 'src/a.b.ts'], ['src/nested/a.ts', 'src/a.js']],
  // `**` matches across segments
  ['/src/**/authority.ts', ['src/authority.ts', 'src/a/authority.ts', 'src/a/b/authority.ts'], ['src/a/authority.js']],
  // `?` matches exactly one character within a segment
  ['/config/root-?.json', ['config/root-1.json', 'config/root-a.json'], ['config/root-12.json', 'config/root-.json']],
  // `**/` consumes zero or more whole segments
  ['/scripts/**/*.cjs', ['scripts/a.cjs', 'scripts/a/b.cjs', 'scripts/a/b/c.cjs'], ['scripts/a.ts']],
  // a full-segment `?` cannot cross a separator
  ['/a?b/c', ['axb/c'], ['a/b/c']],
];

test('the classifier compiles only the patterns the caller supplies', () => {
  // The donor hard-coded its own ROOT_PROTECTED_MANIFEST. Utopia does not: with no
  // options, nothing is protected, and the donor's list is inert data only.
  assert.equal(isProtectedPath('package.json'), false);
  assert.equal(isProtectedPath('.github/CODEOWNERS'), false);
  assert.deepEqual(assessProtectedPaths(['src/root-authority/x.ts']), { protected: false, hits: [], escapes: [] });
  assert.deepEqual(compileProtectedSurface().rules, []);

  // The donor's list is carried over verbatim and in order, and every entry is a
  // usable pattern — but no function reads it.
  assert.equal(DONOR_REPOSITORY, 'zhiheng-zhang-Mera/Codex-Boss');
  assert.equal(DONOR_COMMIT, '8df428eaa437a409368401e95194e40266b83080');
  assert.equal(DONOR_ROOT_PROTECTED_MANIFEST[0], '/.github/CODEOWNERS');
  assert.equal(DONOR_ROOT_PROTECTED_MANIFEST.at(-1), '/scripts/verify-authority-separation.cjs');
  assert.equal(Object.isFrozen(DONOR_ROOT_PROTECTED_MANIFEST), true);
  for (const pattern of DONOR_ROOT_PROTECTED_MANIFEST) {
    assert.ok(codeownersPatternToRegExp(pattern) instanceof RegExp, `${pattern} compiles`);
  }
  // ...and it would still classify the donor's own surface, if a caller passed it in.
  assert.equal(isProtectedPath('src/shared/root-authority/protected-surface.ts', { manifest: DONOR_ROOT_PROTECTED_MANIFEST }), true);

  // The caller's manifest is matched first, and the source says so.
  assert.deepEqual(compileProtectedSurface({ manifest: MANIFEST, extraPatterns: ['/docs/'] }).rules.map((rule) => rule.source), [
    'immutable-manifest',
    'immutable-manifest',
    'immutable-manifest',
    'immutable-manifest',
    'codeowners',
  ]);
});

test('the CODEOWNERS subset grammar matches exactly the vectors the donor documents', () => {
  for (const [pattern, matches, nonMatches] of GRAMMAR_VECTORS) {
    for (const path of matches) {
      assert.equal(isProtectedPath(path, { manifest: [pattern] }), true, `${pattern} should match ${path}`);
    }
    for (const path of nonMatches) {
      assert.equal(isProtectedPath(path, { manifest: [pattern] }), false, `${pattern} should not match ${path}`);
    }
  }

  // A pattern with no slash at all is matched against the basename at any depth; a
  // leading slash OR an internal slash both root-anchor it.
  assert.equal(isProtectedPath('deep/nested/x.ts', { manifest: ['x.ts'] }), true);
  assert.equal(isProtectedPath('deep/nested/x.ts', { manifest: ['/x.ts'] }), false);
  assert.equal(isProtectedPath('deep/nested/src/x.ts', { manifest: ['src/x.ts'] }), false);
  assert.equal(isProtectedPath('src/x.ts', { manifest: ['src/x.ts'] }), true);
  assert.equal(isProtectedPath('deep/nested/src/x.ts', { manifest: ['**/src/x.ts'] }), true);

  // An empty or whitespace-only pattern matches nothing at all.
  assert.equal(codeownersPatternToRegExp('   ').source, '$^');
  assert.equal(isProtectedPath('anything', { manifest: ['   '] }), false);
});

test('a directory pattern protects the entry itself and everything beneath it', () => {
  const options = { manifest: ['/config/'] };
  assert.equal(isProtectedPath('config', options), true, 'the directory entry itself');
  assert.equal(isProtectedPath('config/root.json', options), true, 'a direct child');
  assert.equal(isProtectedPath('config/deep/root.json', options), true, 'a descendant at any depth');
  assert.equal(isProtectedPath('configx/root.json', options), false, 'a sibling with a shared prefix');

  // The same rule makes deleting the directory (not just editing inside it) a hit:
  // delete and write are both just a path here.
  const deletion = assessProtectedPaths(['config'], [], options);
  assert.equal(deletion.protected, true);
  assert.equal(deletion.hits[0].rule, '/config/');

  // The donor's `**` quirk is carried over unchanged: `/scripts/**` is not
  // directory-suffixed, so the bare directory entry itself does not match, while a
  // descendant does. This test pins the donor's behaviour rather than an ideal one.
  const glob = { manifest: ['/scripts/**'] };
  assert.equal(isProtectedPath('scripts/build.cjs', glob), true);
  assert.equal(isProtectedPath('scripts/deep/build.cjs', glob), true);
  assert.equal(isProtectedPath('scripts', glob), false);
});

test('a bare double-star pattern behaves as the donor implements it', () => {
  // A bare `**` compiles to `.*`, so with the unanchored prefix it matches any path.
  assert.equal(codeownersPatternToRegExp('**').source, '^(?:.*\\/)?.*$');
  assert.equal(isProtectedPath('a/b/c.txt', { manifest: ['**'] }), true);
  assert.equal(isProtectedPath('top.txt', { manifest: ['**'] }), true);

  // A trailing `/` is stripped BEFORE the wildcards are read, so `**/` is the bare
  // `**` plus the directory suffix rather than a segment-consuming prefix. The
  // donor's result is that it also matches every path; this pins that, because the
  // order of those two steps is exactly what makes it so.
  assert.equal(codeownersPatternToRegExp('**/').source, '^(?:.*\\/)?.*(?:\\/.*)?$');
  assert.equal(isProtectedPath('a/b/c.txt', { manifest: ['**/'] }), true);
  assert.equal(isProtectedPath('a', { manifest: ['**/'] }), true);

  // The rooted spelling behaves the same way: the leading `/` is consumed and the
  // remaining `**` matches everything.
  assert.equal(codeownersPatternToRegExp('/**/').source, '^.*(?:\\/.*)?$');
  assert.equal(isProtectedPath('a/b/c.txt', { manifest: ['/**/'] }), true);
  assert.equal(isProtectedPath('a', { manifest: ['/**/'] }), true);

  // A real cross-segment glob is unchanged: `**/` in the middle still consumes
  // zero or more whole segments.
  assert.equal(codeownersPatternToRegExp('**/*.ts').source, '^(?:[^/]+\\/)*[^/]*\\.ts$');
  assert.equal(isProtectedPath('a/b/c.ts', { manifest: ['**/*.ts'] }), true);
  assert.equal(isProtectedPath('c.ts', { manifest: ['**/*.ts'] }), true);
  assert.equal(isProtectedPath('a/b/c.js', { manifest: ['**/*.ts'] }), false);
});

test('matching is case-insensitive by default and can be tightened', () => {
  const lax = { manifest: ['/.github/workflows/', '/package.json'] };
  assert.equal(isProtectedPath('.GITHUB/WORKFLOWS/ci.yml', lax), true);
  assert.equal(isProtectedPath('Package.JSON', lax), true);
  assert.equal(assessProtectedPaths(['.Github/Codeowners'], [], { manifest: ['/.github/CODEOWNERS'] }).protected, true);

  // Over-matching is the fail-closed side; a caller that wants exact case can say so.
  const strict = { manifest: ['/.github/workflows/'], caseInsensitive: false };
  assert.equal(isProtectedPath('.github/workflows/ci.yml', strict), true);
  assert.equal(isProtectedPath('.GITHUB/workflows/ci.yml', strict), false);
  assert.equal(compileProtectedSurface(strict).caseInsensitive, false);
  assert.equal(compileProtectedSurface({ manifest: [] }).caseInsensitive, true);
});

test('one rule per path, and a repeated path is counted once', () => {
  const options = { manifest: ['/.github/workflows/'], extraPatterns: ['/.github/**'] };
  const assessment = assessProtectedPaths(
    ['.github/workflows/ci.yml', '.github/workflows/ci.yml', '.GITHUB/WORKFLOWS/CI.YML', 'src/app.ts'],
    [],
    options,
  );
  assert.equal(assessment.protected, true);
  assert.equal(assessment.hits.length, 1, 'the same path three times is one hit');
  // The immutable manifest is matched first, so it is the evidence recorded.
  assert.deepEqual(assessment.hits[0], {
    path: '.github/workflows/ci.yml',
    rule: '/.github/workflows/',
    source: 'immutable-manifest',
  });

  // A path declared in `also` is de-duplicated against one declared in `paths`.
  const both = assessProtectedPaths(['package.json'], ['package.json'], { manifest: ['/package.json'] });
  assert.equal(both.hits.length, 1);

  // With case-sensitive matching, differently-cased paths are distinct.
  const strict = assessProtectedPaths(['Package.json', 'package.json'], [], { manifest: ['/package.json'], caseInsensitive: false });
  assert.equal(strict.hits.length, 1);
  assert.equal(strict.hits[0].path, 'package.json');
});

test('the rename/delete evidence contract: `also` is assessed as well as `paths`', () => {
  const options = { manifest: ['/.github/workflows/'] };
  // A rename away from the protected surface still matches on its source half.
  const moved = assessProtectedPaths(['src/app.ts'], ['.github/workflows/ci.yml'], options);
  assert.equal(moved.protected, true);
  assert.equal(moved.hits[0].path, '.github/workflows/ci.yml');
  assert.deepEqual(moved.escapes, []);

  // Nothing at all is a clean assessment.
  assert.deepEqual(assessProtectedPaths([], [], options), { protected: false, hits: [], escapes: [] });
});

test('normalizeRepoPath accepts repo-relative input and refuses anything that escapes', () => {
  assert.equal(normalizeRepoPath('src/app.ts'), 'src/app.ts');
  assert.equal(normalizeRepoPath('  src/app.ts  '), 'src/app.ts');
  assert.equal(normalizeRepoPath('src//app.ts'), 'src/app.ts');
  assert.equal(normalizeRepoPath('./src/app.ts'), 'src/app.ts');
  assert.equal(normalizeRepoPath('src/./app.ts'), 'src/app.ts');
  assert.equal(normalizeRepoPath('src/../app.ts'), 'app.ts');
  assert.equal(normalizeRepoPath('src\\app.ts'), 'src/app.ts', 'backslashes are POSIX-normalized');

  // Refused: absolute, drive-letter, UNC, traversal past the root, and empties.
  for (const input of [
    '/etc/passwd',
    '\\etc\\passwd',
    'C:/Windows/system32',
    'c:\\Windows\\system32',
    '//server/share/x',
    '\\\\server\\share\\x',
    '..',
    '../',
    '../outside.txt',
    'src/../../outside.txt',
    '',
    '   ',
    '.',
    './',
  ]) {
    assert.equal(normalizeRepoPath(input), undefined, `${JSON.stringify(input)} must not normalize`);
  }
  // Non-strings are refused too, not coerced.
  for (const input of [null, undefined, 42, {}, ['a']]) {
    assert.equal(normalizeRepoPath(input), undefined, `${String(input)} must not normalize`);
  }
});

test('absolute paths, escapes and non-strings become escapes, never silent passes', () => {
  const options = { manifest: ['/.github/workflows/'] };

  const absolute = assessProtectedPaths(['/etc/passwd'], [], options);
  assert.equal(absolute.protected, false);
  assert.deepEqual(absolute.escapes, ['/etc/passwd']);

  const drive = assessProtectedPaths(['C:\\Users\\evil.txt'], [], options);
  assert.deepEqual(drive.escapes, ['C:\\Users\\evil.txt']);

  const traversal = assessProtectedPaths(['../../etc/passwd'], [], options);
  assert.deepEqual(traversal.escapes, ['../../etc/passwd']);

  const nonStrings = assessProtectedPaths([42, null, undefined, {}, []], [], options);
  assert.equal(nonStrings.protected, false);
  assert.deepEqual(nonStrings.escapes, ['42', 'null', 'undefined', '[object Object]', '']);

  const blank = assessProtectedPaths(['', '   '], [], options);
  assert.deepEqual(blank.escapes, ['', '   ']);

  // A path that escapes is an escape even when the raw string also looks protected.
  const sneaky = assessProtectedPaths(['../.github/workflows/ci.yml'], [], options);
  assert.equal(sneaky.protected, false);
  assert.deepEqual(sneaky.escapes, ['../.github/workflows/ci.yml']);

  // A protected hit and an escape can co-exist; both are reported.
  const mixed = assessProtectedPaths(['.github/workflows/ci.yml', '/etc/passwd'], [], options);
  assert.equal(mixed.protected, true);
  assert.equal(mixed.hits.length, 1);
  assert.deepEqual(mixed.escapes, ['/etc/passwd']);
});

test('CODEOWNERS parsing keeps only patterns that carry an owner', () => {
  const content = [
    '# a comment line',
    '',
    '* @global-owner',
    '/docs/ @docs-owner',
    '/nobody/',
    '/two/ @a @b',
    '   ',
    '/trailing/ @owner  # trailing comment',
    '   /indented/ @owner',
  ].join('\n');
  assert.deepEqual(parseCodeownersPatterns(content), ['*', '/docs/', '/two/', '/trailing/', '/indented/']);

  // The parse is total: nothing is thrown, and CRLF is handled.
  assert.deepEqual(parseCodeownersPatterns(''), []);
  assert.deepEqual(parseCodeownersPatterns('/a/ @x\r\n/b/ @y\r\n'), ['/a/', '/b/']);
  // A line whose owner list is not an `@handle` is still a pattern+owner pair to
  // the donor's plain whitespace split, so it is kept: the parser decides only
  // whether an owner list is present, never whether it looks like a real owner.
  assert.deepEqual(parseCodeownersPatterns('not a pattern'), ['not']);

  // Parsed patterns feed the classifier through `extraPatterns`.
  const patterns = parseCodeownersPatterns('/build/ @team');
  assert.equal(isProtectedPath('build/out.js', { extraPatterns: patterns }), true);
  const hit = assessProtectedPaths(['build/out.js'], [], { extraPatterns: patterns }).hits[0];
  assert.deepEqual(hit, { path: 'build/out.js', rule: '/build/', source: 'codeowners' });
});
