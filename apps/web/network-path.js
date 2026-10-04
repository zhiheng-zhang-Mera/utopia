// How two PCs on DIFFERENT networks can actually reach each other: choose the path, and be honest about the ones
// that need somebody else's infrastructure.
//
// THE PROBLEM, STATED WITHOUT SOFTENING IT. Two PCs on one LAN find each other by multicast and connect directly.
// Two PCs on different networks - different rooms on different broadband lines, or different cities - have NO path
// between them unless something creates one, because both are almost always behind NAT and neither can accept an
// inbound connection. The connection surface can only REPORT a reachable path; it cannot conjure one. So the honest
// design is: enumerate the ways a path can exist, choose the best one that needs NOTHING from the user, and tell
// the truth about the ones that need a decision only the Owner can make.
//
// THE OPTIONS, AND WHY THE ORDER IS WHAT IT IS:
//
//   1. DIRECT / SAME LAN      multicast discovery, both on one link. Needs nothing. This is the common case and it
//                             is why it is first: an "optimisation" that makes the common case worse is not one.
//   2. OUTBOUND-DIAL RELAY    NO third party, NO account, NO router change. A relay is run by one of the two Cities
//      (in-City, ours)       (the reachable one, or one the user nominates). The OTHER PC - the one behind NAT that
//                             cannot be dialled - opens an OUTBOUND connection to it, which every NAT permits, and
//                             the join handshake then travels over that connection. This is the ONLY option that
//                             needs nothing from outside this project, which is why it is the default answer for
//                             "different networks".
//   3. OVERLAY NETWORK        Tailscale / WireGuard and friends. Excellent, encrypted, works through NAT, but it
//      (Tailscale/WireGuard)  needs an ACCOUNT and an install on every machine, and it makes a third party part of
//                             the City's reachability. That is an Owner decision (credentials, privacy, cost) and
//                             this module refuses to assume it.
//   4. INBOUND FORWARD        A router port-forward (or UPnP) plus a hostname. No third party, but it is a manual
//      (port-forward + DNS)   per-router action, it exposes a port to the internet, and it needs the user to know
//                             their router. Acceptable as a fallback, never as the default.
//   5. PUBLIC RELAY           Somebody else's server. Cheapest to build, worst to trust: the City's traffic would
//      (third party)          pass through a machine we do not own. Listed so it is a considered refusal rather
//                             than an omission.
//   6. NONE                   No path exists yet. The honest answer, and the one the surface must be able to say
//                             without dressing it up as "connecting…".
//
// WHAT THIS MODULE DOES NOT DO: it does not dial, relay, or tunnel. It decides WHICH mechanism applies to a pair of
// peers from facts the client already holds, returns the action that would establish it (as data), and names the
// Owner decision when the only remaining options need one.
//
// S1/S2 UPDATE, so this header does not keep saying something that is no longer true: the transport for option 2
// NOW EXISTS. `apps/web/relay-dial.mjs` dials the City's relay endpoint and `services/dev-gateway/server.mjs` accepts
// it, so `{kind:'dial-outbound'}` is executable rather than aspirational - which is why `choosePath` now carries the
// relay TARGET (`relayHost` / `relayPort` / `relayCityRef`) instead of only the word "relay". The remaining options
// (overlay, port-forward, public relay) are still decisions and still reported as decisions; this module still
// dials nothing itself.

/** The mechanisms, worst-to-best is intentional: this list is used as a preference ORDER by `choosePath`. */
export const PATHS = Object.freeze([
  'direct',            // same LAN, multicast discovery
  'relay-in-city',     // outbound dial to a relay one of the Cities runs: no third party, no account, no router
  'overlay',           // Tailscale/WireGuard: works, but needs an account and an install everywhere
  'inbound-forward',   // port-forward + DNS: no third party, manual per router, exposes a port
  'public-relay',      // somebody else's server: cheapest, least trustworthy
  'none',
]);

/** Which Owner authority each mechanism needs, so a surface can say WHY it is asking rather than just asking. */
export const OWNER_AUTHORITY = Object.freeze({
  'overlay': 'accounts-and-credentials',
  'inbound-forward': 'network-exposure-and-router-change',
  'public-relay': 'third-party-trust',
});

const isLoopbackAddress = a => typeof a === 'string' && /^(127\.0\.0\.1|localhost|::1)$/i.test(a);
const sameLan = (a, b) => {
  // BOTH must be addresses, and the loopback case is handled FIRST and separately. The first draft of this had an
  // `&&` that short-circuited whenever the two addresses differed in kind, after which the /24 comparison ran on
  // values it was never meant to see - and every candidate came back "same network", including 100.64.x and a
  // loopback peer. That is the failure mode to avoid here: a reachability heuristic that is always true makes the
  // whole decision module a rubber stamp.
  if (!isLoopbackAddress(a) && !isLoopbackAddress(b)) {
    const left = String(a ?? '').split('.').slice(0, 3).join('.');
    const right = String(b ?? '').split('.').slice(0, 3).join('.');
    // Three IPv4 octets must each be non-empty, or two unknowns would "match" as ''.
    if (left.split('.').filter(Boolean).length !== 3 || right.split('.').filter(Boolean).length !== 3) return false;
    return left === right;
  }
  return isLoopbackAddress(a) && isLoopbackAddress(b);
};

/**
 * Choose the connection mechanism for a peer.
 *
 * @param {object} input
 *   `selfAddress`  - this client's address as it sees itself (may be loopback)
 *   `peerAddress`  - the peer's address, if one is known
 *   `transport`    - how the peer was reached: lan | bluetooth | remote | unknown
 *   `relayAvailable` - is there a City we can dial OUTBOUND to that will forward for us (our own, or the peer's)?
 *   `relayHost` / `relayPort` / `relayCityRef` - WHICH City to dial. `relayAvailable` without a host is reported as
 *                      available but without an address, because a mechanism the user cannot act on must not be
 *                      dressed up as a working path.
 *   `overlayPresent` - has the user already installed/joined an overlay network on BOTH sides?
 *   `inboundForwarded` - does the peer accept inbound connections on a forwarded port?
 * @returns {{path: string, action: object|null, ownerDecision: object|null, reason: string}}
 */
export function choosePath({ selfAddress = null, peerAddress = null, transport = 'unknown', relayAvailable = false, relayHost = null, relayPort = null, relayCityRef = null, overlayPresent = false, inboundForwarded = false } = {}) {
  const addressable = typeof peerAddress === 'string' && peerAddress.length > 0;

  // Loopback FIRST: a peer that IS this machine needs no heuristic at all, and checking it after the /24 test made
  // the answer depend on which address happened to be passed.
  if (isLoopbackAddress(peerAddress)) {
    return freeze('direct', { kind: 'connect', to: peerAddress }, null, 'the peer is this machine');
  }
  // Then the same-link heuristic, and it REQUIRES both addresses. The first draft wrote
  // `sameLan(selfAddress ?? peerAddress, peerAddress)`, which - whenever this client did not know its own address -
  // compared the peer with ITSELF and therefore reported "same network" for every candidate on the internet. A
  // reachability test that is trivially true is worse than no test, because everything downstream believes it.
  if (addressable && typeof selfAddress === 'string' && sameLan(selfAddress, peerAddress)) {
    return freeze('direct', { kind: 'connect', to: peerAddress }, null, 'the peer is on this network, so they connect directly');
  }
  if (transport === 'bluetooth') {
    return freeze('direct', { kind: 'connect', to: peerAddress }, null, 'Bluetooth discovery already put them in reach; it is a bootstrap, not a bulk transport');
  }

  // 2. The option that needs nothing from outside this project: an outbound dial.
  if (relayAvailable) {
    // The TARGET travels with the decision. "Dial out to a relay" is not actionable on its own - the surface has to
    // know WHICH City to open the socket to - so the host is part of the action and its absence is visible rather
    // than silently absent (`relayHost: null` means the caller knows a relay exists and not where it is).
    return freeze('relay-in-city', {
      kind: 'dial-outbound',
      via: 'relay',
      to: peerAddress,
      relayHost: typeof relayHost === 'string' && relayHost.length > 0 ? relayHost : null,
      relayPort: Number.isFinite(relayPort) ? relayPort : null,
      relayCityRef: typeof relayCityRef === 'string' && relayCityRef.length > 0 ? relayCityRef : null,
    }, null,
      'the peer cannot be dialled, but it can dial OUT to a relay one of these Cities runs - every NAT allows that, and it needs no account and no router change');
  }

  // 3. An overlay the user has ALREADY set up on both sides is better than asking them to set one up.
  if (overlayPresent) {
    return freeze('overlay', { kind: 'connect', to: peerAddress }, null, 'an overlay network is already present on both machines, so the peer has an address that works');
  }

  // 4. A forwarded port works and costs a manual router action; offered with its cost stated.
  if (inboundForwarded && addressable) {
    return freeze('inbound-forward', { kind: 'connect', to: peerAddress }, {
      authority: OWNER_AUTHORITY['inbound-forward'],
      question: 'the peer accepts inbound connections, but that port is exposed to the internet - accept that exposure?',
    }, 'the peer has a forwarded port, so it can be dialled directly, at the cost of a publicly reachable port');
  }

  // 5. Everything that remains needs the Owner, and saying so is the honest outcome rather than a spinner.
  return freeze('none', null, {
    authority: OWNER_AUTHORITY['overlay'],
    question: 'these two PCs are on different networks and neither can be dialled: choose how a path should exist - run the in-City outbound relay, set up an overlay network (Tailscale/WireGuard), or accept a port-forward?',
  }, 'no path exists between these PCs yet, and every way to create one is an Owner decision about accounts, exposure or third-party trust');
}

function freeze(path, action, ownerDecision, reason) {
  return Object.freeze({ path, action: action ? Object.freeze(action) : null, ownerDecision: ownerDecision ? Object.freeze(ownerDecision) : null, reason });
}

/**
 * Decide for a whole group at once: what each peer needs, and whether one mechanism can serve all of them.
 *
 * The group matters because the Owner's requirement is that several PCs end up in ONE City: if one peer needs the
 * relay and another is on the same LAN, the City has to be reachable BOTH ways, and a single answer for the group
 * would be wrong for at least one of them.
 */
export function planGroupPaths({ selfAddress = null, peers = [], relayAvailable = false, relayTarget = null, overlayPresent = false } = {}) {
  const list = (Array.isArray(peers) ? peers : []).filter(p => p && typeof p === 'object');
  const perPeer = list.map(peer => Object.freeze({
    peerRef: peer.peerRef ?? null,
    displayName: peer.displayName ?? null,
    ...choosePath({
      selfAddress,
      peerAddress: peer.address ?? null,
      transport: peer.transport ?? 'unknown',
      relayAvailable,
      // A peer that published its own relay address is preferred over the group default: the whole point of the
      // carrier decision is that the HARDEST peer must be reachable, and the carrier it named is the one it can reach.
      relayHost: peer.relayHost ?? relayTarget?.host ?? null,
      relayPort: peer.relayPort ?? relayTarget?.port ?? null,
      relayCityRef: peer.relayCityRef ?? peer.cityRef ?? relayTarget?.cityRef ?? null,
      overlayPresent,
      inboundForwarded: peer.inboundForwarded === true,
    }),
  }));
  const needsOwner = perPeer.filter(p => p.ownerDecision !== null);
  const mechanisms = [...new Set(perPeer.map(p => p.path))];
  let reason;
  if (list.length === 0) reason = 'no peers to plan for';
  else if (needsOwner.length === 0) reason = 'every peer has a path that needs nothing from the user, so the group can be connected as it stands';
  else if (needsOwner.length < perPeer.length) reason = 'some peers can be reached directly; the rest need a path that only the Owner can authorise, and the surface must not present those as "connecting"';
  else reason = 'no peer can be reached yet, and every option to change that is an Owner decision';
  return Object.freeze({
    perPeer: Object.freeze(perPeer),
    needsOwner: Object.freeze(needsOwner.map(p => p.peerRef)),
    mechanisms: Object.freeze(mechanisms),
    // The single most demanding mechanism is what the group actually requires: a City is only usable as carrier if
    // the HARDEST peer can reach it too. So this picks the mechanism that appears LATEST in the preference list
    // among those in play - "relay-in-city" when one peer is remote and another is on the LAN - and never the
    // easiest, which is the mistake a first draft made and this comment exists to keep from coming back.
    requiredPath: perPeer.length
      ? PATHS.filter(p => mechanisms.includes(p)).pop() ?? 'none'
      : 'none',
    reason,
  });
}
