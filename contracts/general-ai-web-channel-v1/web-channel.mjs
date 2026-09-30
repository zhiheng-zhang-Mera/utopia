// General AI Web channel (GAI-003).
//
// Web is the *default* General AI execution channel. This module binds execution to a persistent
// provider/account browser-profile *handle* (never an ephemeral window, never raw cookies), reports the
// channel's state honestly, and refuses to execute when the state does not permit it.
//
// Provider page knowledge lives below the adapter: everything here is provider-neutral.
// Pure module: no browser, sockets, filesystem or clock.
export const WEB_CHANNEL_VERSION = 1;
export const DEFAULT_CHANNEL = 'WEB';

export const CHANNEL_STATES = Object.freeze(['READY', 'AUTH_REQUIRED', 'RATE_LIMITED', 'PAGE_CHANGED', 'BUSY_GENERATING', 'DOWN', 'UNKNOWN']);
/** States from which an execution may start. Everything else is a typed refusal. */
export const EXECUTABLE_STATES = Object.freeze(['READY']);
export const EXECUTION_STATES = Object.freeze(['RUNNING', 'CANCELLED', 'SUCCEEDED', 'FAILED']);
export const WEB_CHANNEL_CODES = Object.freeze([
  'INVALID_WEB_REQUEST', 'ADAPTER_REQUIRED', 'HANDLE_STORE_REQUIRED', 'UNKNOWN_SESSION', 'UNKNOWN_EXECUTION',
  'CHANNEL_AUTH_REQUIRED', 'CHANNEL_RATE_LIMITED', 'CHANNEL_PAGE_CHANGED', 'CHANNEL_BUSY',
  'CHANNEL_DOWN', 'CHANNEL_UNKNOWN', 'RAW_COOKIE_IN_CITY_STATE', 'PARTIAL_NOT_FINAL',
  'EXECUTION_ALREADY_FINISHED', 'PROFILE_HANDLE_UNRESOLVED', 'REAL_PROVIDER_ACCEPTANCE_REQUIRED',
]);

export class WebChannelError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'WebChannelError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = 409;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

/** Raw browser state that must never enter persisted City state. */
export const FORBIDDEN_PERSISTED_FIELDS = Object.freeze(['cookies', 'cookie', 'raw_cookies', 'storage_state', 'session_storage', 'local_storage', 'tokens', 'token', 'password', 'credentials', 'profile_bytes']);
export function findForbiddenPersistedFields(value, path = 'state', found = []) {
  if (Array.isArray(value)) { value.forEach((item, index) => findForbiddenPersistedFields(item, `${path}[${index}]`, found)); return found; }
  if (!isPlainObject(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_PERSISTED_FIELDS.includes(key)) found.push(childPath);
    findForbiddenPersistedFields(child, childPath, found);
  }
  return found;
}

/** The provider-neutral adapter contract. Provider page knowledge stays below it. */
export const WEB_CHANNEL_ADAPTER_PORT = Object.freeze({
  interface: 'WebChannelAdapterPort',
  version: WEB_CHANNEL_VERSION,
  methods: Object.freeze(['describe', 'health', 'open', 'execute', 'observe', 'cancel', 'close', 'recover']),
  provider_neutral: true,
  reimplements_remote_mouse_logic: false,
  uses_generic_computer_use_primitives: true,
});

/**
 * Deterministic adapter double. `script` drives one exec per call, so partial/final behaviour is
 * reproducible without a browser; `state` drives health.
 */
export function createWebChannelAdapterDouble({ providerRef = 'provider-alpha', state = 'READY', script = [], conversationRef = 'conversation-1' } = {}) {
  if (!CHANNEL_STATES.includes(state)) throw new WebChannelError('INVALID_WEB_REQUEST', `unknown channel state ${String(state)}`);
  let cursor = 0;
  let health = state;
  const opened = new Map();
  const calls = [];
  return Object.freeze({
    describe: () => ({ provider_ref: providerRef, channel: DEFAULT_CHANNEL, provider_neutral: true, uses_generic_primitives: true }),
    health: () => { calls.push({ op: 'health' }); return { state: health, checked_at: null }; },
    open: ({ profile_ref }) => { calls.push({ op: 'open' }); opened.set(profile_ref, true); return { opened: true, profile_ref, state: health }; },
    execute: ({ session_ref, request }) => {
      calls.push({ op: 'execute' });
      const step = script[cursor] ?? { partials: [], final: { text: 'done' } };
      cursor += 1;
      return { session_ref, request_ref: request?.request_ref ?? null, steps: step };
    },
    observe: () => ({ op: 'observe' }),
    cancel: () => ({ cancelled: true }),
    close: () => ({ closed: true }),
    recover: ({ profile_ref, conversation_refs }) => { calls.push({ op: 'recover', profile_ref }); return { recovered: true, conversation_refs: [...(conversation_refs ?? [])], state: health }; },
    __setState(next) { if (!CHANNEL_STATES.includes(next)) throw new WebChannelError('INVALID_WEB_REQUEST', String(next)); health = next; },
    __calls: calls,
    __conversationRef: conversationRef,
    __opened: opened,
  });
}

export function createWebChannel({ adapter, handleStore, clock = () => null } = {}) {
  if (!adapter || typeof adapter.health !== 'function' || typeof adapter.execute !== 'function') throw new WebChannelError('ADAPTER_REQUIRED', 'a web channel adapter is required');
  if (!handleStore || typeof handleStore.resolveHandle !== 'function') throw new WebChannelError('HANDLE_STORE_REQUIRED', 'the neutral SecureHandleStorePort is required to resolve profile handles');
  const sessions = new Map();
  const executions = new Map();
  let counter = 0;
  let execCounter = 0;

  const requireSession = sessionRef => {
    const session = sessions.get(sessionRef);
    if (!session) throw new WebChannelError('UNKNOWN_SESSION', String(sessionRef));
    return session;
  };
  const requireExecution = executionRef => {
    const execution = executions.get(executionRef);
    if (!execution) throw new WebChannelError('UNKNOWN_EXECUTION', String(executionRef));
    return execution;
  };

  const refusalFor = state => {
    const map = {
      AUTH_REQUIRED: ['CHANNEL_AUTH_REQUIRED', 'the provider session needs the user to authenticate'],
      RATE_LIMITED: ['CHANNEL_RATE_LIMITED', 'the provider is rate limiting this account'],
      PAGE_CHANGED: ['CHANNEL_PAGE_CHANGED', 'the provider page changed and the adapter must be updated'],
      BUSY_GENERATING: ['CHANNEL_BUSY', 'the provider is still generating a previous response'],
      DOWN: ['CHANNEL_DOWN', 'the provider is down'],
      UNKNOWN: ['CHANNEL_UNKNOWN', 'the channel state is unknown'],
    };
    return map[state] ?? null;
  };

  const channel = {
    provider: { adapter: typeof adapter.describe === 'function' ? adapter.describe() : null, default_channel: DEFAULT_CHANNEL },

    /** Open a session against a persistent profile handle; raw browser state never enters this module. */
    open({ providerRef, accountRef = null, profileHandleRef, at = clock() } = {}) {
      if (!isText(providerRef) || !isText(profileHandleRef)) throw new WebChannelError('INVALID_WEB_REQUEST', 'providerRef and profileHandleRef are required');
      // The handle is resolved through the neutral store; the value stays there.
      const resolved = handleStore.resolveHandle(profileHandleRef);
      if (!resolved || !isText(resolved.handle_ref)) throw new WebChannelError('PROFILE_HANDLE_UNRESOLVED', String(profileHandleRef));
      counter += 1;
      const sessionRef = `web-session-${counter}`;
      const health = adapter.health();
      adapter.open({ profile_ref: profileHandleRef });
      const session = {
        session_ref: sessionRef,
        provider_ref: providerRef,
        account_ref: accountRef,
        profile_handle_ref: profileHandleRef,
        conversation_refs: [],
        state: health.state,
        opened_at: at ?? null,
        raw_cookies_in_state: false,
      };
      sessions.set(sessionRef, session);
      return clone(session);
    },

    /** The session's honest channel state, as reported by the adapter. */
    healthy(sessionRef) {
      const session = requireSession(sessionRef);
      session.state = adapter.health().state;
      return { session_ref: sessionRef, state: session.state };
    },

    /** Execute on the default Web channel. A state that does not permit execution is a typed refusal. */
    execute(sessionRef, { request, at = clock() } = {}) {
      const session = requireSession(sessionRef);
      session.state = adapter.health().state;
      if (!EXECUTABLE_STATES.includes(session.state)) {
        const refusal = refusalFor(session.state);
        if (refusal) throw new WebChannelError(refusal[0], refusal[1]);
        throw new WebChannelError('CHANNEL_UNKNOWN', `channel state ${session.state}`);
      }
      if (!isPlainObject(request) || !isText(request.request_ref)) throw new WebChannelError('INVALID_WEB_REQUEST', 'a request with a request_ref is required');
      const result = adapter.execute({ session_ref: sessionRef, request });
      execCounter += 1;
      const executionRef = `web-execution-${execCounter}`;
      executions.set(executionRef, {
        execution_ref: executionRef,
        session_ref: sessionRef,
        request_ref: request.request_ref,
        state: 'RUNNING',
        partials: [...(result?.steps?.partials ?? [])],
        final: result?.steps?.final ?? null,
        conversation_ref: adapter.__conversationRef ?? null,
        cancelled: false,
        channel: DEFAULT_CHANNEL,
        started_at: at ?? null,
      });
      return { execution_ref: executionRef, session_ref: sessionRef, accepted: true, channel: DEFAULT_CHANNEL, state: 'RUNNING' };
    },

    /** Observe output. A partial result is never reported as the final one. */
    observe(executionRef) {
      const execution = requireExecution(executionRef);
      return {
        execution_ref: executionRef,
        state: execution.state,
        partials: clone(execution.partials),
        // `final` is null until the execution actually finished; a caller cannot mistake a partial for it.
        final: execution.state === 'SUCCEEDED' ? clone(execution.final) : null,
        partial_is_final: false,
        conversation_ref: execution.conversation_ref,
      };
    },

    /** Complete an execution from the adapter's scripted final output. */
    complete(executionRef, { at = clock() } = {}) {
      const execution = requireExecution(executionRef);
      if (execution.state !== 'RUNNING') throw new WebChannelError('EXECUTION_ALREADY_FINISHED', `${executionRef} is ${execution.state}`);
      execution.state = 'SUCCEEDED';
      if (execution.conversation_ref) {
        const session = sessions.get(execution.session_ref);
        if (session && !session.conversation_refs.includes(execution.conversation_ref)) session.conversation_refs.push(execution.conversation_ref);
      }
      return this.observe(executionRef);
    },

    cancel(executionRef, { at = clock() } = {}) {
      const execution = requireExecution(executionRef);
      if (execution.state !== 'RUNNING') return { execution_ref: executionRef, cancelled: false, state: execution.state, idempotent: true };
      execution.state = 'CANCELLED';
      execution.cancelled = true;
      adapter.cancel();
      return { execution_ref: executionRef, cancelled: true, state: execution.state, idempotent: false, at: at ?? null };
    },

    close(sessionRef) {
      const session = requireSession(sessionRef);
      adapter.close();
      sessions.delete(sessionRef);
      return { session_ref: sessionRef, closed: true, conversation_refs: [...session.conversation_refs] };
    },

    /** Persist only what is allowed: handle references, thread references and state. */
    persist(sessionRef) {
      const session = requireSession(sessionRef);
      const persisted = {
        web_channel_version: WEB_CHANNEL_VERSION,
        session_ref: session.session_ref,
        provider_ref: session.provider_ref,
        account_ref: session.account_ref,
        profile_handle_ref: session.profile_handle_ref,
        conversation_refs: [...session.conversation_refs],
        state: session.state,
        opened_at: session.opened_at,
      };
      const forbidden = findForbiddenPersistedFields(persisted);
      if (forbidden.length) throw new WebChannelError('RAW_COOKIE_IN_CITY_STATE', `${forbidden.join(', ')} must never be persisted into City state`);
      return persisted;
    },

    /** Restore after an allowed restart: a handle that still resolves restores; one that does not, re-auths. */
    restore(persisted) {
      if (!isPlainObject(persisted) || !isText(persisted.profile_handle_ref)) throw new WebChannelError('INVALID_WEB_REQUEST', 'a persisted web channel state is required');
      const forbidden = findForbiddenPersistedFields(persisted);
      if (forbidden.length) throw new WebChannelError('RAW_COOKIE_IN_CITY_STATE', `${forbidden.join(', ')} must never be restored from City state`);
      let resolved = null;
      try { resolved = handleStore.resolveHandle(persisted.profile_handle_ref); } catch { resolved = null; }
      if (!resolved) {
        // The profile is gone: the honest answer is AUTH_REQUIRED, not a silent fresh login.
        return { restored: false, state: 'AUTH_REQUIRED', session_ref: persisted.session_ref ?? null, profile_handle_ref: persisted.profile_handle_ref, reason: 'PROFILE_HANDLE_UNRESOLVED' };
      }
      counter += 1;
      const sessionRef = persisted.session_ref ?? `web-session-${counter}`;
      const health = adapter.health();
      const recovery = adapter.recover({ profile_ref: persisted.profile_handle_ref, conversation_refs: persisted.conversation_refs ?? [] });
      sessions.set(sessionRef, {
        session_ref: sessionRef,
        provider_ref: persisted.provider_ref ?? null,
        account_ref: persisted.account_ref ?? null,
        profile_handle_ref: persisted.profile_handle_ref,
        conversation_refs: [...(recovery.conversation_refs ?? [])],
        state: health.state,
        opened_at: persisted.opened_at ?? null,
        raw_cookies_in_state: false,
        restored: true,
      });
      return { restored: true, state: health.state, session_ref: sessionRef, profile_handle_ref: persisted.profile_handle_ref, conversation_refs: [...(recovery.conversation_refs ?? [])], reason: null };
    },

    /** Conversation/thread references captured for a session, which is how a chat is reopened. */
    conversations(sessionRef) {
      const session = requireSession(sessionRef);
      return Object.freeze(session.conversation_refs.map(conversationRef => Object.freeze({ conversation_ref: conversationRef, session_ref: session.sessionRef ?? sessionRef, reopenable: true })));
    },
  };

  return Object.freeze(channel);
}

/**
 * Real-provider acceptance is a programme-integration gate. A component run that has no real provider
 * access must record the deferral rather than claim proof it does not have.
 */
export function realProviderAcceptanceStatus({ providerAvailable, evidenceRef = null } = {}) {
  if (providerAvailable === true && isText(evidenceRef)) return Object.freeze({ status: 'PERFORMED', evidence_ref: evidenceRef, fabricated: false });
  return Object.freeze({ status: 'REAL_PROVIDER_ACCEPTANCE_DEFERRED_TO_PROGRAMME_INTEGRATION', evidence_ref: null, fabricated: false });
}
