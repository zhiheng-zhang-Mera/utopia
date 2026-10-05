import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createGateway,REQUIRED_TASK_CAPABILITIES} from '../services/dev-gateway/server.mjs';
import {describeLegacyNode,resourceBlock,taskRequirements,explainRequirementFit,nodeDescriptor} from '../contracts/node-descriptor-v1/index.mjs';
const request=async(app,path,body,token='owner')=>{const response=await fetch(app.url+'/api/v0/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:body?JSON.stringify(body):undefined});return{status:response.status,body:await response.json()};};
const registration=id=>({id,displayName:id,capabilities:REQUIRED_TASK_CAPABILITIES,metadata:{platform:'win32'}});
test('WBC602 review: explicit malformed roles cannot manufacture an execution identity',()=>{
 for(const roles of ['CONTROL_SURFACE',[],null])assert.throws(()=>nodeDescriptor({nodeId:'not-worker',roles,roleSource:'DECLARED'}),error=>error.code==='INVALID_ROLE');
 assert.throws(()=>nodeDescriptor({nodeId:'not-worker',roles:['VALIDATION_NODE'],isExecutionResource:true}),error=>error.code==='INVALID_DESCRIPTOR');
 const control=nodeDescriptor({nodeId:'control',roles:['CONTROL_SURFACE'],roleSource:'DECLARED'});assert.equal(control.isExecutionResource,false);
 assert.equal(nodeDescriptor({nodeId:'legacy'}).isExecutionResource,true);
});
test('WBC602 review: absent GPU/network observations are unknown, not hardware absence',()=>{
 const empty=resourceBlock();assert.equal(empty.gpu.presence,'UNKNOWN');assert.equal(empty.network.reachable,null);
 const live=describeLegacyNode({id:'legacy',online:true,capabilities:[]});assert.equal(live.resources.network.reachable,true);
});
test('WBC602 review: platform mismatch and measured zero accelerators are distinguished from unknown',()=>{
 const node=nodeDescriptor({nodeId:'windows',platform:'win32',resources:{gpu:{count:0}}});
 assert.ok(explainRequirementFit(taskRequirements({platformConstraints:['linux']}),node).reasons.includes('PLATFORM_MISMATCH'));
 assert.ok(explainRequirementFit(taskRequirements({acceleratorRequired:true}),node).reasons.includes('ACCELERATOR_UNAVAILABLE'));
});
test('WBC602 review: malformed requirement arrays yield typed contract refusals',()=>{
 for(const value of ['task.execute.safe',null,7,[null]])assert.throws(()=>taskRequirements({requiredCapabilities:value}),error=>error.code==='INVALID_REQUIREMENTS');
});
test('WBC602 review: busy endpoint cannot advertise accepting work',async()=>{const dir=await mkdtemp(resolve('.scratch-wbc602-review-'));let app;try{
 app=await createGateway({dir,port:0,token:'owner',nodeToken:'node',roomsDisabled:true});await request(app,'node/register',registration('worker'),'node');const task=await request(app,'tasks',{type:'WAIT'});await request(app,'node/claim',{id:'worker'},'node');const descriptor=(await request(app,'nodes')).body.nodeDescriptors[0];assert.equal(descriptor.availability.acceptingWork,false);assert.equal(descriptor.availability.reason,'ENDPOINT_BUSY');assert.equal((await request(app,'node/claim',{id:'worker'},'node')).body.task,null);assert.equal(app.store.get('tasks',task.body.id).assignedNodeId,'worker');
 }finally{await app?.close();await rm(dir,{recursive:true,force:true});}});
test('WBC602 review: explicitly declared multiple worker roles survive real registration and restart',async()=>{const dir=await mkdtemp(resolve('.scratch-wbc602-review-'));let app;try{
 app=await createGateway({dir,port:0,token:'owner',nodeToken:'node',roomsDisabled:true});const roles=['EXECUTION_NODE','VALIDATION_NODE'];assert.equal((await request(app,'node/register',{...registration('configured-worker'),roles},'node')).status,200);let descriptor=(await request(app,'nodes')).body.nodeDescriptors[0];assert.deepEqual(descriptor.roles,roles);assert.equal(descriptor.roleSource,'DECLARED');await app.close();app=await createGateway({dir,port:0,token:'owner',nodeToken:'node',roomsDisabled:true});descriptor=(await request(app,'nodes')).body.nodeDescriptors[0];assert.deepEqual(descriptor.roles,roles);assert.equal(descriptor.availability.state,'OFFLINE');await request(app,'node/register',registration('configured-worker'),'node');assert.deepEqual((await request(app,'nodes')).body.nodeDescriptors[0].roles,roles);assert.equal((await request(app,'node/register',{...registration('configured-worker'),roles:['CONTROL_SURFACE']},'node')).status,400);
 }finally{await app?.close();await rm(dir,{recursive:true,force:true});}});
