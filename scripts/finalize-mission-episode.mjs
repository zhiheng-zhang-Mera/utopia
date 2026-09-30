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
    if (['mission','migration-host','verification-host','branch-sha','ci-run','migration-acceptance','owner-ruling','host-separation','completing-host'].includes(name)) out[name] = value;
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

/**
 * Host separation.
 *
 * `strict` (the default) is the rule: the Migration Host and the Verification Host are two
 * different real hosts, and each role's events must come from its own host.
 *
 * `owner-waived` exists for the case an Owner ruling resolved explicitly: a Mission whose
 * Verification Host cannot execute the closeout while the Migration Host can, so the Owner
 * authorises the Migration Host to finish the verification role. Nothing is rewritten to
 * make that work — every historical event keeps the hostId that produced it, the ruling must
 * be cited by an event in the record, the completing host must actually have produced the
 * verification events, and the episode states which host produced which side. A waiver that
 * is not needed is refused rather than recorded.
 */
const HOST_SEPARATION_MODES = ['strict', 'owner-waived'];
const hostSeparationMode = args['host-separation'] ?? 'strict';
if (!HOST_SEPARATION_MODES.includes(hostSeparationMode)) fail(`Invalid --host-separation: ${hostSeparationMode}`);
const completingHost = args['completing-host'];

if (hostSeparationMode === 'strict') {
  if (completingHost !== undefined) fail('--completing-host is only valid with --host-separation owner-waived');
  if (migrationHost === verificationHost) fail('Migration and verification hosts must differ');
} else {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(completingHost || '')) fail('--host-separation owner-waived requires --completing-host');
  if (!/^[A-Za-z0-9._/#-]{10,200}$/.test(args['owner-ruling'] || '')) fail('--host-separation owner-waived requires --owner-ruling');
  if (completingHost === verificationHost) fail('--host-separation owner-waived is unnecessary: the completing host is already the Verification Host');
  if (completingHost !== migrationHost && completingHost !== verificationHost) fail('--completing-host must already participate in this Mission');
}
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

const allowedMigrationHosts = hostSeparationMode === 'owner-waived' ? [migrationHost, completingHost] : [migrationHost];
const allowedVerificationHosts = hostSeparationMode === 'owner-waived' ? [verificationHost, completingHost] : [verificationHost];
const hostsSeen = { migration: new Set(), verification: new Set() };

for (const event of events) {
  if (!validEvent(event)) fail(`Invalid event: ${event?.eventId || 'unknown'}`);
  if (event.missionId !== missionId) fail('Inbox contains another mission');
  if (event.role === 'MIGRATION') {
    if (!allowedMigrationHosts.includes(event.hostId)) fail('Migration role contains another host');
    hostsSeen.migration.add(event.hostId);
  }
  if (event.role === 'VERIFICATION') {
    if (!allowedVerificationHosts.includes(event.hostId)) fail('Verification role contains another host');
    hostsSeen.verification.add(event.hostId);
  }
}

let hostSeparation = { mode: 'STRICT', migrationHost, verificationHost };
if (hostSeparationMode === 'owner-waived') {
  const byCompleting = events.filter((e) => e.role === 'VERIFICATION' && e.hostId === completingHost);
  if (!byCompleting.length) {
    fail(`--host-separation owner-waived requires the completing host ${completingHost} to have produced VERIFICATION events`);
  }
  const searchable = events.map((e) => `${e.summary ?? ''} ${Array.isArray(e.evidence) ? e.evidence.join(' ') : ''}`).join(' ');
  if (!searchable.includes(args['owner-ruling'])) {
    fail('--host-separation owner-waived requires an event that cites the Owner ruling relied on');
  }
  hostSeparation = {
    mode: 'OWNER_WAIVED',
    ownerRuling: args['owner-ruling'],
    migrationHost,
    verificationHost,
    completingHost,
    migrationHosts: [...hostsSeen.migration].sort(),
    verificationHosts: [...hostsSeen.verification].sort(),
    verificationEventsByCompletingHost: byCompleting.length,
  };
}

/**
 * Migration acceptance basis.
 *
 * `host-pass` (the default) is the original contract: the migration host itself wrote a
 * `MIGRATION_COMPLETE` event with outcome `PASS`.
 *
 * `owner-override` exists because the v2 rules added a case the original contract cannot
 * express: a Mission whose migration host recorded a real `BLOCKED` for the
 * product-consumption gate, which an Owner ruling then overrode by declaring the migration
 * complete (see `Digital-City/mission-book/README.md` §7.2 and the dated Owner responses).
 * The migration host never wrote `MIGRATION_COMPLETE`, and this script must never invent one:
 * the blocker stays in the timeline and the episode records *why* completion was accepted.
 *
 * Everything after the basis is identical, so an owner-override episode is held to the same
 * verification standard as a host-pass one.
 */
const ACCEPTANCE_MODES = ['host-pass', 'owner-override'];

const migrationAcceptanceMode = args['migration-acceptance'] ?? 'host-pass';
const ownerRuling = args['owner-ruling'];
if (!ACCEPTANCE_MODES.includes(migrationAcceptanceMode)) fail(`Invalid --migration-acceptance: ${migrationAcceptanceMode}`);

let migrationDoneIndex;
let migrationAcceptance;
if (migrationAcceptanceMode === 'host-pass') {
  if (ownerRuling !== undefined && hostSeparationMode !== 'owner-waived') fail('--owner-ruling is only valid with --migration-acceptance owner-override or --host-separation owner-waived');
  migrationDoneIndex = events.findIndex(e => e.role === 'MIGRATION' && e.eventType === 'MIGRATION_COMPLETE' && e.outcome === 'PASS');
  if (migrationDoneIndex < 0) fail('Missing PASS MIGRATION_COMPLETE');
  migrationAcceptance = { mode: 'HOST_PASS' };
} else {
  if (!ownerRuling) fail('--migration-acceptance owner-override requires --owner-ruling');
  if (!/^[A-Za-z0-9._/#-]{10,200}$/.test(ownerRuling)) fail('Invalid --owner-ruling reference');

  // 1. the migration side must show a real blocker it did not resolve itself.
  migrationDoneIndex = events.findIndex(e => e.role === 'MIGRATION' && e.eventType === 'MIGRATION_COMPLETE' && e.outcome === 'PASS');
  if (migrationDoneIndex >= 0) fail('This inbox already contains a host PASS MIGRATION_COMPLETE; use --migration-acceptance host-pass');
  const blocker = events
    .map((e, i) => [e, i])
    .filter(([e]) => e.role === 'MIGRATION' && ['BLOCKED', 'FAIL'].includes(e.outcome));
  if (!blocker.length) fail('Owner-override requires a real BLOCKED/FAIL migration event recording the unresolved gate');
  const [blockerEvent, blockerIndex] = blocker.at(-1);

  // 2. the verification host must have recorded an OWNER_INTERVENTION, and
  // 3. that intervention must point at the ruling being relied on.
  const interventions = events
    .map((e, i) => [e, i])
    .filter(([e]) => e.role === 'VERIFICATION' && e.eventType === 'OWNER_INTERVENTION');
  if (!interventions.length) fail('Owner-override requires an OWNER_INTERVENTION from the verification host');
  const [interventionEvent, interventionIndex] = interventions.at(-1);
  // The intervention must be *locatable* to the ruling being relied on. Two forms are
  // accepted, because both are honest citations: the exact reference (`<path>#<anchor>`) in
  // the summary or evidence, or the document path in the evidence plus the anchor named in
  // the summary. A bare document reference with no anchor is NOT enough — the ruling has to
  // be pinned, not gestured at.
  const [rulingPath, rulingAnchor] = ownerRuling.split('#');
  const searchable = [interventionEvent.summary, ...(interventionEvent.evidence ?? [])]
    .filter((text) => typeof text === 'string');
  const citesRuling = searchable.some((text) => text.includes(ownerRuling))
    || (Boolean(rulingAnchor)
      && searchable.some((text) => text.includes(rulingPath))
      && searchable.some((text) => text.includes(rulingAnchor)));
  if (!citesRuling) fail(`OWNER_INTERVENTION does not reference the owner ruling ${ownerRuling}`);

  // 4. an independent verifier finding must exist, and it must postdate the blocker.
  const finding = events.map((e, i) => [e, i]).find(([e]) => e.role === 'VERIFICATION' && e.eventType === 'VERIFIER_FINDING');
  if (!finding) fail('Missing VERIFIER_FINDING from independent review');
  if (finding[1] <= blockerIndex) fail('VERIFIER_FINDING must occur after the recorded migration blocker');
  if (interventionIndex <= blockerIndex) fail('OWNER_INTERVENTION must occur after the recorded migration blocker');

  migrationAcceptance = {
    mode: 'OWNER_OVERRIDE',
    ownerRuling,
    migrationBlockerEventId: blockerEvent.eventId,
    ownerInterventionEventId: interventionEvent.eventId,
  };
}

const verifierFindingIndex = events.findIndex(e => e.role === 'VERIFICATION' && e.eventType === 'VERIFIER_FINDING');
if (verifierFindingIndex < 0) fail('Missing VERIFIER_FINDING from independent review');
const ciIndexes = events.map((e,i) => [e,i]).filter(([e]) => e.role === 'VERIFICATION' && e.eventType === 'CI_RESULT');
if (!ciIndexes.length) fail('Missing verification CI_RESULT');
const [finalCi, finalCiIndex] = ciIndexes.at(-1);
if (finalCi.outcome !== 'PASS') fail('Final verification CI_RESULT is not PASS');
const verificationDoneIndex = events.findIndex((e,i) => i > finalCiIndex && e.role === 'VERIFICATION' && e.eventType === 'VERIFICATION_COMPLETE' && e.outcome === 'PASS');
if (verificationDoneIndex < 0) fail('Missing PASS VERIFICATION_COMPLETE after final PASS CI_RESULT');
if (migrationAcceptanceMode === 'host-pass' && verifierFindingIndex <= migrationDoneIndex) fail('VERIFIER_FINDING must occur after migration completion');

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
  hostSeparation,
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
  migrationAcceptance,
  learning: { eligible: true, authority: 'EXPERIENCE_ONLY' }
};

const episodeFile = path.join('data-records','evolution','episodes','mission-book',missionId,'episode.json');
await mkdir(path.dirname(episodeFile), { recursive: true });
await writeFile(episodeFile, JSON.stringify(episode, null, 2) + '\n', 'utf8');
await rm(inboxFile);
console.log(JSON.stringify({ status: 'FINALIZED', episodeId, episodeFile, removedInbox: inboxFile }));
