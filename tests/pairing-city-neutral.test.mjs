import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {resolve} from 'node:path';import {createGateway} from '../services/dev-gateway/server.mjs';
test('custom City lockout never directs users to an unrelated Alien host; explicit renewal remains usable',async()=>{
 const dir=await mkdtemp(resolve('.scratch-city-neutral-'));let app;
 try{
  app=await createGateway({dir,port:0,token:'owner',nodeToken:'node',roomsDisabled:true});app.store.renameCity('Luna');
  const request=async(path,body,owner=false)=>{const r=await fetch(app.url+'/api/v0/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0',...(owner?{Authorization:'Bearer owner'}:{})},body:JSON.stringify(body)});return{status:r.status,data:await r.json()};};
  const first=(await request('pairing/session',{},true)).data;const wrong=first.shortCode==='000000'?'111111':'000000';const payload={cityId:app.store.cityId,sessionId:first.pairingSessionId,method:'mdns',shortCode:wrong};
  for(let i=0;i<5;i++)assert.equal((await request('pairing/exchange',payload)).status,403);
  const locked=await request('pairing/exchange',{...payload,shortCode:first.shortCode});assert.equal(locked.status,429);assert.doesNotMatch(locked.data.error,/Alien/i);
  const renewed=(await request('pairing/session',{},true)).data;assert.notEqual(renewed.pairingSessionId,first.pairingSessionId);assert.equal((await request('pairing/exchange',{cityId:app.store.cityId,sessionId:renewed.pairingSessionId,method:'mdns',shortCode:renewed.shortCode})).status,200);
 }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
