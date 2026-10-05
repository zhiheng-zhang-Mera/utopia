// CEX-702 · OPPOSITE-HOST REVIEW probes (Mech).
//
// The workbook's Formal Review section names what the reviewer must prove independently:
//
//   choose provider · decline switch -> alternate device · strict target refusal · no alternate available ·
//   stale/offline candidate · duplicate click · handoff result returns to the original surface · Web/Android
//   state agreement
//
// plus the gate that generic CONFIRM is NOT mis-wired, and the mandatory paper point that a difference between the
// presentation contract and the executable route be recorded. Every probe runs against a real createGateway and two
// of them drive a real browser. Verdict and findings: mission-book/reports/CEX-702/REVIEW_REPORT.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createGateway, REQUIRED_TASK_CAPABILITIES } from '../services/dev-gateway/server.mjs';
import { executeTask } from '../agents/reference-node/runner.mjs';
import { FilesystemAdapter } from '../platform/windows/filesystem.mjs';

const V = { 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const auth = t => ({ ...V, Authorization: 'Bearer ' + t });
const telemetry = () => ({ observedAt: new Date().toISOString(), uptimeSeconds: 1, cpu: { usagePercent: 10 }, memory: { usedBytes: 1, totalBytes: 10 }, disk: null });

/** A City with one task RUNNING on node a, node a taken offline, and (optionally) node b available as the alternate. */
async function fixture({ strict = false, alternate = true, sharingOn = true } = {}) {
  const dir = await mkdtemp(resolve('.scratch-cex702-review-'));
  const app = await createGateway({ dir, port: 0, token: 'owner', nodeToken: 'node', heartbeatTimeout: 600000, roomsDisabled: true });
  const req = async (path, body, node = false) => { const r = await fetch(app.url + '/api/v0/' + path, { method: body === undefined ? 'GET' : 'POST', headers: auth(node ? 'node' : 'owner'), body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const register = id => req('node/register', { id, displayName: 'Named ' + id, capabilities: REQUIRED_TASK_CAPABILITIES, telemetry: telemetry() }, true);
  await register('a');
  let task;
  if (strict) { const action = await req('actions', { route: 'CITY_TASK', target: 'city.task', operation: 'WAIT', input: { targetDeviceRef: 'a' }, idempotencyKey: 'review-strict' }); task = app.store.get('tasks', action.body.action.backendRef.taskId); }
  else task = (await req('tasks', { type: 'WAIT' })).body;
  await req('node/claim', { id: 'a' }, true);
  await req('node/report', { id: 'a', taskId: task.id, state: 'RUNNING', progress: 18 }, true);
  app.store.put('nodes', { ...app.store.get('nodes', 'a'), online: false });
  if (alternate) { await register('b'); if (!sharingOn) app.store.put('nodes', { ...app.store.get('nodes', 'b'), sharingEnabled: false }); }
  const entry = async () => (await req('presentation')).body.tasks.find(t => t.taskId === task.id);
  const detail = async () => (await req('tasks/' + task.id)).body;
  const choose = (revision, decision = 'ALTERNATE_DEVICE') => req('tasks/' + task.id + '/switch-declined', decision === undefined ? {} : { decision, expectedUpdatedAt: revision });
  return { app, dir, req, task, entry, detail, choose, register, close: async () => { await app.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('PROBE 1: the choose-provider route is a real executable path, not a presentation term', async () => {
  const f = await fixture();
  try {
    const before = await f.entry();
    assert.equal(before.userChoices.decisionRequired, true, 'the fixture must really be at a switch decision');
    assert.equal(before.userChoices.alternateDevice.allowed, true);
    // A provider the DTO actually offers, taken from the DTO's own provider list rather than assumed.
    const offered = before.dto.providers.filter(p => p.selectable);
    assert.ok(offered.length > 0, 'the DTO must offer at least one selectable provider');
    const ordered = (await f.req('presentation')).body.candidates;
    const chosenRef = ordered[offered[0].index];
    assert.ok(typeof chosenRef === 'string' && chosenRef.length > 0, 'the DTO index must resolve to a real candidate ref');

    const chosen = await f.req('tasks/' + f.task.id + '/provider-choice', { providerRef: chosenRef });
    assert.equal(chosen.status, 200, 'the provider choice must be executable');
    const row = f.app.store.get('tasks', f.task.id);
    assert.equal(row.chosenProviderRef, chosenRef, 'canonical truth must record the choice');
    assert.equal(row.state, 'QUEUED', 'a provider choice re-queues the task for the chosen provider');
    assert.equal(row.assignedNodeId, null);
    assert.equal(f.app.store.events().filter(e => e.type === 'TASK_PROVIDER_CHOSEN').length, 1);
    // And the surface immediately stops offering the switch, because the decision was made.
    assert.equal((await f.entry()).userChoices.decisionRequired, false, 'the choice must close the decision, not leave it open');
  } finally { await f.close(); }
});

test('PROBE 2: declining the switch towards another device is recorded once and consumed by the handoff', async () => {
  const f = await fixture();
  try {
    const before = await f.entry();
    const revision = before.userChoices.alternateDevice.expectedUpdatedAt;
    assert.ok(Number.isFinite(Date.parse(revision)), 'the surface must hand the client a real revision');
    const accepted = await f.choose(revision);
    assert.equal(accepted.status, 200);
    const row = f.app.store.get('tasks', f.task.id);
    assert.equal(row.switchDeclined, true, 'the decision must be recorded in canonical truth');
    assert.equal(row.alternateDeviceDecisionRevision, revision, 'the accepted revision must be recorded so a replay is recognisable');
    assert.equal(row.handoffTargetRef, 'b', 'the decline is the condition RS-202 reaches ALTERNATE_DEVICE on, so a target must exist');
    assert.equal(f.app.store.events().filter(e => e.type === 'TASK_SWITCH_DECLINED').length, 1);
    assert.equal(f.app.store.events().filter(e => e.type === 'TASK_HANDOFF_TRANSFERRED').length, 1);
    // The decision is closed for the surface too.
    assert.equal((await f.entry()).userChoices.decisionRequired, false);
    assert.equal((await f.entry()).userChoices.alternateDevice.reason, 'NO_SWITCH_DECISION');
  } finally { await f.close(); }
});

test('PROBE 3+4: strict-target and no-alternate are refused by NAME and mutate nothing', async () => {
  const strict = await fixture({ strict: true });
  try {
    const entry = await strict.entry();
    assert.equal(entry.userChoices.alternateDevice.allowed, false);
    assert.equal(entry.userChoices.alternateDevice.reason, 'TARGET_DEVICE_BOUND', 'a bound target must not be offered another device');
    // Strict wins even though an alternate node exists, so the refusal is about the binding, not about capacity.
    const attempt = await strict.choose(strict.app.store.get('tasks', strict.task.id).updatedAt);
    assert.equal(attempt.status, 409);
    assert.equal(attempt.body.errorCode ?? attempt.body.error, 'TARGET_DEVICE_BOUND');
    assert.equal(strict.app.store.get('tasks', strict.task.id).switchDeclined, undefined, 'a refusal must not half-apply');
    assert.equal(strict.app.store.get('tasks', strict.task.id).handoffTargetRef, undefined);
    assert.equal(strict.app.store.events().filter(e => e.type === 'TASK_SWITCH_DECLINED').length, 0, 'a refused choice must emit nothing');
  } finally { await strict.close(); }

  const none = await fixture({ alternate: false });
  try {
    const entry = await none.entry();
    assert.equal(entry.userChoices.alternateDevice.allowed, false);
    assert.equal(entry.userChoices.alternateDevice.reason, 'ALTERNATE_NOT_AVAILABLE');
    const attempt = await none.choose(none.app.store.get('tasks', none.task.id).updatedAt);
    assert.equal(attempt.status, 409);
    assert.equal(attempt.body.errorCode ?? attempt.body.error, 'ALTERNATE_NOT_AVAILABLE');
    assert.equal(none.app.store.get('tasks', none.task.id).switchDeclined, undefined);
  } finally { await none.close(); }
});

test('PROBE 5: a stale revision and a withdrawn alternate are both refused against CURRENT City truth', async () => {
  const f = await fixture();
  try {
    const revision = (await f.entry()).userChoices.alternateDevice.expectedUpdatedAt;
    // (a) a revision that is not the task's current one
    const stale = await f.choose('2000-01-01T00:00:00.000Z');
    assert.equal(stale.status, 409);
    assert.equal(stale.body.errorCode ?? stale.body.error, 'CHOICE_STALE', 'an out-of-date surface must be told to refresh');
    assert.equal(f.app.store.get('tasks', f.task.id).switchDeclined, undefined);
    // (b) the alternate goes offline after the surface was rendered - the decision must be refused, not honoured
    f.app.store.put('nodes', { ...f.app.store.get('nodes', 'b'), online: false });
    assert.equal((await f.entry()).userChoices.alternateDevice.allowed, false);
    const offline = await f.choose(revision);
    assert.equal(offline.status, 409);
    assert.equal(offline.body.errorCode ?? offline.body.error, 'ALTERNATE_NOT_AVAILABLE');
    assert.equal(f.app.store.get('tasks', f.task.id).switchDeclined, undefined);
    // (c) the alternate pauses sharing after the surface was rendered
    f.app.store.put('nodes', { ...f.app.store.get('nodes', 'b'), online: true, sharingEnabled: false });
    assert.equal((await f.entry()).userChoices.alternateDevice.allowed, false, 'a paused device must not be offered');
    assert.equal((await f.choose(revision)).status, 409);
  } finally { await f.close(); }
});

test('PROBE 6: a duplicate click is idempotent, and malformed decisions are refused by name', async () => {
  const f = await fixture();
  try {
    const revision = (await f.entry()).userChoices.alternateDevice.expectedUpdatedAt;
    assert.equal((await f.choose(revision)).status, 200);
    const events = () => f.app.store.events().filter(e => e.type === 'TASK_SWITCH_DECLINED').length;
    const handoffs = () => f.app.store.events().filter(e => e.type === 'TASK_HANDOFF_TRANSFERRED').length;
    assert.equal(events(), 1);
    assert.equal(handoffs(), 1);
    // The same click again, with the same revision the client still holds: idempotent, and NOT re-consumed.
    const replay = await f.choose(revision);
    assert.equal(replay.status, 200, 'a repeat of the same accepted decision is not an error');
    assert.equal(events(), 1, 'a duplicate click must not record a second decision');
    assert.equal(handoffs(), 1, 'a duplicate click must not execute the handoff twice');
    // A decision the City does not implement must not be silently treated as the alternative.
    const bogus = await f.req('tasks/' + f.task.id + '/switch-declined', { decision: 'CONFIRM', expectedUpdatedAt: revision });
    assert.equal(bogus.status, 400);
    assert.equal(bogus.body.errorCode ?? bogus.body.error, 'CHOICE_INVALID');
    // An explicit decision without a usable revision is refused rather than applied blind.
    const noRevision = await f.req('tasks/' + f.task.id + '/switch-declined', { decision: 'ALTERNATE_DEVICE' });
    assert.equal(noRevision.status, 400);
    assert.equal(noRevision.body.errorCode ?? noRevision.body.error, 'CHOICE_INVALID');
    assert.equal(events(), 1);
  } finally { await f.close(); }
});

test('PROBE 7: the handoff runs elsewhere and its RESULT returns to the original surface', async () => {
  const f = await fixture();
  try {
    const revision = (await f.entry()).userChoices.alternateDevice.expectedUpdatedAt;
    assert.equal((await f.choose(revision)).status, 200);
    // Node b claims the SAME task and reports a real result: the work moved, the identity did not.
    const claimed = await f.req('node/claim', { id: 'b' }, true);
    assert.equal(claimed.body.task?.id, f.task.id, 'the alternate device must receive the same task, not a copy');
    await executeTask(claimed.body.task, new FilesystemAdapter(resolve(f.dir, 'worker-b')), async patch => {
      const r = await f.req('node/report', { id: 'b', taskId: f.task.id, ...patch }, true);
      assert.equal(r.status, 200);
      return r.body;
    }, 100);
    const row = f.app.store.get('tasks', f.task.id);
    assert.equal(row.state, 'COMPLETED');
    assert.equal(row.assignedNodeId, 'b');
    assert.equal(row.result.waitedMs, 500, 'the real result must be recorded on the original task');
    // ONE task, not two: the handoff must not fork the work.
    assert.equal(f.app.store.list('tasks').length, 1);
    assert.equal(f.app.store.events().filter(e => e.type === 'TASK_HANDOFF_TRANSFERRED').length, 1);
    // The original surface can still read the task and its result.
    const detail = await f.detail();
    assert.equal(detail.id, f.task.id);
    assert.equal(detail.result.waitedMs, 500);
  } finally { await f.close(); }
});

test('PROBE 8: the browser sends the canonical decision, offers no conflicted button, and does not re-derive routing', async () => {
  const f = await fixture();
  let browser;
  try {
    const before = await f.entry();
    const revision = before.userChoices.alternateDevice.expectedUpdatedAt;
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
    const page = await browser.newPage({ locale: 'en-US' });
    page.setDefaultTimeout(15000);
    await page.goto(f.app.url + '/#token=owner');
    await page.locator('#connection.online').waitFor();
    await page.locator('[data-page="Devices"]').click();
    const button = page.locator('[data-scheduler-action="ALTERNATE_DEVICE"]');
    await button.waitFor();
    // The button carries exactly the revision the SERVER issued, so the client is not computing a decision.
    assert.equal(await button.getAttribute('data-scheduler-revision'), revision);
    assert.equal(await button.isEnabled(), true);
    // The generic CONFIRM control stays honest-unwired: there is no route behind it. Asserted HERE, while a choice is
    // still open, because the control is rendered only while the DTO says a decision is required - an earlier draft of
    // this probe asserted it after the click and timed out on a control that had correctly disappeared.
    const confirm = page.locator('[data-scheduler-unwired="CONFIRM"]');
    assert.equal(await confirm.isDisabled(), true, 'the generic CONFIRM must not become wireable by this change');

    // Capture what the page actually sends.
    let sent = null;
    await page.route('**/switch-declined', async route => { sent = JSON.parse(route.request().postData() ?? '{}'); await route.continue(); });
    await button.click();
    await page.waitForFunction(() => document.querySelector('.scheduler-task-state')?.textContent?.includes('another device'));
    assert.deepEqual(sent, { decision: 'ALTERNATE_DEVICE', expectedUpdatedAt: revision }, 'the browser must send the canonical decision and the canonical revision');
    assert.equal(f.app.store.get('tasks', f.task.id).switchDeclined, true);
    assert.equal(f.app.store.events().filter(e => e.type === 'TASK_SWITCH_DECLINED').length, 1);
  } finally { await browser?.close(); await f.close(); }
});

test('PROBE 9: "keep waiting" is a local acknowledgement, not a falsified switch decision', async () => {
  const f = await fixture();
  let browser;
  try {
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
    const page = await browser.newPage({ locale: 'en-US' });
    page.setDefaultTimeout(15000);
    await page.goto(f.app.url + '/#token=owner');
    await page.locator('#connection.online').waitFor();
    await page.locator('[data-page="Devices"]').click();
    const keep = page.locator('[data-scheduler-action="KEEP_WAITING"]');
    await keep.waitFor();
    let wrote = false;
    await page.route('**/api/v0/**', async route => { const m = route.request().method(); if (m !== 'GET') wrote = true; await route.continue(); });
    await keep.click();
    await page.waitForTimeout(500);
    // Keeping to wait is a decision NOT to decide: the City must not be told the user declined the switch.
    assert.equal(f.app.store.get('tasks', f.task.id).switchDeclined, undefined, 'keep-waiting must not record a switch decision');
    assert.equal(f.app.store.events().filter(e => e.type === 'TASK_SWITCH_DECLINED').length, 0);
    assert.equal(f.app.store.get('tasks', f.task.id).state, 'RUNNING');
    assert.equal(wrote, false, 'keep-waiting must be a local acknowledgement, not a write');
  } finally { await browser?.close(); await f.close(); }
});

test('PROBE 10: the paused-device flag is read by the presentation AND enforced by the executable claim path', async () => {
  // The workbook's mandatory paper point asks for the difference between the presentation contract and the
  // executable route to be recorded. This is where that difference used to be, so it is pinned in both directions.
  const f = await fixture();
  try {
    f.app.store.put('nodes', { ...f.app.store.get('nodes', 'b'), sharingEnabled: false });
    const feed = (await f.req('presentation')).body;
    assert.equal(feed.candidates.includes('b'), true, 'a paused device is still a known candidate');
    assert.equal(feed.tasks[0].userChoices.alternateDevice.allowed, false, 'the presentation must not offer a paused device');
    assert.equal(feed.tasks[0].userChoices.alternateDevice.reason, 'ALTERNATE_NOT_AVAILABLE');
    // The executable route agrees, measured on a FRESH claimable task: the task in this fixture is already RUNNING on
    // node a, so it is not claimable by anyone and would have proved nothing either way. An earlier draft made exactly
    // that mistake and its "paused device got no work" assertion was vacuous.
    const queued = (await f.req('tasks', { type: 'WAIT' })).body;
    assert.equal((await f.req('node/claim', { id: 'b' }, true)).body.task, null, 'a paused device must not be handed work');
    assert.equal(f.app.store.get('tasks', queued.id).state, 'QUEUED');
    // And re-enabling flips BOTH back together, so the two are not merely both-negative by accident.
    f.app.store.put('nodes', { ...f.app.store.get('nodes', 'b'), sharingEnabled: true });
    assert.equal((await f.entry()).userChoices.alternateDevice.allowed, true);
    assert.equal((await f.req('node/claim', { id: 'b' }, true)).body.task?.id, queued.id, 'an enabled device must be handed the work');
  } finally { await f.close(); }
});

test('PROBE 11: handoff latency, measured on the opposite host instead of left NOT_OBSERVABLE', async () => {
  // The workbook lists handoff latency among its mandatory paper points, and the development receipt records
  // click_to_handoff_ms and click_to_result_ms as null with unknown_reason NOT_OBSERVABLE. The author's own index says
  // the reviewer must reproduce timing rather than trust undocumented numbers, so this review measures it.
  const f = await fixture();
  try {
    const revision = (await f.entry()).userChoices.alternateDevice.expectedUpdatedAt;
    const t0 = Date.now();
    const accepted = await f.choose(revision);
    const tAccepted = Date.now();
    assert.equal(accepted.status, 200);
    let handoffAt = null;
    for (let i = 0; i < 200 && handoffAt === null; i += 1) {
      const event = f.app.store.events().find(e => e.type === 'TASK_HANDOFF_TRANSFERRED');
      if (event) handoffAt = Date.now();
      else await new Promise(r => setTimeout(r, 5));
    }
    assert.notEqual(handoffAt, null, 'the handoff must actually happen for a latency to exist');
    const claimed = await f.req('node/claim', { id: 'b' }, true);
    await executeTask(claimed.body.task, new FilesystemAdapter(resolve(f.dir, 'worker-b')), async patch => (await f.req('node/report', { id: 'b', taskId: f.task.id, ...patch }, true)).body, 100);
    const tResult = Date.now();
    assert.equal(f.app.store.get('tasks', f.task.id).state, 'COMPLETED');
    // Canonical-record latency: the delta between the two events the City itself stamped, independent of this client.
    const events = f.app.store.events();
    const declinedEvent = events.find(e => e.type === 'TASK_SWITCH_DECLINED');
    const handoffEvent = events.find(e => e.type === 'TASK_HANDOFF_TRANSFERRED');
    const canonicalHandoffMs = Date.parse(handoffEvent.timestamp) - Date.parse(declinedEvent.timestamp);
    const measured = {
      switch_decline_http_ms: tAccepted - t0,
      click_to_handoff_ms: handoffAt - t0,
      click_to_result_ms: tResult - t0,
      canonical_decline_to_handoff_ms: canonicalHandoffMs,
      scope: 'ONE_PHYSICAL_WINDOWS_HOST_CONTROLLED_FIXTURE_NOT_A_PERFORMANCE_CLAIM',
    };
    console.log('MEASURED_HANDOFF_LATENCY ' + JSON.stringify(measured));
    assert.ok(canonicalHandoffMs >= 0 && canonicalHandoffMs < 60000, 'the canonical delta must be plausible, not a fabricated number');
    assert.ok(measured.click_to_handoff_ms >= 0 && measured.click_to_handoff_ms < 60000);
  } finally { await f.close(); }
});
