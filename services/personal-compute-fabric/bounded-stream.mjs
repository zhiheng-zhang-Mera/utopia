// PCF-703 (stream half): openBoundedStream - a real bounded, credit-controlled, cancellable, resumable stream.
//
// The workbook asks for four things that a naive stream gets wrong, so each is enforced here rather than documented:
//
//   1. BYTES AND ITEMS ARE BOTH BOUNDED, and a producer that exceeds either is REFUSED (BACKPRESSURE) instead of being
//      silently buffered. A consumer that stops reading therefore cannot make the sender's memory grow without limit.
//   2. BACKPRESSURE IS END-TO-END: the sender only writes while the RECEIVER has granted credit for it. Credit is
//      per-chunk, so a slow consumer throttles the producer rather than the intermediate hop absorbing the difference.
//   3. CANCELLATION IS TERMINAL and idempotent: after cancel, a write is refused with CANCELLED rather than accepted
//      into a stream nobody will drain, and cancelling twice is not an error.
//   4. RECONNECT CARRIES THE GAP FORWARD. A resume reports how much was lost so a consumer sees missing bytes instead
//      of a stream that silently skipped them, and partial output is FLAGGED rather than presented as complete.
import {requireThat as ok, text, finite, freeze} from './validation.mjs';

export const STREAM_REFUSALS = Object.freeze({
  BACKPRESSURE: 'STREAM_BACKPRESSURE',
  CANCELLED: 'STREAM_CANCELLED',
  CLOSED: 'STREAM_CLOSED',
  DIGEST_MISMATCH: 'STREAM_DIGEST_MISMATCH',
  NO_CREDIT: 'STREAM_NO_CREDIT',
  RESUME_BEYOND_END: 'STREAM_RESUME_BEYOND_END',
  GAP_UNRECONCILED: 'STREAM_GAP_UNRECONCILED',
});
export const STREAM_LIMITS = Object.freeze({maxBytes: 64 * 1024 * 1024, maxItems: 100000, maxChunkBytes: 4 * 1024 * 1024});

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const ref = value => text(value) && value.length <= 256;

/**
 * Open a bounded stream.
 *
 * `transport` is injected and must supply `send(chunk, context)` and optionally `close()`. Nothing here reaches the
 * network itself, so this module is testable without one - and a transport that is absent is reported as unavailable
 * rather than replaced by a silent local fallback, because "offload quietly became local" is the failure the workbook
 * forbids.
 */
export function openBoundedStream({plan = null, transport, maxBytes = STREAM_LIMITS.maxBytes, maxItems = STREAM_LIMITS.maxItems} = {}) {
  ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= STREAM_LIMITS.maxBytes, 'STREAM_BYTES_BOUND');
  ok(Number.isSafeInteger(maxItems) && maxItems > 0 && maxItems <= STREAM_LIMITS.maxItems, 'STREAM_ITEMS_BOUND');
  if (transport !== undefined && transport !== null) ok(typeof transport.send === 'function', 'STREAM_TRANSPORT_INVALID');

  let bytes = 0, items = 0, creditBytes = 0, creditItems = 0, cancelled = false, closed = false;
  const inFlight = new Map();
  const gaps = [];
  let partialOutputVisible = false;

  const assertLive = () => { ok(!cancelled, STREAM_REFUSALS.CANCELLED); ok(!closed, STREAM_REFUSALS.CLOSED); };

  return freeze({
    /** Grant the receiver's credit. Only the receiver calls this, so the producer can never grant itself room. */
    grantCredit({bytes: grantBytes = 0, items: grantItems = 0} = {}) {
      assertLive();
      ok(Number.isSafeInteger(grantBytes) && grantBytes >= 0 && Number.isSafeInteger(grantItems) && grantItems >= 0, 'STREAM_CREDIT_INVALID');
      creditBytes += grantBytes; creditItems += grantItems;
      return freeze({creditBytes, creditItems});
    },

    /**
     * Write one chunk. It is refused when the TOTAL bound would be exceeded, when credit is insufficient, or after
     * cancellation - each with its own code, so a producer can tell "too much data" from "consumer is slow".
     */
    async write(chunkId, bytesInChunk) {
      assertLive();
      ok(ref(chunkId), 'STREAM_CHUNK_ID_REQUIRED');
      ok(Number.isSafeInteger(bytesInChunk) && bytesInChunk > 0 && bytesInChunk <= STREAM_LIMITS.maxChunkBytes, 'STREAM_CHUNK_SIZE');
      ok(!inFlight.has(chunkId), 'STREAM_DUPLICATE_CHUNK');
      // The BOUND is checked before credit: exceeding the total is a refusal regardless of how much credit exists.
      ok(bytes + bytesInChunk <= maxBytes, STREAM_REFUSALS.BACKPRESSURE + ':bytes ' + (bytes + bytesInChunk) + '>' + maxBytes);
      ok(items + 1 <= maxItems, STREAM_REFUSALS.BACKPRESSURE + ':items ' + (items + 1) + '>' + maxItems);
      ok(bytesInChunk <= creditBytes && creditItems >= 1, STREAM_REFUSALS.NO_CREDIT + ': need ' + bytesInChunk + 'B/1 item, have ' + creditBytes + 'B/' + creditItems);
      if (transport === undefined || transport === null) return freeze({sent: false, reason: 'TRANSPORT_UNAVAILABLE', detail: 'no transport was injected; nothing was written and no local fallback was substituted'});
      creditBytes -= bytesInChunk; creditItems -= 1;
      inFlight.set(chunkId, bytesInChunk);
      await transport.send({chunkId, bytes: bytesInChunk});
      bytes += bytesInChunk; items += 1;
      return freeze({sent: true, reason: null, detail: null, bytes, items});
    },

    /** Acknowledge a chunk, releasing it from the in-flight set. An unknown chunk is refused rather than ignored. */
    ack(chunkId) {
      ok(inFlight.has(chunkId), 'STREAM_UNKNOWN_CHUNK');
      inFlight.delete(chunkId);
      return freeze({bytes, items, inFlight: inFlight.size});
    },

    /** Record a LOSS. The gap is carried so a resume reports it instead of skipping silently. */
    recordGap({fromByte, toByte}) {
      ok(Number.isSafeInteger(fromByte) && Number.isSafeInteger(toByte) && toByte >= fromByte, 'STREAM_GAP_INVALID');
      gaps.push(freeze({fromByte, toByte, bytes: toByte - fromByte}));
      partialOutputVisible = true;
      return freeze({gaps: [...gaps]});
    },

    /**
     * Resume at a byte offset. The offset must be within what was written (resuming past the end is a refusal, because
     * it would mean trusting a consumer's claim about bytes that were never sent), and any outstanding gap is reported
     * with what was lost.
     */
    resume({fromByte}) {
      assertLive();
      ok(Number.isSafeInteger(fromByte) && fromByte >= 0, 'STREAM_RESUME_OFFSET');
      ok(fromByte <= bytes, STREAM_REFUSALS.RESUME_BEYOND_END + ':' + fromByte + '>' + bytes);
      const lost = gaps.reduce((sum, gap) => sum + gap.bytes, 0);
      return freeze({resumedAt: fromByte, remaining: bytes - fromByte, gaps: [...gaps], lostBytes: lost,
        gapKnown: gaps.length > 0, partialOutputVisible,
        // A resume with an unreconciled gap is usable but NOT complete, and it says so rather than pretending otherwise.
        completeness: gaps.length ? 'PARTIAL_WITH_KNOWN_GAP' : 'COMPLETE_FROM_OFFSET'});
    },

    /** Reconcile a gap once it has been re-sent. Only then is the stream no longer partial. */
    reconcileGap(index) {
      ok(Number.isInteger(index) && index >= 0 && index < gaps.length, 'STREAM_GAP_UNKNOWN');
      const removed = gaps.splice(index, 1)[0];
      if (gaps.length === 0) partialOutputVisible = false;
      return freeze({reconciled: true, gap: removed, gaps: [...gaps]});
    },

    /** Cancellation is terminal and idempotent. */
    cancel() {
      cancelled = true;
      inFlight.clear();
      creditBytes = 0; creditItems = 0;
      return freeze({cancelled: true});
    },
    close() { closed = true; return freeze({closed: true}); },

    stats: () => freeze({bytes, items, inFlight: inFlight.size, creditBytes, creditItems, cancelled, closed, gaps: [...gaps], partialOutputVisible}),
    partialOutputVisible: () => partialOutputVisible,
  });
}

/**
 * The offload decision. The workbook requires that an unprofitable or unauthorised offload becomes a TYPED REFUSAL or
 * the already-approved local path - never a silent change of destination.
 *
 * `localAvailable` is deliberately NOT defaulted: the approved local path has to be declared by the caller, and a call
 * that does not declare one gets REFUSED rather than a LOCAL answer it cannot honour.
 */
export function chooseTransport({authorised, transportCostMinor, transferBytes, linkStable, localAvailable} = {}) {
  ok(typeof authorised === 'boolean', 'OFFLOAD_DECISION_INPUT');
  ok(localAvailable === undefined || typeof localAvailable === 'boolean', 'OFFLOAD_DECISION_INPUT');
  // The LOCAL path is the ALREADY-APPROVED one or it is nothing: availability is declared by the caller and never
  // assumed, because answering "LOCAL" for a path nobody approved is the same silent change of destination the
  // workbook forbids, only in the other direction. Undeclared therefore settles as REFUSED.
  const settled = (reason, detail) => freeze({choice: localAvailable === true ? 'LOCAL' : 'REFUSED',
    reason, detail, permitsOffload: false, localDeclared: localAvailable === true});
  if (!authorised) return settled('NOT_AUTHORISED', 'offload was never authorised for this workload');
  if (linkStable !== true) return settled('LINK_UNSTABLE', 'the link is not stable enough to move data');
  // This project authorizes NO spend, so any transport cost at all is refused rather than weighed.
  if (finite(transportCostMinor) && transportCostMinor > 0) return settled('TRANSFER_COST', 'transport cost is not authorised');
  if (finite(transferBytes) && transferBytes > STREAM_LIMITS.maxBytes) return settled('TRANSFER_TOO_LARGE', 'the payload exceeds the bounded stream');
  return freeze({choice: 'OFFLOAD', reason: null, detail: null, permitsOffload: true, localDeclared: localAvailable === true});
}
