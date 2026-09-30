// General AI Gateway — routing policy, ports and deterministic doubles (GAI-001).
//
// The routing policy is the product decision this programme must not get wrong, so it is code
// rather than prose: deterministic/local first, Web as the default channel, Web failure never
// silently escalating to API, and API execution gated by *explicit user consent* with budget
// approval as a separate, non-substituting check.
import {
  ATTENTION_KINDS, CHANNELS, GeneralAiGatewayError, isIsoInstant, normalizeFieldName
} from './contracts.mjs';

export const ROUTING_PRIORITY = Object.freeze([
  'DETERMINISTIC_LOCAL',
  'JEV_TRIAGE',
  'WEB_CURRENT_DEVICE',
  'WEB_OTHER_DEVICE',
  'API_SWITCH_PROPOSAL',
  'BUDGET_POLICY',
  'API_EXECUTION',
]);

export const ROUTING_OUTCOMES = Object.freeze([
  'LOCAL_RESULT',
  'JEV_DEGRADED',
  'WEB_SUBMIT',
  'PROPOSE_OTHER_DEVICE',
  'PROPOSE_API_SWITCH',
  'AWAIT_USER_CONSENT',
  'AWAIT_BUDGET_DECISION',
  'API_SUBMIT',
  'REFUSED',
]);

export const ROUTE_REASONS = Object.freeze([
  'DETERMINISTIC_LOCAL_ANSWER',
  'JEV_UNAVAILABLE_DEGRADED',
  'WEB_AVAILABLE_ON_CURRENT_DEVICE',
  'WEB_UNAVAILABLE_ON_CURRENT_DEVICE',
  'WEB_FAILED_CONSENT_REQUIRED',
  'API_CONSENT_REQUIRED',
  'API_CONSENT_GIVEN',
  'BUDGET_REJECTED',
  'NO_CHANNEL_AVAILABLE',
]);

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;

// ---- JEV triage port (advisory only) -------------------------------------

export const JEV_TRIAGE_PORT = Object.freeze({
  interface: 'JevTriagePort',
  version: 1,
  methods: Object.freeze(['assess']),
  authority: 'ADVISORY_ONLY',
  can_execute: false,
  can_grant_permission: false,
  is_canonical_task_truth: false,
});

export const JEV_ASSESSMENT_FIELDS = Object.freeze(['intent', 'complexity', 'risk', 'routeRecommendation', 'confidence', 'needsGeneralAI', 'preferredChannel']);

/**
 * JEV output is structurally advisory: whatever the classifier returns, this wrapper states
 * that it grants nothing and executes nothing. A confidence value cannot become authority.
 */
export function asAdvisoryAssessment(assessment) {
  if (!isPlainObject(assessment)) throw new GeneralAiGatewayError('MALFORMED_ENVELOPE', 'a JEV assessment must be an object');
  const errors = [];
  if (!isText(assessment.intent)) errors.push('intent must be nonempty text');
  if (!['TRIVIAL', 'NORMAL', 'HARD'].includes(assessment.complexity)) errors.push('complexity must be TRIVIAL, NORMAL or HARD');
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(assessment.risk)) errors.push('risk must be LOW, MEDIUM or HIGH');
  if (typeof assessment.confidence !== 'number' || assessment.confidence < 0 || assessment.confidence > 1) errors.push('confidence must be between 0 and 1');
  if (typeof assessment.needsGeneralAI !== 'boolean') errors.push('needsGeneralAI must be a boolean');
  if (assessment.preferredChannel !== null && assessment.preferredChannel !== undefined && !CHANNELS.includes(assessment.preferredChannel)) errors.push(`preferredChannel must be one of ${CHANNELS.join(', ')} or null`);
  // Whitelist projection, not a spread. Spreading an untrusted classifier output let it carry
  // arbitrary extra keys — `channel: 'API'`, `route: 'API_SUBMIT'`, `requires_user_confirmation`,
  // `confirmedByRef`, `budgetDecision` — into the very object whose purpose is to be safe to hand
  // to a later consumer. Routing itself is not fooled (it reads only `jev.degraded`), but a future
  // consumer branching on those names would read a "user-confirmed, API, budget-approved"
  // assessment that nothing ever confirmed.
  const unknown = Object.keys(assessment).filter((key) => !JEV_ASSESSMENT_FIELDS.includes(key));
  if (unknown.length) errors.push(`${unknown[0]} is not a JEV assessment field; an advisory assessment carries no other keys`);
  if (errors.length) throw new GeneralAiGatewayError('MALFORMED_ENVELOPE', errors.slice(0, 3).join('; '));
  const projected = {
    advisory: true,
    grantedAuthority: false,
    executedAnything: false,
    note: 'JEV output recommends; City/Utopia policy decides and executes',
  };
  for (const field of JEV_ASSESSMENT_FIELDS) {
    if (Object.hasOwn(assessment, field) && assessment[field] !== undefined) projected[field] = assessment[field];
  }
  return Object.freeze(projected);
}

/**
 * JEV failure must degrade to deterministic/manual routing. A classifier that is down, slow or
 * malformed is an ordinary input to the policy, never a blocker and never a licence to escalate.
 */
export function assessWithJevTriage(jevTriagePort, request) {
  if (!jevTriagePort || typeof jevTriagePort.assess !== 'function') {
    return { degraded: true, reason: 'JEV_PORT_ABSENT', assessment: null };
  }
  try {
    const assessment = jevTriagePort.assess(request);
    if (assessment === null || assessment === undefined) return { degraded: true, reason: 'JEV_RETURNED_NOTHING', assessment: null };
    return { degraded: false, reason: null, assessment: asAdvisoryAssessment(assessment) };
  } catch (error) {
    return { degraded: true, reason: `JEV_FAILED:${error?.code ?? error?.name ?? 'ERROR'}`, assessment: null };
  }
}

// ---- routing decision ----------------------------------------------------

/**
 * Decide the next routing step. Inputs describe *observed state only*; nothing here reads a
 * clock, a network or a device.
 *
 * @param {{localResult?: *, jev?: {degraded: boolean}, webAvailableOnCurrentDevice?: boolean,
 *          webAvailableOnOtherDevice?: boolean, lastWebAttemptFailed?: boolean,
 *          apiAvailable?: boolean, userConfirmedApi?: boolean,
 *          budgetDecision?: 'APPROVED'|'REJECTED'|'NOT_EVALUATED',
 *          otherDeviceRef?: string|null, budgetRef?: string|null}} observed
 */
export function decideRoute(observed = {}) {
  const state = {
    localResult: observed.localResult ?? null,
    webAvailableOnCurrentDevice: observed.webAvailableOnCurrentDevice === true,
    webAvailableOnOtherDevice: observed.webAvailableOnOtherDevice === true,
    lastWebAttemptFailed: observed.lastWebAttemptFailed === true,
    apiAvailable: observed.apiAvailable === true,
    userConfirmedApi: observed.userConfirmedApi === true,
    budgetDecision: observed.budgetDecision ?? 'NOT_EVALUATED',
    otherDeviceRef: observed.otherDeviceRef ?? null,
    budgetRef: observed.budgetRef ?? null,
    jevDegraded: observed.jev?.degraded === true,
  };

  // P0 — a deterministic/local answer never needs a general-AI round trip.
  if (state.localResult !== null && state.localResult !== undefined) {
    return Object.freeze({ outcome: 'LOCAL_RESULT', reason: 'DETERMINISTIC_LOCAL_ANSWER', priority: 'DETERMINISTIC_LOCAL', channel: null, requiresUserConsent: false, localResult: state.localResult, jevDegraded: state.jevDegraded });
  }
  // P2 — Web is the default general-AI channel, on the device the user is already using.
  if (state.webAvailableOnCurrentDevice) {
    return Object.freeze({ outcome: 'WEB_SUBMIT', reason: state.jevDegraded ? 'JEV_UNAVAILABLE_DEGRADED' : 'WEB_AVAILABLE_ON_CURRENT_DEVICE', priority: state.jevDegraded ? 'JEV_TRIAGE' : 'WEB_CURRENT_DEVICE', channel: 'WEB', requiresUserConsent: false, targetDeviceRef: null, jevDegraded: state.jevDegraded });
  }
  // P3 — another trusted device may only be *proposed*, from already-known presence.
  if (state.webAvailableOnOtherDevice && isText(state.otherDeviceRef)) {
    return Object.freeze({ outcome: 'PROPOSE_OTHER_DEVICE', reason: 'WEB_UNAVAILABLE_ON_CURRENT_DEVICE', priority: 'WEB_OTHER_DEVICE', channel: 'WEB', requiresUserConsent: true, targetDeviceRef: state.otherDeviceRef, jevDegraded: state.jevDegraded });
  }
  // Web present but its last attempt failed: this is still not a reason to use API silently.
  if (state.lastWebAttemptFailed && !state.userConfirmedApi) {
    return Object.freeze({
      outcome: state.apiAvailable ? 'PROPOSE_API_SWITCH' : 'REFUSED',
      reason: state.apiAvailable ? 'WEB_FAILED_CONSENT_REQUIRED' : 'NO_CHANNEL_AVAILABLE',
      priority: 'API_SWITCH_PROPOSAL', channel: null, requiresUserConsent: state.apiAvailable, targetDeviceRef: null, jevDegraded: state.jevDegraded,
    });
  }
  // P4 — API escalation requires explicit user confirmation before anything else happens.
  if (state.apiAvailable && !state.userConfirmedApi) {
    return Object.freeze({ outcome: 'PROPOSE_API_SWITCH', reason: 'API_CONSENT_REQUIRED', priority: 'API_SWITCH_PROPOSAL', channel: null, requiresUserConsent: true, targetDeviceRef: null, jevDegraded: state.jevDegraded });
  }
  if (!state.apiAvailable) {
    return Object.freeze({ outcome: 'REFUSED', reason: 'NO_CHANNEL_AVAILABLE', priority: 'API_SWITCH_PROPOSAL', channel: null, requiresUserConsent: false, targetDeviceRef: null, jevDegraded: state.jevDegraded });
  }
  // P5 — consent is given; budget policy now decides whether the run may be admitted.
  if (state.budgetDecision === 'REJECTED') {
    return Object.freeze({ outcome: 'REFUSED', reason: 'BUDGET_REJECTED', priority: 'BUDGET_POLICY', channel: null, requiresUserConsent: false, targetDeviceRef: null, jevDegraded: state.jevDegraded });
  }
  if (state.budgetDecision !== 'APPROVED') {
    return Object.freeze({ outcome: 'AWAIT_BUDGET_DECISION', reason: 'API_CONSENT_GIVEN', priority: 'BUDGET_POLICY', channel: null, requiresUserConsent: false, budgetRef: state.budgetRef, jevDegraded: state.jevDegraded });
  }
  // P6 — consent given and budget approved: API may execute.
  return Object.freeze({ outcome: 'API_SUBMIT', reason: 'API_CONSENT_GIVEN', priority: 'API_EXECUTION', channel: 'API', requiresUserConsent: false, budgetRef: state.budgetRef, jevDegraded: state.jevDegraded });
}

/** A decision that needs the user must come back as an attention request, never as a silent wait. */
export function attentionForDecision(decision, { actionId, question, createdAt }) {
  if (decision.outcome === 'LOCAL_RESULT' || decision.outcome === 'WEB_SUBMIT' || decision.outcome === 'API_SUBMIT') {
    throw new GeneralAiGatewayError('MALFORMED_ENVELOPE', `outcome ${decision.outcome} does not require user attention`);
  }
  const kind = decision.outcome === 'AWAIT_BUDGET_DECISION' ? 'BUDGET_APPROVAL'
    : decision.outcome === 'REFUSED' ? 'PROVIDER_UNAVAILABLE'
      : 'USER_CONFIRMATION';
  if (!ATTENTION_KINDS.includes(kind)) throw new GeneralAiGatewayError('MALFORMED_ENVELOPE', `unknown attention kind ${kind}`);
  return Object.freeze({
    contract_version: 1,
    attention_id: `attention:${actionId}:${decision.reason}`,
    action_id: actionId,
    kind,
    question,
    blocking: decision.outcome !== 'REFUSED',
    created_at: createdAt,
  });
}

/**
 * Applying an escalation requires the user's own confirmation reference. Budget approval alone
 * is refused here, so "the budget allowed it" can never be mistaken for "the user agreed".
 */
export function applyApiEscalation(proposal, { confirmedByRef, confirmedAt, budgetDecision = 'NOT_EVALUATED' } = {}) {
  if (!isPlainObject(proposal) || proposal.requires_user_confirmation !== true) {
    throw new GeneralAiGatewayError('MALFORMED_ENVELOPE', 'an API switch proposal must declare requires_user_confirmation');
  }
  if (budgetDecision === 'REJECTED') throw new GeneralAiGatewayError('BUDGET_REJECTED', 'budget policy rejected this run');
  if (!isText(confirmedByRef)) throw new GeneralAiGatewayError('USER_CONSENT_REQUIRED', 'API escalation requires explicit user confirmation, not budget approval');
  if (!isIsoInstant(confirmedAt)) throw new GeneralAiGatewayError('MALFORMED_ENVELOPE', 'confirmedAt must be an ISO-8601 UTC instant');
  if (!['APPROVED', 'NOT_EVALUATED'].includes(budgetDecision)) throw new GeneralAiGatewayError('MALFORMED_ENVELOPE', `budgetDecision ${budgetDecision} is not a budget decision`);
  return Object.freeze({
    contract_version: 1,
    receipt_ref: `escalation:${proposal.action_id}`,
    action_id: proposal.action_id,
    from_channel: 'WEB',
    to_channel: 'API',
    confirmed_by_ref: confirmedByRef,
    confirmed_at: confirmedAt,
    budget_decision: budgetDecision,
  });
}

/** A device handoff is user-confirmed in V1: the proposal alone moves nothing. */
export function applyDeviceSwitch(proposal, { confirmedByRef, confirmedAt } = {}) {
  if (!isPlainObject(proposal) || proposal.requires_user_confirmation !== true) {
    throw new GeneralAiGatewayError('MALFORMED_ENVELOPE', 'a device switch proposal must declare requires_user_confirmation');
  }
  if (!isText(confirmedByRef)) throw new GeneralAiGatewayError('USER_CONSENT_REQUIRED', 'moving execution to another device requires explicit user confirmation');
  if (!isIsoInstant(confirmedAt)) throw new GeneralAiGatewayError('MALFORMED_ENVELOPE', 'confirmedAt must be an ISO-8601 UTC instant');
  return Object.freeze({
    contract_version: 1,
    action_id: proposal.action_id,
    execution_device_ref: proposal.to_device_ref,
    interaction_device_ref: proposal.from_device_ref,
    confirmed_by_ref: confirmedByRef,
    confirmed_at: confirmedAt,
    // The user's interaction surface does not move with execution.
    interaction_follows_execution: false,
  });
}

// ---- programme ports -----------------------------------------------------

export const GAI_PORT_CONTRACTS = Object.freeze({
  GeneralAiGatewayPort: Object.freeze(['submit', 'status', 'cancel', 'subscribe', 'listProviders', 'listModels', 'listAccounts', 'getConversation']),
  JevTriagePort: JEV_TRIAGE_PORT.methods,
  RemoteExecutionPort: Object.freeze(['listCandidateEndpoints', 'dispatch', 'subscribe', 'cancel', 'requestAttention']),
});

export function describeGaiPort(portName) {
  if (!Object.hasOwn(GAI_PORT_CONTRACTS, portName)) throw new GeneralAiGatewayError('MALFORMED_ENVELOPE', `unknown port ${portName}`);
  return Object.freeze({ name: portName, version: 1, methods: GAI_PORT_CONTRACTS[portName], transportNeutral: true, providerNeutral: true });
}

export function probeGaiPortConformance(portName, subject) {
  const contract = describeGaiPort(portName);
  if (subject === null || (typeof subject !== 'object' && typeof subject !== 'function')) {
    return { ok: false, port: portName, version: 1, missing: [...contract.methods], nonFunctions: [], extensions: [] };
  }
  const missing = contract.methods.filter(method => !(method in subject));
  const nonFunctions = contract.methods.filter(method => method in subject && typeof subject[method] !== 'function');
  const extensions = Object.keys(subject).filter(key => typeof subject[key] === 'function' && !contract.methods.includes(key)).sort();
  return { ok: missing.length === 0 && nonFunctions.length === 0, port: portName, version: 1, missing, nonFunctions, extensions };
}

/** Deterministic JEV double. `assess` is advisory by construction and may fail on demand. */
export function createDeterministicJevTriageDouble({ assessments = {}, failure = null } = {}) {
  return Object.freeze({
    assess(request) {
      if (failure) throw Object.assign(new Error(failure), { code: failure });
      const intent = typeof request?.input_bundle?.text === 'string' ? request.input_bundle.text : '';
      const scripted = assessments[intent];
      if (scripted) return { ...scripted };
      return { intent: intent || 'unknown', complexity: 'NORMAL', risk: 'LOW', routeRecommendation: 'WEB_CURRENT_DEVICE', confidence: 0.5, needsGeneralAI: true, preferredChannel: 'WEB' };
    },
  });
}

/**
 * Deterministic remote-execution double for sibling GAI tasks. It never grants permission and
 * never fakes a completed result: outcomes come only from the script it was given.
 */
export function createDeterministicRemoteExecutionDouble({ endpoints = [], script = [] } = {}) {
  const dispatches = new Map();
  let cursor = 0;
  const step = () => (cursor < script.length ? script[cursor++] : { status: 'RUNNING', delta: '' });
  return Object.freeze({
    listCandidateEndpoints: async () => endpoints.map(endpoint => ({ ...endpoint })),
    dispatch: async (actionId, executionRequest) => { dispatches.set(actionId, { executionRequest, steps: 0 }); return { actionId, dispatched: true }; },
    subscribe: async actionId => { const entry = dispatches.get(actionId); if (!entry) throw new GeneralAiGatewayError('MALFORMED_ENVELOPE', `unknown action ${actionId}`); const outcome = step(); entry.steps += 1; return { ...outcome, actionId, sequence: entry.steps }; },
    cancel: async actionId => ({ actionId, cancelled: dispatches.has(actionId) }),
    requestAttention: async (actionId, attention) => ({ actionId, attentionId: attention?.attention_id ?? `attention:${actionId}`, delivered: true }),
    __dispatches: dispatches,
  });
}

// ---- historical-product dependency scan ----------------------------------

export const FORBIDDEN_PRODUCT_PATTERN = /boss/i;
/**
 * Files that can carry a dependency edge. Extensionless dotfiles such as `.npmrc` count: a
 * scoped registry line names a package source just as effectively as a `package.json` entry,
 * and leaving them out made the "zero findings" result weaker than it claimed to be.
 */
export const EXECUTABLE_FILE_PATTERN = /(?:\.(?:mjs|cjs|js|mts|ts|tsx|jsx|json|ya?ml|gradle|kts|ps1|sh|cmd|npmrc)$|(?:^|[\\/])\.npmrc$)/i;

/**
 * Linkage shapes that would make the repository depend on the historical product: a module
 * import/require, a package dependency or resolution entry, a repository/host reference, a
 * process or endpoint invocation, or a git submodule/symlink. Prose that merely names the
 * product is not a dependency, and a detector that names it on purpose is not one either —
 * which is why the rule is about linkage positions rather than about the word.
 *
 * The product token is composed at runtime so that this table, and the tests that falsify it,
 * do not themselves contain linkage-shaped text: the scan needs no exclusion list, which is
 * what keeps it auditable.
 *
 * The module rules keep the author's original insight: a *static* `from '...'` needs its quotes,
 * because prose containing the phrase "from `Product`" is a provenance sentence, not an import —
 * dropping the quote requirement reintroduced exactly the false positive the report's D5 had
 * already rejected. What was genuinely missing is the call form: `import(\`...\`)`,
 * `require(\`...\`)`, `require.resolve('...')` and `createRequire(...)('...')` are the same edge.
 */
const PRODUCT = 'boss';
export const FORBIDDEN_DEPENDENCY_RULES = Object.freeze([
  Object.freeze({ id: 'MODULE_IMPORT', pattern: new RegExp(`(?:^|[^\\w])(?:(?:import|require|require\\.resolve)\\s*\\(\\s*['"\`]?[^'"\`\\s)]*${PRODUCT}|from\\s+['"][^'"]*${PRODUCT})`, 'i') }),
  Object.freeze({ id: 'HOST_REFERENCE', pattern: new RegExp(`(?:https?://|git@|github\\.com/)[^\\s'"]*${PRODUCT}`, 'i') }),
  Object.freeze({ id: 'PROCESS_OR_ENDPOINT', pattern: new RegExp(`(?:(?:spawn|exec|execFile|fork|fetch|axios|request)\\s*\\(\\s*['"\`][^'"\`]*${PRODUCT}|createRequire\\b[^\\n]*['"\`][^'"\`\\n]*${PRODUCT})`, 'i') }),
  Object.freeze({ id: 'REPO_LINKAGE', pattern: new RegExp(`(?:submodule|symlink|workspace:|registry\\s*=)[^\\n]*${PRODUCT}|^\\s*-\\s*[^\\n]*${PRODUCT}`, 'i') }),
]);

/** Manifest blocks that constitute a real dependency edge when they name the product. */
export const DEPENDENCY_BLOCKS = Object.freeze(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'resolutions', 'overrides']);

/**
 * Every JSON key under which a package name or module path is a dependency edge, held in
 * *normalised* form (see `normalizeFieldName`), because equality is tested against normalised
 * keys. The fixed six-name list missed `pnpm.overrides`, `bundleDependencies`,
 * `workspaces: { packages: [...] }`, tsconfig `paths`/`imports`, and the lockfile
 * `packages["node_modules/..."]` map — all real shapes that install or resolve a package.
 */
const DEPENDENCY_CONTAINER_KEYS = new Set([
  'dependencies', 'dev_dependencies', 'peer_dependencies', 'optional_dependencies',
  'resolutions', 'overrides', 'pnpm', 'bundle_dependencies', 'bundled_dependencies',
  'workspaces', 'packages', 'imports', 'paths', 'aliases', 'package_manager',
]);

function lineOf(text, needle) {
  const index = text.split(/\r?\n/).findIndex(line => line.includes(needle));
  return index === -1 ? 1 : index + 1;
}

/**
 * A JSON manifest is scanned structurally at any depth: a package name or module path is a
 * linkage wherever it sits under a dependency/override/workspace/lockfile container, while a
 * provenance manifest such as `DONOR.json` legitimately *describes* a historical donor in prose
 * fields — a record, not an edge. Flagging prose would be a false positive that teaches nothing;
 * missing `pnpm.overrides` was a false negative that taught less.
 */
function scanJsonManifest(path, text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const findings = [];
  const push = (rule, needle) => findings.push({ path, line: lineOf(text, String(needle)), rule, text: String(needle).slice(0, 160) });
  const namesProduct = (candidate) => typeof candidate === 'string' && FORBIDDEN_PRODUCT_PATTERN.test(candidate);

  // `inContainer` is what keeps this honest. A bare array entry that happens to name the product
  // (a `sourcePaths` list, a `knownDifferences` paragraph) is provenance prose, not an edge; only
  // a name or path reached through a dependency/override/workspace/lockfile container is linkage.
  const walk = (node, inContainer = false) => {
    if (Array.isArray(node)) {
      for (const entry of node) {
        if (isPlainObject(entry)) walk(entry, inContainer);
        else if (inContainer && namesProduct(entry)) push('REPO_LINKAGE', entry);
      }
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [key, child] of Object.entries(node)) {
      const container = DEPENDENCY_CONTAINER_KEYS.has(normalizeFieldName(key));
      // Any package-name key reached through a dependency container is an edge, at any depth:
      // `pnpm.overrides`, the lockfile `packages` map and tsconfig `paths` are all maps of names.
      if (inContainer && FORBIDDEN_PRODUCT_PATTERN.test(key)) push('PACKAGE_DEPENDENCY', key);
      if (container) {
        if (typeof child === 'string') {
          if (namesProduct(child)) push('REPO_LINKAGE', child);
        } else if (Array.isArray(child)) {
          for (const entry of child) if (namesProduct(entry)) push('REPO_LINKAGE', entry);
        }
        walk(child, true);
        continue;
      }
      walk(child, inContainer);
    }
  };
  walk(parsed);
  // A container's contents can be reached by more than one branch (a workspaces array is both a
  // container value and a walking target), so the same edge would otherwise be reported twice.
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.rule}|${finding.line}|${finding.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Scan candidate files for a forbidden dependency. Markdown and other prose are not scanned at
 * all: a historical name may appear as provenance prose, and forbidding the *word* would make
 * the rule unauditable.
 *
 * @param {{path: string, text: string}[]} files
 * @returns {{path: string, line: number, rule: string, text: string}[]}
 */
export function scanForForbiddenProductDependency(files = []) {
  const findings = [];
  for (const file of files) {
    if (!isPlainObject(file) || !isText(file.path)) throw new GeneralAiGatewayError('MALFORMED_ENVELOPE', 'scanned files must be {path, text}');
    if (!EXECUTABLE_FILE_PATTERN.test(file.path)) continue;
    const text = String(file.text ?? '');
    if (/\.json$/i.test(file.path)) { findings.push(...scanJsonManifest(file.path, text)); continue; }
    text.split(/\r?\n/).forEach((line, index) => {
      if (!FORBIDDEN_PRODUCT_PATTERN.test(line)) return;
      for (const rule of FORBIDDEN_DEPENDENCY_RULES) {
        if (rule.pattern.test(line)) {
          findings.push({ path: file.path, line: index + 1, rule: rule.id, text: line.trim().slice(0, 160) });
          return;
        }
      }
    });
  }
  return findings;
}
