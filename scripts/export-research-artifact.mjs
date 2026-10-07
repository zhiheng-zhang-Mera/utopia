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
// ONE UNREADABLE RECEIPT MUST NOT DESTROY THE WHOLE ARTIFACT. The listing above still names a receipt whose file
// was corrupted, and the detail fetch for it threw at `get`, uncaught - so an export with one healthy campaign and
// one corrupt receipt died with no artifact at all (measured: exit 0xC0000409, uncaught "GET ... answered 500").
// This is the store-guard family's own rule applied to the reader: degrade, report the typed reason, keep serving.
// The loss is named on stderr AND the exit code is non-zero, so a partial artifact can never read as a clean run.
// NOT DONE HERE (stated rather than implied): the loss is not yet carried INSIDE the package, which would need the
// artifact module to publish an `unreadableReceipts` section; until then a reader of the package alone still sees
// only the campaigns that could be read.
const unreadableReceipts = [];
for (const entry of list.receipts ?? []) {
  // The City already names an unreadable receipt with a typed reason and the file it could not parse:
  //   {"file":"campaign-<uuid>.json","state":"UNREADABLE","reason":"RECEIPT_UNREADABLE"}
  // MEASURED, and the reason my first repair printed "undefined": that entry has NO campaignId, so fetching its
  // detail produced `GET research/campaigns/undefined answered 404`. Read the signal the listing already provides
  // instead of inventing a lookup, and name the receipt by its file.
  if (entry.state === 'UNREADABLE' || entry.reason === 'RECEIPT_UNREADABLE') {
    unreadableReceipts.push({name: entry.file ?? entry.campaignId ?? '<unidentified receipt>', reason: entry.reason ?? 'RECEIPT_UNREADABLE'});
    continue;
  }
  try {
    const detail = await get(`research/campaigns/${encodeURIComponent(entry.campaignId)}`);
    if (detail.campaign?.state === 'UNREADABLE' || detail.campaign?.reason === 'RECEIPT_UNREADABLE') unreadableReceipts.push({name: entry.campaignId ?? entry.file, reason: 'RECEIPT_UNREADABLE'});
    else if (detail.campaign) receipts.push(detail.campaign);
    else unreadableReceipts.push({name: entry.campaignId ?? entry.file ?? '<unidentified receipt>', reason: 'NO_CAMPAIGN_IN_DETAIL'});
  } catch (error) {
    unreadableReceipts.push({name: entry.campaignId ?? entry.file ?? '<unidentified receipt>', reason: String(error?.message ?? error).slice(0, 120)});
  }
}
if (list.receiptWindow?.truncated) unreadableReceipts.push({name: 'campaign-receipt-window', reason: 'RECEIPT_WINDOW_TRUNCATED', total: list.receiptWindow.total, returned: (list.receipts ?? []).length});
if (unreadableReceipts.length > 0) {
  console.error(`unreadable receipts: ${unreadableReceipts.length} of ${(list.receipts ?? []).length} - this export describes only what could be read, and must not be mistaken for a smaller study:`);
  for (const row of unreadableReceipts) console.error(`  ${row.name}  ${row.reason}`);
  process.exitCode = 1;
}
// A receipt DELETED from the store leaves no trace in the listing at all: there is no tombstone, and the window's
// own total drops with the file (measured: receipts=1, receiptWindow.total=1 after a deletion). But the live
// campaign record survives completion and still names the last campaign, so a TERMINAL live campaign whose id is
// absent from the receipts means the newest receipt was lost. MEASURED: signal available=true on a throwaway City.
// SCOPE, stated rather than implied: only the newest receipt is detectable this way - deleting an older one while a
// newer receipt survives remains invisible to any reader, which is why the message says "the newest" and not
// "a receipt".
const TERMINAL_CAMPAIGN_STATES = ['COMPLETED', 'STOPPED', 'REFUSED', 'FAILED', 'INTERRUPTED'];
const liveId = list.live?.campaignId ?? null;
const liveAccounted = Boolean(liveId) && (receipts.some(row => row.campaignId === liveId)
  || unreadableReceipts.some(row => String(row.name).startsWith(liveId)));
if (liveId && TERMINAL_CAMPAIGN_STATES.includes(list.live?.state) && !liveAccounted) {
  console.error(`the live campaign ${liveId} (state ${list.live.state}) has no receipt in this City's store - the newest receipt is missing, so this artifact describes less than the City ran (an older loss is not detectable at all):`);
  process.exitCode = 1;
  unreadableReceipts.push({name: liveId, reason: 'LATEST_RECEIPT_MISSING'});
}
if (receipts.length === 0) {
  console.error('no campaign receipt is readable from this City; an artifact with no real source is not worth exporting');
  // DEFECT REPAIR (Windows, measured): `process.exit(1)` here asserted in libuv - "!(handle->flags &
  // UV_HANDLE_CLOSING), src/win/async.c" - because the fetch keep-alive handle from the listing above was still
  // closing, so the process exited with 0xC0000409 and a caller could not tell a designed refusal from a crash.
  // Both failure paths of this script are repaired in this branch; see the unreadable-receipt guard above.
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
    members: (city.members ?? []).map(member => member.deviceId ?? member.ref ?? member.devicePrincipalId ?? null).filter(Boolean),
  },
  receipts,
  sourceReadFailures: unreadableReceipts,
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
