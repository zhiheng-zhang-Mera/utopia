// RS-203 step 5 — provenance binding for a remote result, and a presentation summary that cannot
// leak it.
//
// The workbook asks for the result to be bound to its provenance/evidence while the presentation
// layer receives only "stable summary fields". Those pull in opposite directions, so the tests below
// check BOTH halves: that the binding really happens and is immutable, and that the summary's key set
// is EXACTLY the declared set - which is what makes stability structural rather than a convention.
import test from 'node:test';
import assert from 'node:assert/strict';

import { SUMMARY_FIELDS, createReturnBridge } from '../return-bridge.mjs';

const AT = '2026-10-02T00:00:00.000Z';
const mk = () => {
  const b = createReturnBridge({ resolveSurface: () => ({ device_ref: 'device-interaction' }), clock: () => AT });
  b.register({ actionRef: 'action-1', interactionDeviceRef: 'device-interaction', executionDeviceRef: 'device-remote', ownerRef: 'owner-1' });
  return b;
};

test('RS-203 step 5: a remote result is bound to its provenance, including WHICH device produced it', () => {
  const b = mk();
  const bound = b.bindProvenance({ actionRef: 'action-1', resultRef: 'result-9', evidenceRef: 'evidence-3', digest: 'sha256:abc' });
  assert.equal(bound.result_ref, 'result-9');
  assert.equal(bound.evidence_ref, 'evidence-3');
  assert.equal(bound.digest, 'sha256:abc');
  assert.equal(bound.execution_device_ref, 'device-remote', 'the binding records the producing device, not just the evidence');
  assert.equal(bound.produced_by, 'device-remote');
});

test('RS-203 step 5: the provenance is IMMUTABLE once bound, so a result cannot be re-attributed', () => {
  const b = mk();
  b.bindProvenance({ actionRef: 'action-1', resultRef: 'result-9' });
  assert.throws(
    () => b.bindProvenance({ actionRef: 'action-1', resultRef: 'result-OTHER' }),
    (e) => e.code === 'DUPLICATE_CORRELATION',
  );
  assert.equal(b.provenance('action-1').result_ref, 'result-9');
});

test('RS-203 step 5: the summary key set is EXACTLY the declared set - stability by construction', () => {
  const b = mk();
  const s = b.summary({ actionRef: 'action-1' });
  assert.deepEqual(Object.keys(s).sort(), [...SUMMARY_FIELDS].sort(),
    'a summary field added without declaring it would fail here rather than reach the user');
});

test('RS-203 step 5: the summary NEVER carries the evidence, the digests or the routing identifiers', () => {
  const b = mk();
  b.apply({ actionRef: 'action-1', sequence: 1, kind: 'FINAL' });
  b.bindProvenance({ actionRef: 'action-1', resultRef: 'result-9', evidenceRef: 'evidence-3', digest: 'sha256:abc' });
  const s = b.summary({ actionRef: 'action-1' });
  const leaked = ['digest', 'evidence_ref', 'result_ref', 'execution_device_ref', 'interaction_device_ref', 'last_sequence']
    .filter((k) => k in s);
  assert.deepEqual(leaked, [], `the summary leaked: ${leaked.join(', ')}`);
  // and nothing in the VALUES carries them either
  const values = JSON.stringify(s);
  for (const needle of ['sha256:abc', 'evidence-3', 'result-9', 'device-remote']) {
    assert.ok(!values.includes(needle), `the summary leaked ${needle} through a value`);
  }
});

test('RS-203 step 5: whether evidence EXISTS is presentable, without saying what it is', () => {
  const b = mk();
  assert.equal(b.summary({ actionRef: 'action-1' }).has_provenance, false);
  b.bindProvenance({ actionRef: 'action-1', resultRef: 'result-9', digest: 'sha256:abc' });
  const s = b.summary({ actionRef: 'action-1' });
  assert.equal(s.has_provenance, true);
  assert.ok(!('digest' in s));
});

test('RS-203 step 5: the summary is STABLE across state changes - same shape, always', () => {
  const b = mk();
  const before = Object.keys(b.summary({ actionRef: 'action-1' })).sort();
  b.apply({ actionRef: 'action-1', sequence: 1, kind: 'PROGRESS' });
  b.markDisconnected({ actionRef: 'action-1' });
  b.bindProvenance({ actionRef: 'action-1', resultRef: 'r' });
  b.apply({ actionRef: 'action-1', sequence: 2, kind: 'FINAL' });
  const after = Object.keys(b.summary({ actionRef: 'action-1' })).sort();
  assert.deepEqual(after, before, 'the presentation shape must not change as the run advances');
});

test('RS-203 step 5: the summary still tells the truth about a degraded and a finished run', () => {
  const b = mk();
  b.apply({ actionRef: 'action-1', sequence: 1, kind: 'PROGRESS' });
  const degraded = b.summary({ actionRef: 'action-1' });
  assert.equal(degraded.state, 'RUNNING');
  assert.equal(degraded.remote_state, 'ONLINE');
  b.apply({ actionRef: 'action-1', sequence: 2, kind: 'FINAL' });
  assert.equal(b.summary({ actionRef: 'action-1' }).state, 'SUCCEEDED');
});

test('RS-203 step 5: binding against an unknown correlation is refused', () => {
  const b = mk();
  assert.throws(() => b.bindProvenance({ actionRef: 'nope', resultRef: 'r' }), (e) => e.code === 'UNKNOWN_CORRELATION');
  assert.throws(() => b.summary({ actionRef: 'nope' }), (e) => e.code === 'UNKNOWN_CORRELATION');
  assert.throws(() => b.bindProvenance({ actionRef: 'action-1' }), (e) => e.code === 'INVALID_REQUEST');
});

test('RS-203 step 5: the declared field list is frozen, so it cannot be widened at runtime', () => {
  assert.ok(Object.isFrozen(SUMMARY_FIELDS));
  assert.throws(() => { SUMMARY_FIELDS.push('digest'); }, TypeError);
});
