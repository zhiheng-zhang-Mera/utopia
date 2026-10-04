/**
 * UTOPIA · Experiment Manifest Contract v1 (REX-801).
 *
 * WHY THIS EXISTS. A research claim is only reproducible if the experiment that produced it is *described*
 * before it runs: which question, on which topology, varying what, measuring what, against which controls, for
 * how many repetitions, with which seed, needing which capabilities, stopping when, keeping which artifacts, and
 * on exactly which software. Without a machine-readable manifest, every one of those becomes prose in a report
 * and the "repetition" is a re-invention rather than a reproduction.
 *
 * WHAT THIS CONTRACT IS NOT.
 *
 *  * **Not a second task database.** A manifest describes an experiment; it does not own work, leases,
 *    assignments or results. The canonical task truth stays where it is. The registry built on this contract
 *    refuses, by name, the keys that would turn it into one.
 *  * **Not a fault authorisation.** A manifest may *reference* a fault profile. Referencing is not permission:
 *    nothing here grants, schedules or enables an injected fault, and a fault profile ref is carried as an
 *    opaque string that this module never resolves into authority.
 *  * **Not a default factory.** Missing is missing. Every required field that is absent produces a typed issue;
 *    this contract never invents a repetition count, a metric, a seed or an acceptance criterion to make a
 *    manifest "valid enough". That prohibition is the workbook's, and it is the single most important property
 *    of this module: a fabricated default is indistinguishable from a measurement once it is stored.
 *
 * PURITY. No clock, no storage, no network, no randomness. Capability ids and topology availability are SUPPLIED,
 * so the same manifest validates identically on any host and the same seed policy yields the same seeds forever.
 */

export const EXPERIMENT_MANIFEST_CONTRACT_VERSION = 1;

/**
 * Topologies this release can honestly describe, each with the shape it *requires*. A topology is not a label:
 * declaring `TWO_HOST_MESH` while describing one host is an impossible topology, not a typo to smooth over.
 */
export const TOPOLOGIES = Object.freeze({
  SINGLE_CITY: Object.freeze({ minHosts: 1, maxHosts: 1, minWorkers: 0, minControlSurfaces: 1, description: 'one City process with at least one attached control surface' }),
  TWO_HOST_MESH: Object.freeze({ minHosts: 2, maxHosts: 2, minWorkers: 2, minControlSurfaces: 1, description: 'two physical hosts, each running a real worker, sharing one canonical City' }),
  THREE_SURFACE_MESH: Object.freeze({ minHosts: 2, maxHosts: 2, minWorkers: 2, minControlSurfaces: 3, description: 'the two-host mesh plus a third independent control surface (the MESH-301 shape)' }),
  ANDROID_CONTROL_SURFACE: Object.freeze({ minHosts: 1, maxHosts: 1, minWorkers: 0, minControlSurfaces: 1, requiresAndroidControl: true, description: 'one City whose control surface is a real Android device' }),
});

/** Node roles a topology may require. Mirrors the City node vocabulary; no new roles are invented here. */
export const TOPOLOGY_ROLES = Object.freeze(['EXECUTION_NODE', 'CONTROL_SURFACE', 'VALIDATION_NODE']);

/** Seed policies. Every one of them must be deterministic; `deriveSeed` is pure for all of them. */
export const SEED_POLICIES = Object.freeze(['FIXED', 'PER_REPETITION', 'PER_VARIANT']);

/** Stop conditions this release understands. A condition outside this set is refused, not ignored. */
export const STOP_CONDITION_KINDS = Object.freeze([
  'MAX_REPETITIONS', 'MAX_WALL_CLOCK_MS', 'MAX_FAILURES', 'MIN_SUCCESSFUL_RUNS', 'MANUAL',
]);

/** Artifact retention levels. `NONE` is explicit rather than a missing field. */
export const ARTIFACT_RETENTION = Object.freeze(['NONE', 'SUMMARY_ONLY', 'BOUNDED_TRACE', 'FULL']);

/** Manifest lifecycle inside the registry. There is deliberately no RUNNING or COMPLETED here. */
export const EXPERIMENT_STATUSES = Object.freeze(['REGISTERED', 'VALIDATED', 'REJECTED']);

export const EXPERIMENT_MANIFEST_CODES = Object.freeze([
  'INVALID_MANIFEST', 'INCOMPATIBLE_CONTRACT', 'MISSING_FIELD', 'INVALID_FIELD', 'UNKNOWN_TOPOLOGY',
  'TOPOLOGY_IMPOSSIBLE', 'DUPLICATE_EXPERIMENT_ID', 'UNKNOWN_CAPABILITY', 'CONFLICTING_VARIABLES',
  'DUPLICATE_VARIABLE', 'UNKNOWN_SEED_POLICY', 'UNKNOWN_STOP_CONDITION', 'UNKNOWN_ARTIFACT_RETENTION',
  'MALFORMED_SOFTWARE_REF', 'NOT_REGISTERED', 'IMMUTABLE_MANIFEST', 'NOT_A_MANIFEST_STORE',
]);

export class ExperimentManifestError extends Error {
  constructor(code, detail, issues = [], extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ExperimentManifestError';
    this.code = code;
    this.detail = detail ?? null;
    this.issues = Object.freeze([...issues]);
    this.status = code === 'NOT_REGISTERED' ? 404 : code === 'DUPLICATE_EXPERIMENT_ID' || code === 'IMMUTABLE_MANIFEST' ? 409 : code === 'REJECTED' ? 422 : 400;
    Object.assign(this, extra);
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;

const freeze = value => {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};

/** `experiment_id` is a stable machine-readable name, not a title. */
export const EXPERIMENT_ID_SHAPE = /^[a-z][a-z0-9-]{2,63}$/;

/**
 * A full 40-character commit SHA is the only accepted code identity. A short SHA, a branch name or a tag is
 * refused by name, because a manifest whose software identity can move is not a reproducible experiment.
 */
export const SOFTWARE_REF_SHAPE = /^([a-z][a-z0-9-]{1,31})@([0-9a-f]{40}|[A-Za-z0-9._+-]{1,64})$/;

/** Parse one `component@identity` software reference. Returns a typed record, never throws on shape alone. */
export function parseSoftwareRef(raw) {
  if (!isText(raw)) throw new ExperimentManifestError('MALFORMED_SOFTWARE_REF', `software ref must be a non-empty string, got ${String(raw)}`);
  const match = SOFTWARE_REF_SHAPE.exec(raw.trim());
  if (!match) {
    throw new ExperimentManifestError('MALFORMED_SOFTWARE_REF', `software ref "${raw}" must be component@identity, where identity is a full 40-char commit SHA or a version label`);
  }
  const [, component, identity] = match;
  const commitSha = /^[0-9a-f]{40}$/.test(identity) ? identity : null;
  // A hex-looking identity that is NOT 40 characters, AND is not a well-formed version label, is the exact
  // mistake this refuses. A short SHA or a truncated paste looks authoritative and is not an immutable anchor;
  // `main` and `v1.2.3` are labels, not anchors, but they are honest labels rather than broken SHAs.
  const versionLabel = /^[vV]?\d+(\.\d+)*([-.+][A-Za-z0-9._-]+)*$/.test(identity);
  if (commitSha === null && !versionLabel && /^[0-9a-fA-F]{4,39}$/.test(identity)) {
    throw new ExperimentManifestError('MALFORMED_SOFTWARE_REF', `software ref "${raw}" looks like a short commit SHA (${identity.length} chars); an exact 40-character SHA or an explicit version label is required`);
  }
  return freeze({ component, identity, commitSha, exact: commitSha !== null });
}

/** A bounded, typed issue list is the only way validation reports a problem. */
const issue = (code, path, message) => freeze({ code, path, message });

function requireText(value, path, issues) {
  if (!isText(value)) { issues.push(issue('MISSING_FIELD', path, `${path} is required and must be a non-empty string`)); return null; }
  return value.trim();
}

function requireCount(value, path, issues, { min = 1, max = 1000 } = {}) {
  if (!Number.isSafeInteger(value)) { issues.push(issue('MISSING_FIELD', path, `${path} is required and must be a safe integer`)); return null; }
  if (value < min || value > max) { issues.push(issue('INVALID_FIELD', path, `${path} must be between ${min} and ${max}, got ${value}`)); return null; }
  return value;
}

function mapList(values, path, issues) {
  if (!Array.isArray(values) || values.length === 0) { issues.push(issue('MISSING_FIELD', path, `${path} must be a non-empty array`)); return null; }
  const out = [];
  for (const [index, value] of values.entries()) {
    if (!isText(value)) { issues.push(issue('INVALID_FIELD', `${path}[${index}]`, `${path}[${index}] must be a non-empty string`)); continue; }
    out.push(value.trim());
  }
  return out;
}

/**
 * The seed for one repetition. PURE, and derived from the manifest identity rather than from a clock or a random
 * source: the same experiment and the same repetition index must produce the same seed on any host at any time,
 * or the repetition is not a repetition.
 */
export function deriveSeed({ experimentId, seedPolicy = 'PER_REPETITION', baseSeed = 0, repetition = 0, variant = null } = {}) {
  if (!isText(experimentId)) throw new ExperimentManifestError('INVALID_MANIFEST', 'deriveSeed needs an experimentId');
  if (!SEED_POLICIES.includes(seedPolicy)) throw new ExperimentManifestError('UNKNOWN_SEED_POLICY', `unknown seed policy ${String(seedPolicy)}; known: ${SEED_POLICIES.join(', ')}`);
  if (!Number.isSafeInteger(baseSeed) || baseSeed < 0) throw new ExperimentManifestError('INVALID_FIELD', 'baseSeed must be a non-negative safe integer');
  if (!Number.isSafeInteger(repetition) || repetition < 0) throw new ExperimentManifestError('INVALID_FIELD', 'repetition must be a non-negative safe integer');
  // FNV-1a over a canonical string. Deliberately simple and dependency-free: the property that matters is that it
  // is total, deterministic and stable across processes and versions, not that it is cryptographically strong.
  let hash = 0x811c9dc5;
  const text = [experimentId, seedPolicy, String(baseSeed), seedPolicy === 'FIXED' ? '0' : seedPolicy === 'PER_VARIANT' ? String(variant ?? '') : String(repetition)].join('\u0000');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The complete seed sequence a run of this manifest must use, one entry per repetition. */
export function seedSequence(manifest, repetitions = null) {
  const total = repetitions ?? manifest?.repetitions;
  if (!Number.isSafeInteger(total) || total < 1) throw new ExperimentManifestError('INVALID_MANIFEST', 'seedSequence needs a positive repetition count');
  const variants = manifest?.variables?.independent ?? [];
  return freeze(Array.from({ length: total }, (_, index) => freeze({
    repetition: index,
    variant: manifest?.seedPolicy === 'PER_VARIANT' ? (variants[index % Math.max(1, variants.length)] ?? null) : null,
    seed: deriveSeed({
      experimentId: manifest.experimentId,
      seedPolicy: manifest.seedPolicy,
      baseSeed: manifest.baseSeed ?? 0,
      repetition: index,
      variant: variants[index % Math.max(1, variants.length)] ?? null,
    }),
  })));
}

/** The variables block. Independent, dependent and control sets must be disjoint — a variable cannot be both. */
export function experimentVariables({ independent = [], dependent = [], controls = [] } = {}) {
  const issues = [];
  const read = (values, path) => {
    if (!Array.isArray(values)) { issues.push(issue('INVALID_FIELD', path, `${path} must be an array`)); return []; }
    const out = [];
    for (const [index, value] of values.entries()) {
      if (!isText(value)) { issues.push(issue('INVALID_FIELD', `${path}[${index}]`, `${path}[${index}] must be a non-empty string`)); continue; }
      out.push(value.trim());
    }
    return out;
  };
  const block = { independent: read(independent, 'variables.independent'), dependent: read(dependent, 'variables.dependent'), controls: read(controls, 'variables.controls') };
  for (const [name, list] of Object.entries(block)) {
    const seen = new Set();
    for (const value of list) {
      if (seen.has(value)) issues.push(issue('DUPLICATE_VARIABLE', `variables.${name}`, `variables.${name} lists ${value} more than once`));
      seen.add(value);
    }
  }
  // CONFLICTING VARIABLES: the same name appearing in two roles means the design cannot say what was varied and
  // what was held constant, which is precisely the ambiguity a controlled experiment may not have.
  for (const [left, right] of [['independent', 'dependent'], ['independent', 'controls'], ['dependent', 'controls']]) {
    for (const value of block[left]) {
      if (block[right].includes(value)) issues.push(issue('CONFLICTING_VARIABLES', `variables.${right}`, `variable ${value} is declared in both variables.${left} and variables.${right}`));
    }
  }
  if (block.independent.length === 0) issues.push(issue('MISSING_FIELD', 'variables.independent', 'at least one independent variable is required: an experiment that varies nothing is not an experiment'));
  if (block.dependent.length === 0) issues.push(issue('MISSING_FIELD', 'variables.dependent', 'at least one dependent variable is required: an experiment that measures nothing is not an experiment'));
  return { variables: freeze(block), issues };
}

/** Stop conditions. Each is a kind plus the value that kind requires; an unknown kind is refused. */
export function stopConditions(values = []) {
  const issues = [];
  if (!Array.isArray(values) || values.length === 0) {
    issues.push(issue('MISSING_FIELD', 'stopConditions', 'at least one stop condition is required: a run with no stop condition cannot be bounded'));
    return { stopConditions: freeze([]), issues };
  }
  const out = [];
  for (const [index, entry] of values.entries()) {
    const path = `stopConditions[${index}]`;
    if (!isText(entry?.kind)) { issues.push(issue('INVALID_FIELD', `${path}.kind`, `${path}.kind must be a non-empty string`)); continue; }
    if (!STOP_CONDITION_KINDS.includes(entry.kind)) { issues.push(issue('UNKNOWN_STOP_CONDITION', `${path}.kind`, `unknown stop condition ${entry.kind}; known: ${STOP_CONDITION_KINDS.join(', ')}`)); continue; }
    if (entry.kind === 'MANUAL') { out.push(freeze({ kind: entry.kind, value: null })); continue; }
    if (!Number.isSafeInteger(entry.value) || entry.value <= 0) { issues.push(issue('INVALID_FIELD', `${path}.value`, `${path}.value must be a positive safe integer for ${entry.kind}`)); continue; }
    out.push(freeze({ kind: entry.kind, value: entry.value }));
  }
  if (!out.some(condition => condition.kind === 'MAX_REPETITIONS')) {
    // Not a fabricated default: the absence is REPORTED. A bounded run must be bounded by something, and
    // MAX_REPETITIONS is the bound the manifest's own `repetitions` field can honour.
    issues.push(issue('MISSING_FIELD', 'stopConditions', 'a MAX_REPETITIONS stop condition is required so the declared repetition count is also the run bound'));
  }
  return { stopConditions: freeze(out), issues };
}

/** Artifact policy: what is kept, and where the export would go. `NONE` must be explicit. */
export function artifactPolicy({ retention, exportPath = null } = {}) {
  const issues = [];
  if (!isText(retention)) issues.push(issue('MISSING_FIELD', 'artifactPolicy.retention', 'artifactPolicy.retention is required; use NONE explicitly if nothing is kept'));
  else if (!ARTIFACT_RETENTION.includes(retention)) issues.push(issue('UNKNOWN_ARTIFACT_RETENTION', 'artifactPolicy.retention', `unknown retention ${retention}; known: ${ARTIFACT_RETENTION.join(', ')}`));
  if (exportPath !== null && !isText(exportPath)) issues.push(issue('INVALID_FIELD', 'artifactPolicy.exportPath', 'artifactPolicy.exportPath must be a non-empty string or null'));
  return { artifactPolicy: freeze({ retention: isText(retention) ? retention : null, exportPath: isText(exportPath) ? exportPath : null }), issues };
}

/** Acceptance criteria: how a run is judged, as explicit statements. */
export function acceptanceCriteria({ primary = null, minimumSuccessfulRuns = null, notes = [] } = {}) {
  const issues = [];
  if (!isText(primary)) issues.push(issue('MISSING_FIELD', 'acceptance.primary', 'acceptance.primary is required: a run with no acceptance statement cannot pass or fail'));
  if (minimumSuccessfulRuns !== null && (!Number.isSafeInteger(minimumSuccessfulRuns) || minimumSuccessfulRuns < 1)) {
    issues.push(issue('INVALID_FIELD', 'acceptance.minimumSuccessfulRuns', 'acceptance.minimumSuccessfulRuns must be a positive safe integer or null'));
  }
  if (!Array.isArray(notes)) issues.push(issue('INVALID_FIELD', 'acceptance.notes', 'acceptance.notes must be an array'));
  return { acceptance: freeze({ primary: isText(primary) ? primary.trim() : null, minimumSuccessfulRuns, notes: freeze(Array.isArray(notes) ? notes.filter(isText) : []) }), issues };
}

/**
 * Validate a manifest against the topologies and capabilities that actually exist.
 *
 * Everything is injectable so the same manifest produces the same verdict anywhere: `knownCapabilities` is the
 * City's real capability list (or an explicit fixture in a test), and `knownTopologies` defaults to the closed
 * vocabulary above.
 *
 * @returns {{ok: boolean, issues: object[], manifest: object|null, supported: boolean}}
 */
export function validateExperimentManifest(input, { knownCapabilities = [], knownTopologies = TOPOLOGIES } = {}) {
  const issues = [];
  if (!isPlainObject(input)) {
    return freeze({ ok: false, supported: false, manifest: null, issues: freeze([issue('INVALID_MANIFEST', '', 'a manifest must be an object')]) });
  }
  if (input.contractVersion !== undefined && input.contractVersion !== EXPERIMENT_MANIFEST_CONTRACT_VERSION) {
    return freeze({ ok: false, supported: false, manifest: null, issues: freeze([issue('INCOMPATIBLE_CONTRACT', 'contractVersion', `manifest contractVersion must be ${EXPERIMENT_MANIFEST_CONTRACT_VERSION}, got ${String(input.contractVersion)}`)]) });
  }

  const experimentId = requireText(input.experimentId, 'experimentId', issues);
  if (experimentId !== null && !EXPERIMENT_ID_SHAPE.test(experimentId)) {
    issues.push(issue('INVALID_FIELD', 'experimentId', `experimentId "${experimentId}" must match ${EXPERIMENT_ID_SHAPE}`));
  }
  const question = requireText(input.question, 'question', issues);
  const hypothesis = input.hypothesis === undefined || input.hypothesis === null ? null : requireText(input.hypothesis, 'hypothesis', issues);
  const repetitions = requireCount(input.repetitions, 'repetitions', issues, { min: 1, max: 10000 });

  // Topology: known, and consistent with what the manifest says it will run on.
  let topology = null;
  let topologyFacts = null;
  if (!isText(input.topology)) {
    issues.push(issue('MISSING_FIELD', 'topology', 'topology is required'));
  } else if (!Object.hasOwn(knownTopologies, input.topology)) {
    issues.push(issue('UNKNOWN_TOPOLOGY', 'topology', `unknown topology ${input.topology}; known: ${Object.keys(knownTopologies).join(', ')}`));
  } else {
    topology = input.topology;
    topologyFacts = knownTopologies[topology];
  }

  // What the manifest CLAIMS it will run on, stated explicitly so an impossible topology is detectable rather
  // than assumed. These are declarations for validation, not a resource reservation.
  const declaredHosts = Array.isArray(input.hosts) ? input.hosts.filter(isText).map(value => value.trim()) : [];
  const declaredWorkers = Array.isArray(input.workers) ? input.workers.filter(isText).map(value => value.trim()) : [];
  const declaredSurfaces = Array.isArray(input.controlSurfaces) ? input.controlSurfaces.filter(isText).map(value => value.trim()) : [];
  if (topologyFacts) {
    if (declaredHosts.length !== topologyFacts.minHosts || declaredHosts.length > topologyFacts.maxHosts) {
      const expected = topologyFacts.minHosts === topologyFacts.maxHosts ? String(topologyFacts.minHosts) : `${topologyFacts.minHosts}-${topologyFacts.maxHosts}`;
      issues.push(issue('TOPOLOGY_IMPOSSIBLE', 'hosts', `${topology} requires ${expected} host(s) but the manifest declares ${declaredHosts.length}`));
    }
    if (declaredWorkers.length < topologyFacts.minWorkers) {
      issues.push(issue('TOPOLOGY_IMPOSSIBLE', 'workers', `${topology} requires at least ${topologyFacts.minWorkers} real worker(s) but the manifest declares ${declaredWorkers.length}`));
    }
    if (declaredSurfaces.length < topologyFacts.minControlSurfaces) {
      issues.push(issue('TOPOLOGY_IMPOSSIBLE', 'controlSurfaces', `${topology} requires at least ${topologyFacts.minControlSurfaces} control surface(s) but the manifest declares ${declaredSurfaces.length}`));
    }
    if (topologyFacts.requiresAndroidControl === true && !declaredSurfaces.some(value => /android/i.test(value))) {
      issues.push(issue('TOPOLOGY_IMPOSSIBLE', 'controlSurfaces', `${topology} requires a real Android control surface; none of ${JSON.stringify(declaredSurfaces)} names one`));
    }
    // A worker that is not one of the declared hosts would be a worker this experiment cannot place.
    for (const worker of declaredWorkers) {
      if (declaredHosts.length > 0 && !declaredHosts.some(host => host === worker)) {
        issues.push(issue('TOPOLOGY_IMPOSSIBLE', 'workers', `worker ${worker} is not one of the declared hosts ${JSON.stringify(declaredHosts)}`));
      }
    }
  }

  const { variables, issues: variableIssues } = experimentVariables(input.variables ?? {});
  issues.push(...variableIssues);
  const { stopConditions: stops, issues: stopIssues } = stopConditions(input.stopConditions ?? []);
  issues.push(...stopIssues);
  const { artifactPolicy: artifacts, issues: artifactIssues } = artifactPolicy(input.artifactPolicy ?? {});
  issues.push(...artifactIssues);
  const { acceptance, issues: acceptanceIssues } = acceptanceCriteria(input.acceptance ?? {});
  issues.push(...acceptanceIssues);

  // Capabilities: every required capability must exist in the supplied vocabulary. This is the "unknown
  // capability" gate, and it refuses rather than warning, because a manifest requiring a capability nobody
  // provides can never run and must not be stored as if it could.
  const requiredCapabilities = Array.isArray(input.requiredCapabilities) ? input.requiredCapabilities.filter(isText).map(value => value.trim()) : [];
  if (requiredCapabilities.length === 0) issues.push(issue('MISSING_FIELD', 'requiredCapabilities', 'requiredCapabilities must be a non-empty array'));
  const known = new Set(knownCapabilities);
  for (const capability of requiredCapabilities) {
    if (!known.has(capability)) issues.push(issue('UNKNOWN_CAPABILITY', 'requiredCapabilities', `no provider in this City provides ${capability}`));
  }

  // Seed policy and base seed. No default is invented: an absent policy is an issue, not `PER_REPETITION`.
  let seedPolicy = null;
  if (!isText(input.seedPolicy)) issues.push(issue('MISSING_FIELD', 'seedPolicy', 'seedPolicy is required'));
  else if (!SEED_POLICIES.includes(input.seedPolicy)) issues.push(issue('UNKNOWN_SEED_POLICY', 'seedPolicy', `unknown seed policy ${input.seedPolicy}; known: ${SEED_POLICIES.join(', ')}`));
  else seedPolicy = input.seedPolicy;
  const baseSeed = input.baseSeed === undefined ? 0 : input.baseSeed;
  if (!Number.isSafeInteger(baseSeed) || baseSeed < 0) issues.push(issue('INVALID_FIELD', 'baseSeed', 'baseSeed must be a non-negative safe integer'));

  // Software refs: exact identities only.
  const softwareRefs = [];
  if (!Array.isArray(input.softwareRefs) || input.softwareRefs.length === 0) {
    issues.push(issue('MISSING_FIELD', 'softwareRefs', 'softwareRefs must be a non-empty array of component@identity references'));
  } else {
    for (const [index, raw] of input.softwareRefs.entries()) {
      try {
        softwareRefs.push(parseSoftwareRef(raw));
      } catch (error) {
        issues.push(issue('MALFORMED_SOFTWARE_REF', `softwareRefs[${index}]`, error.detail ?? String(raw)));
      }
    }
  }

  // References that are carried, never resolved into authority.
  const references = freeze({
    scenarioRef: isText(input.scenarioRef) ? input.scenarioRef.trim() : null,
    faultProfileRef: isText(input.faultProfileRef) ? input.faultProfileRef.trim() : null,
    // Stated in the manifest itself so a reader of a stored manifest cannot mistake a reference for a grant.
    referenceIsNotAuthorisation: true,
  });

  const manifest = Object.freeze({
    contractVersion: EXPERIMENT_MANIFEST_CONTRACT_VERSION,
    experimentId,
    question,
    hypothesis,
    topology,
    topologyDescription: topologyFacts?.description ?? null,
    hosts: freeze(declaredHosts),
    workers: freeze(declaredWorkers),
    controlSurfaces: freeze(declaredSurfaces),
    variables,
    repetitions,
    seedPolicy,
    baseSeed,
    requiredCapabilities: freeze(requiredCapabilities),
    stopConditions: stops,
    artifactPolicy: artifacts,
    acceptance,
    softwareRefs: freeze(softwareRefs),
    references,
    // A manifest is never a default: this records that every value above came from the input.
    defaultsInvented: false,
  });

  const ok = issues.length === 0;
  return freeze({ ok, supported: true, manifest, issues: freeze(issues) });
}

/** Assert-and-throw form, for callers that treat an invalid manifest as a refusal. */
export function assertExperimentManifest(input, options = {}) {
  // The task-domain boundary is checked on the RAW input, before validation builds its own clean object: a
  // manifest carrying `tasks` or `leases` is refused for what it is, not laundered into a valid manifest by the
  // projection that drops unknown keys. (This was a real defect in the first version of this function: it checked
  // the projected manifest, which by construction never contains those keys, so the guard could never fire.)
  assertNotATaskStore(input);
  const verdict = validateExperimentManifest(input, options);
  if (!verdict.ok) {
    const first = verdict.issues[0];
    throw new ExperimentManifestError(first.code, `${verdict.issues.length} issue(s); first: ${first.path} ${first.message}`, verdict.issues);
  }
  return verdict.manifest;
}

/**
 * THE BOUNDARY THAT KEEPS THIS OUT OF THE TASK DOMAIN. A manifest that carries work ownership, leases,
 * assignments or results is a second task database wearing a research hat, and it is refused by name.
 */
export const TASK_DOMAIN_KEYS = Object.freeze(['tasks', 'assignments', 'leases', 'claims', 'assignedNodeId', 'taskId', 'results', 'executionState']);

export function assertNotATaskStore(candidate, path = 'manifest') {
  for (const key of TASK_DOMAIN_KEYS) {
    if (candidate !== null && typeof candidate === 'object' && Object.hasOwn(candidate, key)) {
      throw new ExperimentManifestError('NOT_A_MANIFEST_STORE', `${path}.${key} belongs to the task domain; an experiment manifest describes an experiment and does not own work`);
    }
  }
  return candidate;
}
