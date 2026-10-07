import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';
const headers={Authorization:'Bearer dgx-owner','X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json'};
test('DGX007 gateway exposes owner-only governance and unavailable storage never blocks canonical city',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgx-gateway-'));writeFileSync(join(dir,'governance'),'blocked directory');
 const app=await createGateway({dir,port:0,token:'dgx-owner',nodeToken:'dgx-worker',roomsDisabled:true});
 try{
  const r=await fetch(app.url+'/api/v0/governance',{headers});assert.equal(r.status,200);assert.equal((await r.json()).governance.health,'UNAVAILABLE');
  const city=await fetch(app.url+'/api/v0/city',{headers});assert.equal(city.status,200);
  const unauth=await fetch(app.url+'/api/v0/governance');assert.equal(unauth.status,401);
  const worker=await fetch(app.url+'/api/v0/governance',{headers:{...headers,Authorization:'Bearer dgx-worker'}});assert.notEqual(worker.status,200);
  assert.equal(app.store.list('tasks').length,0);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
