// The OPPOSITE SIDE of the agent-job channel: the program an agent on the far machine runs.
//
// WHY THIS EXISTS. The reference node answers mechanical task types with code. When the machine on the other end is
// driven by an AGENT - a Codex or ChatGPT session, or a person at a terminal - there is nothing for that code to answer
// with, and until now the City had no way to reach such a machine at all. This CLI is the missing half: it REGISTERS the
// machine as a node that can be asked for agent jobs, CLAIMS one job, prints it in a form an agent can read and act on,
// and REPORTS back what that agent says happened.
//
// WHAT IT DOES NOT DO, deliberately:
//   · it never invents a result. `report` sends exactly the state, evidence class, summary and artifact digests it was
//     given. A fabricated summary is possible - the City says so on every accepted report - but a fabricated DIGEST is
//     not: the digests are computed here, from the bytes of files the caller named.
//   · it does not run the job. Deciding what "do this" means is the agent's job, and hiding that inside a CLI would make
//     a judgement call look like a program.
//   · it does not upgrade the evidence class. An agent that read something second-hand must say
//     REPORTED_FROM_ELSEWHERE, and this CLI refuses a class it was not given rather than guessing one.
//
// Usage (env CITY_URL / CITY_NODE_TOKEN / CITY_NODE_ID may replace the flags):
//   node scripts/agent-job.mjs register --url http://host:4310 --node-token <t> --id <node-id> [--display-name <name>]
//   node scripts/agent-job.mjs claim    --url ... --node-token ... --id ... [--state-file <path>]
//   node scripts/agent-job.mjs heartbeat --url ... --node-token ... --id ...   (while working, to stay online)
//   node scripts/agent-job.mjs report   --url ... --node-token ... --id ... [--task <taskId>] \
//        --state SUCCEEDED --evidence OBSERVED_HERE --summary-file report.md [--artifact name=path]... [--reason <text>]
//   node scripts/agent-job.mjs digest   --file <path>
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename, resolve} from 'node:path';
import {EVIDENCE_CLASSES, AGENT_REPORTABLE_STATES, REPORT_STATE_TO_TASK_STATE} from '../contracts/city-agent-job-v1/job.mjs';

const VERSION_HEADERS = {'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};

/** The capabilities this node advertises. `city.agent-job.v1` is the ONE thing that makes the City offer it a job. */
export const AGENT_NODE_CAPABILITIES = Object.freeze(['task.execute.safe', 'filesystem.temp', 'city.agent-job.v1']);
/** Where `claim` records the job it took, so `report` binds to THAT job instead of to whatever the caller remembers. */
export const DEFAULT_STATE_FILE = '.agent-job-claimed.json';

export const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * One call to the node route family. The City's answer is returned whole - including its refusal code - so the caller
 * (or the agent reading stdout) can act on the real reason instead of on a generic failure.
 */
export async function nodeCall({url, token, path, body, fetchImpl = fetch}) {
  if (!url || !token) throw Object.assign(new Error('a City url and a node token are required'), {code: 'AGENT_JOB_CLI_CONFIG_REQUIRED'});
  const response = await fetchImpl(new URL('/api/v0/node/' + path, url), {
    method: 'POST',
    headers: {...VERSION_HEADERS, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error ?? `node/${path} failed with ${response.status}`), {
    code: payload.errorCode ?? 'AGENT_JOB_NODE_REFUSED', status: response.status, payload});
  return payload;
}

/** Announce this machine as able to answer agent jobs. Re-registering is how a node updates its capability list. */
export const registerNode = ({url, token, id, displayName = id, capabilities = AGENT_NODE_CAPABILITIES, fetchImpl}) =>
  nodeCall({url, token, path: 'register', fetchImpl, body: {id, displayName, capabilities, agentVersion: 'agent-job-cli/1', metadata: {platform: process.platform}}});

/**
 * Keep this node's liveness fresh.
 *
 * The City marks a node OFFLINE once its own heartbeat timeout has passed (8 s by default), and an offline node is never
 * handed work. A far-side agent must therefore heartbeat for as long as it intends to be asked - including WHILE it is
 * working on a job, or the machine that is busy answering would look like a machine that has gone away.
 */
export const heartbeatNode = ({url, token, id, fetchImpl}) =>
  nodeCall({url, token, path: 'heartbeat', fetchImpl, body: {id, agentVersion: 'agent-job-cli/1'}});

/**
 * Take one job, if the City has one for this node.
 *
 * A CLAIM IS A LIVENESS ACT, and the heartbeat is sent first on purpose. This was a real defect: the first version of
 * this CLI registered and then only claimed, so on a real machine the node was marked offline one heartbeat timeout
 * later and the City stopped offering it work - which looks EXACTLY like a City with nothing to do, and so would have
 * been read as "no jobs" rather than as a broken channel. `null` means "nothing to do" and is NOT an error.
 */
export const claimJob = async ({url, token, id, fetchImpl}) => {
  await heartbeatNode({url, token, id, fetchImpl});
  return (await nodeCall({url, token, path: 'claim', fetchImpl, body: {id}})).task ?? null;
};

/** Bounded, monotonic progress. The City refuses a progress that goes backwards, so this is reported before the end. */
export const reportProgress = ({url, token, id, taskId, state = 'RUNNING', progress = 1, fetchImpl}) =>
  nodeCall({url, token, path: 'report', fetchImpl, body: {id, taskId, state, progress}});

/**
 * What `claim` prints, and in the shape it is handed to an agent. `jobDigest` travels with the job because the City
 * answers a report bound to THAT digest: an agent working from a remembered job would otherwise have its answer refused
 * as being about a different question, which is correct but indistinguishable from a fault.
 */
export const describeClaimedJob = task => {
  if (task === null) return {task: null, note: 'no job waiting for this node'};
  return {
    taskId: task.id,
    jobDigest: task.job?.jobDigest ?? null,
    // A claimed task with no job record is NAMED rather than rendered as an empty request: the City stores what it
    // normalised, and if that piece were ever missing, an agent must not be asked to answer a blank.
    jobState: task.job ? undefined : 'JOB_RECORD_MISSING',
    job: task.job ?? null,
  };
};

/**
 * Write down which job was taken, so the report that follows in a LATER process still answers the same question.
 * The digest is the whole point: it is what the City compares, and it cannot be reconstructed from the task id.
 */
export const saveClaimedJob = (task, path = DEFAULT_STATE_FILE) => {
  const state = {taskId: task.id, jobDigest: task.job?.jobDigest ?? null};
  writeFileSync(path, JSON.stringify(state, null, 2));
  return state;
};
export const readClaimedJob = (path = DEFAULT_STATE_FILE) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Hand the City what the agent says happened.
 *
 * The digests are computed from the files the CALLER named, so every artifact entry points at bytes that really exist
 * on this machine. The state is translated through the contract's own table rather than by string coincidence, and a
 * state with no translation (`EXPIRED` - the City's decision about its own deadline) is refused here, so the caller
 * learns that before spending a round trip.
 */
export async function reportJob({url, token, id, taskId, jobDigest, state, evidence, summary, artifactEntries = [], reason, fetchImpl}) {
  if (!EVIDENCE_CLASSES.includes(evidence)) {
    throw Object.assign(new Error(`evidence must be one of ${EVIDENCE_CLASSES.join(', ')}; it says what kind of claim this is`), {code: 'AGENT_JOB_EVIDENCE_REQUIRED'});
  }
  if (!AGENT_REPORTABLE_STATES.includes(state)) {
    throw Object.assign(new Error(`an agent may report ${AGENT_REPORTABLE_STATES.join(' or ')}, not ${String(state)}: an agent reports an outcome, while cancelling is the owner's and expiring is the City's`), {code: 'AGENT_JOB_STATE_NOT_AGENT_DECIDABLE'});
  }
  const taskState = REPORT_STATE_TO_TASK_STATE[state];
  if (typeof jobDigest !== 'string' || jobDigest.length === 0) throw Object.assign(new Error('the job digest is required; take it from `claim`'), {code: 'AGENT_JOB_DIGEST_REQUIRED'});
  const artifacts = artifactEntries.map(entry => {
    const [name, file] = entry.includes('=') ? [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)] : [basename(entry), entry];
    const bytes = readFileSync(file);
    return {name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length};
  });
  // A COMPLETED task must have passed through RUNNING: the City's own state machine refuses ASSIGNED -> COMPLETED, and
  // that is not a quirk of the backend - a task that produced a result did start. So a report claiming work was done
  // announces RUNNING first. A NOT_DONE claim says no work happened, and announcing RUNNING for it would be a false
  // statement about this machine, so that one goes straight to its terminal state.
  if (evidence !== 'NOT_DONE') await reportProgress({url, token, id, taskId, state: 'RUNNING', progress: 1, fetchImpl});
  const body = {id, taskId, state: taskState, progress: 100,
    result: {jobDigest, state, evidence, summary, artifacts, ...(reason === undefined ? {} : {reason})}};
  const sent = await nodeCall({url, token, path: 'report', fetchImpl, body});
  return {taskId: sent.id, state: sent.state, progress: sent.progress, reportedState: state, evidence};
}

const flag = (argv, name) => {
  const index = argv.indexOf('--' + name);
  return index === -1 ? undefined : argv[index + 1];
};
const repeatable = (argv, name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--' + name && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  return out;
};
const config = argv => ({
  url: flag(argv, 'url') ?? process.env.CITY_URL,
  token: flag(argv, 'node-token') ?? process.env.CITY_NODE_TOKEN,
  id: flag(argv, 'id') ?? process.env.CITY_NODE_ID,
});

export async function main(argv) {
  const command = argv[0];
  const {url, token, id} = config(argv);
  if (command === 'digest') {
    process.stdout.write(sha256File(flag(argv, 'file')) + '\n');
    return 0;
  }
  if (command === 'register') {
    const node = await registerNode({url, token, id, displayName: flag(argv, 'display-name') ?? id});
    process.stdout.write(JSON.stringify({registered: node.id, capabilities: node.capabilities}, null, 2) + '\n');
    return 0;
  }
  if (command === 'heartbeat') {
    const node = await heartbeatNode({url, token, id});
    process.stdout.write(JSON.stringify({nodeId: node.id, online: node.online === true, lastHeartbeatAt: node.lastHeartbeatAt}, null, 2) + '\n');
    return 0;
  }
  if (command === 'claim') {
    const task = await claimJob({url, token, id});
    // The state file is written only when there IS a job: a poll that found nothing must not erase the record of a job
    // that is still in flight, which would make a later report unanswerable.
    if (task !== null) saveClaimedJob(task, flag(argv, 'state-file') ?? DEFAULT_STATE_FILE);
    // Printed as JSON because the reader is an agent, not a person: the whole request travels in one shape it can parse.
    process.stdout.write(JSON.stringify(describeClaimedJob(task), null, 2) + '\n');
    return task === null ? 3 : 0;
  }
  if (command === 'report') {
    const stateFile = flag(argv, 'state-file') ?? DEFAULT_STATE_FILE;
    const claimed = flag(argv, 'task') === undefined && flag(argv, 'job-digest') === undefined ? readClaimedJob(stateFile) : null;
    const taskId = flag(argv, 'task') ?? claimed?.taskId;
    const jobDigest = flag(argv, 'job-digest') ?? claimed?.jobDigest;
    const summaryFile = flag(argv, 'summary-file');
    const summary = summaryFile ? readFileSync(summaryFile, 'utf8') : flag(argv, 'summary') ?? '';
    const sent = await reportJob({url, token, id, taskId, jobDigest, state: flag(argv, 'state'), evidence: flag(argv, 'evidence'),
      summary, artifactEntries: repeatable(argv, 'artifact'), reason: flag(argv, 'reason')});
    process.stdout.write(JSON.stringify(sent, null, 2) + '\n');
    return 0;
  }
  process.stderr.write('usage: agent-job.mjs <register|heartbeat|claim|report|digest> [--url --node-token --id ...]\n');
  return 2;
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? '').replace(/\\/g, '/')}`) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(JSON.stringify({error: error.message, code: error.code ?? null, status: error.status ?? null}) + '\n');
    process.exitCode = 1;
  });
}
