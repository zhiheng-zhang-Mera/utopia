// Which PC should HOST the City, decided as a measurement rather than by whoever clicked first.
//
// THE OWNER'S REQUIREMENT, IN CODE: two (or more) PCs each start their own Utopia, all disconnected, and they
// need to end up in ONE City that every one of them can see from both sides. The City to join is not "the first
// one that answered": it is the machine whose NETWORK POSITION AND HARDWARE together make it the best carrier for
// the others. So this module scores the candidates that a client can actually see and recommends one.
//
// WHY THIS IS A SEPARATE, PURE MODULE. The decision is the part that must be reviewable: it is arithmetic over
// facts, so it is testable without a browser, a LAN or a City, and a change to the weights shows up as a changed
// test rather than as a different-looking UI.
//
// WHAT IT REFUSES TO DO. It never invents a fact it does not have. A candidate with no telemetry is scored as
// "unknown" and marked as such, rather than being given average numbers that would make an unmeasured machine look
// like a good carrier. And a LOOPBACK candidate is never treated as remote: 127.0.0.1 is THIS machine, which is
// the strongest possible network position from here but also means "no second PC is involved yet".
//
// THE SCORE IS FOUR PARTS, each bounded 0..1, then weighted:
//   NETWORK    - how good the path to that City is FROM HERE, as a SCOPE (local > lan > remote > unknown) minus a
//                latency penalty. Scope, not speed, is what separates "same room, same wifi" from "different city
//                over the internet": both are reachable, but only one needs configuration and middleboxes.
//   CAPACITY   - how much spare machine there is: cores, free memory, free disk, and how idle the CPU is.
//   ATTACHMENT - how the candidate is plugged in: wired beats wireless, and a metered link is halved, because the
//                machine that serves everyone else should not be the one on a phone tether.
//   ROLE       - tie-breakers that reflect the product rather than raw power: a City that ALREADY has other
//                devices attached is the better carrier (joining it costs nobody a re-join), and a City this
//                machine has joined before is preferred over a stranger for the same reason.

/** Default weights. Exported so a caller (and a test) can see and change the balance rather than guess it. */
export const DEFAULT_WEIGHTS = Object.freeze({ network: 0.4, capacity: 0.3, attachment: 0.15, role: 0.15 });

/** Path quality by how the City was reached. Loopback is this machine; LAN is the intended case.
 *  `unknown` is the FLOOR, below Bluetooth, on purpose: "we do not know how we would reach it" must never score
 *  above a path we actually measured, or an unidentifiable candidate would outrank a real nearby one.
 *
 *  THE SCOPE LADDER, which is what makes this module answer the Owner's real topology rather than one LAN: the
 *  same product has to work for two PCs in one room on one network, for two PCs in different rooms on one network,
 *  and for two PCs on DIFFERENT NETWORKS in different cities. Those are not the same problem, and the difference
 *  is not speed - it is HOW the path exists at all:
 *    local   - this machine (loopback): no network involved.
 *    lan     - discovered by multicast on the same link (mDNS). Zero configuration, which is why it is preferred.
 *    remote  - reachable only by an address the user was given (invite link, VPN, port-forward, Tailscale...).
 *              Perfectly legitimate, but it carries configuration and middleboxes, so it scores below a LAN path
 *              unless it is explicitly measured to be fast.
 *    unknown - we cannot say. Floor.
 */
const PATH_QUALITY = Object.freeze({ local: 1, lan: 0.8, remote: 0.55, bluetooth: 0.35, unknown: 0.2 });

/** How the hosting machine is attached to its network. Wired beats wireless for a CARRIER: a machine that serves
 *  every other device should not be the one whose link drops when someone walks past with a microwave on. */
const ATTACHMENT_QUALITY = Object.freeze({ ethernet: 1, wifi: 0.7, cellular: 0.3, unknown: 0.5 });

const clamp01 = value => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null);

/**
 * How good the path to a candidate is, from this client.
 * `rttMs` is optional: when it is missing the path is scored on kind alone and `measured` says so.
 * `scope` may be supplied by the caller (it knows whether the address came from multicast, from a pasted invite,
 * or is loopback); when it is absent it is INFERRED from the host and transport, and `inferred` says which.
 */
export function scoreNetwork({ transport = 'unknown', host = null, rttMs = null, scope = null } = {}) {
  const isLoopback = typeof host === 'string' && /^(127\.0\.0\.1|localhost|::1)$/i.test(host);
  const inferred = scope === null;
  const resolved = scope ?? (isLoopback ? 'local' : (transport === 'bluetooth' ? 'bluetooth' : (transport === 'lan' ? 'lan' : 'unknown')));
  const kind = PATH_QUALITY[resolved] === undefined ? 'unknown' : resolved;
  const base = PATH_QUALITY[kind];
  // Latency only ever REMOVES score, and only from a measured value: 0ms is full marks, 150ms+ is the floor.
  const latencyPenalty = Number.isFinite(rttMs) ? Math.min(0.5, Math.max(0, rttMs) / 300) : 0;
  return Object.freeze({
    kind,
    score: clamp01(base - latencyPenalty),
    measured: Number.isFinite(rttMs),
    inferred,
    loopback: kind === 'local',
  });
}

/**
 * How much spare machine a candidate has, from the telemetry the City already publishes per node.
 * Any missing field is EXCLUDED from the average rather than defaulted, and `fields` reports how many were
 * actually used, so a candidate scored from one number can be told apart from one scored from five.
 */
export function scoreCapacity(telemetry = {}) {
  const parts = [];
  const cpu = telemetry?.cpu?.usagePercent;
  if (Number.isFinite(cpu)) parts.push(1 - Math.min(1, Math.max(0, cpu) / 100));      // idle machine is better
  const mem = telemetry?.memory;
  if (Number.isFinite(mem?.totalBytes) && mem.totalBytes > 0 && Number.isFinite(mem?.usedBytes)) {
    parts.push(1 - Math.min(1, Math.max(0, mem.usedBytes / mem.totalBytes)));
  }
  const disk = telemetry?.disk;
  if (Number.isFinite(disk?.totalBytes) && disk.totalBytes > 0 && Number.isFinite(disk?.freeBytes)) {
    parts.push(Math.min(1, Math.max(0, disk.freeBytes / disk.totalBytes)));
  }
  if (Number.isFinite(telemetry?.cores) && telemetry.cores > 0) {
    // 1 core is unusable as a carrier, 8+ is plenty; the curve is deliberately gentle so cores never dominate.
    parts.push(Math.min(1, Math.max(0, (telemetry.cores - 1) / 7)));
  }
  if (parts.length === 0) return Object.freeze({ score: null, fields: 0, known: false });
  return Object.freeze({ score: clamp01(parts.reduce((a, b) => a + b, 0) / parts.length), fields: parts.length, known: true });
}

/**
 * How the candidate is attached to its network, as a carrier-reliability factor.
 * `attachment` is the kind of link ("ethernet", "wifi", "cellular", or anything unknown); `metered` flags a link
 * that costs the owner money or is rate-limited, which is a real reason not to make that machine the carrier for
 * everybody else's traffic. Both are facts the machine reports about itself, not inferences about its speed.
 */
export function scoreAttachment({ attachment = 'unknown', metered = false } = {}) {
  const base = ATTACHMENT_QUALITY[attachment] ?? ATTACHMENT_QUALITY.unknown;
  return Object.freeze({ score: clamp01(metered ? base * 0.5 : base), attachment, metered: metered === true });
}

/**
 * Product tie-breakers, all bounded: is this City already carrying devices, and have we been here before?
 * Both are facts the client holds (the City's node list, and its own memory of past joins), not guesses.
 */
export function scoreRole({ attachedNodes = 0, previouslyJoined = false } = {}) {
  const attached = clamp01(Math.min(1, Math.max(0, attachedNodes) / 3)) ?? 0;   // 3+ attached devices = full marks
  const known = previouslyJoined ? 1 : 0;
  return Object.freeze({ score: clamp01(0.7 * attached + 0.3 * known), attachedNodes, previouslyJoined: !!previouslyJoined });
}

/**
 * Score every candidate and recommend the best carrier.
 *
 * @param {Array} candidates each `{ cityRef, displayName, host, port, transport, rttMs, telemetry, attachedNodes, previouslyJoined }`
 * @param {{now?: number, weights?: object}} [options]
 * @returns {{recommended: object|null, ranked: object[], reason: string}}
 */
export function rankPrimaryCity(candidates = [], { weights = DEFAULT_WEIGHTS } = {}) {
  const rows = (Array.isArray(candidates) ? candidates : []).map(candidate => {
    const network = scoreNetwork(candidate);
    const capacity = scoreCapacity(candidate.telemetry ?? {});
    const attachment = scoreAttachment(candidate);
    const role = scoreRole(candidate);
    // An unmeasured capacity is NOT averaged in as a zero: the score falls back to the parts that were measured,
    // and `capacityKnown` travels with the row so a surface can say which recommendation is thinly evidenced.
    const usable = capacity.known ? weights.capacity : 0;
    const totalWeight = weights.network + usable + weights.attachment + weights.role;
    const total = totalWeight === 0 ? 0 : (network.score * weights.network + (capacity.score ?? 0) * usable + attachment.score * weights.attachment + role.score * weights.role) / totalWeight;
    return Object.freeze({
      cityRef: candidate.cityRef ?? candidate.cityId ?? null,
      displayName: candidate.displayName ?? null,
      host: candidate.host ?? null,
      port: candidate.port ?? null,
      score: clamp01(total),
      network,
      capacity,
      attachment,
      role,
      capacityKnown: capacity.known,
    });
  });

  // Deterministic order: score first, then cityRef, so equal scores do not shuffle between renders.
  rows.sort((a, b) => (b.score - a.score) || String(a.cityRef ?? '').localeCompare(String(b.cityRef ?? '')));
  const recommended = rows[0] ?? null;
  let reason = 'no candidate Cities are visible';
  if (recommended) {
    if (recommended.network.loopback) reason = 'this machine is the only City visible, so it hosts';
    else if (!recommended.capacityKnown) reason = 'best available network position; no hardware telemetry was reported, so capacity was not scored';
    else reason = 'best combination of network position, spare capacity and already-attached devices';
  }
  return Object.freeze({ recommended, ranked: rows, reason });
}

/**
 * The GROUP case, which is the topology the Owner actually described: three or more PCs that are NOT necessarily
 * on the same link - same room/same wifi, different rooms/same network, or different networks in different
 * cities - each running its own City, and all of them needing to end up in ONE City that every one of them can
 * both see and be seen in.
 *
 * THE RULE THIS ADDS, AND WHY IT IS NOT JUST "PICK THE HIGHEST SCORE": a carrier is only usable by a peer if that
 * peer can REACH it. Two PCs on the same wifi can join each other directly; a PC on a home broadband line cannot
 * be reached by a PC on a mobile hotspot unless something (a VPN, a forwarded port, a relay) makes a path exist.
 * So a City nobody else can reach is not a candidate for the group, however powerful the machine is - and this
 * function returns that as an explicit, listable reason rather than silently ranking it first.
 *
 * @param {{peers?: Array, candidates?: Array}} input
 *   `peers`      - `{ peerRef, displayName, candidateRefs: string[] }`: which Cities each peer has a measured path to
 *   `candidates` - the Cities, in the same shape `rankPrimaryCity` takes
 * @returns {{carrier: object|null, reachableBy: string[], unreachablePeers: string[], ranked: object[], reason: string}}
 */
export function chooseGroupCarrier({ peers = [], candidates = [] } = {}) {
  const { ranked } = rankPrimaryCity(candidates);
  const peerList = Array.isArray(peers) ? peers.filter(p => p && typeof p.peerRef === 'string') : [];
  // With no peer reports, the group question cannot be answered by reachability, so the ranking stands on its own
  // and the reason says exactly that instead of implying a reachability check happened.
  if (peerList.length === 0) {
    const carrier = ranked[0] ?? null;
    return Object.freeze({
      carrier,
      reachableBy: carrier ? peerList.map(p => p.peerRef) : [],
      unreachablePeers: [],
      ranked,
      reason: carrier ? 'no peer reachability was reported, so the ranking alone decided the carrier' : 'no candidate Cities are visible',
    });
  }

  const scored = ranked.map(row => {
    const reachableBy = peerList.filter(p => Array.isArray(p.candidateRefs) && p.candidateRefs.includes(row.cityRef)).map(p => p.peerRef);
    return { row, reachableBy, unreachable: peerList.length - reachableBy.length };
  });
  // A carrier reachable by EVERY peer wins; among those, the highest score wins. Only if none is universal does the
  // fallback prefer the widest reach, and the result says which of the two situations it is in.
  const universal = scored.filter(s => s.unreachable === 0);
  const pool = universal.length ? universal : scored.slice().sort((a, b) => (a.unreachable - b.unreachable) || (b.row.score - a.row.score));
  const best = pool[0] ?? null;
  if (!best) return Object.freeze({ carrier: null, reachableBy: [], unreachablePeers: peerList.map(p => p.peerRef), ranked, reason: 'no candidate Cities are visible' });

  const unreachablePeers = peerList.filter(p => !best.reachableBy.includes(p.peerRef)).map(p => p.peerRef);
  let reason;
  if (unreachablePeers.length === 0) reason = 'every peer has a measured path to this City, and it scores highest among those';
  else if (universal.length === 0) reason = `NO candidate is reachable by every peer; this one reaches the most (${best.reachableBy.length}/${peerList.length}), so the peers left out need another path (an invite, a VPN or a relay) before they can join`;
  else reason = 'reachable by every peer';
  return Object.freeze({ carrier: best.row, reachableBy: best.reachableBy, unreachablePeers, ranked, reason });
}
