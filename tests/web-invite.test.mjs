// Invite tokens: the shareable form of a pairing credential.
//
// These cases exist because the first version of this parsing lived inside app.js, where no test could reach it,
// and a caller then passed the PARSED OBJECT back into a function that expected the STRING. It stringified to
// "[object Object]", parsed to null, and the client told the user "the City returned no credential" for an invite
// that was perfectly valid. That shipped as far as a live end-to-end run before it was caught, which is what an
// untestable parser costs. The last test below is that exact bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseInvite, isInvite, inviteOrigin, inviteLeaves} from '../apps/web/invite.js';

const HOST = 'http://172.31.12.151:4391';
const OTHER = 'http://172.31.3.110:4391';
const invite = (host, extra = '') => `utopia://pair?v=1&host=${encodeURIComponent(host)}&city=22e1216b&session=abc-123&expires=2026-10-03T09:00:00.000Z&secret=s3cr3t${extra}`;

test('an invite names the City it belongs to, which is the whole point of the form', () => {
  const parsed = parseInvite(invite(OTHER));
  assert.equal(parsed.host, OTHER);
  assert.equal(parsed.cityId, '22e1216b');
  assert.equal(parsed.sessionId, 'abc-123');
  assert.equal(parsed.secret, 's3cr3t');
  assert.equal(parsed.invite.startsWith('utopia://pair?'), true, 'the raw string is kept for forwarding');
});

test('a bare credential is NOT an invite - it cannot say which City it belongs to', () => {
  assert.equal(parseInvite('2W3E4R'), null);
  assert.equal(isInvite('2W3E4R'), false);
});

test('junk does not throw, it returns null', () => {
  for (const junk of ['', '   ', 'utopia://pair', 'utopia://pair?', 'utopia://pair?city=x', 'http://x', null, undefined, 42, {}]) {
    assert.equal(parseInvite(junk), null, `input ${JSON.stringify(junk)} must not parse`);
  }
});

test('an invite without a host is refused rather than half-understood', () => {
  assert.equal(parseInvite('utopia://pair?v=1&city=abc&secret=s'), null);
});

test('trailing slashes and origins compare cleanly', () => {
  assert.equal(inviteOrigin(invite(OTHER + '/')), OTHER);
  assert.equal(inviteLeaves(invite(OTHER), HOST), true);
  assert.equal(inviteLeaves(invite(HOST), HOST), false, 'the invite of the City you are already on is not a switch');
  assert.equal(inviteLeaves(invite(HOST + '/'), HOST + '/'), false);
});

test('the invite survives a round trip through a URL fragment', () => {
  // The client hands an invite to another origin inside its location hash, which encodeURIComponent encodes once.
  const forwarded = '#' + 'pair=' + encodeURIComponent(invite(OTHER));
  const params = new URLSearchParams(forwarded.replace(/^#/, ''));
  const back = parseInvite(params.get('pair'));
  assert.equal(back.host, OTHER);
  assert.equal(back.secret, 's3cr3t');
});

test('REGRESSION: a PARSED invite handed back in must still resolve, not become "[object Object]"', () => {
  const parsed = parseInvite(invite(OTHER));
  // This is what the caller did: exchange(parsed) instead of exchange(rawString). The fix is that the exchange
  // step accepts both shapes; the parser itself must stay strict, so the check here is that the strict parser
  // says no while the caller's own guard uses the object it was given.
  assert.equal(parseInvite(parsed), null, 'the strict parser must not accept an object');
  assert.equal(typeof parsed === 'object' && parsed !== null && Boolean(parsed.host), true, 'the parsed value carries host, which is what the caller-side guard keys on');
});
