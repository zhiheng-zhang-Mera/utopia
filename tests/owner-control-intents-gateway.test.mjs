import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';
const headers={'X-City-Api-Version':'0','X-City-Schema-Version':'0',Authorization:'Bearer test-owner','Content-Type':'application/json'};
test('real HTTP Ask advertises owner controls but every draft leaves canonical task count unchanged',async()=>{
 const dir=await mkdtemp(resolve('.scratch-owner-intent-'));
 const app=await createGateway({dir,port:0,token:'test-owner',nodeToken:'test-node',roomsDisabled:true,remoteOperation:{enabled:true,allowlist:['git'],workspaces:[dir]},agentJob:{enabled:true}});
 try{
  const read=async path=>(await (await fetch(app.url+'/api/v0/'+path,{headers})).json());
  const targets=(await read('ask/targets')).targets;
  assert.ok(targets.some(t=>t.operation==='OWNER_REMOTE_OPERATION'));assert.ok(targets.some(t=>t.operation==='AGENT_JOB'));
  const before=(await read('tasks')).tasks.length;
  for(const text of ['run git on Alien','让 Alien 的 Agent 检查项目测试']){
   const result=await (await fetch(app.url+'/api/v0/ask',{method:'POST',headers,body:JSON.stringify({text,confirm:true})})).json();
   assert.equal(result.ask.status,'DRAFT_REQUIRED');assert.equal(result.ask.action,null);
  }
  assert.equal((await read('tasks')).tasks.length,before);
  const enrolled=await (await fetch(app.url+'/api/v0/device/enroll',{method:'POST',headers,body:JSON.stringify({displayName:'Member'})})).json();
  const session=await (await fetch(app.url+'/api/v0/device/session',{method:'POST',headers:{...headers,Authorization:undefined},body:JSON.stringify({installationId:enrolled.installation.installationId,instanceId:enrolled.installation.instanceId,...enrolled.credential})})).json();
  assert.ok(session.credential?.startsWith('sess:'));
  const member={...headers,Authorization:'Bearer '+session.credential};
  const memberTargets=(await (await fetch(app.url+'/api/v0/ask/targets',{headers:member})).json()).targets;
  assert.ok(memberTargets.filter(t=>['OWNER_REMOTE_OPERATION','AGENT_JOB'].includes(t.operation)).every(t=>!t.available));
  for(const operation of ['OWNER_REMOTE_OPERATION','AGENT_JOB']){
   const denied=await fetch(app.url+'/api/v0/ask',{method:'POST',headers:member,body:JSON.stringify({text:'anything',selection:{route:'CITY_TASK',target:'city.task',operation},confirm:true})});
   assert.equal(denied.status,403);assert.match(JSON.stringify(await denied.json()),/OWNER_REQUIRED/);
  }
  assert.equal((await read('tasks')).tasks.length,before);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
