import test from 'node:test';
import assert from 'node:assert/strict';
import { browseNearby, browseBluetooth } from '../services/dev-gateway/nearby.mjs';
import { encodeBleAdvertisement } from '../platform/windows/ble.mjs';

test('mDNS tries reachable advertised addresses instead of trusting lexical order', async () => {
  const attempts = [];
  const result = await browseNearby({ timeoutMs: 10, bonjourFactory: () => ({
    find(options, callback) {
      callback({ name: 'Utopia multi NIC', host: 'utopia-peer.local', addresses: ['169.254.1.2', '192.168.1.25'], port: 4310, txt: { city: 'peer-city' } });
      return { on() {}, stop() {} };
    }, destroy() {},
  }), fetchImpl: async url => {
    attempts.push(url);
    if (!url.startsWith('http://192.168.1.25:4310/')) throw Error('unreachable NIC');
    return { ok: true, json: async () => ({ cityId: 'peer-city', displayName: 'Nearby PC' }) };
  } });
  assert.equal(result.candidates.length, 1, 'one dead NIC must not hide a reachable City');
  assert.equal(result.candidates[0].address, '192.168.1.25');
  assert.ok(attempts.length > 0);
});

test('a multicast browse error is unavailable, not a successful empty search', async () => {
  const result = await browseNearby({ timeoutMs: 10, bonjourFactory: () => ({ find() { throw Error('no multicast interface'); }, destroy() {} }) });
  assert.equal(result.unavailable, true);
});

test('Bluetooth scanning decodes the existing Android locator and reports unsupported hosts', async () => {
  const ble = await import('../platform/windows/ble.mjs');
  assert.equal(typeof ble.decodeBleAdvertisement, 'function', 'the Web gateway needs the same locator decoder as Android');
  const endpoint = ble.decodeBleAdvertisement(encodeBleAdvertisement('192.168.1.25', 4310));
  assert.equal(endpoint, 'http://192.168.1.25:4310');
  assert.equal(ble.decodeBleAdvertisement(Buffer.alloc(23)), null);
  assert.equal(ble.decodeBleAdvertisement(Buffer.alloc(22)), null);
  const result = await ble.scanBle({ platform: 'linux' });
  assert.equal(result.unavailable, true);
  assert.equal(result.reason, 'WINDOWS_API_UNAVAILABLE');
});

test('Bluetooth discovery retains the default HTTP port and verifies the endpoint identity', async () => {
  const result = await browseBluetooth({ scan: async () => ({ endpoints: ['http://192.168.1.25:80', 'http://192.168.1.25:80'] }), fetchImpl: async () => ({ ok: true, json: async () => ({ cityId: 'port80-city', displayName: 'Nearby PC' }) }) });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].port, 80);
  assert.equal(result.candidates[0].cityId, 'port80-city');
});
