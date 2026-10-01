// RS-203 step 4 — provider unavailable and device unavailable kept apart.
//
// The workbook requires the two to be handled separately and requires that a fallback must not
// confuse the reasons. The harm being prevented is concrete: a fallback that reports "provider
// unavailable" for a device outage sends the user to fix the wrong thing.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DOMAIN_OF_REASON, UNAVAILABILITY_DOMAINS, classifyUnavailability, createReturnBridge,
} from '../return-bridge.mjs';
import { EXCLUSION_REASONS } from '../../general-ai-remote-execution-v1/remote-execution.mjs';

const AT = '2026-10-02T00:00:00.000Z';
const mk = () => {
  const b = createReturnBridge({ resolveSurface: () => ({ device_ref: 'device-interaction' }), clock: () => AT });
  b.register({ actionRef: 'action-1', interactionDeviceRef: 'device-interaction', executionDeviceRef: 'device-remote', ownerRef: 'owner-1' });
  return b;
};

test('RS-203 step 4: the flat EXCLUSION_REASONS list is CLASSIFIED, and every reason has an axis', () => {
  const missing = EXCLUSION_REASONS.filter((r) => !DOMAIN_OF_REASON[r]);
  assert.deepEqual(missing, [], `these existing reasons have no domain: ${missing.join(', ')}`);
  for (const [reason, domain] of Object.entries(DOMAIN_OF_REASON)) {
    assert.ok(UNAVAILABILITY_DOMAINS.includes(domain), `${reason} -> ${domain} is not a declared domain`);
  }
});

test('RS-203 step 4: a DEVICE outage is classified as DEVICE and nothing else', () => {
  const c = classifyUnavailability({ reasons: ['OFFLINE'] });
  assert.deepEqual([...c.domains], ['DEVICE']);
  assert.equal(c.mixed, false);
  assert.deepEqual([...c.by_domain.PROVIDER], []);
});

test('RS-203 step 4: a PROVIDER outage is classified as PROVIDER and nothing else', () => {
  const c = classifyUnavailability({ reasons: ['NO_SESSION'] });
  assert.deepEqual([...c.domains], ['PROVIDER']);
  assert.deepEqual([...c.by_domain.DEVICE], []);
});

test('RS-203 step 4: an INPUT problem is NEITHER a device nor a provider fault', () => {
  const c = classifyUnavailability({ reasons: ['INPUT_NOT_LOCAL'] });
  assert.deepEqual([...c.domains], ['INPUT']);
  assert.deepEqual([...c.by_domain.DEVICE], []);
  assert.deepEqual([...c.by_domain.PROVIDER], []);
});

test('RS-203 step 4: an UNKNOWN reason is reported, not silently dropped', () => {
  const c = classifyUnavailability({ reasons: ['SOMETHING_NEW'] });
  assert.deepEqual([...c.unclassified], ['SOMETHING_NEW']);
  assert.equal(c.any, true, 'an unclassified cause is still a cause and must not read as "nothing wrong"');
});

test('RS-203 step 4: a DEVICE fallback does NOT implicate the provider', () => {
  const b = mk();
  const plan = b.planFallback({ actionRef: 'action-1', reasons: ['OFFLINE'] });
  assert.equal(plan.cause, 'DEVICE');
  assert.equal(plan.action, 'QUEUE_FOR_DEVICE');
  assert.match(String(plan.detail), /provider is not implicated/);
  assert.equal(plan.mixed_cause, false);
});

test('RS-203 step 4: a PROVIDER fallback does NOT implicate the device', () => {
  const b = mk();
  const plan = b.planFallback({ actionRef: 'action-1', reasons: ['OVERLOADED', 'NO_SESSION'] });
  assert.equal(plan.cause, 'PROVIDER');
  assert.equal(plan.action, 'PROVIDER_FALLBACK');
  assert.match(String(plan.detail), /device is not implicated/);
});

test('RS-203 step 4: an eligible alternate is offered for a DEVICE outage, but the cause is still named', () => {
  const b = mk();
  const plan = b.planFallback({ actionRef: 'action-1', reasons: ['OFFLINE'], alternates: ['device-b'] });
  assert.equal(plan.action, 'ALTERNATE_DEVICE');
  assert.equal(plan.cause, 'DEVICE', 'choosing an alternate must not erase WHY it was needed');
});

test('RS-203 step 4: MIXED causes are NOT collapsed to one, and no single cause is claimed', () => {
  const b = mk();
  const plan = b.planFallback({ actionRef: 'action-1', reasons: ['OFFLINE', 'NO_SESSION'] });
  assert.equal(plan.mixed_cause, true);
  assert.equal(plan.cause, null, 'there is no single cause, so none may be named');
  assert.deepEqual([...plan.causes].sort(), ['DEVICE', 'PROVIDER']);
  assert.match(String(plan.detail), /no single cause is claimed/);
});

test('RS-203 step 4: the reason codes SURVIVE into the plan rather than being paraphrased away', () => {
  const b = mk();
  const plan = b.planFallback({ actionRef: 'action-1', reasons: ['STALE_ENDPOINT'] });
  assert.deepEqual([...plan.classified.by_domain.DEVICE], ['STALE_ENDPOINT']);
  assert.equal(plan.preserves_cause, true);
});

test('RS-203 step 4: with nothing unavailable the plan claims no cause at all', () => {
  const b = mk();
  const plan = b.planFallback({ actionRef: 'action-1', reasons: [] });
  assert.equal(plan.action, 'NONE');
  assert.equal(plan.cause, null);
  assert.equal(plan.classified.any, false);
});

test('RS-203 step 4: planning against an unknown correlation is refused', () => {
  const b = mk();
  assert.throws(() => b.planFallback({ actionRef: 'nope', reasons: ['OFFLINE'] }), (e) => e.code === 'UNKNOWN_CORRELATION');
});
