/**
 * MB-009 verification probe 閳?the Theme Generate path the existing Web and Android
 * surfaces actually call, exercised through the live dev gateway.
 *
 * The Mission's verification gate is: "閻滅増婀?Web/Android 閸欘垵鐨熼悽銊ф畱 Theme Generate 鐠侯垰绶炵紒褏鐢诲銉ょ稊閿? * 娑撳秴绶遍弬鏉款杻 global apply 閺夈儱鍩楅柅?閸欘垳鏁ら幀?" 閳?the Theme Generate path that Web and Android can
 * already call must keep working, and no global apply may be introduced to fake
 * availability.
 *
 * So this drives the REAL product path the clients use:
 *   GET  /api/v0/capabilities                      -> the theme capability is advertised
 *   POST /api/v0/capabilities/presentation.theme.lab/invoke {operationId:'generate'}
 *   GET  /api/v0/capability-invocations/:id        -> durable record + result
 * and asserts the result carries no global apply.
 *
 * Evidence: `.runtime/evidence/mission-book/MB-009/run-001/theme-generate-probe.json`
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const EVIDENCE_DIR = path.join(ROOT, '.runtime', 'evidence', 'mission-book', 'MB-009', 'run-001');
const runtime = path.join(ROOT, '.runtime');

const evidence = {
  mission: 'MB-009',
  role: 'VERIFICATION',
  host: 'Alien',
  sourceSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
  purpose: 'the existing Theme Generate consumption path, exercised live after the relocation',
  status: 'PASS',
};

const headers = { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json' };

const SHELL = 'powershell.exe';
const reachable = async (url, token) => {
  try {
    const response = await fetch(`${url}/api/v0/health`, { headers: { ...headers, Authorization: `Bearer ${token}` } });
    return response.ok;
  } catch {
    return false;
  }
};

const config = JSON.parse(fs.readFileSync(path.join(runtime, 'local-config.json'), 'utf8'));
const url = JSON.parse(fs.readFileSync(path.join(runtime, 'processes.json'), 'utf8')).url;
evidence.gatewayUrl = url;

// The relocation changes module-level constants inside the gateway process
// (`services/capability-bridge/registry.mjs`), so a gateway that was already running
// would keep serving the pre-relocation registry from memory. Restart it and wait
// for it to answer before probing the product path.
evidence.gatewayWasAlreadyRunning = await reachable(url, config.token);
{
  const started = spawnSync(SHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/restart-gateway.ps1'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  evidence.gatewayStartError = started.error ? started.error.code : null;
  evidence.gatewayStartExit = started.status ?? null;
  if (started.error) evidence.gatewayStartFailureOutput = String(started.error.message).slice(0, 300);
}
let ready = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  if (await reachable(url, config.token)) { ready = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
evidence.gatewayReadyAfterRestart = ready;

const call = async (method, route, body, token) => {
  const response = await fetch(url + route, {
    method,
    headers: { ...headers, Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

try {
  const online = await call('GET', '/api/v0/city', undefined, config.token);
  assert.equal(online.status, 200, 'the gateway must be reachable');
  const catalog = await call('GET', '/api/v0/capabilities', undefined, config.token);
  const theme = (catalog.body?.capabilities ?? catalog.body?.data?.capabilities ?? []).find((c) => c.capabilityId === 'presentation.theme.lab');
  evidence.capability = theme
    ? { capabilityId: theme.capabilityId, bridgeState: theme.bridgeState, moduleRefs: theme.moduleRefs, operations: (theme.operations ?? []).map((o) => o.operationId) }
    : null;
  assert.ok(theme, 'the theme capability must still be advertised after the relocation');
  assert.equal(theme.bridgeState, 'AVAILABLE', `the relocated module must still resolve (got ${theme.bridgeState})`);
  assert.deepEqual(theme.moduleRefs, [{ districtId: '00-foundation', buildingId: '05-control-centre', moduleId: 'theme-engine' }],
    'the advertised module reference must be the relocated path');

  // The exact call apps/web/services.js and the Android ServicesPanel make.
  const generated = await call('POST', '/api/v0/capabilities/presentation.theme.lab/invoke', {
    operationId: 'generate',
    input: { seed: 'mb009-verification', style: 'research', accent: '#4d93f8' },
  }, config.token);
  const invocationId = generated.body?.invocationId ?? generated.body?.data?.invocationId;
  evidence.generate = { status: generated.status, invocationId: invocationId ?? null, rowStatus: generated.body?.status ?? generated.body?.data?.status ?? null, errorCode: generated.body?.errorCode ?? generated.body?.data?.errorCode ?? null };
  assert.equal(generated.status, 200, `theme generate must be accepted (got ${generated.status})`);
  assert.ok(invocationId, 'the invocation must have an id');

  // Poll the durable record the clients read for result/history.
  let detail = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const record = await call('GET', `/api/v0/capability-invocations/${invocationId}`, undefined, config.token);
    const row = record.body?.data ?? record.body;
    if (row && ['COMPLETED', 'FAILED', 'REFUSED'].includes(row.status)) { detail = row; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(detail, 'the invocation must reach a terminal state');
  evidence.invocation = {
    invocationId,
    status: detail.status,
    errorCode: detail.errorCode ?? null,
    resultDigest: detail.resultDigest ?? null,
    resultKeys: detail.result && typeof detail.result === 'object' ? Object.keys(detail.result).sort() : null,
    globalApply: detail.result?.globalApply ?? null,
    validationOk: detail.result?.validation?.ok ?? null,
  };

  assert.equal(detail.status, 'COMPLETED', `theme generate must COMPLETE after the relocation (got ${detail.status}${detail.errorCode ? ` / ${detail.errorCode}` : ''})`);
  assert.ok(detail.resultDigest, 'a completed invocation must carry a result digest');
  assert.equal(detail.result?.globalApply, false, 'no global apply may be introduced to fake availability');
} catch (error) {
  evidence.status = 'FAIL';
  evidence.error = error && error.message ? error.message : String(error);
  process.exitCode = 1;
} finally {
  spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `$p = Get-Content '${path.join(runtime, 'processes.json').replace(/\\/g, '/')}' -Raw | ConvertFrom-Json; $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.gatewayPid)"; if ($proc -and $proc.CommandLine -like '*services/dev-gateway/main.mjs*') { Stop-Process -Id $p.gatewayPid }`],
  { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'theme-generate-probe.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ status: evidence.status, error: evidence.error ?? null, capability: evidence.capability, invocation: evidence.invocation ?? null }));
}
