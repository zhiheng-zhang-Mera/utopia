import test from 'node:test';
import assert from 'node:assert/strict';
import {isSelfAdvertisement} from '../services/dev-gateway/nearby.mjs';
import {memberSnapshot} from '../services/dev-gateway/members.mjs';
import {operatingSystemName} from '../apps/web/platform-label.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {hostname,platform,version as osVersion} from 'node:os';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {startAgent} from '../agents/reference-node/agent.mjs';

test('gateway Set of self addresses excludes unlabelled self but retains a same-port neighbour', () => {
  const context = {selfCityId: 'this-city', selfAddresses: new Set(['127.0.0.1', '192.168.1.10']), selfPort: 4310};
  assert.equal(isSelfAdvertisement({address: '192.168.1.10', port: 4310}, context), true);
  assert.equal(isSelfAdvertisement({address: '192.168.1.11', port: 4310}, context), false);
  assert.equal(isSelfAdvertisement({address: '192.168.1.10', port: 4400}, context), false);
});

test('shipped browser keeps live self first, hides offline rows, shows measured platform and restores pairing', async () => {
  const dir=await mkdtemp(resolve('.scratch-rex-series-review-'));
  let app,agent,browser;
  try {
    app=await createGateway({dir,port:0,token:'review-owner',nodeToken:'review-node',roomsDisabled:true,hostDeviceId:'dev-city'});
    agent=await startAgent({url:app.url,token:'review-node',id:'dev-city',workspace:resolve(dir,'workspace'),telemetryEnabled:false});
    app.store.put('nodes',{id:'host-'+hostname().replace(/[^a-zA-Z0-9-]/g,'-'),displayName:'Stale alias',online:false,metadata:{hostname:hostname()},capabilities:[]});
    app.store.put('nodes',{id:'old-remote',displayName:'Offline remote',online:false,capabilities:[]});
    browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
    const page=await browser.newPage({locale:'en-US'});
    await page.goto(app.url);
    await page.getByLabel('Pairing token').fill('review-owner');
    await page.getByRole('button',{name:'Connect',exact:true}).click();
    await page.locator('#connection.online').waitFor();
    await page.locator('[data-page="Devices"]').click();
    const first=page.locator('.device-card').first();
    assert.match(await first.innerText(),/This device/);
    assert.equal(await first.getAttribute('data-member-card'),'dev-city');
    assert.equal(await page.locator('.device-card').count(),1);
    assert.doesNotMatch(await first.innerText(),/No computing agent connected|Stale alias|Offline remote/);
    if(platform()==='win32')assert.ok((await first.innerText()).includes(osVersion()),'the measured Windows product name reaches the shipped UI');
    const city=await(await fetch(app.url+'/api/v0/city',{headers:{Authorization:'Bearer review-owner','X-City-Api-Version':'0','X-City-Schema-Version':'0'}})).json();
    assert.ok(city.nodes.some(n=>n.id==='old-remote'&&!n.online),'offline facts remain available');
    assert.equal(city.members.find(m=>m.deviceId==='dev-city').nodeId,'dev-city');
    await page.locator('[data-page="Pairing"]').click();
    await page.getByRole('button',{name:'Generate pairing session',exact:true}).click();
    await page.locator('#pairing-qr svg').waitFor();
    const code=await page.locator('#pairing-code').innerText();
    const qr=await page.locator('#pairing-qr svg').evaluate(el=>el.outerHTML);
    await page.reload();
    await page.locator('#connection.online').waitFor();
    await page.locator('[data-page="Pairing"]').click();
    await page.locator('#pairing-qr svg').waitFor();
    assert.equal(await page.locator('#pairing-code').innerText(),code);
    assert.equal(await page.locator('#pairing-qr svg').evaluate(el=>el.outerHTML),qr);
  } finally {
    await browser?.close();await agent?.stop();await app?.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

test('a stale host alias never hides the live host or replaces its execution target', () => {
  const live = {id:'dev-city', online:true, capabilities:['task.execute.safe']};
  const stale = {id:'host-LOCAL', online:false, metadata:{hostname:'LOCAL'}, capabilities:[]};
  for (const nodes of [[live, stale], [stale, live]]) {
    const [host] = memberSnapshot({store:{list:()=>nodes,cityName:'Local'}, installations:[],surfaces:[],hostDeviceId:'dev-city',hostnames:['LOCAL']});
    assert.equal(host.online, true);
    assert.equal(host.computeOnline, true);
    assert.equal(host.nodeId, live.id);
    assert.deepEqual(host.capabilities, live.capabilities);
  }
});

test('kernel versions do not invent a Windows edition or future macOS product version', () => {
  assert.equal(operatingSystemName({platform:'win32',release:'10.0.26100'}), 'Windows (kernel 10.0.26100)');
  assert.equal(operatingSystemName({platform:'win32',release:'10.0.26100',productVersion:'Windows Server 2025 Standard'}), 'Windows Server 2025 Standard');
  assert.equal(operatingSystemName({platform:'win32',release:'10.0.26200',productVersion:'Windows 11 Pro'}), 'Windows 11 Pro');
  assert.equal(operatingSystemName({platform:'darwin',release:'25.0.0'}), 'macOS (Darwin 25.0.0)');
  assert.equal(operatingSystemName({platform:'darwin',release:'26.0.0'}), 'macOS (Darwin 26.0.0)');
});
