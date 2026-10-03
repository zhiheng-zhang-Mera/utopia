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
// THE SCORE IS THREE PARTS, each bounded 0..1, then weighted:
//   NETWORK   - how good the path to that City is FROM HERE. loopback > LAN > anything else, minus a latency penalty.
//   CAPACITY  - how much spare machine there is: cores, free memory, free disk, and how idle the CPU is.
//   ROLE      - tie-breakers that reflect the product rather than raw power: a City that ALREADY has other
//               devices attached is the better carrier (joining it costs nobody a re-join), and a City this
//               machine has joined before is preferred over a stranger for the same reason.

/** Default weights. Exported so a caller (and a test) can see and change the balance rather than guess it. */
export const DEFAULT_WEIGHTS = Object.freeze({ network: 0.45, capacity: 0.4, role: 0.15 });

/** Path quality by how the City was reached. Loopback is this machine; LAN is the intended case.
 *  `unknown` is the FLOOR, below Bluetooth, on purpose: "we do not know how we would reach it" must never score
 *  above a path we actually measured, or an unidentifiable candidate would outrank a real nearby one. */
const PATH_QUALITY = Object.freeze({ loopback: 1, lan: 0.8, bluetooth: 0.35, unknown: 0.2 });

const clamp01 = value => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null);

/**
 * How good the path to a candidate is, from this client.
 * `rttMs` is optional: when it is missing the path is scored on kind alone and `measured` says so.
 */
export function scoreNetwork({ transport = 'unknown', host = null, rttMs = null } = {}) {
  const isLoopback = typeof host === 'string' && /^(127\.0\.0\.1|localhost|::1)$/i.test(host);
  const kind = isLoopback ? 'loopback' : (PATH_QUALITY[transport] === undefined ? 'unknown' : transport);
  const base = PATH_QUALITY[kind];
  // Latency only ever REMOVES score, and only from a measured value: 0ms is full marks, 150ms+ is the floor.
  const latencyPenalty = Number.isFinite(rttMs) ? Math.min(0.5, Math.max(0, rttMs) / 300) : 0;
  return Object.freeze({
    kind,
    score: clamp01(base - latencyPenalty),
    measured: Number.isFinite(rttMs),
    loopback: kind === 'loopback',
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
    const role = scoreRole(candidate);
    // An unmeasured capacity is NOT averaged in as a zero: the score falls back to the parts that were measured,
    // and `capacityKnown` travels with the row so a surface can say which recommendation is thinly evidenced.
    const usable = capacity.known ? weights.capacity : 0;
    const totalWeight = weights.network + usable + weights.role;
    const total = totalWeight === 0 ? 0 : (network.score * weights.network + (capacity.score ?? 0) * usable + role.score * weights.role) / totalWeight;
    return Object.freeze({
      cityRef: candidate.cityRef ?? candidate.cityId ?? null,
      displayName: candidate.displayName ?? null,
      host: candidate.host ?? null,
      port: candidate.port ?? null,
      score: clamp01(total),
      network,
      capacity,
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
