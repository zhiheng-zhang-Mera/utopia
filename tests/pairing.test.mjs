import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import {resolve} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {parseQr,validateDescriptor,mergeDiscovered,mdnsTxt} from '../contracts/pairing-v1/descriptor.mjs';
const headers={'X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json'};
test('pairing sessions exchange once, expire and reject secret/code guesses without exposing credentials',async()=>{
 const dir=await mkdtemp(resolve('.scratch-pairing-'));let app;
 try{
  let time=Date.now();app=await createGateway({host:'127.0.0.1',port:0,dir,token:'control-secret',nodeToken:'node-secret',pairingClock:()=>time,pairingTtlMs:300000});
  const request=(path,body,auth=false)=>fetch(app.url+'/api/v0/pairing/'+path,{method:body?'POST':'GET',headers:{...headers,...(auth?{Authorization:'Bearer control-secret'}:{})},body:body?JSON.stringify(body):undefined});
  assert.equal((await request('session',{})).status,401);
  let session=await (await request('session',{},true)).json();assert.ok(session.qrSvg.includes('<svg'));
  const qr=parseQr(session.qrPayload,time),info=await (await request('info')).json();
  assert.equal(info.descriptor.cityId,qr.cityId);assert.equal(info.activeSession,true);
  assert(!JSON.stringify(info).includes('control-secret'));assert(!JSON.stringify(info).includes(qr.secret));assert(!JSON.stringify(info).includes(session.shortCode));
  assert(!session.qrPayload.includes('control-secret'));
  const payload={cityId:qr.cityId,sessionId:qr.pairingSessionId,method:'qr',secret:'wrong'};
  assert.equal((await request('exchange',payload)).status,403);
  payload.secret=qr.secret;
  const results=await Promise.all([request('exchange',payload),request('exchange',payload)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,410]);
  const accepted=await results.find(r=>r.status===200).json();assert.equal(accepted.credential,'control-secret');assert.equal(accepted.cityId,info.cityId);
  session=await (await request('session',{},true)).json();time+=300001;
  assert.equal((await request('exchange',{cityId:info.cityId,sessionId:session.pairingSessionId,method:'mdns',shortCode:session.shortCode})).status,410);
  assert.equal((await (await request('info')).json()).activeSession,false);
  session=await (await request('session',{},true)).json();
  for(let i=0;i<5;i++)assert.equal((await request('exchange',{cityId:info.cityId,sessionId:session.pairingSessionId,method:'ble',shortCode:'wrong'})).status,403);
  assert.equal((await request('exchange',{cityId:info.cityId,sessionId:session.pairingSessionId,method:'ble',shortCode:session.shortCode})).status,429);
  const cityId=info.cityId;await app.close();app=await createGateway({host:'127.0.0.1',port:0,dir,token:'control-secret',nodeToken:'node-secret'});
  assert.equal((await (await request('info')).json()).cityId,cityId);
 }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
test('descriptor validation rejects invalid input and conflicts, discovery TXT excludes secrets',()=>{
 const d={descriptorVersion:1,cityId:'city-id',displayName:'Utopia',endpoint:{scheme:'http',host:'192.168.1.2',port:4310},apiVersion:0,schemaVersion:0,pairingSessionId:'session',expiresAt:new Date(Date.now()+60000).toISOString()};
 assert.equal(validateDescriptor(d).cityId,'city-id');
 for(const patch of [{descriptorVersion:2},{endpoint:{...d.endpoint,host:''}},{endpoint:{...d.endpoint,port:65536}},{expiresAt:'2000-01-01T00:00:00Z'},{endpoint:{...d.endpoint,scheme:'file'}}])assert.throws(()=>validateDescriptor({...d,...patch}));
 assert.throws(()=>parseQr('not a URI'));assert.throws(()=>parseQr('https://pair?v=1'));
 const list=mergeDiscovered([],d);assert.equal(mergeDiscovered(list,d).length,1);assert.throws(()=>mergeDiscovered(list,{...d,endpoint:{...d.endpoint,host:'192.168.1.3'}}));
 const txt=mdnsTxt({...d,secret:'sensitive',credential:'private'});assert.deepEqual(Object.keys(txt).sort(),['api','city','schema','session','v']);assert(!JSON.stringify(txt).includes('sensitive'));
});
