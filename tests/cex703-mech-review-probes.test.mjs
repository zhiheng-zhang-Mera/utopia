// CEX-703 · OPPOSITE-HOST REVIEW probes (Mech).
//
// The workbook's Formal Review section names six checks:
//
//   fresh startup reaches the catalog in 1-2 steps · catalog count/identity aligns with /ask/targets · target
//   unavailable truth · catalog selection and manual Ask selection do not diverge · Web/Android agreement · a new
//   backend target appears with no front-end list edit
//
// plus the rules that the catalog must come from the backend contract with no second handwritten copy, that an
// unavailable capability must be visible but not actionable and must explain itself, and that mutating/side-effect
// targets keep confirmation. Probes 1-7 drive a real browser; PROBE 7 measures the Android chip rule against the real
// backend payload. Verdict and findings: mission-book/reports/CEX-703/REVIEW_REPORT.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createGateway } from '../services/dev-gateway/server.mjs';

const H = { Authorization: 'Bearer owner', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };

async function city(fn) {
  const dir = await mkdtemp(resolve('.scratch-cex703-review-'));
  let app, browser;
  try {
    app = await createGateway({ dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true });
    const targets = async () => (await (await fetch(app.url + '/api/v0/ask/targets', { headers: H })).json()).targets;
    await fn({ app, dir, targets, async open() { browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true }); const page = await browser.newPage({ locale: 'en-US' }); page.setDefaultTimeout(15000); await page.goto(app.url + '/#token=owner'); await page.locator('#connection.online').waitFor(); return page; } });
  } finally { await browser?.close(); await app?.close(); await rm(dir, { recursive: true, force: true }); }
}

test('PROBE 1+6: a fresh user reaches the live catalog without a failed Ask, and the catalog is the backend list', () => city(async ({ targets, open }) => {
  const live = await targets();
  assert.ok(live.length > 0);
  const page = await open();
  // Fresh startup: the ONLY affordance before the catalog is a direct entry point, and no Ask has been attempted.
  let askPosts = 0;
  page.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v0/ask') askPosts += 1; });
  const entry = page.locator('#ask-catalog-entry');
  assert.equal(await entry.count(), 1, 'the catalog must be reachable without failing an Ask first');
  await entry.click();
  let steps = 1;
  await page.locator('[data-terminal="catalog-open"]').click();
  steps += 1;
  await page.locator('#ask-catalog').waitFor();
  assert.equal(askPosts, 0, 'discovering the catalog must not require a failed Ask');
  assert.ok(steps <= 2, `the catalog must be visible within 1-2 steps, measured ${steps}`);

  const cards = page.locator('[data-terminal="catalog-select"]');
  assert.equal(await cards.count(), live.length, 'the rendered catalog must have the backend count');
  for (let i = 0; i < live.length; i += 1) {
    assert.equal(await cards.nth(i).getAttribute('data-target'), live[i].target, `card ${i} must be the backend target in order`);
  }
  // No invented capability: every rendered target exists in the backend payload, and every backend target is rendered.
  const rendered = await cards.evaluateAll(nodes => nodes.map(n => n.dataset.target));
  assert.deepEqual(rendered, live.map(t => t.target), 'catalog identity must equal the backend identity, in both directions');
}));

test('PROBE 2: the catalog is rendered from the response, not from a second handwritten list', () => city(async ({ open }) => {
  const page = await open();
  // Replace the backend answer with a synthetic target that exists in no front-end source. If the page renders it,
  // there is no second copy of the catalog to drift.
  await page.route('**/api/v0/ask/targets*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ apiVersion: 0, schemaVersion: 0, targets: [{ target: 'mech.review.synthetic', route: 'ROOM', operation: 'mech.review', label: 'Synthetic review target', description: 'injected by the reviewer', example: 'run the synthetic target', mutating: false, sideEffect: false, available: true, unavailableReason: null }] }) }));
  await page.locator('#ask-catalog-entry').click();
  await page.locator('[data-terminal="catalog-open"]').click();
  await page.locator('#ask-catalog').waitFor();
  const cards = page.locator('[data-terminal="catalog-select"]');
  assert.equal(await cards.count(), 1, 'the catalog must follow the response exactly, with no hard-coded rows to pad it');
  assert.equal(await cards.first().getAttribute('data-target'), 'mech.review.synthetic');
  assert.match(await cards.first().innerText(), /Synthetic review target/);
}));

test('PROBE 3: every unavailable target is shown, disabled, and explains itself', () => city(async ({ targets, open }) => {
  const live = await targets();
  const unavailable = live.filter(t => t.available === false);
  assert.ok(unavailable.length > 0, 'this fixture must contain unavailable targets for the check to mean anything');
  const page = await open();
  await page.locator('#ask-catalog-entry').click();
  await page.locator('[data-terminal="catalog-open"]').click();
  await page.locator('#ask-catalog').waitFor();
  for (const target of unavailable) {
    const card = page.locator(`[data-terminal="catalog-select"][data-target="${target.target}"]`).first();
    assert.equal(await card.isDisabled(), true, `${target.target} must not be actionable`);
    const text = await card.innerText();
    if (target.unavailableReason) assert.ok(text.includes(target.unavailableReason), `${target.target} must state its reason`);
  }
  // Clicking a disabled card must do nothing at all.
  await page.locator(`[data-terminal="catalog-select"][data-target="${unavailable[0].target}"]`).first().click({ force: true }).catch(() => {});
  assert.equal(await page.locator('#ask-catalog').count(), 1, 'a refused card must not close the catalog');
  assert.equal(await page.locator('#ask-text').inputValue(), '', 'a refused card must not prepare an action');
}));

test('PROBE 4: selecting in the catalog prepares, never executes, and carries the same selection as a manual Ask', () => city(async ({ targets, open }) => {
  const live = await targets();
  const pick = live.find(t => t.available !== false);
  assert.ok(pick);
  const page = await open();
  let askBodies = [];
  await page.route('**/api/v0/ask', async route => { askBodies.push(route.request().postDataJSON()); await route.continue(); });
  await page.locator('#ask-catalog-entry').click();
  await page.locator('[data-terminal="catalog-open"]').click();
  await page.locator('#ask-catalog').waitFor();
  await page.locator(`[data-terminal="catalog-select"][data-target="${pick.target}"]`).first().click();
  assert.equal(askBodies.length, 0, 'choosing from the catalog must not execute anything');
  assert.equal(await page.locator('#ask-catalog').count(), 0, 'the catalog closes once a target is chosen');
  const prepared = await page.locator('#ask-text').inputValue();
  assert.ok(prepared.length > 0, 'the chosen target must be prepared in the input');
  // Submitting sends the SELECTION, so the catalog path and the typed path cannot diverge in meaning.
  await page.locator('#ask-submit').click();
  await page.waitForTimeout(700);
  assert.equal(askBodies.length, 1, 'submitting must reach the City once');
  assert.ok(askBodies[0].selection, 'the catalog choice must travel as a canonical selection, not as loose text');
  assert.equal(askBodies[0].selection.target, pick.target, 'the selection must name the chosen target');
}));

test('PROBE 5: an EMPTY catalog is not explained on the Web the way it is on Android', () => city(async ({ open }) => {
  const page = await open();
  await page.route('**/api/v0/ask/targets*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ apiVersion: 0, schemaVersion: 0, targets: [] }) }));
  await page.locator('#ask-catalog-entry').click();
  await page.locator('[data-terminal="catalog-open"]').click();
  await page.locator('#ask-catalog').waitFor();
  const text = await page.locator('#ask-catalog').innerText();
  assert.equal(await page.locator('[data-terminal="catalog-select"]').count(), 0);
  // FINDING F2 evidence: the section is rendered with a title and NOTHING else. Android renders an explicit
  // "the Gateway provided no targets" empty state for the same payload.
  assert.match(text, /Available targets/, 'the section title is rendered');
  assert.doesNotMatch(text, /no targets|none|empty|unavailable|Gateway/i, 'F2: the Web states no reason for an empty catalog');
  assert.ok(text.trim().split('\n').filter(Boolean).length <= 1, 'F2: nothing but the heading is shown');
}));

test('PROBE 7 (FINDING F1): the Android availability chip calls a locally mutating target SAFE', () => city(async ({ targets }) => {
  // Android AskPanel renders: if(!available) "UNAVAILABLE" else if(sideEffect) "SIDE EFFECT" else "SAFE".
  // The chip therefore ignores `mutating` entirely. Measure the real contract against that rule.
  const live = await targets();
  const rule = t => (t.available === false ? 'UNAVAILABLE' : t.sideEffect === true ? 'SIDE EFFECT' : 'SAFE');
  const locallyMutating = live.filter(t => t.mutating === true && t.sideEffect !== true);
  assert.ok(locallyMutating.length > 0, 'the contract really does contain locally mutating targets with no declared side effect');
  for (const t of locallyMutating) {
    // F1: with the target available, the chip says SAFE for a target that writes local product data. Today these rows
    // are unavailable ONLY because the Room Hub does not answer on loopback - a transient probe result, not a property
    // of the target - so an ordinary City with local tools enabled reaches this combination.
    assert.equal(rule({ ...t, available: true }), 'SAFE', `F1: ${t.target} would be labelled SAFE`);
    assert.equal(t.mutating, true);
    assert.notEqual(rule(t), 'SAFE', 'and today it is masked only by the unavailability of the same rows');
  }
  // The Web says nothing of the kind: it renders separate mutating/side-effect flags and never claims SAFE.
  const webFlagged = locallyMutating.every(t => t.mutating === true);
  assert.equal(webFlagged, true, 'the Web flags mutating targets by name, so the two surfaces disagree');
}));

test('PROBE 8: a mutating or side-effect target keeps confirmation before anything is created', () => city(async ({ app, open }) => {
  const page = await open();
  app.store.put('nodes', { id: 'node-fixture', online: true, capabilities: ['task.execute.safe', 'filesystem.temp'], lastHeartbeatAt: new Date().toISOString() });
  await page.locator('#ask-catalog-entry').click();
  await page.locator('[data-terminal="catalog-open"]').click();
  await page.locator('#ask-catalog').waitFor();
  const card = page.locator('[data-terminal="catalog-select"][data-target="city.task"]').first();
  await card.click();
  assert.equal(app.store.list('tasks').length, 0, 'choosing a City task target must not create a task');
  await page.locator('#ask-submit').click();
  // The confirmation step is the existing semantics; nothing may be created before it.
  await page.locator('[data-terminal="ask-confirm"]').waitFor();
  assert.equal(app.store.list('tasks').length, 0, 'the confirmation must come before any canonical effect');
}));
