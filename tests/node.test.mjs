import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { startAgent } from '../agents/reference-node/agent.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('real node executes file checkpoint task; cancelled task stays cancelled',async()=>{
 const dir=await mkdtemp(resolve('.scratch-node-'));let gateway,agent;
 try{
 gateway=await createGateway({host:'127.0.0.1',port:0,dir,token:'control',nodeToken:'node'});
 const api=async(path,body)=>{const r=await fetch(gateway.url+'/api/v0/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer control','X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return r.json();};
 agent=await startAgent({url:gateway.url,token:'node',workspace:resolve(dir,'work'),interval:100,stepDelay:100});
 const t=await api('tasks',{type:'CHECKPOINT_DEMO'});
 let saved;for(let i=0;i<100;i++){saved=await api('tasks/'+t.id);if(saved.state==='COMPLETED')break;await sleep(100);}
 assert.equal(saved.state,'COMPLETED');assert.match(saved.result.sha256,/^[a-f0-9]{64}$/);assert.equal(saved.result.cleaned,true);
 assert.deepEqual(await readdir(resolve(dir,'work')),[]);
 const events=(await api('events')).events.filter(e=>e.taskId===t.id);
 assert.ok(events.some(e=>e.type==='TASK_CHECKPOINTED'));assert.equal(events.at(-1).type,'TASK_COMPLETED');
 const cancelled=await api('tasks',{type:'WAIT'});await sleep(200);await api('tasks/'+cancelled.id+'/cancel',{});await sleep(400);
 assert.equal((await api('tasks/'+cancelled.id)).state,'CANCELLED');
 }finally{await agent?.stop();await gateway?.close();await rm(dir,{recursive:true,force:true});}
});
