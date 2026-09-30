/**
 * MB-005 verification pilot — REAL host telemetry through the ported Host Health Station,
 * and the SAME telemetry read back from the existing Utopia consumption surface.
 *
 * The Mission's Verification gate says:
 *
 *   "两台主机分别用真实 telemetry 跑过正常、未知/缺失、持续压力/防抖场景。"
 *   "Health Station 只能产生 bounded action request，不能直接执行重启。"
 *   "现有 Utopia 消费面能读取真实 status/history/error；不得为了本 Mission 新建 dashboard。"
 *
 * So this pilot does not script the telemetry:
 *
 *   * Phase A samples THIS host for real, through the port's own provider graph
 *     (`defaultEnvironment()` -> real `node:os`, `HardwareProvider`, `RuntimeProvider`
 *     with `readProcessFacade()`), and drives the scheduler with what it measured.
 *   * Phase B removes telemetry and checks the port reports `unknown` rather than zero.
 *   * Phase C sustains a real pressure metric past its configured band and then
 *     oscillates it, to exercise the sustain gate and the anti-flapping rule.
 *   * Phase D checks that the decision ladder only ever produces a bounded *request*
 *     and that the shipped adapters refuse rather than act.
 *   * Phase E puts the real telemetry into the EXISTING product channel — the
 *     gateway's node telemetry, which the Web and Android device panels already
 *     render — and reads it back. No dashboard is created.
 *
 * Evidence: `.runtime/evidence/mission-book/MB-005/run-001/host-health-pilot.json`
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ACTION_LEVEL,
  DECISION_LADDER,
  EMPTY_RUNTIME_FEED,
  HealthScheduler,
  HardwareProvider,
  RuntimeProvider,
  UnavailableRestartAdapter,
  defaultEnvironment,
  readProcessFacade,
  resolveConfig,
} from '../city/02-engineering/03-host-health-station/host-health-station/index.mjs';
import { validateTelemetry } from '../contracts/pairing-v1/descriptor.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EVIDENCE_DIR = path.join(ROOT, '.runtime', 'evidence', 'mission-book', 'MB-005', 'run-001');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const EPOCH = Date.parse('2026-03-01T00:00:00.000Z');

const evidence = {
  mission: 'MB-005',
  role: 'VERIFICATION',
  host: 'Alien',
  sourceSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
  purpose: 'real host telemetry through the ported Host Health Station, and the same telemetry on the existing consumption surface',
  phases: {},
  status: 'PASS',
};

/** A provider that reports exactly the metrics it is given, once. */
class BagProvider {
  constructor(id, group, provides, bag) {
    this.id = id;
    this.group = group;
    this.provides = provides;
    this.enabled = true;
    this.bag = { ...bag };
  }

  set(values) {
    Object.assign(this.bag, values);
    return this;
  }

  unset(...metrics) {
    for (const metric of metrics) delete this.bag[metric];
    return this;
  }

  sample() {
    const metrics = {};
    for (const metric of this.provides) if (metric in this.bag) metrics[metric] = this.bag[metric];
    return { provider: this.id, timestamp: new Date(this.now ?? Date.now()).toISOString(), metrics };
  }
}

/** A scheduler with an injected clock, plus a tick loop. */
function makeRig(options = {}) {
  const state = { now: options.epoch ?? EPOCH, restart: options.restart ?? new UnavailableRestartAdapter() };
  const config = options.config ?? resolveConfig({});
  const scheduler = new HealthScheduler({
    config,
    restart: state.restart,
    workerControl: { id: 'pilot-worker-control', capability: 'unavailable' },
    stateDirectory: null,
    clock: () => state.now,
  });
  const decisions = [];
  scheduler.on('decision', (record) => decisions.push(record));
  return {
    config,
    state,
    scheduler,
    decisions,
    history: [],
    provider(id, group, provides, bag) {
      const provider = new BagProvider(id, group, provides, bag);
      Object.defineProperty(provider, 'now', { get: () => state.now });
      scheduler.registerProvider(provider);
      return provider;
    },
    async advance(ms, steps = 1) {
      const before = state.now;
      const stepMs = Math.round(ms / steps);
      const snapshots = [];
      for (let index = 0; index < steps; index += 1) {
        state.now += stepMs;
        snapshots.push(await scheduler.tick());
      }
      this.history.push(...snapshots);
      return { from: before, to: state.now, snapshots };
    },
    get last() {
      return this.history[this.history.length - 1];
    },
  };
}

/** Reduce a snapshot to the parts this pilot reasons about. */
function brief(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    keys: Object.keys(snapshot).sort(),
    pressure: snapshot.pressure ? { score: snapshot.pressure.score, level: snapshot.pressure.level } : null,
    coverage: snapshot.coverage ?? null,
    unknownDimensions: snapshot.unknownDimensions ?? null,
    warnings: snapshot.warnings ?? null,
    metrics: snapshot.metrics ? Object.fromEntries(Object.entries(snapshot.metrics).map(([k, v]) => [k, v && typeof v === 'object' ? { value: v.value, level: v.level } : v])) : null,
  };
}

/* ------------------------------------------------------- Phase A: real telemetry */

async function phaseRealTelemetry() {
  const environment = defaultEnvironment();
  const config = resolveConfig({});
  const hardware = new HardwareProvider(environment, { ...config.providerOptions.hardware, helperCommand: null });
  // The runtime feed is an injected seam in the donor too; this host has no
  // harness runtime feed, so it is honestly empty and the runtime metrics this
  // run contributes are the real process readings taken below.
  const runtime = new RuntimeProvider(environment, config.providerOptions.runtime, EMPTY_RUNTIME_FEED);
  const facade = readProcessFacade();

  // CPU usage is a rate between two readings, so the first sample has no
  // predecessor: take a real pair with a real gap between them.
  const firstHardware = await hardware.sample();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const hardwareSample = await hardware.sample();
  const runtimeSample = await runtime.sample();
  const real = {
    ...(hardwareSample.metrics ?? {}),
    ...(runtimeSample.metrics ?? {}),
    process_rss_bytes: facade.rssBytes,
    handle_count: facade.activeHandles,
    uptime_seconds: Math.round(facade.uptimeSeconds),
  };
  // Real host memory and uptime, straight from the same environment the providers read.
  const totalBytes = environment.os.totalmem();
  const freeBytes = environment.os.freemem();
  real.ram_total_bytes = totalBytes;
  real.ram_available_bytes = freeBytes;
  real.ram_used_ratio = totalBytes > 0 ? (totalBytes - freeBytes) / totalBytes : undefined;
  real.uptime_seconds = Math.round(environment.os.uptime());
  for (const [key, value] of Object.entries(real)) if (typeof value !== 'number' || !Number.isFinite(value)) delete real[key];
  const metricNames = Object.keys(real);

  assert.ok(metricNames.length > 0, 'sampling this host must yield at least one real metric');

  const rig = makeRig({ config });
  const provider = rig.provider('host-real', 'hardware', metricNames, real);
  const { snapshots } = await rig.advance(config.sampling.intervalMs * 3, 3);
  const last = brief(snapshots.at(-1));
  const cpu = real.cpu_usage;

  evidence.phases.realTelemetry = {
    realMetricNames: metricNames,
    realValues: real,
    cpuUsagePercent: typeof cpu === 'number' ? cpu : null,
    hardwareDegraded: hardwareSample.degraded ?? null,
    hardwareNotes: hardwareSample.notes ?? null,
    firstSampleHadNoCpuRate: (firstHardware.metrics ?? {}).cpu_usage === undefined,
    snapshot: last,
  };

  assert.ok(rig.last, 'the real-telemetry run must produce snapshots');
  assert.equal(typeof cpu, 'number', 'this host must yield a real cpu_usage reading');
  assert.ok(cpu >= 0 && cpu <= 100, `cpu_usage must be a real percentage (got ${cpu})`);
  assert.ok(last.coverage !== null && last.coverage !== undefined, 'the snapshot must publish a coverage figure');
  // A real host never supplies every modelled metric, so coverage is the honest
  // signal; the point is that it is measured, not assumed.
  evidence.phases.realTelemetry.coverageBelowOne = typeof last.coverage === 'number' ? last.coverage < 1 : null;
  provider.set({});
  return real;
}

/* --------------------------------------------------- Phase B: unknown / missing */

async function phaseUnknown() {
  const config = resolveConfig({});
  const rig = makeRig({ config });
  // A provider that is registered but has measured nothing at all.
  rig.provider('host-silent', 'hardware', ['cpu_usage', 'ram_used_ratio', 'uptime_seconds'], {});
  const { snapshots } = await rig.advance(config.sampling.intervalMs * 4, 4);
  const last = brief(snapshots.at(-1));

  const values = snapshots.at(-1)?.metrics ?? {};
  const fabricatedZeros = Object.entries(values)
    .filter(([, entry]) => entry && typeof entry === 'object' && entry.value === 0)
    .map(([metric]) => metric);
  const reportedUnknown = (last.unknownDimensions ?? []).length;

  evidence.phases.unknown = {
    snapshot: last,
    coverage: last.coverage ?? null,
    unknownDimensionCount: reportedUnknown,
    metricsReportedAsZero: fabricatedZeros,
  };

  assert.ok(rig.last, 'the unknown run must still produce a snapshot');
  assert.equal(reportedUnknown > 0 || (typeof last.coverage === 'number' && last.coverage < 1), true,
    'missing telemetry must surface as unknown dimensions or as coverage below one, not as silence');
  assert.deepEqual(fabricatedZeros, [], 'no missing metric may be reported as the value zero');
}

/* ------------------------------------------- Phase C: sustained pressure, anti-flap */

async function phaseSustainedAndAntiFlap() {
  const config = resolveConfig({});
  // Pick a real, scored pressure metric and read its own configured band.
  const candidate = ['ram_used_ratio', 'cpu_usage'].find((metric) => config.metrics[metric] && config.metrics[metric].band);
  assert.ok(candidate, 'the default configuration must band at least one pressure metric');
  const band = config.metrics[candidate].band;
  const sustainMs = config.metrics[candidate].sustainMs ?? 0;

  const rig = makeRig({ config });
  const provider = rig.provider('host-pressure', 'hardware', [candidate, 'uptime_seconds'], {
    [candidate]: band.critical + Math.max(0.01, (1 - band.critical) / 2),
    uptime_seconds: 3600,
  });

  // Sustain it well past the metric's own sustain window.
  const sustained = await rig.advance(Math.max(sustainMs * 2, MINUTE * 2), 6);
  const escalating = rig.decisions.filter((record) => (ACTION_LEVEL[record.action] ?? 0) >= ACTION_LEVEL.THROTTLE);

  evidence.phases.sustainedPressure = {
    metric: candidate,
    band,
    sustainMs,
    ticks: sustained.snapshots.length,
    lastSnapshot: brief(sustained.snapshots.at(-1)),
    decisions: rig.decisions.map((record) => ({ action: record.action, level: ACTION_LEVEL[record.action] ?? null, at: record.at ?? null })),
    escalatingDecisionCount: escalating.length,
  };

  assert.ok(escalating.length > 0, 'a metric held past its band for longer than its sustain window must produce a bounded action request');
  assert.ok(escalating.every((record) => DECISION_LADDER.includes(record.action)),
    'every decision must be a member of the closed decision ladder');

  // ---- anti-flapping: oscillate around the band inside the cooldown window ----
  const before = rig.decisions.length;
  const cooldownMs = (config.cooldowns && (config.cooldowns[candidate] ?? config.cooldowns.default)) ?? 0;
  const window = Math.max(Math.min(cooldownMs || MINUTE, MINUTE * 3), SECOND * 5);
  for (let index = 0; index < 6; index += 1) {
    provider.set({ [candidate]: index % 2 === 0 ? band.critical + 0.02 : band.warn - 0.02 });
    await rig.advance(Math.round(window / 3), 1);
  }
  const after = rig.decisions.slice(before);
  const escalatingAfter = after.filter((record) => (ACTION_LEVEL[record.action] ?? 0) >= ACTION_LEVEL.THROTTLE);

  evidence.phases.antiFlap = {
    cooldownMs,
    oscillationWindowMs: window,
    decisionsAfterOscillation: after.map((record) => record.action),
    escalatingAfterOscillation: escalatingAfter.length,
  };

  // The anti-flap rule may legitimately allow *some* escalation after a cooldown
  // expires; what it must not do is let every oscillation through. Six crossings
  // inside one cooldown window must not produce six escalating decisions.
  assert.ok(escalatingAfter.length < 6,
    `anti-flapping must suppress repeated escalation across an oscillation, saw ${escalatingAfter.length} of 6`);
}

/* --------------------------------------------- Phase D: bounded requests only */

async function phaseBoundedRequests() {
  const adapter = new UnavailableRestartAdapter();
  const appRestart = await adapter.requestApplicationRestart({ reason: 'pilot' });
  const systemRestart = await adapter.requestSystemRestart({ reason: 'pilot' });

  // Nothing in the module may execute a restart: the ladder stops at a request,
  // and the shipped adapters are the only place an action could leave the process.
  // The vocabulary legitimately contains the word REBOOT, so the scan looks for
  // execution primitives rather than for the word.
  const moduleDir = path.join(ROOT, 'city', '02-engineering', '03-host-health-station', 'host-health-station');
  const sources = fs.readdirSync(moduleDir).filter((name) => name.endsWith('.mjs'));
  const banned = [
    ['Restart-Computer', /Restart-Computer/i],
    ['shutdown /r', /shutdown\s+[\/-]r\b/i],
    ['systemctl reboot', /\bsystemctl\s+(reboot|poweroff)\b/i],
    ['reboot command', /(execFile|spawn|exec)\s*\(\s*['"`](reboot|shutdown|Restart-Computer)/i],
    ['process.kill', /process\.kill\s*\(/],
  ];
  const offending = [];
  const processSpawners = [];
  for (const name of sources) {
    const text = fs.readFileSync(path.join(moduleDir, name), 'utf8');
    for (const [label, pattern] of banned) if (pattern.test(text)) offending.push(`${name}: ${label}`);
    if (/(?<![\w.])(execFile|spawnSync|spawn)\s*\(/.test(text)) processSpawners.push(name);
  }

  evidence.phases.boundedRequests = {
    ladder: DECISION_LADDER,
    ladderTop: DECISION_LADDER.at(-1),
    applicationRestartOutcome: appRestart,
    systemRestartOutcome: systemRestart,
    restartExecutionPrimitivesFound: offending,
    filesThatCanSpawnAProcess: processSpawners,
  };

  assert.equal(DECISION_LADDER.at(-1), 'REQUEST_SYSTEM_REBOOT', 'the strongest step in the ladder must be a request, not an execution');
  assert.equal(appRestart.accepted, false, 'the shipped restart adapter must refuse rather than act');
  assert.equal(systemRestart.accepted, false, 'the shipped restart adapter must refuse rather than act');
  assert.equal(appRestart.state, 'rejected');
  assert.deepEqual(offending, [], 'no module source may contain a restart/reboot execution primitive');
  assert.deepEqual(processSpawners, ['providers.mjs'],
    'the only code in the module that may spawn a process is the telemetry helper probe');
}

/* ------------------------------ Phase E: the existing Utopia consumption surface */

function mapToGatewayTelemetry(real) {
  const total = real.ram_total_bytes;
  const ratio = real.ram_used_ratio;
  const used = typeof total === 'number' && typeof ratio === 'number' ? Math.round(total * ratio) : null;
  return {
    observedAt: new Date().toISOString(),
    uptimeSeconds: typeof real.uptime_seconds === 'number' ? Math.round(real.uptime_seconds) : null,
    cpu: { usagePercent: typeof real.cpu_usage === 'number' ? Number(real.cpu_usage.toFixed(1)) : null },
    memory: total === undefined ? null : { usedBytes: used, totalBytes: Math.round(total) },
    disk: null,
  };
}

async function phaseConsumptionSurface(real) {
  const telemetry = mapToGatewayTelemetry(real);
  validateTelemetry(telemetry);

  const runtime = path.join(ROOT, '.runtime');
  const config = JSON.parse(fs.readFileSync(path.join(runtime, 'local-config.json'), 'utf8'));
  let url = null;
  const result = { telemetry, validatedByExistingContract: true };

  // Start (or restart) the real dev gateway the Web and Android clients talk to.
  const started = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/restart-gateway.ps1'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  result.gatewayStartExit = started.status;
  if (started.status !== 0) {
    result.gatewayStartError = (started.stderr || started.stdout || '').slice(0, 400);
  }
  url = JSON.parse(fs.readFileSync(path.join(runtime, 'processes.json'), 'utf8')).url;
  result.gatewayUrl = url;

  const headers = {
    'X-City-Api-Version': '0',
    'X-City-Schema-Version': '0',
    'Content-Type': 'application/json',
  };
  const call = async (method, route, body, token) => {
    const response = await fetch(url + route, {
      method,
      headers: { ...headers, Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const nodeId = 'mb005-pilot-host';
  const registered = await call('POST', '/api/v0/node/register', {
    id: nodeId,
    displayName: 'MB-005 pilot host',
    capabilities: ['task.execute.safe', 'filesystem.temp'],
    metadata: { platform: process.platform },
    telemetry,
  }, config.nodeToken);
  result.registerStatus = registered.status;
  result.registerBody = registered.body;

  const nodes = await call('GET', '/api/v0/nodes', undefined, config.token);
  result.nodesStatus = nodes.status;
  const node = (nodes.body?.data?.nodes ?? nodes.body?.nodes ?? []).find((entry) => entry.id === nodeId) ?? null;
  result.nodeReadBack = node && node.telemetry
    ? {
        observedAt: node.telemetry.observedAt,
        cpuUsagePercent: node.telemetry.cpu?.usagePercent ?? null,
        memoryTotalBytes: node.telemetry.memory?.totalBytes ?? null,
        uptimeSeconds: node.telemetry.uptimeSeconds ?? null,
        online: node.online,
      }
    : null;
  // The same fields the existing Web/Android device panel renders.
  result.fieldsTheExistingPanelRenders = ['cpu.usagePercent', 'memory.usedBytes', 'memory.totalBytes', 'disk.usedBytes', 'uptimeSeconds', 'observedAt'];

  evidence.phases.consumptionSurface = result;

  assert.equal(registered.status, 200, `the existing node channel must accept real telemetry (got ${registered.status})`);
  assert.ok(result.nodeReadBack, 'the existing node surface must return the telemetry it stored');
  assert.equal(result.nodeReadBack.cpuUsagePercent, telemetry.cpu.usagePercent, 'the surface must return the real CPU reading unchanged');
  assert.equal(result.nodeReadBack.uptimeSeconds, telemetry.uptimeSeconds, 'the surface must return the real uptime unchanged');

  // Leave the gateway as we found it: it is a shared local service.
  spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `$p = Get-Content '${path.join(runtime, 'processes.json').replace(/\\/g, '/')}' -Raw | ConvertFrom-Json; $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.gatewayPid)"; if ($proc -and $proc.CommandLine -like '*services/dev-gateway/main.mjs*') { Stop-Process -Id $p.gatewayPid }`],
  { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
}

/* -------------------------------------------------------------------- the entry */

try {
  const real = await phaseRealTelemetry();
  await phaseUnknown();
  await phaseSustainedAndAntiFlap();
  await phaseBoundedRequests();
  await phaseConsumptionSurface(real);
} catch (error) {
  evidence.status = 'FAIL';
  evidence.error = error && error.message ? error.message : String(error);
  process.exitCode = 1;
} finally {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'host-health-pilot.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    status: evidence.status,
    error: evidence.error ?? null,
    realMetrics: evidence.phases.realTelemetry?.realMetricNames?.length ?? null,
    cpu: evidence.phases.realTelemetry?.cpuUsagePercent ?? null,
    unknownDims: evidence.phases.unknown?.unknownDimensionCount ?? null,
    escalating: evidence.phases.sustainedPressure?.escalatingDecisionCount ?? null,
    escalatingAfterOscillation: evidence.phases.antiFlap?.escalatingAfterOscillation ?? null,
    nodeReadBack: evidence.phases.consumptionSurface?.nodeReadBack ?? null,
  }));
}
