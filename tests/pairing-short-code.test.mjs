import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { exchangeShortCode, codeHandoff } from '../apps/web/short-code.js';
const V = { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };

test('short code preserves identity pinning, reports lockout, and never sends a code to the wrong City', async () => {
  const dir = await mkdtemp(resolve('.scratch-short-code-'));
  const app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'short-owner', nodeToken: 'short-node', roomsDisabled: true });
  const posts = [];
  const fetchImpl = (path, options) => { if (options.method === 'POST') posts.push(path); return fetch(app.url + path, options); };
  try {
    const session = await fetch(app.url + '/api/v0/pairing/session', { method: 'POST', headers: { ...V, Authorization: 'Bearer short-owner', 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json());
    await assert.rejects(exchangeShortCode({ code: session.shortCode, cityRef: 'wrong-city', fetchImpl }), e => e.status === 409);
    assert.deepEqual(posts, [], 'identity mismatch must not even attempt the code');
    const wrong = session.shortCode === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await assert.rejects(exchangeShortCode({ code: wrong, fetchImpl }), e => e.status === 403);
    await assert.rejects(exchangeShortCode({ code: session.shortCode, fetchImpl }), e => e.status === 429, 'a locked session must say locked rather than expired');
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('code handoff carries only a selected City, six digits and the existing transport in a fragment', () => {
  const url = new URL(codeHandoff({ endpoint: 'http://192.168.1.25:4310', cityRef: 'city-a', code: '001234', method: 'ble' }));
  assert.equal(url.search, '');
  const params = new URLSearchParams(new URLSearchParams(url.hash.slice(1)).get('short-pair'));
  assert.equal(params.get('code'), '001234'); assert.equal(params.get('city'), 'city-a'); assert.equal(params.get('method'), 'ble');
  for (const endpoint of ['javascript:alert(1)', 'http://user:password@192.168.1.25', 'http://192.168.1.25/api/', 'http://192.168.1.25/?secret=x']) assert.throws(() => codeHandoff({ endpoint, cityRef: 'city-a', code: '001234' }));
});
