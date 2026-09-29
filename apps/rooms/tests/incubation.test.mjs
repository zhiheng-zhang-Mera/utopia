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
  // A donor room is either still incubating or already promoted; both must carry
  // the full §5.2 contract, and neither may be a plain LOCAL_PRODUCT room.
  const donorRooms = ALL_ROOMS.filter((room) => room.lifecycle !== 'LOCAL_PRODUCT');
  assert.ok(donorRooms.length >= 1, 'the pack knows at least one donor room');
  for (const room of donorRooms) {
    assert.ok(['INCUBATING', 'ACCEPTED_LOCAL', 'PROMOTION_CANDIDATE', 'PROMOTED', 'REJECTED'].includes(room.lifecycle), `${room.id} lifecycle ${room.lifecycle}`);
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
  for (const room of incubatingRooms()) {
    assert.equal(room.lifecycle, 'INCUBATING', `${room.id} is still being proved`);
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
  const promoted = ALL_ROOMS.find((room) => room.id === 'skill-intake-lab');
  assert.ok(promoted, 'the promoted room is still known to the pack');
  assert.equal(promoted.lifecycle, 'PROMOTED');
  assert.ok(RETIRED_LIFECYCLES.includes(promoted.lifecycle), 'PROMOTED is a retired lifecycle');
  assert.ok(!ROOMS.some((room) => room.id === promoted.id), 'it serves no live surface');
  assert.equal(promoted.targetCityPath, 'city/02-engineering/02-worker-gateway/skill-intake', 'its city target is recorded');
  assert.ok(ALL_ROOMS.length > ROOMS.length, 'the pack knows more rooms than it serves');

  // D5 was promoted into the same city module D1 already owns: two incubator rooms,
  // one module, and the retired rooms are both out of the active catalog
  const d5 = ALL_ROOMS.find((room) => room.id === 'skill-discovery-lab');
  assert.ok(d5, 'the D5 room is still known to the pack');
  assert.equal(d5.lifecycle, 'PROMOTED');
  assert.equal(d5.targetCityPath, promoted.targetCityPath, 'D5 targets the module D1 owns');
  assert.deepEqual(d5.donorSourcePaths, [
    'app/extensions/mega/skills/skill-source.js',
    'app/extensions/mega/skills/skill-catalog.js',
  ]);
  assert.ok(!ROOMS.some((room) => room.id === d5.id), 'it serves no live surface either');
  assert.ok(!incubatingRooms().some((room) => room.id === d5.id), 'a promoted room is never still being proved');

  // D6 was promoted into the theme engine module D2 already owns, so the same
  // one-module-two-rooms shape appears a second time and both rooms stay retired
  const d2 = ALL_ROOMS.find((room) => room.id === 'theme-engine-lab');
  const d6 = ALL_ROOMS.find((room) => room.id === 'theme-package-lab');
  assert.ok(d2 && d6, 'both theme rooms are still known to the pack');
  assert.equal(d6.lifecycle, 'PROMOTED');
  assert.equal(d2.lifecycle, 'PROMOTED');
  assert.equal(d6.targetCityPath, d2.targetCityPath, 'D6 targets the module D2 owns');
  assert.equal(d6.targetCityPath, 'city/11-entertainment/01-entertainment-centre/theme-engine');
  assert.deepEqual(d6.donorSourcePaths, [
    'app/extensions/mega/theme/contract.js',
    'app/extensions/mega/theme/surface.js',
    'app/extensions/mega/theme/validator.js',
    'app/extensions/mega/theme/asset-factory.js',
  ]);
  assert.ok(!ROOMS.some((room) => room.id === d6.id), 'it serves no live surface either');
  assert.ok(!incubatingRooms().some((room) => room.id === d6.id), 'a promoted room is never still being proved');
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
  assert.ok(
    !catalog.payload.rooms.some((room) => room.lifecycle === 'PROMOTED'),
    'a promoted room is not part of the served catalog',
  );

  const promotions = await hub.api('GET', '/local-rooms/v1/promotions');
  assert.equal(promotions.status, 200);
  assert.ok(promotions.payload.total >= 1, 'promotions are recorded');
  assert.equal(promotions.payload.consistent, true, JSON.stringify(promotions.payload.problems));
  for (const record of promotions.payload.promotions) {
    assert.equal(record.status, 'PROMOTED', `${record.roomId} is recorded as promoted`);
    assert.ok(record.targetCityPath.startsWith('city/'), `${record.roomId} resolves to a real city path`);
    assert.match(record.acceptedRoomCommit, /^[0-9a-f]{40}$/, `${record.roomId} accepted commit`);
    assert.match(record.promotedAtCommit, /^[0-9a-f]{40}$/, `${record.roomId} promotion commit`);
    assert.match(record.donor.commit, /^[0-9a-f]{40}$/, `${record.roomId} donor commit`);
    const known = ALL_ROOMS.find((room) => room.id === record.roomId);
    assert.ok(known, `${record.roomId} is still known to the manifest`);
    assert.equal(known.targetCityPath, record.targetCityPath, `${record.roomId} record matches the manifest`);
  }
  const d1 = promotions.payload.promotions.find((record) => record.roomId === 'skill-intake-lab');
  assert.ok(d1, 'the D1 promotion is recorded');
  assert.equal(d1.donor.commit, DONOR_COMMIT);
  const d5 = promotions.payload.promotions.find((record) => record.roomId === 'skill-discovery-lab');
  assert.ok(d5, 'the D5 promotion is recorded');
  assert.equal(d5.donor.commit, DONOR_COMMIT);
  assert.equal(d5.targetCityPath, d1.targetCityPath, 'two rooms may strengthen the same city module');
  assert.notEqual(d5.acceptedRoomCommit, d1.acceptedRoomCommit, 'each room has its own accepted commit');

  const d6 = promotions.payload.promotions.find((record) => record.roomId === 'theme-package-lab');
  assert.ok(d6, 'the D6 promotion is recorded');
  assert.equal(d6.donor.commit, DONOR_COMMIT);
  assert.equal(d6.targetCityPath, 'city/11-entertainment/01-entertainment-centre/theme-engine');
  assert.notEqual(d6.acceptedRoomCommit, d6.promotedAtCommit, 'the accepted room commit is not the promotion commit');

  const health = await hub.api('GET', '/health');
  assert.equal(health.payload.rooms.length, catalog.payload.rooms.length, 'health and the catalog agree on the room set');
});
