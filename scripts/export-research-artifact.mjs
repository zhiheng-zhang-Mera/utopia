// Export a research artifact from a live City's REAL campaigns.
//
// Usage: node scripts/export-research-artifact.mjs [--city http://host:port] [--out <dir>] [--config <path>]
//
// It reads the owner credential from the host reservation and never prints or writes it. Everything the artifact claims
// is derived from records this City actually holds: the campaign receipts, the canonical tasks they produced, the
// experiment registry and the trace records that reference those campaigns. Metrics that cannot be derived from those
// records are exported as NOT_MEASURED with the reason, never as zero.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {buildArtifact, artifactFiles, checksumsFor, NOT_MEASURED} from '../services/dev-gateway/research/artifact.mjs';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const CITY = arg('city', 'http://172.31.12.151:4391');
const OUT = resolve(arg('out', 'D:/utopia-chat/evidence/REX-806/artifact'));
const CONFIG = arg('config', 'C:/ProgramData/Utopia/host/city/local-config.json');

const token = JSON.parse(readFileSync(CONFIG, 'utf8')).token;
const headers = {'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', Authorization: `Bearer ${token}`};
const get = async path => {
  const response = await fetch(`${CITY}/api/v0/${path}`, {headers});
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  return response.json();
};

const city = await get('city');
const list = await get('research/campaigns');
const receipts = [];
for (const entry of list.receipts ?? []) {
  const detail = await get(`research/campaigns/${encodeURIComponent(entry.campaignId)}`);
  if (detail.campaign) receipts.push(detail.campaign);
}
if (receipts.length === 0) {
  console.error('no campaign receipt is readable from this City; an artifact with no real source is not worth exporting');
  // DEFECT REPAIR (measured on Windows): `process.exit(1)` here asserted in libuv - "Assertion failed:
  // !(handle->flags & UV_HANDLE_CLOSING), src/win/async.c" - because the fetch keep-alive handle from the
  // listing above was still closing, so the process exited with 0xC0000409 and a caller could not tell a designed
  // refusal from a crash. Setting the exit code and skipping the export keeps both the message and the code
  // honest. The body below is left at its original indentation on purpose: the diff is the guard, not a re-indent
  // of the whole file.
  process.exitCode = 1;
} else {
const experiments = [];
for (const entry of list.experiments ?? []) {
  const id = entry.experimentId ?? entry;
  try { const detail = await get(`research/experiments/${encodeURIComponent(id)}`); if (detail.experiment) experiments.push(detail.experiment); } catch { /* an unreadable registry row is reported by its absence in rawPointers */ }
}
let traceRecords = [];
try { traceRecords = (await get('research/trace')).trace?.records ?? []; } catch { traceRecords = []; }

const campaignIds = new Set(receipts.map(receipt => receipt.campaignId));
const scopedTrace = traceRecords.filter(record => {
  const refs = record.canonicalRefs ?? {};
  return campaignIds.has(refs.campaignId) || (refs.taskRef && (city.tasks ?? []).some(task => task.id === refs.taskRef));
});

const artifact = buildArtifact({
  cityId: city.cityId,
  generatedAt: new Date().toISOString(),
  environment: {
    cityEndpoint: CITY,
    cityStatus: city.status,
    // The deployment binding is part of the environment because an artifact without it cannot be tied to a revision.
    deployedCandidateObservedBy: 'the operator who deployed it; this exporter reads the City, not the process tree',
    nodeRuntime: process.version,
    platform: process.platform,
  },
  topology: {
    nodes: (city.nodes ?? []).map(node => ({id: node.id, online: node.online === true, sharingEnabled: node.sharingEnabled !== false})),
    controlSurfaces: (city.controlSurfaces ?? []).map(surface => surface.clientRef),
    members: (city.members ?? []).map(member => member.ref ?? member.devicePrincipalId ?? null).filter(Boolean),
  },
  receipts,
  tasks: city.tasks ?? [],
  events: city.events ?? [],
  traceRecords: scopedTrace,
  experiments,
});

const files = artifactFiles(artifact);
const checksums = checksumsFor(files);
mkdirSync(OUT, {recursive: true});
for (const [name, text] of Object.entries(files)) writeFileSync(join(OUT, name), text);
writeFileSync(join(OUT, 'checksums.json'), JSON.stringify(checksums, null, 2) + '\n');

console.log(`artifact    ${artifact.manifest.artifactId}`);
console.log(`city        ${city.cityId}  campaigns=${receipts.length}  runs=${artifact.manifest.runCount}  measured=${artifact.manifest.measuredRuns}`);
console.log(`metrics     reported=${artifact.manifest.metricsReported}  notMeasured=${artifact.manifest.metricsNotMeasured}  of ${artifact.manifest.metricCatalogueSize} named`);
for (const row of artifact.metrics.filter(entry => entry.value !== NOT_MEASURED)) console.log(`  ${row.metric} = ${row.value} (${row.scope}, n=${row.n})`);
console.log(`failures    unmeasured runs=${artifact.failures.unmeasuredRuns.length}  warmup runs=${artifact.failures.warmupRuns.length}  campaign outcomes=${artifact.failures.campaignOutcomes.length} (warmups are NOT failures)`);
const accounting = artifact.manifest.supporting.accounting;
console.log(`accounting  planned=${accounting.planned} accounted=${accounting.accounted} measured=${accounting.measured} undelivered=${accounting.planned - accounting.accounted}${accounting.undeliveredCampaigns.length ? ' from ' + accounting.undeliveredCampaigns.map(entry => `${entry.reason}`).join(',') : ''}`);
console.log(`exclusions  ${artifact.exclusions.length}`);
console.log(`written     ${OUT} (${Object.keys(files).length + 1} files, checksums.json included)`);
}
