// PCF-703 acceptance (stream half): openBoundedStream and the offload decision.
//
// Each of the four properties the workbook names is checked from the refusing side, because a stream that only ever
// behaves is not evidence: exceeding a bound, writing without credit, writing after cancellation, and resuming past the
// end all have to fail, and a lost chunk has to stay visible.
import test from 'node:test';
import assert from 'node:assert/strict';
import {STREAM_REFUSALS, STREAM_LIMITS, openBoundedStream, chooseTransport} from '../services/personal-compute-fabric/bounded-stream.mjs';

const transportSpy = () => {
  const sent = [];
  return {sent, send: async chunk => { sent.push(chunk); }};
};

test('PCF703-01 a chunk is written only when the receiver granted credit for it', async () => {
  const transport = transportSpy();
  const stream = openBoundedStream({transport, maxBytes: 1000, maxItems: 10});
  // No credit yet: the producer is refused BY NAME rather than buffered.
  await assert.rejects(() => stream.write('c1', 100), /STREAM_NO_CREDIT/);
  assert.equal(transport.sent.length, 0);
  stream.grantCredit({bytes: 250, items: 3});
  await stream.write('c1', 100);
  await stream.write('c2', 150);
  assert.equal(transport.sent.length, 2);
  // The credit is consumed exactly, so a third write needs more credit even though the total bound allows it.
  await assert.rejects(() => stream.write('c3', 10), /STREAM_NO_CREDIT/);
  assert.deepEqual(stream.stats().creditBytes, 0);
  // A second grant ADDS room rather than replacing the credit, which is what makes a slow receiver able to top the
  // sender up one window at a time; the item credit left over from the first grant is still counted.
  assert.deepEqual(stream.grantCredit({bytes: 1000, items: 10}), {creditBytes: 1000, creditItems: 11});
  await stream.write('c3', 10);
  assert.deepEqual(stream.stats(), {bytes: 260, items: 3, inFlight: 3, creditBytes: 990, creditItems: 10, cancelled: false, closed: false, gaps: [], partialOutputVisible: false});
});

test('PCF703-02 the TOTAL bytes and items bounds are refused even when credit exists', async () => {
  const transport = transportSpy();
  const stream = openBoundedStream({transport, maxBytes: 200, maxItems: 2});
  stream.grantCredit({bytes: 10000, items: 100});
  await stream.write('c1', 120);
  // Credit is plentiful; the byte BOUND is what refuses this, and the code says so.
  await assert.rejects(() => stream.write('c2', 120), /STREAM_BACKPRESSURE:bytes 240>200/);
  await stream.write('c2', 80);
  // The byte budget is now exhausted, so a further chunk is refused for BYTES (the bound checked first).
  await assert.rejects(() => stream.write('c3', 1), /STREAM_BACKPRESSURE:bytes 201>200/);
  assert.equal(transport.sent.length, 2);
  // A separate stream isolates the ITEM bound, with bytes to spare.
  const byItems = openBoundedStream({transport: transportSpy(), maxBytes: 1000, maxItems: 2});
  byItems.grantCredit({bytes: 1000, items: 100});
  await byItems.write('c1', 1);
  await byItems.write('c2', 1);
  await assert.rejects(() => byItems.write('c3', 1), /STREAM_BACKPRESSURE:items 3>2/);
  assert.equal(byItems.stats().items, 2, 'the item bound held');
});

test('PCF703-03 cancellation is terminal and idempotent, and a write after it is refused', async () => {
  const transport = transportSpy();
  const stream = openBoundedStream({transport, maxBytes: 1000, maxItems: 10});
  stream.grantCredit({bytes: 1000, items: 10});
  await stream.write('c1', 10);
  stream.cancel();
  assert.equal(stream.cancel().cancelled, true, 'cancelling twice is not an error');
  await assert.rejects(() => stream.write('c2', 10), /STREAM_CANCELLED/);
  assert.equal(stream.stats().bytes, 10, 'nothing was accepted after cancellation');
  // Closing is a different terminal state with its own code.
  const other = openBoundedStream({transport, maxBytes: 1000, maxItems: 10});
  other.close();
  await assert.rejects(() => other.write('c1', 10), /STREAM_CLOSED/);
});

test('PCF703-04 a transport that is absent is reported as unavailable and NO local fallback is substituted', async () => {
  const stream = openBoundedStream({maxBytes: 1000, maxItems: 10});
  stream.grantCredit({bytes: 1000, items: 10});
  const outcome = await stream.write('c1', 10);
  assert.equal(outcome.sent, false);
  assert.equal(outcome.reason, 'TRANSPORT_UNAVAILABLE');
  assert.match(outcome.detail, /no local fallback was substituted/);
  assert.equal(stream.stats().bytes, 0, 'an unavailable transport wrote nothing');
  assert.throws(() => openBoundedStream({transport: {}, maxBytes: 10, maxItems: 1}), /STREAM_TRANSPORT_INVALID/);
});

test('PCF703-05 a lost chunk stays visible: the resume reports the gap and marks the stream PARTIAL', async () => {
  const stream = openBoundedStream({transport: transportSpy(), maxBytes: 1000, maxItems: 10});
  stream.grantCredit({bytes: 1000, items: 10});
  await stream.write('c1', 100);
  await stream.write('c2', 100);
  // Chunk c2 is lost in transit.
  stream.recordGap({fromByte: 100, toByte: 200});
  assert.equal(stream.partialOutputVisible(), true, 'partial output is FLAGGED, never presented as complete');
  const resumed = stream.resume({fromByte: 100});
  assert.equal(resumed.lostBytes, 100);
  assert.equal(resumed.gapKnown, true);
  assert.equal(resumed.completeness, 'PARTIAL_WITH_KNOWN_GAP');
  assert.deepEqual(resumed.gaps, [{fromByte: 100, toByte: 200, bytes: 100}]);
  // Once the gap is re-sent and reconciled the stream stops being partial.
  stream.reconcileGap(0);
  const clean = stream.resume({fromByte: 100});
  assert.equal(clean.gapKnown, false);
  assert.equal(clean.completeness, 'COMPLETE_FROM_OFFSET');
  assert.equal(stream.partialOutputVisible(), false);
  assert.equal(stream.resume({fromByte: 100}).remaining, 100, 'the remaining bytes are computed from what was written');
});

test('PCF703-06 resuming past the end, an unknown ack and a bad gap are each refused', async () => {
  const stream = openBoundedStream({transport: transportSpy(), maxBytes: 1000, maxItems: 10});
  stream.grantCredit({bytes: 1000, items: 10});
  await stream.write('c1', 50);
  // A consumer claiming more bytes than were ever sent must not be trusted.
  assert.throws(() => stream.resume({fromByte: 500}), /STREAM_RESUME_BEYOND_END:500>50/);
  assert.throws(() => stream.ack('never-written'), /STREAM_UNKNOWN_CHUNK/);
  assert.throws(() => stream.recordGap({fromByte: 10, toByte: 5}), /STREAM_GAP_INVALID/);
  assert.throws(() => stream.reconcileGap(3), /STREAM_GAP_UNKNOWN/);
  // An acknowledged chunk leaves the in-flight set.
  assert.equal(stream.ack('c1').inFlight, 0);
  // A duplicate chunk id is refused rather than silently overwriting an in-flight chunk.
  stream.grantCredit({bytes: 1000, items: 10});
  await stream.write('c2', 10);
  await assert.rejects(() => stream.write('c2', 10), /STREAM_DUPLICATE_CHUNK/);
});

test('PCF703-07 the bounds themselves are validated, and a chunk cannot exceed the per-chunk ceiling', async () => {
  assert.throws(() => openBoundedStream({maxBytes: 0, maxItems: 1}), /STREAM_BYTES_BOUND/);
  assert.throws(() => openBoundedStream({maxBytes: STREAM_LIMITS.maxBytes + 1, maxItems: 1}), /STREAM_BYTES_BOUND/);
  assert.throws(() => openBoundedStream({maxBytes: 10, maxItems: 0}), /STREAM_ITEMS_BOUND/);
  const stream = openBoundedStream({transport: transportSpy(), maxBytes: STREAM_LIMITS.maxBytes, maxItems: 10});
  stream.grantCredit({bytes: STREAM_LIMITS.maxBytes, items: 10});
  await assert.rejects(() => stream.write('c1', STREAM_LIMITS.maxChunkBytes + 1), /STREAM_CHUNK_SIZE/);
});

test('PCF703-08 an unauthorised, unstable, costly or oversized offload becomes a typed refusal or the approved local path', () => {
  // The approved local path is DECLARED, never assumed: with it declared, each refusal reason still runs locally.
  assert.equal(chooseTransport({authorised: false, localAvailable: true}).choice, 'LOCAL');
  assert.equal(chooseTransport({authorised: false, localAvailable: true}).reason, 'NOT_AUTHORISED');
  assert.equal(chooseTransport({authorised: true, linkStable: false, localAvailable: true}).reason, 'LINK_UNSTABLE');
  // This project authorizes no spend, so ANY cost refuses the offload rather than being weighed against benefit.
  assert.equal(chooseTransport({authorised: true, linkStable: true, transportCostMinor: 1, localAvailable: true}).reason, 'TRANSFER_COST');
  assert.equal(chooseTransport({authorised: true, linkStable: true, transferBytes: STREAM_LIMITS.maxBytes + 1, localAvailable: true}).reason, 'TRANSFER_TOO_LARGE');
  // With no approved local execution the answer is a refusal, never a silent change of destination.
  assert.equal(chooseTransport({authorised: false, localAvailable: false}).choice, 'REFUSED');
  assert.equal(chooseTransport({authorised: true, linkStable: false, localAvailable: false}).choice, 'REFUSED');
  assert.equal(chooseTransport({authorised: true, linkStable: true, transportCostMinor: 5, localAvailable: false}).choice, 'REFUSED');
  // ...and the same holds when the LOCAL path is the one that cannot be used.
  assert.equal(chooseTransport({authorised: true, linkStable: true, transferBytes: STREAM_LIMITS.maxBytes + 1, localAvailable: false}).choice, 'REFUSED');
  // The fallback has to be declared by the caller, so an UNDECLARED local path is refused rather than promised.
  assert.equal(chooseTransport({authorised: false}).choice, 'REFUSED');
  assert.equal(chooseTransport({authorised: false}).localDeclared, false);
  // The only case that permits moving data, and it needs no local fallback to exist.
  const offload = chooseTransport({authorised: true, linkStable: true, transportCostMinor: 0, transferBytes: 1024});
  assert.equal(offload.choice, 'OFFLOAD');
  assert.equal(offload.permitsOffload, true);
  assert.throws(() => chooseTransport({authorised: 'yes'}), /OFFLOAD_DECISION_INPUT/);
  assert.throws(() => chooseTransport({authorised: true, localAvailable: 'yes'}), /OFFLOAD_DECISION_INPUT/);
});
