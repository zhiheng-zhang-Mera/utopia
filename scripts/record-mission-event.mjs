import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const EVENT_TYPES = new Set(["MISSION_CLAIMED","ATTEMPT_STARTED","CHANGE_APPLIED","TEST_PASS","TEST_FAIL","RUNTIME_PASS","RUNTIME_FAIL","RECOVERY","OWNER_INTERVENTION","MIGRATION_COMPLETE","VERIFIER_FINDING","REPAIR_APPLIED","CI_RESULT","VERIFICATION_COMPLETE","MISSION_ACCEPTED"]);
const OUTCOMES = new Set(["INFO","PASS","FAIL","BLOCKED","REJECTED","REPAIRED"]);
const ROLES = new Set(['MIGRATION','VERIFICATION']);

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parse(argv) {
  const out = { evidence: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) fail(`Unexpected argument: ${key}`);
    const name = key.slice(2);
    const value = argv[++i];
    if (value == null || value.startsWith('--')) fail(`Missing value for --${name}`);
    if (name === 'evidence') out.evidence.push(value);
    else if (['mission','role','host','type','outcome','summary','source-ref','target-ref','timestamp'].includes(name)) out[name] = value;
    else fail(`Unknown option: --${name}`);
  }
  return out;
}

function cleanRef(value) {
  if (value == null) return null;
  if (value.length > 500 || value.includes('\0')) fail('Invalid ref');
  return value;
}

const args = parse(process.argv.slice(2));
const missionId = args.mission;
const role = String(args.role || '').toUpperCase();
const hostId = args.host;
const eventType = String(args.type || '').toUpperCase();
const outcome = String(args.outcome || '').toUpperCase();
const summary = args.summary;
const timestamp = args.timestamp || new Date().toISOString();

if (!/^MB-[0-9]{3}$/.test(missionId || '')) fail('Invalid --mission; expected MB-xxx');
if (!ROLES.has(role)) fail('Invalid --role');
if (!/^[A-Za-z0-9._-]{1,80}$/.test(hostId || '')) fail('Invalid --host');
if (!EVENT_TYPES.has(eventType)) fail('Invalid --type');
if (!OUTCOMES.has(outcome)) fail('Invalid --outcome');
if (!summary || summary.length > 1000) fail('Invalid --summary');
if (Number.isNaN(Date.parse(timestamp))) fail('Invalid --timestamp');
if (args.evidence.length > 50) fail('Too many --evidence values');
for (const pointer of args.evidence) {
  if (!pointer || pointer.length > 2048 || pointer.includes('\0')) fail('Invalid evidence pointer');
}

const sourceRef = cleanRef(args['source-ref']);
const targetRef = cleanRef(args['target-ref']);
const basis = JSON.stringify({ missionId, role, hostId, eventType, timestamp, outcome, summary, sourceRef, targetRef, evidence: args.evidence });
const eventId = `${missionId}:${createHash('sha256').update(basis).digest('hex').slice(0,16)}`;
const event = { schemaVersion: 1, eventId, missionId, role, hostId, eventType, timestamp, outcome, summary, sourceRef, targetRef, evidence: args.evidence };

const file = path.join('data-records','evolution','inbox','mission-book',missionId,'events.jsonl');
await mkdir(path.dirname(file), { recursive: true });

try {
  const existing = await readFile(file, 'utf8');
  if (existing.split(/\r?\n/).some(line => line.includes(`"eventId":"${eventId}"`))) {
    console.log(JSON.stringify({ status: 'ALREADY_RECORDED', eventId, file }));
    process.exit(0);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

await appendFile(file, JSON.stringify(event) + '\n', 'utf8');
console.log(JSON.stringify({ status: 'RECORDED', eventId, file }));
