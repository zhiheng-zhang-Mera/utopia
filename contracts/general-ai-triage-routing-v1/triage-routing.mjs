// Deterministic + JEV triage routing (GAI-005).
//
// Routing is deterministic first. A known local command is answered locally and the optional JEV triage is
// never even consulted, so basic Utopia routing cannot depend on a model being reachable.
//
// When text is ambiguous the gateway MAY ask the optional `JevTriagePort` to classify it. JEV is a
// classifier: it may return intent/complexity/risk/confidence/needs-general-AI/channel recommendations and
// nothing else. It never executes an Action, never grants permission and never becomes canonical state, and
// gateway policy — not JEV — makes the final routing decision. The two are recorded separately, so an audit
// can always answer "what did JEV recommend?" and "what did the gateway actually choose?" independently.
//
// Unavailable, timed-out, malformed or low-confidence JEV output is non-blocking: the router falls back to
// the deterministic candidate list and the manual picker. Engineering/HARD intent is routed out to the
// Engineering programme through a typed port rather than being executed by General AI, and side-effecting
// or destructive intent stays behind the existing confirmation/permission boundary.
//
// Pure module: ports and the clock are injected; no network, no ambient state.
export const TRIAGE_ROUTING_CONTRACT_VERSION = 1;

export const CHANNELS = Object.freeze(['DETERMINISTIC', 'GENERAL_AI', 'ENGINEERING', 'MANUAL_PICKER', 'CONFIRMATION_REQUIRED']);
export const INTENTS = Object.freeze(['QUESTION', 'COMMAND', 'ACTION', 'ENGINEERING', 'AMBIGUOUS']);
export const COMPLEXITIES = Object.freeze(['TRIVIAL', 'SIMPLE', 'MODERATE', 'COMPLEX']);
export const RISKS = Object.freeze(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'DESTRUCTIVE']);
export const DESTRUCTIVE_RISKS = Object.freeze(['HIGH', 'DESTRUCTIVE']);
export const RECOMMENDATION_SOURCES = Object.freeze(['DETERMINISTIC', 'JEV', 'NONE']);
export const FALLBACK_REASONS = Object.freeze([
  'JEV_UNAVAILABLE', 'JEV_TIMEOUT', 'JEV_MALFORMED', 'JEV_LOW_CONFIDENCE', 'JEV_MAY_NOT_EXECUTE',
  'JEV_RECOMMENDATION_ABSENT',
]);

export const TRIAGE_CODES = Object.freeze([
  'INVALID_REQUEST', 'INVALID_POLICY', 'INVALID_CLOCK', 'INVALID_JEV_OUTPUT', 'UNKNOWN_CHANNEL',
  'JEV_MAY_NOT_EXECUTE', 'ENGINEERING_ROUTE_DEFERRED', 'DETERMINISTIC_HANDLER_REQUIRED',
]);

export class TriageError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'TriageError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'ENGINEERING_ROUTE_DEFERRED' ? 501 : 400;
    Object.assign(this, extra);
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
const freeze = value => {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

/** Fields that would turn a classification into an execution or an authority transfer. */
export const EXECUTION_FIELDS = Object.freeze([
  'action_ref', 'actions', 'execute', 'execution', 'handler_ref', 'handler', 'call', 'invoke', 'invocation',
  'grants', 'permissions', 'permission_grants', 'grant', 'authority', 'lease', 'execution_lease',
  'action_key', 'capabilities', 'capability_grants', 'scopes', 'access_token', 'credentials', 'credential_ref',
  'task_ref', 'lease_ref', 'side_effects', 'apply', 'commit', 'dispatch',
]);

export function findExecutionFields(value, path = 'jev', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findExecutionFields(item, `${path}[${index}]`, found));
    return found;
  }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (EXECUTION_FIELDS.includes(key.toLowerCase())) found.push(childPath);
    findExecutionFields(child, childPath, found);
  }
  return found;
}

export const DEFAULT_TRIAGE_POLICY = Object.freeze({
  policy_ref: 'policy:gai-triage-default',
  min_confidence: 0.5,
  engineering_intents: Object.freeze(['ENGINEERING']),
  engineering_complexities: Object.freeze(['COMPLEX']),
  confirmation_risks: DESTRUCTIVE_RISKS,
  confirmation_intents: Object.freeze(['ACTION']),
  ambiguous_channel: 'MANUAL_PICKER',
  general_ai_intents: Object.freeze(['QUESTION', 'COMMAND', 'AMBIGUOUS']),
  jev_enabled: true,
});

const DETERMINISTIC_SPEC = Object.freeze({
  command_ref: { required: true, type: 'text' },
  handler_ref: { required: true, type: 'text' },
  description: { required: false, type: 'text' },
});

const INTENT_ALIASES = Object.freeze({
  QUESTION: 'QUESTION', QUERY: 'QUESTION', ASK: 'QUESTION',
  COMMAND: 'COMMAND', INSTRUCTION: 'COMMAND', CHAT: 'COMMAND',
  ACTION: 'ACTION', SIDE_EFFECT: 'ACTION', TOOL: 'ACTION',
  ENGINEERING: 'ENGINEERING', CODING: 'ENGINEERING', CODE: 'ENGINEERING', BUILD: 'ENGINEERING', HARD: 'ENGINEERING',
  AMBIGUOUS: 'AMBIGUOUS', UNKNOWN: 'AMBIGUOUS', UNCLEAR: 'AMBIGUOUS',
});

const COMPLEXITY_ALIASES = Object.freeze({
  TRIVIAL: 'TRIVIAL', EASY: 'SIMPLE', SIMPLE: 'SIMPLE', MODERATE: 'MODERATE', MEDIUM: 'MODERATE',
  COMPLEX: 'COMPLEX', HARD: 'COMPLEX', LARGE: 'COMPLEX',
});

const RISK_ALIASES = Object.freeze({
  NONE: 'NONE', SAFE: 'NONE', LOW: 'LOW', MEDIUM: 'MEDIUM', MODERATE: 'MEDIUM', HIGH: 'HIGH',
  DESTRUCTIVE: 'DESTRUCTIVE', CRITICAL: 'DESTRUCTIVE',
});

const CHANNEL_ALIASES = Object.freeze({
  DETERMINISTIC: 'DETERMINISTIC', LOCAL: 'DETERMINISTIC',
  GENERAL_AI: 'GENERAL_AI', GAI: 'GENERAL_AI', API: 'GENERAL_AI', WEB: 'GENERAL_AI', PROVIDER: 'GENERAL_AI',
  ENGINEERING: 'ENGINEERING', EM: 'ENGINEERING',
  MANUAL_PICKER: 'MANUAL_PICKER', MANUAL: 'MANUAL_PICKER', PICKER: 'MANUAL_PICKER',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED', CONFIRM: 'CONFIRMATION_REQUIRED',
});

/**
 * Normalize whatever the triage port returned into the one neutral recommendation shape. Anything the
 * vocabulary does not cover becomes null rather than being coerced into a false certainty.
 */
export function normalizeJevOutput(raw) {
  if (!isPlainObject(raw)) return freeze({ ok: false, reason: 'NOT_AN_OBJECT', recommendation: null });
  const execution = findExecutionFields(raw);
  const pick = (value, aliases) => (isText(value) ? aliases[String(value).trim().toUpperCase()] ?? null : null);
  const intent = pick(raw.intent ?? raw.category ?? raw.kind, INTENT_ALIASES);
  const complexity = pick(raw.complexity ?? raw.difficulty ?? raw.size, COMPLEXITY_ALIASES);
  const risk = pick(raw.risk ?? raw.risk_level ?? raw.danger, RISK_ALIASES);
  const preferred = pick(raw.preferred_channel ?? raw.channel ?? raw.recommended_channel ?? raw.route, CHANNEL_ALIASES);
  const needs = typeof raw.needs_general_ai === 'boolean' ? raw.needs_general_ai
    : typeof raw.needs_general_ai === 'string' ? ['TRUE', 'YES'].includes(raw.needs_general_ai.trim().toUpperCase()) ? true
      : ['FALSE', 'NO'].includes(raw.needs_general_ai.trim().toUpperCase()) ? false : null
      : null;
  const confidence = Number.isFinite(raw.confidence) ? raw.confidence
    : isText(raw.confidence) && Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : null;
  const ambiguity = typeof raw.ambiguous === 'boolean' ? raw.ambiguous
    : typeof raw.ambiguity === 'boolean' ? raw.ambiguity : null;
  const escalate = typeof raw.escalate === 'boolean' ? raw.escalate : null;
  if (intent === null && complexity === null && risk === null && preferred === null && needs === null) {
    return freeze({ ok: false, reason: 'NOTHING_RECOGNIZED', recommendation: null, execution_fields: execution });
  }
  return freeze({
    ok: true,
    reason: null,
    execution_fields: execution,
    recommendation: freeze({
      source: 'JEV',
      intent,
      complexity,
      risk,
      confidence,
      needs_general_ai: needs,
      preferred_channel: preferred,
      ambiguous: ambiguity,
      escalate: escalate,
      raw_intent: isText(raw.intent) ? raw.intent : null,
    }),
  });
}

export function createTriageRouter({
  deterministicCommands = [],
  jev = null,
  engineeringRoute = null,
  policy = {},
  clock = () => new Date().toISOString(),
} = {}) {
  if (typeof clock !== 'function') throw new TriageError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  const config = {
    ...DEFAULT_TRIAGE_POLICY,
    ...(isPlainObject(policy) ? policy : {}),
    decide: isPlainObject(policy) && typeof policy.decide === 'function' ? policy.decide : null,
  };
  if (!Array.isArray(deterministicCommands)) throw new TriageError('INVALID_POLICY', 'deterministicCommands must be an array');
  const commands = new Map();
  for (const entry of deterministicCommands) {
    if (!isPlainObject(entry) || !isText(entry.command_ref) || !isText(entry.handler_ref)) {
      throw new TriageError('DETERMINISTIC_HANDLER_REQUIRED', 'each deterministic command needs a command_ref and a handler_ref');
    }
    for (const key of Object.keys(entry)) if (!(key in DETERMINISTIC_SPEC)) throw new TriageError('INVALID_POLICY', `deterministic command field ${key} is not part of the canonical contract`);
    commands.set(entry.command_ref, freeze({ command_ref: entry.command_ref, handler_ref: entry.handler_ref, description: entry.description ?? null }));
  }
  const jevPort = isPlainObject(jev) && typeof jev.classify === 'function' ? jev : null;
  const engineeringPort = isPlainObject(engineeringRoute) && typeof engineeringRoute.route === 'function' ? engineeringRoute : null;
  const audit = [];
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isIsoInstant(produced)) throw new TriageError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
    return produced;
  };

  const policyDecide = ({ recommendation, deterministic_match, text, context }) => {
    const fallback = () => {
      if (isPlainObject(deterministic_match)) {
        return { route: 'DETERMINISTIC', reason: 'DETERMINISTIC_MATCH', handler_ref: deterministic_match.handler_ref, requires_confirmation: false };
      }
      return { route: config.ambiguous_channel, reason: 'NO_MODEL_SIGNAL', handler_ref: null, requires_confirmation: false };
    };
    let decision;
    if (config.decide !== null) {
      decision = config.decide({ recommendation: clone(recommendation), deterministic_match: clone(deterministic_match), text, context: clone(context ?? null) });
      if (!isPlainObject(decision) || !CHANNELS.includes(decision.route)) {
        throw new TriageError('UNKNOWN_CHANNEL', 'the gateway policy returned no canonical route');
      }
      return { route: decision.route, reason: isText(decision.reason) ? decision.reason : 'POLICY_DECISION', handler_ref: isText(decision.handler_ref) ? decision.handler_ref : null, requires_confirmation: decision.requires_confirmation === true };
    }
    if (isPlainObject(deterministic_match)) return fallback();
    if (recommendation === null) return fallback();
    const risk = recommendation.risk;
    const intent = recommendation.intent;
    if ((risk !== null && config.confirmation_risks.includes(risk)) || (intent !== null && config.confirmation_intents.includes(intent))) {
      return { route: 'CONFIRMATION_REQUIRED', reason: 'SIDE_EFFECT_BOUNDARY', handler_ref: null, requires_confirmation: true };
    }
    if ((intent !== null && config.engineering_intents.includes(intent)) || (recommendation.complexity !== null && config.engineering_complexities.includes(recommendation.complexity))) {
      return { route: 'ENGINEERING', reason: 'ENGINEERING_INTENT', handler_ref: null, requires_confirmation: false };
    }
    const channel = recommendation.preferred_channel;
    if (channel !== null) return { route: channel, reason: 'JEV_RECOMMENDATION', handler_ref: null, requires_confirmation: false };
    if (needsGeneralAi(recommendation)) return { route: 'GENERAL_AI', reason: 'JEV_NEEDS_GENERAL_AI', handler_ref: null, requires_confirmation: false };
    return fallback();
  };

  const needsGeneralAi = recommendation => recommendation?.needs_general_ai === true;

  const api = {
    policy: () => freeze(clone({ ...config, decide: undefined })),

    /** Known local commands take the deterministic path; JEV is not consulted at all. */
    deterministicMatch(text) {
      if (!isText(text)) return null;
      const trimmed = text.trim();
      for (const [command_ref, entry] of commands) {
        if (trimmed === command_ref || trimmed.startsWith(`${command_ref} `)) return entry;
      }
      return null;
    },

    route({ text, context = null, request_ref = null, at: when } = {}) {
      if (!isText(text)) throw new TriageError('INVALID_REQUEST', 'text is required to route');
      const timestamp = when ?? now();
      if (!isIsoInstant(timestamp)) throw new TriageError('INVALID_REQUEST', 'at must be an ISO-8601 UTC instant');
      counter += 1;
      const decision_id = `triage:${counter}`;

      const deterministic_match = api.deterministicMatch(text);
      let jev_attempted = false;
      let jev_used = false;
      let fallback_reason = null;
      let recommendation = null;
      let jev_note = null;

      // Deterministic first: a known command must not depend on any model.
      if (deterministic_match === null && jevPort !== null && config.jev_enabled === true) {
        jev_attempted = true;
        let raw = null;
        try {
          raw = jevPort.classify({ text, context: clone(context) });
        } catch (error) {
          const code = String(error?.code ?? '').toUpperCase();
          fallback_reason = code === 'TIMEOUT' || code === 'ETIMEDOUT' ? 'JEV_TIMEOUT' : 'JEV_UNAVAILABLE';
          jev_note = String(error?.message ?? error);
        }
        if (fallback_reason === null && raw === undefined) {
          fallback_reason = 'JEV_UNAVAILABLE';
          jev_note = 'the triage port returned nothing';
        }
        if (fallback_reason === null) {
          const normalized = normalizeJevOutput(raw);
          if (!normalized.ok) {
            fallback_reason = 'JEV_MALFORMED';
            jev_note = normalized.reason;
          } else if (normalized.execution_fields.length > 0) {
            // A classifier may not hand back an execution, an authority transfer or a credential.
            fallback_reason = 'JEV_MAY_NOT_EXECUTE';
            jev_note = normalized.execution_fields.join(', ');
          } else if (normalized.recommendation.confidence !== null && normalized.recommendation.confidence < config.min_confidence) {
            fallback_reason = 'JEV_LOW_CONFIDENCE';
            jev_note = `confidence ${normalized.recommendation.confidence} below ${config.min_confidence}`;
          } else {
            recommendation = normalized.recommendation;
            jev_used = true;
          }
        }
      } else if (deterministic_match === null && config.jev_enabled !== true) {
        fallback_reason = 'JEV_UNAVAILABLE';
        jev_note = 'triage is disabled by policy';
      } else if (deterministic_match === null && jevPort === null) {
        fallback_reason = 'JEV_UNAVAILABLE';
        jev_note = 'no triage port is configured';
      }

      if (fallback_reason !== null) {
        recommendation = freeze({ source: 'NONE', intent: null, complexity: null, risk: null, confidence: null, needs_general_ai: null, preferred_channel: null, ambiguous: null, escalate: null, raw_intent: null });
      }

      const chosen = policyDecide({ recommendation: jev_used ? recommendation : null, deterministic_match, text, context });
      const chosen_channel = chosen.route;
      let engineering = null;
      let deferred = null;
      let general_ai_invoked = false;

      if (chosen_channel === 'ENGINEERING') {
        if (engineeringPort === null) {
          deferred = freeze({
            code: 'ENGINEERING_ROUTE_DEFERRED',
            seam: 'ENGINEERING_ROUTE_PORT',
            requested_action: 'HAND_OFF_TO_ENGINEERING',
            deferred: true,
            succeeded: false,
            note: 'complex engineering intent must be executed by the Engineering programme; General AI does not execute it',
          });
        } else {
          engineering = freeze(clone(engineeringPort.route({
            text,
            recommendation: clone(recommendation),
            context: clone(context),
            request_ref,
          })) ?? { routed: true });
        }
      } else if (chosen_channel === 'GENERAL_AI') {
        // The router only reports the channel; admission (consent + budget) belongs to the channel itself.
        general_ai_invoked = false;
      }

      const decision = freeze({
        contract_version: TRIAGE_ROUTING_CONTRACT_VERSION,
        decision_id,
        request_ref,
        input_ref: request_ref ?? `text:${text.slice(0, 24)}`,
        deterministic_match: deterministic_match === null ? null : freeze({ command_ref: deterministic_match.command_ref, handler_ref: deterministic_match.handler_ref }),
        jev_attempted,
        jev_used,
        jev_fallback_reason: fallback_reason,
        jev_note,
        // Recommendation and chosen route are separate fields on purpose: an audit can always distinguish them.
        recommendation,
        recommendation_source: jev_used ? 'JEV' : deterministic_match !== null ? 'DETERMINISTIC' : 'NONE',
        chosen: freeze({
          route: chosen_channel,
          reason: chosen.reason,
          decided_by: config.decide !== null ? 'GATEWAY_POLICY_CUSTOM' : 'GATEWAY_POLICY_DEFAULT',
          policy_ref: config.policy_ref,
          handler_ref: chosen.handler_ref,
          requires_confirmation: chosen.requires_confirmation === true,
        }),
        engineering: engineering ?? deferred,
        engineering_deferred: deferred !== null,
        general_ai_invoked,
        action_executed: false,
        permission_granted: false,
        jev_is_canonical_truth: false,
        at: timestamp,
      });
      audit.push(decision);
      return decision;
    },

    auditTrail: () => clone(audit),
    deterministicCommands: () => freeze(clone([...commands.values()])),
    hasJev: () => jevPort !== null,
    hasEngineeringRoute: () => engineeringPort !== null,
  };
  return Object.freeze(api);
}
