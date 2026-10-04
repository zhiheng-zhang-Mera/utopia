// JOIN-502 REVIEW (Alien, second pass under the new connection surface): the BROWSE must be reachable by a client
// that holds no credential, because that is the state a joining PC is in, and the connection screen now lists the
// nearby PCs BEFORE anything is typed.
//
// WHY THIS FILE EXISTS. The first development pass had `/api/v0/join/nearby` authenticated. Every unit test passed,
// because the tests exercised the adapter and the route with a credential. What broke was only visible on a
// disconnected PAGE: the surface's own browse answered 401, so the "your PCs" list could never populate on the very
// screen that needs it. That is the class of defect the second-pass review was for.
//
// THE BOUNDARY IS PINNED IN BOTH DIRECTIONS: the browse is reachable without a credential, and the DECISION routes
// (the request list, approve, reject) are not. A public read that quietly widened into a public write would be a far
// worse defect than the one being repaired.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';

const V = { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const CONTROL = 'review502-second-pass';

const get = async (url, path, credential, headers = V) => {
  const r = await fetch(url + path, { headers: { ...headers, ...(credential ? { Authorization: `Bearer ${credential}` } : {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = async (url, path, body, credential, headers = V) => {
  const r = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers, ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('the browse is reachable WITHOUT a credential, because a joining PC has none', async () => {
  const dir = await mkdtemp(resolve('.scratch-review502b-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: 'review502b-node' });
    const anonymous = await get(app.url, '/api/v0/join/nearby');
    assert.equal(anonymous.status, 200, 'a disconnected surface must be able to list nearby PCs');
    assert.ok(Array.isArray(anonymous.body.nearby), 'and gets a list, empty or not');
    assert.equal(anonymous.body.bounded, true, 'the browse stays bounded in both directions');
    // NOTHING in the browse may read as trust: this is the rule the workbook states in as many words.
    for (const row of anonymous.body.nearby) {
      assert.equal(row.grantsTrust, false, 'a discovered City is never trusted');
      assert.equal(typeof row.cityRef, 'string', 'and it is identified by City identity, not by address alone');
    }
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the DECISION routes stay authenticated: a public read must not widen into a public write', async () => {
  const dir = await mkdtemp(resolve('.scratch-review502b-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: 'review502b-node' });
    assert.equal((await get(app.url, '/api/v0/join/requests')).status, 401, 'the pending-request list is owner information');
    assert.equal((await post(app.url, '/api/v0/join/requests/anything/approve', {})).status, 401, 'approval needs the owner credential');
    assert.equal((await post(app.url, '/api/v0/join/requests/anything/reject', {})).status, 401, 'rejection too');
    // ...and with the credential they are reachable, so the assertions above are about authority, not about a typo.
    assert.equal((await get(app.url, '/api/v0/join/requests', CONTROL)).status, 200);
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the version check still applies to the join routes that are public', async () => {
  const dir = await mkdtemp(resolve('.scratch-review502b-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: CONTROL, nodeToken: 'review502b-node' });
    const bad = { 'X-City-Api-Version': '9', 'X-City-Schema-Version': '9' };
    assert.equal((await get(app.url, '/api/v0/join/nearby', null, bad)).status, 409, 'public does not mean version-blind');
    assert.equal((await get(app.url, '/api/v0/join/info', null, bad)).status, 409);
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});
