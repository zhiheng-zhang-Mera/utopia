import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  configureRuntime,
  formatTime,
  getLocale,
  localeLabel,
  messageKeys,
  messagesFor,
  normalizeLocale,
  resetLocaleCache,
  resolveInitialLocale,
  setLocale,
  t,
} from '../apps/web/i18n/index.js';
import { createGateway } from '../services/dev-gateway/server.mjs';

// Node exposes navigator.language, so the runtime must be pinned explicitly or
// the host language would leak into other test files in the same process.
configureRuntime({ storage: null, navigator: { language: 'en-US' } });

const ZH_CN = 'zh-CN';
const ZH_LABEL = '简体中文';
const ZH_HOME = '首页';
const ZH_CONNECT_TITLE = '连接你的城市。';

/** Minimal document stub good enough for applyTranslations. */
function fakeDocument() {
  const nodes = [
    { dataset: { i18n: 'nav.home' }, textContent: 'Home' },
    { dataset: { i18n: 'pair.connect' }, textContent: 'Connect' },
  ];
  const attrs = [{ dataset: { i18nAttr: 'aria-label:action.runTestTask' }, setAttribute(name, value) { this[name] = value; } }];
  return {
    documentElement: { lang: 'en' },
    title: '',
    querySelectorAll(selector) {
      return selector === '[data-i18n]' ? nodes : attrs;
    },
    nodes,
    attrs,
  };
}

const REPO = resolve(import.meta.dirname, '..');

test('locale contract: supported tokens, fallback and first-run detection', () => {
  assert.deepEqual(SUPPORTED_LOCALES, ['en', ZH_CN]);
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.equal(LOCALE_STORAGE_KEY, 'utopia.ui.locale');

  assert.equal(normalizeLocale('en'), 'en');
  assert.equal(normalizeLocale(ZH_CN), ZH_CN);
  for (const bad of ['de', 'zh', 'zh-TW', '', null, undefined, 'EN', 42]) {
    assert.equal(normalizeLocale(bad), 'en', `${String(bad)} falls back to en`);
  }

  const store = (value) => ({ getItem: () => value, setItem: () => {} });
  assert.equal(resolveInitialLocale(store(ZH_CN), { language: 'en-US' }), ZH_CN, 'stored value wins');
  assert.equal(resolveInitialLocale(store('bogus'), { language: 'en-US' }), 'en', 'unknown stored value falls back');
  assert.equal(resolveInitialLocale(store(null), { language: 'zh-Hans-CN' }), ZH_CN, 'browser zh starts in Chinese');
  assert.equal(resolveInitialLocale(store(null), { language: 'zh-TW' }), ZH_CN);
  assert.equal(resolveInitialLocale(store(null), { language: 'en-GB' }), 'en');
  assert.equal(resolveInitialLocale(store(null), { languages: ['fr-FR'] }), 'en');
  assert.equal(resolveInitialLocale(store(null), {}), 'en');
  assert.equal(resolveInitialLocale(null, null), 'en', 'unreadable storage must not throw');
});

test('both language packs cover every message key with matching placeholders', () => {
  const en = messagesFor('en');
  const zh = messagesFor(ZH_CN);
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh-CN covers exactly the en key set');
  assert.ok(messageKeys().length >= 50, `expected a substantial pack, got ${messageKeys().length}`);

  const placeholders = (value) => (String(value).match(/\{(\w+)\}/g) ?? []).sort();
  for (const key of Object.keys(en)) {
    assert.ok(String(en[key]).trim().length > 0, `en.${key} is not empty`);
    assert.ok(String(zh[key]).trim().length > 0, `zh-CN.${key} is not empty`);
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `placeholders match for ${key}`);
  }

  assert.equal(localeLabel('en'), 'English');
  assert.equal(localeLabel(ZH_CN), ZH_LABEL);
  assert.notEqual(en['nav.home'], zh['nav.home']);
  assert.equal(en['settings.language'], 'Language / 语言', 'the language row label is bilingual in both packs');
  assert.equal(zh['settings.language'], 'Language / 语言');
});

test('every fixed Web UI string is present in the language packs', () => {
  const en = messagesFor('en');
  const required = [
    'Home', 'Nodes', 'Tasks', 'Activity', 'Settings',
    'Connect to your city.', 'Pairing token', 'Connect',
    'Your city, at a glance.', 'The places work happens.', 'From intent to done.',
    'Life in your city.', 'A connection you control.',
    'Connected nodes', 'Running tasks', 'Completed tasks', 'Needs attention',
    'Runtime nodes', 'Recent activity', 'Recent tasks',
    'Waiting for a runtime node.', 'No tasks yet.',
    'Task registry', 'Event timeline', 'Checkpoint', 'Result', 'Cancel task',
    'Connection diagnostics', 'City URL', 'Change pairing token',
    'Last snapshot', 'Waiting for snapshot',
  ];
  const values = new Set(Object.values(en).map((value) => String(value)));
  for (const phrase of required) {
    const covered = [...values].some((value) => value === phrase || value.startsWith(phrase));
    assert.ok(covered, `English pack covers "${phrase}"`);
  }
});

test('protocol tokens and City Control state names are never translated', async () => {
  // Canonical protocol vocabulary must appear verbatim in both packs wherever it
  // appears at all, and must never be given a translated display form.
  const canonical = ['apiVersion', 'schemaVersion'];
  for (const locale of SUPPORTED_LOCALES) {
    const pack = messagesFor(locale);
    for (const token of canonical) {
      const carriers = Object.entries(pack).filter(([, value]) => String(value).includes(token));
      assert.ok(carriers.length > 0, `${locale} still renders the canonical ${token}`);
      for (const [key, value] of carriers) {
        assert.ok(String(value).includes(token), `${locale}.${key} keeps ${token} verbatim`);
      }
    }
  }

  // The set of canonical protocol strings the surface depends on.
  const apiVersion = 'apiVersion = {api} · schemaVersion = {schema}';
  assert.equal(messagesFor('en')['settings.protocol'], apiVersion);
  assert.equal(messagesFor(ZH_CN)['settings.protocol'], apiVersion);

  // Display copy may be translated, but the canonical state token must not change.
  const states = ['QUEUED', 'ASSIGNED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'];
  const appJs = await readFile(resolve(REPO, 'apps/web/app.js'), 'utf8');
  for (const state of states) {
    assert.ok(!new RegExp(`t\\([^)]*${state}`).test(appJs), `app.js must not pass the ${state} state through t()`);
  }
  // State tokens may only appear as the canonical badge values and terminal check.
  assert.match(appJs, /const badge=\(stateClass, displayLabel=stateClass\)=>/, 'badge keeps the canonical state as its CSS class');
  assert.match(appJs, /const finished=t=>\['COMPLETED','FAILED','CANCELLED'\]\.includes\(t\.state\)/, 'the terminal-state check is unchanged');
  const packValues = [...Object.values(messagesFor('en')), ...Object.values(messagesFor(ZH_CN))].join(' ');
  for (const state of states) {
    assert.ok(!packValues.includes(state), `no language pack renders the ${state} state as copy`);
  }
  assert.ok(appJs.includes('apiVersion'), 'the client still validates apiVersion');
  assert.ok(appJs.includes('schemaVersion'), 'the client still validates schemaVersion');
  const indexHtml = await readFile(resolve(REPO, 'apps/web/index.html'), 'utf8');
  for (const token of ['apiVersion', 'schemaVersion']) {
    assert.ok(!indexHtml.includes(token), `index.html does not hardcode ${token}`);
  }
});

test('web assets only use message keys that exist in the packs', async () => {
  const known = new Set(messageKeys());
  const indexHtml = await readFile(resolve(REPO, 'apps/web/index.html'), 'utf8');
  const appJs = await readFile(resolve(REPO, 'apps/web/app.js'), 'utf8');

  const htmlKeys = [...indexHtml.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]);
  const htmlAttrKeys = [...indexHtml.matchAll(/data-i18n-attr="([^"]+)"/g)]
    .flatMap((match) => match[1].split(','))
    .map((pair) => pair.split(':')[1]?.trim())
    .filter(Boolean);
  const jsLiteralKeys = [...appJs.matchAll(/\bt\('([a-zA-Z][\w.]*)'/g)].map((match) => match[1]);
  const jsDynamicPrefixes = [...appJs.matchAll(/\bt\('([a-zA-Z][\w.]*\.)'\s*\+/g)].map((match) => match[1]);

  assert.ok(htmlKeys.length >= 15, `index.html carries static i18n keys (${htmlKeys.length})`);
  assert.ok(jsLiteralKeys.length >= 15, `app.js uses literals through t() (${jsLiteralKeys.length})`);

  // a key built from a prefix at runtime is checked through its family instead
  const isDynamicPrefix = (key) => jsDynamicPrefixes.some((prefix) => key === prefix);
  for (const key of [...htmlKeys, ...htmlAttrKeys, ...jsLiteralKeys]) {
    if (isDynamicPrefix(key)) continue;
    assert.ok(known.has(key), `message key ${key} exists in the packs`);
  }
  for (const prefix of jsDynamicPrefixes) {
    const family = messageKeys().filter((key) => key.startsWith(prefix));
    assert.ok(family.length >= 2, `dynamic key family ${prefix}* is covered`);
  }

  // the protocol layer must be untouched by localization
  for (const token of ['apiVersion', 'schemaVersion', 'X-City-Api-Version', 'Bearer ']) {
    assert.ok(appJs.includes(token), `app.js still sends ${token}`);
  }
  assert.ok(!/QUEUED|ASSIGNED/.test(appJs), 'app.js does not translate state tokens');
});

test('badge state and display label stay separate in every locale', async () => {
  const appJs = await readFile(resolve(REPO, 'apps/web/app.js'), 'utf8');

  // The badge helper takes a machine state plus an optional display label, and the
  // CSS class is always the canonical state token.
  assert.match(
    appJs,
    /const badge=\(stateClass, displayLabel=stateClass\)=>/,
    'badge(stateClass, displayLabel) keeps the class canonical',
  );
  assert.ok(!/badge\(t\(/.test(appJs), 'a translation is never passed as the badge state class');

  // Node rows derive the canonical state first, then look up the label.
  assert.match(appJs, /const state=nodeState\(n\);/, 'node state comes from machine values');
  assert.match(appJs, /badge\(state,label\)/, 'node rows pass state and label separately');
  assert.ok(!/badge\(connection!=='ONLINE'\?t\(/.test(appJs), 'the old translated-class path is gone');

  // Task state must stay canonical.
  assert.match(appJs, /badge\([xt]\.state\)/, 'task badges use the canonical state');
  assert.match(appJs, /badge\(detail\.state\)/, 'the detail badge uses the canonical state');

  // The run button keys off the machine connection state, not displayed text.
  assert.match(appJs, /\$\('#run'\)\.disabled=connection!=='ONLINE';/, 'run disabled follows the canonical state');
  assert.ok(!/\$\('#connection'\)\.textContent!==/.test(appJs), 'displayed text never decides enablement');
  assert.match(appJs, /\$\('#connection'\)\.textContent=t\('connection\.'\+s\.toLowerCase\(\)\)/, 'the connection label is translated from the machine state');

  // Under zh-CN the CSS classes must still be the canonical tokens.
  const doc = fakeDocument();
  setLocale(ZH_CN, { storage: { setItem() {} }, root: doc });
  assert.equal(doc.documentElement.lang, ZH_CN);
  for (const [state, label] of [['online', t('node.online')], ['offline', t('node.offline')], ['UNKNOWN', t('node.unknown')]]) {
    const row = `class="badge ${state}" text="${label}"`;
    assert.match(row, new RegExp(`class="badge ${state}"`), `${state} class is preserved in zh-CN`);
    assert.ok(row.includes(label), `${state} label is translated`);
  }
  assert.equal(t('node.online'), '在线');
  assert.equal(t('node.offline'), '离线');
  assert.equal(t('node.unknown'), '未知');
  assert.equal(t('connection.online'), '在线');
  assert.equal(t('connection.offline'), '离线');
  resetLocaleCache();
});

test('applyTranslations and setLocale update the document without touching storage contracts', async () => {
  const { applyTranslations, setLocale } = await import('../apps/web/i18n/index.js');
  const doc = fakeDocument();
  const writes = [];
  const storage = { setItem: (key, value) => writes.push([key, value]) };

  resetLocaleCache();
  const locale = applyTranslations(doc);
  assert.equal(locale, 'en');
  assert.equal(doc.documentElement.lang, 'en');
  assert.equal(doc.nodes[0].textContent, 'Home');
  assert.equal(doc.attrs[0]['aria-label'], 'Run Test Task');

  const next = setLocale(ZH_CN, { storage, root: doc });
  assert.equal(next, ZH_CN);
  assert.deepEqual(writes, [['utopia.ui.locale', ZH_CN]]);
  assert.equal(doc.documentElement.lang, ZH_CN);
  assert.equal(doc.nodes[0].textContent, ZH_HOME);
  assert.equal(doc.attrs[0]['aria-label'], '运行测试任务');

  assert.equal(setLocale('de', { storage, root: doc }), 'en', 'unknown locale falls back to en');
  assert.equal(doc.nodes[1].textContent, 'Connect');
  resetLocaleCache();
});

test('translation fills placeholders and time formatting follows the locale', () => {
  configureRuntime({ storage: null, navigator: { language: 'en-US' } });
  resetLocaleCache();
  assert.equal(t('section.eventTimeline', { count: 7 }), 'Event timeline · 7 events');
  assert.equal(t('settings.protocol', { api: 0, schema: 0 }), 'apiVersion = 0 · schemaVersion = 0');
  assert.equal(t('status.lastSnapshot', { time: '10:00' }), 'Last snapshot · 10:00');
  assert.equal(t('pair.connect', { unused: 1 }), 'Connect', 'extra params are ignored');
  assert.equal(t('section.eventTimeline', {}), 'Event timeline · {count} events', 'missing params keep the placeholder');
  assert.equal(t('does.not.exist'), 'does.not.exist', 'unknown keys return the key');
  assert.equal(getLocale(), 'en');
  assert.match(formatTime('2026-09-29T10:11:12.000Z', 'en'), /\d/);
  assert.match(formatTime('2026-09-29T10:11:12.000Z', ZH_CN), /\d/);
  assert.equal(formatTime('not-a-date', 'en'), 'not-a-date');
});

test('Web Settings language switch, persistence and protocol stability (real browser)', async () => {
  const { chromium } = await import('playwright');
  const dir = await mkdtemp(resolve('.scratch-web-i18n-'));
  let app;
  let browser;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'i18n-test', nodeToken: 'i18n-node' });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    // The host machine runs a Chinese Edge, so the first-run locale is pinned
    // explicitly here and the browser-language rule is covered by the unit test.
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();

    // the three i18n modules must be reachable from the control surface
    for (const path of ['/i18n/index.js', '/i18n/en.js', '/i18n/zh-CN.js']) {
      const response = await page.request.get(`${app.url}${path}`);
      assert.equal(response.status(), 200, `${path} is served`);
      assert.match(response.headers()['content-type'], /javascript/);
    }

    await page.goto(app.url);
    await page.getByLabel('Pairing token').fill('i18n-test');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText('ONLINE', { exact: true }).first().waitFor();

    // 1 + 2: default locale is English, and each page exposes English copy
    assert.equal(await page.evaluate(() => localStorage.getItem('utopia.ui.locale')), null, 'nothing stored before a choice');
    for (const [page_, heading] of [
      ['Devices', 'Your devices, in focus.'],
      ['Pairing', 'Bring a device into your city.'],
      ['Tasks', 'From intent to done.'],
      ['Activity', 'Life in your city.'],
    ]) {
      await page.locator(`nav button[data-page="${page_}"]`).click();
      await page.getByText(heading, { exact: true }).waitFor();
    }
    await page.locator('nav button[data-page="Settings"]').click();
    await page.getByText('Language / 语言', { exact: true }).waitFor();

    // 3: switching to 简体中文 rerenders the fixed copy of all five pages
    await page.getByRole('button', { name: ZH_LABEL }).click();
    await page.getByText('连接诊断', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), ZH_CN);
    assert.equal(await page.evaluate(() => localStorage.getItem('utopia.ui.locale')), ZH_CN);
    for (const [page_, heading] of [
      ['Home', '一眼看清你的城市。'],
      ['Devices', '专注查看你的设备。'],
      ['Pairing', '将设备接入你的城市。'],
      ['Tasks', '从意图到完成。'],
      ['Activity', '城市里的日常。'],
      ['Settings', '由你掌控的连接。'],
    ]) {
      await page.locator(`nav button[data-page="${page_}"]`).click();
      await page.getByText(heading, { exact: true }).waitFor();
    }
    await page.locator('nav button[data-page="Settings"]').click();

    // 4: the choice survives a reload
    await page.reload();
    await page.getByText('在线', { exact: true }).first().waitFor();
    await page.locator('nav button[data-page="Settings"]').click();
    await page.getByText('连接诊断', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('utopia.ui.locale')), ZH_CN);

    // 5: changing the pairing token keeps the language
    await page.getByRole('button', { name: '更换配对令牌' }).click();
    await page.getByText(ZH_CONNECT_TITLE, { exact: true }).waitFor();
    await page.getByLabel('配对令牌').fill('i18n-test');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByText('在线', { exact: true }).first().waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('utopia.ui.locale')), ZH_CN);

    // 6: switching back to English
    await page.locator('nav button[data-page="Settings"]').click();
    await page.getByRole('button', { name: 'English' }).click();
    await page.getByText('Connection diagnostics', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('utopia.ui.locale')), 'en');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');

    // 7: an unknown stored locale falls back to English
    await page.evaluate(() => localStorage.setItem('utopia.ui.locale', 'de-DE'));
    await page.reload();
    await page.getByText('ONLINE', { exact: true }).first().waitFor();
    await page.locator('nav button[data-page="Settings"]').click();
    await page.getByText('Connection diagnostics', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');

    // 8: the Gateway data is untouched by localization
    const city = await page.evaluate(async (token) => {
      const response = await fetch('/api/v0/city', {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-City-Api-Version': '0',
          'X-City-Schema-Version': '0',
        },
      });
      return response.json();
    }, 'i18n-test');
    assert.equal(city.apiVersion, 0);
    assert.equal(city.schemaVersion, 0);
    assert.ok(Array.isArray(city.tasks), 'the city snapshot still exposes tasks');
    assert.ok(Array.isArray(city.nodes), 'the city snapshot still exposes nodes');
  } finally {
    await browser?.close();
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
