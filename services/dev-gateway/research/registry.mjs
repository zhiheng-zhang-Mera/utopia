/**
 * UTOPIA · Experiment Registry (REX-801).
 *
 * A register of *described* experiments. It stores manifests and their validation verdicts, answers list/inspect,
 * and produces the deterministic seed sequence a run would use. That is the whole responsibility.
 *
 * WHY IT IS FILE-BACKED AND NOT IN THE CITY STORE. The City's store is the canonical task/node/action truth and
 * every table in it is keyed by a task-shaped `id`. Putting experiment descriptions there would mean either
 * pretending a manifest is a task record or adding a research table to the task schema — both of which erode the
 * boundary this task exists to hold. An experiment description is a *document*, so it is stored as one, under
 * `.runtime/research/experiments/`, written atomically (temp file + rename) so a crash cannot leave a half-written
 * manifest behind.
 *
 * WHAT IT DELIBERATELY CANNOT DO:
 *
 *  * **It cannot become a task database.** `register` refuses any manifest carrying task-domain keys, and there is
 *    no API here that assigns, leases, claims or completes work. A caller looking for "run this experiment" will
 *    not find it, and that absence is the design: REX-803 owns execution.
 *  * **It cannot rewrite a registered manifest.** `update` does not exist. A describe-before-you-run registry
 *    whose description can be edited afterwards cannot support a reproducibility claim, so a changed manifest must
 *    be a new experiment id: re-registering the same id with different content is `IMMUTABLE_MANIFEST`, while an
 *    identical re-registration is idempotent (and reports `replayed: true`).
 *  * **It cannot fabricate.** Registration validates first, and a rejected manifest is STORED as a rejection with
 *    its issue list rather than dropped or repaired. Refusals are evidence.
 *
 * PURITY: no clock is read for validation; `now` is injected and only stamps records. No randomness anywhere.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  EXPERIMENT_MANIFEST_CONTRACT_VERSION,
  EXPERIMENT_STATUSES,
  ExperimentManifestError,
  assertNotATaskStore,
  seedSequence,
  validateExperimentManifest,
} from '../../../contracts/experiment-manifest-v1/manifest.mjs';

/** The filename shape a stored experiment must have. A stray file is not silently adopted as an experiment. */
const RECORD_FILE = /^([a-z][a-z0-9-]{2,63})\.json$/;

const freeze = value => {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};

/**
 * @param {object} deps
 * @param {string}  deps.dir                  where experiment documents live (usually `<runtime>/research/experiments`)
 * @param {string[]} deps.knownCapabilities   the City's real capability ids, supplied as data
 * @param {object}   [deps.knownTopologies]   topology vocabulary (injected for tests)
 * @param {() => string} [deps.now]           timestamp source, injected
 */
export function createExperimentRegistry({ dir, knownCapabilities = [], knownTopologies, now = () => new Date().toISOString() } = {}) {
  if (typeof dir !== 'string' || dir.trim().length === 0) throw new ExperimentManifestError('INVALID_MANIFEST', 'the experiment registry needs a directory');
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });

  const pathOf = experimentId => join(root, `${experimentId}.json`);

  /**
   * Read every stored experiment. A file that cannot be parsed, or whose name is not an experiment id, is
   * REPORTED as a broken record rather than skipped: silently ignoring it would make a missing experiment look
   * like an experiment that was never created, which is the same mistake class as a silently repaired manifest.
   */
  function readAll() {
    const records = [];
    const broken = [];
    for (const name of readdirSync(root).sort()) {
      const match = RECORD_FILE.exec(name);
      if (!match) { if (name !== '.gitkeep') broken.push(freeze({ file: name, reason: 'FILE_NAME_IS_NOT_AN_EXPERIMENT_ID' })); continue; }
      try {
        const parsed = JSON.parse(readFileSync(join(root, name), 'utf8'));
        if (parsed?.experimentId !== match[1] || typeof parsed?.status !== 'string') { broken.push(freeze({ file: name, reason: 'RECORD_SHAPE_MISMATCH' })); continue; }
        records.push(parsed);
      } catch (error) {
        broken.push(freeze({ file: name, reason: `UNREADABLE:${String(error?.code ?? error?.message ?? error)}` }));
      }
    }
    return { records, broken };
  }

  const find = experimentId => {
    const path = pathOf(String(experimentId ?? ''));
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  };

  /** Atomic write: a crash mid-write leaves the previous document, never a truncated one. */
  function write(record) {
    const target = pathOf(record.experimentId);
    const temp = `${target}.tmp`;
    writeFileSync(temp, JSON.stringify(record, null, 2), { encoding: 'utf8' });
    renameSync(temp, target);
    return record;
  }

  /** Canonical serialisation: key order must not decide whether two manifests are the same manifest. */
  const canonical = value => JSON.stringify(value, (key, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner)
    ? Object.fromEntries(Object.keys(inner).sort().map(k => [k, inner[k]]))
    : inner));

  function register(input) {
    // Checked on the RAW input, before validation projects its own clean object: a manifest carrying task-domain
    // keys must be refused for what it is rather than laundered by a projection that drops unknown keys.
    assertNotATaskStore(input);
    const verdict = validateExperimentManifest(input, { knownCapabilities, ...(knownTopologies ? { knownTopologies } : {}) });

    if (!verdict.ok) {
      const rejected = {
        experimentId: typeof input?.experimentId === 'string' && RECORD_FILE.test(`${input.experimentId}.json`) ? input.experimentId : null,
        status: 'REJECTED',
        contractVersion: EXPERIMENT_MANIFEST_CONTRACT_VERSION,
        registeredAt: now(),
        manifest: null,
        issues: verdict.issues,
        inputDigest: canonical(input ?? null),
      };
      // A rejection with no storable identity is returned, not written: there is no filename for it, and
      // inventing one would put a nameless experiment into the register.
      if (rejected.experimentId === null) return { record: freeze(rejected), verdict, replayed: false, persisted: false };
      const prior = find(rejected.experimentId);
      if (prior?.status === 'VALIDATED') throw new ExperimentManifestError('IMMUTABLE_MANIFEST', `experiment ${rejected.experimentId} is already registered as a valid manifest; a rejection may not replace it`);
      if (prior?.status === 'REJECTED' && prior.inputDigest === rejected.inputDigest) return { record: freeze(prior), verdict, replayed: true, persisted: true };
      write(rejected);
      return { record: freeze(rejected), verdict, replayed: false, persisted: true };
    }

    const prior = find(verdict.manifest.experimentId);
    const digest = canonical(verdict.manifest);
    if (prior?.status === 'VALIDATED') {
      if (prior.digest === digest) return { record: freeze(prior), verdict, replayed: true, persisted: true };
      throw new ExperimentManifestError('IMMUTABLE_MANIFEST', `experiment ${verdict.manifest.experimentId} is already registered with different content; use a new experiment id rather than editing a description that has already been published`);
    }
    const record = {
      experimentId: verdict.manifest.experimentId,
      status: 'VALIDATED',
      contractVersion: EXPERIMENT_MANIFEST_CONTRACT_VERSION,
      registeredAt: now(),
      manifest: verdict.manifest,
      digest,
      issues: [],
    };
    write(record);
    return { record: freeze(record), verdict, replayed: false, persisted: true };
  }

  /** Validate without registering. This is the "validate before run" entry. */
  function validate(input) {
    const verdict = validateExperimentManifest(input, { knownCapabilities, ...(knownTopologies ? { knownTopologies } : {}) });
    return freeze({
      ok: verdict.ok,
      issues: verdict.issues,
      experimentId: verdict.manifest?.experimentId ?? null,
      registered: find(verdict.manifest?.experimentId ?? '') !== null,
      // Stated so a caller can tell validation from registration, and neither of them from execution.
      registeredNothing: true,
      executesNothing: true,
    });
  }

  function get(experimentId) {
    const record = find(String(experimentId ?? ''));
    if (!record) throw new ExperimentManifestError('NOT_REGISTERED', `no experiment ${String(experimentId)} is registered`, [], { experimentId: String(experimentId ?? '') });
    return freeze(record);
  }

  function list({ status = null } = {}) {
    const { records, broken } = readAll();
    const filtered = status === null ? records : records.filter(record => record.status === status);
    return freeze({
      experiments: freeze(filtered
        .slice()
        .sort((left, right) => String(left.experimentId).localeCompare(String(right.experimentId)))
        .map(record => freeze({
          experimentId: record.experimentId,
          status: record.status,
          contractVersion: record.contractVersion,
          registeredAt: record.registeredAt,
          question: record.manifest?.question ?? null,
          topology: record.manifest?.topology ?? null,
          repetitions: record.manifest?.repetitions ?? null,
          seedPolicy: record.manifest?.seedPolicy ?? null,
          requiredCapabilities: record.manifest?.requiredCapabilities ?? freeze([]),
          softwareRefs: record.manifest?.softwareRefs ?? freeze([]),
          issueCount: (record.issues ?? []).length,
        }))),
      // Broken files are surfaced, never hidden.
      broken,
    });
  }

  /** The seed sequence a run of this experiment must use. Deterministic, computed on demand, stored nowhere. */
  function seeds(experimentId, { repetitions = null } = {}) {
    const record = get(experimentId);
    if (record.status !== 'VALIDATED') {
      throw new ExperimentManifestError('NOT_REGISTERED', `experiment ${String(experimentId)} was rejected and has no seed sequence`, record.issues ?? []);
    }
    const sequence = seedSequence(record.manifest, repetitions);
    return freeze({ experimentId: record.experimentId, repetitions: sequence.length, seedPolicy: record.manifest.seedPolicy, baseSeed: record.manifest.baseSeed, sequence });
  }

  return Object.freeze({
    contractVersion: EXPERIMENT_MANIFEST_CONTRACT_VERSION,
    directory: root,
    register,
    validate,
    get,
    list,
    seeds,
    statuses: EXPERIMENT_STATUSES,
    // Diagnostics for the review: the registry can state what it is NOT.
    ownsTaskState: false,
    grantsFaultAuthority: false,
    editableAfterRegistration: false,
  });
}
