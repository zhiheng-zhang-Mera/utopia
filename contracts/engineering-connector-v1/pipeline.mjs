// Adapter pipeline: detect → select → adapt → validate → standardize → unify (EM-002).
//
// Every stage runs a *third-party* adapter function, so every stage is fault-isolated: a throw,
// a non-object answer or invalid output becomes recorded data (`failures[]`) and the pipeline
// continues. One malformed connector can therefore never stop the others from loading, and
// adding a connector is registration code rather than a new branch in the foreman core.
import { ConnectorError, assertConnectorManifest } from './manifest.mjs';

export const PIPELINE_STAGES = Object.freeze(['DETECT', 'SELECT', 'ADAPT', 'VALIDATE', 'STANDARDIZE', 'UNIFY']);
export const ADAPTER_STAGES = Object.freeze(['detector', 'adapt', 'validate', 'standardize']);
export const STAGE_FAILURE_CODES = Object.freeze({ detector: 'ADAPTER_DETECT_FAILED', adapt: 'ADAPTER_ADAPT_FAILED', validate: 'ADAPTER_INVALID_OUTPUT', standardize: 'ADAPTER_STANDARDIZE_FAILED' });

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));

/**
 * Register an adapter. Registration is pure declaration: it validates the *shape* of the adapter,
 * never its behaviour, so a broken adapter registers fine and fails in isolation at run time.
 */
export function registerAdapter(adapter) {
  const { adapter_ref, runtime_kind, detector, adapt, validate, standardize } = adapter ?? {};
  const errors = [];
  if (!isText(adapter_ref)) errors.push('adapter_ref must be nonempty text');
  if (!isText(runtime_kind)) errors.push('runtime_kind must be nonempty text');
  for (const stage of ADAPTER_STAGES) if (typeof adapter?.[stage] !== 'function') errors.push(`${stage} must be a function`);
  if (errors.length) throw new ConnectorError('INVALID_ADAPTER_REGISTRATION', errors.slice(0, 3).join('; '));
  return Object.freeze({ adapter_ref, runtime_kind, detector, adapt, validate, standardize });
}

function guardStage(adapter, stage, input) {
  try {
    const value = adapter[stage](input);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, code: STAGE_FAILURE_CODES[stage], detail: `${adapter.adapter_ref}: ${error?.code ?? error?.name ?? 'ERROR'}: ${String(error?.message ?? error).slice(0, 160)}` };
  }
}

/**
 * Run the pipeline over one observation.
 *
 * SELECT is an explicit, declared rule (highest `score`, then `adapter_ref` order) rather than a
 * hand-written conditional per connector, which is what keeps the core business-agnostic.
 */
export function runAdapterPipeline({ adapters = [], observation = {}, policy = null } = {}) {
  if (!Array.isArray(adapters)) throw new ConnectorError('INVALID_ADAPTER_REGISTRATION', 'adapters must be an array');
  if (!isPlainObject(observation)) throw new ConnectorError('INVALID_ADAPTER_REGISTRATION', 'observation must be an object');
  const failures = [];
  const candidates = [];

  for (const adapter of adapters) {
    const detected = guardStage(adapter, 'detector', observation);
    if (!detected.ok) { failures.push({ stage: 'DETECT', adapter_ref: adapter?.adapter_ref ?? 'unknown', code: detected.code, detail: detected.detail }); continue; }
    const answer = detected.value;
    if (!isPlainObject(answer) || typeof answer.matched !== 'boolean') {
      failures.push({ stage: 'DETECT', adapter_ref: adapter.adapter_ref, code: 'ADAPTER_INVALID_OUTPUT', detail: `${adapter.adapter_ref}: detector must return {matched, score?, evidence?}` });
      continue;
    }
    if (!answer.matched) continue;
    const score = Number.isFinite(answer.score) ? answer.score : 0;
    candidates.push({ adapter, score, evidence: isText(answer.evidence) ? answer.evidence : 'adapter reported a match' });
  }

  if (candidates.length === 0) {
    return Object.freeze({ unified: [], failures: Object.freeze(failures.map(Object.freeze)), selected: null, stages: Object.freeze(PIPELINE_STAGES), noAdapterSelected: true });
  }

  candidates.sort((left, right) => (right.score - left.score) || (left.adapter.adapter_ref < right.adapter.adapter_ref ? -1 : 1));
  const winner = candidates[0];

  const adapted = guardStage(winner.adapter, 'adapt', observation);
  if (!adapted.ok) {
    failures.push({ stage: 'ADAPT', adapter_ref: winner.adapter.adapter_ref, code: adapted.code, detail: adapted.detail });
    return Object.freeze({ unified: [], failures: Object.freeze(failures.map(Object.freeze)), selected: winner.adapter.adapter_ref, stages: Object.freeze(PIPELINE_STAGES), noAdapterSelected: false });
  }

  const validated = guardStage(winner.adapter, 'validate', adapted.value);
  if (!validated.ok) {
    failures.push({ stage: 'VALIDATE', adapter_ref: winner.adapter.adapter_ref, code: validated.code, detail: validated.detail });
    return Object.freeze({ unified: [], failures: Object.freeze(failures.map(Object.freeze)), selected: winner.adapter.adapter_ref, stages: Object.freeze(PIPELINE_STAGES), noAdapterSelected: false });
  }
  // A validator that cannot answer "is this valid?" is a malformed connector, not a fatal error.
  if (validated.value !== true && !(isPlainObject(validated.value) && typeof validated.value.ok === 'boolean')) {
    failures.push({ stage: 'VALIDATE', adapter_ref: winner.adapter.adapter_ref, code: 'ADAPTER_INVALID_OUTPUT', detail: `${winner.adapter.adapter_ref}: validate must return true/false or {ok}` });
    return Object.freeze({ unified: [], failures: Object.freeze(failures.map(Object.freeze)), selected: winner.adapter.adapter_ref, stages: Object.freeze(PIPELINE_STAGES), noAdapterSelected: false });
  }
  const validatedOk = validated.value === true || validated.value.ok === true;
  if (!validatedOk) {
    failures.push({ stage: 'VALIDATE', adapter_ref: winner.adapter.adapter_ref, code: 'ADAPTER_INVALID_OUTPUT', detail: `${winner.adapter.adapter_ref}: candidate was rejected by its own validator` });
    return Object.freeze({ unified: [], failures: Object.freeze(failures.map(Object.freeze)), selected: winner.adapter.adapter_ref, stages: Object.freeze(PIPELINE_STAGES), noAdapterSelected: false });
  }

  const standardized = guardStage(winner.adapter, 'standardize', { candidate: adapted.value, evidence: winner.evidence, policy });
  if (!standardized.ok) {
    failures.push({ stage: 'STANDARDIZE', adapter_ref: winner.adapter.adapter_ref, code: standardized.code, detail: standardized.detail });
    return Object.freeze({ unified: [], failures: Object.freeze(failures.map(Object.freeze)), selected: winner.adapter.adapter_ref, stages: Object.freeze(PIPELINE_STAGES), noAdapterSelected: false });
  }

  // UNIFY: the standardizer must produce a canonical manifest; provenance is added here so the
  // adapter cannot forge which adapter was selected or which runtime kind won.
  const manifest = clone(standardized.value);
  if (isPlainObject(manifest)) {
    manifest.provenance = {
      detection_evidence: winner.evidence,
      selected_adapter_ref: winner.adapter.adapter_ref,
      runtime_kind: manifest.runtime_kind ?? winner.adapter.runtime_kind,
    };
  }
  try {
    assertConnectorManifest(manifest);
  } catch (error) {
    failures.push({ stage: 'UNIFY', adapter_ref: winner.adapter.adapter_ref, code: 'INVALID_CONNECTOR_MANIFEST', detail: String(error.detail ?? error.message).slice(0, 200) });
    return Object.freeze({ unified: [], failures: Object.freeze(failures.map(Object.freeze)), selected: winner.adapter.adapter_ref, stages: Object.freeze(PIPELINE_STAGES), noAdapterSelected: false });
  }

  return Object.freeze({
    unified: Object.freeze([Object.freeze(manifest)]),
    failures: Object.freeze(failures.map(Object.freeze)),
    selected: winner.adapter.adapter_ref,
    stages: Object.freeze(PIPELINE_STAGES),
    noAdapterSelected: false,
  });
}

/**
 * Load many connectors at once. Each observation is independent, so one malformed connector
 * cannot prevent the others from loading: failures are returned alongside the manifests.
 */
export function loadConnectors({ adapters = [], observations = [], policy = null } = {}) {
  if (!Array.isArray(observations)) throw new ConnectorError('INVALID_ADAPTER_REGISTRATION', 'observations must be an array');
  const manifests = [];
  const failures = [];
  const selectedAdapters = [];
  observations.forEach((observation, index) => {
    const result = runAdapterPipeline({ adapters, observation, policy });
    for (const failure of result.failures) failures.push({ ...failure, observation_index: index });
    for (const manifest of result.unified) manifests.push(manifest);
    if (result.selected) selectedAdapters.push(result.selected);
  });
  const kinds = new Set();
  const unified = [];
  for (const manifest of manifests) {
    if (kinds.has(manifest.connector_kind)) { failures.push({ stage: 'UNIFY', adapter_ref: manifest.provenance.selected_adapter_ref, code: 'DUPLICATE_CONNECTOR_KIND', detail: `${manifest.connector_kind} was produced twice` }); continue; }
    kinds.add(manifest.connector_kind);
    unified.push(manifest);
  }
  return Object.freeze({
    unified: Object.freeze(unified),
    failures: Object.freeze(failures.map(Object.freeze)),
    selected_adapters: Object.freeze([...new Set(selectedAdapters)].sort()),
    loaded: unified.length,
  });
}
