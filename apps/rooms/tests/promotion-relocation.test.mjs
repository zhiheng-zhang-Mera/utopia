/**
 * Promotion relocation records.
 *
 * A promotion record is a historical fact: `targetCityPath` is where the promotion
 * actually landed and is pinned to `promotedAtCommit` by
 * `scripts/verify-promotion-history.mjs`. When a later Mission relocates a module —
 * MB-009 moved the theme engine from 11 Entertainment to 00/05 Control Centre after
 * Digital-City reassigned its ownership — the record gains `relocatedTo` and
 * `relocatedByMission` instead of having its history rewritten.
 *
 * This suite pins that contract in the data, so the verifier's relocation branch
 * cannot silently become dead code and a future relocation cannot be recorded
 * without naming its authority.
 *
 * Known gap, deliberately not pinned as expected behaviour: the hub's
 * `normalizePromotionRecord` projects a fixed field set and therefore drops
 * `relocatedTo`/`relocatedByMission`, so the in-process view used by the Rooms hub
 * does not carry the current location even though the verifier reads it. Recorded in
 * MB-009's City verification report §7 rather than asserted here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROMOTIONS_DIR = join(REPO, 'apps', 'rooms', 'promotions');

async function records() {
  const files = (await readdir(PROMOTIONS_DIR)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(files.map(async (file) => [file, JSON.parse(await readFile(join(PROMOTIONS_DIR, file), 'utf8'))]));
}

test('a relocated promotion keeps its historical target and names its authority', async () => {
  const relocated = [];
  for (const [file, record] of await records()) {
    if (record.relocatedTo === undefined) continue;
    relocated.push(file);

    assert.equal(typeof record.relocatedTo, 'string', `${file}: relocatedTo must be a string`);
    assert.ok(record.relocatedTo.startsWith('city/'), `${file}: relocatedTo must live under city/`);
    assert.ok(
      typeof record.relocatedByMission === 'string' && record.relocatedByMission.trim() !== '',
      `${file}: a relocation must name the Mission that authorised it`,
    );
    assert.notEqual(
      record.relocatedTo,
      record.targetCityPath,
      `${file}: targetCityPath is the historical landing point and must not be rewritten to the new location`,
    );
    assert.ok(
      existsSync(join(REPO, record.relocatedTo)),
      `${file}: the relocated module must exist at ${record.relocatedTo}`,
    );
    assert.equal(
      existsSync(join(REPO, record.targetCityPath)),
      false,
      `${file}: the historical path should no longer exist, otherwise this is not a relocation`,
    );
  }

  assert.deepEqual(
    relocated,
    ['theme-builder-lab.json', 'theme-engine-lab.json', 'theme-package-lab.json'],
    'the three theme waves are the records MB-009 relocated, and the relocation mechanism must not go unused',
  );
});

test('every promotion record still names a landing point under city/', async () => {
  for (const [file, record] of await records()) {
    assert.ok(
      typeof record.targetCityPath === 'string' && record.targetCityPath.startsWith('city/'),
      `${file}: targetCityPath must be a city path`,
    );
  }
});
