// REX-803: the campaign control surface in a real browser - the owner starts and stops a real campaign, and every
// repetition that produced no measurement is displayed WITH its reason. Playwright against a real Gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';

const h = credential => ({Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'});
const ask = async (app, path, body, credential = 'owner') => {
  const response = await fetch(app.url + '/api/v0/' + path, {method: body ? 'POST' : 'GET', headers: h(credential), body: body ? JSON.stringify(body) : undefined});
  return {status: response.status, body: await response.json()};
};
const manifest = controlSurface => ({
  experimentId: 'ui-campaign-fixture',
  question: 'Can one scenario be repeated and every absence explained on screen?',
  topology: 'SINGLE_CITY',
  hosts: ['ui-node'], workers: ['ui-node'], controlSurfaces: [controlSurface],
  variables: {independent: ['scenario'], dependent: ['completion'], controls: ['taskType']},
  repetitions: 3, seedPolicy: 'PER_REPETITION', baseSeed: 11,
  requiredCapabilities: ['research.evidence.review'],
  stopConditions: [{kind: 'MAX_REPETITIONS', value: 3}],
  artifactPolicy: {retention: 'SUMMARY_ONLY'},
  acceptance: {primary: 'Every repetition is either measured or explained'},
  softwareRefs: ['utopia@' + '0'.repeat(40)],
});
const registerWorker = app => ask(app, 'node/register', {id: 'ui-node', displayName: 'UI fixture worker', capabilities: ['task.execute.safe', 'filesystem.temp'], roles: ['EXECUTION_NODE'], metadata: {platform: 'win32'}}, 'node');
/** A worker whose Nth task fails, so the screen has to show exactly one repetition without a measurement. */
function startWorker(app, {failFrom = Number.MAX_SAFE_INTEGER} = {}) {
  let seen = 0, stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const claimed = await ask(app, 'node/claim', {id: 'ui-node'}, 'node');
      const taskId = claimed.body?.task?.id;
      if (taskId) {
        seen += 1;
        await ask(app, 'node/report', {id: 'ui-node', taskId, state: 'RUNNING', progress: 50}, 'node');
        // Exactly the named task fails. An earlier version failed every task from that index onward, which produced a
        // campaign of three failures - the product was right and the fixture was wrong (MEASUREMENT_DEFECT).
        const fail = seen === failFrom;
        await ask(app, 'node/report', {id: 'ui-node', taskId, state: fail ? 'FAILED' : 'COMPLETED', progress: fail ? 60 : 100, result: fail ? undefined : {ok: true}, error: fail ? 'fixture failure' : undefined}, 'node');
      }
      await new Promise(r => setTimeout(r, 15));
    }
  })();
  return {stop: () => {stopped = true; return loop; }};
}
const connect = async (app, browser, hash = '#token=owner') => {
  const page = await browser.newPage({locale: 'en-US'});
  page.setDefaultTimeout(15000);
  await page.goto(app.url + '/' + hash);
  await page.locator('#connection.online').waitFor();
  return page;
};

test('REX803 web: the owner runs a real campaign and every repetition without a measurement shows its reason', async () => {
  const dir = await mkdtemp(resolve('.scratch-rex803-web-'));
  let app = null, browser = null, worker = null;
  try {
    app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true, researchTraceSoftwareRefs: {softwareSha: '0'.repeat(40)}});
    await registerWorker(app);
    // The browser's own control-surface ref is only knowable from the City once that surface is connected, and the
    // campaign surface publishes the live vocabulary for exactly this reason: the experiment must declare the
    // identity the City actually reports, not one the test invented.
    browser = await chromium.launch({channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true});
    const page = await connect(app, browser);
    const vocabulary = (await ask(app, 'research/campaigns')).body.topology;
    assert.deepEqual(vocabulary.workers, ['ui-node']);
    assert.equal(vocabulary.surfaces.length, 1, 'the connected browser is a live control surface');
    assert.match(vocabulary.surfaces[0].ref, /^[a-zA-Z0-9-]{1,80}$/, 'the ref is whatever the surface really declared');
    assert.equal((await ask(app, 'research/experiments', {manifest: manifest(vocabulary.surfaces[0].ref)})).status, 200);
    worker = startWorker(app, {failFrom: 4});
    await page.locator('[data-page="ResearchCampaign"]').click();
    await page.locator('#research-campaign[data-loaded="true"]').waitFor();
    assert.equal(await page.locator('#rc-experiment option').count(), 1, 'the registered experiment is selectable');
    assert.equal(await page.locator('#rc-scenario option').count(), 5, 'every canonical scenario is selectable');
    assert.match(await page.locator('#rc-experiment-facts').innerText(), /3 repetitions/);
    assert.match(await page.locator('#rc-live-topology').innerText(), /ui-node/, 'the surface says which identities this City can offer');
    assert.equal(await page.locator('#rc-stop').isDisabled(), true, 'stop is not offered when nothing is running');

    await page.locator('#rc-start').click();
    await page.waitForFunction(() => document.querySelector('#rc-status')?.textContent.includes('COMPLETED'));
    assert.equal(await page.locator('#rc-measured tbody tr[data-rc-run]').count(), 3);
    assert.equal(await page.locator('#rc-excluded tbody tr').count(), 0);
    assert.match(await page.locator('#rc-totals').innerText(), /3 measured of 3 planned/);
    assert.equal(await page.locator('#rc-receipts li[data-rc-receipt]').count(), 1, 'the finished campaign is filed as a receipt');
    assert.equal(await page.locator('#rc-technical').getAttribute('open'), null, 'technical identifiers stay folded away');
    assert.ok(!(await page.locator('#research-campaign').innerText()).includes('campaignSeed'), 'the primary reading carries no seed or run reference');
    await page.screenshot({path: '.runtime/evidence/mission-book/REX-803/research-campaign-measured.png', fullPage: true});

    // A campaign whose second repetition fails: the failure is a RESULT of the screen, not a hidden detail.
    await page.locator('#rc-repetitions').fill('3');
    await page.locator('#rc-start').click();
    await page.waitForFunction(() => document.querySelector('#rc-totals')?.textContent.includes('2 measured of 3'));
    const excluded = page.locator('#rc-excluded tbody tr[data-rc-excluded]');
    assert.equal(await excluded.count(), 1, 'the repetition without a measurement is listed');
    assert.match(await excluded.first().innerText(), /FAILED/);
    assert.match(await excluded.first().innerText(), /the canonical task ended FAILED: fixture failure/, 'the reason is the canonical task outcome, in words');
    await page.screenshot({path: '.runtime/evidence/mission-book/REX-803/research-campaign-explained-absence.png', fullPage: true});

    // Leaving the page stops the view from polling, and coming back rebuilds it from the City.
    await page.locator('[data-page="Home"]').click();
    await page.locator('[data-page="ResearchCampaign"]').click();
    await page.locator('#research-campaign[data-loaded="true"]').waitFor();
    assert.equal(await page.locator('#rc-receipts li[data-rc-receipt]').count(), 2);
  } finally {
    try { await worker?.stop(); } catch { /* already stopped */ }
    await browser?.close();
    await app?.close();
    await rm(dir, {recursive: true, force: true});
  }
});

test('REX803 web: a member is told the campaign surface is the owner\'s, and is offered no controls', async () => {
  const dir = await mkdtemp(resolve('.scratch-rex803-web-member-'));
  let app = null, browser = null;
  try {
    app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true});
    const enrollment = (await ask(app, 'device/enroll', {displayName: 'Member'})).body;
    const session = (await ask(app, 'device/session', {installationId: enrollment.installation.installationId, instanceId: enrollment.installation.instanceId, ...enrollment.credential})).body.credential;
    browser = await chromium.launch({channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true});
    const page = await connect(app, browser, '#session=' + encodeURIComponent(session));
    await page.locator('[data-page="ResearchCampaign"]').click();
    await page.locator('#rc-error').waitFor();
    assert.match(await page.locator('#rc-error').innerText(), /Only the City owner/);
    assert.equal(await page.locator('#rc-start').count(), 0, 'no control is offered to a member');
  } finally {
    await browser?.close();
    await app?.close();
    await rm(dir, {recursive: true, force: true});
  }
});
