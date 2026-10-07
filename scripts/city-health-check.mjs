#!/usr/bin/env node
import { mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { runHealthCheck, quarterlyReview } from '../city/02-engineering/05-city-self-health-check/city-self-health-check/index.mjs';

const allowed = new Set(['utopia', 'city', 'mode', 'out', 'max-files', 'max-bytes', 'max-duration-ms', 'runtime-snapshot', 'quarterly-input']);
function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) { const key = argv[i]?.replace(/^--/, ''); if (!allowed.has(key) || !argv[i].startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--') || key in result) throw new Error(`Invalid argument: ${argv[i]}`); result[key] = argv[i + 1]; }
  if (!result.utopia || !result.city || !result.out) throw new Error('Usage: node scripts/city-health-check.mjs --utopia <checkout> --city <Digital-City-checkout> --out <external-new-directory> [--mode small|full|quarterly]');
  return result;
}
async function canonicalOutput(path) { try { return await realpath(path); } catch (error) { if (error.code !== 'ENOENT') throw error; const parent = resolve(path, '..'); if (parent === path) throw error; return resolve(await canonicalOutput(parent), relative(parent, path)); } }
async function jsonInput(path) { if (!path) return null; const info = await lstat(resolve(path)); if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw new Error('Input must be a regular JSON file under 1 MB'); return JSON.parse(await readFile(resolve(path), 'utf8')); }
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
try {
  const options = args(process.argv.slice(2));
  const utopiaRoot = await realpath(resolve(options.utopia)), cityRoot = await realpath(resolve(options.city));
  const out = await canonicalOutput(resolve(options.out));
  for (const root of [utopiaRoot, cityRoot]) { const rel = relative(root, out); if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Output must be outside inspected repositories'); }
  const report = await runHealthCheck({ utopiaRoot, cityRoot, mode: options.mode ?? 'small', ...(options['max-files'] ? { maxFiles: Number(options['max-files']) } : {}), ...(options['max-bytes'] ? { maxBytes: Number(options['max-bytes']) } : {}), ...(options['max-duration-ms'] ? { maxDurationMs: Number(options['max-duration-ms']) } : {}), runtimeSnapshot: await jsonInput(options['runtime-snapshot']) });
  const quarterlyInput = await jsonInput(options['quarterly-input']);
  if (quarterlyInput) report.quarterly = quarterlyReview(report, quarterlyInput);
  // Exclusive creation preserves historical runs. A check can only write its explicit output bundle.
  await mkdir(out, { recursive: false });
  const markdown = `# City self-health check\n\nMode: ${report.mode}; outcome: ${report.outcome}.\n\nImplementation SHA: ${report.identities.utopia.head_sha}; City SHA: ${report.identities.city.head_sha}.\n\nRead ${report.metrics.filesRead} files / ${report.metrics.bytesRead} bytes in ${report.metrics.elapsed_ms.toFixed(1)} ms. Static scan complete: ${report.coverage.complete}. Runtime: ${report.coverage.runtime}.\n\nIndependent whole-series review: NOT_RUN. Scheduling, repairs, execution and promotion authority: none.\n\n## Findings\n\n| Code | Owner | Severity | Evidence | Destination |\n|---|---|---|---|---|\n${report.findings.map(x => `| ${x.code} | ${x.owner_surface.replace(/[|\n\r]/g, ' ')} | ${x.severity} | ${x.evidence[0].path.replace(/[|\n\r]/g, ' ')} | ${x.recommended_destination} |`).join('\n')}\n\n## Coverage\n\nSee report.json for unknown/unmeasured domains, diagnostics, self model, BLG-001..006 reconciliation and routing receipts. Static heuristics discover candidate drift; findings do not establish root cause or authorize repair.\n`;
  const artifacts = { 'report.json': JSON.stringify(report, null, 2) + '\n', 'report.md': markdown, 'source-manifest.json': JSON.stringify(report.evidence_manifest, null, 2) + '\n' };
  const checksums = { schema_version: 1, algorithm: 'sha256', files: {} };
  for (const [name, content] of Object.entries(artifacts)) { await writeFile(resolve(out, name), content, { flag: 'wx' }); checksums.files[name] = digest(content); }
  await writeFile(resolve(out, 'checksums.json'), JSON.stringify(checksums, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ out, outcome: report.outcome, finding_count: report.findings.length, coverage_complete: report.coverage.complete, metrics: report.metrics, independent_review: 'NOT_RUN' }) + '\n');
} catch (error) { process.stderr.write(`CHK: ${error.message}\n`); process.exitCode = 2; }
