// City -> remote AGENT job (v1).
//
// The sibling of `city-remote-operation-v1`, and the difference between them is the whole point: that one makes a
// machine RUN A PROGRAM the City named; this one hands a remote AGENT a REQUEST and takes back a REPORT. The City
// cannot see inside an agent - Codex, an LLM session, a person at a terminal - so it does not pretend to. It carries
// the request, bounds it, records who asked and who answered, and states plainly that the answer is the agent's own
// observation rather than something the City verified. That is the same discipline the node receipt follows, applied
// to a participant whose internals are unknowable rather than merely remote.
//
// WHY THIS EXISTS AT ALL. The reference-node protocol only understands mechanical task types (WAIT, hash an artifact,
// touch a checkpoint). A machine whose opposite side is driven by an agent therefore had NO channel: the City could
// not ask it for anything, and the member-message route is session-only, so a node credential cannot read it either.
// That is a capability gap, not a workaround - the City had no way to hand work to the one kind of participant most
// likely to be on the other end of a link.
//
// WHAT IT REFUSES, and why each refusal is a decision:
//   · no instruction, no job - an unexplained request to an autonomous agent is refused by presence, like `purpose`.
//   · inputs are BOUNDED TEXT AND REFS, never a credential: passing a token as an input would put a live secret into
//     the City's own job record, and a record is not a secret store.
//   · the deadline is bounded and clamped, so a job cannot be handed out with no end.
//   · the report is bounded and must DECLARE its own confidence class, because "the agent said so" and "the agent ran
//     it and here are the bytes" are different kinds of claim and must not arrive looking the same.
import {createHash} from 'node:crypto';

export const AGENT_JOB_VERSION = 1;
export const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;
export const MAX_DEADLINE_MS = 24 * 60 * 60 * 1000;
export const MAX_STATEMENT_LENGTH = 8000;
export const MAX_INPUTS = 64;
export const MAX_REPORT_SUMMARY = 20000;
export const MAX_ARTIFACTS = 64;

export const JOB_STATES = Object.freeze(['PENDING', 'CLAIMED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']);
export const TERMINAL_JOB_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']);
/**
 * The report vocabulary is NOT the canonical task vocabulary, and the difference is not cosmetic: an agent answers
 * "SUCCEEDED", while the City's own task record says "COMPLETED", because the City's word describes a task reaching a
 * terminal state and the agent's describes the agent's own outcome. Translating between them in ONE named table is what
 * keeps a report from being compared against the wrong word.
 */
export const REPORT_STATE_TO_TASK_STATE = Object.freeze({SUCCEEDED: 'COMPLETED', FAILED: 'FAILED', CANCELLED: 'CANCELLED'});
/**
 * And this is WHO DECIDES WHAT. An agent may report an OUTCOME and nothing else: a cancellation is the owner's decision
 * and an expiry is the City's decision about its own deadline, so neither travels in a report. Stating the boundary as
 * a list means "the agent may not declare this" is answered by name instead of by whichever check happens to run first.
 */
export const AGENT_REPORTABLE_STATES = Object.freeze(['SUCCEEDED', 'FAILED']);
/**
 * What kind of claim the agent is making. The City cannot verify any of these; it requires the agent to SAY which one
 * it is, so a reader is never left to assume the strongest one.
 */
export const EVIDENCE_CLASSES = Object.freeze(['OBSERVED_HERE', 'REPORTED_FROM_ELSEWHERE', 'INFERRED', 'NOT_DONE']);

const refuse = (code, message) => { throw Object.assign(new Error(message ?? code), {code}); };
const isText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const canonical = value => Array.isArray(value)
  ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object'
    ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    : JSON.stringify(value);
export const jobDigest = value => createHash('sha256').update(canonical(value)).digest('hex');

/**
 * A credential-shaped key or value is refused rather than redacted: the caller must not send one at all.
 *
 * The value pattern was WRONG in the first version of this file, and the falsification test is what found it: it ended
 * in `\b` after an alternative that ends in `_`, so `ghp_<token>` never matched - a real prefix is ALWAYS followed by
 * word characters, so the boundary the pattern demanded could not exist. Each prefix now states how many characters must
 * follow it, which is what makes "this looks like a live token" a decidable claim rather than a shape that only matches
 * a credential followed by punctuation.
 */
const CREDENTIAL_KEY = /(^|_)(token|secret|password|credential|api[_-]?key|authorization|bearer)($|_)/i;
const CREDENTIAL_VALUE = /(?:\bgh[pousr]_[A-Za-z0-9]{8,}|\bgithub_pat_[A-Za-z0-9_]{8,}|\bsk-[A-Za-z0-9_-]{12,}|\bBearer\s+[A-Za-z0-9._~+/-]{8,})/;

/**
 * Turn a requested job into the frozen form the City persists and an agent reads, or refuse by name.
 * Ownership is NOT checked here: this function is pure, and who may ask is decided by the route that calls it.
 */
export function normalizeAgentJob(spec, {enabled = false} = {}) {
  if (enabled !== true) refuse('AGENT_JOB_DISABLED', 'agent jobs are not enabled on this City');
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) refuse('JOB_SPEC_REQUIRED');
  if (!isText(spec.title, 200)) refuse('JOB_TITLE_REQUIRED', 'a job needs a short title');
  if (!isText(spec.instruction, MAX_STATEMENT_LENGTH)) refuse('JOB_INSTRUCTION_REQUIRED', 'a job must say what to do, in words');
  if (!isText(spec.purpose, 500)) refuse('JOB_PURPOSE_REQUIRED', 'a job must say why it is being asked for');

  const inputs = spec.inputs === undefined ? [] : spec.inputs;
  if (!Array.isArray(inputs) || inputs.length > MAX_INPUTS) refuse('JOB_INPUTS_INVALID', `inputs must be an array of at most ${MAX_INPUTS} entries`);
  for (const [index, input] of inputs.entries()) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) refuse('JOB_INPUTS_INVALID', `inputs[${index}] must be an object`);
    if (!isText(input.name, 120)) refuse('JOB_INPUTS_INVALID', `inputs[${index}].name is required`);
    // A credential is refused BY NAME before its value is even looked at, because the shape of the mistake is the key.
    if (CREDENTIAL_KEY.test(input.name.replace(/[^A-Za-z0-9_]/g, '_'))) refuse('JOB_INPUT_CREDENTIAL_REFUSED', `inputs[${index}] looks like a credential; a job record is not a secret store`);
    const hasText = typeof input.text === 'string';
    const hasRef = isText(input.ref, 512);
    if (hasText === hasRef) refuse('JOB_INPUTS_INVALID', `inputs[${index}] must carry exactly one of text or ref`);
    if (hasText) {
      if (input.text.length > 16000) refuse('JOB_INPUT_TOO_LONG', `inputs[${index}].text is too long`);
      if (CREDENTIAL_VALUE.test(input.text)) refuse('JOB_INPUT_CREDENTIAL_REFUSED', `inputs[${index}] contains what looks like a live credential`);
    }
  }

  const expect = spec.expect === undefined ? null : spec.expect;
  if (expect !== null && !isText(expect, 2000)) refuse('JOB_EXPECT_INVALID', 'expect must be a short statement of what the report should contain');

  const deadlineMs = spec.deadlineMs === undefined ? DEFAULT_DEADLINE_MS : spec.deadlineMs;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) refuse('JOB_DEADLINE_INVALID', 'deadlineMs must be a positive integer');
  if (deadlineMs > MAX_DEADLINE_MS) refuse('JOB_DEADLINE_EXCEEDS_LIMIT', `deadlineMs exceeds the ${MAX_DEADLINE_MS} ms ceiling`);

  // An environment/intent field the City does not model is refused rather than ignored: a job that silently drops half
  // of what the owner asked for is worse than one that is refused and can be corrected.
  const ALLOWED = ['title', 'instruction', 'purpose', 'inputs', 'expect', 'deadlineMs'];
  const unknown = Object.keys(spec).filter(key => !ALLOWED.includes(key));
  if (unknown.length) refuse('JOB_UNKNOWN_FIELD', `unknown field(s): ${unknown.join(', ')}`);

  const body = {schemaVersion: AGENT_JOB_VERSION, title: spec.title, instruction: spec.instruction, purpose: spec.purpose,
    inputs: Object.freeze(inputs.map(i => Object.freeze(i.text !== undefined ? {name: i.name, text: i.text} : {name: i.name, ref: i.ref}))),
    expect, deadlineMs};
  return Object.freeze({...body, jobDigest: jobDigest(body)});
}

/**
 * The City's check on what an agent sent back. A report is an OBSERVATION by a participant whose internals the City
 * cannot see, so this validates the SHAPE and the honesty of the claim - never its truth. `authority` is false on
 * every accepted report, and the evidence class is required so a report cannot arrive looking stronger than it is.
 */
export function validateAgentJobReport(job, report, {now = Date.now()} = {}) {
  const fail = code => Object.freeze({valid: false, code, acceptanceAuthority: false});
  try {
    if (!job || typeof job !== 'object') return fail('JOB_REQUIRED');
    if (!report || typeof report !== 'object' || Array.isArray(report)) return fail('REPORT_REQUIRED');
    if (report.jobDigest !== job.jobDigest) return fail('REPORT_JOB_MISMATCH');
    if (!TERMINAL_JOB_STATES.includes(report.state)) return fail('REPORT_STATE_INVALID');
    if (!EVIDENCE_CLASSES.includes(report.evidence)) return fail('REPORT_EVIDENCE_CLASS_REQUIRED');
    if (typeof report.summary !== 'string' || report.summary.length > MAX_REPORT_SUMMARY) return fail('REPORT_SUMMARY_REQUIRED');
    const artifacts = report.artifacts ?? [];
    if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACTS) return fail('REPORT_ARTIFACTS_INVALID');
    for (const [index, artifact] of artifacts.entries()) {
      if (!artifact || typeof artifact !== 'object' || !isText(artifact.name, 200)) return fail('REPORT_ARTIFACTS_INVALID');
      // A digest is REQUIRED for an artifact: "here is a file" without its hash cannot be compared with anything, and
      // the REX-890 reproduction exists precisely to compare bytes.
      if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) return fail('REPORT_ARTIFACT_DIGEST_REQUIRED');
    }
    // A job that was asked for and came back NOT_DONE is a legitimate answer; one that came back NOT_DONE yet claims
    // SUCCEEDED is two contradictory statements, and the shape is refused rather than reinterpreted.
    if (report.state === 'SUCCEEDED' && report.evidence === 'NOT_DONE') return fail('REPORT_SUCCEEDED_BUT_NOT_DONE');
    if (report.state === 'FAILED' && !isText(report.reason ?? '', 2000)) return fail('REPORT_FAILURE_REASON_REQUIRED');
    return Object.freeze({valid: true, state: report.state, evidence: report.evidence,
      artifacts: artifacts.length, summaryBytes: Buffer.byteLength(report.summary),
      // Stated on every accepted report so a reader cannot mistake it for a verification.
      acceptanceAuthority: false,
      verification: 'AGENT_OBSERVATION_NOT_CITY_VERIFICATION'});
  } catch { return fail('REPORT_UNREADABLE'); }
}

/** A job whose deadline has passed is EXPIRED, and saying so is the City's job rather than the agent's. */
export const isJobExpired = (job, now = Date.now()) => Boolean(job) && !TERMINAL_JOB_STATES.includes(job.state)
  && Number.isFinite(Date.parse(job.createdAt)) && now - Date.parse(job.createdAt) > job.deadlineMs;

/**
 * Taking delivery of a report is its OWN act with its OWN record, not a flag on the job.
 *
 * "The agent answered" and "the answer was taken" are different facts, and an answer nobody has taken delivery of is
 * exactly the one that gets asked for twice: without a receipt there is no way to tell a report that was read and acted
 * on from one that is still sitting there, and no way for the far side to know its work was received at all.
 *
 * It is also the one place PCF-715's rule lands directly: A CALLER ACKNOWLEDGING A RESULT IS NOT THE AGENT CONSUMING IT.
 * So the receipt says which of those it is (`authority`), states that it is not a verification, and carries
 * `agentConsumption: false` rather than leaving a reader to infer that delivery meant agreement.
 */
export const CONSUMPTION_AUTHORITY = 'ACKNOWLEDGEMENT_NOT_VERIFICATION';

/**
 * The receipt, derived rather than invented. Every field is either an input or a consequence of one, and `receiptDigest`
 * covers the whole thing so two receipts can be compared without trusting either copy.
 *
 * `reportDigest` binds it to the EXACT report that was stored, which is what stops a receipt being moved to a different
 * answer: the City re-derives it from the report it holds, so a receipt that does not match the stored bytes is
 * detectable rather than merely unlikely.
 */
export function consumptionReceipt({taskId, job, report, consumedAt, consumedBy, note = null}) {
  const body = {schemaVersion: AGENT_JOB_VERSION, taskId, jobDigest: job?.jobDigest ?? null,
    reportDigest: report === undefined || report === null ? null : jobDigest(report),
    consumedAt, consumedBy, note,
    authority: CONSUMPTION_AUTHORITY,
    verification: 'AGENT_OBSERVATION_NOT_CITY_VERIFICATION',
    // Said out loud because the tempting misreading is that taking delivery means the City accepted the claim.
    agentConsumption: false};
  return Object.freeze({...body, receiptDigest: jobDigest(body)});
}

/**
 * A receipt may only be issued for a report that EXISTS and passes the same validation the City applied when it arrived.
 * A job with no report has nothing to take delivery of, and saying so by name is the difference between "you collected
 * nothing" and "there was nothing to collect".
 */
export function validateConsumptionRequest(job, report) {
  if (!job || typeof job !== 'object') return Object.freeze({ok: false, code: 'JOB_REQUIRED'});
  if (report === undefined || report === null) return Object.freeze({ok: false, code: 'CONSUMPTION_REQUIRES_A_REPORT'});
  const verdict = validateAgentJobReport(job, report);
  if (verdict.valid !== true) return Object.freeze({ok: false, code: verdict.code});
  return Object.freeze({ok: true, code: null});
}

export const AGENT_JOB_EXPOSURE = Object.freeze({
  capabilityId: 'CAP-CITY-AGENT-JOB-001',
  exposureClass: 'DIRECT_CONTROL',
  surface: 'CITY_ADVANCED',
  nesting: 'L4_TECHNICAL',
  requiresConfirmation: true,
  cancellable: true,
  defaultEnabled: false,
});
