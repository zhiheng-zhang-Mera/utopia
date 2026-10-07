// REX-807 acceptance: tests/rex807-danger-confirmation.test.mjs
//
// The workbook's requirement is that "high-impact fault controls are not triggered by accident". The first revision of
// the surface satisfied that with a SENTENCE: the danger section carried `requiresConfirmation: true` and an
// instruction, and a test asserted the instruction mentioned a campaign id. Nothing refused anything, and the
// instruction was in fact wrong - the gateway requires the exact token `FAULT:<kind>:<nodeId>`
// (services/dev-gateway/research/faults.mjs), so an operator who followed the on-screen instruction to the letter was
// refused with FAULT_CONFIRMATION_REQUIRED. This file turns the sentence into a gate and checks it in both directions:
//
//   S9  no ADVANCED_CONTROL section or control may exist without requiresConfirmation, enforced by the surface itself
//   S10 the confirmation rule refuses empty, partial, wrong-target and wrong-kind input - and it is the same rule the
//       gateway enforces, proven against a REAL gateway rather than against a copy of the string
//   S11 in a real browser against a real gateway: a wrong confirmation performs NO injection and says so, and the
//       exact token then injects and can be emergency-stopped
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {SURFACE_LEVELS, assertAdvancedControlsConfirmed, confirmationSatisfied, faultConfirmationToken, researchView} from '../apps/web/research-surface.js';

const headers = {Authorization: 'Bearer ctl', 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const nodeHeaders = {...headers, Authorization: 'Bearer node'};
const registerNode = (id, base, auth = nodeHeaders) => fetch(`${base}/api/v0/node/register`, {method: 'POST', headers: auth, body: JSON.stringify({id, displayName: id, metadata: {platform: 'reference'}, capabilities: ['task.execute.safe', 'filesystem.temp']})});
const heartbeat = (id, base, auth = nodeHeaders) => fetch(`${base}/api/v0/node/heartbeat`, {method: 'POST', headers: auth, body: JSON.stringify({id})});
const startFault = (base, body) => fetch(`${base}/api/v0/research/faults`, {method: 'POST', headers, body: JSON.stringify(body)});
const listFaults = async (base, auth = headers) => ((await (await fetch(`${base}/api/v0/research/faults`, {headers: auth})).json()).faults ?? []);

test('REX807 S9: the surface refuses to exist if any advanced control could be triggered without confirmation', () => {
  const view = researchView({}, {locale: 'en'});
  assert.equal(assertAdvancedControlsConfirmed(view), view, 'a well-formed surface passes');
  const danger = view.sections.find(section => section.id === 'advanced-faults');
  assert.equal(danger.requiresConfirmation, true);
  assert.ok(view.confirmationRequired.includes('advanced-faults'));

  // Each of the three shapes a later edit could take is refused by name: an unconfirmed advanced SECTION, an
  // unconfirmed advanced CONTROL inside a section, and an unconfirmed advanced control at the top level.
  const unconfirmedSection = {sections: [{id: 'new-danger', level: SURFACE_LEVELS.ADVANCED_CONTROL}]};
  assert.throws(() => assertAdvancedControlsConfirmed(unconfirmedSection), /ADVANCED_CONTROL_UNCONFIRMED: section:new-danger/);
  const unconfirmedControl = {sections: [{id: 'experiments', level: SURFACE_LEVELS.DIRECT_CONTROL, controls: [{id: 'wipe', level: SURFACE_LEVELS.ADVANCED_CONTROL}]}]};
  assert.throws(() => assertAdvancedControlsConfirmed(unconfirmedControl), /control:experiments\/wipe/);
  const unconfirmedTopLevel = {sections: [], controls: [{id: 'seedOverride', level: SURFACE_LEVELS.ADVANCED_CONTROL}]};
  assert.throws(() => assertAdvancedControlsConfirmed(unconfirmedTopLevel), /control:seedOverride/);
  // A DIRECT_CONTROL section without confirmation is legitimate and must not be refused.
  assert.doesNotThrow(() => assertAdvancedControlsConfirmed({sections: [{id: 'experiments', level: SURFACE_LEVELS.DIRECT_CONTROL, controls: [{id: 'create', level: SURFACE_LEVELS.DIRECT_CONTROL, requiresConfirmation: false}]}]}));
});

test('REX807 S10: the client confirmation rule refuses anything except the exact token the gateway enforces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rex807-confirm-'));
  const app = await createGateway({dir, port: 0, token: 'ctl', nodeToken: 'node', roomsDisabled: true});
  try {
    await registerNode('alpha', app.url);
    await registerNode('beta', app.url);
    await heartbeat('alpha', app.url);
    await heartbeat('beta', app.url);
    const expected = faultConfirmationToken({kind: 'HEARTBEAT_LOSS', nodeId: 'alpha'});
    assert.equal(expected, 'FAULT:HEARTBEAT_LOSS:alpha');

    // The rule is strict, and each near-miss is refused: empty, whitespace, the campaign id an old revision asked for,
    // the right kind against the wrong target, the wrong kind against the right target, and the token with padding.
    for (const typed of ['', ' ', 'campaign-4f1c2b7e-9a3d-4e5f-8b21-0c7d6e5f4a3b', 'FAULT:HEARTBEAT_LOSS:beta', 'FAULT:PROVIDER_UNAVAILABLE:alpha', ` ${expected}`, `${expected} `, expected.toLowerCase()]) {
      assert.equal(confirmationSatisfied(expected, typed), false, `the client must refuse ${JSON.stringify(typed)}`);
    }
    assert.equal(confirmationSatisfied(expected, expected), true);
    assert.equal(confirmationSatisfied('', ''), false, 'an empty requirement is never satisfied');

    // And the string this module builds is the string the GATEWAY accepts - asserted against the real endpoint, so a
    // future divergence fails here instead of in front of an operator mid-incident.
    const refused = await startFault(app.url, {kind: 'HEARTBEAT_LOSS', nodeId: 'alpha', durationMs: 50, confirmation: 'FAULT:HEARTBEAT_LOSS:beta'});
    assert.equal(refused.status, 403, 'the gateway refuses a confirmation for a different target');
    assert.equal((await refused.json()).error, 'FAULT_CONFIRMATION_REQUIRED');
    assert.equal((await listFaults(app.url)).length, 0, 'the refused attempt injected nothing');
    const accepted = await startFault(app.url, {kind: 'HEARTBEAT_LOSS', nodeId: 'alpha', durationMs: 50, confirmation: expected});
    assert.equal(accepted.status, 200, 'the client-built token is the one the gateway accepts');
    assert.equal((await accepted.json()).fault.nodeId, 'alpha');
    assert.equal((await listFaults(app.url)).length, 1);
  } finally {
    await app.close();
    await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}).catch(() => {});
  }
});

test('REX807 S11: in a real browser a wrong confirmation injects nothing, and the exact token then injects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rex807-danger-web-'));
  let app, browser;
  try {
    app = await createGateway({dir, port: 0, token: 'web-review', nodeToken: 'web-node', roomsDisabled: true});
    const webHeaders = {...headers, Authorization: 'Bearer web-review'};
    const webNodeHeaders = {...headers, Authorization: 'Bearer web-node'};
    await registerNode('alpha', app.url, webNodeHeaders);
    await heartbeat('alpha', app.url, webNodeHeaders);
    browser = await chromium.launch({channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true});
    const page = await browser.newPage({locale: 'en-US'});
    await page.goto(app.url);
    await page.locator('#token').fill('web-review');
    await page.locator('#connect').click();
    await page.locator('#connection').filter({hasText: 'ONLINE'}).waitFor();
    await page.locator('[data-page="Research"]').click();
    // The danger zone renders itself after its own refresh; wait for the target worker to be selectable.
    await page.waitForFunction(() => document.querySelector('#fault-node')?.options.length > 0 && document.querySelector('#fault-kind')?.options.length > 0);
    // It must be closed, and the required phrase must be shown rather than guessed.
    assert.equal(await page.locator('#fault-danger').evaluate(node => node.open), false, 'the Danger Zone starts collapsed');
    await page.locator('#fault-danger > summary').click();
    const shown = await page.locator('#fault-confirmation-hint').innerText();
    assert.match(shown, /FAULT:[A-Z_]+:alpha/, `the page must state the exact required token, showed: ${shown}`);
    assert.equal(await page.locator('#fault-confirmation').inputValue(), '', 'the confirmation field starts empty');

    // (a) A wrong confirmation must inject nothing. It IS submitted, because the gateway owns this rule and its typed
    //     refusal is better evidence than a client-side guess - but nothing may be injected, and the page must say so.
    await page.locator('#fault-confirmation').fill('campaign-4f1c2b7e-9a3d-4e5f-8b21-0c7d6e5f4a3b');
    await page.locator('#fault-start').click();
    await page.locator('#fault-error').filter({hasText: 'FAULT_CONFIRMATION_REQUIRED'}).waitFor();
    assert.equal((await listFaults(app.url, webHeaders)).length, 0, 'a wrong confirmation performed no injection');

    // (b) An EMPTY confirmation is refused locally: an unfilled form is not a confirmation attempt, so no request is
    //     made and the page names the exact token it wants.
    await page.locator('#fault-confirmation').fill('');
    await page.locator('#fault-start').click();
    await page.locator('#fault-error').filter({hasText: 'FAULT_CONFIRMATION_REQUIRED'}).waitFor();
    assert.match(await page.locator('#fault-error').innerText(), /type exactly FAULT:/, 'an empty confirmation names the exact token');
    assert.equal((await listFaults(app.url, webHeaders)).length, 0, 'an empty confirmation performed no injection');
    // Whitespace is not a confirmation either.
    await page.locator('#fault-confirmation').fill('   ');
    await page.locator('#fault-start').click();
    await page.locator('#fault-error').filter({hasText: 'FAULT_CONFIRMATION_REQUIRED'}).waitFor();
    assert.equal((await listFaults(app.url, webHeaders)).length, 0, 'whitespace performed no injection');

    // (c) The exact token injects - the instruction on screen really is satisfiable.
    const token = (await page.locator('#fault-confirmation-hint').innerText()).replace(/^Required confirmation:\s*/, '').trim();
    await page.locator('#fault-confirmation').fill(token);
    await page.locator('#fault-start').click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('#fault-output')?.textContent || 'null')?.fault?.faultId !== undefined);
    const rows = await listFaults(app.url, webHeaders);
    assert.equal(rows.length, 1, 'the exact token injected exactly once');
    assert.equal(rows[0].nodeId, 'alpha');
    // The field is cleared after a successful injection, so a second accidental click cannot repeat it blind.
    assert.equal(await page.locator('#fault-confirmation').inputValue(), '', 'the confirmation is cleared after use');
  } finally {
    await browser?.close();
    await app?.close();
    await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}).catch(() => {});
  }
});

// S12: Export is a DIRECT_CONTROL the workbook names, and the capability must be usable WITHOUT a raw API call. Before
// this increment the artifact export existed only as an HTTP endpoint, so "Research without a console" was false for
// the one capability that produces the research deliverable. The control is exercised against a City that really holds
// a campaign receipt, so a green result means a file the operator can actually use.
test('REX807 S12: the Owner downloads the research artifact from the page, with no API call and no console', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rex807-export-web-'));
  let app, browser;
  try {
    await mkdir(resolve(dir, 'research', 'campaigns'), {recursive: true});
    await writeFile(resolve(dir, 'research', 'campaigns', 'campaign-5face000-0000-4000-8000-000000000001.json'), JSON.stringify({
      campaignId: 'campaign-5face000-0000-4000-8000-000000000001', scenarioId: 'WAIT', state: 'COMPLETED', reason: 'REPETITIONS_FINISHED',
      seedPolicy: 'derived:seed(campaign,index)', campaignSeed: 'export', repetitions: 1, warmup: 0, timeout: 30000, limits: {},
      totalRuns: 1, startedAt: 1000, finishedAt: 8000,
      runs: [{index: 0, state: 'MEASURED', reason: null, seed: 7, warmup: false, measured: true, durationMs: 7000, result: {taskRef: 'Q-5face000-0000-4000-8000-000000000001', state: 'COMPLETED', assignedNodeId: 's-worker', result: {waitedMs: 6000}}}],
      context: {experimentId: 'export-exp', manifestIdentity: 'id', manifest: {topology: 'TWO_HOST_MESH', hosts: ['s-worker'], workers: ['s-worker'], controlSurfaces: ['probe-surface'], repetitions: 1, seedPolicy: 'PER_REPETITION', baseSeed: 1, stopConditions: [], acceptance: {}, softwareRefs: []}, targetDeviceRef: null},
      summary: {planned: 1, accounted: 1, warmup: 0, measured: 1, timedOut: 0, failed: 0, excluded: 0, cancelled: 0, skipped: 0, interrupted: 0, terminalAccountingComplete: true},
    }, null, 2) + '\n');
    app = await createGateway({dir, port: 0, token: 'web-review', nodeToken: 'web-node', roomsDisabled: true});
    browser = await chromium.launch({channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true});
    const page = await browser.newPage({locale: 'en-US', acceptDownloads: true});
    await page.goto(app.url);
    await page.locator('#token').fill('web-review');
    await page.locator('#connect').click();
    await page.locator('#connection').filter({hasText: 'ONLINE'}).waitFor();
    await page.locator('[data-page="Research"]').click();
    await page.waitForFunction(() => document.querySelector('#research-export-json') && !document.querySelector('#research-export-json').disabled);
    // textContent, not innerText: the export details element is collapsed, and innerText of a collapsed element is
    // empty in this browser - which made a correct control look unrendered in the first run of this test.
    const status = () => page.locator('#research-export-status').evaluate(node => node.textContent);
    assert.match(await status(), /Owner session detected/, 'an owner session is stated, not assumed');
    // The page disables every control while a read is in flight, so a click during the initial list load is correctly
    // ignored. The test waits for the control to be actionable and retries instead of assuming a fixed delay.
    const download = async selector => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await page.waitForFunction(sel => !document.querySelector(sel).disabled, selector);
        // The export lives in a disclosure section; open it before pressing, exactly as an operator would. It is only
        // clicked when CLOSED: clicking the summary of an open disclosure closes it, which hid the button on the first
        // run of this test.
        if (!(await page.locator('#research-export').evaluate(node => node.open))) await page.locator('#research-export > summary').click();
        await page.locator(selector).waitFor({state: 'visible'});
        const [event] = await Promise.all([page.waitForEvent('download', {timeout: 8000}).catch(() => null), page.locator(selector).click()]);
        if (event) return event;
      }
      throw new Error(`no download was produced by ${selector}`);
    };

    const jsonDownload = await download('#research-export-json');
    const artifact = JSON.parse(await readFile(await jsonDownload.path(), 'utf8'));
    assert.equal(artifact.artifact.manifest.cityId, app.store.cityId, 'the downloaded artifact is the real export');
    assert.ok(Array.isArray(artifact.artifact.metrics) && artifact.artifact.metrics.length > 0, 'the artifact carries its metrics');
    assert.ok(Object.keys(artifact.checksums ?? {}).length > 0, 'the artifact carries checksums');
    assert.match(jsonDownload.suggestedFilename(), /^research-artifact-.*\.json$/, 'the download is named, not a blob id');
    assert.match(await status(), /Last export:/, 'the page reports what it exported');

    const csvDownload = await download('#research-export-csv');
    const csv = await readFile(await csvDownload.path(), 'utf8');
    assert.match(csv, /metric/i, 'the CSV export carries the metric table');
    assert.match(csvDownload.suggestedFilename(), /^research-metrics-.*\.csv$/);
  } finally {
    await browser?.close();
    await app?.close();
    await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}).catch(() => {});
  }
});
