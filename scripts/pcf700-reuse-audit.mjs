#!/usr/bin/env node
// PCF-700 reuse/wiring audit. It MEASURES and prints; it asserts nothing about maturity beyond what its own grep
// found, because "the contract directory exists" and "the gateway calls it" are different facts and this programme
// has already been burned once by treating a seam as a service. Run: node scripts/pcf700-reuse-audit.mjs [--out FILE]
//
// Tiers are derived, never declared by hand:
//   MISSING            no such contract directory
//   DECLARED           the directory exists but nothing outside it references it
//   COMPONENT_TESTED   only tests/ reference it
//   LIVE_WIRED         at least one production file (not under tests/) references it
// TWO_HOST_VERIFIED and ORIGIN_AGENT_CONSUMED are deliberately NOT derivable from this grep: the first needs the
// opposite physical host and the second needs a measured origin-side result consumption, so both are reported as
// NOT_MEASURED_HERE and the human record must cite its own evidence.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
const read = (p) => readFile(p, 'utf8');
const exists = async (p) => { try { await stat(p); return true } catch { return false; } };
const walk = async (dir, skip, out = []) => {
  let entries;
  // Churn-tolerant for the same reason as the guard suite: another test may remove a scratch directory mid-walk.
  try { entries = await readdir(dir, {withFileTypes: true}); } catch (error) { if (error.code === 'ENOENT') return out; throw error; }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isDirectory()) { if (skip.includes(e.name)) continue; await walk(path.join(dir, e.name), skip, out); }
    else out.push(path.join(dir, e.name));
  }
  return out;
};

// THE INSTRUMENT IS NOT PART OF THE SUBJECT. This script names contract paths and the words
// "personal-compute-fabric", so counting itself would inflate its own importer counts and its own
// no-PCF-runtime evidence; it is excluded from the scanned set, and the runtime claim is restricted to runtime roots.
const files = (await walk('.', ['node_modules', '.git', 'build', '.gradle']))
  .map((p) => p.split(path.sep).join('/').replace(/^\.\//, ''))
  .filter((p) => /\.(mjs|js|kt|ts)$/.test(p))
  .filter((p) => p !== 'scripts/pcf700-reuse-audit.mjs');
const text = new Map();
for (const f of files) text.set(f, await read(f));

const contractDirs = (await readdir('contracts', { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const DOMAINS = {
  EM_ENGINEERING: contractDirs.filter((n) => n.startsWith('engineering-')),
  GAI_GENERAL_AI: contractDirs.filter((n) => n.startsWith('general-ai-')),
  RF_REMOTE_AND_RETURN_SURFACE: contractDirs.filter((n) => n.startsWith('remote-') || n.startsWith('rs-')),
  WBC_WORKBENCH_COMPAT: ['execution-backend-v1', 'node-descriptor-v1'],
};

const tiers = {};
for (const [domain, names] of Object.entries(DOMAINS)) {
  tiers[domain] = [];
  for (const name of names) {
    const dir = `contracts/${name}`;
    const modules = files.filter((f) => f.startsWith(`${dir}/`) && f.endsWith('.mjs'));
    const refs = files.filter((f) => !f.startsWith(`${dir}/`) && text.get(f).includes(`${dir}/`));
    const tests = refs.filter((f) => f.startsWith('tests/'));
    const production = refs.filter((f) => !f.startsWith('tests/'));
    const exports = modules.reduce((n, f) => n + (text.get(f).match(/^export /gm) || []).length, 0);
    tiers[domain].push({
      contract: name,
      declared: modules.length > 0,
      moduleFiles: modules.length,
      exportedStatements: exports,
      productionImporters: production,
      testImporters: tests,
      tier: !modules.length ? 'MISSING' : production.length ? 'LIVE_WIRED' : tests.length ? 'COMPONENT_TESTED' : 'DECLARED',
      twoHostVerified: 'NOT_MEASURED_HERE (needs the opposite physical host)',
      originAgentConsumed: 'NOT_MEASURED_HERE (needs a measured origin-side result consumption)',
    });
  }
}

// Does any backend file IMPORT a front-end module? The direction of the dependency is the claim under audit, so the
// three ways a reference can happen are separated rather than lumped together: a real module import (the dependency
// that would make the direction cyclic), a filesystem path used to SERVE the UI (a static host, which is the correct
// direction), and drivers under tests/ or scripts/ that import web modules on purpose.
//
// TWO OF THIS PROBE'S OWN BUGS ARE RECORDED RATHER THAN SMOOTHED OVER. (1) One loose regex reported nineteen
// "backend imports" of front-end code; all nineteen were false positives (serve paths and test/script drivers).
// (2) The repair then matched only `import ... from '...'`, so a SIDE-EFFECT import - `import '../apps/web/app.js';`,
// which is a real dependency - escaped it; that was found by falsifying the guard with exactly that line. The probe
// now extracts module specifiers and asks whether any of them resolves into apps/, which covers both spellings.
const SPECIFIER = /^\s*(?:import|export)\s+(?:[^;\n]*?\bfrom\s*)?(['"])([^'"]+)\1|^\s*import\s*\(\s*(['"])([^'"]+)\3/gm;
const moduleSpecifiers = (t) => [...t.matchAll(SPECIFIER)].map((m) => m[2] ?? m[4]);
const importsAppModule = (t) => moduleSpecifiers(t).some((s) => /(^|\/)apps\/(web|android)\//.test(s));
const codeImporters = files.filter((f) => importsAppModule(text.get(f)));
const backendModuleImports = codeImporters.filter((f) => /^(services|contracts|city|platform)\//.test(f));
const toolModuleImports = codeImporters.filter((f) => f.startsWith('scripts/'));
const testModuleImports = codeImporters.filter((f) => f.startsWith('tests/'));
const serveReferences = files.filter((f) => !codeImporters.includes(f) && /resolve\([^\n]*apps\/(web|android)/.test(text.get(f)));

// UI -> backend: every /api/v0 literal a user surface can reach, per file.
const uiFiles = files.filter((f) => f.startsWith('apps/web/') || f.startsWith('apps/android/'));
const uiEndpoints = {};
for (const f of uiFiles) {
  const hits = [...new Set((text.get(f).match(/\/api\/v0\/[a-z0-9/_{}$.-]*/gi) || []).map((s) => s.replace(/[.,'"`)]+$/, '')))].sort();
  if (hits.length) uiEndpoints[f] = hits;
}
const gatewayRoutes = [...new Set((text.get('services/dev-gateway/server.mjs').match(/\/api\/v0\/[a-z0-9/_{}.-]*/gi) || []))].sort();

// A UI literal is unresolved if no gateway route starts with its static prefix (the UI may append an id).
const unresolved = [];
for (const [file, list] of Object.entries(uiEndpoints)) {
  for (const literal of list) {
    const staticPart = literal.replace(/\$\{[^}]*\}/g, '').replace(/\/$/, '');
    if (!gatewayRoutes.some((r) => r.replace(/\$\{[^}]*\}/g, '').startsWith(staticPart) || staticPart.startsWith(r.replace(/\/$/, '')))) {
      unresolved.push({ file, literal });
    }
  }
}

// Single writers: the canonical files whose sole-writer claim the map makes, with exact byte evidence so the opposite
// host can recompute rather than trust.
const canonical = [
  ['services/dev-gateway/server.mjs', 'routes + backend/profile construction (only writer)'],
  ['services/dev-gateway/store.mjs', 'canonical task/action/device/event truth (only writer)'],
  ['services/dev-gateway/targeting.mjs', 'strict-target classification (pure, no writer)'],
  ['services/dev-gateway/execution-profile.mjs', 'profile switch controller (only writer of profile state)'],
  ['contracts/node-descriptor-v1/node-descriptor.mjs', 'node-descriptor fields (shared by gateway and worker pool)'],
];
const singleWriters = [];
for (const [file, role] of canonical) {
  const bytes = Buffer.from(text.get(file), 'utf8');
  singleWriters.push({ file, role, bytes: bytes.length, lines: text.get(file).split('\n').length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
// PCF-700's phase claim was "no runtime module refers to the fabric yet". PCF-701 activated the fabric's first runtime
// modules under its declared paths, so the audit now reports BOTH numbers: every runtime reference, and the ones that
// fall outside the declared paths (which would mean the fabric leaked into another domain). The property survives the
// activation instead of being deleted; see the successor guard PCF-700 D4 in tests/pcf700-dependency-direction.test.mjs.
const PCF_DECLARED_PATHS = /^(contracts\/personal-compute-fabric-v1|services\/personal-compute-fabric)\//;
const pcfRuntimeReferences = files.filter((f) => /^(services|contracts|apps|city|platform)\//.test(f) && text.get(f).includes('personal-compute-fabric'));
const pcfRuntimeReferencesOutsideDeclaredPaths = pcfRuntimeReferences.filter((f) => !PCF_DECLARED_PATHS.test(f));

const report = {
  measuredAt: { host: process.env.COMPUTERNAME || 'unknown', node: process.version, head: 'see report HEAD_SHA' },
  contractDirectoryCount: contractDirs.length,
  domains: tiers,
  dependencyDirection: {
    backendModuleImports,
    toolModuleImports,
    testModuleImports,
    backendServePathReferences: serveReferences,
    frontendFileCount: uiFiles.length,
    uiWithEndpoints: Object.keys(uiEndpoints).length,
    unresolvedUiEndpoints: unresolved,
  },
  gatewayRoutes,
  uiEndpoints,
  singleWriters,
  pcfRuntimeReferences,
  pcfRuntimeReferencesOutsideDeclaredPaths,
};
const rendered = JSON.stringify(report, null, 2) + '\n';
if (OUT) await writeFile(OUT, rendered, 'utf8');
process.stdout.write(rendered);
