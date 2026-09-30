// Conformance tests for GAI-006 闁?conversation + InputBundle + streaming + cancellation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_STATE_SOURCE, ConversationError, DEFAULT_CONVERSATION_POLICY, STAGING_POLICIES, TURN_STATES,
  createConversationRegistry, isDigest,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const AT = ms => new Date(Date.parse(T0) + ms).toISOString();

function registryAt({ seeds = ['a1b2c3d4e5f60718293a4b5c6d7e8f90'], policy = {}, digest = null } = {}) {
  let index = 0;
  registryInstance += 1;
  const instance = registryInstance;
  const entropy = bytes => {
    const seed = seeds[Math.min(index, seeds.length - 1)];
    const salt = (((index * 0x9e3779b1) ^ (instance * 0x85ebca6b)) >>> 0).toString(16).padStart(8, '0');
    index += 1;
    return `${salt}${seed.repeat(4)}`.slice(0, bytes * 2);
  };
  const state = { ms: 0 };
  const clock = () => AT(state.ms);
  clock.advance = ms => { state.ms += ms; return clock(); };
  return { registry: createConversationRegistry({ entropy, clock, policy, digest }), clock };
}

let registryInstance = 0;
const PROVENANCE = { source_channel: 'WEB', device_ref: 'device:laptop-a', created_at: T0 };
const FILE = { logical_ref: 'file:report', media_type: 'application/pdf', size_bytes: 1024, digest: 'sha256:0123456789abcdef', origin_device_ref: 'device:laptop-a' };

const failure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof ConversationError, `expected a ConversationError, got ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

const openTurnWith = (registry, conversation_id, overrides = {}) => {
  const bundle = registry.createInputBundle({ conversation_id, text: 'hello', provenance: PROVENANCE, ...overrides });
  return registry.openTurn({ conversation_id, bundle_ref: bundle.bundle_ref });
};

test('one conversation continues while backend thread, provider and device metadata change', () => {
  const { registry } = registryAt();
  const conversation = registry.createConversation({ subject_ref: 'user:owner' });
  assert.match(conversation.conversation_id, /^conversation:[0-9a-f]{32}$/);
  assert.equal(conversation.identity_is_provider_independent, true);
  assert.equal(conversation.provider_thread_is_canonical, false);
  assert.equal(conversation.continuation_available, false, 'a conversation with no backend cannot pretend to continue');

  const first = registry.bindBackend({ conversation_id: conversation.conversation_id, channel: 'WEB', provider: 'deepseek', model: 'chat', thread_ref: 'thread:1', device_ref: 'device:laptop-a' });
  assert.equal(first.continuation_preserved, true);
  assert.equal(first.thread_is_identity, false);
  assert.equal(first.binding.binding_version, 1);
  assert.equal(registry.conversation(conversation.conversation_id).continuation_available, true);

  const turn = openTurnWith(registry, conversation.conversation_id);
  registry.emitPartial({ turn_ref: turn.turn_ref, text: 'wor' });
  registry.emitPartial({ turn_ref: turn.turn_ref, text: 'king' });
  const result = registry.finalizeTurn({ turn_ref: turn.turn_ref, result_ref: 'result:1', text: 'working on it' });
  assert.equal(result.terminal, true);
  assert.equal(result.conversation_id, conversation.conversation_id);
  assert.equal(result.partials_are_terminal, false);
  assert.equal(result.canonical_state_source, CANONICAL_STATE_SOURCE);

  // The provider thread changes, and the device changes with it: same conversation.
  const rebound = registry.bindBackend({ conversation_id: conversation.conversation_id, channel: 'API', provider: 'anthropic', model: 'sonnet', thread_ref: 'thread:2', device_ref: 'device:phone-b' });
  assert.equal(rebound.conversation_id, conversation.conversation_id);
  assert.equal(rebound.conversation_identity_changed, false);
  assert.equal(rebound.backend_metadata_changed, true);
  assert.equal(rebound.continuation_preserved, true);
  assert.equal(rebound.binding.binding_version, 2);
  assert.equal(rebound.previous_binding_ref, first.binding.binding_ref);
  const after = registry.conversation(conversation.conversation_id);
  assert.equal(after.backend_bindings.length, 2);
  assert.equal(after.backend_bindings[0].state, 'SUPERSEDED');
  assert.equal(after.active_binding.thread_ref, 'thread:2');
  assert.equal(after.turn_count, 1);

  // The conversation keeps working on the new backend.
  const next = openTurnWith(registry, conversation.conversation_id);
  assert.equal(next.binding_ref, rebound.binding.binding_ref);
  assert.equal(registry.finalizeTurn({ turn_ref: next.turn_ref, result_ref: 'result:2' }).turn_ref, next.turn_ref);

  // Closing is explicit and further work is refused.
  const closed = registry.closeConversation({ conversation_id: conversation.conversation_id });
  assert.equal(closed.state, 'CLOSED');
  assert.equal(failure(() => openTurnWith(registry, conversation.conversation_id)).code, 'CONVERSATION_CLOSED');
  assert.equal(failure(() => registry.bindBackend({ conversation_id: conversation.conversation_id, channel: 'WEB' })).code, 'CONVERSATION_CLOSED');
  assert.equal(registry.conversation('conversation:nope'), null, 'an unknown conversation is a typed absence');
});

test('backend thread loss is reported and never becomes a silent false continuation', () => {
  const { registry } = registryAt();
  const conversation = registry.createConversation();
  registry.bindBackend({ conversation_id: conversation.conversation_id, channel: 'WEB', provider: 'deepseek', thread_ref: 'thread:1' });
  const turn = openTurnWith(registry, conversation.conversation_id);
  registry.emitPartial({ turn_ref: turn.turn_ref, text: 'half an ans' });

  const lost = registry.reportBackendLoss({ conversation_id: conversation.conversation_id, reason: 'PROVIDER_THREAD_GONE' });
  assert.equal(lost.reported, true);
  assert.equal(lost.continuation_available, false);
  assert.equal(lost.silent_false_continuation, false);
  assert.equal(lost.rebind_required, true);
  assert.equal(lost.lost_thread_ref, 'thread:1');
  assert.equal(registry.conversation(conversation.conversation_id).continuation_available, false, 'the conversation reports that continuation is not available');
  assert.equal(registry.conversation(conversation.conversation_id).state, 'OPEN', 'loss is not the same as closing');

  // No new turn may be started on a lost backend.
  const refused = failure(() => openTurnWith(registry, conversation.conversation_id));
  assert.equal(refused.code, 'REBIND_REQUIRED');
  assert.equal(refused.status, 409);

  // The already-open turn is not silently "continued" either; a rebind is the only way forward.
  const rebound = registry.bindBackend({ conversation_id: conversation.conversation_id, channel: 'API', thread_ref: 'thread:2' });
  assert.equal(rebound.continuation_preserved, true);
  assert.equal(registry.conversation(conversation.conversation_id).backend_bindings[0].state, 'LOST');
  const resumed = openTurnWith(registry, conversation.conversation_id);
  assert.equal(resumed.binding_ref, rebound.binding.binding_ref);
  assert.equal(failure(() => registry.reportBackendLoss({ conversation_id: 'conversation:nope' })).code, 'UNKNOWN_CONVERSATION');

  // A conversation with no binding at all reports that honestly.
  const bare = registry.createConversation();
  assert.equal(failure(() => registry.reportBackendLoss({ conversation_id: bare.conversation_id })).code, 'NO_BACKEND_BINDING');
  assert.equal(failure(() => openTurnWith(registry, bare.conversation_id)).code, 'NO_BACKEND_BINDING');
});

test('InputBundle enforces bounds, media type, digest and provenance', () => {
  const { registry } = registryAt();
  const conversation = registry.createConversation();
  registry.bindBackend({ conversation_id: conversation.conversation_id, channel: 'WEB' });

  const bundle = registry.createInputBundle({
    conversation_id: conversation.conversation_id,
    text: 'please summarise this',
    files: [FILE],
    images: [{ logical_ref: 'image:scan', media_type: 'image/png', size_bytes: 2048, digest: 'sha256:abcdef0123456789', origin_device_ref: 'device:phone-b' }],
    references: [{ ref: 'task:123', kind: 'TASK' }],
    context_refs: ['context:project-1'],
    provenance: PROVENANCE,
  });
  assert.equal(bundle.bundle_version, 1);
  assert.equal(bundle.text_chars, 'please summarise this'.length);
  assert.equal(bundle.files.length, 1);
  assert.equal(bundle.files[0].kind, 'file');
  assert.equal(bundle.files[0].canonical_path, null, 'a logical reference is not a filesystem path');
  assert.equal(bundle.files[0].hard_coded_remote_path, false);
  assert.equal(bundle.files[0].origin_device_ref, 'device:laptop-a');
  assert.equal(bundle.images[0].kind, 'image');
  assert.equal(bundle.provenance.source_channel, 'WEB');
  assert.equal(bundle.bundle_digest, null, 'this registry has no digest port, so no digest is invented');
  assert.equal(bundle.bundle_digest_status, 'NOT_COMPUTED');
  assert.throws(() => { bundle.text = 'tampered'; }, TypeError);

  // A digest port produces a digest and says who computed it.
  const withDigest = registryAt({ digest: () => 'sha256:computed' }).registry;
  const dConversation = withDigest.createConversation();
  withDigest.bindBackend({ conversation_id: dConversation.conversation_id, channel: 'WEB' });
  const computed = withDigest.createInputBundle({ conversation_id: dConversation.conversation_id, text: 'x', provenance: PROVENANCE });
  assert.equal(computed.bundle_digest, 'sha256:computed');
  assert.equal(computed.bundle_digest_status, 'COMPUTED');

  // Bounds, types, digests and provenance are all enforced.
  assert.equal(failure(() => registry.createInputBundle({ conversation_id: conversation.conversation_id, text: 'x'.repeat(DEFAULT_CONVERSATION_POLICY.max_text_chars + 1), provenance: PROVENANCE })).code, 'BOUNDS_EXCEEDED');
  assert.equal(failure(() => registry.createInputBundle({ conversation_id: conversation.conversation_id, files: Array.from({ length: 9 }, (_, index) => ({ ...FILE, logical_ref: `file:${index}` })), provenance: PROVENANCE })).code, 'BOUNDS_EXCEEDED');
  assert.equal(failure(() => registry.createInputBundle({ conversation_id: conversation.conversation_id, files: [{ ...FILE, media_type: 'application/x-msdownload' }], provenance: PROVENANCE })).code, 'MEDIA_TYPE_NOT_ALLOWED');
  assert.equal(failure(() => registry.createInputBundle({ conversation_id: conversation.conversation_id, files: [{ ...FILE, size_bytes: DEFAULT_CONVERSATION_POLICY.max_file_bytes + 1 }], provenance: PROVENANCE })).code, 'FILE_TOO_LARGE');
  assert.equal(failure(() => registry.createInputBundle({ conversation_id: conversation.conversation_id, files: [{ ...FILE, digest: undefined }], provenance: PROVENANCE })).code, 'DIGEST_REQUIRED');
  assert.equal(failure(() => registry.createInputBundle({ conversation_id: conversation.conversation_id, files: [{ ...FILE, digest: 'md5:abc' }], provenance: PROVENANCE })).code, 'INVALID_DIGEST');
  assert.equal(failure(() => registry.createInputBundle({ conversation_id: conversation.conversation_id, text: 'x' })).code, 'PROVENANCE_REQUIRED');
  assert.equal(failure(() => registry.createInputBundle({ conversation_id: conversation.conversation_id, text: 'x', provenance: { source_channel: 'WEB' } })).code, 'PROVENANCE_REQUIRED');
  assert.equal(failure(() => registry.createInputBundle({ conversation_id: conversation.conversation_id, text: 'x', files: [{ ...FILE, extra: 1 }], provenance: PROVENANCE })).code, 'INVALID_BUNDLE');
  assert.equal(failure(() => registry.createInputBundle({ conversation_id: 'conversation:nope', text: 'x', provenance: PROVENANCE })).code, 'UNKNOWN_CONVERSATION');
  assert.equal(isDigest('sha256:0123456789abcdef'), true);
  assert.equal(isDigest('sha256:zz'), false);
  assert.equal(registry.bundle('bundle:nope'), null, 'an unknown bundle is a typed absence');
});

test('temporary staging metadata always carries an explicit cleanup policy', () => {
  const { registry } = registryAt();
  const conversation = registry.createConversation();
  registry.bindBackend({ conversation_id: conversation.conversation_id, channel: 'WEB' });
  const bundle = registry.createInputBundle({
    conversation_id: conversation.conversation_id,
    files: [
      { ...FILE, logical_ref: 'file:temp', staging: { policy: 'DELETE_AFTER_USE', staging_ref: 'staging:1', cleanup_by: AT(600000) } },
      { ...FILE, logical_ref: 'file:kept', staging: { policy: 'RETAIN' } },
      { ...FILE, logical_ref: 'file:inline' },
    ],
    provenance: PROVENANCE,
  });
  const plan = registry.stagingPlan({ bundle_ref: bundle.bundle_ref });
  assert.equal(plan.every_item_has_explicit_policy, true);
  assert.equal(plan.staged_count, 2);
  assert.deepEqual(plan.items.map(item => [item.logical_ref, item.staging_policy, item.cleanup_required]), [
    ['file:temp', 'DELETE_AFTER_USE', true],
    ['file:kept', 'RETAIN', false],
    ['file:inline', 'NO_STAGING', false],
  ]);
  assert.equal(plan.items[1].retained, true);
  assert.deepEqual([...STAGING_POLICIES], ['NO_STAGING', 'DELETE_AFTER_USE', 'RETAIN']);

  const released = registry.releaseStaging({ bundle_ref: bundle.bundle_ref });
  assert.deepEqual(released.released_logical_refs, ['file:temp']);
  assert.equal(released.idempotent, false);
  const again = registry.releaseStaging({ bundle_ref: bundle.bundle_ref });
  assert.deepEqual(again.released_logical_refs, []);
  assert.equal(again.idempotent, true, 'release is idempotent');
  assert.deepEqual(registry.releaseStaging({ bundle_ref: bundle.bundle_ref }).released_count, 0);
  assert.equal(failure(() => registry.releaseStaging({ bundle_ref: 'bundle:nope' })).code, 'UNKNOWN_BUNDLE');
  assert.equal(failure(() => registry.stagingPlan({ bundle_ref: 'bundle:nope' })).code, 'UNKNOWN_BUNDLE');

  // A staging entry with no policy, or a cleanup policy with no deadline, is refused.
  assert.equal(failure(() => registry.createInputBundle({ conversation_id: conversation.conversation_id, files: [{ ...FILE, staging: { staging_ref: 'staging:2' } }], provenance: PROVENANCE })).code, 'STAGING_POLICY_REQUIRED');
  assert.equal(failure(() => registry.createInputBundle({ conversation_id: conversation.conversation_id, files: [{ ...FILE, staging: { policy: 'DELETE_AFTER_USE' } }], provenance: PROVENANCE })).code, 'STAGING_POLICY_REQUIRED');
  assert.equal(failure(() => registry.createInputBundle({ conversation_id: conversation.conversation_id, files: [{ ...FILE, staging: { policy: 'SOMETIME' } }], provenance: PROVENANCE })).code, 'STAGING_POLICY_REQUIRED');
});

test('partial events are ordered, versioned and never terminal, and RF envelopes stay non-canonical', () => {
  const { registry } = registryAt();
  const conversation = registry.createConversation();
  registry.bindBackend({ conversation_id: conversation.conversation_id, channel: 'WEB' });
  const turn = openTurnWith(registry, conversation.conversation_id);
  assert.deepEqual([...TURN_STATES], ['PENDING', 'STREAMING', 'COMPLETED', 'CANCELLED']);

  const first = registry.emitPartial({ turn_ref: turn.turn_ref, text: 'Hel' });
  const second = registry.emitPartial({ turn_ref: turn.turn_ref, text: 'lo' });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(registry.turn(turn.turn_ref).state, 'STREAMING');
  for (const partial of [first, second]) {
    assert.equal(partial.terminal, false, 'a partial is never a terminal success');
    assert.equal(partial.partial_is_terminal_success, false);
    assert.equal(partial.canonical_state_source, CANONICAL_STATE_SOURCE);
  }
  assert.equal(failure(() => registry.emitPartial({ turn_ref: turn.turn_ref, text: 'x', seq: 9 })).code, 'PARTIAL_OUT_OF_ORDER');
  assert.equal(failure(() => registry.emitPartial({ turn_ref: turn.turn_ref, text: '' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => registry.emitPartial({ turn_ref: 'turn:nope', text: 'x' })).code, 'UNKNOWN_TURN');

  // RF may carry the bytes; that transport reference is not canonical state.
  const attached = registry.attachTransport({ partial_ref: second.partial_ref, transport_ref: 'rf:path:1' });
  assert.equal(attached.transport_envelope_is_canonical, false);
  assert.equal(attached.canonical_state_source, CANONICAL_STATE_SOURCE);
  assert.equal(attached.domain_event_ref, second.partial_ref);
  const events = registry.eventsFor(conversation.conversation_id);
  assert.deepEqual(events.map(event => event.seq), [1, 2]);
  assert.deepEqual(events.map(event => event.terminal), [false, false]);
  assert.equal(events[1].transport_ref, 'rf:path:1');
  assert.equal(failure(() => registry.eventsFor('conversation:nope')).code, 'UNKNOWN_CONVERSATION');

  const result = registry.finalizeTurn({ turn_ref: turn.turn_ref, result_ref: 'result:9', text: 'Hello', attachments: [{ logical_ref: 'file:out', media_type: 'text/plain', digest: 'sha256:99999999' }] });
  assert.equal(result.terminal, true);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.partial_count, 2);
  assert.equal(registry.turn(turn.turn_ref).state, 'COMPLETED');
  assert.equal(registry.turn(turn.turn_ref).terminal, true);
  assert.equal(failure(() => registry.emitPartial({ turn_ref: turn.turn_ref, text: 'late' })).code, 'TURN_ALREADY_COMPLETE');
  assert.equal(failure(() => registry.finalizeTurn({ turn_ref: turn.turn_ref, result_ref: 'result:10' })).code, 'TURN_ALREADY_COMPLETE');
  assert.equal(failure(() => registry.finalizeTurn({ turn_ref: turn.turn_ref })).code, 'INVALID_REQUEST', 'a result without a reference is a malformed request');
  assert.equal(failure(() => registry.finalizeTurn({ turn_ref: turn.turn_ref, result_ref: 'result:late-again' })).code, 'TURN_ALREADY_COMPLETE', 'a completed turn takes no second result');
  assert.equal(registry.turn('turn:nope'), null);
});

test('cancellation is idempotent, works across channel changes, and reconciles late results', () => {
  const { registry } = registryAt();
  const conversation = registry.createConversation();
  registry.bindBackend({ conversation_id: conversation.conversation_id, channel: 'WEB', thread_ref: 'thread:1' });
  const turn = openTurnWith(registry, conversation.conversation_id);
  registry.emitPartial({ turn_ref: turn.turn_ref, text: 'partial' });

  // The device and channel change while the turn is running; cancellation still works.
  registry.bindBackend({ conversation_id: conversation.conversation_id, channel: 'API', thread_ref: 'thread:2', device_ref: 'device:phone-b' });
  const cancelled = registry.cancelAcrossChannels({ turn_ref: turn.turn_ref, reason: 'USER_CANCELLED' });
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(cancelled.binding_at_cancel, turn.binding_ref, 'the cancellation records the binding it started under');
  assert.equal(cancelled.binding_changed_since_opening, true);
  assert.equal(cancelled.cancellation_works_across_channels, true);
  assert.equal(cancelled.partials_before_cancel, 1);
  assert.equal(cancelled.canonical_state_source, CANONICAL_STATE_SOURCE);

  // Idempotent: the same cancellation reference comes back, marked as a duplicate.
  const again = registry.cancelTurn({ turn_ref: turn.turn_ref, reason: 'USER_CANCELLED' });
  assert.equal(again.cancellation_ref, cancelled.cancellation_ref);
  assert.equal(again.duplicate, true);
  assert.equal(again.cancellation_idempotent, true);
  assert.equal(again.state, 'CANCELLED');

  // A late result is reconciled, not silently accepted.
  const late = registry.finalizeTurn({ turn_ref: turn.turn_ref, result_ref: 'result:late', text: 'too late' });
  assert.equal(late.accepted, false);
  assert.equal(late.reconciled, true);
  assert.equal(late.reason, 'LATE_RESULT_AFTER_CANCEL');
  assert.equal(late.discarded_result_ref, 'result:late');
  assert.equal(late.state, 'CANCELLED');
  assert.equal(registry.turn(turn.turn_ref).result, null, 'no result became canonical');
  assert.deepEqual(registry.turn(turn.turn_ref).reconciled_results.map(entry => entry.result_ref), ['result:late']);
  assert.equal(registry.journal().some(entry => entry.event === 'LATE_RESULT_RECONCILED'), true);

  // A cancelled turn accepts no further partials, and cancel takes a reason.
  assert.equal(failure(() => registry.emitPartial({ turn_ref: turn.turn_ref, text: 'more' })).code, 'TURN_CANCELLED');
  assert.equal(failure(() => registry.cancelTurn({ turn_ref: turn.turn_ref, reason: '' })).code, 'INVALID_CANCEL');
  assert.equal(failure(() => registry.cancelTurn({ turn_ref: 'turn:nope' })).code, 'UNKNOWN_TURN');

  // A completed turn cannot be cancelled afterwards.
  const second = openTurnWith(registry, conversation.conversation_id);
  registry.finalizeTurn({ turn_ref: second.turn_ref, result_ref: 'result:ok' });
  assert.equal(failure(() => registry.cancelTurn({ turn_ref: second.turn_ref })).code, 'TURN_ALREADY_COMPLETE');
  assert.equal(registry.turn(second.turn_ref).state, 'COMPLETED');
});

test('the conversation contract is closed, frozen and identity-independent', () => {
  const { registry } = registryAt();
  const conversation = registry.createConversation();
  const binding = registry.bindBackend({ conversation_id: conversation.conversation_id, channel: 'WEB' });
  const turn = openTurnWith(registry, conversation.conversation_id);
  assert.throws(() => { conversation.state = 'CLOSED'; }, TypeError, 'projections are frozen');
  assert.throws(() => { binding.continuation_preserved = false; }, TypeError);
  assert.throws(() => { turn.state = 'COMPLETED'; }, TypeError);

  // Identity does not come from the backend, the device or the channel.
  assert.equal(conversation.conversation_id.includes('WEB'), false);
  assert.equal(conversation.conversation_id.includes('thread'), false);
  assert.equal(registry.conversation(conversation.conversation_id).identity_is_provider_independent, true);

  // Two registries share nothing, and identity is not derivable.
  const other = registryAt().registry;
  const otherConversation = other.createConversation();
  assert.notEqual(otherConversation.conversation_id, conversation.conversation_id);
  assert.equal(other.conversation(conversation.conversation_id), null);

  assert.throws(() => createConversationRegistry({ clock: () => T0 }), error => error.code === 'ENTROPY_REQUIRED');
  assert.throws(() => createConversationRegistry({ entropy: () => 'zz', clock: () => T0 }).createConversation(), error => error.code === 'ENTROPY_REQUIRED');
  assert.equal(failure(() => registry.openTurn({ conversation_id: conversation.conversation_id, bundle_ref: 'bundle:nope' })).code, 'UNKNOWN_BUNDLE');
  const foreign = registryAt().registry;
  const foreignConversation = foreign.createConversation();
  foreign.bindBackend({ conversation_id: foreignConversation.conversation_id, channel: 'WEB' });
  const foreignBundle = foreign.createInputBundle({ conversation_id: foreignConversation.conversation_id, text: 'x', provenance: PROVENANCE });
  assert.equal(failure(() => registry.openTurn({ conversation_id: conversation.conversation_id, bundle_ref: foreignBundle.bundle_ref })).code, 'UNKNOWN_BUNDLE', 'a bundle belongs to its conversation');
  assert.throws(() => createConversationRegistry({ entropy: () => 'ab', clock: 'now' }), error => error.code === 'INVALID_CLOCK');
  assert.equal(registry.policy().policy_ref, 'policy:gai-conversation-default');
});
