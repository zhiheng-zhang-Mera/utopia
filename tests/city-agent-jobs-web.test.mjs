// CITY-AGENT-JOB — the OWNER SURFACE, in a real browser against a real City.
//
// CONSTRUCTION_RULES 14A makes this file the evidence for the parts of the exposure gate that only a real surface can
// answer: that the entry is DISCOVERABLE in the shipped navigation, that the control really reaches the canonical
// backend, that the owner sees the REAL result, that a confirmation stands between the owner and the high-impact part,
// and that the request can be withdrawn. A test that only called the API would satisfy none of them.
//
// It also carries the regression guard for a defect this surface's own navigation exposed: the sidebar is FIXED to the
// viewport, so a nav entry pushed below the fold is unreachable by ANY means, and the page title is derived from the
// lowercased page name, so a camelCase `heading.*` key silently renders as the raw key.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {AGENT_NODE_CAPABILITIES, claimJob, registerNode, reportJob} from '../scripts/agent-job.mjs';

const V={'X-City-Api-Version':'0','X-City-Schema-Version':'0'};
const OWNER='web-owner';
const NODE_TOKEN='web-node';
const NODE_ID='dev-opposite-agent';
const owner={...V,Authorization:'Bearer '+OWNER,'Content-Type':'application/json'};

const launch=()=>chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});

const jobSpec=()=>({title:'Reproduce the study on the opposite host',instruction:'Run the reproduction harness and report what happened.',
  purpose:'independent reproduction on a machine the City cannot see into',deadlineMs:1800000});

test('CAJ-WEB 1: the entry is discoverable, the typed confirmation gates the request, and the agent answer is labelled as a claim',async t=>{
  const dir=await mkdtemp(resolve('.scratch-agent-job-web-'));
  let app,browser;
  try{
    // `heartbeatTimeout` is long HERE on purpose. This file tests the SURFACE; whether a far-side node stays online is
    // a separate, real question that tests/city-agent-job.test.mjs answers directly (CAJ 11). Leaving the default 8 s
    // in place made this test fail under full-suite load for a reason that had nothing to do with the surface: the
    // machine dropped out of the target list between registration and the page loading.
    app=await createGateway({dir:resolve(dir,'city'),port:0,token:OWNER,nodeToken:NODE_TOKEN,roomsDisabled:true,agentJob:{enabled:true},heartbeatTimeout:600000});
    await registerNode({url:app.url,token:NODE_TOKEN,id:NODE_ID,displayName:'Alien (agent-driven)'});
    browser=await launch();
    const page=await browser.newPage({locale:'en-US'});
    page.setDefaultTimeout(8000);
    await page.goto(app.url);
    await page.locator('#token').fill(OWNER);
    await page.locator('#connect').click();
    await page.locator('#connection.online').waitFor();

    // 1. DISCOVERABLE: the entry is in the shipped navigation, and clicking it really opens the surface.
    const entry=page.locator('nav [data-page="AgentJobs"]');
    assert.equal(await entry.count(),1,'the surface must be reachable from the shipped navigation');
    await entry.click();
    await page.locator('#aj-refresh').waitFor();
    await page.waitForFunction(()=>document.querySelector('#aj-state')?.textContent?.length>0);

    // 2. The City's own switch is shown as a fact read from the City, not inferred from a missing button.
    assert.match(await page.locator('#aj-state').innerText(),/Enabled/);
    assert.match(await page.locator('#aj-state').innerText(),/DIRECT_CONTROL/);

    // 3. CONFIRMATION: the request cannot be sent until the owner types the exact title.
    await page.locator('#aj-node').selectOption(NODE_ID);
    await page.locator('#aj-title').fill(jobSpec().title);
    await page.locator('#aj-instruction').fill(jobSpec().instruction);
    await page.locator('#aj-purpose').fill(jobSpec().purpose);
    await page.locator('#aj-danger > summary').click();
    const dispatch=page.locator('#aj-dispatch');
    assert.equal(await dispatch.isDisabled(),true,'the gate must hold with an empty confirmation');
    await page.locator('#aj-confirm').fill('Reproduce the study on the opposite');
    assert.equal(await dispatch.isDisabled(),true,'a PARTIAL title must not open the gate');
    await page.locator('#aj-confirm').fill(jobSpec().title);
    assert.equal(await dispatch.isDisabled(),false);
    await dispatch.click();

    // 4. The request really reached the canonical backend: a real task exists for a real node to take.
    await page.waitForFunction(()=>document.querySelector('[data-aj-state]')?.textContent?.includes('QUEUED'));
    const claimed=await claimJob({url:app.url,token:NODE_TOKEN,id:NODE_ID});
    assert.ok(claimed,'the job must be claimable by the capable node the owner named');
    assert.equal(claimed.job.title,jobSpec().title);
    assert.equal(claimed.job.purpose,jobSpec().purpose);

    // 5. REAL RESULT, AND THE LABEL THAT MATTERS: the agent's answer appears as the agent's claim, with its own
    //    evidence class, and never as something the City verified.
    await reportJob({url:app.url,token:NODE_TOKEN,id:NODE_ID,taskId:claimed.id,jobDigest:claimed.job.jobDigest,
      state:'SUCCEEDED',evidence:'OBSERVED_HERE',summary:'the harness ran and the four metrics agreed'});
    await page.locator('#aj-refresh').click();
    await page.waitForFunction(()=>document.querySelector('[data-aj-report]'));
    const report=page.locator('[data-aj-report]');
    assert.match(await report.innerText(),/the harness ran and the four metrics agreed/);
    assert.equal(await report.locator('[data-aj-evidence]').innerText(),'OBSERVED_HERE');
    assert.match(await report.innerText(),/agent.s own claim/);
    assert.match(await report.innerText(),/did not verify/);
    //    And the City's OWN word for the task is a different word, in its own block.
    assert.equal(await page.locator('[data-aj-state]').innerText(),'COMPLETED');
    assert.match(await report.innerText(),/agent.s own claim/);
    assert.match(await report.innerText(),/did not verify/);

    // 5b. TAKING DELIVERY is the owner's own act and is shown as its own state, with the receipt's own authority line -
    //     so delivery can never be read as agreement with what the agent said.
    assert.equal(await page.locator('[data-aj-consumed]').count(),0,'an answer nobody has collected must not look collected');
    await page.locator('[data-aj-consume]').click();
    await page.locator('[data-aj-consumed]').waitFor();
    const collected=await page.locator('[data-aj-consumed]').innerText();
    assert.match(collected,/ACKNOWLEDGEMENT_NOT_VERIFICATION/);
    assert.equal(await page.locator('[data-aj-consume]').count(),0,'the control is gone once the act is recorded');
    // A recorded delivery is not rewritten: the receipt's digest is on the surface and is stable across a reload.
    const digest=await page.locator('[data-aj-consumed]').getAttribute('data-aj-consumed');
    assert.match(digest,/^[a-f0-9]{64}$/);
    await page.reload();
    await page.locator('#connection.online').waitFor();
    await page.locator('nav [data-page="AgentJobs"]').click();
    await page.locator('[data-aj-consumed]').waitFor();
    assert.equal(await page.locator('[data-aj-consumed]').getAttribute('data-aj-consumed'),digest);

    // 6. The guard for this surface's own navigation: EVERY nav entry is reachable on this viewport, and every page
    //    title is real translated copy rather than a raw key. Both halves failed when this page was added.
    for(const page_ of await page.locator('nav button[data-page]').evaluateAll(nodes=>nodes.map(n=>n.dataset.page))){
      await page.locator(`nav button[data-page="${page_}"]`).click();
      const heading=await page.locator('#heading').innerText();
      assert.ok(heading.trim().length>0,`${page_} rendered an empty heading`);
      assert.ok(!heading.includes('heading.'),`${page_} rendered the raw i18n key as its title: ${heading}`);
    }
  }finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
});

test('CAJ-WEB 2: a dispatched but unanswered request can be withdrawn from the surface, and a member cannot open it at all',async t=>{
  const dir=await mkdtemp(resolve('.scratch-agent-job-web2-'));
  let app,browser;
  try{
    app=await createGateway({dir:resolve(dir,'city'),port:0,token:OWNER,nodeToken:NODE_TOKEN,roomsDisabled:true,agentJob:{enabled:true},heartbeatTimeout:600000});
    // The node is registered WITHOUT the agent-job capability, so the request WAITS rather than being taken: that is
    // what makes it a request the owner is entitled to withdraw.
    await registerNode({url:app.url,token:NODE_TOKEN,id:NODE_ID,capabilities:['task.execute.safe','filesystem.temp']});
    await fetch(app.url+'/api/v0/actions',{method:'POST',headers:owner,body:JSON.stringify({route:'CITY_TASK',target:'city.task',
      operation:'AGENT_JOB',input:{targetDeviceRef:NODE_ID,job:jobSpec()},idempotencyKey:'web-2-fixture'})});
    browser=await launch();
    const page=await browser.newPage({locale:'en-US'});
    page.setDefaultTimeout(8000);
    await page.goto(app.url);
    await page.locator('#token').fill(OWNER);
    await page.locator('#connect').click();
    await page.locator('#connection.online').waitFor();
    await page.locator('nav [data-page="AgentJobs"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-aj-state]')?.textContent?.includes('QUEUED'));
    // The reason it is waiting is on the surface, by name - not an empty screen with a spinner.
    assert.match(await page.locator('#aj-list').innerText(),/NODE_MISSING_CAPABILITY:city\.agent-job\.v1/);
    // WITHDRAW: the owner's stop is a real state change through the canonical cancel route.
    await page.locator('[data-aj-stop]').click();
    await page.waitForFunction(()=>document.querySelector('[data-aj-state]')?.textContent?.includes('CANCELLED'));
    assert.ok(!(await page.locator('#aj-list').innerText()).includes('No report yet')===false,'the withdrawn request keeps its record');

    // A MEMBER CANNOT OPEN THE SURFACE. The nav entry is owner-scoped in the City, so the page reports the real refusal
    // rather than showing an empty list that looks like "nothing has been asked".
    const enrollment=await (await fetch(app.url+'/api/v0/device/enroll',{method:'POST',headers:owner,body:JSON.stringify({displayName:'Member'})})).json();
    const session=(await (await fetch(app.url+'/api/v0/device/session',{method:'POST',headers:V,
      body:JSON.stringify({installationId:enrollment.installation.installationId,instanceId:enrollment.installation.instanceId,...enrollment.credential})})).json()).credential;
    const memberPage=await browser.newPage({locale:'en-US'});
    memberPage.setDefaultTimeout(8000);
    await memberPage.goto(app.url+'/#session='+encodeURIComponent(session));
    await memberPage.locator('#connection.online').waitFor();
    await memberPage.locator('nav [data-page="AgentJobs"]').click();
    await memberPage.waitForFunction(()=>document.querySelector('#aj-error')?.textContent?.length>0);
    assert.match(await memberPage.locator('#aj-error').innerText(),/owner/i,'a member must be told the refusal, not shown an empty list');
  }finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
});
