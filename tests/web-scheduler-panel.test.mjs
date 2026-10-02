// UXI-301 steps 2/3/5/6: the Web scheduler status panel.
//
// The panel is a pure string builder, so the rendering RULES are testable here against real contract
// DTOs rather than only in a browser. The rules asserted are the workbook's acceptance items:
//   - major scheduler states render in USER LANGUAGE;
//   - an unavailable provider is VISIBLE but NOT CLICKABLE;
//   - NO raw scheduler field leaks by default, with technical detail behind an expandable Advanced;
//   - an unreported feed must never look like a healthy one.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {schedulerPanel, esc} from '../apps/web/scheduler.js';
import {buildPresentationFeed} from '../services/dev-gateway/presentation.mjs';
import {PRESENTATION_STATES, TERMS} from '../contracts/rs-presentation-contract-v1/presentation.mjs';
import {configureRuntime, getLocale, messagesFor, resetLocaleCache, t} from '../apps/web/i18n/index.js';

const useLocale = (locale) => {
  configureRuntime({storage: null, navigator: {language: locale}});
  resetLocaleCache();
};
useLocale('en');

const node = (id, telemetry, online = true) => ({id, online, telemetry});
const healthy = (id = 'healthy') => node(id, {cpu: {usagePercent: 19.7}, memory: {usedBytes: 22.4e9, totalBytes: 31.8e9}});
const hot = (id = 'hot') => node(id, {cpu: {usagePercent: 99}, memory: {usedBytes: 31e9, totalBytes: 31.8e9}});
const offline = (id = 'offline') => node(id, {cpu: {usagePercent: 5}, memory: {usedBytes: 1e9, totalBytes: 8e9}}, false);

const feedFor = (tasks, nodes) => buildPresentationFeed({tasks, nodes, generatedAt: '2026-10-02T00:00:00.000Z'});

test('UXI-301 panel: a state renders in user language, not as a token', () => {
  const html = schedulerPanel(feedFor([{id: 't1', state: 'RUNNING'}], [healthy()]));
  assert.match(html, /class="panel scheduler-panel"/);
  assert.match(html, new RegExp(esc(t('scheduler.panel.title'))));
  // The healthy node is available, so the panel says so rather than showing a token.
  assert.match(html, new RegExp(esc(t('scheduler.panel.providerAvailable'))));
  assert.doesNotMatch(html, /SELECTABLE/, 'the mapped term must not be printed');
});

test('UXI-301 panel: NO raw scheduler vocabulary appears in the default HTML', () => {
  // The strongest form of the acceptance item: sweep every term AND every state token through a real
  // feed and search the rendered HTML for each. Case-sensitive, because the copy is prose.
  const nodes = [healthy('a'), hot('b'), offline('c'), node('d', null)];
  const tasks = [{id: 't1', state: 'RUNNING'}, {id: 't2', state: 'QUEUED'}, {id: 't3', state: 'FAILED'}];
  const html = schedulerPanel(feedFor(tasks, nodes));
  const leaked = [...new Set([...TERMS, ...PRESENTATION_STATES])].filter((token) => html.includes(token));
  assert.deepEqual(leaked, [], `raw scheduler tokens reached the UI: ${leaked.join(', ')}`);
  // And the technical disclosure is absent entirely unless asked for.
  assert.equal(html.includes('scheduler-technical'), false);
});

test('UXI-301 panel: an unavailable provider is visible with its reason and is NOT a control', () => {
  const html = schedulerPanel(feedFor([{id: 't1', state: 'RUNNING'}], [healthy('ok'), offline('gone'), hot('busy')]));
  const items = html.match(/<li class="scheduler-provider[^"]*"[^>]*>.*?<\/li>/g) ?? [];
  assert.equal(items.length, 3, 'every candidate is shown, available or not');
  const unavailable = items.filter((i) => i.includes('data-selectable="false"'));
  assert.equal(unavailable.length, 2, 'the offline and the saturated node are both shown as unavailable');
  for (const item of unavailable) {
    // No control of any kind inside an unavailable provider: not a button, not a link, not an input.
    assert.doesNotMatch(item, /<button|<a\s|<input|data-scheduler-action|onclick=/, 'an unavailable provider must not be interactive');
    assert.match(item, new RegExp(esc(t('scheduler.panel.providerUnavailable'))), 'it must say why it is unavailable');
  }
  assert.equal(items.filter((i) => i.includes('data-selectable="true"')).length, 1);
});

test('UXI-301 panel: actions carry the token for wiring and the LABEL in user language', () => {
  const html = schedulerPanel(feedFor([{id: 't1', state: 'RUNNING'}], [offline()]));
  const buttons = html.match(/<button class="scheduler-action[^"]*" data-scheduler-action="([A-Z_]+)">([^<]*)<\/button>/g) ?? [];
  assert.ok(buttons.length > 0, 'a structurally refused fleet must offer an action');
  for (const b of buttons) {
    const token = /data-scheduler-action="([A-Z_]+)"/.exec(b)[1];
    const label = />([^<]*)<\/button>/.exec(b)[1];
    assert.match(token, /^[A-Z_]+$/);
    assert.ok(!label.includes(token), `the label must be user language, not the token (${b})`);
    assert.ok(label.trim().length > 0);
  }
});

test('UXI-301 panel: a decision is asked for only when the feed requires one', () => {
  const demanded = schedulerPanel(feedFor([{id: 't1', state: 'RUNNING'}], [offline()]));
  assert.match(demanded, new RegExp(esc(t('scheduler.choice.prompt'))), 'a structural refusal asks the user');
  const notDemanded = schedulerPanel(feedFor([{id: 't1', state: 'RUNNING'}], [healthy()]));
  assert.doesNotMatch(notDemanded, new RegExp(esc(t('scheduler.choice.prompt'))), 'a usable provider must not ask');
});

test('UXI-301 panel: technical detail appears ONLY behind the explicit Advanced disclosure', () => {
  const feed = feedFor([{id: 't1', state: 'RUNNING'}], [healthy()]);
  const plain = schedulerPanel(feed);
  assert.equal(plain.includes('scheduler-technical'), false);
  const advanced = schedulerPanel(feed, {advanced: true});
  assert.match(advanced, /<details class="scheduler-technical"><summary>/);
  // In advanced mode the raw vocabulary IS allowed, which is why the disclosure is the single gate.
  assert.match(advanced, /SELECTABLE/);
});

test('UXI-301 panel: an unreported feed never looks like a healthy or idle one', () => {
  const offlineHtml = schedulerPanel(feedFor([{id: 't1', state: 'RUNNING'}], [healthy()]), {isOnline: false});
  assert.match(offlineHtml, new RegExp(esc(t('scheduler.panel.offline'))));
  assert.doesNotMatch(offlineHtml, /scheduler-task/, 'no status is rendered while disconnected');

  const missing = schedulerPanel(null);
  assert.match(missing, new RegExp(esc(t('scheduler.panel.feedUnavailable'))), 'a missing feed says so');
  assert.doesNotMatch(missing, new RegExp(esc(t('scheduler.panel.idle'))), 'and must NOT claim there is nothing to run');

  const malformed = schedulerPanel({tasks: 'not-an-array'});
  assert.match(malformed, new RegExp(esc(t('scheduler.panel.feedUnavailable'))));

  const empty = schedulerPanel(feedFor([], [healthy()]));
  assert.match(empty, new RegExp(esc(t('scheduler.panel.idle'))));
  assert.doesNotMatch(empty, /scheduler-task/);
});

test('UXI-301 panel: all text is escaped, including ids from the feed', () => {
  const html = schedulerPanel({
    tasks: [{taskId: '<script>alert(1)</script>', taskState: 'RUNNING', dto: {state: 'RUNNING', providers: [], actions: [], provider_choice_required: false}}],
  });
  assert.doesNotMatch(html, /<script>/, 'a hostile id must not become markup');
  assert.match(html, /&lt;script&gt;/);
  assert.equal(esc('a"b\'c<d>&'), 'a&quot;b&#39;c&lt;d&gt;&amp;');
});

test('UXI-301 panel: the panel renders in zh-CN as well as en', () => {
  useLocale('en');
  const feed = feedFor([{id: 't1', state: 'RUNNING'}], [offline()]);
  const en = schedulerPanel(feed, {advanced: true});
  useLocale('zh-CN');
  const zh = schedulerPanel(feed, {advanced: true});
  assert.notEqual(en, zh, 'the panel must follow the active locale');
  assert.match(zh, /[\u4e00-\u9fff]/, 'zh-CN copy should contain Han characters');
  assert.equal(getLocale(), 'zh-CN');
  useLocale('en');
});

test('UXI-301 panel: every copy key the panel uses exists in both locale packs', () => {
  // The key list is EXTRACTED FROM THE MODULE SOURCE rather than hand-written. My first version listed
  // the keys by hand and included a stale name left over from a rename, so the guard failed on its own
  // bookkeeping instead of on the panel. Deriving them means it cannot go stale.
  const source = readFileSync(new URL('../apps/web/scheduler.js', import.meta.url), 'utf8');
  // NOTE: the character class includes A-Z. My first version used [a-z0-9_.] and silently skipped every
  // camelCase key such as `providerAvailable`, so it found 5 keys instead of the real set - a narrow
  // regex reporting a plausible number is the same fault as a scan that reports a comfortable zero.
  const used = [...new Set([...source.matchAll(/t\('([A-Za-z0-9_.]+)'\)/g)].map((m) => m[1]))];
  assert.ok(used.length > 5, `expected the panel to reference several copy keys, found ${used.length}`);
  assert.ok(used.every((k) => k.startsWith('scheduler.')), 'the panel should only use scheduler copy');
  for (const locale of ['en', 'zh-CN']) {
    const pack = messagesFor(locale);
    const missing = used.filter((k) => !(k in pack));
    assert.deepEqual(missing, [], `${locale} is missing: ${missing.join(', ')}`);
  }
});
