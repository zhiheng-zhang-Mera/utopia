// Process-level acceptance for the single-machine lifecycle.
//
// The unit-level suite proves the rule through createGateway; this file proves the two things only a real process can
// show: that main.mjs actually wires the lifecycle through to a process exit when the page closes, and that a stored
// host role is ignored unless the start is an online one.
//
// WHY THIS FILE IS NOT IN tests/*.test.mjs
// Starting a real City is a HOST-WIDE act: main.mjs refuses to start while findRunningCities() sees any other
// services/dev-gateway/main.mjs process, and that scan reads the process list, not ports. A file that spawns Cities
// therefore cannot run in parallel with tests that also start Cities: running it inside `pnpm test` made
// tests/host-city-launcher.test.mjs fail on CI with "City did not become ready within 45 seconds" and "Requires a free
// local host reservation", on a runner where those same tests are green at the base commit. The repair is
// serialisation, not evasion: this acceptance runs as its own CI step (`pnpm test:acceptance`) before `pnpm test` in
// the same job, so it still gates the pull request while never overlapping another City. Hiding the spawned process
// from the preflight would have concealed a real violation of the one-City-per-host rule instead of respecting it.
//
// It also needs the host to itself locally, so when a City is already running the file SKIPS with the reason instead
// of pretending to have checked anything - a green suite that did not run is worse than an honest skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {WebSocket} from 'ws';
import {findRunningCities} from '../../services/dev-gateway/host-preflight.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const running = await findRunningCities();
const HOST_BUSY = running.length > 0 ? `a City is already running on this host (${running.map(c => c.endpoint).join(', ')})` : false;

async function startIsolated({lifecycle, coordPort, httpPort, role}) {
  const base = await mkdtemp(resolve('.scratch-lifecycle-e2e-'));
  const stateDir = resolve(base, 'host');
  await writeFile(resolve(base, '.keep'), '');
  const {mkdir} = await import('node:fs/promises');
  await mkdir(stateDir, {recursive: true});
  if (role) await writeFile(resolve(stateDir, 'role.json'), JSON.stringify(role));
  const child = spawn(process.execPath, ['services/dev-gateway/main.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CITY_LIFECYCLE: lifecycle,
      CITY_PAGE_IDLE_MS: '500',
      CITY_COORDINATION_PORT: String(coordPort),
      CITY_PORT: String(httpPort),
      CITY_HOST: '127.0.0.1',
      CITY_ROOMS_DISABLED: '1',
      CITY_DISCOVERY_DISABLED: '1',
      CITY_MANAGE_SERVICES: '0',
      UTOPIA_HOST_STATE_DIR: stateDir,
      UTOPIA_CLIENT_STATE_DIR: resolve(base, 'client'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', d => log.push(String(d)));
  child.stderr.on('data', d => log.push(String(d)));
  const exited = new Promise(yes => child.once('exit', code => yes(code)));
  // Kill first, then WAIT for the process to finish its own shutdown before removing the data directory: the City
  // closes sqlite asynchronously, and an earlier draft of this cleanup raced it into EBUSY on a locked database.
  const cleanup = async () => {
    try { child.kill(); } catch {}
    await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
    for (let i = 0; i < 24; i += 1) {
      try { await rm(base, {recursive: true, force: true}); return; } catch { await new Promise(r => setTimeout(r, 250)); }
    }
    await rm(base, {recursive: true, force: true}).catch(() => {});
  };
  return {child, exited, log, base, stateDir, coordPort, httpPort, cleanup};
}

async function waitForOnline(coordPort) {
  for (let i = 0; i < 240; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${coordPort}/`, {signal: AbortSignal.timeout(500)});
      const record = await r.json();
      if (record.state === 'ONLINE') return record;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

test('E2E 1: the page-tied City process exits when its last page closes', {skip: HOST_BUSY}, async () => {
  const c = await startIsolated({lifecycle: 'page', coordPort: 4390, httpPort: 4402});
  try {
    const record = await waitForOnline(4390);
    assert.ok(record, 'the isolated City must come up: ' + c.log.join(''));
    assert.equal(record.endpoint, 'http://127.0.0.1:4402');
    const token = JSON.parse(await readFile(resolve(record.dataDir, 'local-config.json'), 'utf8')).token;
    const url = `ws://127.0.0.1:4402/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=e2e-page&clientLabel=e2e`;
    const ws = new WebSocket(url, {headers: {Authorization: 'Bearer ' + token}});
    await new Promise((yes, no) => { ws.once('open', yes); ws.once('error', no); });
    ws.close();
    const code = await Promise.race([c.exited, new Promise(r => setTimeout(() => r('STILL-RUNNING'), 6000))]);
    assert.notEqual(code, 'STILL-RUNNING', 'closing the page must end the City process, not leave it behind: ' + c.log.join(''));
    assert.equal(code, 0, 'and it must exit cleanly');
    assert.match(c.log.join(''), /Utopia City closing/);
  } finally { await c.cleanup(); }
});

test('E2E 2: a stored MEMBER role is ignored on a single-machine start and honoured only when going online', {skip: HOST_BUSY}, async () => {
  // A role file that selects membership of a City that is not running here. In single-machine mode this must NOT
  // divert the start: the person asked for their own City.
  const role = {role: 'MEMBER', cityId: '11111111-2222-3333-4444-555555555555', memberEnrollmentFile: resolve(import.meta.dirname, 'no-such-enrollment.json')};
  const offline = await startIsolated({lifecycle: 'page', coordPort: 4391, httpPort: 4403, role});
  try {
    const record = await waitForOnline(4391);
    assert.ok(record, 'the single-machine start must still bring up the LOCAL City: ' + offline.log.join(''));
    assert.equal(record.role, 'PRIMARY', 'the stored MEMBER role must not have been honoured');
    assert.equal(JSON.parse(await readFile(resolve(offline.stateDir, 'role.json'), 'utf8')).role, 'MEMBER', 'the stored role file itself is left alone, not rewritten');
  } finally { await offline.cleanup(); }

  // The same role, going online, must be honoured - that is the act that adjusts the role.
  const online = await startIsolated({lifecycle: 'online', coordPort: 4392, httpPort: 4404, role});
  try {
    const code = await Promise.race([online.exited, new Promise(r => setTimeout(() => r('STILL-RUNNING'), 5000))]);
    const log = online.log.join('');
    const honoured = code !== 'STILL-RUNNING' ? /credential unavailable|identity mismatch|Invalid selected host role/i.test(log) : /Utopia member/.test(log);
    assert.equal(honoured, true, 'an online start must follow the stored role instead of silently starting a primary City: ' + log);
  } finally { await online.cleanup(); }
});

test('E2E 3: a member agent is an online start, so it never becomes a host City of its own', {skip: HOST_BUSY}, async () => {
  // The rule this pins was caught by hosted CI, not here: the launcher spawns a member agent with CITY_MEMBER_FILE and
  // no declared lifecycle, and a predicate that only read CITY_LIFECYCLE made that process start as a PRIMARY City - a
  // host City launched where the caller had deliberately asked for none. The enrollment below names a City that does not
  // exist, so the member agent is EXPECTED to fail; what is asserted is what it refused to become.
  const base = await mkdtemp(resolve('.scratch-member-agent-'));
  const stateDir = resolve(base, 'host');
  const {mkdir} = await import('node:fs/promises');
  await mkdir(stateDir, {recursive: true});
  const enrollmentFile = resolve(base, 'device-enrollment.json');
  await writeFile(enrollmentFile, JSON.stringify({endpoint: 'http://127.0.0.1:9', cityId: '11111111-2222-3333-4444-555555555555', deviceId: 'dev-x', credential: 'not-a-real-credential'}));
  const child = spawn(process.execPath, ['services/dev-gateway/main.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CITY_MEMBER_FILE: enrollmentFile,          // exactly what the launcher sets for a member agent
      CITY_COORDINATION_PORT: '4497',
      CITY_PORT: '4498',
      CITY_HOST: '127.0.0.1',
      CITY_ROOMS_DISABLED: '1',
      CITY_DISCOVERY_DISABLED: '1',
      CITY_MANAGE_SERVICES: '0',
      UTOPIA_HOST_STATE_DIR: stateDir,
      UTOPIA_CLIENT_STATE_DIR: resolve(base, 'client'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', d => log.push(String(d)));
  child.stderr.on('data', d => log.push(String(d)));
  const exited = new Promise(yes => child.once('exit', code => yes(code)));
  try {
    const code = await Promise.race([exited, new Promise(r => setTimeout(() => r('STILL-RUNNING'), 8000))]);
    const output = log.join('');
    const record = await readFile(resolve(stateDir, 'role.json'), 'utf8').then(JSON.parse).catch(() => null);
    assert.notEqual(record?.role, 'PRIMARY', 'a member start must not reserve this host as a PRIMARY City: ' + output);
    assert.doesNotMatch(output, /Utopia Host listening/, 'it must not start a City on this host: ' + output);
    if (code === 'STILL-RUNNING') {
      const listening = await fetch('http://127.0.0.1:4498/api/v0/pairing/info', {headers: {'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'}, signal: AbortSignal.timeout(1500)}).then(() => true).catch(() => false);
      assert.equal(listening, false, 'a member agent must not open this host\'s City port: ' + output);
    } else {
      // It exited. For a City that is not there, exiting is the honest outcome, and the invariant under test is what it
      // refused to BECOME (the two assertions above). The exact code is recorded rather than asserted: a member start
      // with an unreachable City currently exits through the uncaught-error path (1) instead of the launcher's
      // documented 6, which is a real inconsistency noted in the report and not repaired here.
      assert.ok(Number.isInteger(code), 'the member start must exit with a code, got ' + String(code) + ': ' + output);
    }
  } finally {
    try { child.kill(); } catch {}
    await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
    for (let i = 0; i < 24; i += 1) { try { await rm(base, {recursive: true, force: true}); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
  }
});
