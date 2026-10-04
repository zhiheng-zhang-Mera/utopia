import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {enrollWithCity,openDeviceSession} from '../apps/client/device-enrollment.mjs';
import {startAgent} from '../agents/reference-node/agent.mjs';
const h=credential=>({'Authorization':'Bearer '+credential,'X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json'});
async function api(app,path,credential='owner',data,method){const r=await fetch(app.url+'/api/v0/'+path,{method:method||(data?'POST':'GET'),headers:h(credential),body:data?JSON.stringify(data):undefined});return {status:r.status,body:await r.json()};}
async function enroll(app,name){const {body:p}=await api(app,'pairing/session','owner',{});const {record}=await enrollWithCity({endpoint:app.url,invite:{cityId:app.store.cityId,sessionId:p.pairingSessionId,method:'mdns',shortCode:p.shortCode},displayName:name});return {...record,...await openDeviceSession(record)};}
test('real joined devices retain names, appear beside the host and may register only their own worker',async()=>{
const dir=await mkdtemp(resolve('.scratch-member-test-'));let app;try{app=await createGateway({dir,port:0,token:'owner',nodeToken:'node',hostDeviceId:'host-a'});const a=await enroll(app,'悉尼电脑');const b=await enroll(app,'墨尔本电脑');
let snap=(await api(app,'city',a.credential)).body;assert.equal(snap.enrolledDevice.displayName,'悉尼电脑');assert.equal(snap.currentMemberRef,a.deviceId);assert.ok(snap.members.some(m=>m.deviceId===b.deviceId&&m.displayName==='墨尔本电脑'));assert.ok(snap.members.some(m=>m.deviceId==='host-a'&&m.role==='PRIMARY'));
assert.equal((await api(app,'node/register',a.credential,{id:a.deviceId,displayName:'fake',capabilities:['task.execute.safe']})).status,200);
assert.equal((await api(app,'node/register',a.credential,{id:b.deviceId,displayName:'stolen',capabilities:[]})).status,403);
assert.equal((await api(app,'node/heartbeat',a.credential,{id:b.deviceId})).status,403);
snap=(await api(app,'city',a.credential)).body;assert.equal(snap.nodes.find(n=>n.id===a.deviceId).displayName,'悉尼电脑');
}finally{await app?.close();await rm(dir,{recursive:true,force:true});}});
test('two members exchange messages with explicit receipt and sender identity cannot be forged',async()=>{
const dir=await mkdtemp(resolve('.scratch-member-message-'));let app;try{app=await createGateway({dir,port:0,token:'owner',nodeToken:'node'});const a=await enroll(app,'A');const b=await enroll(app,'B');
const sent=await api(app,'members/messages',a.credential,{targetDeviceId:b.deviceId,text:'你好 B',senderDeviceId:b.deviceId});assert.equal(sent.status,200);assert.equal(sent.body.message.senderDeviceId,a.deviceId);assert.equal(sent.body.message.state,'PENDING');
assert.equal((await api(app,'members/messages',b.credential)).body.messages[0].text,'你好 B');
assert.equal((await api(app,'members/messages/'+sent.body.message.id+'/receipt',a.credential,{})).status,403);
assert.equal((await api(app,'members/messages/'+sent.body.message.id+'/receipt',b.credential,{})).body.message.state,'RECEIVED');
assert.equal((await api(app,'members/messages',b.credential,{targetDeviceId:a.deviceId,text:'你好 A'})).status,200);
assert.equal((await api(app,'members/messages',a.credential,{targetDeviceId:'other-city',text:'x'})).status,404);
assert.equal((await api(app,'members/messages',a.credential,{targetDeviceId:b.deviceId,text:' '})).status,400);
}finally{await app?.close();await rm(dir,{recursive:true,force:true});}});
test('member B actually computes a task from A; disabling sharing and revoke prevents further claims',async()=>{
const dir=await mkdtemp(resolve('.scratch-member-compute-'));let app,agent;try{app=await createGateway({dir,port:0,token:'owner',nodeToken:'node'});const a=await enroll(app,'A');const b=await enroll(app,'B');
agent=await startAgent({url:app.url,token:b.credential,id:b.deviceId,displayName:b.displayName,workspace:resolve(dir,'b-work'),interval:80,stepDelay:10});
const action=await api(app,'actions',a.credential,{route:'CITY_TASK',target:'city.task',operation:'HASH_TEMP_ARTIFACT',input:{targetDeviceRef:b.deviceId},idempotencyKey:'b-hash'});assert.equal(action.status,200);const task={body:{id:action.body.action.backendRef.taskId}};
let saved;for(let i=0;i<150;i++){saved=(await api(app,'tasks/'+task.body.id,a.credential)).body;if(saved.state==='COMPLETED')break;await new Promise(r=>setTimeout(r,40));}assert.equal(saved.state,'COMPLETED');assert.equal(saved.assignedNodeId,b.deviceId);assert.match(saved.result.sha256,/^[a-f0-9]{64}$/);
assert.equal((await api(app,'node/sharing',b.credential,{id:b.deviceId,enabled:false})).status,200);
assert.equal((await api(app,'node/claim',b.credential,{id:b.deviceId})).body.task,null);
assert.equal((await api(app,'node/sharing',a.credential,{id:b.deviceId,enabled:true})).status,403);
await api(app,'device/installations/'+b.installationId+'/revoke','owner',{});assert.equal((await api(app,'node/heartbeat',b.credential,{id:b.deviceId})).status,401);
}finally{await agent?.stop();await app?.close();await rm(dir,{recursive:true,force:true});}});

test('new admission cannot take the host or an existing member identity, even with a valid short code',async()=>{const dir=await mkdtemp(resolve('.scratch-member-collision-'));let app;try{app=await createGateway({dir,port:0,token:'owner',nodeToken:'node'});const victim=await enroll(app,'Victim');for(const deviceId of [(await api(app,'city')).body.hostDeviceId,victim.deviceId]){const p=(await api(app,'pairing/session','owner',{})).body;const rejected=await api(app,'pairing/exchange','',{cityId:app.store.cityId,sessionId:p.pairingSessionId,method:'mdns',shortCode:p.shortCode,installation:{displayName:'Attacker',deviceId,browserOnly:true}});assert.equal(rejected.status,409);assert.equal(rejected.body.errorCode,'DEVICE_ID_ALREADY_EXISTS');const legitimate=await api(app,'pairing/exchange','',{cityId:app.store.cityId,sessionId:p.pairingSessionId,method:'mdns',shortCode:p.shortCode,installation:{displayName:'Fresh',browserOnly:true}});assert.equal(legitimate.status,200);assert.notEqual(legitimate.body.member.deviceId,deviceId);}
}finally{await app?.close();await rm(dir,{recursive:true,force:true});}});
test('an active browser session refresh actually extends expiry while preserving its installation scope',async()=>{const dir=await mkdtemp(resolve('.scratch-session-renew-'));let app;let clock=Date.now();try{app=await createGateway({dir,port:0,token:'owner',nodeToken:'node',deviceClock:()=>clock});const a=await enroll(app,'A');clock+=3600000;const fresh=await api(app,'device/session','',{sessionId:a.session.sessionId});assert.equal(fresh.status,200);assert.ok(Date.parse(fresh.body.session.expiresAt)>Date.parse(a.session.expiresAt));assert.equal(fresh.body.installation.deviceId,a.deviceId);assert.notEqual(fresh.body.credential,a.credential);clock=Date.parse(a.session.expiresAt)+1;assert.equal((await api(app,'city',fresh.body.credential)).status,200);assert.equal((await api(app,'city',a.credential)).status,401);
}finally{await app?.close();await rm(dir,{recursive:true,force:true});}});
