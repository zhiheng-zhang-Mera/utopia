// PCF-700 dependency-direction guards / 依赖方向守卫
//
// The workbook's fourth acceptance sub-step asks for the UI -> backend direction to be checked for cycles, and the
// fifth asks that an unproven seam be recorded rather than zeroed. These four guards encode the direction claim that
// scripts/pcf700-reuse-audit.mjs measures, so the map cannot rot silently: a backend module that starts importing a
// front-end module, a UI that calls a route the City does not serve, a new engineering/general-ai contract with no
// test, or a runtime module that starts referring to the fabric, each turns a test red instead of becoming prose.
//
// The probe that produced the numbers in docs/{zh-CN,en}/pcf/reuse-tiers.md had its OWN bug first: one loose regex
// reported nineteen "backend imports" of front-end code, and all nineteen were false positives (filesystem paths used
// to SERVE the UI, and drivers under tests/ and scripts/). The separation into module imports, serve paths, tools and
// tests is the repair, and it is the distinction this file asserts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SKIP = new Set(['node_modules', '.git', 'build', '.gradle']);
const SELF = 'scripts/pcf700-reuse-audit.mjs'; // the instrument is not part of the subject it measures
const walk = async (dir, out = []) => {
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    if (entry.isDirectory()) { if (!SKIP.has(entry.name)) await walk(resolve(dir, entry.name), out); }
    else if (/\.(mjs|js|kt|ts)$/.test(entry.name)) out.push(resolve(dir, entry.name));
  }
  return out;
};
const rel = (p) => p.slice(ROOT.length + 1).split('\\').join('/');
const sources = async () => {
  const out = new Map();
  for (const file of await walk(ROOT)) { const name = rel(file); if (name !== SELF) out.set(name, await readFile(file, 'utf8')); }
  return out;
};
const CODE_IMPORT = /^\s*(?:import|export)\s+(?:[^;\n]*?\bfrom\s*)?(['"])([^'"]+)\1|^\s*import\s*\(\s*(['"])([^'"]+)\3/gm;
/** Module specifiers only. A SIDE-EFFECT import (`import '../apps/web/app.js';`) has no `from` clause, and the first
 *  spelling of this detector missed exactly that case until falsifying the guard produced the line; both spellings
 *  are covered now, because both create the dependency this file is about. */
const importsApp = (text) => [...text.matchAll(CODE_IMPORT)].map((m) => m[2] ?? m[4]).some((s) => /(^|\/)apps\/(web|android)\//.test(s));
const literals = (text, re) => [...new Set((text.match(re) || []).map((s) => s.replace(/[.,'"`)]+$/, '')))];

test('PCF-700 D1: no backend module imports a front-end module, so the UI -> backend direction stays acyclic', async () => {
  const files = await sources();
  const backend = [...files].filter(([name, text]) => /^(services|contracts|city|platform)\//.test(name) && importsApp(text)).map(([name]) => name);
  assert.deepEqual(backend, [], 'a backend module importing apps/* would make the dependency direction cyclic');
  // The other two categories are recorded, not forbidden: the static host serves the web root as a PATH, and the
  // drivers under tests/ and scripts/ import web modules on purpose. Naming them keeps the distinction visible.
  const serve = [...files].filter(([name, text]) => !importsApp(text) && /resolve\([^\n]*apps\/(web|android)/.test(text)).map(([name]) => name);
  assert.deepEqual(serve, ['services/dev-gateway/static.mjs', 'tests/web-i18n.test.mjs'], 'the only path-level references to the web root are the static host and one i18n test');
});

test('PCF-700 D2: every endpoint a user surface names is one the gateway actually serves', async () => {
  const files = await sources();
  const routes = literals(files.get('services/dev-gateway/server.mjs'), /\/api\/v0\/[a-z0-9/_{}.-]*/gi).map((r) => r.replace(/\/$/, ''));
  const unresolved = [];
  for (const [name, text] of files) {
    if (!/^apps\/(web|android)\//.test(name)) continue;
    for (const literal of literals(text, /\/api\/v0\/[a-z0-9/_{}$.-]*/gi)) {
      const staticPart = literal.replace(/\$\{[^}]*\}/g, '').replace(/\/$/, '');
      if (!routes.some((route) => route.startsWith(staticPart) || staticPart.startsWith(route))) unresolved.push(`${name} -> ${literal}`);
    }
  }
  assert.deepEqual(unresolved, [], 'a UI literal with no gateway route is a call that would 404 in production');
});

test('PCF-700 D3: every engineering and general-ai contract carries at least one test', async () => {
  const files = await sources();
  const dirs = (await readdir(resolve(ROOT, 'contracts'), {withFileTypes: true}))
    .filter((e) => e.isDirectory() && (e.name.startsWith('engineering-') || e.name.startsWith('general-ai-'))).map((e) => e.name).sort();
  const untested = dirs.filter((name) => ![...files].some(([file, text]) => !file.startsWith(`contracts/${name}/`) && text.includes(`contracts/${name}/`)));
  assert.deepEqual(untested, [], 'a contract nobody references is DECLARED only, and the tier table must be able to say so from a test');
  assert.ok(dirs.length >= 20, `the measured domain must be non-empty, found ${dirs.length} directories`);
});

test('PCF-700 D4: no runtime module refers to the fabric yet, so the audit really is still an audit', async () => {
  const files = await sources();
  const runtime = [...files].filter(([name, text]) => /^(services|contracts|apps|city|platform)\//.test(name) && text.includes('personal-compute-fabric')).map(([name]) => name);
  assert.deepEqual(runtime, [], 'this workbook creates no runtime module; a reference here means the audit silently became an implementation');
});
