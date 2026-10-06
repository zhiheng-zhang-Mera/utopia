// REX-804 reviewer-proposed repair guard (Mech): a receipt this module cannot read must be REPORTED, never fatal.
//
// The opposite-host review found (blocking finding B1) that one unreadable fault receipt made createGateway throw an
// untyped SyntaxError, so the City did not start at all. These two probes are the regression guard for the minimum
// repair carried on this branch. They are deliberately small: the repair is the reader guard, and nothing else about
// the fault semantics, the routes or the UI was changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';

const headers = {Authorization: 'Bearer ctl', 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
// A node credential authenticates the node route family; the control credential authenticates everything else.
const nodeHeaders = {...headers, Authorization: 'Bearer node'};

test('REX804 repair guard: an unreadable fault receipt is reported and never prevents the City from starting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rex804-repair-corrupt-'));
  try {
    await mkdir(join(dir, 'research', 'faults'), {recursive: true});
    await writeFile(join(dir, 'research', 'faults', 'fault-11111111-2222-4333-8444-555555555555.json'), '{not json');
    const app = await createGateway({dir, port: 0, token: 'ctl', nodeToken: 'node', roomsDisabled: true});
    try {
      const health = await fetch(app.url + '/api/v0/health', {headers});
      assert.equal(health.status, 200, 'the City must start with a broken receipt present');
      const listing = await (await fetch(app.url + '/api/v0/research/faults', {headers})).json();
      assert.equal(listing.faults.length, 0, 'a broken receipt is not adopted as a fault');
      assert.deepEqual(listing.broken, [{file: 'fault-11111111-2222-4333-8444-555555555555.json', reason: 'UNREADABLE_RECEIPT'}]);
      // The fault surface still works next to a broken neighbour.
      const registered = await fetch(app.url + '/api/v0/node/register', {method: 'POST', headers: nodeHeaders, body: JSON.stringify({id: 'alpha', displayName: 'alpha', metadata: {platform: 'reference'}, capabilities: ['task.execute.safe', 'filesystem.temp']})});
      assert.equal(registered.status, 200);
      await fetch(app.url + '/api/v0/node/heartbeat', {method: 'POST', headers: nodeHeaders, body: JSON.stringify({id: 'alpha'})});
      const started = await fetch(app.url + '/api/v0/research/faults', {method: 'POST', headers, body: JSON.stringify({kind: 'HEARTBEAT_LOSS', nodeId: 'alpha', durationMs: 50, confirmation: 'FAULT:HEARTBEAT_LOSS:alpha'})});
      assert.equal(started.status, 200, 'a broken neighbouring receipt must not disable injection');
    } finally { await app.close(); }
  } finally { await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}).catch(() => {}); }
});

test('REX804 repair guard: a receipt with no fault identity is reported as broken, not adopted without identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rex804-repair-shapeless-'));
  let app = null;
  try {
    await mkdir(join(dir, 'research', 'faults'), {recursive: true});
    await writeFile(join(dir, 'research', 'faults', 'fault-22222222-2222-4333-8444-555555555555.json'), JSON.stringify({hello: 'world'}));
    app = await createGateway({dir, port: 0, token: 'ctl', nodeToken: 'node', roomsDisabled: true});
    const listing = await (await fetch(app.url + '/api/v0/research/faults', {headers})).json();
    assert.equal(listing.faults.length, 0, 'a receipt with no identity must not become a fault row');
    assert.deepEqual(listing.broken, [{file: 'fault-22222222-2222-4333-8444-555555555555.json', reason: 'RECEIPT_SHAPE_MISMATCH'}]);
  } finally {
    await app?.close();
    await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}).catch(() => {});
  }
});
