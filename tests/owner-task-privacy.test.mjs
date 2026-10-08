import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {registerNode} from '../scripts/agent-job.mjs';
import WebSocket from 'ws';

test('unrelated members cannot read or mutate Owner tasks through generic projections',{timeout:30000},async()=>{
 const dir=await mkdtemp(resolve('.scratch-owner-privacy-'));
 const app=await createGateway({dir,port:0,token:'owner',nodeToken:'node',roomsDisabled:true,remoteOperation:{enabled:true,allowlist:['node'],workspaces:[dir]},agentJob:{enabled:true}});
 let ws;
 try{
  const H={Authorization:'Bearer owner','Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'};
  const req=async(path,body,headers=H)=>fetch(app.url+'/api/v0/'+path,{headers,method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});
  const enrollment=await (await req('device/enroll',{displayName:'Unrelated'})).json();
  const session=await (await req('device/session',{installationId:enrollment.installation.installationId,instanceId:enrollment.installation.instanceId,...enrollment.credential},{...H,Authorization:''})).json();
  const M={...H,Authorization:'Bearer '+session.credential};
  const messages=[];ws=new WebSocket(app.url.replace('http:','ws:')+'/api/v0/events/stream?apiVersion=0&schemaVersion=0',{headers:M});ws.on('message',data=>messages.push(String(data)));await new Promise((ok,no)=>{ws.once('open',ok);ws.once('error',no)});
  await registerNode({url:app.url,token:'node',id:'dev-private',displayName:'Private'});
  for(const operation of ['OWNER_REMOTE_OPERATION','AGENT_JOB']){
   const secret='private-'+operation;
   const input=operation==='AGENT_JOB'?{job:{title:secret,instruction:secret,purpose:secret,inputs:[]}}:{operation:{executable:'node',argv:[secret],cwd:dir,purpose:secret}};
   const created=await (await req('actions',{route:'CITY_TASK',target:'city.task',operation,input:{targetDeviceRef:'dev-private',...input},idempotencyKey:operation})).json();
   const id=created.action.backendRef.taskId;assert.ok(id);
   for(const path of ['city','tasks','events','actions','presentation']){
    const r=await req(path,undefined,M);assert.equal(r.status,200);assert.equal(JSON.stringify(await r.json()).includes(secret),false,path+' must not expose owner input');
   }
   for(const path of ['tasks/'+id,'actions/'+created.action.id])assert.equal((await req(path,undefined,M)).status,403,path);
   for(const suffix of ['cancel','provider-choice','switch-declined'])assert.equal((await req('tasks/'+id+'/'+suffix,{providerRef:'x'},M)).status,403,suffix);
   assert.equal((await (await req('tasks/'+id)).json()).state,'QUEUED');
   await new Promise(ok=>setTimeout(ok,80));assert.equal(messages.join('').includes(secret),false,'member live stream must not reveal owner event payload');
  }
  const refused=await (await req('actions',{route:'CITY_TASK',target:'city.task',operation:'OWNER_REMOTE_OPERATION',input:{targetDeviceRef:'dev-private',operation:{executable:'cmd',argv:['private-refused-input'],cwd:dir,purpose:'private-refused-input'}},idempotencyKey:'refused'})).json();
  assert.equal(refused.action.status,'REFUSED');
  assert.equal(JSON.stringify(await (await req('actions',undefined,M)).json()).includes('private-refused-input'),false,'refused actions without a task remain owner-only');
  assert.equal((await req('actions/'+refused.action.id,undefined,M)).status,403);
 }finally{ws?.terminate();await app.close();await rm(dir,{recursive:true,force:true});}
});
