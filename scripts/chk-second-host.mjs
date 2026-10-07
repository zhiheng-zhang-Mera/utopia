#!/usr/bin/env node
// Whole-series DEVELOPMENT replay runner. Independent reviewer owns acceptance.
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, relative, isAbsolute } from 'node:path';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { redactText } from '../city/02-engineering/05-city-self-health-check/city-self-health-check/sanitize.mjs';

const options = {};
async function canonicalOutput(path) { try { return await realpath(path); } catch (error) { if (error.code !== 'ENOENT') throw error; const parent = resolve(path, '..'); if (parent === path) throw error; return resolve(await canonicalOutput(parent), relative(parent, path)); } }
try {
  for (let i = 2; i < process.argv.length;) { const key = process.argv[i]; if (key === '--development' && !(key in options)) { options[key] = true; i++; continue; } if (!['--utopia', '--city', '--implementation-sha', '--city-sha', '--out'].includes(key) || !process.argv[i + 1] || key in options) throw new Error('Expected --utopia --city --implementation-sha --city-sha --out [--development]'); options[key] = process.argv[i + 1]; i += 2; }
  for (const key of ['--utopia', '--city', '--implementation-sha', '--city-sha', '--out']) if (!options[key]) throw new Error(`Missing ${key}`);
  const utopia = await realpath(resolve(options['--utopia'])), city = await realpath(resolve(options['--city'])), out = await canonicalOutput(resolve(options['--out']));
  if (!options['--development'] && hostname().toLowerCase() === 'mera-alianware') throw new Error('Developer physical host must use explicit --development; second-host review requires another host');
  const git = (root, args) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', timeout: 10000 }).trim();
  const snapshot = root => ({ head_sha: git(root, ['rev-parse', 'HEAD']), branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), clean: !git(root, ['status', '--porcelain']) });
  const before = { utopia: snapshot(utopia), city: snapshot(city) };
  for (const [root, expected, actual] of [[utopia, options['--implementation-sha'], before.utopia], [city, options['--city-sha'], before.city]]) { if (!/^[0-9a-f]{40}$/.test(expected) || actual.head_sha !== expected) throw new Error('Exact SHA mismatch'); if (!actual.clean) throw new Error('Replay requires clean checkouts'); const rel = relative(root, out); if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Output must be outside inspected repositories'); }
  await mkdir(out, { recursive: false });
  const runs = [];
  for (const [name, args] of [['chk990', ['--test', 'city/02-engineering/05-city-self-health-check/city-self-health-check/tests/health-check.test.mjs', 'city/02-engineering/05-city-self-health-check/city-self-health-check/tests/boundaries.test.mjs']], ['small', ['scripts/city-health-check.mjs', '--utopia', utopia, '--city', city, '--out', resolve(out, 'small'), '--mode', 'small']], ['full', ['scripts/city-health-check.mjs', '--utopia', utopia, '--city', city, '--out', resolve(out, 'full'), '--mode', 'full', '--max-duration-ms', '120000']]]) {
    const result = spawnSync(process.execPath, args, { cwd: utopia, encoding: 'utf8', timeout: 180000, maxBuffer: 16_000_000 });
    const log = redactText(`${result.stdout ?? ''}${result.stderr ?? ''}`); await writeFile(resolve(out, `${name}.log`), log, { flag: 'wx' }); runs.push({ name, exit_code: result.status, status: result.status === 0 ? 'PASS' : 'FAIL', sha256: createHash('sha256').update(log).digest('hex') });
  }
  const after = { utopia: snapshot(utopia), city: snapshot(city) }, cleanAfter = after.utopia.clean && after.city.clean;
  const sourceUnchanged = JSON.stringify(before) === JSON.stringify(after);
  const receipt = { schema_version: 1, host: hostname(), node_version: process.version, run_mode: options['--development'] ? 'DEVELOPMENT_REPLAY' : 'SECOND_HOST_REPLAY_PENDING_REVIEW', host_identity_assurance: 'HOSTNAME_ONLY', implementation_sha: options['--implementation-sha'], city_sha: options['--city-sha'], identities_before: before, identities_after: after, source_unchanged: sourceUnchanged, runs, inspected_roots_clean_after: cleanAfter, observed_at: new Date().toISOString(), whole_series_independent_review: 'NOT_RUN_REVIEWER_MUST_ASSESS', freeze_outcome: 'NOT_ACCEPTED_BY_RUNNER', execution_authority: false };
  await writeFile(resolve(out, 'replay-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify(receipt) + '\n'); process.exitCode = runs.every(x => x.status === 'PASS') && cleanAfter && sourceUnchanged ? 0 : 1;
} catch (error) { process.stderr.write(`CHK replay: ${error.message}\n`); process.exitCode = 2; }
