// Join a running City as a real worker WITHOUT transporting the City's node token.
//
// WHY THIS EXISTS. The three-end topology the research programme needs (a second physical host running a
// reference worker beside this host and an Android control surface) has been blocked for days on one
// thing: the shipped reference-node agent authenticates with CITY_NODE_TOKEN, and the node token is a
// secret held by the City's own host. The programme forbids writing secrets into records, so there was no
// channel by which the other host could obtain it - a capability blocker that looked like a scheduling one.
//
// It is not a capability blocker, because the City already has the mechanism that removes the secret:
// `pairing/info` and `pairing/exchange` are PUBLIC routes, and a caller that consumes an owner-minted short
// code is ENROLLED in the same breath, receiving a `sess:` credential scoped to its own device. The
// reference agent already accepts a `credentialProvider` instead of a static token, and the City's own auth
// preamble returns early for a session bearer, so a session is sufficient for `node/*` - with
// `assertOwnNode` ensuring a member can only operate its OWN node identity.
//
// WHAT THIS SCRIPT DOES, in that order: consume the short code, become a member, then run the reference
// worker with the session credential. Nothing here widens authority: the session can register and
// heartbeat only its own device, exactly as a browser member can.
//
// USAGE, on the joining host:
//   CITY_URL=http://<city-host>:4310 node scripts/join-worker.mjs --code 123456 --name "Alien reference node"
// The owner mints the code with POST /api/v0/pairing/session (owner credential) and reads the node identity
// this script prints, then declares that identity in the experiment manifest.
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {startAgent} from '../agents/reference-node/agent.mjs';

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const cityUrl = (option('city') ?? process.env.CITY_URL ?? 'http://127.0.0.1:4310').replace(/\/$/, '');
const code = option('code');
const displayName = option('name') ?? 'joined reference node';
const platform = option('platform') ?? process.platform;
const identityFile = resolve(option('identity-file') ?? '.runtime/join-worker.json');
if (!code) {
  console.error('usage: node scripts/join-worker.mjs --code <shortCode> [--city <url>] [--name <displayName>] [--identity-file <path>]');
  process.exit(2);
}
const publicHeaders = {Accept: 'application/json', 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};

/** Reuse the device identity across restarts, so a joined worker keeps its node id and its receipts. */
function rememberedIdentity() {
  if (!existsSync(identityFile)) return null;
  try { return JSON.parse(readFileSync(identityFile, 'utf8')); } catch { return null; }
}
function remember(identity) {
  mkdirSync(dirname(identityFile), {recursive: true});
  writeFileSync(identityFile, JSON.stringify(identity, null, 2), {mode: 0o600});
}

async function join() {
  const infoResponse = await fetch(`${cityUrl}/api/v0/pairing/info`, {headers: publicHeaders});
  if (!infoResponse.ok) throw new Error(`pairing/info answered ${infoResponse.status}`);
  const info = await infoResponse.json();
  const descriptor = info.descriptor ?? info;
  const cityId = descriptor.cityId ?? info.cityId;
  const sessionId = descriptor.pairingSessionId ?? info.pairingSessionId ?? descriptor.sessionId;
  if (!cityId || !sessionId) throw new Error(`pairing/info did not describe a session: ${JSON.stringify(info).slice(0, 200)}`);
  const prior = rememberedIdentity();
  const exchangeResponse = await fetch(`${cityUrl}/api/v0/pairing/exchange`, {
    method: 'POST',
    headers: publicHeaders,
    body: JSON.stringify({
      cityId, sessionId, method: 'mdns', shortCode: code,
      installation: {
        displayName,
        platform,
        ...(prior?.deviceId ? {deviceId: prior.deviceId} : {}),
        ...(prior?.instanceId ? {instanceId: prior.instanceId} : {}),
      },
    }),
  });
  const exchanged = await exchangeResponse.json();
  if (!exchangeResponse.ok || !exchanged.credential || !(exchanged.enrollment?.deviceId ?? exchanged.member?.deviceId)) {
    throw new Error(`pairing/exchange answered ${exchangeResponse.status}: ${JSON.stringify(exchanged).slice(0, 300)}`);
  }
  const identity = {
    cityId: exchanged.cityId ?? cityId,
    deviceId: exchanged.enrollment?.deviceId ?? exchanged.member?.deviceId,
    installationId: exchanged.enrollment?.installationId ?? null,
    instanceId: exchanged.enrollment?.instanceId ?? null,
    credential: exchanged.credential,
  };
  remember(identity);
  return identity;
}

const prior = rememberedIdentity();
// A failure here must be a plain message and a non-zero exit. The first version let the rejection escape the
// top-level await, and on Windows the abort that followed discarded the piped stderr - so a caller capturing
// output saw a process that produced NOTHING, which is the least diagnosable failure a tool can have.
let identity;
try {
  identity = prior?.credential && prior?.deviceId && !option('rejoin', null) ? prior : await join();
} catch (error) {
  console.error(`join-worker: ${error?.message ?? error}`);
  process.exit(1);
}

console.log(`joined City ${identity.cityId} as node identity ${identity.deviceId}`);
console.log('declare this identity in the experiment manifest hosts/workers, then it appears as a live worker:');
console.log(`  ${identity.deviceId}`);

// The session credential is presented for every node call. A revoked installation stops the very next
// heartbeat, because the City resolves the session on every request rather than caching it.
const agent = await startAgent({
  url: cityUrl,
  id: identity.deviceId,
  displayName,
  credentialProvider: () => identity.credential,
  workspace: option('workspace') ?? '.runtime/workspace',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await agent.stop(); process.exit(0); });
}
