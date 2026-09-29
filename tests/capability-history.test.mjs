import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../services/dev-gateway/store.mjs';
import {createBridge} from '../services/capability-bridge/bridge.mjs';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {digest} from '../contracts/capability-bridge-v1/protocol.mjs';

const legacy=(n,result={sections:[{text:'generated public document '+n}]})=>({id:'I-'+n,invocationId:'I-'+n,capabilityId:'planning.document.intake',operationId:'read',inputClass:'document',inputBytes:25,startedAt:'2026-01-01T00:00:00.000Z',finishedAt:'2026-01-01T00:00:01.000Z',status:'COMPLETED',errorCode:null,resultDigest:digest(result),result});
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'utopia-history-'));const store=new Store(dir);try{await fn(store,dir);}finally{store.close();await rm(dir,{recursive:true,force:true});}}
function seed(store,rows){store.db.exec('CREATE TABLE IF NOT EXISTS invocations(id TEXT PRIMARY KEY,json TEXT NOT NULL)');for(const row of rows)store.put('invocations',row);}

test('old SQLite results migrate without changing identity, digest or metadata, including restart',()=>fixture(async store=>{
 const row=legacy(1);seed(store,[row]);let bridge=createBridge(store,()=>{});
 const {result,id,...metadata}=row;
 assert.deepEqual(bridge.list(),[{...metadata,resultAvailable:true}]);
 assert.deepEqual(bridge.get(row.id),{...metadata,resultAvailable:true,result});
 assert.equal(Object.hasOwn(store.get('invocations',row.id),'result'),false);
 bridge.close();bridge=createBridge(store,()=>{});
 assert.deepEqual(bridge.get(row.id),{...metadata,resultAvailable:true,result});bridge.close();
}));

test('migration fails closed and rolls back earlier rows when legacy history is corrupt',()=>fixture(async store=>{
 const row=legacy(1);seed(store,[row]);store.db.prepare('INSERT INTO invocations VALUES(?,?)').run('I-broken','{');
 assert.throws(()=>createBridge(store,()=>{}));
 assert.deepEqual(store.get('invocations',row.id),row,'earlier history must remain unchanged on failure');
 assert.equal(store.db.prepare('SELECT json FROM invocations WHERE id=?').get('I-broken').json,'{');
}));

test('560 large legacy results keep 500 summaries and 50 details; new saves remain bounded',()=>fixture(async store=>{
 const rows=Array.from({length:560},(_,i)=>legacy(i,{sections:[{text:'generated '.repeat(6000)}],previewPngBase64:Buffer.alloc(10000,i%255).toString('base64')}));
 seed(store,rows);const bridge=createBridge(store,()=>{},{execute:async()=>({result:{sections:[{text:'new public result'}]}})});
 try{
  assert.equal(store.list('invocations').length,500);
  assert.equal(bridge.list().length,50);
  assert.equal(bridge.list(999999).length,200);
  assert.ok(bridge.list(200).every(i=>!Object.hasOwn(i,'result')));
  assert.equal(bridge.get('I-59'),null);
  assert.equal(bridge.get('I-60').status,'COMPLETED');
  assert.equal(bridge.get('I-60').resultAvailable,false);
  assert.equal(bridge.get('I-60').result,null);
  assert.equal(bridge.get('I-60').resultDigest,rows[60].resultDigest);
  assert.equal(bridge.get('I-510').resultAvailable,true);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM invocation_details').get().n,50);
  for(let i=0;i<55;i++)await bridge.invoke('planning.document.intake',{operationId:'read',input:{}});
  assert.equal(store.list('invocations').length,500);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM invocation_details').get().n,50);
  assert.equal(bridge.get('I-559').resultAvailable,false);
  assert.equal(bridge.get('I-559').resultDigest,rows[559].resultDigest);
  assert.ok(Buffer.byteLength(JSON.stringify(bridge.list()))<40000,'summary payload independent of result size');
  for(const limit of [0,-1,'oops',1.5,Infinity])assert.throws(()=>bridge.list(limit),{code:'INVALID_LIMIT'});
 }finally{bridge.close();}
}));

test('city and list APIs send summaries only, enforce limits and retrieve individual details',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'utopia-history-http-'));const store=new Store(dir);seed(store,Array.from({length:230},(_,i)=>legacy(i)));store.close();
 const gateway=await createGateway({dir,port:0,token:'history-test',nodeToken:'history-node'});
 const call=async path=>{const r=await fetch(gateway.url+'/api/v0/'+path,{headers:{Authorization:'Bearer history-test','X-City-Api-Version':'0','X-City-Schema-Version':'0'}});return{status:r.status,body:await r.json()};};
 try{
  const snapshot=(await call('city')).body;assert.equal(snapshot.invocations.length,50);assert.ok(snapshot.invocations.every(x=>!Object.hasOwn(x,'result')));
  assert.equal((await call('capability-invocations?limit=3')).body.invocations.length,3);
  assert.equal((await call('capability-invocations?limit=999999')).body.invocations.length,200);
  assert.equal((await call('capability-invocations?limit=bad')).status,400);
  assert.equal((await call('capabilities/unknown')).body.errorCode,'CAPABILITY_NOT_FOUND');
  assert.equal((await call('capability-invocations/I-missing')).body.errorCode,'INVOCATION_NOT_FOUND');
  const old=(await call('capability-invocations/I-0')).body;assert.equal(old.status,'COMPLETED');assert.equal(old.resultAvailable,false);assert.equal(old.resultDigest,legacy(0).resultDigest);
  const last=(await call('capability-invocations/I-229')).body;assert.equal(last.resultAvailable,true);assert.deepEqual(last.result,legacy(229).result);
 }finally{await gateway.close();await rm(dir,{recursive:true,force:true});}
});

test('a long running invocation survives pruning and its completion remains readable',()=>fixture(async store=>{
 let release;const waiting=new Promise(r=>{release=r;});
 const bridge=createBridge(store,()=>{},{execute:async({input})=>input.wait?waiting:{result:{public:true}}});
 try{
  const active=bridge.invoke('planning.document.intake',{operationId:'read',input:{wait:true}});
  const id=bridge.list()[0].invocationId;
  for(let i=0;i<505;i++)await bridge.invoke('planning.document.intake',{operationId:'read',input:{}});
  assert.equal(bridge.get(id).status,'RUNNING');assert.equal(store.list('invocations').length,500);
  release({result:{public:'late completion'}});const completed=await active;
  assert.equal(completed?.status,'COMPLETED');assert.equal(bridge.get(id)?.resultAvailable,true);assert.equal(bridge.list().at(-1).invocationId,id);
 }finally{bridge.close();}
}));
