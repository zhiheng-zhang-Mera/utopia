// Conversation + InputBundle + streaming + cancellation (GAI-006).
//
// A Utopia conversation has its own identity. Provider threads, provider sessions, devices and channels are
// *backend references* that may appear, change or vanish while the conversation continues — and when a
// backend thread is lost, that is reported, never papered over as a continuation that did not happen.
//
// Rich input is canonical here too: an InputBundle is bounded (counts, sizes, media types), every binary
// item carries a digest and a logical reference with its origin device and staging policy instead of a
// hard-coded remote path, and a temporary staging area always has an explicit cleanup policy.
//
// Streaming is a GAI domain-semantic stream. A PartialResult is ordered and versioned and is NEVER a
// terminal success; a ResultEnvelope is the terminal record. Remote Fabric may carry the bytes, but an RF
// transport envelope never becomes canonical conversation or result state.
//
// Cancellation is idempotent and works through backend/device changes, and a result that arrives after a
// cancellation is reconciled — recorded and discarded — rather than silently accepted.
//
// Pure module: entropy, the optional digest function and the clock are injected; no network, no storage.
export const CONVERSATION_CONTRACT_VERSION = 1;

export const CONVERSATION_STATES = Object.freeze(['OPEN', 'CLOSED']);
export const TURN_STATES = Object.freeze(['PENDING', 'STREAMING', 'COMPLETED', 'CANCELLED']);
export const TERMINAL_TURN_STATES = Object.freeze(['COMPLETED', 'CANCELLED']);
export const BINDING_STATES = Object.freeze(['ACTIVE', 'SUPERSEDED', 'LOST']);
export const STAGING_POLICIES = Object.freeze(['NO_STAGING', 'DELETE_AFTER_USE', 'RETAIN']);
export const EVENT_KINDS = Object.freeze(['PARTIAL', 'CANCELLED']);
export const CANONICAL_STATE_SOURCE = 'GAI_CONVERSATION';

export const CONVERSATION_CODES = Object.freeze([
  'INVALID_CONVERSATION', 'ENTROPY_REQUIRED', 'INVALID_CLOCK', 'INVALID_REQUEST', 'UNKNOWN_CONVERSATION',
  'UNKNOWN_TURN', 'UNKNOWN_BUNDLE', 'CONVERSATION_CLOSED', 'INVALID_BUNDLE', 'BOUNDS_EXCEEDED',
  'MEDIA_TYPE_NOT_ALLOWED', 'FILE_TOO_LARGE', 'DIGEST_REQUIRED', 'INVALID_DIGEST', 'PROVENANCE_REQUIRED',
  'STAGING_POLICY_REQUIRED', 'NO_BACKEND_BINDING', 'BACKEND_THREAD_LOST', 'REBIND_REQUIRED',
  'PARTIAL_OUT_OF_ORDER', 'PARTIAL_LIMIT', 'TURN_ALREADY_COMPLETE', 'TURN_CANCELLED',
  'LATE_RESULT_AFTER_CANCEL', 'INVALID_CANCEL', 'TRANSPORT_IS_NOT_CANONICAL',
]);

const CONFLICT_CODES = new Set(['TURN_ALREADY_COMPLETE', 'TURN_CANCELLED', 'BACKEND_THREAD_LOST', 'REBIND_REQUIRED', 'LATE_RESULT_AFTER_CANCEL', 'CONVERSATION_CLOSED']);

export class ConversationError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ConversationError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_CONVERSATION' || code === 'UNKNOWN_TURN' || code === 'UNKNOWN_BUNDLE' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
    Object.assign(this, extra);
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
const freeze = value => {
  const seen = new WeakSet();
  const walk = node => {
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) return node;
    seen.add(node);
    for (const child of Object.values(node)) walk(child);
    return Object.freeze(node);
  };
  return walk(value);
};
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);
export const isDigest = value => isText(value) && /^sha256:[0-9a-f]{8,64}$/i.test(value);

const INSTANT_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
/** The shape regex accepts a calendar-impossible date, so every component must survive a round trip. */
const isRealInstant = value => {
  if (!isIsoInstant(value)) return false;
  const parts = INSTANT_PARTS.exec(value);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  return date.getUTCFullYear() === Number(parts[1])
    && date.getUTCMonth() + 1 === Number(parts[2])
    && date.getUTCDate() === Number(parts[3])
    && date.getUTCHours() === Number(parts[4])
    && date.getUTCMinutes() === Number(parts[5])
    && date.getUTCSeconds() === Number(parts[6]);
};

/** A caller-supplied instant is validated exactly like the injected clock. */
const callerInstant = (value, label = 'at') => {
  if (!isRealInstant(value)) throw new ConversationError('INVALID_REQUEST', `${label} must be an ISO-8601 UTC instant such as 2026-01-01T00:00:00Z, got ${String(value)}`);
  return value;
};

export const DEFAULT_CONVERSATION_POLICY = Object.freeze({
  policy_ref: 'policy:gai-conversation-default',
  max_text_chars: 20000,
  max_files: 8,
  max_images: 8,
  max_references: 32,
  max_context_refs: 32,
  max_file_bytes: 25000000,
  allowed_media_types: Object.freeze(['text/plain', 'text/markdown', 'application/json', 'application/pdf', 'image/png', 'image/jpeg', 'image/webp']),
  max_partials_per_turn: 500,
  require_digest: true,
});

const ITEM_SPEC = Object.freeze({
  logical_ref: { required: true, type: 'text' },
  media_type: { required: true, type: 'text' },
  size_bytes: { required: true, type: 'int' },
  digest: { required: false, type: 'digest' },
  origin_device_ref: { required: true, type: 'text' },
  display_name: { required: false, type: 'text' },
  staging: { required: false, type: 'object' },
});

const STAGING_SPEC = Object.freeze({
  policy: { required: true, type: 'enum', values: STAGING_POLICIES },
  staging_ref: { required: false, type: 'text' },
  cleanup_by: { required: false, type: 'instant' },
});

function checkShape(value, path, spec, errors) {
  if (!isPlainObject(value)) { errors.push(`${path} must be an object`); return; }
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !Object.hasOwn(spec, key)) errors.push(`${path}.${String(key)} is not part of the canonical contract`);
  for (const [key, rule] of Object.entries(spec)) {
    const present = Object.hasOwn(value, key);
    if (!present) { if (rule.required) errors.push(`${path}.${key} is required`); continue; }
    const field = value[key];
    const fieldPath = `${path}.${key}`;
    if (field === null || field === undefined) { if (!rule.nullable) errors.push(`${fieldPath} must not be null`); continue; }
    if (rule.type === 'text' && !isText(field)) errors.push(`${fieldPath} must be nonempty text`);
    if (rule.type === 'instant' && !isRealInstant(field)) errors.push(`${fieldPath} must be an ISO-8601 UTC instant`);
    if (rule.type === 'digest' && !isDigest(field)) errors.push(`${fieldPath} must be a sha256 digest`);
    if (rule.type === 'int' && (!Number.isSafeInteger(field) || field < 0)) errors.push(`${fieldPath} must be a non-negative integer`);
    if (rule.type === 'object' && !isPlainObject(field)) errors.push(`${fieldPath} must be an object`);
    if (rule.type === 'array' && !Array.isArray(field)) errors.push(`${fieldPath} must be an array`);
    if (rule.type === 'enum' && !rule.values.includes(field)) errors.push(`${fieldPath} must be one of ${rule.values.join(', ')}`);
  }
}

export function createConversationRegistry({ entropy, digest = null, clock = () => new Date().toISOString(), policy = {} } = {}) {
  if (typeof entropy !== 'function') throw new ConversationError('ENTROPY_REQUIRED', 'an entropy source is required; this module must not invent its own conversation identity');
  if (typeof clock !== 'function') throw new ConversationError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  if (policy !== undefined && policy !== null && !isPlainObject(policy)) throw new ConversationError('INVALID_REQUEST', 'policy must be an object');
  const config = { ...DEFAULT_CONVERSATION_POLICY, ...(policy ?? {}) };
  for (const key of ['max_text_chars', 'max_files', 'max_images', 'max_references', 'max_context_refs', 'max_file_bytes', 'max_partials_per_turn']) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) {
      throw new ConversationError('INVALID_REQUEST', `policy.${key} must be a positive safe integer, got ${String(config[key])}`);
    }
  }
  if (!Array.isArray(config.allowed_media_types) || config.allowed_media_types.length === 0 || config.allowed_media_types.some(entry => !isText(entry))) {
    throw new ConversationError('INVALID_REQUEST', 'policy.allowed_media_types must be a non-empty list of media types');
  }
  if (typeof config.require_digest !== 'boolean') {
    throw new ConversationError('INVALID_REQUEST', 'policy.require_digest must be a boolean, so the verification requirement cannot be disabled by a non-boolean value');
  }
  const digestPort = typeof digest === 'function' ? digest : null;
  const conversations = new Map();
  const bundles = new Map();
  const turns = new Map();
  const partials = new Map();
  const stagingReleased = new Map();
  const journal = [];
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isRealInstant(produced)) throw new ConversationError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
    return produced;
  };

  const note = (event, at, detail = {}) => {
    journal.push(freeze({ event, at, ...detail }));
    return journal.length - 1;
  };

  const randomHex = bytes => {
    const produced = entropy(bytes);
    if (typeof produced !== 'string' || produced.length < bytes * 2 || !/^[0-9a-f]+$/i.test(produced)) {
      throw new ConversationError('ENTROPY_REQUIRED', 'the entropy source returned unusable material');
    }
    return produced.slice(0, bytes * 2).toLowerCase();
  };

  const requireConversation = conversation_id => {
    const conversation = conversations.get(conversation_id);
    if (!conversation) throw new ConversationError('UNKNOWN_CONVERSATION', `no conversation ${String(conversation_id)}`);
    return conversation;
  };

  const requireTurn = turn_ref => {
    const turn = turns.get(turn_ref);
    if (!turn) throw new ConversationError('UNKNOWN_TURN', `no turn ${String(turn_ref)}`);
    return turn;
  };

  const activeBinding = conversation => conversation.bindings.find(entry => entry.state === 'ACTIVE') ?? null;

  const conversationProjection = conversation => freeze({
    contract_version: CONVERSATION_CONTRACT_VERSION,
    conversation_id: conversation.conversation_id,
    state: conversation.state,
    created_at: conversation.created_at,
    subject_ref: conversation.subject_ref,
    turn_count: conversation.turns.length,
    binding_version: conversation.binding_version,
    active_binding: activeBinding(conversation) === null ? null : clone(activeBinding(conversation)),
    backend_bindings: clone(conversation.bindings),
    continuation_available: activeBinding(conversation)?.state === 'ACTIVE',
    identity_is_provider_independent: true,
    provider_thread_is_canonical: false,
    canonical_state_source: CANONICAL_STATE_SOURCE,
  });

  const validateItem = (item, path, kind) => {
    // Digest first: "you forgot a digest" and "your digest is malformed" are different problems.
    const declared = isPlainObject(item) ? item.digest : undefined;
    if (declared === undefined || declared === null) {
      if (config.require_digest === true) throw new ConversationError('DIGEST_REQUIRED', `${path}.digest is required: a file or image cannot enter a bundle unverified`);
    } else if (!isDigest(declared)) {
      throw new ConversationError('INVALID_DIGEST', `${path}.digest must be a sha256 digest, got ${String(declared)}`);
    }
    const errors = [];
    checkShape(item, path, ITEM_SPEC, errors);
    if (errors.length) throw new ConversationError('INVALID_BUNDLE', errors.join('; '));
    if (item.digest !== undefined && item.digest !== null && !isDigest(item.digest)) throw new ConversationError('INVALID_DIGEST', `${path}.digest must be a sha256 digest`);
    if (!config.allowed_media_types.includes(item.media_type)) {
      throw new ConversationError('MEDIA_TYPE_NOT_ALLOWED', `${path}.media_type ${item.media_type} is not in the allowed set`);
    }
    const limit = kind === 'image' ? config.max_file_bytes : config.max_file_bytes;
    if (item.size_bytes > limit) throw new ConversationError('FILE_TOO_LARGE', `${path}.size_bytes ${item.size_bytes} exceeds ${limit}`);
    if (item.staging !== undefined) {
      const stagingErrors = [];
      checkShape(item.staging, `${path}.staging`, STAGING_SPEC, stagingErrors);
      if (stagingErrors.length) throw new ConversationError('STAGING_POLICY_REQUIRED', stagingErrors.join('; '));
      if (item.staging.policy !== 'NO_STAGING') {
        if (item.staging.cleanup_by !== undefined && !isRealInstant(item.staging.cleanup_by)) {
          throw new ConversationError('STAGING_POLICY_REQUIRED', `${path}.staging.cleanup_by must be an ISO-8601 UTC instant`);
        }
        if (item.staging.policy === 'DELETE_AFTER_USE' && item.staging.cleanup_by === undefined) {
          throw new ConversationError('STAGING_POLICY_REQUIRED', `${path}.staging.cleanup_by is required when staging must be cleaned up`);
        }
      }
    }
    return freeze({
      ...clone(item),
      digest: item.digest ?? null,
      display_name: item.display_name ?? null,
      staging: item.staging === undefined ? freeze({ policy: 'NO_STAGING', staging_ref: null, cleanup_by: null }) : freeze(clone(item.staging)),
      kind,
      canonical_path: null,
      hard_coded_remote_path: false,
    });
  };

  const api = {
    policy: () => freeze(clone(config)),

    createConversation({ subject_ref = null, at: when } = {}) {
      const created_at = when === undefined || when === null ? now() : callerInstant(when);
      counter += 1;
      const conversation = {
        conversation_id: `conversation:${randomHex(16)}`,
        state: 'OPEN',
        subject_ref,
        created_at,
        binding_version: 0,
        bindings: [],
        turns: [],
      };
      conversations.set(conversation.conversation_id, conversation);
      note('CONVERSATION_CREATED', created_at, { conversation_id: conversation.conversation_id });
      return conversationProjection(conversation);
    },

    /** Provider/device/channel details are backend references; the conversation identity is untouched. */
    bindBackend({ conversation_id, channel, provider = null, model = null, thread_ref = null, device_ref = null, at: when } = {}) {
      const conversation = requireConversation(conversation_id);
      if (conversation.state !== 'OPEN') throw new ConversationError('CONVERSATION_CLOSED', `conversation ${conversation_id} is closed`);
      if (!isText(channel)) throw new ConversationError('INVALID_REQUEST', 'a backend binding needs a channel');
      const at = when === undefined || when === null ? now() : callerInstant(when);
      // Every stored field is validated before the record changes: an uncloneable or wrongly typed value
      // must be refused before the previous binding is superseded, not after it is persisted.
      for (const [label, value] of [['provider', provider], ['model', model], ['thread_ref', thread_ref], ['device_ref', device_ref]]) {
        if (value !== null && value !== undefined && !isText(value)) throw new ConversationError('INVALID_REQUEST', `binding.${label} must be text when given`);
      }
      const previous = activeBinding(conversation);
      if (previous) previous.state = 'SUPERSEDED';
      conversation.binding_version += 1;
      const binding = {
        binding_ref: `binding:${conversation_id}:${conversation.binding_version}`,
        binding_version: conversation.binding_version,
        channel,
        provider,
        model,
        thread_ref,
        device_ref,
        state: 'ACTIVE',
        bound_at: at,
        superseded_binding_ref: previous?.binding_ref ?? null,
      };
      conversation.bindings.push(binding);
      note('BACKEND_BOUND', at, { conversation_id, binding_ref: binding.binding_ref, thread_changed: previous !== null && previous.thread_ref !== thread_ref });
      return freeze({
        contract_version: CONVERSATION_CONTRACT_VERSION,
        conversation_id,
        binding: freeze(clone(binding)),
        previous_binding_ref: previous?.binding_ref ?? null,
        backend_metadata_changed: previous !== null,
        continuation_preserved: true,
        conversation_identity_changed: false,
        thread_is_identity: false,
        canonical_state_source: CANONICAL_STATE_SOURCE,
      });
    },

    /** Backend thread loss is reported honestly; the conversation does not silently "continue". */
    reportBackendLoss({ conversation_id, thread_ref = null, reason = 'BACKEND_THREAD_LOST', at: when } = {}) {
      const conversation = requireConversation(conversation_id);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const binding = activeBinding(conversation);
      if (!binding) throw new ConversationError('NO_BACKEND_BINDING', `conversation ${conversation_id} has no active backend binding`);
      binding.state = 'LOST';
      binding.lost_at = at;
      binding.lost_thread_ref = thread_ref ?? binding.thread_ref;
      note('BACKEND_LOST', at, { conversation_id, binding_ref: binding.binding_ref });
      return freeze({
        contract_version: CONVERSATION_CONTRACT_VERSION,
        conversation_id,
        binding_ref: binding.binding_ref,
        lost_thread_ref: binding.lost_thread_ref,
        reason,
        reported: true,
        continuation_available: false,
        silent_false_continuation: false,
        rebind_required: true,
        conversation_state: conversation.state,
        canonical_state_source: CANONICAL_STATE_SOURCE,
      });
    },

    /** Bounded, digests-verified, provenance-carrying input. */
    createInputBundle({ conversation_id, text = null, files = [], images = [], references = [], context_refs = [], provenance, at: when } = {}) {
      requireConversation(conversation_id);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      if (text !== null && typeof text !== 'string') throw new ConversationError('INVALID_BUNDLE', 'text must be a string when present');
      if (text !== null && text.length > config.max_text_chars) throw new ConversationError('BOUNDS_EXCEEDED', `text exceeds ${config.max_text_chars} characters`);
      for (const [name, list, max] of [['files', files, config.max_files], ['images', images, config.max_images], ['references', references, config.max_references], ['context_refs', context_refs, config.max_context_refs]]) {
        if (!Array.isArray(list)) throw new ConversationError('INVALID_BUNDLE', `${name} must be an array`);
        if (list.length > max) throw new ConversationError('BOUNDS_EXCEEDED', `${name} carries ${list.length} items, limit is ${max}`);
      }
      if (!isPlainObject(provenance) || !isText(provenance.source_channel) || !isText(provenance.device_ref)) {
        throw new ConversationError('PROVENANCE_REQUIRED', 'a bundle needs provenance naming the source channel and device');
      }
      if (provenance.created_at !== undefined && !isRealInstant(provenance.created_at)) throw new ConversationError('PROVENANCE_REQUIRED', 'provenance.created_at must be an ISO-8601 UTC instant');

      const bundleFiles = files.map((item, index) => validateItem(item, `files[${index}]`, 'file'));
      const bundleImages = images.map((item, index) => validateItem(item, `images[${index}]`, 'image'));
      const bundleReferences = references.map((item, index) => {
        if (!isPlainObject(item) || !isText(item.ref) || !isText(item.kind)) throw new ConversationError('INVALID_BUNDLE', `references[${index}] needs a ref and a kind`);
        for (const key of Object.keys(item)) if (!['ref', 'kind', 'note'].includes(key)) throw new ConversationError('INVALID_BUNDLE', `references[${index}].${key} is not part of the canonical contract`);
        if (item.note !== undefined && item.note !== null && !isText(item.note)) throw new ConversationError('INVALID_BUNDLE', `references[${index}].note must be text`);
        return freeze({ ref: item.ref, kind: item.kind, note: item.note ?? null });
      });
      const bundleContextRefs = context_refs.map((item, index) => {
        if (!isText(item)) throw new ConversationError('INVALID_BUNDLE', `context_refs[${index}] must be a nonempty reference`);
        return item;
      });

      counter += 1;
      const bundle_ref = `bundle:${conversation_id}:${counter}`;
      const canonical = JSON.stringify({
        conversation_id,
        text,
        files: bundleFiles.map(item => [item.logical_ref, item.digest, item.size_bytes]),
        images: bundleImages.map(item => [item.logical_ref, item.digest, item.size_bytes]),
        references: bundleReferences.map(item => item.ref),
        context_refs: bundleContextRefs,
      });
      const bundle = {
        bundle_ref,
        conversation_id,
        bundle_version: 1,
        text,
        text_chars: text === null ? 0 : text.length,
        files: bundleFiles,
        images: bundleImages,
        references: bundleReferences,
        context_refs: bundleContextRefs,
        provenance: freeze({ source_channel: provenance.source_channel, device_ref: provenance.device_ref, created_at: provenance.created_at ?? at }),
        bundle_digest: digestPort === null ? null : digestPort(canonical),
        bundle_digest_status: digestPort === null ? 'NOT_COMPUTED' : 'COMPUTED',
        digest_computed_by: digestPort === null ? null : 'INJECTED_DIGEST_PORT',
        created_at: at,
      };
      bundles.set(bundle_ref, bundle);
      note('BUNDLE_CREATED', at, { bundle_ref, conversation_id, files: bundleFiles.length, images: bundleImages.length });
      return freeze(clone(bundle));
    },

    /** Turns are the GAI domain-semantic stream. */
    openTurn({ conversation_id, bundle_ref, at: when } = {}) {
      const conversation = requireConversation(conversation_id);
      if (conversation.state !== 'OPEN') throw new ConversationError('CONVERSATION_CLOSED', `conversation ${conversation_id} is closed`);
      const bundle = bundles.get(bundle_ref);
      if (!bundle || bundle.conversation_id !== conversation_id) throw new ConversationError('UNKNOWN_BUNDLE', `no bundle ${String(bundle_ref)} for ${conversation_id}`);
      const binding = activeBinding(conversation);
      if (!binding) {
        const lost = conversation.bindings.some(entry => entry.state === 'LOST');
        throw new ConversationError(lost ? 'REBIND_REQUIRED' : 'NO_BACKEND_BINDING', lost
          ? 'the backend thread was lost; rebind before starting more work instead of pretending to continue'
          : 'no active backend binding');
      }
      const at = when === undefined || when === null ? now() : callerInstant(when);
      counter += 1;
      const turn = {
        turn_ref: `turn:${conversation_id}:${counter}`,
        conversation_id,
        bundle_ref,
        binding_ref: binding.binding_ref,
        state: 'PENDING',
        partial_seq: 0,
        partial_count: 0,
        events: [],
        result: null,
        cancellation: null,
        opened_at: at,
      };
      turns.set(turn.turn_ref, turn);
      conversation.turns.push(turn.turn_ref);
      note('TURN_OPENED', at, { turn_ref: turn.turn_ref, conversation_id, binding_ref: binding.binding_ref });
      return freeze({
        contract_version: CONVERSATION_CONTRACT_VERSION,
        turn_ref: turn.turn_ref,
        conversation_id,
        bundle_ref,
        binding_ref: binding.binding_ref,
        state: turn.state,
        terminal: false,
        canonical_state_source: CANONICAL_STATE_SOURCE,
      });
    },

    /** A partial is ordered and versioned, and is never a terminal success. */
    emitPartial({ turn_ref, text, at: when, seq } = {}) {
      const turn = requireTurn(turn_ref);
      if (turn.state === 'CANCELLED') throw new ConversationError('TURN_CANCELLED', `turn ${turn_ref} was cancelled`, { turn_ref });
      if (TERMINAL_TURN_STATES.includes(turn.state)) throw new ConversationError('TURN_ALREADY_COMPLETE', `turn ${turn_ref} is ${turn.state}`, { turn_ref });
      if (!isText(text)) throw new ConversationError('INVALID_REQUEST', 'a partial needs text');
      if (turn.partial_count >= config.max_partials_per_turn) throw new ConversationError('PARTIAL_LIMIT', `turn ${turn_ref} exceeded ${config.max_partials_per_turn} partials`);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      const nextSeq = turn.partial_seq + 1;
      if (seq !== undefined && seq !== nextSeq) {
        throw new ConversationError('PARTIAL_OUT_OF_ORDER', `partial seq ${seq} is not the expected ${nextSeq}`, { turn_ref, expected_seq: nextSeq });
      }
      turn.partial_seq = nextSeq;
      turn.partial_count += 1;
      if (turn.state === 'PENDING') turn.state = 'STREAMING';
      const partial = {
        partial_ref: `${turn_ref}:partial:${nextSeq}`,
        turn_ref,
        conversation_id: turn.conversation_id,
        seq: nextSeq,
        text,
        terminal: false,
        partial_is_terminal_success: false,
        transport_ref: null,
        transport_envelope_is_canonical: false,
        canonical_state_source: CANONICAL_STATE_SOURCE,
        at,
      };
      partials.set(partial.partial_ref, partial);
      turn.events.push({ kind: 'PARTIAL', seq: nextSeq, partial_ref: partial.partial_ref, at });
      return freeze(clone(partial));
    },

    /** Remote Fabric may carry the bytes; its envelope never becomes canonical result state. */
    attachTransport({ partial_ref, transport_ref } = {}) {
      const partial = partials.get(partial_ref);
      if (!partial) throw new ConversationError('INVALID_REQUEST', `no partial ${String(partial_ref)}`);
      if (!isText(transport_ref)) throw new ConversationError('INVALID_REQUEST', 'transport_ref is required');
      // A settled turn is immutable: a late transport attachment may not rewrite its record.
      const owningTurn = requireTurn(partial.turn_ref);
      if (owningTurn.state === 'CANCELLED') throw new ConversationError('TURN_CANCELLED', `turn ${partial.turn_ref} was cancelled`, { turn_ref: partial.turn_ref, partial_ref });
      if (TERMINAL_TURN_STATES.includes(owningTurn.state)) throw new ConversationError('TURN_ALREADY_COMPLETE', `turn ${partial.turn_ref} is ${owningTurn.state}`, { turn_ref: partial.turn_ref, partial_ref });
      partial.transport_ref = transport_ref;
      return freeze({
        partial_ref,
        transport_ref,
        transport_envelope_is_canonical: false,
        canonical_state_source: CANONICAL_STATE_SOURCE,
        domain_event_ref: partial.partial_ref,
      });
    },

    /** The terminal record — unless the turn was cancelled, in which case the result is reconciled away. */
    finalizeTurn({ turn_ref, result_ref, text = null, attachments = [], at: when } = {}) {
      const turn = requireTurn(turn_ref);
      if (!isText(result_ref)) throw new ConversationError('INVALID_REQUEST', 'a result needs a reference');
      if (text !== null && text !== undefined && typeof text !== 'string') throw new ConversationError('INVALID_REQUEST', 'result text must be a string when present');
      const at = when === undefined || when === null ? now() : callerInstant(when);
      if (turn.state === 'CANCELLED') {
        turn.reconciled_seq = (turn.reconciled_seq ?? 0) + 1;
        const reconciliation_ref = `reconciled:${turn_ref}:${turn.reconciled_seq}`;
        turn.reconciled_results = [...(turn.reconciled_results ?? []), { result_ref, at, reconciliation_ref }];
        note('LATE_RESULT_RECONCILED', at, { turn_ref, result_ref });
        return freeze({
          contract_version: CONVERSATION_CONTRACT_VERSION,
          accepted: false,
          reconciled: true,
          terminal: true,
          turn_ref,
          state: 'CANCELLED',
          reason: 'LATE_RESULT_AFTER_CANCEL',
          reconciliation_ref,
          discarded_result_ref: result_ref,
          canonical_state_source: CANONICAL_STATE_SOURCE,
        });
      }
      if (turn.state === 'COMPLETED') throw new ConversationError('TURN_ALREADY_COMPLETE', `turn ${turn_ref} already completed`, { turn_ref });
      // Validate the attachments before any state change: a malformed or cyclic attachment must not
      // complete the turn, and the terminal record must not be rewritable afterwards.
      if (!Array.isArray(attachments)) throw new ConversationError('INVALID_BUNDLE', 'attachments must be an array');
      for (const [index, item] of attachments.entries()) {
        if (!isPlainObject(item) || !isText(item.logical_ref)) throw new ConversationError('INVALID_BUNDLE', `attachments[${index}] must be a plain record carrying a logical_ref`);
        if (item.media_type !== undefined && !isText(item.media_type)) throw new ConversationError('INVALID_BUNDLE', `attachments[${index}].media_type must be text`);
        if (item.size_bytes !== undefined && (!Number.isSafeInteger(item.size_bytes) || item.size_bytes < 0)) throw new ConversationError('INVALID_BUNDLE', `attachments[${index}].size_bytes must be a non-negative integer`);
        if (item.digest !== undefined && item.digest !== null && !isDigest(item.digest)) throw new ConversationError('INVALID_DIGEST', `attachments[${index}].digest must be a sha256 digest`);
        if (item.origin_device_ref !== undefined && !isText(item.origin_device_ref)) throw new ConversationError('INVALID_BUNDLE', `attachments[${index}].origin_device_ref must be text`);
      }
      turn.state = 'COMPLETED';
      const result = {
        result_envelope_ref: `result:${turn_ref}`,
        turn_ref,
        conversation_id: turn.conversation_id,
        result_ref,
        text,
        attachments: clone(attachments),
        terminal: true,
        partial_count: turn.partial_count,
        partials_are_terminal: false,
        canonical_state_source: CANONICAL_STATE_SOURCE,
        at,
      };
      turn.result = result;
      note('TURN_COMPLETED', at, { turn_ref, result_ref });
      return freeze(clone(result));
    },

    /** Cancellation is idempotent and survives a backend/device change. */
    cancelTurn({ turn_ref, reason = 'USER_CANCELLED', at: when } = {}) {
      const turn = requireTurn(turn_ref);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      if (!isText(reason)) throw new ConversationError('INVALID_CANCEL', 'a cancellation needs a reason');
      if (turn.cancellation !== null) {
        return freeze({
          ...clone(turn.cancellation),
          duplicate: true,
          cancellation_idempotent: true,
          state: turn.state,
        });
      }
      if (turn.state === 'COMPLETED') throw new ConversationError('TURN_ALREADY_COMPLETE', `turn ${turn_ref} already completed and cannot be cancelled`, { turn_ref });
      const cancellation = {
        cancellation_ref: `cancel:${turn_ref}`,
        turn_ref,
        conversation_id: turn.conversation_id,
        reason,
        state: 'CANCELLED',
        cancelled_at: at,
        binding_ref_at_cancel: turn.binding_ref,
        partials_before_cancel: turn.partial_count,
        cancellation_requires_rebind: false,
        canonical_state_source: CANONICAL_STATE_SOURCE,
      };
      turn.cancellation = cancellation;
      turn.state = 'CANCELLED';
      turn.events.push({ kind: 'CANCELLED', seq: turn.partial_seq + 1, cancellation_ref: cancellation.cancellation_ref, at });
      note('TURN_CANCELLED', at, { turn_ref, reason });
      return freeze({ ...clone(cancellation), duplicate: false, cancellation_idempotent: true });
    },

    /** Explicit statement that cancellation is effective regardless of the current binding. */
    cancelAcrossChannels({ turn_ref, reason = 'CANCELLED_AFTER_TRANSITION', at: when } = {}) {
      const turn = requireTurn(turn_ref);
      const conversation = requireConversation(turn.conversation_id);
      const current = activeBinding(conversation);
      const cancelled = api.cancelTurn({ turn_ref, reason, at: when });
      return freeze({
        ...cancelled,
        binding_at_cancel: turn.binding_ref,
        binding_now: current?.binding_ref ?? null,
        binding_changed_since_opening: (current?.binding_ref ?? null) !== turn.binding_ref,
        cancellation_works_across_channels: true,
      });
    },

    stagingPlan({ bundle_ref } = {}) {
      const bundle = bundles.get(bundle_ref);
      if (!bundle) throw new ConversationError('UNKNOWN_BUNDLE', `no bundle ${String(bundle_ref)}`);
      const items = [...bundle.files, ...bundle.images].map(item => freeze({
        logical_ref: item.logical_ref,
        kind: item.kind,
        origin_device_ref: item.origin_device_ref,
        staging_policy: item.staging.policy,
        staging_ref: item.staging.staging_ref ?? null,
        cleanup_by: item.staging.cleanup_by ?? null,
        cleanup_required: item.staging.policy === 'DELETE_AFTER_USE',
        retained: item.staging.policy === 'RETAIN',
        staging_explicit: true,
      }));
      return freeze({
        bundle_ref,
        items,
        staged_count: items.filter(item => item.staging_policy !== 'NO_STAGING').length,
        every_item_has_explicit_policy: items.every(item => STAGING_POLICIES.includes(item.staging_policy)),
      });
    },

    releaseStaging({ bundle_ref, at: when } = {}) {
      const bundle = bundles.get(bundle_ref);
      if (!bundle) throw new ConversationError('UNKNOWN_BUNDLE', `no bundle ${String(bundle_ref)}`);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      // Release state lives beside the immutable bundle record, not inside it.
      const releasedSet = stagingReleased.get(bundle_ref) ?? new Set();
      const released = [];
      for (const item of [...bundle.files, ...bundle.images]) {
        if (item.staging.policy !== 'DELETE_AFTER_USE') continue;
        if (releasedSet.has(item.logical_ref)) continue;
        releasedSet.add(item.logical_ref);
        released.push(item.logical_ref);
      }
      stagingReleased.set(bundle_ref, releasedSet);
      note('STAGING_RELEASED', at, { bundle_ref, released: released.length });
      return freeze({ bundle_ref, released_logical_refs: released, released_count: released.length, idempotent: released.length === 0 });
    },

    closeConversation({ conversation_id, at: when } = {}) {
      const conversation = requireConversation(conversation_id);
      const at = when === undefined || when === null ? now() : callerInstant(when);
      conversation.state = 'CLOSED';
      note('CONVERSATION_CLOSED', at, { conversation_id });
      return conversationProjection(conversation);
    },

    conversation: conversation_id => {
      const conversation = conversations.get(conversation_id);
      return conversation ? conversationProjection(conversation) : null;
    },

    turn: turn_ref => {
      const turn = turns.get(turn_ref);
      if (!turn) return null;
      return freeze({
        contract_version: CONVERSATION_CONTRACT_VERSION,
        turn_ref: turn.turn_ref,
        conversation_id: turn.conversation_id,
        bundle_ref: turn.bundle_ref,
        binding_ref: turn.binding_ref,
        state: turn.state,
        terminal: TERMINAL_TURN_STATES.includes(turn.state),
        partial_count: turn.partial_count,
        result: turn.result === null ? null : clone(turn.result),
        cancellation: turn.cancellation === null ? null : clone(turn.cancellation),
        reconciled_results: clone(turn.reconciled_results ?? []),
        canonical_state_source: CANONICAL_STATE_SOURCE,
      });
    },

    bundle: bundle_ref => {
      const bundle = bundles.get(bundle_ref);
      return bundle ? freeze(clone(bundle)) : null;
    },

    /** The GAI domain-semantic stream for a conversation, in order. */
    eventsFor(conversation_id) {
      requireConversation(conversation_id);
      return freeze([...partials.values()]
        .filter(partial => partial.conversation_id === conversation_id)
        .map(partial => freeze({ seq: partial.seq, turn_ref: partial.turn_ref, kind: 'PARTIAL', partial_ref: partial.partial_ref, terminal: false, text: partial.text, transport_ref: partial.transport_ref, canonical_state_source: CANONICAL_STATE_SOURCE, at: partial.at })));
    },

    journal: () => clone(journal),
  };
  return Object.freeze(api);
}
