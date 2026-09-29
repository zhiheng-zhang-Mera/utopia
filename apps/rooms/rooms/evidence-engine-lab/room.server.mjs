/**
 * UTOPIA · Rooms · Room D8 — Evidence Engine Lab (server).
 *
 * Incubator for the evidence engine: build a sample evidence task, add
 * proposal/response/synthesis/peer_review artifacts, and see the manifest, the
 * integrityRoot, every claim with its status, the disputes, the providers that
 * produced nothing and the resulting PASS/HOLD decision. Tampering with an artifact
 * after capture is visible and fails closed.
 *
 * Donor: zhiheng-zhang-Mera/Codex-Boss @ 8df428eaa437a409368401e95194e40266b83080
 *        electron/evidence-engine.ts
 *
 * The room is a product surface, not a runtime: it never contacts a provider, never
 * schedules a task and never writes a file.
 */

import { createRouter, sendJson } from '../../shared/http.mjs';
import { RoomValidationError } from '../../shared/room-kit.mjs';
import {
  ARTIFACT_KINDS,
  CLAIM_STATUSES,
  DECISIONS,
  ArtifactIntegrityError,
  buildEvidenceBundle,
  buildRehydrationPrompts,
  describeBundle,
  evidenceArtifact,
  parseStructuredClaims,
  sha256,
  verifyArtifact,
} from './evidence-engine.mjs';

const DONOR = Object.freeze({
  repository: 'zhiheng-zhang-Mera/Codex-Boss',
  commit: '8df428eaa437a409368401e95194e40266b83080',
  sourcePaths: ['electron/evidence-engine.ts'],
  referenceTypes: ['src/shared/contracts.ts', 'src/shared/provider-contracts.ts'],
});

/** The sample task: three providers, one of which is expected to stay silent. */
export const SAMPLE_TASK = Object.freeze({
  id: 'task-shelf-review',
  prompt: 'Review whether the trust shelf still carries a verified anchor, and state what remains unknown.',
  providerIds: ['provider-alpha', 'provider-beta', 'provider-gamma'],
});

/** A synthesis document with a structured claims block, exactly as the donor reads it. */
export function sampleSynthesis() {
  return [
    'Synthesis of the two proposals.',
    '',
    JSON.stringify({
      claims: [
        { text: 'The trust anchor is still valid across both proposals.', evidenceLabels: ['Proposal A', 'Proposal B'] },
        { text: 'The memory shelf was re-indexed after the last release.', evidenceLabels: ['Proposal C'] },
        { text: 'Nothing in the proposals contradicts the retention policy.', evidenceLabels: [] },
      ],
    }),
    '',
    'End of synthesis.',
  ].join('\n');
}

/** The four artifacts a default sample task carries. */
export function sampleArtifacts() {
  const capturedAt = '2026-09-29T00:00:00.000Z';
  const artifacts = [
    {
      id: 'artifact-a-proposal',
      taskId: SAMPLE_TASK.id,
      providerId: 'provider-alpha',
      kind: 'proposal',
      content: 'Proposal A: keep the anchor and re-verify it quarterly.',
      capturedAt,
    },
    {
      id: 'artifact-b-proposal',
      taskId: SAMPLE_TASK.id,
      providerId: 'provider-beta',
      kind: 'proposal',
      content: 'Proposal B: keep the anchor, but add a second witness whenever the shelf changes.',
      capturedAt,
    },
    {
      id: 'artifact-c-response',
      taskId: SAMPLE_TASK.id,
      providerId: 'provider-alpha',
      kind: 'response',
      content: 'Response without a structured claims block.',
      capturedAt,
    },
    {
      id: 'artifact-d-synthesis',
      taskId: SAMPLE_TASK.id,
      providerId: 'provider-alpha',
      kind: 'synthesis',
      content: sampleSynthesis(),
      capturedAt,
    },
  ];
  // Every artifact records its own hash at capture: that is what makes tampering
  // visible later.
  return artifacts.map((artifact) => ({ ...artifact, contentHash: sha256(artifact.content) }));
}

function requireObject(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RoomValidationError('payload must be a JSON object');
  }
  return payload;
}

function requireArtifacts(payload) {
  if (!Array.isArray(payload.artifacts)) throw new RoomValidationError('artifacts must be an array');
  if (payload.artifacts.length > 200) throw new RoomValidationError('artifacts must be at most 200 entries', 413);
  for (const artifact of payload.artifacts) {
    if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
      throw new RoomValidationError('every artifact must be a JSON object');
    }
    if (typeof artifact.content !== 'string') throw new RoomValidationError('every artifact needs string content');
    if (artifact.content.length > 200000) throw new RoomValidationError('artifact content must be at most 200000 characters', 413);
  }
  return payload.artifacts;
}

function requireDisputes(payload) {
  if (payload.disputes === undefined || payload.disputes === null) return [];
  if (!Array.isArray(payload.disputes)) throw new RoomValidationError('disputes must be an array');
  return payload.disputes;
}

/** Build a bundle from a request body, reporting refusals as product answers. */
function buildFrom(payload) {
  const task = payload.task ?? SAMPLE_TASK;
  const artifacts = requireArtifacts(payload);
  const disputes = requireDisputes(payload);
  try {
    const bundle = buildEvidenceBundle({ task, artifacts, disputes, previousReview: payload.previousReview ?? null });
    return {
      ok: true,
      bundle,
      summary: describeBundle(bundle),
      verified: bundle.manifest.map((entry) => ({ artifactId: entry.artifactId, sha256: entry.sha256, bytes: entry.bytes })),
    };
  } catch (error) {
    if (error instanceof ArtifactIntegrityError) {
      return {
        ok: false,
        code: error.code,
        reason: error.message,
        artifactId: error.artifactId,
        stored: error.stored,
        computed: error.computed,
      };
    }
    return { ok: false, code: 'BUNDLE_REFUSED', reason: String(error?.message || error) };
  }
}

/** Create the Evidence Engine Lab route handler (no durable store). */
export function createEvidenceEngineRoom() {
  const route = createRouter([
    {
      method: 'GET',
      pattern: '/capabilities',
      handle: async ({ res }) => {
        sendJson(res, 200, {
          room: 'evidence-engine-lab',
          installs: false,
          writes_files: false,
          contacts_providers: false,
          donor: DONOR,
          artifact_kinds: ARTIFACT_KINDS,
          claim_statuses: CLAIM_STATUSES,
          decisions: DECISIONS,
          pass_rule: 'PASS requires no missing provider, no unresolved dispute, and no DISPUTED or INSUFFICIENT claim',
          reference: 'src/shared/contracts.ts and src/shared/provider-contracts.ts are reference types only; no Boss runtime is carried',
          sample_task: SAMPLE_TASK,
        });
      },
    },
    {
      method: 'GET',
      pattern: '/task/sample',
      handle: async ({ res }) => {
        const artifacts = sampleArtifacts();
        sendJson(res, 200, {
          ok: true,
          task: SAMPLE_TASK,
          artifacts,
          synthesis: sampleSynthesis(),
          hashes: artifacts.map((artifact) => ({ artifactId: artifact.id, sha256: artifact.contentHash, bytes: Buffer.byteLength(artifact.content, 'utf8') })),
        });
      },
    },
    {
      method: 'POST',
      pattern: '/bundle/build',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        sendJson(res, 200, buildFrom(payload));
      },
    },
    {
      method: 'POST',
      pattern: '/artifact/verify',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        if (payload.artifact === undefined || payload.artifact === null) throw new RoomValidationError('artifact is required');
        sendJson(res, 200, { ok: true, verification: verifyArtifact(payload.artifact) });
      },
    },
    {
      method: 'POST',
      pattern: '/artifact/tamper',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        if (typeof payload.artifactId !== 'string') throw new RoomValidationError('artifactId is required');
        const replacement = typeof payload.content === 'string' ? payload.content : 'Tampered after capture: the record no longer matches its hash.';
        const artifacts = sampleArtifacts().map((artifact) => (
          artifact.id === payload.artifactId ? { ...artifact, content: replacement } : artifact
        ));
        if (!artifacts.some((artifact) => artifact.id === payload.artifactId)) {
          throw new RoomValidationError(`unknown artifactId ${payload.artifactId}`);
        }
        // The bundle refuses this input: the room reports the refusal, it never
        // re-hashes the mutated content.
        sendJson(res, 200, buildFrom({ task: SAMPLE_TASK, artifacts, disputes: [] }));
      },
    },
    {
      method: 'POST',
      pattern: '/claims/parse',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        if (typeof payload.content !== 'string') throw new RoomValidationError('content must be a string');
        sendJson(res, 200, { ok: true, claims: parseStructuredClaims(payload.content) });
      },
    },
    {
      method: 'POST',
      pattern: '/claims/rehydrate',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const built = buildFrom(payload);
        if (built.ok === false) {
          sendJson(res, 200, built);
          return;
        }
        const prompts = buildRehydrationPrompts({
          task: payload.task ?? SAMPLE_TASK,
          bundle: built.bundle,
          artifacts: requireArtifacts(payload),
          providerIds: payload.providerIds ?? (payload.task ?? SAMPLE_TASK).providerIds,
        });
        sendJson(res, 200, { ok: true, targets: built.bundle.claims.filter((claim) => claim.status === 'DISPUTED' || claim.status === 'INSUFFICIENT').length, prompts: Object.fromEntries(prompts) });
      },
    },
  ]);

  return { id: 'evidence-engine-lab', handle: route };
}

export { evidenceArtifact, sha256 };
