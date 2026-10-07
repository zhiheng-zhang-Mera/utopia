// PCF-702 (cost half): the decomposed, honest placement cost estimate.
//
// The workbook asks for five separately named components (queueing, input transfer, cold start, execution, result
// return), a saved interval, the sample source, the model version and the MISSING status - and it forbids
// manufacturing prediction accuracy when there is no calibration evidence. So nothing here ever collapses into one
// bare number:
//
//   * every component keeps its own interval and where that interval came from;
//   * a component that was not observed is MISSING, never 0 - a missing measurement is not a fast machine;
//   * the RANKING bound is widened when the model is uncalibrated, so an uncalibrated estimate cannot out-rank a
//     calibrated one on the strength of a point estimate nobody measured;
//   * `accuracyClaim` is always NONE, because this model has no calibration evidence behind it and saying otherwise
//     would be the fabrication the workbook names.
import {finite, freeze} from './validation.mjs';

export const COST_MODEL_VERSION = 1;
export const COST_COMPONENTS = Object.freeze(['queue', 'inputTransfer', 'coldStart', 'execution', 'resultReturn']);
// The declared conservative rule for an uncalibrated model. It is a policy constant, not a measurement.
export const UNCALIBRATED_WIDENING = 4;
export const CALIBRATION_STATUS = Object.freeze({CALIBRATED: 'CALIBRATED', UNCALIBRATED: 'UNCALIBRATED'});

const FIELD = Object.freeze({inputTransfer: 'inputMs', coldStart: 'coldStartMs', execution: 'executeMs', resultReturn: 'returnMs'});
const asInterval = value => Array.isArray(value) && value.length === 2 && value.every(finite) && value[0] <= value[1] ? [value[0], value[1]] : null;
// Queueing is one observed wait rather than a two-point estimate, so it is reported as the degenerate interval
// [wait, wait] rather than being widened into a range nobody measured.
const queueInterval = value => finite(value) ? [value, value] : null;

/**
 * Decompose one candidate's cost estimate. The result is frozen and self-describing: `state` says whether the
 * estimate is usable at all, `missing` names exactly what was not observed, and `rankingMs` is the bound a ranking
 * rule may use (null when there is nothing to rank on).
 */
export function estimateCost(candidate = {}) {
  const cost = candidate.cost ?? {};
  const components = {};
  const missing = [];
  for (const name of COST_COMPONENTS) {
    const bound = name === 'queue' ? queueInterval(candidate.queueMs) : asInterval(cost[FIELD[name]]);
    if (!bound) {
      components[name] = freeze({state: 'MISSING', intervalMs: null, source: null});
      missing.push(name);
      continue;
    }
    components[name] = freeze({state: 'MEASURED', intervalMs: bound, source: cost.sources?.[name] ?? (name === 'queue' ? 'candidate.queueMs' : 'candidate.cost.' + FIELD[name])});
  }
  const samples = finite(cost.calibrationSamples) && cost.calibrationSamples > 0 ? cost.calibrationSamples : 0;
  const calibrated = samples > 0 && typeof cost.calibrationVersion === 'string' && cost.calibrationVersion.length > 0;
  const calibration = freeze({status: calibrated ? CALIBRATION_STATUS.CALIBRATED : CALIBRATION_STATUS.UNCALIBRATED, samples,
    version: calibrated ? cost.calibrationVersion : null,
    note: calibrated ? null : 'no calibration evidence: the ranking bound is widened and no accuracy is claimed'});
  const modelVersion = calibrated ? cost.calibrationVersion : 'conservative-uncalibrated-v' + COST_MODEL_VERSION;
  const shared = {modelVersion, calibration, complete: missing.length === 0, missing: freeze([...missing]), components: freeze(components), accuracyClaim: 'NONE'};
  if (missing.length) return freeze({...shared, state: 'UNKNOWN', intervalMs: null, calibrationVersion: calibrated ? cost.calibrationVersion : null, total: null, rankingMs: null});
  const intervalMs = [0, 1].map(index => COST_COMPONENTS.reduce((sum, name) => sum + components[name].intervalMs[index], 0));
  return freeze({...shared, state: 'ESTIMATED', intervalMs, calibrationVersion: calibrated ? cost.calibrationVersion : null,
    total: freeze({intervalMs: freeze(intervalMs), unit: 'ms', basis: 'SUM_OF_DECLARED_COMPONENTS'}),
    rankingMs: calibrated ? intervalMs[1] : intervalMs[1] * UNCALIBRATED_WIDENING});
}
