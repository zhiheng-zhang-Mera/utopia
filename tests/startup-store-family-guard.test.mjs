// THE STARTUP-STORE FAMILY, GUARDED IN ONE PLACE.
//
// One unusable file store must never be able to stop a City from starting, and this programme has now found that shape
// FIVE times in five different modules - the REX-801 experiment registry, the capability-bridge theme artifacts, the
// WBC-604 execution profile, the REX-803 campaign runner, and the REX-804 fault controller - plus two instances that do
// not brick but mislead (the canonical store's undiagnosed refusal and the join store's silent durability loss). Each
// was repaired where it was found, and each repair shipped with its own module's probe; what never existed was a single
// guard over the FAMILY, which is why the sixth instance was always going to land silently.
//
// This file is that guard. It is deliberately about the shape rather than about any one module: a FILE where a module
// needs a DIRECTORY, and the inverse. Adding a new startup store without handling the shape fails here.
//
// Every case states what its failure means, and the cases that pin KNOWN behaviour say so in as many words - a guard
// that quietly accepts a defect is worse than no guard, because it looks like coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {createExecutionProfileController, PROFILE_CODES} from '../services/dev-gateway/execution-profile.mjs';
import {createJoinRequests} from '../services/dev-gateway/join.mjs';

/** Every store the City touches while it is being constructed. A new one belongs in this list. */
const STARTUP_STORES = [
  ['theme-packages (capability-bridge artifacts)', 'theme-packages'],
  ['research (REX-801 registry parent)', 'research'],
  ['research/experiments (REX-801 registry)', join('research', 'experiments')],
  ['research/campaigns (REX-803 campaign receipts)', join('research', 'campaigns')],
  ['research/faults (REX-804 fault receipts)', join('research', 'faults')],
  ['monitor (MON-903 decision store)', 'monitor'],
  ['research-trace (REX-802 collector)', 'research-trace'],
];
const HEALTHY = ['research/experiments', 'research/campaigns', 'research/faults', 'monitor', 'research-trace', 'theme-packages'];

const withCity = async (prepare, fn) => {
  const dir = await mkdtemp(resolve('.scratch-store-family-'));
  let app = null;
  try {
    for (const pre of HEALTHY) await mkdir(join(dir, pre), {recursive: true}).catch(() => {});
    if (prepare) await prepare(dir);
    app = await createGateway({dir, port: 0, token: 'family-owner', nodeToken: 'family-node', roomsDisabled: true});
    return await fn({app, dir});
  } finally {
    await app?.close().catch(() => {});
    await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}).catch(() => {});
  }
};

test('SHAPE A: a file where a startup store needs a directory cannot stop the City', async t => {
  for (const [label, relative] of STARTUP_STORES) {
    await t.test(label, async () => {
      const dir = await mkdtemp(resolve('.scratch-store-family-'));
      let app = null;
      try {
        for (const pre of HEALTHY) await mkdir(join(dir, pre), {recursive: true}).catch(() => {});
        await rm(join(dir, relative), {recursive: true, force: true}).catch(() => {});
        await writeFile(join(dir, relative), 'a file where a directory belongs');
        // If this throws, one stray file has taken the whole City down: tasks, nodes, rooms and execution paths all
        // unavailable because one capability could not make a directory.
        app = await createGateway({dir, port: 0, token: 'family-owner', nodeToken: 'family-node', roomsDisabled: true});
        const health = await(await fetch(`${app.url}/api/v0/health`, {headers: {Authorization: 'Bearer family-owner', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'}})).json();
        assert.ok(health.components.gateway.state === 'READY', `${label}: the City started but does not report itself serving`);
      } finally {
        await app?.close().catch(() => {});
        await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}).catch(() => {});
      }
    });
  }
});

test('SHAPE B: the canonical store is the ONE case where refusing to start is correct, and it says why', async () => {
  const dir = await mkdtemp(resolve('.scratch-store-family-'));
  let app = null;
  try {
    await mkdir(join(dir, 'city.sqlite'), {recursive: true});
    let thrown = null;
    try { app = await createGateway({dir, port: 0, token: 'family-owner', nodeToken: 'family-node', roomsDisabled: true}); }
    catch (error) { thrown = error; }
    // PINNED AS CORRECT: a City without its canonical store has no task truth, so bricking here is the right decision
    // and must not be "repaired" into degradation. What is asserted is that the refusal is DIAGNOSABLE - the current
    // message names the database but not the reason, which is defect F-1 in the family record, still open by choice.
    assert.ok(thrown, 'a directory where the canonical database belongs must stop the City');
    assert.match(String(thrown.message), /database|city\.sqlite/i, `the refusal must name what it could not open: ${thrown.message}`);
  } finally {
    await app?.close().catch(() => {});
    await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}).catch(() => {});
  }
});

test('SHAPE B: an unusable join store does not stop the City, and the request still answers', async () => {
  // PINNED KNOWN BEHAVIOUR, not a desired one: join.mjs persists deliberately silently (its own comment calls
  // persistence "a convenience for a City restart, not a correctness requirement"), so a request succeeds in memory
  // while nothing reaches the disk. That is defect F-2 in the family record, reported and not repaired here. This case
  // exists so that if the behaviour CHANGES it changes on purpose, and so the silent loss is not mistaken for coverage.
  await withCity(async dir => { await mkdir(join(dir, 'join-requests.json'), {recursive: true}); }, async ({app}) => {
    assert.ok(app.url, 'the City must start with an unusable join store');
  });
  const dir = await mkdtemp(resolve('.scratch-store-family-'));
  try {
    const target = join(dir, 'join-requests.json');
    await mkdir(target, {recursive: true});
    const store = createJoinRequests({file: target, credential: 'owner-credential-value', clock: () => Date.now()});
    const record = store.request({displayName: 'family guard', platform: 'windows', claim: 'c'.repeat(32)});
    assert.ok(record, 'the in-memory path keeps working');
    assert.ok((await import('node:fs')).statSync(target).isDirectory(), 'and nothing was written over the trap, which is the silent part');
  } finally { await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}).catch(() => {}); }
});

test('SHAPE B: a profile the City cannot persist is refused, and the running profile does not move', async () => {
  // This is defect F-3: the module's own rule 2 promises "a failed activation leaves the CURRENT profile in place ...
  // it never half-switches", and the original code assigned the profile BEFORE persisting it, so a store failure
  // produced exactly the half-switch the rule forbids. On this branch the repair is present and the guard is green; on
  // main before it, this assertion fails with `actual STANDARD_DEVICES -> WORKER_POOL`.
  const dir = await mkdtemp(resolve('.scratch-store-family-'));
  try {
    await mkdir(join(dir, 'execution-profile.json'), {recursive: true});
    const controller = createExecutionProfileController({dir, readinessOf: () => 'READY'});
    const before = controller.profile();
    let thrown = null;
    try { controller.change('WORKER_POOL'); } catch (error) { thrown = error; }
    assert.ok(thrown, 'a change the City cannot persist must be refused');
    assert.equal(thrown.code, PROFILE_CODES.STORE_UNAVAILABLE, 'and typed, not a raw filesystem errno');
    assert.equal(controller.profile(), before, 'the running profile must be exactly where it was');
  } finally { await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}).catch(() => {}); }
});

test('CONTROL: with every store healthy the City starts, serves and reports itself healthy', async () => {
  // Without this the SHAPE A loop could pass by the City refusing to run at all in some other way.
  await withCity(null, async ({app}) => {
    const health = await(await fetch(`${app.url}/api/v0/health`, {headers: {Authorization: 'Bearer family-owner', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'}})).json();
    // `rooms` is NOT asserted: this fixture disables the Room Hub on purpose, and a disabled hub legitimately reports
    // UNAVAILABLE. Asserting it here would be asserting the fixture rather than the City.
    assert.equal(health.components.gateway.state, 'READY');
    const created = await(await fetch(`${app.url}/api/v0/tasks`, {method: 'POST', headers: {Authorization: 'Bearer family-owner', 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'}, body: JSON.stringify({type: 'WAIT'})})).json();
    assert.ok(created.id, 'the control City must actually serve');
  });
});
