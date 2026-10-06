// REX-806 surface probes: the artifact export must be reachable by the Owner and unreachable by a member session, and
// what it returns must be the same thing the module builds - a route that quietly returned something else would make
// every downstream claim about the artifact wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {enrollWithCity, openDeviceSession} from '../apps/client/device-enrollment.mjs';

const V = {'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const api = async (app, path, credential, body) => {
  const response = await fetch(`${app.url}/api/v0/${path}`, {method: body ? 'POST' : 'GET', headers: {...V, ...(credential ? {Authorization: `Bearer ${credential}`} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
  return {status: response.status, body: await response.json().catch(() => null)};
};
// A real member session: the owner mints a pairing session, a device enrolls with it and opens its own session. This is
// the credential kind the research surfaces must refuse, and inventing one would prove nothing.
const enrollMember = async (app, name) => {
  const {body: pairing} = await api(app, 'pairing/session', 'owner-token', {});
  const {record} = await enrollWithCity({endpoint: app.url, invite: {cityId: app.store.cityId, sessionId: pairing.pairingSessionId, method: 'mdns', shortCode: pairing.shortCode}, displayName: name});
  return {...record, ...(await openDeviceSession(record))};
};

const withCity = async fn => {
  const dir = await mkdtemp(resolve('.scratch-rex806-surface-'));
  // A receipt on disk, in the shape the runner writes, so the export has a real source. The route is what these probes
  // cover; the metric derivations themselves are covered by the module probes.
  await mkdir(resolve(dir, 'research', 'campaigns'), {recursive: true});
  await writeFile(resolve(dir, 'research', 'campaigns', 'campaign-5face000-0000-4000-8000-000000000001.json'), JSON.stringify({
    campaignId: 'campaign-5face000-0000-4000-8000-000000000001', scenarioId: 'WAIT', state: 'COMPLETED', reason: 'REPETITIONS_FINISHED',
    seedPolicy: 'derived:seed(campaign,index)', campaignSeed: 'surface', repetitions: 1, warmup: 0, timeout: 30000, limits: {},
    totalRuns: 1, startedAt: 1000, finishedAt: 8000,
    runs: [{index: 0, state: 'MEASURED', reason: null, seed: 7, warmup: false, measured: true, durationMs: 7000, result: {taskRef: 'Q-5face000-0000-4000-8000-000000000001', state: 'COMPLETED', assignedNodeId: 's-worker', result: {waitedMs: 6000}}}],
    context: {experimentId: 'surface-exp', manifestIdentity: 'id', manifest: {topology: 'TWO_HOST_MESH', hosts: ['s-worker'], workers: ['s-worker'], controlSurfaces: ['probe-surface'], repetitions: 1, seedPolicy: 'PER_REPETITION', baseSeed: 1, stopConditions: [], acceptance: {}, softwareRefs: []}, targetDeviceRef: null},
    summary: {planned: 1, accounted: 1, warmup: 0, measured: 1, timedOut: 0, failed: 0, excluded: 0, cancelled: 0, skipped: 0, interrupted: 0, terminalAccountingComplete: true},
  }, null, 2) + '\n');
  const app = await createGateway({dir, port: 0, token: 'owner-token', nodeToken: 'node-token', roomsDisabled: true});
  try {
    await api(app, 'node/register', 'node-token', {id: 's-worker', displayName: 'S', metadata: {platform: 'reference'}, capabilities: ['task.execute.safe', 'filesystem.temp']});
    return await fn({app, dir});
  } finally {
    await app.close();
    await rm(dir, {recursive: true, force: true});
  }
};

// S1 - the surfaces exist for the owner. A missing export surface would mean the deliverable is a library nobody can use.
test('REX806 S1: the owner can read the artifact export and its preview', async () => {
  await withCity(async ({app}) => {
    const preview = await api(app, 'research/artifacts/preview', 'owner-token');
    assert.equal(preview.status, 200, `preview answered ${preview.status} ${JSON.stringify(preview.body).slice(0, 160)}`);
    assert.ok(Array.isArray(preview.body.preview.metricAvailability), 'the preview must report metric availability');
    const full = await api(app, 'research/artifacts', 'owner-token');
    assert.equal(full.status, 200, `export answered ${full.status} ${JSON.stringify(full.body).slice(0, 160)}`);
    assert.equal(full.body.artifact.manifest.cityId, app.store.cityId, 'the export must name the City it came from');
    assert.equal(full.body.artifact.metrics.length, full.body.artifact.manifest.metricCatalogueSize, 'every named metric must be present');
    assert.ok(Object.keys(full.body.checksums).length > 0, 'the export must carry checksums');
  });
});

// S2 - a member session must be refused. This is the same boundary the trace and fault surfaces enforce.
test('REX806 S2: a member session cannot read the artifact export', async () => {
  await withCity(async ({app}) => {
    const member = await enrollMember(app, 'Probe PC');
    assert.ok(String(member.credential).startsWith('sess:'), 'the probe really holds a member session credential');
    for (const path of ['research/artifacts', 'research/artifacts/preview', 'research/artifacts?format=csv']) {
      const response = await api(app, path, member.credential);
      assert.equal(response.status, 403, `${path} must refuse a member session (answered ${response.status})`);
      assert.equal(response.body.errorCode, 'RESEARCH_OWNER_REQUIRED');
    }
  });
});

// S3 - the CSV surface must be the same CSV the module emits, not a second implementation of it.
test('REX806 S3: the CSV surface matches the module and stays table-ready', async () => {
  await withCity(async ({app}) => {
    const response = await api(app, 'research/artifacts?format=csv', 'owner-token');
    assert.equal(response.status, 200);
    assert.ok(response.body.metricsCsv.startsWith('metric,scope,value,reason,n,provenance'), 'the CSV header is the documented one');
    assert.ok(response.body.metricsCsv.includes('NOT_MEASURED'), 'unavailable metrics must appear in the CSV rather than being omitted');
    assert.ok(response.body.checksums['metrics.csv']?.sha256, 'the CSV must be checksummed too');
  });
});

// S4 - the preview is bounded. A preview that returned the whole dataset would be the export wearing a smaller name.
test('REX806 S4: the preview is bounded and says so', async () => {
  await withCity(async ({app}) => {
    const body = (await api(app, 'research/artifacts/preview?limit=1', 'owner-token')).body;
    assert.ok(body.preview.rows.length <= 1);
    assert.equal(body.preview.rowsShown, Math.min(1, body.preview.rowsTotal));
    assert.ok(!('dataset' in body.preview), 'the preview must not smuggle the full dataset');
  });
});

// S5 - with no campaign held, the export refuses instead of emitting an empty shape that would look like a clean result.
test('REX806 S5: an export with nothing behind it is refused by name', async () => {
  const dir = await mkdtemp(resolve('.scratch-rex806-empty-'));
  const app = await createGateway({dir, port: 0, token: 'owner-token', nodeToken: 'node-token', roomsDisabled: true});
  try {
    const response = await api(app, 'research/artifacts', 'owner-token');
    assert.equal(response.status, 422);
    assert.equal(response.body.errorCode, 'ARTIFACT_NO_SOURCE');
  } finally {
    await app.close();
    await rm(dir, {recursive: true, force: true});
  }
});

test('REX806 S6: the owner download retains the enrolled member identities', async () => {
  await withCity(async ({app}) => {
    const member=await enrollMember(app,'artifact-topology-review');
    const out=await api(app,'research/artifacts','owner-token');
    assert.equal(out.status,200);
    assert.ok(out.body.artifact.topology.members?.includes(member.deviceId));
  });
});

test('REX806 S7: corrupt receipt loss remains visible in full, preview and CSV responses', async () => {
  await withCity(async ({app,dir}) => {
    const broken='campaign-5face000-0000-4000-8000-000000000002.json';
    await writeFile(resolve(dir,'research','campaigns',broken),'{broken');
    const full=await api(app,'research/artifacts','owner-token');
    assert.equal(full.status,200);
    assert.ok(full.body.artifact.failures.sourceReadFailures?.some(x=>x.name===broken&&x.reason==='RECEIPT_UNREADABLE'));
    assert.equal(full.body.artifact.manifest.sourceCoverage?.status,'PARTIAL');
    const preview=await api(app,'research/artifacts/preview','owner-token');
    assert.equal(preview.body.preview.manifest.sourceCoverage?.status,'PARTIAL');
    const csv=await api(app,'research/artifacts?format=csv','owner-token');
    assert.equal(csv.body.sourceCoverage?.status,'PARTIAL');
  });
});

