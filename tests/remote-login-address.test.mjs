import test from 'node:test';
import assert from 'node:assert/strict';
import { inviteForExchange, openDeviceSession } from '../apps/client/device-enrollment.mjs';

test('native and browser invites retain the target address rather than falling back to this host', () => {
  const params = new URLSearchParams({ v: '1', host: 'https://city.example.test', city: 'remote-city', session: 'session-a', secret: 'one-time-secret' });
  const native = 'utopia://pair?' + params;
  assert.equal(inviteForExchange(native)?.host, 'https://city.example.test');
  assert.equal(inviteForExchange('https://city.example.test/?pair=' + encodeURIComponent(params.toString()))?.host, 'https://city.example.test');
  assert.equal(inviteForExchange('https://city.example.test/#pair=' + encodeURIComponent(native))?.host, 'https://city.example.test');
  assert.equal(inviteForExchange('utopia://pair?' + new URLSearchParams({ ...Object.fromEntries(params), host: 'http://user:password@city.example.test' })), null);
});

test('remote reconnect stays on the recorded origin and rejects a different City response', async () => {
  const record = { endpoint: 'https://city.example.test', cityId: 'remote-city', installationId: 'install-a', instanceId: 'instance-a', credentialId: 'credential-a', credentialSecret: 'secret-a' };
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push(url); return { ok: true, json: async () => ({ cityId: 'another-city', credential: 'sess:wrong-city' }) }; };
  await assert.rejects(openDeviceSession(record, { fetchImpl }), e => e.code === 'CITY_IDENTITY_MISMATCH');
  assert.deepEqual(calls, ['https://city.example.test/api/v0/device/session']);
});
