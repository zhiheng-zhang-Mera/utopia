// Conformance tests for GAI-004 — API channel + explicit consent + budget policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMISSION_VERDICTS, API_PROTOCOLS, CONSENT_KINDS, DEFAULT_BUDGET_POLICY, ApiChannelError,
  createApiChannel, findSecretFields, looksLikeSecretValue, redact, usageFromResponse,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const SECRET = 'sk-live-0123456789abcdefghijklmnop';

/** Deterministic protocol adapters. Each records whether it was reached. */
function createAdapters({ streaming = false, fault = null, usage = { input_tokens: 10, output_tokens: 5 }, response = { text: 'ok' } } = {}) {
  const calls = [];
  const make = protocol => Object.freeze({
    protocol,
    supports: Object.freeze({ streaming }),
    execute({ request, provider, model, stream, credential_ref }) {
      calls.push({ protocol, provider, model, stream, credential_ref, request });
      if (fault) {
        const error = new Error(fault.message ?? 'adapter fault');
        error.code = fault.code;
        if (fault.retry_after_ms !== undefined) error.retry_after_ms = fault.retry_after_ms;
        throw error;
      }
      return { ...response, ...(usage === null ? {} : { usage }) };
    },
  });
  return { adapters: { OPENAI_COMPATIBLE: make('OPENAI_COMPATIBLE'), ANTHROPIC: make('ANTHROPIC'), GEMINI: make('GEMINI') }, calls };
}

const approvedCommand = (overrides = {}) => ({
  consent_id: 'consent-1',
  kind: 'USER_COMMAND',
  verdict: 'APPROVED',
  action_ref: 'action:1',
  command_ref: 'command:use-api',
  setting_ref: null,
  scope: 'action:1',
  created_at: T0,
  ...overrides,
});

const channelAt = (options = {}, config = {}) => {
  const { adapters, calls } = createAdapters(options);
  const channel = createApiChannel({ adapters, config, clock: () => T0 });
  return { channel, calls };
};

test('no API network call happens before consent and budget admission', () => {
  const { channel, calls } = channelAt();
  assert.deepEqual([...API_PROTOCOLS], ['OPENAI_COMPATIBLE', 'ANTHROPIC', 'GEMINI']);

  // No consent record at all: refused, adapter untouched.
  const noConsent = channel.execute({ action_ref: 'action:1', protocol: 'OPENAI_COMPATIBLE', request: { prompt: 'hi' } });
  assert.equal(noConsent.ok, false);
  assert.equal(noConsent.executed, false);
  assert.equal(noConsent.adapter_called, false);
  assert.equal(noConsent.admission.verdict, 'REFUSED_NO_CONSENT');
  assert.equal(noConsent.admission.reason, 'NO_CONSENT_RECORD');
  assert.equal(noConsent.admission.api_execution_permitted, false);
  assert.equal(noConsent.admission.budget, null, 'the budget is not even evaluated without consent');

  // Denied consent: still refused.
  const denied = channel.execute({ action_ref: 'action:1', consent: approvedCommand({ verdict: 'DENIED' }), protocol: 'OPENAI_COMPATIBLE', request: {} });
  assert.equal(denied.admission.verdict, 'REFUSED_NO_CONSENT');
  assert.equal(denied.admission.reason, 'CONSENT_DENIED');
  assert.equal(denied.adapter_called, false);

  // Consent approved but budget denied: refused, and the verdict says budget — not consent.
  const overBudget = channel.execute({
    action_ref: 'action:1',
    consent: approvedCommand(),
    protocol: 'OPENAI_COMPATIBLE',
    request: { estimated_actions: 99 },
  });
  assert.equal(overBudget.ok, false);
  assert.equal(overBudget.adapter_called, false);
  assert.equal(overBudget.admission.verdict, 'REFUSED_BUDGET');
  assert.equal(overBudget.admission.budget.verdict, 'OVER_PER_ACTION_LIMIT');
  assert.equal(overBudget.admission.budget.allowed, false);

  assert.equal(calls.length, 0, 'not one adapter call was made');

  // Both approved: the run proceeds.
  const admitted = channel.execute({ action_ref: 'action:1', consent: approvedCommand(), protocol: 'OPENAI_COMPATIBLE', provider: 'deepseek', model: 'chat', request: { prompt: 'hi' } });
  assert.equal(admitted.ok, true);
  assert.equal(admitted.executed, true);
  assert.equal(admitted.adapter_called, true);
  assert.equal(admitted.admission.verdict, 'ADMITTED');
  assert.equal(admitted.admission.reason, 'CONSENT_AND_BUDGET_APPROVED');
  assert.equal(admitted.admission.budget.verdict, 'WITHIN_BUDGET');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].protocol, 'OPENAI_COMPATIBLE');
  assert.equal(calls[0].provider, 'deepseek');
  assert.equal(channel.adapterCalls().length, 1);
  assert.deepEqual([...ADMISSION_VERDICTS], ['ADMITTED', 'REFUSED_NO_CONSENT', 'REFUSED_BUDGET', 'REFUSED_USAGE_UNKNOWN', 'REFUSED_NO_ADAPTER']);
});

test('a Web failure proposes API but never grants it, and budget does not stand in for consent', () => {
  const { channel, calls } = channelAt();
  const proposal = channel.proposeApiSwitch({ proposal_id: 'proposal-1', reason: 'web channel unavailable', web_channel_state: 'FAILED', action_ref: 'action:1' });
  assert.equal(proposal.from_channel, 'WEB');
  assert.equal(proposal.to_channel, 'API');
  assert.equal(proposal.automatic, true);
  assert.equal(proposal.grants_permission, false, 'WEB failure != API permission');
  assert.equal(proposal.web_failure_implies_permission, false);
  assert.equal(proposal.requires_consent, true);
  assert.equal(proposal.consent, null);
  assert.equal(proposal.admission, null);

  // A proposal alone is not consent.
  const withProposalOnly = channel.execute({ action_ref: 'action:1', proposal, protocol: 'OPENAI_COMPATIBLE', request: {} });
  assert.equal(withProposalOnly.admission.verdict, 'REFUSED_NO_CONSENT');
  assert.equal(withProposalOnly.adapter_called, false);

  // Budget alone is not consent either.
  const budgetOnly = channel.checkBudget({ action_ref: 'action:1' });
  assert.equal(budgetOnly.allowed, true);
  assert.equal(budgetOnly.user_consent_implied, false);
  assert.equal(channel.admit({ action_ref: 'action:1', request: {} }).verdict, 'REFUSED_NO_CONSENT');

  // An explicit user command is enough on its own — no Web failure needs to have happened.
  const explicit = channel.execute({ action_ref: 'action:1', consent: approvedCommand(), protocol: 'ANTHROPIC', request: { prompt: 'explicit' } });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.provenance.user_directed, true, 'an explicit use-API command is a user-directed choice');
  assert.equal(explicit.provenance.consent_kind, 'USER_COMMAND');
  assert.equal(explicit.provenance.consent_ref, 'consent-1');
  assert.equal(explicit.provenance.escalation, false, 'a direct user choice is not an escalation');
  assert.equal(calls.length, 1);

  // The same command escalated from a Web failure records the proposal reference.
  const escalated = channel.execute({ action_ref: 'action:1', proposal, consent: approvedCommand({ consent_id: 'consent-2' }), protocol: 'OPENAI_COMPATIBLE', request: {} });
  assert.equal(escalated.ok, true);
  assert.equal(escalated.provenance.escalation, true);
  assert.equal(escalated.provenance.proposal_ref, 'proposal-1');
  assert.equal(escalated.provenance.web_failure_implies_permission, false);
  assert.equal(escalated.admission.budget_available_implies_consent, false);

  // A user SETTING is an equally explicit consent record, and it must name the setting.
  const settingConsent = channel.execute({
    action_ref: 'action:1',
    consent: approvedCommand({ consent_id: 'consent-3', kind: 'USER_SETTING', command_ref: null, setting_ref: 'setting:always-use-api' }),
    protocol: 'GEMINI',
    request: {},
  });
  assert.equal(settingConsent.ok, true);
  assert.equal(settingConsent.provenance.consent_kind, 'USER_SETTING');
  assert.equal(settingConsent.provenance.user_directed, true);
  assert.deepEqual([...CONSENT_KINDS], ['USER_COMMAND', 'USER_SETTING']);
  assert.throws(() => channel.validateConsent(approvedCommand({ kind: 'USER_SETTING', command_ref: null })), error => error.code === 'INVALID_CONSENT');
  assert.throws(() => channel.validateConsent({ consent_id: 'x', kind: 'USER_COMMAND', verdict: 'APPROVED', scope: 's', created_at: T0, command_ref: null, setting_ref: null, action_ref: null }), error => error.code === 'INVALID_CONSENT');
  assert.throws(() => channel.validateConsent({ ...approvedCommand(), extra: true }), error => error.code === 'INVALID_CONSENT');
});

test('rate limit, auth and provider faults stay typed and never look like success', () => {
  for (const fault of [{ code: 'RATE_LIMITED', retry_after_ms: 5000, message: 'slow down' }, { code: 'AUTH_FAILED', message: 'bad key' }, { code: 'TIMEOUT', message: 'gateway timeout' }, { code: 'PROVIDER_FAULT', message: 'upstream 500' }]) {
    const { channel } = channelAt({ fault });
    const result = channel.execute({ action_ref: 'action:1', consent: approvedCommand(), protocol: 'OPENAI_COMPATIBLE', request: {} });
    assert.equal(result.ok, false, `${fault.code} is not a success`);
    assert.equal(result.executed, false);
    assert.equal(result.adapter_called, true, 'the adapter was reached, so the fault is a real transportation fault');
    assert.equal(result.fault.code, fault.code);
    assert.equal(result.response, null);
    assert.equal(result.usage, null);
    assert.equal(result.fault.retryable, ['RATE_LIMITED', 'TIMEOUT', 'PROVIDER_FAULT'].includes(fault.code));
    if (fault.retry_after_ms !== undefined) assert.equal(result.fault.retry_after_ms, 5000);
  }
  // An untyped adapter crash is still a typed result for the caller.
  const { channel } = channelAt({ fault: { code: 'SOMETHING_NEW', message: 'vendor changed' } });
  const unknown = channel.execute({ action_ref: 'action:1', consent: approvedCommand(), protocol: 'OPENAI_COMPATIBLE', request: {} });
  assert.equal(unknown.fault.code, 'PROVIDER_FAULT');
  assert.equal(unknown.ok, false);

  // A missing adapter never silently degrades to another protocol.
  const empty = createApiChannel({ adapters: {}, clock: () => T0 });
  const noAdapter = empty.execute({ action_ref: 'action:1', consent: approvedCommand(), protocol: 'GEMINI', request: {} });
  assert.equal(noAdapter.admission.verdict, 'REFUSED_NO_ADAPTER');
  assert.equal(noAdapter.adapter_called, false);
  assert.throws(() => empty.execute({ action_ref: 'action:1', consent: approvedCommand(), protocol: 'MYSTERY_PROTOCOL', request: {} }), error => error.code === 'INVALID_REQUEST');
});

test('usage the provider did not report stays unknown, never zero', () => {
  const { channel } = channelAt({ usage: null });
  const result = channel.execute({ action_ref: 'action:1', consent: approvedCommand(), protocol: 'OPENAI_COMPATIBLE', request: {} });
  assert.equal(result.ok, true);
  assert.equal(result.usage.known, false);
  assert.equal(result.usage.input_tokens, null);
  assert.equal(result.usage.output_tokens, null);
  assert.equal(result.usage.total_tokens, null, 'absent usage is not zero tokens');
  assert.equal(result.usage.cost, null, 'absent cost is not a free call');
  assert.equal(result.usage.reason, 'PROVIDER_REPORTED_NO_USAGE');
  assert.equal(result.provenance.usage_known, false);

  const reported = usageFromResponse({ usage: { input_tokens: 3, output_tokens: 4 } });
  assert.deepEqual({ known: reported.known, total: reported.total_tokens }, { known: true, total: 7 });
  const partial = usageFromResponse({ usage: { output_tokens: 4 } });
  assert.equal(partial.known, true);
  assert.equal(partial.input_tokens, null, 'a partially reported number is not invented');
  assert.equal(usageFromResponse({}).known, false);

  // Unknown aggregate spend is not treated as zero budget consumed: the check refuses instead.
  const unknownAggregate = channel.checkBudget({ action_ref: 'action:1', usage_so_far: { known: false } });
  assert.equal(unknownAggregate.verdict, 'AGGREGATE_USAGE_UNKNOWN');
  assert.equal(unknownAggregate.allowed, false);
  assert.equal(unknownAggregate.aggregate_consumed, null);
  assert.equal(unknownAggregate.usage_absent_treated_as_zero, false);
  assert.equal(unknownAggregate.on_unknown_usage, DEFAULT_BUDGET_POLICY.on_unknown_usage);

  const refused = channel.execute({ action_ref: 'action:1', consent: approvedCommand(), protocol: 'OPENAI_COMPATIBLE', request: {}, usage_so_far: { known: false } });
  assert.equal(refused.ok, false);
  assert.equal(refused.admitted, undefined);
  assert.equal(refused.admission.verdict, 'REFUSED_USAGE_UNKNOWN');
  assert.equal(refused.adapter_called, false, 'unknown spend does not buy a call');

  // Accumulation keeps unknown sticky rather than folding it in as zero.
  const running = channel.accumulateUsage({ known: true, actions: 2, total_tokens: 20 }, reported);
  assert.deepEqual({ known: running.known, actions: running.actions, total: running.total_tokens }, { known: true, actions: 3, total: 27 });
  const poisoned = channel.accumulateUsage({ known: true, actions: 2, total_tokens: 20 }, usageFromResponse({}));
  assert.equal(poisoned.known, false);
  assert.equal(poisoned.total_tokens, null);
  assert.equal(poisoned.reason, 'USAGE_UNKNOWN_STAYS_UNKNOWN');
  assert.equal(channel.checkBudget({ action_ref: 'action:1', usage_so_far: poisoned }).allowed, false);

  // Aggregate limits are enforced once spend is known.
  const tight = createApiChannel({ adapters: createAdapters().adapters, config: { budget: { per_action_limit: 5, aggregate_limit: 10 } }, clock: () => T0 });
  assert.equal(tight.checkBudget({ action_ref: 'a', usage_so_far: { known: true, total_tokens: 9 } }).verdict, 'WITHIN_BUDGET');
  const over = tight.checkBudget({ action_ref: 'a', usage_so_far: { known: true, total_tokens: 10 }, request: { estimated_actions: 1 } });
  assert.equal(over.verdict, 'OVER_AGGREGATE_LIMIT');
  assert.equal(over.allowed, false);
  assert.equal(tight.admit({ action_ref: 'a', consent: approvedCommand(), usage_so_far: { known: true, total_tokens: 10 } }).verdict, 'REFUSED_BUDGET');
});

test('streaming is supported only where the adapter says so, and secrets never reach provenance', () => {
  const nonStreaming = channelAt({ streaming: false });
  const refused = nonStreaming.channel.execute({ action_ref: 'action:1', consent: approvedCommand(), protocol: 'OPENAI_COMPATIBLE', request: {}, stream: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.adapter_called, false, 'an unsupported stream semantics request is refused instead of silently downgraded');
  assert.equal(refused.fault.code, 'STREAMING_UNSUPPORTED');
  assert.equal(refused.fault.retryable, false);
  assert.equal(nonStreaming.calls.length, 0);

  const streaming = channelAt({ streaming: true });
  const ok = streaming.channel.execute({ action_ref: 'action:1', consent: approvedCommand(), protocol: 'ANTHROPIC', request: {}, stream: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.provenance.stream, true);
  assert.equal(streaming.calls[0].stream, true);

  // A credential is passed as a handle reference, and secret material is redacted everywhere.
  const withSecret = channelAt();
  const result = withSecret.channel.execute({
    action_ref: 'action:1',
    consent: approvedCommand(),
    protocol: 'OPENAI_COMPATIBLE',
    credential_ref: 'handle:CREDENTIAL:7',
    request: { prompt: 'hello', api_key: SECRET },
  });
  assert.equal(result.ok, true);
  assert.equal(withSecret.calls[0].credential_ref, 'handle:CREDENTIAL:7', 'the adapter receives a handle, not a secret');
  assert.equal(withSecret.calls[0].request.api_key, SECRET, 'the redaction boundary is our own records, not the adapter call');
  assert.deepEqual(findSecretFields(result.provenance), []);
  assert.equal(JSON.stringify(result.provenance).includes(SECRET), false);
  assert.equal(JSON.stringify(result.response).includes(SECRET), false, 'the stored response is redacted');
  assert.equal(JSON.stringify(withSecret.channel.provenanceLog()).includes(SECRET), false);
  assert.equal(JSON.stringify(withSecret.channel.logEntries()).includes(SECRET), false);
  assert.equal(result.provenance.credential_ref, null, 'a credential reference is carried by the admission, not invented in provenance');
  assert.equal(looksLikeSecretValue(SECRET), true);
  assert.equal(redact({ nested: { token: SECRET } }).nested.token, '[REDACTED]');
  assert.equal(redact(`failed with ${SECRET}`), 'failed with [REDACTED]', 'a secret inside a longer message is redacted too');
});

test('channel state stays isolated, frozen and free of ambient behaviour', () => {
  const first = channelAt();
  const second = channelAt();
  first.channel.proposeApiSwitch({ proposal_id: 'p1', reason: 'r', web_channel_state: 'FAILED' });
  assert.equal(first.channel.logEntries().length, 1);
  assert.equal(second.channel.logEntries().length, 0, 'channels share no state');

  const proposal = first.channel.proposeApiSwitch({ proposal_id: 'p2', reason: 'r', web_channel_state: 'FAILED' });
  assert.throws(() => { proposal.grants_permission = true; }, TypeError, 'a proposal cannot be mutated into permission');
  assert.throws(() => first.channel.proposeApiSwitch({ proposal_id: 'p3', web_channel_state: 'FAILED' }), error => error.code === 'INVALID_PROPOSAL');
  assert.throws(() => first.channel.proposeApiSwitch({ proposal_id: 'p3', reason: 'r', web_channel_state: 'FAILED', consent: approvedCommand() }), error => error.code === 'INVALID_PROPOSAL');
  assert.throws(() => createApiChannel({ adapters: {} , clock: 'now' }), error => error.code === 'INVALID_CLOCK');
  assert.equal(first.channel.budgetPolicy().per_action_limit, DEFAULT_BUDGET_POLICY.per_action_limit);
  assert.deepEqual([...CONSENT_KINDS].length, 2);
  assert.throws(() => first.channel.execute({ action_ref: 'action:1', consent: approvedCommand(), protocol: 'OPENAI_COMPATIBLE', request: {}, at: 'yesterday' }), error => error.code === 'INVALID_REQUEST');
});
