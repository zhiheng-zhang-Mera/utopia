// REAL BROWSER CHECK (Edge over CDP, no new dependencies).
//
// WHY THIS EXISTS SEPARATELY FROM THE UNIT TESTS: this project has already been bitten twice by defects that ONLY a
// real browser could see - a frozen object being assigned to (which crashed the whole page) and a re-render that
// destroyed the button between mousedown and click. Unit tests import modules; they never load the page. So this
// script loads the actual page in the actual browser, listens for page errors, and then drives the cross-network
// action through the surface the user clicks.
//
// WHAT IT DOES NOT DO: it does not replace an acceptance run on two real PCs. It proves the PAGE works and that the
// relay action is reachable from it.
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
  constructor(url) { this.url = url; this.next = 1; this.pending = new Map(); this.events = []; }
  async open() {
    const { WebSocket } = await import('ws');
    this.socket = new WebSocket(this.url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.id && this.pending.has(message.id)) {
        const { resolve: done, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error))); else done(message.result);
      } else if (message.method) this.events.push(message);
    });
    await new Promise((done, fail) => { this.socket.once('open', done); this.socket.once('error', fail); });
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((done, fail) => {
      this.pending.set(id, { resolve: done, reject: fail });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`page exception: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`);
    return result.result?.value;
  }
  close() { try { this.socket?.close(); } catch { /* already gone */ } }
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
let ok = false;
try {
  // Wait for the debugging endpoint, then attach to the page target.
  let target = null;
  for (let i = 0; i < 60 && !target; i += 1) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(t => t.type === 'page') ?? null;
    } catch { /* the browser is not listening yet */ }
  }
  if (!target) throw new Error('Edge never exposed a page target');
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // LISTEN BEFORE NAVIGATING, or the first page error is missed - which is exactly the failure mode this check is
  // for. `addScriptToEvaluateOnNewDocument` rather than `evaluate`: an evaluated listener lives in the about:blank
  // context and is destroyed by the navigation, which is how the first attempt reported "undefined" instead of the
  // page's real errors.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__errs = []; window.addEventListener('error', function (e) { window.__errs.push(String(e.message)); }); window.addEventListener('unhandledrejection', function (e) { window.__errs.push('unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason)); });" });

  await cdp.send('Page.navigate', { url: cityA.url + '/' });
  await sleep(2500);

  const errorsBefore = await cdp.evaluate('window.__errs.slice()');
  console.log('[1] page errors at load:', JSON.stringify(errorsBefore));
  const surface = await cdp.evaluate(`({hasConnect:!!document.querySelector('#connect-host'),hasBody:!!document.querySelector('#connect-body'),rows:document.querySelectorAll('#connect-body .connect-row').length,hasList:document.querySelectorAll('#connect-body .connect-list').length})`);
  console.log('[2] connection surface:', JSON.stringify(surface));
  const relayApi = await cdp.evaluate(`({present:typeof window.utopiaRelay==='object',keys:Object.keys(window.utopiaRelay||{}),self:window.utopiaRelay?window.utopiaRelay.selfOrigin():null})`);
  console.log('[3] relay API on the page:', JSON.stringify(relayApi));

  // City-B dials out to City-A, as the main City of the pair does.
  peer = await dialRelay({ host: '127.0.0.1', port: Number(new URL(cityA.url).port), installationId: 'browser-city-b', label: 'City-B', clientUrl: cityB.url });
  console.log(`[4] City-B dialled City-A from OUTSIDE the browser: peerRef=${peer.peerRef}`);

  // THE PAGE ITSELF now runs the cross-network join through the exposed surface - the same functions the list's
  // button dispatches to. A stub forward is NOT used: the page opens the WebSocket to City-A and sends the payload.
  const flow = await cdp.evaluate(`(async()=>{
    const claim='browser-flow-claim-0123456789';
    const dial=await window.utopiaRelay.dial({host:'127.0.0.1',port:${Number(new URL(cityA.url).port)},installationId:'page-install',label:'Browser page',clientUrl:window.utopiaRelay.selfOrigin()});
    const pending=window.utopiaRelay.joinCityOverRelay({forward:(p,b,o)=>dial.forward(p,b,o),claim,displayName:'Browser page',platform:'Win32',hint:'browser-page-install',pollIntervalMs:200});
    const asked=await new Promise(r=>setTimeout(r,700))||null;
    return {dialed:!!dial.peerRef,peerRef:dial.peerRef};
  })()`).catch(error => ({error: String(error.message).slice(0, 200)}));
  console.log('[5] the page opened the pipe itself:', JSON.stringify(flow));

  const askedOnA = await (async () => {
    for (let i = 0; i < 20; i += 1) {
      const list = await (await fetch(cityA.url + '/api/v0/join/requests', { headers: owner('browser-a-control') })).json();
      const row = list.requests.find(r => r.installationHint === 'browser-page-install');
      if (row) return row;
      await sleep(250);
    }
    return null;
  })();
  console.log('[6] the ask created BY THE PAGE reached City-A:', Boolean(askedOnA), askedOnA ? `state=${askedOnA.state}` : '');
  if (askedOnA) {
    const approved = await fetch(cityA.url + `/api/v0/join/requests/${askedOnA.id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...owner('browser-a-control') }, body: '{}' });
    console.log('[7] owner approved:', approved.status);
  }

  const errorsAfter = await cdp.evaluate('window.__errs.slice()');
  console.log('[8] page errors after driving the flow:', JSON.stringify(errorsAfter));
  ok = Boolean(relayApi.present) && surface.hasConnect && Boolean(askedOnA) && errorsBefore.length === 0 && errorsAfter.length === 0;
  console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'} - the real page runs the cross-network action without a page error`);
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error('BROWSER CHECK FAILED:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  try { peer?.close(); } catch { /* already gone */ }
  cdp?.close();
  try { edge.kill(); } catch { /* already gone */ }
  await sleep(400);
  await cityA.close();
  await cityB.close();
  for (const dir of [dirA, dirB, userDir]) await rm(dir, { recursive: true, force: true }).catch(() => {});
}
