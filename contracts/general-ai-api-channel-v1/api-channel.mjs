// API channel + explicit consent + budget policy (GAI-004).
//
// API is an explicit escalation/manual channel, never an automatic fallback from Web. The hard policy is
// enforced structurally rather than advised:
//
//   WEB failure != API permission   a Web failure produces an ApiSwitchProposal, and a proposal grants
//                                   nothing (`grants_permission: false`) 鈥?only a user consent record does.
//   budget available != user consent  the budget check runs AFTER consent, and never substitutes for it.
//   user consent -> budget check -> API admission   that is the only order this module implements, and the
//                                   adapter is unreachable unless admission succeeded.
//
// Usage the provider did not report stays UNKNOWN, never zero. Secret access is by handle reference only,
// and provenance/log records are scanned and redacted before they are returned.
//
// Pure module: the protocol adapter, the clock and the store are injected; no ambient state, no network.
export const API_CHANNEL_CONTRACT_VERSION = 1;

/** Protocol identity is not provider identity: one protocol serves many providers. */
export const API_PROTOCOLS = Object.freeze(['OPENAI_COMPATIBLE', 'ANTHROPIC', 'GEMINI']);

export const CONSENT_KINDS = Object.freeze(['USER_COMMAND', 'USER_SETTING']);
export const CONSENT_VERDICTS = Object.freeze(['APPROVED', 'DENIED']);
export const ADMISSION_VERDICTS = Object.freeze(['ADMITTED', 'REFUSED_NO_CONSENT', 'REFUSED_BUDGET', 'REFUSED_USAGE_UNKNOWN', 'REFUSED_NO_ADAPTER']);
export const BUDGET_VERDICTS = Object.freeze(['WITHIN_BUDGET', 'OVER_PER_ACTION_LIMIT', 'OVER_AGGREGATE_LIMIT', 'AGGREGATE_USAGE_UNKNOWN']);
export const API_FAULT_CODES = Object.freeze(['RATE_LIMITED', 'AUTH_FAILED', 'PROVIDER_FAULT', 'TIMEOUT', 'INVALID_REQUEST', 'STREAMING_UNSUPPORTED']);
export const RETRYABLE_FAULTS = Object.freeze(['RATE_LIMITED', 'TIMEOUT', 'PROVIDER_FAULT']);

/** An explicit user command/setting selecting API for that action IS the consent record. */
export const CONSENT_RECORD_SPEC = Object.freeze({
  consent_id: { required: true, type: 'text' },
  kind: { required: true, type: 'enum', values: CONSENT_KINDS },
  verdict: { required: true, type: 'enum', values: CONSENT_VERDICTS },
  action_ref: { required: true, type: 'text', nullable: true },
  command_ref: { required: true, type: 'text', nullable: true },
  setting_ref: { required: true, type: 'text', nullable: true },
  scope: { required: true, type: 'text' },
  created_at: { required: true, type: 'instant' },
});

export const API_SWITCH_PROPOSAL_SPEC = Object.freeze({
  contract_version: { required: true, type: 'int', constant: API_CHANNEL_CONTRACT_VERSION },
  proposal_id: { required: true, type: 'text' },
  from_channel: { required: true, type: 'enum', values: ['WEB'] },
  to_channel: { required: true, type: 'enum', values: ['API'] },
  reason: { required: true, type: 'text' },
  web_channel_state: { required: true, type: 'text' },
  action_ref: { required: true, type: 'text', nullable: true },
  created_at: { required: true, type: 'instant' },
});

/** A proposal may not carry consent, admission or budget fields: it is a proposal and nothing more. */
export const API_SWITCH_PROPOSAL_INPUT_SPEC = Object.freeze({
  proposal_id: { required: true, type: 'text' },
  reason: { required: true, type: 'text' },
  web_channel_state: { required: true, type: 'text' },
  action_ref: { required: false, type: 'text', nullable: true },
  at: { required: false, type: 'instant', nullable: true },
});

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
const freeze = value => {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};
const isIsoInstantShape = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);
/** Shape is not enough: an impossible instant parses to NaN, and a NaN comparison is always false. */
export const isIsoInstant = value => {
  if (!isIsoInstantShape(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
};

const SECRET_KEY_SHAPE = /(secret|token|password|passwd|api_?key|private_?key|bearer|client_secret|credential_?value|^value$)/i;
const SECRET_VALUE_SHAPE = /^(sk|pk|ghp|xox[baprs]|AKIA)-[A-Za-z0-9_\-]{8,}$/;
const SECRET_SUBSTRING_SHAPE = /(?:sk|pk|ghp|xox[baprs]|AKIA)-[A-Za-z0-9_\-]{8,}/g;

export const looksLikeSecretValue = value => isText(value) && SECRET_VALUE_SHAPE.test(value);

export function findSecretFields(value, path = 'record', found = [], seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return found;
    seen.add(value);
    value.forEach((item, index) => findSecretFields(item, `${path}[${index}]`, found, seen));
    return found;
  }
  if (typeof value === 'string') {
    if ((looksLikeSecretValue(value) || SECRET_SUBSTRING_SHAPE.test(value)) && !found.includes(path)) found.push(path);
    SECRET_SUBSTRING_SHAPE.lastIndex = 0;
    return found;
  }
  if (typeof value === 'boolean' || value === null) return found;
  if (!isPlainObject(value)) return found;
  if (seen.has(value)) return found;
  seen.add(value);
  // Own keys of any enumerability: a non-enumerable own api_key used to be invisible to the scan.
  for (const key of Reflect.ownKeys(value)) {
    const child = value[key];
    const childPath = `${path}.${String(key)}`;
    const keyIsSecret = typeof key === 'string' && SECRET_KEY_SHAPE.test(key) && !/_ref$/.test(key) && typeof child !== 'boolean';
    if (keyIsSecret) {
      if (!found.includes(childPath)) found.push(childPath);
      continue;
    }
    findSecretFields(child, childPath, found, seen);
  }
  return found;
}

export function redact(value, key = null) {
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (typeof value === 'string') {
    if (key !== null && SECRET_KEY_SHAPE.test(key) && !/_ref$/.test(key)) return '[REDACTED]';
    return value.replace(SECRET_SUBSTRING_SHAPE, '[REDACTED]');
  }
  if (!isPlainObject(value)) return value;
  const out = {};
  // Own keys of any enumerability: a hidden secret used to survive redaction into logs and provenance.
  for (const childKey of Reflect.ownKeys(value)) {
    const child = value[childKey];
    out[childKey] = typeof childKey === 'string' && SECRET_KEY_SHAPE.test(childKey) && !/_ref$/.test(childKey) && typeof child !== 'boolean' ? '[REDACTED]' : redact(child, childKey);
  }
  return out;
}

export const API_CHANNEL_CODES = Object.freeze([
  'INVALID_CONSENT', 'INVALID_PROPOSAL', 'INVALID_REQUEST', 'INVALID_ADAPTER', 'INVALID_CLOCK', 'INVALID_BUDGET',
  'CONSENT_REQUIRED', 'BUDGET_REQUIRED', 'NO_ADAPTER_FOR_PROTOCOL', 'ADAPTER_FAILED', 'INVALID_USAGE',
]);

export class ApiChannelError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ApiChannelError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'NO_ADAPTER_FOR_PROTOCOL' ? 501 : code === 'CONSENT_REQUIRED' ? 403 : 400;
  }
}

function checkShape(value, path, spec, errors) {
  if (!isPlainObject(value)) { errors.push(`${path} must be an object`); return; }
  // `key in spec` walks the prototype chain, so a field named constructor/toString passed as part of
  // the contract; only own keys of the spec count, and Reflect.ownKeys closes the non-enumerable case.
  for (const key of Reflect.ownKeys(value)) if (!Object.hasOwn(spec, key)) errors.push(`${path}.${String(key)} is not part of the canonical contract`);
  for (const [key, rule] of Object.entries(spec)) {
    const present = Object.hasOwn(value, key);
    if (!present) { if (rule.required) errors.push(`${path}.${key} is required`); continue; }
    const field = value[key];
    const fieldPath = `${path}.${key}`;
    if (field === null || field === undefined) { if (!rule.nullable) errors.push(`${fieldPath} must not be null`); continue; }
    if (rule.type === 'text' && !isText(field)) errors.push(`${fieldPath} must be nonempty text`);
    if (rule.type === 'instant' && !isIsoInstant(field)) errors.push(`${fieldPath} must be an ISO-8601 UTC instant`);
    if (rule.type === 'int' && (!Number.isSafeInteger(field) || (rule.constant !== undefined && field !== rule.constant))) errors.push(`${fieldPath} must be the integer ${rule.constant}`);
    if (rule.type === 'enum' && !rule.values.includes(field)) errors.push(`${fieldPath} must be one of ${rule.values.join(', ')}`);
  }
}

export const DEFAULT_BUDGET_POLICY = Object.freeze({
  per_action_limit: 1,
  aggregate_limit: 10,
  on_unknown_usage: 'REFUSE',
});

/** A provider response whose usage is absent yields UNKNOWN usage, never a zero that looks like free. */
export function usageFromResponse(response) {
  const usage = isPlainObject(response) ? response.usage : null;
  // A negative count used to be summed in, so a call could *increase* the remaining budget.
  const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const input = count(usage?.input_tokens);
  const output = count(usage?.output_tokens);
  if (input === null && output === null) {
    return freeze({ known: false, input_tokens: null, output_tokens: null, total_tokens: null, cost: null, reason: 'PROVIDER_REPORTED_NO_USAGE' });
  }
  return freeze({ known: true, input_tokens: input, output_tokens: output, total_tokens: (input ?? 0) + (output ?? 0), cost: typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null, reason: 'PROVIDER_REPORTED_USAGE' });
}

export function createApiChannel({ adapters = {}, config = {}, clock = () => new Date().toISOString() } = {}) {
  if (typeof clock !== 'function') throw new ApiChannelError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  if (!isPlainObject(adapters)) throw new ApiChannelError('INVALID_ADAPTER', 'adapters must be a map keyed by protocol');
  const budgetPolicy = { ...DEFAULT_BUDGET_POLICY, ...(isPlainObject(config.budget) ? config.budget : {}) };
  // The budget is the second gate after consent, so its limits must be real: NaN, Infinity, a string or
  // null made BOTH Number.isFinite checks false and admitted every call regardless of size.
  const budgetProblems = [];
  for (const key of ['per_action_limit', 'aggregate_limit']) {
    if (typeof budgetPolicy[key] !== 'number' || !Number.isFinite(budgetPolicy[key]) || budgetPolicy[key] < 0) budgetProblems.push(key);
  }
  if (!['REFUSE', 'ALLOW'].includes(budgetPolicy.on_unknown_usage)) budgetProblems.push('on_unknown_usage');
  if (budgetProblems.length > 0) throw new ApiChannelError('INVALID_BUDGET', 'budget policy values are not usable: ' + budgetProblems.join(', '));
  const adapterCalls = [];
  const provenance = [];
  const log = [];

  const at = value => {
    if (value === undefined || value === null) {
      const produced = clock();
      if (!isIsoInstant(produced)) throw new ApiChannelError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
      return produced;
    }
    if (!isIsoInstant(value)) throw new ApiChannelError('INVALID_REQUEST', 'at must be an ISO-8601 UTC instant');
    return value;
  };

  const record = (event, detail = {}) => {
    log.push(freeze({ event, at: at(undefined), ...redact(detail) }));
    return log.length - 1;
  };

  const validateConsent = consent => {
    const errors = [];
    checkShape(consent, 'consent', CONSENT_RECORD_SPEC, errors);
    if (errors.length) throw new ApiChannelError('INVALID_CONSENT', errors.join('; '));
    if (consent.kind === 'USER_COMMAND' && !isText(consent.command_ref)) throw new ApiChannelError('INVALID_CONSENT', 'a USER_COMMAND consent needs the command reference that carried it');
    if (consent.kind === 'USER_SETTING' && !isText(consent.setting_ref)) throw new ApiChannelError('INVALID_CONSENT', 'a USER_SETTING consent needs the setting reference that carries it');
    return consent;
  };

  const checkBudget = ({ action_ref, request = {}, usage_so_far = null, at: when } = {}) => {
    const estimated = Number.isFinite(request.estimated_actions) ? request.estimated_actions : 1;
    const aggregateUnknown = usage_so_far !== null && isPlainObject(usage_so_far) && usage_so_far.known === false;
    const consumed = usage_so_far === null ? 0 : aggregateUnknown ? null : Number.isFinite(usage_so_far.total_tokens) ? usage_so_far.total_tokens : Number.isFinite(usage_so_far.actions) ? usage_so_far.actions : 0;
    let verdict = 'WITHIN_BUDGET';
    let reason = 'WITHIN_BUDGET';
    if (Number.isFinite(budgetPolicy.per_action_limit) && estimated > budgetPolicy.per_action_limit) {
      verdict = 'OVER_PER_ACTION_LIMIT';
      reason = 'PER_ACTION_LIMIT_EXCEEDED';
    } else if (aggregateUnknown) {
      verdict = 'AGGREGATE_USAGE_UNKNOWN';
      reason = 'AGGREGATE_SPEND_UNKNOWN';
    } else if (Number.isFinite(budgetPolicy.aggregate_limit) && consumed + estimated > budgetPolicy.aggregate_limit) {
      verdict = 'OVER_AGGREGATE_LIMIT';
      reason = 'AGGREGATE_LIMIT_EXCEEDED';
    }
    return freeze({
      contract_version: API_CHANNEL_CONTRACT_VERSION,
      verdict,
      allowed: verdict === 'WITHIN_BUDGET',
      reason,
      action_ref: action_ref ?? null,
      per_action_limit: budgetPolicy.per_action_limit,
      aggregate_limit: budgetPolicy.aggregate_limit,
      estimated_actions: estimated,
      aggregate_consumed: consumed,
      // These two fields are reported as the code actually behaves. `aggregate_usage_known` said true
      // for an absent aggregate and `usage_absent_treated_as_zero` said false while the accounting
      // treated absence as zero — a claim that could not fail, on the second gate after consent.
      aggregate_usage_known: usage_so_far !== null && isPlainObject(usage_so_far) && usage_so_far.known === true,
      on_unknown_usage: budgetPolicy.on_unknown_usage,
      evaluated_at: at(when),
      usage_absent_treated_as_zero: usage_so_far === null,
      user_consent_implied: false,
    });
  };

  const adapterFor = protocol => {
    const adapter = adapters[protocol];
    return isPlainObject(adapter) && typeof adapter.execute === 'function' ? adapter : null;
  };

  const api = {
    /** A Web failure produces a PROPOSAL. It grants nothing and is never consent. */
    proposeApiSwitch({ proposal_id, reason, web_channel_state, action_ref = null, at: when, ...rest } = {}) {
      const errors = [];
      checkShape({ proposal_id, reason, web_channel_state, action_ref, at: when, ...rest }, 'proposal', API_SWITCH_PROPOSAL_INPUT_SPEC, errors);
      if (errors.length) throw new ApiChannelError('INVALID_PROPOSAL', errors.join('; '));
      if (!isText(proposal_id) || !isText(reason) || !isText(web_channel_state)) {
        throw new ApiChannelError('INVALID_PROPOSAL', 'proposal_id, reason and web_channel_state are required');
      }
      const proposal = freeze({
        contract_version: API_CHANNEL_CONTRACT_VERSION,
        proposal_id,
        from_channel: 'WEB',
        to_channel: 'API',
        reason,
        web_channel_state,
        action_ref,
        created_at: at(when),
      });
      record('API_SWITCH_PROPOSED', { proposal_id, reason, web_channel_state });
      return freeze({
        ...proposal,
        automatic: true,
        grants_permission: false,
        web_failure_implies_permission: false,
        requires_consent: true,
        consent: null,
        admission: null,
      });
    },

    validateConsent,
    checkBudget,

    /**
     * The only path to an API execution: consent APPROVED -> budget check -> admission. Any refusal
     * returns without touching an adapter.
     */
    admit({ action_ref, consent = null, proposal = null, request = {}, usage_so_far = null, protocol = null, provider = null, model = null, at: when } = {}) {
      if (!isText(action_ref)) throw new ApiChannelError('INVALID_REQUEST', 'action_ref is required');
      if (!isPlainObject(request)) throw new ApiChannelError('INVALID_REQUEST', 'request must be an object');
      if (protocol !== null && !API_PROTOCOLS.includes(protocol)) throw new ApiChannelError('INVALID_REQUEST', `unknown protocol ${protocol}`);
      const timestamp = at(when);
      const base = {
        contract_version: API_CHANNEL_CONTRACT_VERSION,
        action_ref,
        protocol,
        provider,
        model,
        proposal_ref: isPlainObject(proposal) ? proposal.proposal_id ?? null : null,
        escalation: isPlainObject(proposal),
        web_failure_implies_permission: false,
        budget_available_implies_consent: false,
        evaluated_at: timestamp,
      };
      if (consent === null || consent === undefined) {
        return freeze({ ...base, verdict: 'REFUSED_NO_CONSENT', admitted: false, consent: null, budget: null, api_execution_permitted: false, reason: 'NO_CONSENT_RECORD' });
      }
      const validated = validateConsent(consent);
      if (validated.verdict !== 'APPROVED') {
        record('API_CONSENT_DENIED', { action_ref, consent_id: validated.consent_id });
        return freeze({ ...base, verdict: 'REFUSED_NO_CONSENT', admitted: false, consent: clone(validated), budget: null, api_execution_permitted: false, reason: 'CONSENT_DENIED' });
      }
      const budget = checkBudget({ action_ref, request, usage_so_far, at: timestamp });
      if (!budget.allowed) {
        const verdict = budget.verdict === 'AGGREGATE_USAGE_UNKNOWN' && budgetPolicy.on_unknown_usage === 'REFUSE' ? 'REFUSED_USAGE_UNKNOWN' : 'REFUSED_BUDGET';
        record('API_BUDGET_REFUSED', { action_ref, budget_verdict: budget.verdict });
        return freeze({ ...base, verdict, admitted: false, consent: clone(validated), budget, api_execution_permitted: false, reason: budget.reason });
      }
      if (protocol !== null && !adapterFor(protocol)) {
        record('API_ADAPTER_MISSING', { action_ref, protocol });
        return freeze({ ...base, verdict: 'REFUSED_NO_ADAPTER', admitted: false, consent: clone(validated), budget, api_execution_permitted: false, reason: 'NO_ADAPTER_FOR_PROTOCOL' });
      }
      record('API_ADMITTED', { action_ref, consent_id: validated.consent_id, consent_kind: validated.kind, protocol, provider, model });
      return freeze({
        ...base,
        verdict: 'ADMITTED',
        admitted: true,
        consent: clone(validated),
        budget,
        user_directed: true,
        api_execution_permitted: true,
        reason: 'CONSENT_AND_BUDGET_APPROVED',
      });
    },

    /**
     * Consent -> budget -> adapter. The adapter is called only after admission, faults come back typed,
     * and the provenance record carries references and verdicts with secret material redacted.
     */
    execute({ action_ref, consent = null, proposal = null, protocol, provider = null, model = null, request = {}, credential_ref = null, stream = false, usage_so_far = null, at: when } = {}) {
      const admission = api.admit({ action_ref, consent, proposal, request, usage_so_far, protocol, provider, model, at: when });
      if (!admission.admitted) {
        return freeze({ ok: false, executed: false, adapter_called: false, admission, fault: null, response: null, usage: null, provenance: null });
      }
      // Admission is consent + budget; the adapter is chosen at execution time. A call admitted with no
      // protocol (or a protocol with no adapter) used to reach this line and throw an untyped TypeError.
      const adapter = adapterFor(protocol);
      if (adapter === null) {
        record('API_ADAPTER_MISSING', { action_ref, protocol });
        const fault = freeze({ code: 'NO_ADAPTER_FOR_PROTOCOL', retryable: false, detail: 'no adapter is configured for ' + String(protocol) });
        return freeze({ ok: false, executed: false, adapter_called: false, admission, fault, response: null, usage: null, provenance: null });
      }
      const supportsStreaming = adapter.supports?.streaming === true;
      if (stream && !supportsStreaming) {
        const fault = freeze({ code: 'STREAMING_UNSUPPORTED', retryable: false, detail: `${protocol} adapter does not support streaming` });
        record('API_STREAMING_REFUSED', { action_ref, protocol });
        return freeze({ ok: false, executed: false, adapter_called: false, admission, fault, response: null, usage: null, provenance: api.provenanceFor({ admission, stream }) });
      }
      const timestamp = at(when);
      adapterCalls.push({ action_ref, protocol, provider, model, stream, at: timestamp });
      let raw;
      try {
        raw = adapter.execute({ request: clone(request), provider, model, stream, credential_ref });
      } catch (error) {
        const code = API_FAULT_CODES.includes(error?.code) ? error.code : 'PROVIDER_FAULT';
        const fault = freeze({ code, retryable: RETRYABLE_FAULTS.includes(code), retry_after_ms: Number.isFinite(error?.retry_after_ms) ? error.retry_after_ms : null, detail: redact(String(error?.message ?? error)) });
        record('API_FAULT', { action_ref, protocol, code });
        return freeze({ ok: false, executed: false, adapter_called: true, admission, fault, response: null, usage: null, provenance: api.provenanceFor({ admission, stream: false }) });
      }
      const usage = usageFromResponse(raw);
      record('API_EXECUTED', { action_ref, protocol, usage_known: usage.known });
      return freeze({
        ok: true,
        executed: true,
        adapter_called: true,
        admission,
        fault: null,
        response: freeze(redact(clone(raw))),
        usage,
        provenance: api.provenanceFor({ admission, stream: stream === true, usage }),
      });
    },

    provenanceFor({ admission, stream = false, usage = null } = {}) {
      const entry = freeze({
        contract_version: API_CHANNEL_CONTRACT_VERSION,
        action_ref: admission?.action_ref ?? null,
        channel: 'API',
        admission_verdict: admission?.verdict ?? null,
        consent_ref: admission?.consent?.consent_id ?? null,
        consent_kind: admission?.consent?.kind ?? null,
        user_directed: admission?.user_directed === true,
        proposal_ref: admission?.proposal_ref ?? null,
        escalation: admission?.escalation === true,
        budget_verdict: admission?.budget?.verdict ?? null,
        protocol: admission?.protocol ?? null,
        provider: admission?.provider ?? null,
        model: admission?.model ?? null,
        stream: stream === true,
        usage_known: usage === null ? null : usage.known,
        web_failure_implies_permission: false,
        budget_available_implies_consent: false,
        credential_ref: admission?.credential_ref ?? null,
        references_only: true,
      });
      provenance.push(entry);
      return entry;
    },

    /** Usage accounting: an unreported usage stays unknown and is never folded in as zero. */
    accumulateUsage(existing, usage) {
      if (!isPlainObject(usage) || usage.known !== true) {
        const prior = isPlainObject(existing) ? existing : { actions: 0, total_tokens: 0, known: true };
        return freeze({ ...prior, known: false, total_tokens: null, reason: 'USAGE_UNKNOWN_STAYS_UNKNOWN' });
      }
      const prior = isPlainObject(existing) && existing.known === true ? existing : { actions: 0, total_tokens: 0, known: true };
      return freeze({ known: true, actions: (prior.actions ?? 0) + 1, total_tokens: (prior.total_tokens ?? 0) + (usage.total_tokens ?? 0) });
    },

    adapterCalls: () => clone(adapterCalls),
    provenanceLog: () => clone(provenance),
    logEntries: () => clone(log),
    budgetPolicy: () => freeze(clone(budgetPolicy)),
  };
  return api;
}
