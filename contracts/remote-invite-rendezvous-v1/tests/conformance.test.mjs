// Conformance tests for RF-005 â€?remote invite / meeting code / deep-link rendezvous.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_ALPHABET, DEEP_LINK_SCHEME, INVITE_CODES, InviteError, PAIRING_ENTRY_POINT, WEB_LINK_BASE,
  codeChecksum, createInviteRendezvous, encodeRendezvousCode, normalizeCodeInput, parseLocator,
  rendezvousUnavailable,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const at = ms => new Date(Date.parse(T0) + ms).toISOString();

/** Deterministic but varied entropy: real sources differ per call, so the double must too. */
function entropyFrom(seeds) {
  let index = 0;
  const entropy = bytes => {
    const seed = seeds[Math.min(index, seeds.length - 1)];
    const salt = (index * 0x9e3779b1).toString(16).padStart(8, '0');
    index += 1;
    return `${salt}${seed.repeat(Math.ceil((bytes * 2) / seed.length))}`.slice(0, bytes * 2);
  };
  return entropy;
}

function rendezvousAt({ now = 0, policy = {}, seeds = ['a1b2c3d4e5f60718293a4b5c6d7e8f90', '0f1e2d3c4b5a69788796a5b4c3d2e1f0'] } = {}) {
  const state = { ms: now };
  const clock = () => at(state.ms);
  clock.advance = ms => { state.ms += ms; return clock(); };
  const rendezvous = createInviteRendezvous({ entropy: entropyFrom(seeds), clock, policy });
  return { rendezvous, clock };
}

const hostRef = 'device:host-a';
const guestRef = 'device:guest-b';
const createInvite = (rendezvous, overrides = {}) => rendezvous.createInvite({ host_device_ref: hostRef, ...overrides });

const genericFailure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof InviteError, `expected an InviteError, got ${error?.name}`);
    return {
      code: error.code, detail: error.detail, status: error.status, generic: error.generic === true, message: error.message,
      retry_after_ms: error.retry_after_ms, capability: error.capability, capabilities_invocable: error.capabilities_invocable,
    };
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

test('one invite renders as code, deep link, web link and QR payload without creating trust records', () => {
  const { rendezvous } = rendezvousAt();
  const invite = createInvite(rendezvous);
  assert.equal(invite.state, 'ACTIVE');
  assert.equal(invite.uses, 0);
  assert.equal(invite.max_uses, 1);
  assert.equal(invite.path_independent, true);
  assert.equal(invite.relay_coupled, false);
  assert.equal(invite.reconnect_authority, false);
  assert.equal(invite.representations.invite_id, invite.invite_id);
  assert.equal(invite.representations.separate_trust_records, 0, 'four representations are still one rendezvous');
  assert.equal(invite.representations.creates_trust, false);
  assert.equal(invite.representations.is_authentication, false);
  assert.equal(invite.representations.grants_permission, false);
  assert.equal(invite.representations.carries_private_key, false);
  assert.equal(invite.representations.carries_bearer_token, false);
  assert.equal(invite.representations.locator_only, true);

  const { code, deep_link: deepLink, web_link: webLink, qr_payload: qrPayload } = invite.representations;
  assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]$/);
  assert.equal(deepLink.startsWith(DEEP_LINK_SCHEME), true);
  assert.equal(webLink.startsWith(WEB_LINK_BASE), true);
  assert.equal(qrPayload.includes(encodeURIComponent(code)) || qrPayload.includes(code), true);

  // Every representation resolves back to the same rendezvous, and none of them carries a secret.
  for (const locator of [code, deepLink, webLink, qrPayload]) {
    const parsed = parseLocator(locator);
    assert.equal(parsed.format_valid, true, `${locator} must parse`);
    assert.equal(parsed.code, code, 'all four representations name the same rendezvous code');
  }
  assert.equal(parseLocator(code.toLowerCase().replace(/-/g, ' ')).code, code, 'a human retyping the code with spaces and lowercase still reaches the same rendezvous');
  assert.equal(parseLocator(code.replace('0', 'O').replace('1', 'I')).code, code, 'ambiguous characters are folded, not rejected');
  assert.equal(rendezvous.representationsFor({ invite_id: invite.invite_id }).code, code);
  // The representations carry a locator, never a token: there is no bearer-shaped material in them.
  for (const locator of [deepLink, webLink, qrPayload]) {
    assert.equal(/token|secret|key=|bearer/i.test(locator), false, `${locator} must not carry credentials`);
  }
  assert.equal(normalizeCodeInput(code), code.replace(/-/g, ''));
  assert.equal(CODE_ALPHABET.includes('I') || CODE_ALPHABET.includes('O'), false);
  assert.equal(encodeRendezvousCode('0123456789').code.endsWith(codeChecksum(encodeRendezvousCode('0123456789').payload)), true);
});

test('expired, cancelled and already-used invites fail with one indistinguishable generic error', () => {
  const { rendezvous, clock } = rendezvousAt();

  // Unknown code.
  const unknown = genericFailure(() => rendezvous.redeem({ locator: 'ZZZZ-ZZZZ-Z', guest_device_ref: guestRef }));

  // Expired.
  const expiredInvite = createInvite(rendezvous, { ttl_ms: 1000 });
  clock.advance(2000);
  const expired = genericFailure(() => rendezvous.redeem({ locator: expiredInvite.representations.code, guest_device_ref: guestRef }));

  // Cancelled.
  const cancelledInvite = createInvite(rendezvous);
  rendezvous.revoke({ invite_id: cancelledInvite.invite_id, host_device_ref: hostRef });
  const cancelled = genericFailure(() => rendezvous.redeem({ locator: cancelledInvite.representations.code, guest_device_ref: guestRef }));

  // Already used (one-use by default).
  const usedInvite = createInvite(rendezvous);
  const ticket = rendezvous.redeem({ locator: usedInvite.representations.code, guest_device_ref: guestRef });
  rendezvous.confirm({ ticket_ref: ticket.ticket_ref, host_device_ref: hostRef, accepted: true });
  const used = genericFailure(() => rendezvous.redeem({ locator: usedInvite.representations.code, guest_device_ref: guestRef }));

  // Malformed input fails the same way, so probing the format teaches nothing about existence.
  const malformed = genericFailure(() => rendezvous.redeem({ locator: 'not-a-code', guest_device_ref: guestRef }));

  assert.deepEqual(new Set([unknown, expired, cancelled, used, malformed].map(entry => JSON.stringify(entry))).size, 1, 'every unusable locator produces byte-identical failures');
  assert.equal(unknown.code, 'RENDEZVOUS_UNAVAILABLE');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.generic, true);
  assert.equal(JSON.stringify(unknown).includes(hostRef), false, 'the failure never names the host device');
  assert.equal(rendezvous.getInvite(expiredInvite.invite_id).state, 'EXPIRED');
  assert.equal(rendezvous.getInvite(cancelledInvite.invite_id).state, 'CANCELLED');
  assert.equal(rendezvous.getInvite(usedInvite.invite_id).state, 'USED');
  assert.equal(rendezvous.representationsFor({ invite_id: cancelledInvite.invite_id }).creates_trust, false, 'a cancelled invite still renders, and still grants nothing');
  assert.equal(genericFailure(() => rendezvous.representationsFor({ invite_id: 'invite:nope' })).code, 'RENDEZVOUS_UNAVAILABLE');
  assert.equal(genericFailure(() => rendezvous.revoke({ invite_id: 'invite:nope', host_device_ref: hostRef })).code, 'RENDEZVOUS_UNAVAILABLE');
  assert.equal(genericFailure(() => rendezvous.revoke({ invite_id: cancelledInvite.invite_id, host_device_ref: 'device:someone-else' })).code, 'NOT_THE_HOST');
  assert.equal(typeof rendezvousUnavailable, 'function');
});

test('guessing is rate-limited and never reveals whether a device exists', () => {
  const { rendezvous } = rendezvousAt({ policy: { rate_limit: { max_attempts: 3, window_ms: 60000 } } });
  const real = createInvite(rendezvous);

  const probes = [];
  for (let index = 0; index < 3; index += 1) {
    probes.push(genericFailure(() => rendezvous.preview({ locator: 'ZZZZ-ZZZZ-Z', client_ref: 'client:prober' })));
  }
  assert.equal(new Set(probes.map(entry => JSON.stringify(entry))).size, 1, 'a prober cannot tell two misses apart');

  const limited = genericFailure(() => rendezvous.preview({ locator: real.representations.code, client_ref: 'client:prober' }));
  assert.equal(limited.code, 'RATE_LIMITED');
  assert.equal(limited.status, 429);
  assert.equal(limited.retry_after_ms, 60000);
  assert.equal(JSON.stringify(limited).includes(hostRef), false);
  // A different client is unaffected, and the limit is per client rather than per code.
  const otherClient = genericFailure(() => rendezvous.preview({ locator: 'ZZZZ-ZZZZ-Z', client_ref: 'client:other' }));
  assert.equal(otherClient.code, 'RENDEZVOUS_UNAVAILABLE', 'the limiter is per client, and it never looked at the code');

  // The preview reaches only the pairing entry point, and discloses no host identity.
  const preview = rendezvous.preview({ locator: real.representations.code, client_ref: 'client:guest' });
  assert.equal(preview.available, true);
  assert.equal(preview.pairing_entry_point, PAIRING_ENTRY_POINT);
  assert.equal(preview.converges_on_pairing, true);
  assert.equal(preview.requires_confirmation, true);
  assert.equal(preview.grants_trust, false);
  assert.equal(preview.grants_permission, false);
  assert.equal(preview.host_identity_disclosed, false);
  assert.equal(preview.host_device_ref, null);
  assert.equal(JSON.stringify(preview).includes(hostRef), false, 'the preview never names the host device');

  // parseLocator is purely local: it validates format and resolves nothing.
  const unknownButWellFormed = parseLocator('ZZZZ-ZZZZ-Z');
  assert.equal(unknownButWellFormed.format_valid, false, 'the checksum is checked locally');
  const wellFormed = parseLocator(real.representations.code);
  assert.equal(wellFormed.format_valid, true);
  assert.equal('invite_ref' in wellFormed, false, 'a parsed locator carries no reference to any device or invite');
});

test('entering an invite reaches pairing preview but cannot invoke capabilities before confirmation', () => {
  const { rendezvous } = rendezvousAt();
  const invite = createInvite(rendezvous);
  const ticket = rendezvous.redeem({ locator: invite.representations.web_link, client_ref: 'client:guest', guest_device_ref: guestRef });
  assert.equal(ticket.state, 'AWAITING_CONFIRMATION');
  assert.equal(ticket.trust_established, false);
  assert.equal(ticket.capabilities_invocable, false);
  assert.equal(ticket.host_identity_disclosed, false);
  assert.equal(ticket.host_device_ref, null);
  assert.equal(ticket.pairing_entry_point, PAIRING_ENTRY_POINT);
  assert.equal(ticket.use_consumed, false);
  assert.equal(rendezvous.getInvite(invite.invite_id).state, 'ACTIVE', 'redeeming alone does not consume the invite');

  const beforeConfirmation = genericFailure(() => rendezvous.invokeCapability({ ticket_ref: ticket.ticket_ref, capability: 'camera.capture@1' }));
  assert.equal(beforeConfirmation.code, 'CONFIRMATION_REQUIRED');
  assert.equal(beforeConfirmation.capabilities_invocable, false);
  assert.equal(beforeConfirmation.capability, 'camera.capture@1');
  assert.equal(JSON.stringify(beforeConfirmation).includes(hostRef), false);

  // Only the host may confirm, and a decline establishes nothing and consumes nothing.
  assert.equal(genericFailure(() => rendezvous.confirm({ ticket_ref: ticket.ticket_ref, host_device_ref: 'device:impostor', accepted: true })).code, 'NOT_THE_HOST');
  const declined = rendezvous.confirm({ ticket_ref: ticket.ticket_ref, host_device_ref: hostRef, accepted: false });
  assert.equal(declined.trust_established, false);
  assert.equal(declined.use_consumed, false);
  assert.equal(declined.invite_state, 'ACTIVE', 'a declined rendezvous does not burn the invite');
  assert.equal(declined.host_identity_disclosed, false);
  assert.equal(genericFailure(() => rendezvous.invokeCapability({ ticket_ref: ticket.ticket_ref, capability: 'camera.capture@1' })).code, 'CONFIRMATION_REQUIRED');

  // The invite is still usable, and acceptance establishes trust and discloses the identity once.
  const second = rendezvous.redeem({ locator: invite.representations.code, client_ref: 'client:guest-2', guest_device_ref: 'device:guest-c' });
  const accepted = rendezvous.confirm({ ticket_ref: second.ticket_ref, host_device_ref: hostRef, accepted: true });
  assert.equal(accepted.trust_established, true);
  assert.equal(accepted.use_consumed, true);
  assert.equal(accepted.host_identity_disclosed, true, 'identity is disclosed only after confirmation');
  assert.equal(accepted.host_device_ref, hostRef);
  assert.equal(accepted.granted_permission, false, 'a rendezvous grants no permission of its own');
  assert.equal(accepted.on_the_rendezvous_service, false, 'trust is established for the Fabric, not on the rendezvous service');
  assert.equal(accepted.pairing_handoff.entry_point, PAIRING_ENTRY_POINT);
  assert.equal(accepted.pairing_handoff.converges_on_pairing, true);
  assert.equal(accepted.pairing_handoff.pairwise_key_exchange, 'RF-002', 'the handoff names the one pairing protocol');
  assert.equal(accepted.pairing_handoff.path_negotiation, 'RF-006');
  assert.equal(accepted.pairing_handoff.capabilities_invocable, false);
  assert.equal(accepted.invite_state, 'USED');
  assert.equal(genericFailure(() => rendezvous.confirm({ ticket_ref: second.ticket_ref, host_device_ref: hostRef, accepted: true })).code, 'ALREADY_CONFIRMED');
  assert.equal(genericFailure(() => rendezvous.invokeCapability({ ticket_ref: second.ticket_ref, capability: 'camera.capture@1' })).code, 'RENDEZVOUS_IS_NOT_A_CAPABILITY_PATH');
});

test('an invite is a one-time rendezvous, and after trust it can no longer reconnect anything', () => {
  const { rendezvous } = rendezvousAt();
  const single = createInvite(rendezvous);
  assert.equal(genericFailure(() => rendezvous.createInvite({ host_device_ref: hostRef, max_uses: 4 })).code, 'MULTI_USE_NOT_PERMITTED');
  assert.equal(genericFailure(() => rendezvous.createInvite({ host_device_ref: hostRef, max_uses: 4, allow_multi_use: true })).code, 'MULTI_USE_NOT_PERMITTED', 'the deployment policy must permit multi-use too');
  assert.equal(genericFailure(() => rendezvous.createInvite({ host_device_ref: hostRef, max_uses: 0 })).code, 'INVALID_INVITE');
  assert.equal(genericFailure(() => rendezvous.createInvite({ host_device_ref: hostRef, max_uses: 99 })).code, 'INVALID_INVITE');
  assert.equal(genericFailure(() => rendezvous.createInvite({ host_device_ref: hostRef, ttl_ms: 99999999 })).code, 'INVALID_INVITE');

  // A multi-use invite is only allowed when policy says so, and still stops at max_uses.
  const multi = rendezvousAt({ policy: { allow_multi_use: true } });
  const shared = createInvite(multi.rendezvous, { max_uses: 2, allow_multi_use: true });
  assert.equal(shared.multi_use, true);
  for (let index = 0; index < 2; index += 1) {
    const ticket = multi.rendezvous.redeem({ locator: shared.representations.code, guest_device_ref: `device:guest-${index}` });
    const accepted = multi.rendezvous.confirm({ ticket_ref: ticket.ticket_ref, host_device_ref: hostRef, accepted: true });
    assert.equal(accepted.trust_established, true);
    assert.equal(accepted.uses, index + 1);
  }
  assert.equal(multi.rendezvous.getInvite(shared.invite_id).state, 'USED');
  assert.equal(genericFailure(() => multi.rendezvous.redeem({ locator: shared.representations.code, guest_device_ref: 'device:guest-late' })).code, 'RENDEZVOUS_UNAVAILABLE');

  // Reconnection after trust requires current Fabric trust state, not the old locator.
  assert.equal(genericFailure(() => rendezvous.reconnectViaInvite({ locator: single.representations.code })).code, 'RENDEZVOUS_IS_NOT_RECONNECT_AUTHORITY');
  assert.equal(genericFailure(() => rendezvous.confirm({ ticket_ref: 'ticket:nope', host_device_ref: hostRef, accepted: true })).code, 'UNKNOWN_TICKET');
  assert.equal(genericFailure(() => rendezvous.invokeCapability({ ticket_ref: 'ticket:nope' })).code, 'UNKNOWN_TICKET');
  assert.equal(INVITE_CODES.includes('RENDEZVOUS_IS_NOT_RECONNECT_AUTHORITY'), true);
});

test('the rendezvous service stays independent of the eventual data path', () => {
  const { rendezvous } = rendezvousAt();
  const invite = createInvite(rendezvous);
  const ticket = rendezvous.redeem({ locator: invite.representations.deep_link, guest_device_ref: guestRef });
  const accepted = rendezvous.confirm({ ticket_ref: ticket.ticket_ref, host_device_ref: hostRef, accepted: true });

  // Nothing about a path, relay, transport or session was decided here.
  const serialized = JSON.stringify(accepted);
  for (const forbidden of ['relay_ref', 'transport', 'session_ref', 'ip', 'quic', 'webrtc', 'websocket']) {
    assert.equal(serialized.includes(forbidden), false, `the rendezvous must not decide ${forbidden}`);
  }
  assert.equal(accepted.pairing_handoff.path_negotiation, 'RF-006');
  assert.equal(accepted.on_the_rendezvous_service, false);

  // The records are closed: no field can be added or flipped from outside.
  assert.throws(() => { invite.state = 'CANCELLED'; }, TypeError, 'invite projections are frozen');
  assert.throws(() => { invite.representations.creates_trust = true; }, TypeError);
  assert.throws(() => { accepted.pairing_handoff.converges_on_pairing = false; }, TypeError);
  const stored = rendezvous.invites()[0];
  assert.equal(stored.state, 'USED');
  assert.equal(stored.max_uses, 1);
  assert.equal(rendezvous.tickets().length, 1);
  assert.equal(rendezvous.journal().some(entry => entry.event === 'TRUST_ESTABLISHED'), true);
  assert.equal(rendezvous.journal().some(entry => entry.event === 'REDEEMED'), true);
  assert.equal(rendezvous.journal().some(entry => entry.event === 'INVITE_CREATED'), true);
  assert.equal(rendezvous.journal().some(entry => entry.event === 'PREVIEWED'), false, 'redeeming a deep link never required a preview');
  assert.equal(genericFailure(() => rendezvous.createInvite({})).code, 'INVALID_INVITE');
  assert.throws(() => createInviteRendezvous({ clock: () => T0 }), error => error.code === 'ENTROPY_REQUIRED', 'the module refuses to invent its own randomness');
  assert.throws(() => createInviteRendezvous({ entropy: entropyFrom(['ab']), clock: 'now' }), error => error.code === 'INVALID_INVITE');
  assert.throws(() => createInviteRendezvous({ entropy: () => 'zz', clock: () => T0 }).createInvite({ host_device_ref: hostRef }), error => error.code === 'ENTROPY_REQUIRED');
  assert.equal(genericFailure(() => rendezvous.redeem({ locator: invite.representations.code, guest_device_ref: '' })).code, 'INVALID_TICKET');
  assert.equal(rendezvous.policy().default_ttl_ms, 600000);
});

/* --------------------------------- 8. regressions (Correction, host Alien) */

import { createInviteRendezvous as makeRendezvous } from '../index.mjs';
import { MAX_INVITE_TTL_MS } from '../invite-rendezvous.mjs';

const T0R = '2026-09-30T12:00:00.000Z';
let seedR = 0;
const entropyR = bytes => ((seedR += 1), `${String(seedR).padStart(4, '0')}${'ab12'.repeat(bytes)}`.slice(0, bytes * 2).padEnd(bytes * 2, 'f'));
const rendezvousR = (policy = {}) => makeRendezvous({ entropy: entropyR, clock: () => T0R, policy });
const expectCodeR = (fn, code) => { try { fn(); } catch (error) { assert.equal(error.code, code, 'expected ' + code + ', got ' + error.code); return error; } assert.fail('expected the call to fail with ' + code); };

test('invite policy values are bounded, so a locator cannot be eternal', () => {
  expectCodeR(() => rendezvousR({ max_ttl_ms: Number.MAX_SAFE_INTEGER }), 'INVALID_INVITE');
  expectCodeR(() => rendezvousR({ max_ttl_ms: MAX_INVITE_TTL_MS + 1 }), 'INVALID_INVITE');
  expectCodeR(() => rendezvousR({ max_ttl_ms: 0 }), 'INVALID_INVITE');
  expectCodeR(() => rendezvousR({ default_ttl_ms: 10_000, max_ttl_ms: 1_000 }), 'INVALID_INVITE');
  expectCodeR(() => rendezvousR({ rate_limit: { max_attempts: Number.MAX_SAFE_INTEGER } }), 'INVALID_INVITE');
  expectCodeR(() => rendezvousR({ rate_limit: { max_attempts: 0 } }), 'INVALID_INVITE');
  expectCodeR(() => rendezvousR({ allow_multi_use: 'yes' }), 'INVALID_INVITE');
  // neighbours: the default policy works, and a longer-but-legal window is still accepted
  assert.equal(rendezvousR().createInvite({ host_device_ref: 'dev-host' }).state, 'ACTIVE');
  assert.equal(rendezvousR({ max_ttl_ms: MAX_INVITE_TTL_MS }).createInvite({ host_device_ref: 'dev-host', ttl_ms: MAX_INVITE_TTL_MS }).state, 'ACTIVE');
});

test('a hostile link is a bad link, never a crash', () => {
  for (const link of ['digitalcity://join?c=%E0%A4%A', 'https://digitalcity.local/join/%E0%A4%A', 'digitalcity://join?c=%']) {
    const verdict = parseLocator(link);
    assert.equal(verdict.format_valid, false, link + ' must be a verdict, not a throw');
    assert.equal(verdict.reason, 'BAD_LINK');
  }
  // neighbours: a well-formed code still parses, and an ordinary bad code still reports its reason
  const good = rendezvousR().createInvite({ host_device_ref: 'dev-host' }).code;
  assert.equal(parseLocator(good).format_valid, true);
  assert.equal(parseLocator('digitalcity://join?c=' + good).format_valid, true);
  assert.equal(parseLocator('ABCD-EFGH-0').reason, 'BAD_CHECKSUM');
});

test('a consumed invite keeps its outcome, and an impossible instant is typed', () => {
  const r = rendezvousR();
  const invite = r.createInvite({ host_device_ref: 'dev-host' });
  const ticket = r.redeem({ locator: invite.code, guest_device_ref: 'dev-guest' });
  assert.equal(r.confirm({ ticket_ref: ticket.ticket_ref, host_device_ref: 'dev-host', accepted: true }).invite_state, 'USED');
  expectCodeR(() => r.revoke({ invite_id: invite.invite_id, host_device_ref: 'dev-host' }), 'RENDEZVOUS_UNAVAILABLE');
  assert.equal(r.getInvite(invite.invite_id).state, 'USED', 'the recorded outcome is not rewritten');
  // an impossible instant is refused rather than reaching toISOString
  expectCodeR(() => rendezvousR().createInvite({ host_device_ref: 'dev-host', at: '2026-13-45T99:99:99Z' }), 'INVALID_INVITE');
  // neighbours: an active invite can still be revoked, and a real instant is accepted
  const live = rendezvousR();
  const active = live.createInvite({ host_device_ref: 'dev-host' });
  assert.equal(live.revoke({ invite_id: active.invite_id, host_device_ref: 'dev-host' }).state, 'CANCELLED');
  assert.equal(rendezvousR().createInvite({ host_device_ref: 'dev-host', at: T0R }).state, 'ACTIVE');
});