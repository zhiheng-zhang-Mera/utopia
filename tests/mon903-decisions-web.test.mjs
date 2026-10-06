// MON-903 in a real browser: what the City decided, why, and that nothing was applied on the owner's behalf.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';

const headers = token => ({Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'});
const ask = async (app, path, body, token = 'owner') => {
  const response = await fetch(app.url + '/api/v0/' + path, {method: body ? 'POST' : 'GET', headers: headers(token), body: body ? JSON.stringify(body) : undefined});
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  return {status: response.status, body: parsed};
};
const registerWorker = app => ask(app, 'node/register', {id: 'web-node', displayName: 'Web fixture worker', metadata: {platform: 'reference'}, capabilities: ['task.execute.safe', 'filesystem.temp']}, 'node');
const failOneTask = async app => {
  const task = (await ask(app, 'tasks', {type: 'WAIT'})).body;
  await ask(app, 'node/claim', {id: 'web-node'}, 'node');
  await ask(app, 'node/report', {id: 'web-node', taskId: task.id, state: 'RUNNING', progress: 30}, 'node');
  await ask(app, 'node/report', {id: 'web-node', taskId: task.id, state: 'FAILED', progress: 60, error: 'endpoint refused the work'}, 'node');
  return task;
};
const connect = async (app, browser, hash = '#token=owner') => {
  const page = await browser.newPage({locale: 'en-US'});
  page.setDefaultTimeout(15000);
  await page.goto(app.url + '/' + hash);
  await page.locator('#connection.online').waitFor();
  return page;
};

test('MON903 web: the owner sees the decision the City recorded, its provenance, and that nobody applied it', async () => {
  const dir = await mkdtemp(resolve('.scratch-mon903-web-'));
  let app = null, browser = null;
  try {
    app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true});
    await registerWorker(app);
    browser = await chromium.launch({channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true});
    const page = await connect(app, browser);
    await page.locator('[data-page="Decisions"]').click();
    await page.locator('#monitor-decisions[data-loaded="true"]').waitFor();
    // An empty window says so in words rather than implying that everything is fine.
    assert.match(await page.locator('#dec-empty').innerText(), /No decision has been recorded/);
    assert.match(await page.locator('#dec-owner-empty').innerText(), /No receipt in this window is marked owner-required; current Owner work is not determined here/);
    assert.match(await page.locator('#dec-metrics').innerText(), /NOT_MEASURED/, 'an empty window reports NOT_MEASURED, never a fabricated rate');

    const task = await failOneTask(app);
    await page.locator('#dec-table tbody tr[data-decision]').first().waitFor();
    const row = page.locator('#dec-table tbody tr[data-decision]').first();
    const text = await row.innerText();
    assert.match(text, /FAILED/);
    assert.match(text, /RULE/);
    assert.match(text, /RETRY_RECOMMENDED/);
    assert.match(text, /no/, 'this decision did not need the owner');
    // Provenance is folded away and states that the decision changed nothing.
    const provenance = row.locator('details[data-provenance]');
    assert.equal(await provenance.getAttribute('open'), null, 'provenance stays folded in the primary reading');
    await provenance.locator('summary').click();
    const details = await provenance.innerText();
    assert.match(details, /State before: FAILED/);
    assert.match(details, /Applied by: nobody/);
    assert.match(details, /CANONICAL_GATEWAY_STORE/);
    assert.match(await page.locator('#dec-metrics').innerText(), /1 decision/);
    assert.match(await page.locator('#dec-notblocking').innerText(), /ABSENT_BY_CONSTRUCTION/);
    // The task itself is untouched by the decision that was recorded about it.
    assert.equal(app.store.get('tasks', task.id).state, 'FAILED');
    assert.equal(app.store.get('tasks', task.id).error, 'endpoint refused the work');

    // An owner-boundary trigger moves into the section that is meant to be looked at.
    await ask(app, 'monitor/decisions', {kind: 'SCOPE_CHANGE', taskRef: task.id, reason: 'the workbook grew a second deliverable'});
    await page.locator('#dec-owner-list li[data-owner-required]').first().waitFor();
    const ownerItem = await page.locator('#dec-owner-list li[data-owner-required]').first().innerText();
    assert.match(ownerItem, /SCOPE_CHANGE/);
    assert.match(ownerItem, /OWNER_BOUNDARY_KIND/);
    assert.match(await page.locator('#dec-metrics').innerText(), /1 owner-required/);
    await page.screenshot({path: '.runtime/evidence/mission-book/MON-903/decision-provenance.png', fullPage: true});
  } finally {
    await browser?.close();
    await app?.close();
    await rm(dir, {recursive: true, force: true});
  }
});

test('MON903 web: an enrolled member may read what the City decided, and is told who can ask for one', async () => {
  const dir = await mkdtemp(resolve('.scratch-mon903-web-member-'));
  let app = null, browser = null;
  try {
    app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true});
    await registerWorker(app);
    await failOneTask(app);
    const enrollment = (await ask(app, 'device/enroll', {displayName: 'Member'})).body;
    const session = (await ask(app, 'device/session', {installationId: enrollment.installation.installationId, instanceId: enrollment.installation.instanceId, ...enrollment.credential})).body.credential;
    browser = await chromium.launch({channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true});
    const page = await connect(app, browser, '#session=' + encodeURIComponent(session));
    await page.locator('[data-page="Decisions"]').click();
    await page.locator('#monitor-decisions[data-loaded="true"]').waitFor();
    await page.locator('#dec-table tbody tr[data-decision]').first().waitFor();
    assert.equal(await page.locator('#dec-error').count(), 0, 'a member reads the decision log without an error');
    // The route refuses a member who tries to ASK for a decision, and the surface never offers that control.
    assert.equal((await ask(app, 'monitor/decisions', {kind: 'SCOPE_CHANGE'}, session)).status, 403);
    assert.equal(await page.locator('#dec-submit').count(), 0, 'no submit control exists on this read surface');
  } finally {
    await browser?.close();
    await app?.close();
    await rm(dir, {recursive: true, force: true});
  }
});
