// Proof that a foreign host can become a real, live worker of a running City WITHOUT being given the City's
// node token. The three-end research topology has been blocked for days on exactly that secret, and the
// programme forbids putting secrets into records - so the blocker looked like scheduling when it was
// capability. It is neither: the City's pairing routes are public, a consumed short code enrolls the caller,
// and the reference agent accepts a credential provider instead of a static token.
//
// This probe drives the whole path with a real child process, so the claim is a measurement and not a reading:
//   owner mints a short code -> a separate process consumes it -> that process registers and heartbeats as a
//   node -> the City lists it ONLINE and as a campaign worker -> killing the process takes it offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {spawn} from 'node:child_process';
import {createGateway} from '../services/dev-gateway/server.mjs';

const H = {'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const OWNER = {...H, Authorization: 'Bearer owner'};
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('a foreign host joins as a live worker using only an owner-minted short code, with no node token', async () => {
  const dir = await mkdtemp(resolve('.scratch-join-worker-'));
  let app = null, child = null;
  try {
    app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node-token-never-shared', roomsDisabled: true, heartbeatTimeout: 1500});
    const identityFile = join(dir, 'join-worker.json');

    // The owner mints a pairing session; this is the only thing that has to cross the gap, and it is a short code.
    const minted = await(await fetch(`${app.url}/api/v0/pairing/session`, {method: 'POST', headers: OWNER, body: JSON.stringify({expectedSessionState: 'IDLE'})})).json();
    const shortCode = minted.descriptor?.shortCode ?? minted.shortCode;
    assert.ok(shortCode, `the owner must be able to mint a short code: ${JSON.stringify(minted).slice(0, 200)}`);

    // A SEPARATE PROCESS consumes it and then serves as a worker. It is never told the node token.
    child = spawn(process.execPath, ['scripts/join-worker.mjs', '--city', app.url, '--code', shortCode, '--name', 'joined reference node', '--identity-file', identityFile], {stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });

    // The joined node must appear ONLINE in the City, and as a worker the campaign topology will accept.
    let node = null;
    for (let attempt = 0; attempt < 100 && !node; attempt += 1) {
      await sleep(150);
      const city = await(await fetch(`${app.url}/api/v0/city`, {headers: OWNER})).json();
      node = (city.nodes ?? []).find(candidate => candidate.online === true && candidate.id !== city.hostDeviceId) ?? null;
    }
    assert.ok(node, `no joined node came online. script output:\n${output.slice(-600)}`);
    const identity = JSON.parse(await readFile(identityFile, 'utf8'));
    assert.equal(node.id, identity.deviceId, 'the node that came online is the identity the joiner enrolled');
    // The joined node must be an ELIGIBLE worker, not merely a visible row: `campaignWorkers()` keeps online nodes
    // whose capabilities satisfy the task requirements and whose sharing is on.
    assert.ok((node.capabilities ?? []).includes('task.execute.safe'), `the joined node must advertise the execution capability: ${JSON.stringify(node.capabilities)}`);
    assert.notEqual(node.sharingEnabled, false, 'a joined node keeps sharing on unless its owner turns it off');

    // The campaign topology only exists where REX-803 is present, so this part is asserted when the route answers and
    // reported as out of scope when it does not - never silently skipped.
    const campaignsResponse = await fetch(`${app.url}/api/v0/research/campaigns`, {headers: OWNER});
    if (campaignsResponse.status === 200) {
      const campaigns = await campaignsResponse.json();
      assert.ok((campaigns.topology?.workers ?? []).includes(identity.deviceId),
        `the joined node must count as a campaign worker: ${JSON.stringify(campaigns.topology?.workers)}`);
    } else {
      assert.equal(campaignsResponse.status, 404, 'the only acceptable absence is that this build has no campaign route');
    }

    // Kill the joiner and the City must no longer count it. The wait has to exceed the City's heartbeat timeout,
    // which is why this fixture shortens it: waiting out a production timeout would make the probe about the clock.
    const beforeKill = (await(await fetch(`${app.url}/api/v0/city`, {headers: OWNER})).json()).nodes.find(candidate => candidate.id === identity.deviceId);
    child.kill();
    // Comfortably beyond heartbeatTimeout + the agent's 1000 ms heartbeat interval + the City's 1000 ms sweep: the
    // first version waited 2800 ms against a 2000 ms timeout, which is marginal, and it passed or failed depending on
    // where the last heartbeat fell. A window that only just covers the property is the same defect this programme has
    // now recorded four times, so this one is given real margin rather than a lucky one.
    await sleep(4000);
    const after = await(await fetch(`${app.url}/api/v0/city`, {headers: OWNER})).json();
    const afterNode = (after.nodes ?? []).find(candidate => candidate.id === identity.deviceId);
    assert.equal(afterNode?.online, false,
      `a killed joiner stops being a live worker (heartbeat ${beforeKill?.lastHeartbeatAt} -> ${afterNode?.lastHeartbeatAt}, exitCode ${child.exitCode}, killed ${child.killed})`);
  } finally {
    try { child?.kill(); } catch { /* already gone */ }
    await app?.close();
    await rm(dir, {recursive: true, force: true});
  }
});
