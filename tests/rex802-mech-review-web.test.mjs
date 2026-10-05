// REX-802 · OPPOSITE-HOST REVIEW · Web surface probe (Mech).
//
// The workbook declares user_exposure_class OBSERVABLE_ADVANCED on surface RESEARCH_RUN_DETAILS and requires the user
// to be able to see: what is being recorded, the current run, failures, metrics availability, provenance, and trace
// completeness / missing fields. This probe drives a REAL browser against a REAL gateway and reads the rendered DOM,
// so "the user can see it" is measured rather than asserted from the template string.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createGateway, REQUIRED_TASK_CAPABILITIES } from '../services/dev-gateway/server.mjs';

const V = { 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const auth = token => ({ ...V, Authorization: 'Bearer ' + token });

async function open(options, fn) {
  const dir = await mkdtemp(resolve('.scratch-rex802-web-'));
  let app, browser;
  try {
    app = await createGateway({ dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true, ...options });
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
    return await fn({ app, browser, dir });
  } finally { await browser?.close(); await app?.close(); await rm(dir, { recursive: true, force: true }); }
}

const post = (app, path, body, token = 'owner') => fetch(app.url + '/api/v0/' + path, { method: 'POST', headers: auth(token), body: JSON.stringify(body ?? {}) }).then(r => r.json());
const get = (app, path, token = 'owner') => fetch(app.url + '/api/v0/' + path, { headers: auth(token) }).then(async r => ({ status: r.status, body: await r.json() }));

test('REX802-WEB: the owner page renders every disclosure the workbook names, with identifiers folded', () => open({ researchTraceSoftwareRefs: { softwareSha: '0e9bea3ce739b979e582a428af8fb233045a5e75' } }, async ({ app, browser }) => {
  // NOTE: /api/v0/node/* is a nodeRoute, so it is authorized by the NODE token, not the owner token. The first draft
  // of this probe posted it with the owner token, silently took a 401, and then reported that no resource observation
  // existed - a probe defect that looked exactly like a product defect. The token is explicit here for that reason.
  await post(app, 'node/register', { id: 'n1', displayName: 'n1', metadata: { platform: 'win32' }, capabilities: [...REQUIRED_TASK_CAPABILITIES], telemetry: { observedAt: new Date().toISOString(), uptimeSeconds: 3, cpu: { usagePercent: 12 }, memory: { usedBytes: 2048, totalBytes: 4096 }, disk: null } }, 'node');
  await post(app, 'tasks', { type: 'WAIT' });
  await app.researchTrace.flush();

  const page = await browser.newPage({ locale: 'en-US' });
  page.setDefaultTimeout(10000);
  await page.goto(app.url + '/#token=owner');
  await page.locator('#connection.online').waitFor();
  await page.locator('[data-page="ResearchTrace"]').click();
  await page.locator('#research-trace[data-loaded="true"]').waitFor();

  const panel = page.locator('#research-trace');
  const text = await panel.innerText();
  // 1. what is being recorded
  assert.match(text, /Recorded event types/i, 'the user must see what is being recorded');
  assert.match(text, /TASK_CREATED|RESOURCE_OBSERVATION/, 'the recorded types must be named');
  // 2. the current run
  assert.match(text, /Recording\b/, 'the user must see whether recording is live');
  // 3. failures
  assert.match(text, /Collector failures/i, 'the user must see collector failures');
  // 4. metrics availability
  assert.match(text, /Measurement availability/i, 'the user must see measurement availability');
  assert.match(text, /cpuPercent/, 'each measurement must be listed by name');
  assert.match(text, /Measured/, 'a measured metric must be shown as measured');
  assert.match(text, /NOT_OBSERVABLE/, 'a missing measurement must be shown as unknown, not as a value');
  // 5. provenance - FINDING F3: the only provenance statement in the product is inside the folded Run details, so it
  // is NOT visible to a user who does not expand raw identifiers. Measured rather than assumed:
  assert.doesNotMatch(text, /declared reference|external verification/i, 'F3: the provenance statement is folded away');
  assert.match(text, /Run details/, 'the folded technical section is the only place left for it');
  // 6. completeness
  assert.match(text, /COMPLETE|PARTIAL/, 'the user must see trace completeness');

  // Raw identifiers are folded, not dumped: <details> must exist and must be closed by default.
  const details = page.locator('#trace-technical');
  assert.equal(await details.count(), 1);
  assert.equal(await details.getAttribute('open'), null, 'technical identifiers must start folded');

  // FINDING F1, user-facing evidence: the aggregate completeness is visible, but the per-record reason for it is ONLY
  // inside the folded raw JSON. This measures exactly what the user can see without expanding technical details.
  const visibleOnly = await page.evaluate(() => {
    const panel = document.querySelector('#research-trace');
    const clone = panel.cloneNode(true);
    clone.querySelectorAll('details').forEach(d => d.remove());
    return clone.innerText;
  });
  assert.doesNotMatch(visibleOnly, /missingFields/, 'F1: the missing-field list is not surfaced outside the raw JSON');
  assert.doesNotMatch(visibleOnly, /annotations/, 'F1: per-record annotations are not surfaced outside the raw JSON');
  assert.match(text, /PARTIAL/, 'F1: the visible completeness is PARTIAL even for this healthy recording');
  // The folded content is not "rendered", so it must be read as textContent rather than innerText - the first draft
  // of this probe read innerText and concluded the data was absent when it was merely collapsed.
  const folded = await details.evaluate(el => el.textContent);
  assert.match(folded, /missingFields/, 'the data exists - it is present once the user expands technical details');
  assert.match(folded, /experimentRef/, 'the data exists - it names the absent experiment binding');
  assert.match(folded, /declared reference/i, 'F3: the provenance statement is present, but only here');
}));

test('REX802-WEB: a member is told the owner requirement instead of seeing an empty success', () => open({}, async ({ app, browser }) => {
  const admission = await post(app, 'device/enroll', { displayName: 'Member' });
  const session = (await post(app, 'device/session', { installationId: admission.installation.installationId, instanceId: admission.installation.instanceId, ...admission.credential })).credential;
  assert.equal((await get(app, 'research/trace', session)).status, 403);

  const page = await browser.newPage({ locale: 'en-US' });
  page.setDefaultTimeout(10000);
  await page.goto(app.url + '/#session=' + encodeURIComponent(session));
  await page.locator('#connection.online').waitFor();
  await page.locator('[data-page="ResearchTrace"]').click();
  await page.locator('#research-trace[data-loaded="true"]').waitFor();
  const text = await page.locator('#research-trace').innerText();
  assert.match(text, /Only the City owner/i, 'a member must receive owner-required guidance');
  assert.match(text, /owner/i);
  assert.equal(await page.locator('#trace-technical').count(), 0, 'a refused member must not be shown a technical dump');
  assert.doesNotMatch(text, /Missing|undefined|null/, 'a refusal must not render junk placeholders');
}));

test('REX802-WEB: an offline page says the recording is not live rather than showing cached state as current', () => open({}, async ({ app, browser }) => {
  await post(app, 'tasks', { type: 'WAIT' });
  await app.researchTrace.flush();
  const page = await browser.newPage({ locale: 'en-US' });
  page.setDefaultTimeout(10000);
  await page.goto(app.url + '/#token=owner');
  await page.locator('#connection.online').waitFor();
  await page.locator('[data-page="ResearchTrace"]').click();
  await page.locator('#research-trace[data-loaded="true"]').waitFor();
  assert.match(await page.locator('#research-trace').innerText(), /PARTIAL|COMPLETE/);

  // Prove the fence: with the City unreachable the panel must not keep presenting the old view as live.
  await page.route('**/api/v0/research/trace*', route => route.abort());
  await page.locator('#trace-refresh').click();
  await page.waitForTimeout(300);
  const after = await page.locator('#research-trace').innerText();
  assert.match(after, /unavailable|Reconnect/i, 'a failed refresh must be stated, not silently ignored');
}));
