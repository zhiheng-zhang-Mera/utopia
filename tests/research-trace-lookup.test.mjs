// LOOKUP A TRACE RECORD BY ID, AGAINST THE DURABLE STORE.
//
// The measured failure this exists for: an artifact package publishes exact trace pointers as part of its evidence, but
// the City's trace SURFACE is a rolling window (`recordLimit`, default 256). Once enough new records exist, every
// published pointer falls out of that window, and a reproduction host on ANOTHER machine - which can reach nothing but
// the HTTP API - reads 206 published pointers, resolves 0, and is told "0 inconsistencies" because the City honestly
// says PARTIAL. That is not a wrong answer, but it is an unusable one: "nothing to compare" and "compared
// successfully" must not look the same to the person reading a reproduction report.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createTraceCollector} from '../services/research-trace/index.mjs';
import {createGateway} from '../services/dev-gateway/server.mjs';

const V={'X-City-Api-Version':'0','X-City-Schema-Version':'0'};
const OWNER='trace-owner';
const owner={...V,Authorization:'Bearer '+OWNER,'Content-Type':'application/json'};
const at=i=>new Date(Date.UTC(2026,9,8,0,0,i)).toISOString();

test('TRACE-LOOKUP 1: a record outside the RETAINED WINDOW is still resolved from the durable store',async t=>{
  const dir=await mkdtemp(resolve('.scratch-trace-lookup-'));
  // recordLimit of 2 makes the window smaller than the store on purpose: that IS the situation the package's 206
  // pointers are in, and it is the one a snapshot-only reader cannot see out of.
  const trace=createTraceCollector({directory:dir,recordLimit:2,sourceStreamRef:'lookup-test'});
  t.after(async()=>{await trace.close();await rm(dir,{recursive:true,force:true});});
  const ids=[];
  for(let i=0;i<5;i++){const eventId='ev-'+i;ids.push(eventId);
    assert.equal(trace.record({eventId,type:'TASK_CREATED',timestamp:at(i),sourceSeq:i+1}),true);}
  assert.equal(await trace.flush(),true,'the store must be written before it can be asked');

  const snapshot=trace.snapshot();
  assert.equal(snapshot.records.length,2,'the window keeps only the newest 2');
  assert.equal(snapshot.retentionTruncated,true,'and says so');
  const inWindow=snapshot.records.map(r=>r.eventId);
  assert.deepEqual(inWindow,['ev-3','ev-4']);
  const evicted=ids.filter(id=>!inWindow.includes(id));
  assert.equal(evicted.length,3);

  // THE POINT: the evicted ids are invisible to the snapshot and fully resolvable by lookup.
  const held=await trace.lookup(evicted);
  assert.equal(held.storeScope,'DURABLE_TRACE_FILES');
  assert.equal(held.requested,3);
  assert.deepEqual(held.found.slice().sort(),evicted.slice().sort());
  assert.deepEqual(held.absent,[]);
  assert.deepEqual(held.retainedWindow,{recordLimit:2,retained:2});
  assert.equal(held.storageState,'READY');

  // A PUBlISHED POINTER CARRIES A `trace:` PREFIX and the store holds the bare id; the lookup accepts both, because
  // making the caller know which form a surface uses is how the two get compared wrongly.
  const prefixed=await trace.lookup(evicted.map(id=>'trace:'+id));
  assert.deepEqual(prefixed.found.slice().sort(),evicted.slice().sort());

  // Absence and presence are reported SEPARATELY, and include=records returns the record itself when asked.
  const mixed=await trace.lookup(['trace:'+evicted[0],'ev-not-in-store'],{include:'RECORDS'});
  assert.equal(mixed.include,'RECORDS');
  assert.equal(mixed.found.length,1);
  assert.equal(mixed.found[0].eventId,evicted[0]);
  assert.equal(mixed.found[0].record.eventId,evicted[0]);
  assert.equal(mixed.found[0].record.type,'TASK_CREATED');
  assert.deepEqual(mixed.absent,['ev-not-in-store']);

  // Duplicates are collapsed rather than answered twice, and both refusals are typed.
  assert.equal((await trace.lookup([evicted[0],evicted[0]])).requested,1);
  await assert.rejects(()=>trace.lookup([]),error=>error.code==='TRACE_LOOKUP_IDS_REQUIRED');
  await assert.rejects(()=>trace.lookup(Array.from({length:1025},(_,i)=>'x'+i)),error=>error.code==='TRACE_LOOKUP_TOO_MANY_IDS');
});

test('TRACE-LOOKUP 2: the City exposes it owner-only, and a bad request is a 400 rather than a 500',async t=>{
  const dir=await mkdtemp(resolve('.scratch-trace-lookup-route-'));
  const app=await createGateway({dir,port:0,token:OWNER,nodeToken:'trace-node',roomsDisabled:true});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const get=(path,credential=owner)=>fetch(app.url+path,{headers:credential});

  // Make some real trace records through the product's own path.
  await fetch(app.url+'/api/v0/tasks',{method:'POST',headers:owner,body:JSON.stringify({type:'WAIT'})});
  await app.researchTrace.flush();
  const snapshot=(await (await get('/api/v0/research/trace')).json()).trace;
  assert.ok(snapshot.records.length>0,'the fixture must have real trace records');
  const known=snapshot.records.at(-1).eventId;

  // A record the snapshot holds is resolvable, and reports the store scope it answered from.
  const found=(await (await get('/api/v0/research/trace/records?ids='+encodeURIComponent(known))).json()).lookup;
  assert.deepEqual(found.found,[known]);
  assert.deepEqual(found.absent,[]);
  assert.equal(found.storeScope,'DURABLE_TRACE_FILES');
  assert.equal(found.include,'PRESENCE_ONLY','presence is the default so 206 pointers stay a small answer');
  // An unknown id is ABSENT, not an error: a reproduction report has to be able to say which pointers it could not
  // resolve, and failing the whole request would hide the rest.
  const missing=(await (await get('/api/v0/research/trace/records?ids=not-a-record')).json()).lookup;
  assert.deepEqual(missing.found,[]);
  assert.deepEqual(missing.absent,['not-a-record']);

  // Client mistakes are 4xx with their own code, not a 500 the reader would take for a broken City.
  for(const [path,code] of [['/api/v0/research/trace/records','TRACE_LOOKUP_IDS_REQUIRED'],
    ['/api/v0/research/trace/records?ids='+'x'.repeat(181),'TRACE_LOOKUP_ID_INVALID'],
    ['/api/v0/research/trace/records?ids='+Array.from({length:1025},(_,i)=>'i'+i).join(','),'TRACE_LOOKUP_TOO_MANY_IDS']]){
    const response=await get(path);
    assert.equal(response.status,400,`${code} must be a client error`);
    assert.equal((await response.json()).errorCode,code);
  }

  // Owner-only, exactly like the trace surface it belongs to.
  const enrollment=await (await fetch(app.url+'/api/v0/device/enroll',{method:'POST',headers:owner,body:JSON.stringify({displayName:'Member'})})).json();
  const session=(await (await fetch(app.url+'/api/v0/device/session',{method:'POST',headers:V,
    body:JSON.stringify({installationId:enrollment.installation.installationId,instanceId:enrollment.installation.instanceId,...enrollment.credential})})).json()).credential;
  const member={...V,Authorization:'Bearer '+session,'Content-Type':'application/json'};
  const refused=await get('/api/v0/research/trace/records?ids='+encodeURIComponent(known),member);
  assert.equal(refused.status,403);
  assert.equal((await refused.json()).errorCode,'RESEARCH_OWNER_REQUIRED');
});
