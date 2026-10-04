import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

test('host reservation is atomic across requested ports and retains the canonical data directory', async () => {
  const registry = await import('../services/dev-gateway/host-city.mjs').catch(() => ({}));
  assert.equal(typeof registry.reserveHostCity, 'function', 'production needs an OS-owned host reservation shared by installations');
  const dir = await mkdtemp(resolve('.scratch-host-registry-'));
  let first, second, recovered;
  try {
    first = await registry.reserveHostCity({ stateDir: dir, requestedDataDir: resolve(dir, 'install-a/.runtime'), coordinationPort: 0 });
    const port = first.coordinationPort;
    await first.publish({ state: 'ONLINE', endpoint: 'http://127.0.0.1:4310', cityId: 'city-a', gatewayPid: process.pid });
    second = await registry.reserveHostCity({ stateDir: dir, requestedDataDir: resolve(dir, 'install-b/.runtime'), coordinationPort: port });
    assert.equal(second.owner, false);
    assert.equal(second.record.cityId, 'city-a');
    assert.equal(second.record.endpoint, 'http://127.0.0.1:4310');
    assert.equal(second.record.dataDir, first.record.dataDir);
    assert.equal('token' in second.record, false, 'coordination exposes metadata, never credentials');
    await first.close(); first = null;
    recovered = await registry.reserveHostCity({ stateDir: dir, requestedDataDir: resolve(dir, 'install-b/.runtime'), coordinationPort: port });
    assert.equal(recovered.owner, true);
    assert.equal(recovered.record.dataDir, second.record.dataDir, 'recovery cannot switch to the second installation database');
  } finally { await first?.close(); await recovered?.close(); await rm(dir, { recursive: true, force: true }); }
});
