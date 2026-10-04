import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';
const valid={experimentId:'alien-independent-review',question:'Does strict routing preserve target identity?',topology:'TWO_HOST_MESH',hosts:['host-a','host-b'],workers:['host-a','host-b'],controlSurfaces:['control-a'],variables:{independent:['target'],dependent:['completion'],controls:['taskType']},repetitions:3,seedPolicy:'PER_REPETITION',baseSeed:41,requiredCapabilities:['research.evidence.review'],stopConditions:[{kind:'MAX_REPETITIONS',value:3}],artifactPolicy:{retention:'SUMMARY_ONLY'},acceptance:{primary:'All runs remain on the target'},softwareRefs:['utopia@8f8c521fc299d622093776615b653457d8833f96']};
test('Alien independently constructs all workbook negative cases and restart seed consistency',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rex801-review-'));let app;const start=()=>createGateway({dir,port:0,token:'review-owner',nodeToken:'review-node',roomsDisabled:true});
 try{app=await start();const req=async(path,manifest,method=null)=>{const r=await fetch(app.url+'/api/v0/research/experiments'+path,{method:method??(manifest?'POST':'GET'),headers:{Authorization:'Bearer review-owner','X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json'},body:manifest?JSON.stringify({manifest}):undefined});return {status:r.status,data:await r.json()};};
 for(const [label,patch,code] of [['malformed',{question:null},'MISSING_FIELD'],['unknown capability',{requiredCapabilities:['not-a-capability']},'UNKNOWN_CAPABILITY'],['impossible topology',{hosts:['one']},'TOPOLOGY_IMPOSSIBLE'],['conflicting variables',{variables:{independent:['same'],dependent:['same'],controls:['task']}},'CONFLICTING_VARIABLES']]){const r=await req('/validate',{...valid,...patch});assert.equal(r.data.validation.ok,false,label);assert.ok(r.data.validation.issues.some(x=>x.code===code),label);}
 assert.equal((await req('',valid)).status,200);assert.equal((await req('',{...valid,question:'A different identity-content mapping'})).status,409);const before=(await req('/alien-independent-review/seeds')).data;await app.close();app=await start();const after=(await req('/alien-independent-review/seeds')).data;assert.deepEqual(before,after);assert.equal(app.store.list('tasks').length,0);
 }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
test('a manifest with only a movable branch must not pass exact software provenance validation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rex801-review-'));const app=await createGateway({dir,port:0,token:'review-owner',nodeToken:'review-node',roomsDisabled:true});
 try{const r=await fetch(app.url+'/api/v0/research/experiments/validate',{method:'POST',headers:{Authorization:'Bearer review-owner','X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json'},body:JSON.stringify({manifest:{...valid,softwareRefs:['utopia@main']}})});const data=await r.json();assert.equal(data.validation.ok,false,'Movable branch is not exact software/config provenance');}finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
test('two equal host references are one physical host, not a TWO_HOST_MESH',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rex801-review-'));const app=await createGateway({dir,port:0,token:'review-owner',nodeToken:'review-node',roomsDisabled:true});
 try{const r=await fetch(app.url+'/api/v0/research/experiments/validate',{method:'POST',headers:{Authorization:'Bearer review-owner','X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json'},body:JSON.stringify({manifest:{...valid,hosts:['host-a','host-a'],workers:['host-a','host-a']}})});const data=await r.json();assert.equal(data.validation.ok,false,'Duplicate refs cannot satisfy physical topology cardinality');}finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
