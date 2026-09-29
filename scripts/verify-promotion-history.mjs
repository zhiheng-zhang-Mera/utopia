/**
 * UTOPIA — promotion history verifier.
 *
 * Checks every `apps/rooms/promotions/*.json` record against the *local* Git
 * history (never the GitHub API):
 *
 *   git cat-file -e <accepted>^{commit}
 *   git cat-file -e <promoted>^{commit}
 *   git merge-base --is-ancestor <accepted> <promoted>
 *   git merge-base --is-ancestor <promoted> HEAD
 *   git cat-file -e <promoted>:<targetCityPath>
 *   git cat-file -e HEAD:<targetCityPath>
 *
 * and confirms the retired incubator room no longer has a live implementation.
 *
 * Usage: node scripts/verify-promotion-history.mjs
 */

import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMOTIONS_DIR = join(REPO, 'apps', 'rooms', 'promotions');

const problems = [];
const notes = [];

async function git(args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await run('git', args, { cwd: REPO });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    if (!allowFailure) {
      problems.push(`git ${args.join(' ')} failed: ${String(error.stderr ?? error.message).trim()}`);
    }
    return { ok: false, stdout: '' };
  }
}

async function commitExists(sha) {
  const result = await git(['cat-file', '-e', `${sha}^{commit}`], { allowFailure: true });
  return result.ok;
}

async function isAncestor(ancestor, descendant) {
  const result = await git(['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true });
  return result.ok;
}

async function pathExistsAt(sha, path) {
  const result = await git(['cat-file', '-e', `${sha}:${path}`], { allowFailure: true });
  return result.ok;
}

const head = (await git(['rev-parse', 'HEAD'])).stdout;
if (!head) {
  console.error('promotion-history: cannot resolve HEAD');
  process.exit(1);
}

let files = [];
try {
  files = (await readdir(PROMOTIONS_DIR)).filter((name) => name.endsWith('.json')).sort();
} catch (error) {
  console.error(`promotion-history: cannot read ${PROMOTIONS_DIR}: ${error.message}`);
  process.exit(1);
}

if (files.length === 0) {
  console.log('promotion-history: no promotion records found');
  process.exit(0);
}

for (const file of files) {
  const record = JSON.parse(await readFile(join(PROMOTIONS_DIR, file), 'utf8'));
  const label = `${record.roomId ?? file}`;

  for (const field of ['roomId', 'acceptedRoomCommit', 'promotedAtCommit', 'targetCityPath', 'status']) {
    if (!record[field] || typeof record[field] !== 'string') {
      problems.push(`${file}: ${field} must be a non-empty string`);
    }
  }
  if (record.status !== 'PROMOTED') problems.push(`${file}: status must be PROMOTED`);
  if (!String(record.targetCityPath ?? '').startsWith('city/')) {
    problems.push(`${file}: targetCityPath must live under city/`);
  }
  if (!/^[0-9a-f]{40}$/i.test(record.acceptedRoomCommit ?? '')) problems.push(`${file}: acceptedRoomCommit must be a full git SHA`);
  if (!/^[0-9a-f]{40}$/i.test(record.promotedAtCommit ?? '')) problems.push(`${file}: promotedAtCommit must be a full git SHA`);

  if (!(await commitExists(record.acceptedRoomCommit))) {
    problems.push(`${file}: acceptedRoomCommit ${record.acceptedRoomCommit} does not resolve to a commit`);
  }
  if (!(await commitExists(record.promotedAtCommit))) {
    problems.push(`${file}: promotedAtCommit ${record.promotedAtCommit} does not resolve to a commit`);
    continue;
  }
  if (!(await isAncestor(record.acceptedRoomCommit, record.promotedAtCommit))) {
    problems.push(`${file}: acceptedRoomCommit is not an ancestor of promotedAtCommit`);
  }
  if (!(await isAncestor(record.promotedAtCommit, head))) {
    problems.push(`${file}: promotedAtCommit ${record.promotedAtCommit.slice(0, 12)} is not reachable from HEAD`);
  }
  if (!(await pathExistsAt(record.promotedAtCommit, record.targetCityPath))) {
    problems.push(`${file}: ${record.targetCityPath} does not exist at promotedAtCommit ${record.promotedAtCommit.slice(0, 12)}`);
  }
  if (!(await pathExistsAt('HEAD', record.targetCityPath))) {
    problems.push(`${file}: ${record.targetCityPath} does not exist at HEAD`);
  }

  // the retired incubator must not still ship a live implementation
  const live = join(REPO, 'apps', 'rooms', 'rooms', record.roomId);
  if (await stat(live).then(() => true, () => false)) {
    problems.push(`${file}: apps/rooms/rooms/${record.roomId} still exists; a promoted room must not keep a live implementation`);
  }

  notes.push(`${label}: ${record.acceptedRoomCommit.slice(0, 12)} -> ${record.promotedAtCommit.slice(0, 12)} -> ${record.targetCityPath}`);
}

console.log('promotion history:');
for (const note of notes) console.log(`  OK   ${note}`);

if (problems.length > 0) {
  console.error('\npromotion history problems:');
  for (const problem of problems) console.error(`  FAIL ${problem}`);
  console.error(`\npromotion-history: ${problems.length} problem(s)`);
  process.exit(1);
}

console.log(`promotion-history: ${files.length} record(s) verified against local Git history at ${head.slice(0, 12)}`);
