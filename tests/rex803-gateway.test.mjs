import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';
test('owner campaign HTTP creates canonical tasks, refuses worker credential and stop preserves trace',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rex803-http-'));const app=await createGateway({dir,port:0,token:'ctl',nodeToken:'node',roomsDisabled:true});
 const request=(path,body,token='ctl')=>fetch(app.url+'/api/v0/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:body?JSON.stringify(body):undefined});
 try{
  const m={experimentId:'http-campaign',question:'Do canonical safe tasks retain cancelled outcomes?',topology:'SINGLE_CITY',hosts:['host'],workers:['host'],controlSurfaces:['web'],variables:{independent:['target'],dependent:['latency'],controls:['type']},repetitions:2,seedPolicy:'FIXED',baseSeed:19,requiredCapabilities:['research.evidence.review'],stopConditions:[{kind:'MAX_REPETITIONS',value:2}],artifactPolicy:{retention:'SUMMARY_ONLY'},acceptance:{primary:'Cancellation is recorded'},softwareRefs:['utopia@1a26d7499d3de39b19c3136c3032e8ccd9343428']};
  const registered=await request('research/experiments',{manifest:m});assert.equal(registered.status,200,await registered.text());
  const options={experimentId:m.experimentId,scenario:'WAIT',repetitions:2,warmups:0,timeoutMs:100,resumePolicy:'INTERRUPT'};
  assert.equal((await request('research/campaigns',options,'node')).status,401);
  const enrolled=await (await request('device/enroll',{displayName:'Research member'})).json();
  const session=await (await request('device/session',{installationId:enrolled.installation.installationId,instanceId:enrolled.installation.instanceId,...enrolled.credential})).json();
  assert.equal((await request('research/campaigns',options,session.credential)).status,403,'enrolled members cannot operate owner campaigns');
  const refused=await request('research/campaigns',options);assert.equal(refused.status,409,await refused.text());
  await request('node/register',{id:'host',displayName:'Host',metadata:{platform:'reference'},capabilities:['task.execute.safe','filesystem.temp']},'node');
  // Control identity is a live WebSocket observation, never just the declared word "web".
  const {WebSocket}=await import('ws');const ws=new WebSocket(app.url.replace('http','ws')+'/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=web',{headers:{Authorization:'Bearer ctl'}});await new Promise((res,rej)=>{ws.once('open',res);ws.once('error',rej);});
  const response=await request('research/campaigns',options);assert.equal(response.status,200);const {campaign}=await response.json();assert.ok(campaign.campaignId);
  await new Promise(r=>setTimeout(r,10));assert.equal(app.store.list('tasks').length,1);
  assert.equal(app.store.list('tasks')[0].targetDeviceRef,'host','campaign task must stay within declared workers');
  await request('research/campaigns/'+campaign.campaignId+'/stop',{});await new Promise(r=>setTimeout(r,20));
  const end=await (await request('research/campaigns/'+campaign.campaignId)).json();assert.equal(end.campaign.status,'CANCELLED');assert.equal(app.store.list('tasks')[0].state,'CANCELLED');
  assert.ok(app.researchTrace.snapshot().records.some(r=>r.dimensions.experimentRef==='http-campaign'&&r.canonicalRefs.taskRef));ws.close();
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
