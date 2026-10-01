#!/usr/bin/env node
/**
 * UI-000 evidence helper — published-evidence consistency check.
 *
 * This mission hit the SAME class of defect three times: an evidence pointer that
 * no longer described the artifact it claimed to describe.
 *
 *   1. `HEAD_SHA` in DEVELOPMENT_REPORT went stale when the branch moved (§8 item 6).
 *   2. `parity.mjs` wrote its report to a path that was no longer published, so the
 *      published parity report sat at 285/285 while the real run was 390/390 (§10).
 *   3. Published candidate screenshots and README numbers predated the head that
 *      fixed the very defect the Review had flagged.
 *
 * `CONSTRUCTION_RULES.md` §7 exists for exactly this, and it says reconciliation must
 * verify `recorded == evidence` before a stage is declared drained or a merge starts.
 * A human doing that by eye is what failed three times, so this makes it one command.
 *
 *   node scripts/ui-000/evidence-check.mjs --write   # (re)generate the manifest
 *   node scripts/ui-000/evidence-check.mjs           # verify it against the current source state
 *
 * Verifies: the source the evidence describes is unchanged, and every listed file
 * exists with the recorded sha256. A mismatch is EVIDENCE_POINTER_MISMATCH.
 *
 * Keyed to the SOURCE STATE, not to a commit sha. Keying it to a commit would make
 * every evidence-only commit invalidate its own manifest — and would also force a
 * pointless re-capture when only unrelated files (docs, tests) moved. What the
 * evidence actually describes is the tree under SOURCE_PATHS, so that is what is
 * hashed.
 *
 * Evidence tooling for the UI-000 Owner gate; delete with apps/web/candidates/.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PUBLISHED = resolve(ROOT, 'evidence/raw/mission-book/UI-000');
const MANIFEST = resolve(PUBLISHED, 'EVIDENCE_MANIFEST.json');
const WRITE = process.argv.includes('--write');

/** The tree the published evidence is a picture of. */
const SOURCE_PATHS = [
  'apps/web/candidates',
  'apps/rooms/hub/public/themes',
  'apps/rooms/hub/public/index.html',
  'apps/android/app/src/main/java/city/utopia/control/ui000',
  'apps/android/app/src/debug',
  'apps/android/app/src/main/AndroidManifest.xml',
];

const git = (...args) => execFileSync('git', args, { cwd: ROOT }).toString().trim();
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.name !== 'EVIDENCE_MANIFEST.json') out.push(full);
  }
  return out;
}

/** Files whose content is produced by a tool and therefore must track the source. */
const GENERATED = /(parity-report\.(md|json)|candidate-[abc]\/.*\.png|rooms\/.*\.png|before\/.*\.png|android-candidates\/.*\.png)$/;

/** Deterministic digest over the files the evidence is a picture of. */
async function sourceDigest() {
  const files = [];
  for (const entry of SOURCE_PATHS) {
    const full = resolve(ROOT, entry);
    try {
      const info = await stat(full);
      if (info.isDirectory()) files.push(...await walk(full));
      else files.push(full);
    } catch {
      /* a path that does not exist yet contributes nothing */
    }
  }
  const rel = files.map((f) => relative(ROOT, f).split(sep).join('/')).sort();
  const hash = createHash('sha256');
  for (const path of rel) {
    hash.update(path);
    hash.update('\0');
    hash.update(await readFile(resolve(ROOT, path)));
    hash.update('\0');
  }
  return { digest: hash.digest('hex'), fileCount: rel.length };
}

async function build() {
  const head = git('rev-parse', 'HEAD');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const source = await sourceDigest();
  const files = (await walk(PUBLISHED)).sort();
  const entries = [];
  for (const file of files) {
    const buf = await readFile(file);
    entries.push({
      path: relative(PUBLISHED, file).split(sep).join('/'),
      bytes: (await stat(file)).size,
      sha256: sha256(buf),
      generated: GENERATED.test(file.split(sep).join('/')),
    });
  }
  return {
    schema: 'ui-000-evidence-manifest/1',
    captured_at: new Date().toISOString(),
    branch,
    captured_at_head_sha: head,
    source_paths: SOURCE_PATHS,
    source_file_count: source.fileCount,
    source_digest: source.digest,
    note: 'source_digest is a sha256 over source_paths, i.e. the tree this evidence is a picture of. It is deliberately NOT keyed to a commit sha: that would make every evidence-only commit invalidate its own manifest, and would force a pointless re-capture when only docs or tests moved. Generated files must be re-captured whenever source_digest changes; hand-written files (README.md, this manifest) are exempt from that rule but are still hash-verified.',
    file_count: entries.length,
    generated_file_count: entries.filter((e) => e.generated).length,
    files: entries,
  };
}

async function verify() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  } catch {
    console.error('EVIDENCE_MANIFEST_MISSING: run with --write to generate it');
    process.exit(1);
  }
  const source = await sourceDigest();
  const failures = [];

  if (manifest.source_digest !== source.digest) {
    failures.push(`EVIDENCE_POINTER_MISMATCH: evidence describes source_digest ${String(manifest.source_digest).slice(0, 12)} but the source is now ${source.digest.slice(0, 12)} (${source.fileCount} files) — re-capture the generated evidence, then run --write`);
  }
  for (const entry of manifest.files) {
    const file = resolve(PUBLISHED, entry.path);
    try {
      const buf = await readFile(file);
      const digest = sha256(buf);
      if (digest !== entry.sha256) failures.push(`HASH_MISMATCH: ${entry.path}`);
    } catch {
      failures.push(`MISSING: ${entry.path}`);
    }
  }
  const present = new Set((await walk(PUBLISHED)).map((f) => relative(PUBLISHED, f).split(sep).join('/')));
  for (const path of present) {
    if (!manifest.files.some((f) => f.path === path)) failures.push(`UNRECORDED: ${path} is published but not in the manifest`);
  }

  console.log(`evidence manifest: source ${manifest.source_digest.slice(0, 12)} (${source.fileCount} source files), ${manifest.files.length} published files (${manifest.generated_file_count} generated), captured at head ${String(manifest.captured_at_head_sha).slice(0, 10)}`);
  if (failures.length) {
    for (const f of failures) console.error('  - ' + f);
    console.error(`evidence-check: FAIL (${failures.length})`);
    process.exit(1);
  }
  console.log('evidence-check: PASS');
}

if (WRITE) {
  await writeFile(MANIFEST, JSON.stringify(await build(), null, 2) + '\n');
  console.log('evidence manifest written');
} else {
  await verify();
}
