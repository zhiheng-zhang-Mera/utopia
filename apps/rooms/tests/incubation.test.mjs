/**
 * Stage B — incubation lifecycle and promotion records.
 *
 * Proves the lifecycle contract of MECH ROOM PACK §5: the ten local rooms stay
 * LOCAL_PRODUCT, retired rooms leave the active catalog, incubating rooms carry
 * donor metadata, and promotion records are validated and cross-checked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALL_ROOMS,
  RETIRED_LIFECYCLES,
  ROOMS,
  ROOM_LIFECYCLES,
  findActiveRoom,
  findRoom,
  incubatingRooms,
  lifecycleDefaults,
  persistentRooms,
  roomIncubationMetadata,
} from '../hub/manifest.mjs';
import {
  PromotionRecordError,
  crossCheckPromotions,
  loadPromotionRecords,
  normalizePromotionRecord,
} from '../hub/promotions.mjs';
import { startTestHub } from './harness.mjs';

const DONOR_COMMIT = 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b';

test('all ten local rooms are LOCAL_PRODUCT and carry null donor metadata', () => {
  const localRooms = ROOMS.filter((room) => room.lifecycle === 'LOCAL_PRODUCT');
  assert.equal(localRooms.length, 10, 'the ten local product rooms are unchanged');
  for (const room of localRooms) {
    assert.ok(ROOM_LIFECYCLES.includes(room.lifecycle), `${room.id} lifecycle is known`);
    assert.equal(room.donorRepository, null, `${room.id} has no donor repository`);
    assert.equal(room.donorCommit, null, `${room.id} has no donor commit`);
    assert.equal(room.targetCityPath, null, `${room.id} has no city target`);
    assert.deepEqual(room.donorSourcePaths, [], `${room.id} has no donor source paths`);
  }
  assert.equal(persistentRooms().length, 7, 'the seven durable rooms are unchanged');
  assert.equal(findActiveRoom('knowledge').id, 'knowledge');
  assert.equal(findRoom('knowledge').lifecycle, 'LOCAL_PRODUCT');
  assert.equal(findActiveRoom('nope'), null);
});

test('every incubating room declares a full donor and promotion contract', () => {
  const incubating = incubatingRooms();
  assert.ok(incubating.length >= 1, 'at least one donor room is incubating');
  for (const room of incubating) {
    assert.ok(room.targetCityPath?.startsWith('city/'), `${room.id} targets a city path`);
    assert.match(room.donorRepository ?? '', /^[\w.-]+\/[\w.-]+$/, `${room.id} names a donor repository`);
    assert.match(room.donorCommit ?? '', /^[0-9a-f]{40}$/i, `${room.id} pins a full donor commit`);
    assert.ok(room.donorSourcePaths.length > 0, `${room.id} records the copied donor files`);
    assert.deepEqual(Object.keys(roomIncubationMetadata(room)).sort(), [
      'donorCommit',
      'donorRepository',
      'donorSourcePaths',
      'id',
      'label',
      'lifecycle',
      'targetCityPath',
    ]);
  }
});

test('lifecycle defaults and metadata projection follow the §5.2 contract', () => {
  assert.deepEqual(lifecycleDefaults(), {
    lifecycle: 'LOCAL_PRODUCT',
    targetCityPath: null,
    donorRepository: null,
    donorCommit: null,
    donorSourcePaths: [],
  });
  const donorRoom = {
    id: 'demo-lab',
    label: 'Demo Lab',
    ...lifecycleDefaults({
      lifecycle: 'INCUBATING',
      targetCityPath: 'city/02-engineering/02-worker-gateway/demo',
      donorRepository: 'zhiheng-zhang-Mera/DS-Hns',
      donorCommit: DONOR_COMMIT,
      donorSourcePaths: ['app/extensions/mega/skills/skill-format.js'],
    }),
  };
  assert.deepEqual(roomIncubationMetadata(donorRoom), {
    id: 'demo-lab',
    label: 'Demo Lab',
    lifecycle: 'INCUBATING',
    targetCityPath: 'city/02-engineering/02-worker-gateway/demo',
    donorRepository: 'zhiheng-zhang-Mera/DS-Hns',
    donorCommit: DONOR_COMMIT,
    donorSourcePaths: ['app/extensions/mega/skills/skill-format.js'],
  });
});

test('a promoted room leaves the active catalog but stays known to Git history', () => {
  const promoted = {
    id: 'skill-intake-lab',
    label: 'Skill Intake Lab',
    number: '11',
    zh: '技能接入实验室',
    summary: 'Incubated skill intake core.',
    dataFile: null,
    initialData: null,
    tags: ['incubator'],
    lifecycle: 'PROMOTED',
    targetCityPath: 'city/02-engineering/02-worker-gateway/skill-intake',
    donorRepository: 'zhiheng-zhang-Mera/DS-Hns',
    donorCommit: DONOR_COMMIT,
    donorSourcePaths: ['app/extensions/mega/skills/skill-format.js'],
  };
  const all = [...ALL_ROOMS, promoted];
  const active = all.filter((room) => !RETIRED_LIFECYCLES.includes(room.lifecycle));
  assert.equal(active.length, ALL_ROOMS.length, 'the promoted room is not active');
  assert.ok(all.some((room) => room.id === 'skill-intake-lab'), 'it is still known');
});

test('promotion records are validated and rejected when malformed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rooms-promotions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const good = {
    roomId: 'skill-intake-lab',
    acceptedRoomCommit: '0123456789abcdef0123456789abcdef01234567',
    promotedAtCommit: 'fedcba9876543210fedcba9876543210fedcba98',
    targetCityPath: 'city/02-engineering/02-worker-gateway/skill-intake',
    donor: {
      repository: 'zhiheng-zhang-Mera/DS-Hns',
      commit: DONOR_COMMIT,
      sourcePaths: ['app/extensions/mega/skills/skill-format.js'],
    },
    status: 'PROMOTED',
  };
  await writeFile(join(dir, 'skill-intake-lab.json'), JSON.stringify(good), 'utf8');
  const records = await loadPromotionRecords(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].roomId, 'skill-intake-lab');
  assert.equal(records[0].file, 'skill-intake-lab.json');
  assert.equal(records[0].donor.commit, DONOR_COMMIT);

  const bad = [
    { ...good, roomId: '' },
    { ...good, targetCityPath: 'apps/rooms/rooms/skill-intake-lab' },
    { ...good, status: 'ACTIVE' },
    { ...good, acceptedRoomCommit: 'not-a-sha' },
    { ...good, donor: { repository: 'x', commit: 'nope' } },
    { ...good, donor: 'DS-Hns' },
  ];
  for (const record of bad) {
    assert.throws(() => normalizePromotionRecord(record), PromotionRecordError, JSON.stringify(record).slice(0, 60));
  }
  assert.throws(() => normalizePromotionRecord([]), PromotionRecordError);

  await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8');
  await assert.rejects(() => loadPromotionRecords(dir), PromotionRecordError);
});

test('promotion cross-checks catch an unknown room, an active room and a path mismatch', () => {
  const record = normalizePromotionRecord({
    roomId: 'skill-intake-lab',
    acceptedRoomCommit: '0123456789abcdef0123456789abcdef01234567',
    promotedAtCommit: 'fedcba9876543210fedcba9876543210fedcba98',
    targetCityPath: 'city/02-engineering/02-worker-gateway/skill-intake',
    donor: { repository: 'zhiheng-zhang-Mera/DS-Hns', commit: DONOR_COMMIT, sourcePaths: [] },
    status: 'PROMOTED',
  }, 'skill-intake-lab.json');

  const promotedRoom = {
    id: 'skill-intake-lab',
    lifecycle: 'PROMOTED',
    targetCityPath: 'city/02-engineering/02-worker-gateway/skill-intake',
  };
  assert.deepEqual(crossCheckPromotions([{ file: 'skill-intake-lab.json', ...record }], [promotedRoom], []), []);

  const unknown = crossCheckPromotions([{ file: 'x.json', ...record }], [], []);
  assert.equal(unknown.length, 1);
  assert.match(unknown[0], /not a known room/);

  const stillActive = crossCheckPromotions([{ file: 'x.json', ...record }], [promotedRoom], [promotedRoom]);
  assert.match(stillActive.join(' '), /still in the active catalog/);

  const wrongLifecycle = crossCheckPromotions(
    [{ file: 'x.json', ...record }],
    [{ ...promotedRoom, lifecycle: 'INFERRED' }],
    [],
  );
  assert.match(wrongLifecycle.join(' '), /expected PROMOTED/);

  const mismatch = crossCheckPromotions(
    [{ file: 'x.json', ...record }],
    [{ ...promotedRoom, targetCityPath: 'city/elsewhere' }],
    [],
  );
  assert.match(mismatch.join(' '), /does not match the manifest/);
});

test('hub exposes lifecycle metadata and the promotion record set', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const catalog = await hub.api('GET', '/local-rooms/v1/rooms');
  assert.equal(catalog.status, 200);
  const localRooms = catalog.payload.rooms.filter((room) => room.lifecycle === 'LOCAL_PRODUCT');
  assert.equal(localRooms.length, 10);
  for (const room of localRooms) {
    assert.equal(room.targetCityPath, null);
    assert.equal(room.donorRepository, null);
    assert.equal(room.donorCommit, null);
    assert.deepEqual(room.donorSourcePaths, []);
  }
  const incubating = catalog.payload.rooms.filter((room) => room.lifecycle === 'INCUBATING');
  assert.ok(incubating.length >= 1, 'the incubating donor room is exposed');
  for (const room of incubating) {
    assert.ok(room.targetCityPath.startsWith('city/'), `${room.id} exposes its city target`);
    assert.ok(room.donorCommit.length === 40, `${room.id} exposes its donor commit`);
  }

  const promotions = await hub.api('GET', '/local-rooms/v1/promotions');
  assert.equal(promotions.status, 200);
  assert.equal(promotions.payload.total, 0, 'no promotion has happened yet');
  assert.equal(promotions.payload.consistent, true);
  assert.deepEqual(promotions.payload.promotions, []);

  const health = await hub.api('GET', '/health');
  assert.equal(health.payload.rooms.length, catalog.payload.rooms.length, 'health and the catalog agree on the room set');
});
