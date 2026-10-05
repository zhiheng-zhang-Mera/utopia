import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {createGateway} from '../services/dev-gateway/server.mjs';

test('Android approval enrolls a named member; durable reconnect survives City restart and self-revoke',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'utopia-native-'));const owner='controlled-native-owner';
 const headers={'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'};
 let app,socket;let serial=0;const pending=new Map();
 const request=async(path,body,credential)=>{
  const response=await fetch(app.url+'/api/v0/'+path,{method:body?'POST':'GET',headers:{...headers,...(credential?{Authorization:'Bearer '+credential}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json()};
 };
 const start=()=>createGateway({host:'127.0.0.1',port:0,dir,token:owner,nodeToken:'native-node'});
 try {
  app=await start();socket=new WebSocket(app.url.replace(/^http/,'ws')+'/api/v0/relay?apiVersion=0&schemaVersion=0&installationId=native-phone');
  await new Promise((ok,bad)=>{socket.on('error',bad);socket.on('message',raw=>{const frame=JSON.parse(raw);if(frame.type==='RELAY_READY')ok();else {const done=pending.get(frame.requestId);if(done){pending.delete(frame.requestId);done(frame.response??frame);}}});});
  const forward=(path,body)=>new Promise((ok)=>{const requestId='native-'+ ++serial;pending.set(requestId,ok);socket.send(JSON.stringify({kind:'relay-request',requestId,path,method:'POST',body}));});
  const claim='controlled-native-claim';
  const asked=await forward('/api/v0/join/request',{displayName:'Phone acceptance',platform:'android',claim});
  const id=asked.payload.requestId??asked.payload.id;
  assert.equal((await request(`join/requests/${id}/approve`,{},owner)).status,200);
  const instanceId='inst-'+ '2'.repeat(32);
  const exchanged=await forward('/api/v0/join/exchange',{requestId:id,claim,installation:{deviceId:'dev-'+ '1'.repeat(32),instanceId,displayName:'Phone acceptance',platform:'android'}});
  assert.equal(exchanged.status,200);const record=exchanged.payload.enrollment;
  assert.equal(record.displayName,'Phone acceptance');assert.equal(record.instanceId,instanceId);assert.ok(exchanged.payload.credential.startsWith('sess:'));
  assert.notEqual(exchanged.payload.credential,owner);
  assert.equal((await request('pairing/session',{},exchanged.payload.credential)).status,403);
  socket.terminate();socket=null;const city=exchanged.payload.cityId;await app.close();app=await start();
  const opened=await request('device/session',{installationId:record.installationId,instanceId:record.instanceId,credentialId:record.credentialId,credentialSecret:record.credentialSecret});
  assert.equal(opened.status,200);assert.equal(opened.data.cityId,city);assert.ok(opened.data.credential.startsWith('sess:'));
  const roster=await request('device/installations',null,opened.data.credential);assert.equal(roster.data.scope,'OWN_INSTALLATION');assert.equal(roster.data.installations.length,1);
  assert.equal((await request(`device/installations/${record.installationId}/revoke`,{reason:'left_by_device'},opened.data.credential)).status,200);
  assert.equal((await request('city',null,opened.data.credential)).status,401);
  assert.equal((await request('device/session',{installationId:record.installationId,instanceId:record.instanceId,credentialId:record.credentialId,credentialSecret:record.credentialSecret})).status,403);
  assert.equal((await request('city',null,owner)).status,200);
 } finally {socket?.terminate();await app?.close();await rm(dir,{recursive:true,force:true});}
});
