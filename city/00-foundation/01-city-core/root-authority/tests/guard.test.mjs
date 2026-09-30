/**
 * UTOPIA · City Core — protected surface guard suite.
 *
 * Every vector here restates the Codex-Boss donor
 * `electron/root-authority/protected-surface-guard.ts` @
 * 8df428eaa437a409368401e95194e40266b83080: the composition rule, the escape
 * limits, the rename/delete classification, the `git diff --name-only` change-set
 * path and the pattern order.
 *
 * The donor's guard owned fs and realpath containment; here containment is the
 * injected `resolve` seam, so this suite proves the same behaviour without a real
 * tree — and proves that a resolver failure is an escape, not a silent pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProtectedSurfaceGuard, assessWorkspaceChanges } from '../guard.mjs';

const MANIFEST = ['/.github/CODEOWNERS', '/.github/workflows/', '/.github/'];
const CODEOWNERS = ['/config/', '/src/protected/', '/scripts/**'];

/**
 * A containment resolver in the donor's `workspacePath` spirit: normalize the
 * requested path, refuse anything absolute or that climbs past the root, and
 * refuse the paths this fake host pretends are link escapes.
 */
function resolver({ escapePoints = [], throwing = [] } = {}) {
  return (requested) => {
    if (typeof requested !== 'string' || !requested.trim()) return undefined;
    if (throwing.includes(requested)) throw new Error(`workspacePath refused ${requested}`);
    if (escapePoints.includes(requested)) return undefined;
    const value = requested.replace(/\\/g, '/');
    if (value.startsWith('/') || /^[a-zA-Z]:\//.test(value) || value.startsWith('//')) return undefined;
    const segments = [];
    for (const segment of value.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        if (!segments.length) return undefined;
        segments.pop();
        continue;
      }
      segments.push(segment);
    }
    if (!segments.length) return undefined;
    return { relative: segments.join('/') };
  };
}

function guard(options = {}) {
  return createProtectedSurfaceGuard({
    manifest: MANIFEST,
    extraPatterns: CODEOWNERS,
    resolve: resolver(options),
    ...(options.caseInsensitive === undefined ? {} : { caseInsensitive: options.caseInsensitive }),
  });
}

test('the composition rule is fixed: escape beats protected beats clean', () => {
  const g = guard();

  // clean ⇒ ALLOW
  const clean = g.assessPaths(['src/app.ts', 'README.md']);
  assert.equal(clean.decision, 'ALLOW');
  assert.deepEqual(clean.protected, []);
  assert.deepEqual(clean.escapes, []);
  assert.deepEqual(clean.reasons, []);

  // a protected hit ⇒ REQUIRE_OWNER, with one reason per hit and no escape reason
  const protectedOnly = g.assessPaths(['.github/workflows/ci.yml']);
  assert.equal(protectedOnly.decision, 'REQUIRE_OWNER');
  assert.deepEqual(protectedOnly.escapes, []);
  assert.deepEqual(protectedOnly.reasons, [
    {
      code: 'path:protected:immutable-manifest',
      detail: '.github/workflows/ci.yml matches /.github/workflows/',
    },
  ]);

  // an escape ⇒ DENY, even when a protected path is touched in the same call
  const escaped = g.assessPaths(['../outside.txt']);
  assert.equal(escaped.decision, 'DENY');
  assert.deepEqual(escaped.reasons.map((reason) => reason.code), ['path:escape']);

  const both = g.assessPaths(['.github/workflows/ci.yml', '../outside.txt']);
  assert.equal(both.decision, 'DENY');
  assert.deepEqual(both.reasons.map((reason) => reason.code), ['path:escape', 'path:protected:immutable-manifest']);
  assert.equal(both.protected.length, 1);
  assert.deepEqual(both.escapes, ['../outside.txt']);
  assert.equal(g.compositionRule.DENY, 'any escape');
});

test('assessPaths treats anything unresolvable as an escape, never as unprotected', () => {
  const g = guard({ escapePoints: ['src/protected/inner.txt'], throwing: ['linked/out.txt'] });

  const absolute = g.assessPaths(['/etc/passwd']);
  assert.equal(absolute.decision, 'DENY');
  assert.deepEqual(absolute.escapes, ['/etc/passwd']);

  const traversal = g.assessPaths(['../../etc/passwd']);
  assert.equal(traversal.decision, 'DENY');
  assert.deepEqual(traversal.escapes, ['../../etc/passwd']);

  const driveLetter = g.assessPaths(['C:\\Windows\\system32']);
  assert.equal(driveLetter.decision, 'DENY');
  assert.deepEqual(driveLetter.escapes, ['C:\\Windows\\system32']);

  const nonStrings = g.assessPaths([42, null, undefined, {}]);
  assert.equal(nonStrings.decision, 'DENY');
  assert.deepEqual(nonStrings.escapes, ['42', 'null', 'undefined', '[object Object]']);

  const blank = g.assessPaths(['', '   ']);
  assert.equal(blank.decision, 'DENY');
  assert.deepEqual(blank.escapes, ['', '   ']);

  // a resolver that throws is an escape (the donor's try/catch around workspacePath)
  const refused = g.assessPaths(['linked/out.txt']);
  assert.equal(refused.decision, 'DENY');
  assert.deepEqual(refused.escapes, ['linked/out.txt']);

  // a link escape is an escape even though the path lexically looks protected
  const linked = g.assessPaths(['src/protected/inner.txt']);
  assert.equal(linked.decision, 'DENY');
  assert.equal(linked.protected.length, 0);

  // `also` is assessed exactly like `paths`
  const also = g.assessPaths(['src/app.ts'], ['../outside.txt']);
  assert.equal(also.decision, 'DENY');
  assert.deepEqual(also.escapes, ['../outside.txt']);
  assert.deepEqual(g.assessPaths(['src/app.ts'], []).escapes, []);
});

test('a rename is classified on both endpoints and a delete like a write', () => {
  const g = guard();

  // moving OUT of a protected directory: the source half must still be seen
  const out = g.assessChanges([{ kind: 'rename', from: '.github/workflows/ci.yml', path: 'src/ci.yml' }]);
  assert.equal(out.decision, 'REQUIRE_OWNER');
  assert.deepEqual(out.protected.map((hit) => hit.path), ['.github/workflows/ci.yml']);

  // moving INTO a protected directory: the destination half must be seen
  const into = g.assessChanges([{ kind: 'rename', from: 'src/app.ts', path: 'config/app.json' }]);
  assert.equal(into.decision, 'REQUIRE_OWNER');
  assert.deepEqual(into.protected, [{ path: 'config/app.json', rule: '/config/', source: 'codeowners' }]);

  // between two protected directories: both halves are evidence
  const within = g.assessChanges([{ kind: 'rename', from: 'config/a.json', path: '.github/b.json' }]);
  assert.equal(within.decision, 'REQUIRE_OWNER');
  assert.deepEqual(within.protected.map((hit) => hit.path).sort(), ['.github/b.json', 'config/a.json']);

  // a rename with a missing `from` contributes an escape rather than skipping half
  const missing = g.assessChanges([{ kind: 'rename', path: 'src/app.ts' }]);
  assert.equal(missing.decision, 'DENY');
  assert.deepEqual(missing.escapes, ['undefined']);

  // a delete is classified exactly like a write — same paths, same assessment
  const deleted = g.assessChanges([{ kind: 'delete', path: '.github/workflows/ci.yml' }]);
  const written = g.assessChanges([{ kind: 'write', path: '.github/workflows/ci.yml' }]);
  assert.equal(deleted.decision, 'REQUIRE_OWNER');
  assert.deepEqual(deleted, written);

  // deleting a protected directory itself is a hit (the directory-pattern rule)
  const deletedDirectory = g.assessChanges([{ kind: 'delete', path: 'config' }]);
  assert.equal(deletedDirectory.decision, 'REQUIRE_OWNER');
  assert.deepEqual(deletedDirectory.protected, [{ path: 'config', rule: '/config/', source: 'codeowners' }]);

  // `read`, `write` and `create` contribute only their `path`
  for (const kind of ['read', 'write', 'create']) {
    assert.deepEqual(g.assessChanges([{ kind, path: 'src/app.ts' }]).decision, 'ALLOW');
    assert.deepEqual(g.assessChanges([{ kind, path: 'config/app.json' }]).decision, 'REQUIRE_OWNER');
  }

  // a non-string target is an escape, and an empty change list is clean
  assert.deepEqual(g.assessChanges([{ kind: 'write', path: 42 }]).escapes, ['42']);
  assert.deepEqual(g.assessChanges([]).decision, 'ALLOW');
});

test('assessChangeSet reads repo-relative diff names and skips blanks', () => {
  const g = guard();

  const clean = g.assessChangeSet(['src/app.ts', 'docs/readme.md']);
  assert.equal(clean.decision, 'ALLOW');

  const touched = g.assessChangeSet(['src/app.ts', 'config/root.json']);
  assert.equal(touched.decision, 'REQUIRE_OWNER');
  assert.deepEqual(touched.protected, [{ path: 'config/root.json', rule: '/config/', source: 'codeowners' }]);

  // blank and non-string entries are skipped, not escaped: an empty diff line is
  // not a containment violation (the donor's `assessChangeSet` behaviour)
  const blanks = g.assessChangeSet(['', '   ', 'src/app.ts']);
  assert.equal(blanks.decision, 'ALLOW');
  assert.deepEqual(blanks.escapes, []);

  // ...but a path that escapes is still DENY
  const escaped = g.assessChangeSet(['../outside.txt']);
  assert.equal(escaped.decision, 'DENY');
  assert.deepEqual(escaped.escapes, ['../outside.txt']);

  // additional protected paths are unioned into this call, with source `codeowners`
  const extra = g.assessChangeSet(['reports/out.json'], ['/reports/']);
  assert.equal(extra.decision, 'REQUIRE_OWNER');
  assert.deepEqual(extra.protected, [{ path: 'reports/out.json', rule: '/reports/', source: 'codeowners' }]);
  // ...and they are NOT compiled into the durable surface
  assert.equal(g.patterns().some((rule) => rule.pattern === '/reports/'), false);
  assert.equal(g.assessPaths(['reports/out.json']).decision, 'ALLOW');

  // duplicate diff entries are de-duplicated
  const duplicates = g.assessChangeSet(['config/root.json', 'config/root.json', 'CONFIG/ROOT.JSON']);
  assert.equal(duplicates.protected.length, 1);
});

test('reasons list at most five escapes and at most ten protected hits', () => {
  const g = guard();

  const escapes = Array.from({ length: 7 }, (unused, index) => `../escape-${index}.txt`);
  const escaped = g.assessPaths(escapes);
  assert.equal(escaped.decision, 'DENY');
  assert.equal(escaped.escapes.length, 7, 'every escape is reported on the assessment');
  assert.equal(escaped.reasons.length, 1, 'all escapes fold into one reason');
  assert.equal(escaped.reasons[0].code, 'path:escape');
  assert.equal(
    escaped.reasons[0].detail,
    'path escaped the candidate workspace: ../escape-0.txt, ../escape-1.txt, ../escape-2.txt, ../escape-3.txt, ../escape-4.txt',
  );

  const hits = Array.from({ length: 12 }, (unused, index) => `.github/CODEOWNERS-${index}`);
  const protectedOnly = g.assessPaths(hits);
  assert.equal(protectedOnly.decision, 'REQUIRE_OWNER');
  assert.equal(protectedOnly.protected.length, 12, 'every hit is reported on the assessment');
  assert.equal(protectedOnly.reasons.length, 10, 'at most ten hits become reasons');
  assert.deepEqual(
    protectedOnly.reasons.map((reason) => reason.detail),
    Array.from({ length: 10 }, (unused, index) => `.github/CODEOWNERS-${index} matches /.github/`),
  );
  assert.ok(protectedOnly.reasons.every((reason) => reason.code === 'path:protected:immutable-manifest'));
});

test('patterns() is the compiled surface in order, immutable manifest first', () => {
  const g = guard();
  assert.deepEqual(g.patterns(), [
    { pattern: '/.github/CODEOWNERS', source: 'immutable-manifest' },
    { pattern: '/.github/workflows/', source: 'immutable-manifest' },
    { pattern: '/.github/', source: 'immutable-manifest' },
    { pattern: '/config/', source: 'codeowners' },
    { pattern: '/src/protected/', source: 'codeowners' },
    { pattern: '/scripts/**', source: 'codeowners' },
  ]);

  // Deterministic across instances, and the immutable source always wins a tie.
  assert.deepEqual(guard().patterns(), g.patterns());
  const tie = createProtectedSurfaceGuard({
    manifest: ['/.github/workflows/'],
    extraPatterns: ['/.github/workflows/'],
    resolve: resolver(),
  });
  assert.deepEqual(tie.patterns(), [
    { pattern: '/.github/workflows/', source: 'immutable-manifest' },
    { pattern: '/.github/workflows/', source: 'codeowners' },
  ]);
  assert.deepEqual(tie.assessPaths(['.github/workflows/ci.yml']).protected, [
    { path: '.github/workflows/ci.yml', rule: '/.github/workflows/', source: 'immutable-manifest' },
  ]);

  // A guard with no CODEOWNERS at all is just the manifest, and the donor's
  // default (case-insensitive) still holds.
  const bare = createProtectedSurfaceGuard({ manifest: ['/package.json'], resolve: resolver() });
  assert.deepEqual(bare.patterns(), [{ pattern: '/package.json', source: 'immutable-manifest' }]);
  assert.equal(bare.caseInsensitive, true);
  assert.equal(bare.assessPaths(['PACKAGE.JSON']).decision, 'REQUIRE_OWNER');
  const strict = createProtectedSurfaceGuard({ manifest: ['/package.json'], caseInsensitive: false, resolve: resolver() });
  assert.equal(strict.assessPaths(['PACKAGE.JSON']).decision, 'ALLOW');

  // Containment is injected: without a resolver there is no guard at all.
  assert.throws(() => createProtectedSurfaceGuard({ manifest: [] }), TypeError);
  assert.throws(() => createProtectedSurfaceGuard(), TypeError);
});

test('one-shot assessment needs a resolver too, and the guard is deterministic', () => {
  const changes = [
    { kind: 'write', path: 'src/app.ts' },
    { kind: 'rename', from: 'config/a.json', path: 'src/a.json' },
  ];
  assert.equal(assessWorkspaceChanges({ manifest: MANIFEST, extraPatterns: CODEOWNERS, resolve: resolver() }, changes).decision, 'REQUIRE_OWNER');

  const g = guard();
  assert.deepEqual(g.assessChanges(changes), g.assessChanges(changes));
  assert.equal(g.assessChanges(changes).decision, 'REQUIRE_OWNER');
  assert.deepEqual(
    g.assessChanges(changes).reasons,
    [{ code: 'path:protected:codeowners', detail: 'config/a.json matches /config/' }],
  );
});

test('the guard carries no fs, realpath or CODEOWNERS loading of its own', async () => {
  const moduleDir = join(import.meta.dirname, '..');
  for (const file of ['contracts.mjs', 'protected-surface.mjs', 'guard.mjs', 'index.mjs']) {
    const source = await readFile(join(moduleDir, file), 'utf8');
    // Strip block comments, then whole-line `//` comments. No multi-line regex, so
    // the result cannot swallow real code.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    for (const forbidden of [
      "from 'node:fs",
      'from "node:fs',
      "from 'electron",
      'workspacePath',
      'canonicalRealPathSync',
      'process.env',
      'Date.now',
      'Math.random',
      'readFileSync',
      'existsSync',
    ]) {
      assert.ok(!code.includes(forbidden), `${file} must not carry ${forbidden}`);
    }
    // Every import specifier is relative; this module tree has no builtin imports.
    for (const specifier of [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('./'), `${file} imports ${specifier}, which is not a relative module`);
    }
  }
});
