/**
 * UTOPIA · City · Project Foreman — adapters, autonomy authority and the episode
 * state machine.
 *
 * This file carries the three parts of the mission that had no port yet:
 *
 *  * `adapters.mjs` — the adapter set `discovery.mjs` lazily loads. Every adapter's
 *    detection score and evidence string is asserted literally, and then checked a
 *    second time against the donor module itself when the frozen checkout is
 *    present, so a transcription slip cannot hide behind a hand-written literal.
 *  * `autonomy.mjs` and `episode.mjs` — the two pure donor modules, ported
 *    mechanically: their vocabularies, budgets, refusals, transitions and the
 *    injected clock seam are asserted exactly.
 *  * the end-to-end proof that the gap is closed: against a temporary Node fixture
 *    under `node:os.tmpdir()`, `discoverCommands` now produces a non-empty
 *    operations table and `buildPlan` builds all six steps of the repair template,
 *    where an adapter-less discovery still collapses to two steps.
 *
 * Fixtures are built with `node:fs` `mkdtemp` under `node:os.tmpdir()` and removed
 * afterwards; nothing here writes inside the repository tree.
 *
 * The donor is `DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b`.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import * as adapters from '../adapters.mjs';
import * as discovery from '../discovery.mjs';
import * as plan from '../plan.mjs';
import * as autonomy from '../autonomy.mjs';
import * as episode from '../episode.mjs';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Every temporary directory this file creates, removed when the file settles. */
const TEMPORARY_ROOTS = [];

/**
 * Build a throwaway project directory under the OS temporary directory.
 *
 * A value of `null` in `files` means "make this a directory"; anything else is
 * written as UTF-8 text, with parent directories created as needed.
 *
 * @param {object} files relative path → file content (or null for a directory)
 * @returns {string} the absolute root
 */
function fixture(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-adapters-'));
  TEMPORARY_ROOTS.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    if (content === null) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return root;
}

after(() => {
  for (const root of TEMPORARY_ROOTS) fs.rmSync(root, { recursive: true, force: true });
});

/** The donor checkout, reached from this file rather than from the caller's cwd. */
function repositoryRoot() {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(directory, 'city', 'test-all.mjs'))) return directory;
    directory = path.dirname(directory);
  }
  return process.cwd();
}

const DONOR_ROOT = path.join(repositoryRoot(), '.runtime', 'evidence', 'mission-book', 'MB-004', 'donor-hns', 'app', 'engineering');
const DONOR_AVAILABLE = fs.existsSync(path.join(DONOR_ROOT, 'adapters', 'index.cjs'));
const DONOR_SKIP = DONOR_AVAILABLE ? false : `donor checkout absent at ${DONOR_ROOT}`;

/** Every adapter the donor ships, by id, as instances. */
const ADAPTERS = Object.freeze({
  rust: adapters.rustAdapter(),
  go: adapters.goAdapter(),
  dotnet: adapters.dotnetAdapter(),
  java: adapters.javaAdapter(),
  cmake: adapters.cmakeAdapter(),
  python: adapters.pythonAdapter(),
  node: adapters.nodeAdapter(),
  make: adapters.makeAdapter(),
  generic: adapters.genericAdapter(),
});

/** The exact interface contract `discovery.mjs` relies on. */
const COMMAND_KEYS = Object.freeze(['command', 'cwd', 'confidence', 'evidence', 'longRunning', 'acceptsFocus']);

/**
 * One declaring directory per adapter, with the donor's exact expectation.
 *
 * The expectation is what the donor answers, quoted so a reviewer can diff it.
 */
const DECLARING_FIXTURES = [
  { id: 'rust', adapter: 'rust', files: { 'Cargo.toml': '[package]\nname = "fixture"\n' }, expect: { score: 95, evidence: 'Cargo.toml' } },
  { id: 'go', adapter: 'go', files: { 'go.mod': 'module example.com/fixture\n' }, expect: { score: 95, evidence: 'go.mod' } },
  { id: 'dotnet-csproj', adapter: 'dotnet', files: { 'Fixture.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n' }, expect: { score: 90, evidence: 'Fixture.csproj' } },
  { id: 'dotnet-sln', adapter: 'dotnet', files: { 'Fixture.sln': 'Microsoft Visual Studio Solution File\n' }, expect: { score: 90, evidence: 'Fixture.sln' } },
  { id: 'java-maven', adapter: 'java', files: { 'pom.xml': '<project />\n' }, expect: { score: 92, evidence: 'pom.xml' } },
  { id: 'java-gradle', adapter: 'java', files: { 'build.gradle': 'plugins {}\n' }, expect: { score: 92, evidence: 'build.gradle' } },
  { id: 'java-gradle-kts', adapter: 'java', files: { 'build.gradle.kts': 'plugins {}\n' }, expect: { score: 92, evidence: 'build.gradle' } },
  { id: 'cmake', adapter: 'cmake', files: { 'CMakeLists.txt': 'project(fixture)\n' }, expect: { score: 88, evidence: 'CMakeLists.txt' } },
  { id: 'python-pyproject', adapter: 'python', files: { 'pyproject.toml': '[project]\nname = "fixture"\n' }, expect: { score: 85, evidence: 'python project markers: pyproject.toml' } },
  { id: 'python-requirements', adapter: 'python', files: { 'requirements.txt': 'pytest\n' }, expect: { score: 75, evidence: 'python project markers: requirements.txt' } },
  { id: 'python-setup-py', adapter: 'python', files: { 'setup.py': 'from setuptools import setup\n' }, expect: { score: 75, evidence: 'python project markers: setup.py' } },
  { id: 'python-many-markers', adapter: 'python', files: { 'setup.py': '', 'requirements.txt': '', 'tox.ini': '' }, expect: { score: 75, evidence: 'python project markers: setup.py, requirements.txt, tox.ini' } },
  { id: 'node-source-dir', adapter: 'node', files: { 'package.json': '{"name":"fixture"}\n', 'src/index.js': 'export const x = 1\n' }, expect: { score: 90, evidence: 'package.json with a source directory' } },
  { id: 'node-index-file', adapter: 'node', files: { 'package.json': '{"name":"fixture"}\n', 'index.js': '' }, expect: { score: 90, evidence: 'package.json with a source directory' } },
  { id: 'node-manifest-only', adapter: 'node', files: { 'package.json': '{"name":"fixture"}\n' }, expect: { score: 60, evidence: 'package.json only' } },
  { id: 'make', adapter: 'make', files: { 'Makefile': 'all:\n\techo hi\n' }, expect: { score: 70, evidence: 'Makefile' } },
  { id: 'make-lowercase', adapter: 'make', files: { 'makefile': 'all:\n\techo hi\n' }, expect: { score: 70, evidence: 'Makefile' } },
].map((entry) => ({ ...entry, root: fixture(entry.files) }));

/** The empty directory every adapter must abstain on — except the fallback. */
const EMPTY_ROOT = fixture({});

// ---------------------------------------------------------------------------
// The adapter interface and the closed vocabularies
// ---------------------------------------------------------------------------

test('every shipped adapter exposes the interface discovery calls', () => {
  assert.equal(Object.keys(ADAPTERS).length, 9);
  for (const [id, adapter] of Object.entries(ADAPTERS)) {
    assert.equal(adapter.id, id, `${id} reports its own id`);
    assert.equal(typeof adapter.language, 'string');
    assert.ok(adapter.language.length > 0);
    assert.equal(typeof adapter.detect, 'function', `${id}.detect`);
    assert.equal(typeof adapter.commands, 'function', `${id}.commands`);
  }
});

test('defaultAdapters keeps the donor specificity order exactly', () => {
  const shipped = adapters.defaultAdapters();
  assert.deepEqual(shipped.map((adapter) => adapter.id), ['rust', 'go', 'dotnet', 'java', 'cmake', 'python', 'node', 'make', 'generic']);
  assert.deepEqual(shipped.map((adapter) => adapter.language), ['rust', 'go', 'csharp', 'java', 'c', 'python', 'javascript', 'generic', 'unknown']);
  // Every call builds a fresh set: a caller cannot mutate the next caller's adapters.
  assert.notEqual(adapters.defaultAdapters()[0], shipped[0]);
});

test('OPERATIONS and CONFIDENCE carry the donor values exactly, and match discovery', () => {
  assert.deepEqual([...adapters.OPERATIONS], ['install', 'build', 'test', 'focusedTest', 'lint', 'format', 'typecheck', 'package', 'run']);
  assert.deepEqual({ ...adapters.CONFIDENCE }, { DECLARED: 'declared', CONVENTION: 'convention', INFERRED: 'inferred' });
  assert.deepEqual([...discovery.OPERATIONS], [...adapters.OPERATIONS]);
  assert.deepEqual({ ...discovery.CONFIDENCE }, { ...adapters.CONFIDENCE });
});

test('every adapter abstains on an empty directory, and only the generic fallback claims it', () => {
  for (const [id, adapter] of Object.entries(ADAPTERS)) {
    if (id === 'generic') continue;
    assert.equal(adapter.detect(EMPTY_ROOT), null, `${id} must find nothing in an empty directory`);
  }
  assert.equal(ADAPTERS.generic.detect(EMPTY_ROOT).score, 1);
  assert.equal(ADAPTERS.generic.detect(EMPTY_ROOT).evidence, 'no known project manifest was found');
});

test('each adapter detects its own ecosystem with the donor score and evidence', () => {
  for (const entry of DECLARING_FIXTURES) {
    assert.deepEqual(ADAPTERS[entry.adapter].detect(entry.root), entry.expect, `${entry.adapter} on ${entry.id}`);
  }
});

test('an unreadable directory is nothing to detect, not a crash', () => {
  const missing = path.join(EMPTY_ROOT, 'no-such-directory');
  // `exists` is a stat, so it simply answers false…
  for (const [id, adapter] of Object.entries(ADAPTERS)) {
    if (id === 'generic') continue;
    assert.equal(adapter.detect(missing), null, `${id} on a missing directory`);
  }
  // …while the two adapters that list the directory answer with an empty table.
  assert.deepEqual(ADAPTERS.generic.commands(missing), {});
  assert.deepEqual(ADAPTERS.dotnet.detect(missing), null);
});

test('every discovered command has the donor shape and a known operation name', () => {
  for (const [id, adapter] of Object.entries(ADAPTERS)) {
    for (const entry of [...DECLARING_FIXTURES, { id: 'empty', root: EMPTY_ROOT }]) {
      const table = adapter.commands(entry.root);
      assert.equal(typeof table, 'object');
      for (const [operation, value] of Object.entries(table)) {
        assert.ok(adapters.OPERATIONS.includes(operation), `${id}.${operation} is a real operation`);
        assert.equal(typeof value, 'object');
        assert.deepEqual(Object.keys(value).sort(), [...COMMAND_KEYS].sort(), `${id}.${operation} shape`);
        assert.equal(typeof value.command, 'string');
        assert.equal(typeof value.confidence, 'string');
        assert.ok(Object.values(adapters.CONFIDENCE).includes(value.confidence), `${id}.${operation} confidence`);
        assert.equal(typeof value.longRunning, 'boolean');
        assert.equal(typeof value.acceptsFocus, 'boolean');
      }
    }
  }
});

test('adapters.mjs can never execute anything', () => {
  const source = fs.readFileSync(new URL('../adapters.mjs', import.meta.url), 'utf8');
  // The whole module is a reader: no process, no shell, no worker, no evaluation.
  assert.equal(/child_process/.test(source), false);
  assert.equal(/\b(spawn|spawnSync|exec|execFile|execFileSync|execSync|fork)\s*\(/.test(source), false);
  assert.equal(/node:vm|worker_threads|node:cluster/.test(source), false);
  assert.deepEqual(
    [...source.matchAll(/^import .*$/gm)].map((match) => match[0]),
    ["import fs from 'node:fs';", "import path from 'node:path';"],
    'the only imports are the filesystem and the path module',
  );
});

test('answering detection and commands leaves the project directory untouched', () => {
  const entry = DECLARING_FIXTURES.find((candidate) => candidate.id === 'node-source-dir');
  const before = fs.readdirSync(entry.root, { recursive: true }).map(String).sort();
  for (const adapter of adapters.defaultAdapters()) {
    adapter.detect(entry.root);
    adapter.commands(entry.root);
  }
  const after = fs.readdirSync(entry.root, { recursive: true }).map(String).sort();
  assert.deepEqual(after, before, 'an adapter answers, it does not act');
});

// ---------------------------------------------------------------------------
// The Node adapter: package manager and test-command precedence
// ---------------------------------------------------------------------------

/** A package.json fixture with the given scripts and extra files. */
function nodeFixture(scripts, extra = {}) {
  return fixture({ 'package.json': JSON.stringify({ name: 'fixture', scripts }, null, 2), ...extra });
}

test('the package manager is chosen from the lockfile, in the donor precedence order', () => {
  const cases = [
    { id: 'pnpm', files: { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }, manager: 'pnpm', install: 'pnpm install --frozen-lockfile', runner: 'pnpm' },
    { id: 'yarn', files: { 'yarn.lock': '# yarn\n' }, manager: 'yarn', install: 'yarn install --frozen-lockfile', runner: 'yarn' },
    { id: 'bun', files: { 'bun.lockb': 'binary\n' }, manager: 'bun', install: 'bun install', runner: 'bun' },
    { id: 'npm', files: { 'package-lock.json': '{"lockfileVersion":3}\n' }, manager: 'npm', install: 'npm ci', runner: 'npm run' },
    // The donor's fallback: a bare manifest is answered as npm, and its install
    // command is still `npm ci`, labelled "declared" with a lockfile it does not have.
    { id: 'no-lockfile', files: {}, manager: 'npm', install: 'npm ci', runner: 'npm run' },
  ];
  for (const entry of cases) {
    const root = nodeFixture({ test: 'node --test' }, entry.files);
    assert.equal(adapters.packageManagerOf(root), entry.manager, `${entry.id} package manager`);
    const table = ADAPTERS.node.commands(root);
    assert.equal(table.install.command, entry.install, `${entry.id} install`);
    assert.equal(table.install.confidence, 'declared');
    assert.equal(table.install.evidence, `lockfile for ${entry.manager}`);
    assert.equal(table.test.command, `${entry.runner} test`, `${entry.id} test runner`);
  }
  // All four lockfiles at once: the first in the donor's order wins.
  const all = nodeFixture({ test: 'node --test' }, { 'pnpm-lock.yaml': '', 'yarn.lock': '', 'bun.lockb': '', 'package-lock.json': '' });
  assert.equal(adapters.packageManagerOf(all), 'pnpm');
  // No manifest at all, and not even a lockfile: there is no manager to report.
  assert.equal(adapters.packageManagerOf(EMPTY_ROOT), null);
});

test('the test command prefers a declared script over a framework config over the convention', () => {
  // 1. The project's own script: declared, and the focused variant takes a name.
  const declared = nodeFixture({ test: 'node --test tests' }, { 'vitest.config.js': 'export default {}\n' });
  const declaredTable = ADAPTERS.node.commands(declared);
  assert.deepEqual(declaredTable.test, {
    command: 'npm run test',
    cwd: null,
    confidence: 'declared',
    evidence: 'package.json scripts.test',
    longRunning: false,
    acceptsFocus: false,
  });
  assert.deepEqual(declaredTable.focusedTest, { ...declaredTable.test, acceptsFocus: true });

  // 2. No script, but a declared Vitest configuration: convention.
  const vitest = nodeFixture({}, { 'vitest.config.ts': 'export default {}\n' });
  const vitestTable = ADAPTERS.node.commands(vitest);
  assert.equal(vitestTable.test.command, 'npx vitest run');
  assert.equal(vitestTable.test.confidence, 'convention');
  assert.equal(vitestTable.test.evidence, 'vitest.config');
  assert.equal(vitestTable.focusedTest.acceptsFocus, true);

  // 3. No script, but a declared Jest configuration: convention.
  const jest = nodeFixture({}, { 'jest.config.cjs': 'module.exports = {}\n' });
  const jestTable = ADAPTERS.node.commands(jest);
  assert.equal(jestTable.test.command, 'npx jest --ci');
  assert.equal(jestTable.test.confidence, 'convention');
  assert.equal(jestTable.test.evidence, 'jest.config');
  assert.equal(jestTable.focusedTest.acceptsFocus, true);

  // 4. Nothing declared at all: no test command, and no invented one.
  const bare = nodeFixture({}, { 'index.js': '' });
  const bareTable = ADAPTERS.node.commands(bare);
  assert.equal(bareTable.test, undefined);
  assert.equal(bareTable.focusedTest, undefined);
  // Vitest outranks Jest when both configurations are declared.
  assert.equal(ADAPTERS.node.commands(nodeFixture({}, { 'vitest.config.js': '', 'jest.config.js': '' })).test.command, 'npx vitest run');
});

test('a declared TypeScript configuration supplies a build command only when none is declared', () => {
  const inferred = nodeFixture({}, { 'tsconfig.json': '{}\n', 'index.ts': '' });
  const table = ADAPTERS.node.commands(inferred);
  assert.equal(table.build.command, 'npx tsc -p tsconfig.json --noEmit');
  assert.equal(table.build.confidence, 'convention');
  assert.equal(table.build.evidence, 'tsconfig.json');

  const declared = nodeFixture({ build: 'tsc -b' }, { 'tsconfig.json': '{}\n' });
  const declaredTable = ADAPTERS.node.commands(declared);
  assert.equal(declaredTable.build.command, 'npm run build');
  assert.equal(declaredTable.build.confidence, 'declared');
  assert.equal(declaredTable.build.evidence, 'package.json scripts.build');
});

test('every declared Node script is carried over with its own evidence string', () => {
  const root = nodeFixture({ build: 'tsc', test: 'node --test', lint: 'eslint .', format: 'prettier -w .', typecheck: 'tsc --noEmit', dev: 'node src/dev.js', start: 'node src/index.js' });
  const table = ADAPTERS.node.commands(root);
  assert.deepEqual(
    Object.fromEntries(['build', 'test', 'lint', 'format', 'typecheck'].map((operation) => [operation, [table[operation].command, table[operation].evidence]])),
    {
      build: ['npm run build', 'package.json scripts.build'],
      test: ['npm run test', 'package.json scripts.test'],
      lint: ['npm run lint', 'package.json scripts.lint'],
      format: ['npm run format', 'package.json scripts.format'],
      typecheck: ['npm run typecheck', 'package.json scripts.typecheck'],
    },
  );
  // `run` is long running, and `dev` outranks `start`.
  assert.deepEqual([table.run.command, table.run.evidence, table.run.longRunning], ['npm run dev', 'package.json scripts.dev', true]);
  assert.deepEqual(ADAPTERS.node.commands(nodeFixture({ start: 'node server.js' })).run, {
    command: 'npm run start',
    cwd: null,
    confidence: 'declared',
    evidence: 'package.json scripts.start',
    longRunning: true,
    acceptsFocus: false,
  });
  // A blank script is not a declared script.
  assert.equal(ADAPTERS.node.commands(nodeFixture({ test: '   ' })).test, undefined);
});

test('the generic fallback claims nothing it cannot see and labels every guess inferred', () => {
  // Its detection is constant: the fallback cannot find a manifest it does not know.
  assert.deepEqual(ADAPTERS.generic.detect(fixture({ 'Makefile': 'all:\n' })), { score: 1, evidence: 'no known project manifest was found' });

  const makeOnly = fixture({ 'Makefile': 'all:\n' });
  assert.deepEqual(ADAPTERS.generic.commands(makeOnly).build, {
    command: 'make',
    cwd: null,
    confidence: 'inferred',
    evidence: 'a Makefile exists',
    longRunning: false,
    acceptsFocus: false,
  });
  const scripted = fixture({ 'build.sh': '#!/bin/sh\n', 'test.sh': '#!/bin/sh\n' });
  const inferred = ADAPTERS.generic.commands(scripted);
  assert.deepEqual([inferred.build.command, inferred.build.evidence, inferred.build.confidence], [process.platform === 'win32' ? 'bash build.sh' : './build.sh', 'build.sh exists', 'inferred']);
  assert.deepEqual([inferred.test.command, inferred.test.evidence, inferred.test.confidence], [process.platform === 'win32' ? 'bash test.sh' : './test.sh', 'test.sh exists', 'inferred']);
  // A scripts/test* file with no manifest is still a guess, and it says so.
  const scriptsDirectory = fixture({ 'scripts': null, 'scripts/test-all.sh': '' });
  assert.deepEqual(ADAPTERS.generic.commands(scriptsDirectory).test, {
    command: 'npm test',
    cwd: null,
    confidence: 'inferred',
    evidence: 'a scripts/test* file exists but no manifest declares it',
    longRunning: false,
    acceptsFocus: false,
  });
  // A declared test.sh outranks the scripts/ guess, as the donor orders them.
  const both = fixture({ 'test.sh': '', 'scripts': null, 'scripts/test-all.sh': '' });
  assert.equal(ADAPTERS.generic.commands(both).test.evidence, 'test.sh exists');
});

test('every non-Node command template is the donor string, label and evidence', () => {
  // [operation, command, confidence, evidence, acceptsFocus]
  const mavenWrapper = process.platform === 'win32' ? 'mvnw.bat' : './mvnw';
  const cases = [
    { adapter: 'rust', root: fixture({ 'Cargo.toml': '' }), table: {
      install: ['cargo fetch', 'convention', 'cargo', false],
      build: ['cargo build --all-targets', 'convention', 'cargo', false],
      test: ['cargo test', 'declared', 'cargo test', false],
      focusedTest: ['cargo test', 'declared', 'cargo test', true],
      lint: ['cargo clippy --all-targets -- -D warnings', 'convention', 'clippy', false],
      format: ['cargo fmt --check', 'convention', 'rustfmt', false],
      package: ['cargo package --allow-dirty', 'convention', 'cargo', false],
    } },
    { adapter: 'go', root: fixture({ 'go.mod': '' }), table: {
      install: ['go mod download', 'convention', 'go modules', false],
      build: ['go build ./...', 'declared', 'go build', false],
      test: ['go test ./...', 'declared', 'go test', false],
      focusedTest: ['go test', 'declared', 'go test', true],
      lint: ['go vet ./...', 'convention', 'go vet', false],
      format: ['gofmt -l .', 'convention', 'gofmt', false],
    } },
    { adapter: 'cmake', root: fixture({ 'CMakeLists.txt': '' }), table: {
      build: ['cmake --build build', 'convention', 'CMakeLists.txt', false],
      test: ['ctest --test-dir build --output-on-failure', 'convention', 'CMakeLists.txt', false],
      focusedTest: ['ctest --test-dir build -R', 'convention', 'CMakeLists.txt', true],
    } },
    { adapter: 'dotnet', root: fixture({ 'App.csproj': '' }), table: {
      install: ['dotnet restore', 'convention', 'dotnet', false],
      build: ['dotnet build --nologo', 'convention', 'dotnet', false],
      test: ['dotnet test --nologo', 'convention', 'dotnet', false],
      focusedTest: ['dotnet test --nologo --filter', 'convention', 'dotnet', true],
      package: ['dotnet pack --nologo', 'convention', 'dotnet', false],
    } },
    { adapter: 'java', root: fixture({ 'pom.xml': '' }), table: {
      build: ['mvn -B -DskipTests package', 'convention', 'pom.xml', false],
      test: ['mvn -B test', 'convention', 'pom.xml', false],
      focusedTest: ['mvn -B test', 'convention', 'pom.xml', true],
      package: ['mvn -B package', 'convention', 'pom.xml', false],
    } },
    { adapter: 'java', root: fixture({ 'build.gradle': '' }), table: {
      build: ['gradle build -x test', 'convention', 'build.gradle', false],
      test: ['gradle test', 'convention', 'build.gradle', false],
      focusedTest: ['gradle test', 'convention', 'build.gradle', true],
      package: ['gradle assemble', 'convention', 'build.gradle', false],
    } },
    // A wrapper script is used where the project ships one.
    { adapter: 'java', root: fixture({ 'pom.xml': '', 'mvnw': '' }), table: {
      build: [`${mavenWrapper} -B -DskipTests package`, 'convention', 'pom.xml', false],
      test: [`${mavenWrapper} -B test`, 'convention', 'pom.xml', false],
      focusedTest: [`${mavenWrapper} -B test`, 'convention', 'pom.xml', true],
      package: [`${mavenWrapper} -B package`, 'convention', 'pom.xml', false],
    } },
    { adapter: 'python', root: fixture({ 'pytest.ini': '[pytest]\n', 'requirements.txt': 'pytest\n' }), table: {
      install: ['python -m pip install -r requirements.txt', 'declared', 'requirements.txt', false],
      test: ['python -m pytest', 'declared', 'pytest.ini', false],
      focusedTest: ['python -m pytest', 'declared', 'pytest.ini', true],
    } },
    { adapter: 'python', root: fixture({ 'tests': null }), table: {
      test: ['python -m pytest', 'convention', 'a tests directory or pytest configuration', false],
      focusedTest: ['python -m pytest', 'convention', 'a tests directory or pytest configuration', true],
    } },
    { adapter: 'python', root: fixture({ 'uv.lock': '', 'poetry.lock': '', 'pyproject.toml': '[tool.poetry]\n[tool.ruff]\n[tool.mypy]\n' }), table: {
      install: ['uv sync', 'declared', 'uv.lock', false],
      lint: ['python -m ruff check .', 'declared', 'ruff configuration', false],
      format: ['python -m ruff format --check .', 'declared', 'ruff configuration', false],
      typecheck: ['python -m mypy .', 'declared', 'mypy configuration', false],
    } },
    { adapter: 'python', root: fixture({ 'poetry.lock': '' }), table: { install: ['poetry install', 'declared', 'poetry', false] } },
    { adapter: 'python', root: fixture({ 'Pipfile': '' }), table: { install: ['pipenv install --dev', 'declared', 'Pipfile', false] } },
    { adapter: 'python', root: fixture({ 'setup.cfg': '[flake8]\n' }), table: { lint: ['python -m flake8', 'declared', 'flake8 configuration', false] } },
    { adapter: 'make', root: fixture({ 'Makefile': 'all:\n\techo all\ntest:\n\techo test\ncheck:\n\techo check\nlint:\n\techo lint\nfmt:\n\techo fmt\ninstall:\n\techo install\n' }), table: {
      build: ['make all', 'declared', 'Makefile target all', false],
      test: ['make test', 'declared', 'Makefile target test', false],
      lint: ['make lint', 'declared', 'Makefile target lint', false],
      format: ['make fmt', 'declared', 'Makefile target fmt', false],
      install: ['make install', 'declared', 'Makefile target install', false],
    } },
    // `check` is the fallback test target when there is no `test` target.
    { adapter: 'make', root: fixture({ 'makefile': 'check:\n\techo check\n' }), table: {
      test: ['make check', 'declared', 'Makefile target check', false],
    } },
  ];
  for (const entry of cases) {
    const table = ADAPTERS[entry.adapter].commands(entry.root);
    assert.deepEqual(Object.keys(table), Object.keys(entry.table), `${entry.adapter} operations`);
    for (const [operation, [command, confidence, evidence, acceptsFocus]] of Object.entries(entry.table)) {
      const value = table[operation];
      assert.deepEqual([value.command, value.confidence, value.evidence, value.acceptsFocus, value.longRunning, value.cwd], [command, confidence, evidence, acceptsFocus, false, null], `${entry.adapter}.${operation}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Specificity: a manifest the adapter cannot see outranks one it can
// ---------------------------------------------------------------------------

test('a repository with Cargo.toml and package.json is a Rust project, not Node', () => {
  const root = fixture({ 'Cargo.toml': '[package]\nname = "fixture"\n', 'package.json': '{"name":"helper"}\n', 'src/lib.rs': '' });
  const detected = discovery.detectProject(root);
  assert.equal(detected.id, 'rust');
  assert.equal(detected.language, 'rust');
  assert.equal(detected.evidence, 'Cargo.toml');
  assert.equal(detected.adapter.id, 'rust');
  // The runner-up is context, not a fallback — and Node here is at its *highest*
  // score (a manifest beside a source directory) and still loses to Rust. The
  // generic fallback is always present, at score 1.
  assert.deepEqual(detected.others, [
    { id: 'node', score: 90, evidence: 'package.json with a source directory' },
    { id: 'generic', score: 1, evidence: 'no known project manifest was found' },
  ]);
  assert.equal(discovery.discoverCommands({ root }).operations.test.command, 'cargo test');

  // Two adapters that score identically are separated by the shipped order.
  const goAndRust = fixture({ 'Cargo.toml': '', 'go.mod': '' });
  assert.equal(discovery.detectProject(goAndRust).id, 'rust', 'rust is declared before go');
});

// ---------------------------------------------------------------------------
// The episode state machine
// ---------------------------------------------------------------------------

test('the episode phase vocabulary, terminal set, work phases and parkable phases are the donor lists', () => {
  assert.deepEqual(Object.values(episode.EPISODE_PHASES), [
    'INITIALIZING', 'DISCOVERING', 'PLANNING', 'EDITING', 'BUILDING', 'TESTING', 'INSPECTING_FAILURE',
    'REPAIRING', 'VERIFYING', 'RECOVERING', 'WAITING_PROCESS', 'WAITING_RETRY', 'STALLED',
    'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED',
  ]);
  assert.deepEqual([...episode.TERMINAL_PHASES], ['COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED']);
  assert.deepEqual([...episode.WORK_PHASES], ['DISCOVERING', 'PLANNING', 'EDITING', 'BUILDING', 'TESTING', 'INSPECTING_FAILURE', 'REPAIRING', 'VERIFYING']);
  assert.deepEqual([...episode.PARKABLE_PHASES], ['WAITING_PROCESS', 'WAITING_RETRY']);
  assert.deepEqual(Object.keys(episode.EPISODE_TRANSITIONS), Object.values(episode.EPISODE_PHASES));
  assert.equal(episode.isTerminalPhase('COMPLETED'), true);
  assert.equal(episode.isTerminalPhase('EDITING'), false);
  assert.equal(episode.isParkablePhase('WAITING_RETRY'), true);
  assert.equal(episode.isParkablePhase('WAITING_PROCESS'), true);
  assert.equal(episode.isParkablePhase('STALLED'), false, 'STALLED is a decision point, not a park');
});

test('every legal transition is allowed and every other move is refused with the donor reason', () => {
  const phases = Object.values(episode.EPISODE_PHASES);
  const legalMoves = Object.values(episode.EPISODE_TRANSITIONS).reduce((total, moves) => total + moves.length, 0);
  assert.equal(legalMoves, 111, 'the donor transition table has 111 legal moves');
  let allowed = 0;
  let refused = 0;
  for (const from of phases) {
    for (const to of phases) {
      const machine = episode.createEpisodeStateMachine({ initial: from, now: () => 42 });
      const result = machine.transition(to);
      const isLegal = episode.EPISODE_TRANSITIONS[from].includes(to);
      const isTerminal = episode.TERMINAL_PHASES.includes(from);
      if (isTerminal && from !== to) {
        assert.equal(result.ok, false, `${from} -> ${to}`);
        assert.equal(result.reason, `the episode already ended in ${from}`);
        assert.equal(result.phase, from, 'a refused move leaves the phase alone');
        assert.equal(machine.phase, from);
        refused += 1;
        continue;
      }
      if (!isLegal) {
        assert.equal(result.ok, false, `${from} -> ${to} must be refused`);
        assert.equal(result.reason, `${from} cannot move to ${to}`);
        assert.deepEqual(result.allowed, episode.EPISODE_TRANSITIONS[from]);
        assert.equal(machine.phase, from);
        refused += 1;
        continue;
      }
      assert.equal(result.ok, true, `${from} -> ${to} must be allowed`);
      assert.equal(result.phase, to);
      assert.equal(result.previous, from);
      assert.deepEqual(result.entry, { at: 42, from, to }, 'the donor clock seam supplies the timestamp');
      assert.equal(machine.phase, to);
      assert.equal(machine.history().length, 1);
      allowed += 1;
    }
  }
  assert.equal(allowed, 111);
  assert.equal(refused, phases.length * phases.length - 111, 'every other pair is refused, not corrected');
});

test('an unknown phase is refused by name, at construction and at the move', () => {
  assert.throws(() => episode.createEpisodeStateMachine({ initial: 'NOPE' }), /unknown initial phase: NOPE/);
  const machine = episode.createEpisodeStateMachine();
  assert.deepEqual(machine.transition('NOPE'), { ok: false, reason: 'unknown phase: NOPE', phase: 'INITIALIZING' });
  assert.deepEqual(machine.force('NOPE'), { ok: false, reason: 'unknown phase: NOPE', phase: 'INITIALIZING' });
  assert.equal(machine.phase, 'INITIALIZING');
});

test('a terminal episode can force a teardown but cannot walk on', () => {
  const machine = episode.createEpisodeStateMachine({ initial: 'PLANNING' });
  assert.equal(machine.transition('COMPLETED').ok, true);
  assert.equal(machine.terminal, true);
  assert.equal(machine.parkable, false);
  const blocked = machine.transition('EDITING');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'the episode already ended in COMPLETED');
  // A terminal phase cannot even move to itself: there is no work left to do.
  const again = machine.transition('COMPLETED');
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'COMPLETED cannot move to COMPLETED');
  // Teardown is the one move legality does not gate, and it is recorded as forced.
  const forced = machine.force('CANCELLED', 'the caller stopped it');
  assert.equal(forced.ok, true);
  assert.equal(forced.previous, 'COMPLETED');
  assert.equal(forced.entry.forced, true);
  assert.equal(forced.entry.reason, 'the caller stopped it');
  assert.equal(machine.phase, 'CANCELLED');
  assert.equal(machine.force('FAILED').entry.reason, 'teardown', 'the reason defaults to teardown');
});

test('the machine reports its phase, its allowed moves and a bounded history', () => {
  const machine = episode.createEpisodeStateMachine({ initial: 'EDITING', ringSize: 2, now: () => 7 });
  assert.equal(machine.parkable, false);
  assert.deepEqual(machine.allowedFrom(), ['BUILDING', 'TESTING', 'VERIFYING', 'EDITING', 'INSPECTING_FAILURE', 'RECOVERING', 'WAITING_PROCESS', 'FAILED', 'BLOCKED', 'CANCELLED']);
  assert.equal(machine.canTransition('BUILDING'), true);
  assert.equal(machine.canTransition('INITIALIZING'), false);
  // The returned list is a copy: a caller cannot edit the donor table.
  machine.allowedFrom().push('INITIALIZING');
  assert.equal(machine.allowedFrom().includes('INITIALIZING'), false);
  assert.equal(machine.transition('WAITING_PROCESS').ok, true);
  assert.equal(machine.parkable, true, 'an owned process may be parked in WAITING_PROCESS');
  assert.equal(machine.transition('TESTING').ok, true);
  assert.equal(machine.transition('VERIFYING').ok, true);
  assert.equal(machine.history().length, 2, 'ringSize bounds the history');
  assert.deepEqual(machine.history().map((entry) => [entry.at, entry.from, entry.to]), [[7, 'WAITING_PROCESS', 'TESTING'], [7, 'TESTING', 'VERIFYING']]);
  machine.history().push({ at: 0 });
  assert.equal(machine.history().length, 2, 'history() hands out a copy');
});

// ---------------------------------------------------------------------------
// Autonomy authority
// ---------------------------------------------------------------------------

test('the autonomy vocabulary and its budgets are the donor values', () => {
  assert.deepEqual({ ...autonomy.AUTONOMY_SOURCES }, { RUNTIME: 'runtime', CONTRACT: 'contract', RUN_OPTION: 'run-option', OPTION: 'option' });
  assert.deepEqual([...autonomy.FINAL_REASONS], ['BLOCKED', 'CANCELLED', 'REFUSED', 'completion is refused', 'no further repair is available']);
  assert.deepEqual({ ...autonomy.DEFAULT_AUTONOMY_LIMITS }, { maxContinuationRounds: 8, maxTotalSteps: 400 });
});

test('a boolean may arrive as a spelling, and anything unstated stays unstated', () => {
  for (const value of ['true', 'TRUE', ' true ', '1', 'yes']) assert.equal(autonomy.booleanOrNull(value), true, value);
  for (const value of ['false', 'FALSE', ' 0 ', 'no']) assert.equal(autonomy.booleanOrNull(value), false, value);
  for (const value of ['maybe', '', 'on', 'off', undefined, null]) assert.equal(autonomy.booleanOrNull(value), null, String(value));
  assert.equal(autonomy.booleanOrNull(true), true);
  assert.equal(autonomy.booleanOrNull(false), false);
  assert.equal(autonomy.booleanOrNull(1), true);
  assert.equal(autonomy.booleanOrNull(0), false);
});

test('autonomy resolves runtime default < contract override < explicit run option', () => {
  const cases = [
    { runtime: {}, contract: {}, runOptions: {}, enabled: false, source: 'runtime', reason: 'no source stated autonomy, so it stays off' },
    { runtime: { autonomyEnabled: true }, contract: {}, runOptions: {}, enabled: true, source: 'runtime', reason: 'the deployment default enabled autonomy' },
    { runtime: { autonomyEnabled: false }, contract: {}, runOptions: {}, enabled: false, source: 'runtime', reason: 'the deployment default disabled autonomy' },
    { runtime: { autonomyEnabled: false }, contract: { autonomyEnabled: true }, runOptions: {}, enabled: true, source: 'contract', reason: 'the contract enabled autonomy' },
    { runtime: { autonomyEnabled: true }, contract: { autonomyEnabled: false }, runOptions: {}, enabled: false, source: 'contract', reason: 'the contract disabled autonomy' },
    { runtime: {}, contract: { autonomy_enabled: true }, runOptions: {}, enabled: true, source: 'contract', reason: 'the contract enabled autonomy' },
    { runtime: { autonomyEnabled: false }, contract: { autonomyEnabled: true }, runOptions: { autonomous: false }, enabled: false, source: 'run-option', reason: 'the run option disabled autonomy for this run' },
    { runtime: { autonomyEnabled: true }, contract: { autonomyEnabled: false }, runOptions: { autonomous: true }, enabled: true, source: 'run-option', reason: 'the run option enabled autonomy for this run' },
    { runtime: {}, contract: {}, runOptions: { autonomyEnabled: true }, enabled: true, source: 'run-option', reason: 'the run option enabled autonomy for this run' },
    // The deployment's own spelling, and an unrecognised spelling that is simply unstated.
    { runtime: { enabled: 'yes' }, contract: { autonomyEnabled: 'maybe' }, runOptions: {}, enabled: true, source: 'runtime', reason: 'the deployment default enabled autonomy' },
  ];
  for (const entry of cases) {
    const resolved = autonomy.resolveAutonomy(entry);
    assert.equal(resolved.enabled, entry.enabled, JSON.stringify(entry));
    assert.equal(resolved.source, entry.source, JSON.stringify(entry));
    assert.equal(resolved.reason, entry.reason, JSON.stringify(entry));
    assert.deepEqual(Object.keys(resolved.requested), ['runtime', 'contract', 'runOption']);
  }
  assert.deepEqual(autonomy.resolveAutonomy().requested, { runtime: null, contract: null, runOption: null });
  assert.deepEqual(autonomy.resolveAutonomy({ runtime: { autonomyEnabled: true }, contract: { autonomy_enabled: false } }).requested, { runtime: true, contract: false, runOption: null });
});

test('a disabled controller never continues, whatever the evidence says', () => {
  const controller = autonomy.createEngineeringAutonomy({ enabled: false });
  assert.equal(controller.enabled, false);
  assert.equal(controller.source, 'runtime');
  assert.deepEqual({ ...controller.limits }, { maxContinuationRounds: 8, maxTotalSteps: 400 });
  const decision = controller.decide({ result: 'FAILED', mutations: { applied: 3 }, filesChanged: ['a.js'] }, { round: 0, totalSteps: 1 });
  assert.equal(decision.continue, false);
  assert.equal(decision.reason, 'autonomy is disabled for this run');
  assert.equal(decision.result, 'FAILED');
});

test('completion, cancellation and a block are terminal for autonomy', () => {
  const controller = autonomy.createEngineeringAutonomy({ enabled: true });
  const progressed = { result: 'FAILED', mutations: { applied: 1 }, filesChanged: ['a.js'] };
  assert.equal(controller.decide({ ...progressed, result: 'COMPLETED' }, { round: 0, totalSteps: 1 }).reason, 'the episode completed with verified evidence');
  assert.equal(controller.decide({ ...progressed, result: 'CANCELLED' }, { round: 0, totalSteps: 1 }).reason, 'the caller cancelled the episode');
  assert.equal(controller.decide({ ...progressed, result: 'BLOCKED' }, { round: 0, totalSteps: 1 }).reason, 'the episode is blocked on an external condition');
  for (const result of ['COMPLETED', 'CANCELLED', 'BLOCKED']) {
    assert.equal(controller.decide({ ...progressed, result }, { round: 0, totalSteps: 1 }).continue, false);
  }
});

test('the continuation budget is consumed and exhausted with the donor numbers', () => {
  const controller = autonomy.createEngineeringAutonomy({ enabled: true, limits: { maxContinuationRounds: 2, maxTotalSteps: 100 } });
  const report = { result: 'FAILED', mutations: { applied: 1 }, filesChanged: ['src/a.js'] };
  const first = controller.decide(report, { round: 0, totalSteps: 3 });
  assert.equal(first.continue, true);
  assert.equal(first.reason, 'continuing with the remaining plan (round 1/2)');
  assert.deepEqual(first.resume, { filesChanged: ['src/a.js'], passedLevels: [] });
  assert.equal(controller.decide(report, { round: 1, totalSteps: 6 }).reason, 'continuing with the remaining plan (round 2/2)');
  const spent = controller.decide(report, { round: 2, totalSteps: 9 });
  assert.equal(spent.continue, false);
  assert.equal(spent.reason, 'the continuation budget is spent (2/2 rounds)');
  // A missing or non-integer round is round 0, which still has budget.
  assert.equal(controller.decide(report).round, 0);
  assert.equal(controller.decide(report).continue, true);

  // The shipped default is 8 rounds.
  const shipped = autonomy.createEngineeringAutonomy({ enabled: true });
  const rounds = [];
  for (let round = 0; round < 9; round += 1) rounds.push(shipped.decide(report, { round, totalSteps: 1 }));
  assert.deepEqual(rounds.map((entry) => entry.continue), [true, true, true, true, true, true, true, true, false]);
  assert.equal(rounds[7].reason, 'continuing with the remaining plan (round 8/8)');
  assert.equal(rounds[8].reason, 'the continuation budget is spent (8/8 rounds)');
});

test('the step budget is consumed and exhausted with the donor numbers', () => {
  const controller = autonomy.createEngineeringAutonomy({ enabled: true, limits: { maxContinuationRounds: 8, maxTotalSteps: 400 } });
  const report = { result: 'FAILED', mutations: { applied: 1 }, filesChanged: ['src/a.js'] };
  assert.equal(controller.decide(report, { round: 0, totalSteps: 399 }).continue, true);
  const spent = controller.decide(report, { round: 0, totalSteps: 400 });
  assert.equal(spent.continue, false);
  assert.equal(spent.reason, 'the step budget is spent (400/400 steps)');
  // The continuation budget is checked first, so a round over both is reported as rounds.
  const overBoth = autonomy.createEngineeringAutonomy({ enabled: true, limits: { maxContinuationRounds: 0, maxTotalSteps: 0 } });
  assert.equal(overBoth.decide(report, { round: 0, totalSteps: 0 }).reason, 'the continuation budget is spent (0/0 rounds)');
  // A missing totalSteps is 0, which is below the budget.
  assert.equal(controller.decide(report).totalSteps, 0);
});

test('a round that changed nothing is not continued, and says exactly why', () => {
  const controller = autonomy.createEngineeringAutonomy({ enabled: true });
  const nothing = controller.decide({ result: 'FAILED', mutations: { applied: 0 }, filesChanged: [], verification: { levels: { 'full-verify': { ok: false } } } }, { round: 0, totalSteps: 4 });
  assert.equal(nothing.continue, false);
  assert.equal(nothing.reason, 'the last round produced no new evidence: no mutation and no passing verification');
  assert.equal(nothing.resume, undefined);
});

test('progress is a mutation, a changed file or a passed verification level', () => {
  const controller = autonomy.createEngineeringAutonomy({ enabled: true, now: () => 777 });
  const mutated = controller.decide({ result: 'FAILED', mutations: { applied: 2 }, filesChanged: [] }, { round: 0, totalSteps: 1 });
  assert.equal(mutated.continue, true);
  assert.equal(mutated.at, 777, 'the injected clock supplies the timestamp');
  assert.deepEqual(mutated.resume, { filesChanged: [], passedLevels: [] });

  const changed = controller.decide({ result: 'FAILED', filesChanged: ['src/a.js'] }, { round: 1, totalSteps: 2 });
  assert.equal(changed.continue, true);
  assert.deepEqual(changed.resume.filesChanged, ['src/a.js']);

  const verified = controller.decide({ result: 'FAILED', verification: { levels: { 'focused-test': { ok: true }, 'full-verify': { ok: false }, 'affected-test': { ok: true } } } }, { round: 2, totalSteps: 3 });
  assert.equal(verified.continue, true);
  assert.deepEqual(verified.resume.passedLevels, ['focused-test', 'affected-test'], 'only the passing levels are resumed');

  // The resumed file list is bounded at fifty, so a huge episode cannot carry one.
  const many = controller.decide({ result: 'FAILED', filesChanged: Array.from({ length: 60 }, (_, index) => `src/f${index}.js`) }, { round: 3, totalSteps: 4 });
  assert.equal(many.resume.filesChanged.length, 50);

  // A non-finite mutation count is no mutation at all.
  assert.equal(controller.decide({ result: 'FAILED', mutations: { applied: 'lots' } }, { round: 4, totalSteps: 5 }).continue, false);
});

test('the controller keeps a bounded decision trail and reports its own state', () => {
  const controller = autonomy.createEngineeringAutonomy({ enabled: true, source: 'contract', now: () => 5 });
  const report = { result: 'FAILED', mutations: { applied: 1 } };
  for (let index = 0; index < 105; index += 1) controller.decide(report, { round: 0, totalSteps: index });
  assert.equal(controller.decisions().length, 100, 'the ring keeps the last hundred decisions');
  assert.equal(controller.state().decisions.length, 5, 'the state summary keeps the last five');
  assert.equal(controller.source, 'contract');
  assert.deepEqual(Object.keys(controller.state()), ['enabled', 'source', 'limits', 'decisions']);
  assert.deepEqual(controller.decisions()[0], {
    at: 5,
    round: 0,
    totalSteps: 5,
    result: 'FAILED',
    source: 'contract',
    continue: true,
    reason: 'continuing with the remaining plan (round 1/8)',
    resume: { filesChanged: [], passedLevels: [] },
  });
  // Limits are merged, not replaced: a partial override keeps the other default.
  const partial = autonomy.createEngineeringAutonomy({ enabled: true, limits: { maxTotalSteps: 10 } });
  assert.deepEqual({ ...partial.limits }, { maxContinuationRounds: 8, maxTotalSteps: 10 });
});

test('the donor never consults FINAL_REASONS, and the port keeps that behaviour', () => {
  // The donor exports the list but nothing in `app/engineering` reads it: `decide`
  // stops on the three result strings above, and a report whose result is one of
  // the textual stop reasons is judged on its progress alone. This is asserted
  // rather than "fixed", because MIGRATION_ONLY may not invent a rule.
  const controller = autonomy.createEngineeringAutonomy({ enabled: true });
  const progressed = { result: 'REFUSED', mutations: { applied: 1 } };
  assert.equal(controller.decide(progressed, { round: 0, totalSteps: 1 }).continue, true);
  const nothing = { result: 'completion is refused' };
  assert.equal(controller.decide(nothing, { round: 0, totalSteps: 0 }).reason, 'the last round produced no new evidence: no mutation and no passing verification');
});

// ---------------------------------------------------------------------------
// End to end: the operations table and the repair plan are no longer empty
// ---------------------------------------------------------------------------

/** A Node repository that declares everything the repair template asks for. */
const NODE_PROJECT_FILES = {
  'package.json': JSON.stringify({
    name: 'foreman-e2e-fixture',
    version: '1.0.0',
    scripts: { test: 'node --test tests', build: 'node build.js', lint: 'eslint .' },
  }, null, 2),
  'package-lock.json': '{"lockfileVersion":3}\n',
  'src/index.js': 'export const add = (a, b) => a - b;\n',
  'tests/index.test.js': "import test from 'node:test';\n",
};

test('discovery finds commands for a real Node project through the lazily loaded adapter set', () => {
  const root = fixture(NODE_PROJECT_FILES);

  // The loader in discovery.mjs reaches adapters.mjs through require(esm).
  assert.equal(typeof require('../adapters.mjs').defaultAdapters, 'function');
  assert.equal(require('../adapters.mjs').defaultAdapters().length, 9);

  const detected = discovery.detectProject(root);
  assert.equal(detected.id, 'node');
  assert.equal(detected.language, 'javascript');
  assert.equal(detected.evidence, 'package.json with a source directory');
  assert.equal(detected.adapter.id, 'node');
  assert.deepEqual(detected.others, [{ id: 'generic', score: 1, evidence: 'no known project manifest was found' }]);

  const discovered = discovery.discoverCommands({ root });
  assert.equal(discovered.adapterId, 'node');
  assert.deepEqual(Object.keys(discovered.operations), ['install', 'build', 'test', 'focusedTest', 'lint']);
  assert.equal(discovered.operations.install.command, 'npm ci');
  assert.equal(discovered.operations.build.command, 'npm run build');
  assert.equal(discovered.operations.test.command, 'npm run test');
  assert.equal(discovered.operations.focusedTest.command, 'npm run test');
  assert.equal(discovered.operations.focusedTest.acceptsFocus, true);
  assert.equal(discovered.operations.test.acceptsFocus, false);
  assert.equal(discovered.operations.lint.command, 'npm run lint');
  assert.deepEqual(discovered.sources, { install: 'declared', build: 'declared', test: 'declared', focusedTest: 'declared', lint: 'declared' });
  assert.deepEqual(discovered.operations.test.evidence, 'package.json scripts.test');
  assert.deepEqual(discovered.project, { id: 'node', language: 'javascript', evidence: 'package.json with a source directory', others: [{ id: 'generic', score: 1, evidence: 'no known project manifest was found' }] });
});

test('the fix template builds all six steps from the discovered command table', () => {
  const root = fixture(NODE_PROJECT_FILES);
  const discovered = discovery.discoverCommands({ root });
  const built = plan.buildPlan({
    goal: 'fix the failing unit test in src/index.js',
    discovery: { root, project: discovered.project, commands: discovered.operations },
  });

  assert.equal(built.intent, 'fix');
  assert.equal(built.steps.length, 6, 'reproduce -> inspect -> patch -> focused-test -> affected-test -> full-verify');
  assert.deepEqual(built.steps.map((step) => step.kind), ['reproduce', 'inspect', 'patch', 'focused-test', 'affected-test', 'full-verify']);
  assert.deepEqual(built.reasons, [], 'no step was dropped and nothing needed explaining');
  assert.deepEqual(built.progress(), { steps: 6, settled: 0, cursor: 0, current: 'template:reproduce:1', remaining: 6, optionalFailures: 0, budget: { maxSteps: 40 }, reasons: [], complete: false, settledRecords: 0 });

  const byKind = Object.fromEntries(built.steps.map((step) => [step.kind, step]));
  // The reproduce step runs the focused command, and it is the one step whose
  // success is a failure. A discovered command is carried whole — the port does
  // exactly what the donor does, verified against the donor module below: the
  // command string is verbatim and `args` is empty because discovery's command
  // object has no separate argv.
  assert.deepEqual([byKind.reproduce.command, byKind.reproduce.args, byKind.reproduce.operation], ['npm run test', [], 'focusedTest']);
  // The donor's `validateExpects` keeps only evaluable conditions, so the
  // descriptive `description` on KIND_EXPECTS stays in the vocabulary and does not
  // reach the step; the donor module produces exactly this object.
  assert.deepEqual(byKind.reproduce.expects, { failurePresent: true });
  assert.equal(byKind.reproduce.confidence, 'declared');
  assert.equal(byKind.reproduce.commandEvidence, 'package.json scripts.test');
  assert.deepEqual(byKind.reproduce.evidence, ['failing-test-output', 'exit-code']);
  // The two steps that need no command carry none.
  for (const kind of ['inspect', 'patch']) {
    assert.equal(byKind[kind].command, null);
    assert.equal(byKind[kind].operation, null);
    assert.deepEqual(byKind[kind].args, []);
    assert.deepEqual(byKind[kind].expects, { exitCode: 0 });
  }
  // The focused step is the same command; the affected and full steps use the
  // broad `test` operation, in the donor's candidate order.
  assert.deepEqual([byKind['focused-test'].operation, byKind['focused-test'].command], ['focusedTest', 'npm run test']);
  assert.deepEqual([byKind['affected-test'].operation, byKind['affected-test'].command], ['test', 'npm run test']);
  assert.deepEqual([byKind['full-verify'].operation, byKind['full-verify'].command], ['test', 'npm run test']);
  assert.deepEqual(byKind['full-verify'].expects, { exitCode: 0, testCount: { failed: 0 } });
  assert.deepEqual(byKind['full-verify'].evidence, ['test-summary', 'exit-code', 'duration', 'command']);
  assert.deepEqual(built.steps.map((step) => step.id), ['template:reproduce:1', 'template:inspect:2', 'template:patch:3', 'template:focused-test:4', 'template:affected-test:5', 'template:full-verify:6']);
});

test('without an adapter set the same repository still produces the empty table the gap described', () => {
  const root = fixture(NODE_PROJECT_FILES);
  // This is the shape discovery degraded to before adapters.mjs existed: the
  // adapter is absent, so `project.adapter.commands` throws and is caught.
  const degraded = discovery.discoverCommands({ root, project: { id: 'generic', language: 'unknown', evidence: 'nothing to detect', others: [], adapter: null } });
  assert.deepEqual(degraded.operations, {});
  assert.deepEqual(degraded.sources, {});

  const built = plan.buildPlan({ goal: 'fix the failing test', discovery: { root, commands: degraded.operations } });
  assert.deepEqual(built.steps.map((step) => step.kind), ['inspect', 'patch'], 'every command-bearing step is dropped');
  assert.ok(built.reasons.some((reason) => /reproduce: the reproduce step needs the focusedTest or test command, and discovery provided none/.test(reason)));
  assert.ok(built.reasons.some((reason) => /affected-test: the affected-test step needs the test or focusedTest command/.test(reason)));
  assert.ok(built.reasons.some((reason) => /a repair without a reproduce step has no regression evidence/.test(reason)));
});

// ---------------------------------------------------------------------------
// Differential check against the frozen donor modules
// ---------------------------------------------------------------------------

test('the adapter port agrees with the donor module for every adapter and fixture', { skip: DONOR_SKIP }, () => {
  const donor = require(path.join(DONOR_ROOT, 'adapters', 'index.cjs'));
  assert.deepEqual(adapters.defaultAdapters().map((adapter) => adapter.id), donor.defaultAdapters().map((adapter) => adapter.id));
  assert.deepEqual([...adapters.OPERATIONS], [...donor.OPERATIONS]);
  assert.deepEqual({ ...adapters.CONFIDENCE }, { ...donor.CONFIDENCE });

  const portAdapters = Object.fromEntries(adapters.defaultAdapters().map((adapter) => [adapter.id, adapter]));
  const donorAdapters = Object.fromEntries(donor.defaultAdapters().map((adapter) => [adapter.id, adapter]));
  const roots = [...DECLARING_FIXTURES.map((entry) => entry.root), EMPTY_ROOT, fixture({}), fixture({ 'package.json': '{"scripts":{"test":"node --test"}}', 'pnpm-lock.yaml': '' })];
  for (const root of roots) {
    assert.equal(adapters.packageManagerOf(root), donor.packageManagerOf(root), `packageManagerOf(${root})`);
    for (const id of Object.keys(donorAdapters)) {
      assert.deepEqual(portAdapters[id].detect(root), donorAdapters[id].detect(root), `${id}.detect(${root})`);
      assert.deepEqual(portAdapters[id].commands(root), donorAdapters[id].commands(root), `${id}.commands(${root})`);
      assert.deepEqual(portAdapters[id].artifacts(root), donorAdapters[id].artifacts(root), `${id}.artifacts(${root})`);
    }
  }
  assert.equal(adapters.command(''), donor.command(''));
  assert.deepEqual(adapters.command('npm test', { cwd: 'pkg', confidence: 'inferred', evidence: 'e', longRunning: true, acceptsFocus: true }), donor.command('npm test', { cwd: 'pkg', confidence: 'inferred', evidence: 'e', longRunning: true, acceptsFocus: true }));
  assert.equal(adapters.readText(EMPTY_ROOT, 'nope.txt'), donor.readText(EMPTY_ROOT, 'nope.txt'));
  assert.deepEqual(adapters.readJson(path.join(EMPTY_ROOT, 'nope.json')), donor.readJson(path.join(EMPTY_ROOT, 'nope.json')));
  assert.equal(adapters.exists(EMPTY_ROOT, 'nope'), donor.exists(EMPTY_ROOT, 'nope'));
});

test('the autonomy port agrees with the donor module decision by decision', { skip: DONOR_SKIP }, () => {
  const donor = require(path.join(DONOR_ROOT, 'autonomy.cjs'));
  assert.deepEqual({ ...autonomy.AUTONOMY_SOURCES }, { ...donor.AUTONOMY_SOURCES });
  assert.deepEqual([...autonomy.FINAL_REASONS], [...donor.FINAL_REASONS]);
  assert.deepEqual({ ...autonomy.DEFAULT_AUTONOMY_LIMITS }, { ...donor.DEFAULT_AUTONOMY_LIMITS });
  for (const value of ['yes', 'no', 'maybe', '', 1, 0, true, false, null, undefined]) {
    assert.equal(autonomy.booleanOrNull(value), donor.booleanOrNull(value), String(value));
  }
  const resolutions = [
    {},
    { runtime: { autonomyEnabled: true } },
    { contract: { autonomy_enabled: true } },
    { runOptions: { autonomous: false } },
    { runtime: { enabled: 'no' }, contract: { autonomyEnabled: 'true' }, runOptions: { autonomyEnabled: '1' } },
  ];
  for (const input of resolutions) assert.deepEqual(autonomy.resolveAutonomy(input), donor.resolveAutonomy(input), JSON.stringify(input));

  const reports = [
    { result: 'FAILED', mutations: { applied: 1 }, filesChanged: ['a.js'], verification: { levels: { 'full-verify': { ok: true } } } },
    { result: 'COMPLETED' },
    { result: 'CANCELLED' },
    { result: 'BLOCKED' },
    { result: 'REFUSED', mutations: { applied: 2 } },
    { result: 'completion is refused' },
    { result: 'FAILED' },
    { result: 'FAILED', filesChanged: Array.from({ length: 60 }, (_, index) => `f${index}`) },
  ];
  const contexts = [{ round: 0, totalSteps: 0 }, { round: 7, totalSteps: 399 }, { round: 8, totalSteps: 400 }, { round: 2, totalSteps: 100 }];
  for (const enabled of [false, true]) {
    for (const limits of [undefined, { maxContinuationRounds: 2, maxTotalSteps: 100 }, { maxContinuationRounds: 0, maxTotalSteps: 0 }]) {
      const ported = autonomy.createEngineeringAutonomy({ enabled, limits, now: () => 7 });
      const original = donor.createEngineeringAutonomy({ enabled, limits, now: () => 7 });
      for (const report of reports) {
        for (const context of contexts) {
          assert.deepEqual(ported.decide(report, context), original.decide(report, context), `${enabled} ${JSON.stringify(limits)} ${JSON.stringify(context)} ${JSON.stringify(report.result)}`);
        }
      }
      assert.deepEqual(ported.decisions(), original.decisions());
      assert.deepEqual(ported.state(), original.state());
    }
  }
});

test('the episode port agrees with the donor module transition by transition', { skip: DONOR_SKIP }, () => {
  const donor = require(path.join(DONOR_ROOT, 'episode.cjs'));
  assert.deepEqual({ ...episode.EPISODE_PHASES }, { ...donor.EPISODE_PHASES });
  assert.deepEqual({ ...episode.EPISODE_TRANSITIONS }, { ...donor.EPISODE_TRANSITIONS });
  assert.deepEqual([...episode.TERMINAL_PHASES], [...donor.TERMINAL_PHASES]);
  assert.deepEqual([...episode.WORK_PHASES], [...donor.WORK_PHASES]);
  assert.deepEqual([...episode.PARKABLE_PHASES], [...donor.PARKABLE_PHASES]);
  assert.deepEqual(episode.EPISODE_TRANSITIONS, donor.EPISODE_TRANSITIONS, 'the frozen tables are equal, not merely equivalent');
  for (const phase of Object.values(episode.EPISODE_PHASES)) {
    assert.equal(episode.isTerminalPhase(phase), donor.isTerminalPhase(phase), phase);
    assert.equal(episode.isParkablePhase(phase), donor.isParkablePhase(phase), phase);
  }
  for (const from of Object.values(episode.EPISODE_PHASES)) {
    for (const to of Object.values(episode.EPISODE_PHASES)) {
      const ported = episode.createEpisodeStateMachine({ initial: from, now: () => 3 });
      const original = donor.createEpisodeStateMachine({ initial: from, now: () => 3 });
      assert.deepEqual(ported.transition(to), original.transition(to), `${from} -> ${to}`);
      assert.deepEqual(ported.allowedFrom(), original.allowedFrom(), `${from} allowedFrom`);
      assert.deepEqual(ported.force(to, 'x'), original.force(to, 'x'), `${from} force ${to}`);
    }
  }
});
