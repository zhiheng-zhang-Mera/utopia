import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const EVENT_TYPES = new Set(["MISSION_CLAIMED","ATTEMPT_STARTED","CHANGE_APPLIED","TEST_PASS","TEST_FAIL","RUNTIME_PASS","RUNTIME_FAIL","RECOVERY","OWNER_INTERVENTION","MIGRATION_COMPLETE","VERIFIER_FINDING","REPAIR_APPLIED","CI_RESULT","VERIFICATION_COMPLETE","MISSION_ACCEPTED"]);
const OUTCOMES = new Set(["INFO","PASS","FAIL","BLOCKED","REJECTED","REPAIRED"]);

function fail(message) {
  console.error(message);
  process.exit(2);
}
function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) fail(`Unexpected argument: ${key}`);
    const name = key.slice(2);
    const value = argv[++i];
    if (value == null || value.startsWith('--')) fail(`Missing value for --${name}`);
    if (['mission','migration-host','verification-host','branch-sha','ci-run'].includes(name)) out[name] = value;
    else fail(`Unknown option: --${name}`);
  }
  return out;
}
function validEvent(e) {
  return e && e.schemaVersion === 1 &&
    /^MB-[0-9]{3}$/.test(e.missionId || '') &&
    /^(MIGRATION|VERIFICATION)$/.test(e.role || '') &&
    /^[A-Za-z0-9._-]{1,80}$/.test(e.hostId || '') &&
    EVENT_TYPES.has(e.eventType) && OUTCOMES.has(e.outcome) &&
    typeof e.summary === 'string' && Array.isArray(e.evidence);
}
function slim(e) {
  return { eventId: e.eventId, role: e.role, hostId: e.hostId, eventType: e.eventType, outcome: e.outcome, timestamp: e.timestamp, summary: e.summary, evidence: e.evidence };
}

const args = parse(process.argv.slice(2));
const missionId = args.mission;
const migrationHost = args['migration-host'];
const verificationHost = args['verification-host'];
const branchFinalSha = args['branch-sha'];
const ciRun = args['ci-run'];

if (!/^MB-[0-9]{3}$/.test(missionId || '')) fail('Invalid --mission');
if (!/^[A-Za-z0-9._-]{1,80}$/.test(migrationHost || '')) fail('Invalid --migration-host');
if (!/^[A-Za-z0-9._-]{1,80}$/.test(verificationHost || '')) fail('Invalid --verification-host');
if (migrationHost === verificationHost) fail('Migration and verification hosts must differ');
if (!/^[A-Fa-f0-9]{7,64}$/.test(branchFinalSha || '')) fail('Invalid --branch-sha');
if (!ciRun) fail('Missing --ci-run');

const inboxFile = path.join('data-records','evolution','inbox','mission-book',missionId,'events.jsonl');
let inboxRaw;
try { inboxRaw = await readFile(inboxFile, 'utf8'); }
catch (error) { fail(`Cannot read inbox: ${error.message}`); }

const events = inboxRaw.split(/\r?\n/).filter(Boolean).map((line, i) => {
  try { return JSON.parse(line); } catch { fail(`Invalid JSONL at line ${i + 1}`); }
});
if (!events.length) fail('Inbox is empty');
for (const event of events) {
  if (!validEvent(event)) fail(`Invalid event: ${event?.eventId || 'unknown'}`);
  if (event.missionId !== missionId) fail('Inbox contains another mission');
  if (event.role === 'MIGRATION' && event.hostId !== migrationHost) fail('Migration role contains another host');
  if (event.role === 'VERIFICATION' && event.hostId !== verificationHost) fail('Verification role contains another host');
}

const migrationDoneIndex = events.findIndex(e => e.role === 'MIGRATION' && e.eventType === 'MIGRATION_COMPLETE' && e.outcome === 'PASS');
if (migrationDoneIndex < 0) fail('Missing PASS MIGRATION_COMPLETE');
const verifierFindingIndex = events.findIndex(e => e.role === 'VERIFICATION' && e.eventType === 'VERIFIER_FINDING');
if (verifierFindingIndex < 0) fail('Missing VERIFIER_FINDING from independent review');
const ciIndexes = events.map((e,i) => [e,i]).filter(([e]) => e.role === 'VERIFICATION' && e.eventType === 'CI_RESULT');
if (!ciIndexes.length) fail('Missing verification CI_RESULT');
const [finalCi, finalCiIndex] = ciIndexes.at(-1);
if (finalCi.outcome !== 'PASS') fail('Final verification CI_RESULT is not PASS');
const verificationDoneIndex = events.findIndex((e,i) => i > finalCiIndex && e.role === 'VERIFICATION' && e.eventType === 'VERIFICATION_COMPLETE' && e.outcome === 'PASS');
if (verificationDoneIndex < 0) fail('Missing PASS VERIFICATION_COMPLETE after final PASS CI_RESULT');
if (verifierFindingIndex <= migrationDoneIndex) fail('VERIFIER_FINDING must occur after migration completion');

const inboxDigestSha256 = createHash('sha256').update(inboxRaw).digest('hex');
const episodeId = `${missionId}:${createHash('sha256').update(inboxDigestSha256 + ':' + branchFinalSha).digest('hex').slice(0,16)}`;
const unique = values => [...new Set(values.filter(Boolean))];
const failures = events.filter(e => ['FAIL','BLOCKED'].includes(e.outcome)).map(slim);
const rejectedApproaches = events.filter(e => e.outcome === 'REJECTED').map(slim);
const repairs = events.filter(e => ['REPAIR_APPLIED','RECOVERY'].includes(e.eventType)).map(slim);
const verifierFindings = events.filter(e => e.eventType === 'VERIFIER_FINDING').map(slim);
const verificationComplete = events[verificationDoneIndex];

const episode = {
  schemaVersion: 1,
  episodeId,
  missionId,
  status: 'VERIFIED',
  participants: { migrationHost, verificationHost },
  sourceRefs: unique(events.map(e => e.sourceRef)),
  target: { branchFinalSha: branchFinalSha.toLowerCase(), targetRefs: unique(events.map(e => e.targetRef)) },
  inboxDigestSha256,
  timeline: events.map(slim),
  failures,
  rejectedApproaches,
  repairs,
  verifierFindings,
  acceptedApproach: { summary: verificationComplete.summary, eventId: verificationComplete.eventId },
  metrics: {
    eventCount: events.length,
    attempts: events.filter(e => e.eventType === 'ATTEMPT_STARTED').length,
    testPasses: events.filter(e => e.eventType === 'TEST_PASS').length,
    testFailures: events.filter(e => e.eventType === 'TEST_FAIL').length,
    runtimePasses: events.filter(e => e.eventType === 'RUNTIME_PASS').length,
    runtimeFailures: events.filter(e => e.eventType === 'RUNTIME_FAIL').length,
    repairs: repairs.length,
    verifierFindings: verifierFindings.length,
    ownerInterventions: events.filter(e => e.eventType === 'OWNER_INTERVENTION').length
  },
  evidence: unique(events.flatMap(e => e.evidence)),
  ci: { run: String(ciRun), outcome: 'PASS' },
  learning: { eligible: true, authority: 'EXPERIENCE_ONLY' }
};

const episodeFile = path.join('data-records','evolution','episodes','mission-book',missionId,'episode.json');
await mkdir(path.dirname(episodeFile), { recursive: true });
await writeFile(episodeFile, JSON.stringify(episode, null, 2) + '\n', 'utf8');
await rm(inboxFile);
console.log(JSON.stringify({ status: 'FINALIZED', episodeId, episodeFile, removedInbox: inboxFile }));
