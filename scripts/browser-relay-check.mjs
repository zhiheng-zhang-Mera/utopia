// REAL BROWSER CHECK (Edge over CDP, no new dependencies).
//
// WHY THIS EXISTS SEPARATELY FROM THE UNIT TESTS: this project has already been bitten three times by defects that
// ONLY a real browser could see - a frozen object being assigned to (which crashed the whole page), a re-render that
// destroyed the button between mousedown and click, and a missing import that stopped the module from initialising
// at all. Unit tests import modules; they never load the page. So this script loads the actual pages in the actual
// browser, listens for page errors, and drives the two cross-PC paths a person uses.
//
// WHAT IT DOES NOT DO: it is not an acceptance run on two real PCs. Both "PCs" are this machine, and the second one
// is the same browser page navigated to the link (a second tab shares sessionStorage, which would make it look
// already-connected and hide the very entry point being checked).
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { dialRelay } from '../apps/web/relay-dial.mjs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const V = { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
const owner = token => ({ ...V, Authorization: `Bearer ${token}` });
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(url) { this.url = url; this.next = 1; this.pending = new Map(); }
  async open() {
    const { WebSocket } = await import('ws');
    this.socket = new WebSocket(this.url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.socket.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      }
    });
    await new Promise((done, fail) => { this.socket.once('open', done); this.socket.once('error', fail); });
  }
  send(method, params = {}) { const id = this.next++; return new Promise((done, fail) => { this.pending.set(id, { resolve: done, reject: fail }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
    return r.result?.value;
  }
  close() { try { this.socket?.close(); } catch { /* gone */ } }
}

const dirA = await mkdtemp(resolve('.scratch-browser-a-'));
const dirB = await mkdtemp(resolve('.scratch-browser-b-'));
const userDir = await mkdtemp(resolve('.scratch-browser-profile-'));
const port = 9333 + (process.pid % 500);
const cityA = await createGateway({ host: '127.0.0.1', port: 0, dir: dirA, token: 'browser-a-control', nodeToken: 'browser-a-node' });
const cityB = await createGateway({ host: '127.0.0.1', port: 0, dir: dirB, token: 'browser-b-control', nodeToken: 'browser-b-node' });
console.log('City-A', cityA.url, '| City-B', cityB.url);

const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let cdp = null;
let peer = null;
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: Boolean(pass) }); console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` :: ${detail}` : ''}`); };

/** Poll until `expression` returns something truthy, or give up. Returns the last value either way. */
const until = async (expression, { tries = 60, gap = 250 } = {}) => {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    last = await cdp.evaluate(expression).catch(error => ({ error: String(error.message).slice(0, 120) }));
    if (last && !last.error && (last.ok === true || last.truthy === true)) return last;
    await sleep(gap);
  }
  return last;
};

try {
  let target = null;
  for (let i = 0; i < 60 && !target; i += 1) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page') ?? null; } catch { /* the browser is not listening yet */ }
  }
  if (!target) throw new Error('Edge never exposed a page target');
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message));});" });

  // === 1. THE DISCONNECTED FIRST SCREEN (what a new user sees) ================================================
  // A CLEAN, UNCONNECTED PAGE FIRST, and the first navigation is what makes it clean: `about:blank` has an opaque
  // origin, so touching sessionStorage there throws a SecurityError - a fact the check itself has to respect.
  await cdp.send('Page.navigate', { url: cityA.url + '/?s=' + Date.now() });
  await sleep(1800);
  await cdp.evaluate(`sessionStorage.removeItem('city-token')`).catch(() => {});
  await cdp.send('Page.navigate', { url: cityA.url + '/?landing=' + Date.now() });
  await sleep(2000);
  const landing = await until(`({
    truthy: !!document.querySelector('#pair-code'),
    hasConnect: !!document.querySelector('#connect-host'),
    hasEntryHost: !!document.querySelector('#pair-code-card'),
    entryVisible: (() => { const el = document.querySelector('#pair-code'); return !!el && el.offsetParent !== null; })(),
    entryLabel: (document.querySelector('#pair-code-connect')?.textContent || '').trim(),
    errors: (window.__errs || []).slice(),
  })`);
  check('the disconnected screen offers a code/link entry that is VISIBLE', landing?.entryVisible && landing?.entryLabel.length > 0, JSON.stringify({ label: landing?.entryLabel, errors: landing?.errors }));
  check('the disconnected screen has no page errors', (landing?.errors ?? ['missing']).length === 0, JSON.stringify(landing?.errors));

  // === 2. THE CONNECTED PAGE: the state everyone is actually in ===============================================
  await cdp.evaluate(`sessionStorage.setItem('city-token','browser-a-control')`);
  await cdp.send('Page.navigate', { url: `${cityA.url}/?s=${Date.now()}` });
  const online = await until(`({ truthy: document.querySelector('#connection')?.classList.contains('online') === true, contentHidden: document.querySelector('#content')?.hidden ?? null })`);
  check('the page reaches ONLINE with the stored owner credential', online?.truthy === true, JSON.stringify(online));

  const pairingPage = await cdp.evaluate(`(async () => {
    [...document.querySelectorAll('nav button')].find(b => b.dataset.page === 'Pairing')?.click();
    await new Promise(r => setTimeout(r, 500));
    const el = id => document.querySelector(id);
    return {
      pairHidden: el('#pair')?.hidden ?? null,
      entryVisible: !!el('#swap-code') && el('#swap-code').offsetParent !== null,
      buttonVisible: !!el('#swap-code-connect') && el('#swap-code-connect').offsetParent !== null,
      title: (el('#swap-code-title')?.textContent || '').trim().slice(0, 60),
      genEnabled: el('#generate-pairing') ? !el('#generate-pairing').disabled : null,
      errors: (window.__errs || []).slice(),
    };
  })()`);
  check('the CONNECTED Pairing page has a visible code/link entry (the state the first screen hides)', pairingPage.entryVisible && pairingPage.buttonVisible, JSON.stringify({ pairHidden: pairingPage.pairHidden, title: pairingPage.title }));
  check('generating is available on the connected Pairing page', pairingPage.genEnabled === true);

  // A code that is not a 6-digit code and not a link must be REFUSED with a reason, not silently ignored.
  const refused = await cdp.evaluate(`(async () => {
    const field = document.querySelector('#swap-code');
    field.value = '123456';
    document.querySelector('#swap-code-connect')?.click();
    await new Promise(r => setTimeout(r, 300));
    return { note: (document.querySelector('#swap-code-note')?.textContent || '').trim().slice(0, 60) };
  })()`);
  check('a bare 6-digit code is answered with "a code is not an address", not silence', refused.note.length > 0, refused.note);

  // === 3. THE SHAREABLE LINK ==================================================================================
  const madeLink = await cdp.evaluate(`(async () => {
    const gen = document.querySelector('#generate-pairing');
    if (gen && !gen.disabled) gen.click();
    for (let i = 0; i < 30; i += 1) {
      await new Promise(r => setTimeout(r, 300));
      const link = document.querySelector('#pairing-link');
      if (link) return { href: link.getAttribute('href'), text: link.textContent.trim().slice(0, 80), copy: !!document.querySelector('#copy-invite'), raw: !!document.querySelector('#pairing-invite') };
    }
    return { href: null };
  })()`);
  const href = madeLink.href || '';
  check('the invite is rendered as a REAL http link (not a utopia:// scheme)', /^https?:\/\//.test(href) && href.includes('pair='), href.slice(0, 90));
  check('the link text is the link itself, so it can be copied from the screen', madeLink.text === href || (madeLink.text || '').startsWith('http'), (madeLink.text || '').slice(0, 60));
  check('the QR / deep-link payload is still available in the folded detail', madeLink.raw === true);

  // === 4. THE OTHER PC OPENS THAT LINK ========================================================================
  if (href) {
    await cdp.evaluate(`sessionStorage.removeItem('city-token')`).catch(() => {});
    await cdp.send('Page.navigate', { url: href });
    await sleep(2200);
    const arriving = await cdp.evaluate(`({
      href: location.href.slice(0, 90),
      query: location.search.slice(0, 20),
      readyShown: !document.querySelector('#pair-invite-ready')?.hidden,
      acceptVisible: !!document.querySelector('#pair-invite-accept') && document.querySelector('#pair-invite-accept').offsetParent !== null,
      where: (document.querySelector('#pair-invite-text')?.textContent || '').trim().slice(0, 60),
      hash: location.hash.slice(0, 30),
      noteText: (document.querySelector('#pair-code-note')?.textContent || '').trim().slice(0, 60),
      readyHost: !!document.querySelector('#pair-invite-ready'),
      bodyText: (document.querySelector('#pair')?.textContent || '').replace(/\s+/g,' ').slice(0, 120),
      errors: (window.__errs || []).slice(),
    })`);
    check('opening the link shows ONE confirm step naming the other machine', arriving.readyShown && arriving.acceptVisible && arriving.where.length > 0, JSON.stringify({ where: arriving.where, query: arriving.query }));
    check('the one-time secret is stripped from the address bar on arrival', !(arriving.query || '').includes('pair='), arriving.query);
    check('no page errors while receiving the link', arriving.errors.length === 0, JSON.stringify(arriving.errors));

    const completed = await cdp.evaluate(`(async () => {
      document.querySelector('#pair-invite-accept')?.click();
      await new Promise(r => setTimeout(r, 2400));
      return { online: document.querySelector('#connection')?.classList.contains('online') === true, contentHidden: document.querySelector('#content')?.hidden ?? null, errors: (window.__errs || []).slice() };
    })()`);
    check('one click on the link pairs the other PC and it reaches ONLINE', completed.online === true, JSON.stringify({ contentHidden: completed.contentHidden, errors: completed.errors }));
  }

  // === 5. THE CROSS-NETWORK JOIN (N2) =========================================================================
  peer = await dialRelay({ host: '127.0.0.1', port: Number(new URL(cityA.url).port), installationId: 'browser-city-b', label: 'City-B', clientUrl: cityB.url });
  await cdp.evaluate(`sessionStorage.setItem('city-token','browser-a-control')`);
  await cdp.send('Page.navigate', { url: `${cityA.url}/?s=${Date.now()}` });
  await until(`({ truthy: document.querySelector('#connection')?.classList.contains('online') === true })`);
  const relayApi = await cdp.evaluate(`({ present: typeof window.utopiaRelay === 'object', keys: Object.keys(window.utopiaRelay || {}) })`);
  check('the page exposes the relay dialler for the connection list to dispatch to', relayApi.present && relayApi.keys.includes('dial'), JSON.stringify(relayApi.keys));

  const drove = await cdp.evaluate(`(async () => {
    const dial = await window.utopiaRelay.dial({ host: '127.0.0.1', port: ${Number(new URL(cityA.url).port)}, installationId: 'page-install', label: 'Browser page', clientUrl: window.utopiaRelay.selfOrigin() });
    const claim = 'browser-flow-claim-0123456789';
    const flow = window.utopiaRelay.joinCityOverRelay({ forward: (p, b, o) => dial.forward(p, b, o), claim, displayName: 'Browser page', platform: 'Win32', hint: 'browser-page-install', pollIntervalMs: 200 });
    await new Promise(r => setTimeout(r, 700));
    return { dialed: !!dial.peerRef, peerRef: dial.peerRef, flowStarted: !!flow };
  })()`).catch(error => ({ error: String(error.message).slice(0, 160) }));
  check('the page opens the relay pipe itself', drove.dialed === true, JSON.stringify(drove));

  const askedOnA = await (async () => {
    for (let i = 0; i < 20; i += 1) {
      const list = await (await fetch(cityA.url + '/api/v0/join/requests', { headers: owner('browser-a-control') })).json();
      const row = list.requests.find(r => r.installationHint === 'browser-page-install');
      if (row) return row;
      await sleep(250);
    }
    return null;
  })();
  check('the ask created by the page reaches City-A', Boolean(askedOnA), askedOnA ? `state=${askedOnA.state}` : 'no row');
  if (askedOnA) {
    const approved = await fetch(cityA.url + `/api/v0/join/requests/${askedOnA.id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...owner('browser-a-control') }, body: '{}' });
    check('the owner approves it on the City surface', approved.status === 200, `status=${approved.status}`);
  }
  const finalErrors = await cdp.evaluate('(window.__errs || []).slice()');
  check('the page stayed error-free through both paths', finalErrors.length === 0, JSON.stringify(finalErrors));
} catch (error) {
  console.error('BROWSER CHECK FAILED:', error?.message ?? error);
  results.push({ name: 'browser check completed', pass: false });
} finally {
  try { peer?.close(); } catch { /* already gone */ }
  cdp?.close();
  try { edge.kill(); } catch { /* already gone */ }
  await sleep(400);
  await cityA.close();
  await cityB.close();
  for (const dir of [dirA, dirB, userDir]) await rm(dir, { recursive: true, force: true }).catch(() => {});
  const failed = results.filter(r => !r.pass);
  console.log(`\nRESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} - ${results.length - failed.length}/${results.length} browser checks passed`);
  if (failed.length) { console.log('failed:', failed.map(r => r.name).join(' | ')); process.exitCode = 1; }
}
