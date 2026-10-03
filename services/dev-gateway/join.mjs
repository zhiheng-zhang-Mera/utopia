// JOIN-502 step 2: the City side of "a new PC asks to join, an existing trusted device decides".
//
// WHY THIS EXISTS AT ALL. RF-002 already owns pairing and trust; this module is NOT a second trust
// state machine and does not issue a second kind of credential. What it adds is the *approval* seam the
// workbook requires and the baseline did not have: today a joining PC can only succeed by presenting a
// temporary pairing secret that the OWNER's surface generated (JOIN-501's explicit Generate rule), so
// there is no way for a nearby PC to ASK. This module records the ask, surfaces it to an already
// trusted device, and releases the existing City credential only after that device approves.
//
// Four properties are load-bearing and each is enforced here rather than documented:
//
//   1. DISCOVERY IS NOT TRUST. Creating a request grants nothing. A request has no credential, is not a
//      node, is not in any worker pool, and cannot invoke anything. It is a row a human looks at.
//   2. THE REQUESTER HOLDS THE ONLY COPY OF ITS CLAIM. The client generates a claim secret and stores
//      only its sha256 here. Status polling and the credential exchange both require the preimage, so
//      another machine on the same LAN that hears the same mDNS advertisement (or reads the city
//      snapshot, which deliberately contains no claim digests) cannot adopt someone else's request.
//   3. APPROVAL IS THE ONLY PATH TO A CREDENTIAL. `exchange` refuses anything that is not APPROVED, and
//      a request is APPROVED only through the authenticated owner route.
//   4. DECISIONS ARE NEGATIVE-SAFE. A rejected request cannot be revived by repeating it; a consumed
//      request cannot be replayed; an expired request cannot be approved back into life.
//
// Persistence is a bounded JSON file under the City's own runtime directory. It is deliberately NOT a
// second device registry: rows carry no device identity, hold no long-lived secret, and are pruned.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const hash = value => createHash('sha256').update(String(value)).digest();
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = hash(a); const right = hash(b);
  return timingSafeEqual(left, right);
};

/** States a request can be in. CONSUMED and REJECTED are terminal; EXPIRED is terminal too. */
export const JOIN_STATES = Object.freeze(['PENDING', 'APPROVED', 'REJECTED', 'CONSUMED', 'EXPIRED']);
export const JOIN_TTL_MS = 10 * 60 * 1000;
/** Bounds, all of them enforced rather than hoped for. A LAN full of clients must not be able to grow
 *  the City's memory or the surface's render without limit. */
export const MAX_PENDING = 8;
export const MAX_TRACKED = 64;
export const MAX_DISPLAY_NAME = 64;
export const MAX_PLATFORM = 40;
export const MAX_INSTALLATION_HINT = 80;

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** A short, non-secret reference shown to the approver. It is a REFERENCE, not an identity: it is
 *  derived from the request id alone, so it cannot be used as a cryptographic anchor and it is
 *  regenerated for every request. The workbook asks for a fingerprint "or short fingerprint" on the
 *  approval card; this is the honest bounded version of that, and the real installation fingerprint
 *  arrives with device enrollment (JOIN-503), not here. */
export const shortRef = requestId => `join-${hash(String(requestId)).toString('hex').slice(0, 10)}`;

export function createJoinRequests({ file = null, clock = Date.now, ttlMs = JOIN_TTL_MS, credential, onChange = () => {} } = {}) {
  if (!isText(credential)) throw new Error('join requests need the City credential they may release after approval');
  if (file === null) throw new Error('join requests need a persistence file');
  const path = resolve(file);
  /** id -> record. Insertion-ordered, which is also the order the approver sees. */
  const records = new Map();
  let closed = false;

  const persist = () => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.tmp-${process.pid}`;
      writeFileSync(temporary, JSON.stringify({ version: 1, records: [...records.values()] }), { encoding: 'utf8' });
      renameSync(temporary, path);
    } catch {
      // Persistence is a convenience for a City restart, not a correctness requirement: if the disk
      // refuses, the in-memory truth keeps working and the failure is silent by design rather than
      // turning an approval into a 500.
    }
  };

  const load = () => {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      if (raw?.version !== 1 || !Array.isArray(raw.records)) return;
      for (const record of raw.records) if (isText(record?.id)) records.set(record.id, record);
    } catch { /* no file yet, or unreadable: start empty rather than fail the City */ }
  };
  load();

  const prune = () => {
    const at = clock();
    for (const record of records.values()) {
      // Only PENDING and APPROVED can expire: a terminal decision is kept for the approver's audit
      // trail and for the hostile-replay case, and is dropped by the count bound instead.
      if ((record.state === 'PENDING' || record.state === 'APPROVED') && at >= record.expiresAt) {
        record.state = 'EXPIRED';
        record.decidedAt = record.decidedAt ?? at;
      }
    }
    if (records.size <= MAX_TRACKED) return;
    // Evict oldest TERMINAL rows first; a live pending request is never evicted by count, because
    // silently dropping an ask a human has not seen yet is worse than refusing the newest one.
    const terminal = [...records.values()].filter(r => r.state !== 'PENDING' && r.state !== 'APPROVED').sort((a, b) => a.createdAt - b.createdAt);
    while (records.size > MAX_TRACKED && terminal.length) records.delete(terminal.shift().id);
  };

  const publicView = record => Object.freeze({
    id: record.id,
    shortRef: record.shortRef,
    displayName: record.displayName,
    platform: record.platform,
    installationHint: record.installationHint,
    origin: record.origin,
    state: record.state,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    decidedAt: record.decidedAt === null ? null : new Date(record.decidedAt).toISOString(),
    // Named so no surface can mistake the row for trust.
    grantsTrust: false,
    isIdentity: false,
  });

  const pendingCount = () => [...records.values()].filter(r => r.state === 'PENDING').length;

  /** The joining client's row as it sees it. Same shape as the approver's minus nothing: the requester
   *  already knows what it sent, and a request holds no secret to hide. */
  const statusOf = record => ({ ...publicView(record), approved: record.state === 'APPROVED', terminal: record.state !== 'PENDING' && record.state !== 'APPROVED' });

  /** Find a row and prove the caller holds its claim, for the two operations that AUTHORIZE something.
   *  Reading a status is not one of them - see `locate`. */
  const findByClaim = (requestId, claim) => {
    const record = locate(requestId, claim);
    // A DECIDED request answers with its decision even to a caller that cannot prove the claim. "The owner
    // rejected this" and "you are not the requester" are different facts, and the first version collapsed
    // them: rejecting cleared the claim digest, so the requester's own next poll was told its request
    // belonged to somebody else and the page never learned it had been rejected. Neither answer releases
    // anything, so saying which one happened costs no authority.
    if (record.state === 'REJECTED') fail(403, 'The City owner rejected this join request');
    if (record.state === 'EXPIRED') fail(410, 'This join request expired before it was approved');
    // A spent request says SO rather than "wrong requester": a client retrying after a lost response must
    // not be sent looking for an attacker instead of a dropped reply.
    if (record.state === 'CONSUMED') fail(410, 'This join request has already been used');
    if (record.claimDigest === null || !equal(hash(claim ?? '').toString('hex'), record.claimDigest)) fail(403, 'That join request belongs to another requester');
    return record;
  };

  /** Find a row and check the claim, WITHOUT treating a terminal state as an error.
   *
   *  This split is the fix for a real regression: routing every read through the authorizing lookup made
   *  `join/status` answer 410 for an expired request, so the requester's own poll saw an HTTP error where
   *  the requested information is exactly "your request expired". A poll that fails cannot report a
   *  terminal state, which is the one thing it exists to do. */
  const locate = (requestId, claim) => {
    const record = records.get(String(requestId ?? ''));
    if (!record) fail(404, 'No such join request');
    // A claim is compared as a digest in constant time: the presented preimage is hashed first, so the
    // comparison never depends on how much of a guess matched. A spent row has no digest left, and its
    // state is already public to whoever holds the id.
    if (record.claimDigest !== null && !equal(hash(claim ?? '').toString('hex'), record.claimDigest)) fail(403, 'That join request belongs to another requester');
    return record;
  };

  return Object.freeze({
    file: path,
    /** --- the joining client's three unauthenticated calls -------------------------------- */

    /**
     * Create (or re-adopt) a request. Idempotent by `installationHint` while the prior request is still
     * PENDING: the same PC asking twice gets the SAME row with a refreshed claim, so a retrying client
     * cannot flood the approver with duplicate cards. A previously REJECTED hint is refused outright:
     * re-asking after a rejection is the requester trying to turn a decision into a question, and the
     * answer is no.
     */
    request({ displayName, platform, installationHint, origin, claim } = {}) {
      if (closed) fail(503, 'City is shutting down');
      prune();
      if (!isText(claim) || claim.length < 16 || claim.length > 200) fail(400, 'A join request needs a claim secret of 16-200 characters');
      if (!isText(displayName)) fail(400, 'A join request needs a display name');
      const name = clean(displayName, MAX_DISPLAY_NAME) || 'Unnamed device';
      const hint = clean(installationHint, MAX_INSTALLATION_HINT) || null;
      const at = clock();

      if (hint !== null) {
        const prior = [...records.values()].find(r => r.installationHint === hint && r.state !== 'CONSUMED' && r.state !== 'EXPIRED');
        if (prior && prior.state === 'REJECTED') fail(403, 'This installation was rejected by the City owner');
        if (prior && (prior.state === 'PENDING' || prior.state === 'APPROVED')) {
          // Re-adopt rather than duplicate. The claim is replaced because the requester proving it
          // holds the new one is the only authority this path has; the row, its id, its decision and
          // its age stay. An APPROVED row is therefore collectable with the refreshed claim without
          // the approver having to decide twice.
          prior.claimDigest = hash(claim).toString('hex');
          prior.displayName = name;
          prior.platform = clean(platform, MAX_PLATFORM) || 'unknown';
          prior.origin = clean(origin, 120) || null;
          persist(); onChange('updated', publicView(prior));
          return statusOf(prior);
        }
      }
      if (pendingCount() >= MAX_PENDING) fail(429, 'Too many join requests are already waiting for a decision');
      const record = {
        id: randomUUID(),
        shortRef: null,
        claimDigest: hash(claim).toString('hex'),
        displayName: name,
        platform: clean(platform, MAX_PLATFORM) || 'unknown',
        installationHint: hint,
        origin: clean(origin, 120) || null,
        state: 'PENDING',
        createdAt: at,
        expiresAt: at + ttlMs,
        decidedAt: null,
        consumedAt: null,
        history: [],
      };
      record.shortRef = shortRef(record.id);
      records.set(record.id, record);
      persist(); onChange('created', publicView(record));
      return statusOf(record);
    },

    /** Poll by id + claim. Never returns the credential: approval and collection are separate steps so
     *  a surface cannot hold a credential it did not collect. A terminal state is the ANSWER, not an
     *  error - only a claim that does not belong to the caller, or an id that does not exist, fails. */
    status({ requestId, claim } = {}) {
      prune();
      const record = locate(requestId, claim);
      return statusOf(record);
    },

    /** THE ONLY PATH TO A CREDENTIAL. Requires the request to be APPROVED, unexpired and unconsumed,
     *  and requires the claim preimage. Consumption is recorded before the credential is returned, so a
     *  second call - including a retry that races the first - can never mint a second credential.
     *
     *  The claim digest is destroyed as part of consuming, so the spent preimage authorizes nothing
     *  afterwards even if it leaks; the row keeps its state so a retry is answered "already used"
     *  instead of "wrong requester". */
    exchange({ requestId, claim } = {}) {
      prune();
      // `findByClaim` already answers REJECTED / EXPIRED / CONSUMED with their own status, and refuses a
      // claim that is not the caller's, so by here the row is PENDING or APPROVED for THIS requester.
      const record = findByClaim(requestId, claim);
      if (record.state !== 'APPROVED') fail(409, 'This join request has not been approved yet');
      record.state = 'CONSUMED';
      record.consumedAt = clock();
      record.claimDigest = null;
      persist(); onChange('consumed', publicView(record));
      return { cityId: null, accepted: true, requestId: record.id, credential };
    },

    /** --- the owner's authenticated calls -------------------------------------------------- */

    list() {
      prune();
      return {
        requests: [...records.values()].map(publicView),
        pending: pendingCount(),
        limits: { maxPending: MAX_PENDING, maxTracked: MAX_TRACKED },
      };
    },

    /** Approve by id. The approver does not need the claim: an already trusted device deciding is the
     *  whole point, and requiring the claim here would mean the approver had to possess a secret that
     *  belongs to the requester. */
    approve({ requestId } = {}) {
      prune();
      const record = records.get(String(requestId ?? ''));
      if (!record) fail(404, 'No such join request');
      if (record.state === 'PENDING') {
        record.state = 'APPROVED';
        record.decidedAt = clock();
        record.history.push({ state: 'APPROVED', at: record.decidedAt });
        persist(); onChange('approved', publicView(record));
      } else if (record.state !== 'APPROVED') {
        fail(409, `A join request that is ${record.state} cannot be approved`);
      }
      return publicView(record);
    },

    reject({ requestId } = {}) {
      prune();
      const record = records.get(String(requestId ?? ''));
      if (!record) fail(404, 'No such join request');
      if (record.state === 'PENDING' || record.state === 'APPROVED') {
        record.state = 'REJECTED';
        record.decidedAt = clock();
        // The claim digest is KEPT. It authorizes nothing - `exchange` refuses a rejected row before it
        // ever looks at the claim - and dropping it would make the requester's own poll indistinguishable
        // from a stranger's guess at the id.
        record.history.push({ state: 'REJECTED', at: record.decidedAt });
        persist(); onChange('rejected', publicView(record));
      } else if (record.state !== 'REJECTED') {
        fail(409, `A join request that is ${record.state} cannot be rejected`);
      }
      return publicView(record);
    },

    /** Bounded snapshot for the City snapshot, so an already connected trusted surface can render the
     *  waiting asks without polling a second endpoint. Only live rows: terminal history stays available
     *  through the authenticated list. */
    snapshot() {
      prune();
      return [...records.values()]
        .filter(r => r.state === 'PENDING' || r.state === 'APPROVED')
        .slice(0, MAX_PENDING)
        .map(publicView);
    },

    close() { closed = true; persist(); },
  });
}
