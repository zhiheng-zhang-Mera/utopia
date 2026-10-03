// Utopia launcher - generates a LOCAL token, brings this host's City up with it, and opens the web client.
//
// WHY A LAUNCHER AND NOT JUST A URL: the web client needs a credential, and until now every credential was typed
// by hand from a value that had to be fetched out of band. This generates a fresh one for THIS host on every
// launch, writes it where only this machine can read it (.runtime/ is git-ignored), starts the City with it, and
// hands it to the browser so the client opens ALREADY CONNECTED. Nothing is typed, and no token is ever passed on
// a command line - the child gateway inherits it through the environment, so it does not appear in a process list.
//
// WHAT "THE LOCAL TOKEN" IS, AND IS NOT. It is a bootstrap credential for the City on this machine. It is
// destroyed on the client side the moment this client switches to a DIFFERENT City with an invite token, and it
// is regenerated on the next launch either way. It is NOT revoked server-side: the running gateway keeps
// accepting it until it is restarted, because rotating a live Gateway's credential would mean changing the auth
// path of a running service, and that is a change the Owner has not asked for. Stated here rather than implied,
// because "destroyed" and "revoked" are not the same word.
//
// USAGE
//   node scripts/utopia-client-launcher.mjs [--port 4391] [--host <lan-ip>] [--no-open]
//                                            [--takeover] [--keep-token]
//   --takeover    stop whatever is already listening on the port, but ONLY if it is a dev-gateway process
//   --keep-token  reuse the token already in .runtime/local-token.json instead of generating a new one
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {networkInterfaces} from 'node:os';
import {resolve} from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : (argv[i + 1] ?? true); };
const has = (name) => argv.includes(`--${name}`);

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(flag('port', process.env.CITY_PORT || 4391));
const TOKEN_FILE = resolve(ROOT, '.runtime/local-token.json');
const lan = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
const HOST = String(flag('host', process.env.CITY_HOST || lan[0] || '127.0.0.1'));
const BASE = `http://${HOST}:${PORT}`;
const say = (m) => console.log(m);

const headers = (token) => ({Authorization: `Bearer ${token}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'});
const probe = async (token) => {
  try {
    const r = await fetch(`${BASE}/api/v0/city`, {headers: headers(token), signal: AbortSignal.timeout(2500)});
    if (r.status === 200) return {listening: true, accepted: true, city: await r.json()};
    return {listening: true, accepted: false, status: r.status};
  } catch { return {listening: false, accepted: false}; }
};

function newToken() { return randomBytes(24).toString('base64url'); }
function readStoredToken() {
  try { if (!existsSync(TOKEN_FILE)) return null; const j = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')); return j?.token ?? null; } catch { return null; }
}
function writeTokenFile(token, cityId) {
  mkdirSync(resolve(ROOT, '.runtime'), {recursive: true});
  writeFileSync(TOKEN_FILE, JSON.stringify({token, nodeToken: token + '-node', endpoint: BASE, cityId: cityId ?? null, createdAt: new Date().toISOString()}, null, 2));
}
async function listenerOnPort() {
  // Read-only: who owns the port, and what is it? Used to refuse politely rather than to fight.
  // The PowerShell is built by concatenation on purpose: nesting a quoted -Filter inside a quoted argument is
  // how the previous version of this helper produced a literal `' + '` in the command instead of a PID.
  const ps = '$c=Get-NetTCPConnection -State Listen -LocalPort ' + PORT + ' -ErrorAction SilentlyContinue | Select-Object -First 1;'
    + 'if(-not $c){Write-Output "PID=none CMD=";exit 0};'
    + '$p=Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.OwningProcess) -ErrorAction SilentlyContinue;'
    + 'Write-Output ("PID=" + $c.OwningProcess + " CMD=" + $p.CommandLine)';
  return new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-Command', ps], {stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true});
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('exit', () => res(out.trim()));
  });
}
function openBrowser(url) {
  // The DEFAULT browser, as a normal window the user owns - not a browser this script controls and closes.
  spawn('cmd.exe', ['/c', 'start', '', url], {detached: true, stdio: 'ignore', windowsHide: false}).unref();
}

say('===============================================================');
say('  UTOPIA  -  launcher for this host');
say('---------------------------------------------------------------');
say(`  City endpoint : ${BASE}`);
say(`  token file    : ${TOKEN_FILE}   (git-ignored, readable only on this machine)`);
say('===============================================================');

const already = await probe('__probe__');
let token = null;
let child = null;

if (already.listening) {
  const stored = readStoredToken();
  const withStored = stored ? await probe(stored) : {accepted: false};
  if (withStored.accepted) {
    token = stored;
    say('A City is already listening here and accepts the stored token: reusing it, not starting a second one.');
    say(`  cityId ${withStored.city?.cityId}`);
  } else if (has('takeover')) {
    const info = await listenerOnPort();
    if (!/dev-gateway/.test(info)) {
      say(`REFUSING --takeover: the process on ${PORT} is not a dev-gateway, so it is not ours to stop.`);
      say(`  ${info}`);
      process.exit(2);
    }
    const pid = Number((info.match(/PID=(\d+)/) ?? [])[1]);
    say(`--takeover: stopping the dev-gateway already on ${PORT} (pid ${pid}), because a NEW local token is being`);
    say('  generated and the old City cannot be re-keyed while it is running.');
    if (pid) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {stdio: 'ignore'});
    for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); if (!(await probe('__probe__')).listening) break; }
    if ((await probe('__probe__')).listening) {
      // A supervisor may be holding it open by restarting children - say so rather than looping.
      say('A City is STILL listening. A supervisor is probably restarting it (the resident supervisor does exactly');
      say('that); close that window first, or run with a different --port. Nothing was started.');
      process.exit(3);
    }
  } else {
    say(`REFUSING to start: something is already listening on ${PORT} and it does not accept the stored token.`);
    say(`  ${await listenerOnPort()}`);
    say('  Close it (or pass --takeover, which stops it only if it is a dev-gateway) and run the launcher again.');
    process.exit(2);
  }
}

if (!token) {
  const stored = readStoredToken();
  token = has('keep-token') && stored ? stored : newToken();
  writeTokenFile(token, null);
  say(`generated a fresh LOCAL token for this launch (${token.length} chars, not printed)`);
  child = spawn(process.execPath, [resolve(ROOT, 'services/dev-gateway/main.mjs')], {
    cwd: ROOT,
    env: {...process.env, CITY_HOST: HOST, CITY_PORT: String(PORT), CITY_URL: BASE, CITY_TOKEN: token, CITY_NODE_TOKEN: token + '-node',
          CITY_DATA: resolve(ROOT, '.runtime'), CITY_WORKSPACE: resolve(ROOT, '.runtime/workspace')},
    stdio: 'inherit',   // the City's own log IS this window: no secrets on a command line, nothing hidden
  });
  child.on('exit', (code) => { say(`the City exited (code ${code}); the launcher is done`); process.exit(code ?? 0); });
  say('starting the City in this window...');
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const p = await probe(token);
    if (p.accepted) { up = true; writeTokenFile(token, p.city?.cityId); say(`City is ONLINE  cityId ${p.city?.cityId}`); }
  }
  if (!up) { say('the City did not come up within 20s; see the log above. Nothing was opened.'); process.exit(4); }
}

const url = `${BASE}/#token=${encodeURIComponent(token)}`;
say('');
say(`opening the web client: ${BASE}/#token=…   (the token travels in the URL fragment, which browsers never`);
say('  send to a server, and the page strips it from the address bar as soon as it has been read)');
if (!has('no-open')) openBrowser(url);
say('');
say('PAIRING AND SHARING');
say('  In the client: Pairing -> Generate pairing session. The page then shows a SHAREABLE PAIRING TOKEN as text');
say('  (alongside its QR and 6-digit short code). That token names this City as well as carrying a one-time secret,');
say('  so whoever receives it can paste it into their own client and land on THIS City - a bare credential could');
say('  not do that, because it does not say which City it belongs to. It is single use and expires with the session.');
say('');
say(`  This window holds the City. Closing it (or Ctrl+C) stops the City.  port ${PORT}`);
