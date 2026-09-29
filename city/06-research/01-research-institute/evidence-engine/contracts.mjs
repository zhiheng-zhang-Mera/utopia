/**
 * UTOPIA · Research Institute — evidence contracts.
 *
 * The value shapes an evidence review is built from, expressed as data plus small
 * validators. Nothing here is a runtime: there is no task scheduler, no provider
 * automation, no council process and no root trust, because an evidence record must
 * be readable on its own, years later, without the machinery that produced it.
 *
 * Reference (not copied): Codex-Boss `src/shared/contracts.ts` and
 * `src/shared/provider-contracts.ts` @
 * 8df428eaa437a409368401e95194e40266b83080, reduced to the fields an evidence
 * bundle actually needs. The donor's BossTask runtime, provider contracts, council
 * session and root trust are deliberately out of scope.
 *
 * Vocabulary:
 *   EvidenceTask      what was asked, and which providers were expected to answer
 *   EvidenceArtifact  one captured document: who produced it, when, and its hash
 *   EvidenceClaim     one structured assertion, its evidence and its status
 *   EvidenceDispute   a recorded disagreement, with the positions and its state
 *   EvidenceBundle    the immutable record: manifest, integrityRoot, claims,
 *                     disputes, missing providers and the decision
 */

/** Artifact kinds an evidence review understands. */
export const ARTIFACT_KINDS = Object.freeze(['proposal', 'response', 'synthesis', 'peer_review']);

/**
 * Claim statuses, in the order they are reported.
 *
 *   REFERENCED_NOT_VERIFIED  every declared evidence label resolves; the claim is
 *                            referenced, and nothing here claims it is *true*
 *   UNVERIFIED               a claim that has no structured evidence block at all
 *   DISPUTED                 a recorded dispute names the claim's topic
 *   INSUFFICIENT             a declared label does not resolve, or no label was given
 */
export const CLAIM_STATUSES = Object.freeze(['UNVERIFIED', 'REFERENCED_NOT_VERIFIED', 'DISPUTED', 'INSUFFICIENT']);

/** Statuses that block a PASS. */
export const BLOCKING_CLAIM_STATUSES = Object.freeze(['DISPUTED', 'INSUFFICIENT']);

/** The two decisions an evidence bundle may reach. */
export const DECISIONS = Object.freeze(['PASS', 'HOLD_FOR_REVIEW']);

/** The one claim status that counts as a resolved reference. */
export const REFERENCED_STATUS = 'REFERENCED_NOT_VERIFIED';

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

/**
 * Validate an evidence task.
 *
 * @param {{id?: string, prompt: string, providerIds: string[]}} task
 */
export function evidenceTask(task) {
  if (task === null || typeof task !== 'object' || Array.isArray(task)) throw new TypeError('task must be an object');
  const providerIds = requireArray(task.providerIds ?? [], 'task.providerIds').map((providerId) => requireText(providerId, 'task.providerIds[]'));
  if (new Set(providerIds).size !== providerIds.length) throw new TypeError('task.providerIds must be unique');
  return {
    id: requireText(task.id ?? 'task', 'task.id'),
    prompt: requireText(task.prompt, 'task.prompt'),
    providerIds,
  };
}

/**
 * Validate one artifact and compute the hash that identifies it.
 *
 * `contentHash`, when the caller supplies it, is the hash recorded at capture: it is
 * what makes tampering visible later, so it is carried verbatim and never rewritten
 * here.
 */
export function evidenceArtifact(artifact, { sha256 } = {}) {
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) throw new TypeError('artifact must be an object');
  const content = typeof artifact.content === 'string' ? artifact.content : '';
  const kind = requireText(artifact.kind, 'artifact.kind');
  if (!ARTIFACT_KINDS.includes(kind)) throw new TypeError(`artifact.kind must be one of ${ARTIFACT_KINDS.join(', ')}`);
  const computed = typeof sha256 === 'function' ? sha256(content) : null;
  return {
    id: requireText(artifact.id, 'artifact.id'),
    taskId: requireText(artifact.taskId, 'artifact.taskId'),
    providerId: requireText(artifact.providerId, 'artifact.providerId'),
    kind,
    content,
    contentHash: typeof artifact.contentHash === 'string' && artifact.contentHash ? artifact.contentHash : computed,
    capturedAt: requireText(artifact.capturedAt, 'artifact.capturedAt'),
  };
}

/** Validate a recorded dispute. */
export function evidenceDispute(dispute) {
  if (dispute === null || typeof dispute !== 'object' || Array.isArray(dispute)) throw new TypeError('dispute must be an object');
  const positions = requireArray(dispute.positions ?? [], 'dispute.positions').map((position) => requireText(position, 'dispute.positions[]'));
  return {
    topic: requireText(dispute.topic, 'dispute.topic'),
    positions,
    resolved: dispute.resolved === true,
  };
}

/** A claim's status, judged from its evidence and the disputes that name it. */
export function claimStatus({ resolvedIds, missingLabels, disputed }) {
  if (disputed) return 'DISPUTED';
  if (missingLabels.length > 0) return 'INSUFFICIENT';
  if (resolvedIds.length > 0) return REFERENCED_STATUS;
  return 'INSUFFICIENT';
}

/** Is this bundle's decision a PASS? Only an exact, honest match counts. */
export function isPass(decision) {
  if (!DECISIONS.includes(decision)) throw new TypeError(`decision must be one of ${DECISIONS.join(', ')}`);
  return decision === 'PASS';
}
