import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';

test('a loopback Web gateway searches LAN interfaces rather than the loopback interface',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pair-lan-'));let app,options;
 try{
  app=await createGateway({dir,port:0,token:'loopback-control',nodeToken:'loopback-node',nearbyTimeoutMs:20,
   nearbyBrowser:async value=>{options=value;return {candidates:[],bounded:true,discovered:0};}});
  const response=await fetch(app.url+'/api/v0/join/nearby',{headers:{'X-City-Api-Version':'0','X-City-Schema-Version':'0'}});
  assert.equal(response.status,200);
  assert.ok(options,'the Gateway must invoke its discovery adapter');
  assert.equal(options.interface,undefined,'127.0.0.1 cannot receive Wi-Fi multicast');
 }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
