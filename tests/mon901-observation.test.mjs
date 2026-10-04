import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Server} from 'node:http';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {createObservation} from '../services/dev-gateway/observation.mjs';

test('bounded canonical projection exposes active task, binding and exact event evidence without raw secrets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mon901-'));const app=await createGateway({dir,port:0,token:'owner',nodeToken:'worker',roomsDisabled:true});
 try {
  app.store.put('nodes',{id:'worker-a',online:true,displayName:'Peer A'});
  app.store.put('tasks',{id:'Q-live',type:'WAIT',state:'RUNNING',assignedNodeId:'worker-a',progress:0.5,error:'private-secret'});
  const ev=app.store.event('TASK_RUNNING','Q-live',{state:'RUNNING',token:'private-secret'},'worker-a');
  const observer=createObservation({read:()=>app.store.observationWindow({limit:2})});
  const view=await observer.refresh();
  assert.equal(view.nodes.find(x=>x.id==='Q-live').state,'RUNNING');
  assert.equal(view.nodes.find(x=>x.id==='Q-live').hostRef,'worker-a');
  assert.ok(view.edges.some(x=>x.from==='Q-live'&&x.to==='worker-a'&&x.type==='ASSIGNED_TO'));
  assert.ok(view.evidence.some(x=>x.canonicalEventId===ev.id&&x.seq===ev.seq));
  assert.equal(JSON.stringify(view).includes('private-secret'),false);
  assert.equal(view.authoritative,false);
  const res=await fetch(app.url+'/api/v0/monitor',{headers:{Authorization:'Bearer owner','X-City-Api-Version':'0','X-City-Schema-Version':'0'}});
  assert.equal(res.status,200);assert.equal((await res.json()).monitor.authoritative,false);
  assert.equal((await fetch(app.url+'/api/v0/monitor')).status,401);
 } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});

test('overflow and missing history remain visible; fresh snapshot reflects canonical state, not cached truth',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mon901-'));const app=await createGateway({dir,port:0,token:'owner',nodeToken:'worker',roomsDisabled:true});
 try {
  for(let i=0;i<5;i++){app.store.put('tasks',{id:'Q-'+i,state:'RUNNING',assignedNodeId:null});app.store.event('TASK_RUNNING','Q-'+i);}
  const observer=createObservation({read:()=>app.store.observationWindow({limit:2})});
  const first=await observer.refresh();assert.equal(first.nodes.filter(x=>x.kind==='TASK').length,2);
  assert.equal(first.completeness.tasksOmitted,3);assert.equal(first.completeness.historyGap,true);
  assert.notEqual(first.health,'COMPLETE');assert.equal(first.nodes.find(x=>x.kind==='TASK').hostRef,null);
  app.store.put('tasks',{id:'Q-0',state:'FAILED',assignedNodeId:null});
  assert.equal((await observer.refresh()).nodes.find(x=>x.id==='Q-0').state,'FAILED');
 } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});

test('slow/disconnected observation never gates real canonical task persistence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mon901-'));const app=await createGateway({dir,port:0,token:'owner',nodeToken:'worker',roomsDisabled:true});
 let release;const observer=createObservation({read:()=>new Promise(r=>{release=r;})});
 try {
  const pending=observer.refresh();
  const response=await fetch(app.url+'/api/v0/tasks',{method:'POST',headers:{Authorization:'Bearer owner','X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json'},body:JSON.stringify({type:'WAIT'})});
  assert.equal(response.status,200);assert.equal(app.store.list('tasks').length,1);
  observer.disconnect();release(app.store.observationWindow());await pending;
  assert.equal(observer.snapshot().health,'DISCONNECTED');
  const failing=createObservation({read:()=>{throw Error('private-secret');}});await failing.refresh();
  assert.equal(failing.snapshot().health,'UNAVAILABLE');assert.equal(JSON.stringify(failing.snapshot()).includes('private-secret'),false);
 } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});

test('real API claim/report projection follows persisted lifecycle and cannot execute commands',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mon901-'));const app=await createGateway({dir,port:0,token:'owner',nodeToken:'worker',roomsDisabled:true});
 const request=async(path,data,credential='owner')=>{
  const response=await fetch(app.url+'/api/v0/'+path,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+credential,'X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
  assert.equal(response.status,200);return response.json();
 };
 try {
  await request('node/register',{id:'node-real',displayName:'Runtime peer',metadata:{platform:'reference'},capabilities:['task.execute.safe','filesystem.temp']},'worker');
  const task=await request('tasks',{type:'WAIT'});
  assert.equal((await request('node/claim',{id:'node-real'},'worker')).task.id,task.id);
  await request('node/report',{id:'node-real',taskId:task.id,state:'RUNNING',progress:10},'worker');
  const projected=(await request('monitor')).monitor;
  assert.equal(projected.nodes.find(n=>n.id===task.id).state,'RUNNING');
  assert.equal(projected.nodes.find(n=>n.id===task.id).hostRef,'node-real');
  assert.ok(projected.events.some(e=>e.type==='TASK_STARTED'&&e.taskRef===task.id));
  await request('node/report',{id:'node-real',taskId:task.id,state:'COMPLETED',progress:100,result:{message:'done'}},'worker');
  assert.equal((await request('monitor')).monitor.nodes.find(n=>n.id===task.id).state,'COMPLETED');
  const denied=await fetch(app.url+'/api/v0/monitor',{method:'POST',headers:{Authorization:'Bearer owner','X-City-Api-Version':'0','X-City-Schema-Version':'0'}});
  assert.equal(denied.status,404);assert.equal(app.store.get('tasks',task.id).state,'COMPLETED');
  assert.equal((await fetch(app.url+'/api/v0/monitor',{headers:{Authorization:'Bearer worker','X-City-Api-Version':'0','X-City-Schema-Version':'0'}})).status,401);
 }finally {await app.close();await rm(dir,{recursive:true,force:true});}
});

test('stalled HTTP monitor request and broken reader leave independent create/cancel requests working',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mon901-'));const app=await createGateway({dir,port:0,token:'owner',nodeToken:'worker',roomsDisabled:true});
 const headers={Authorization:'Bearer owner','X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json'};
 const original=app.store.observationWindow.bind(app.store);let release;let entered;
 const live=new Promise(r=>{entered=r;});
 app.store.observationWindow=()=>new Promise(r=>{release=r;entered();});
 const pending=fetch(app.url+'/api/v0/monitor',{headers});
 try {
  await live;
  const response=await fetch(app.url+'/api/v0/tasks',{method:'POST',headers,body:JSON.stringify({type:'WAIT'}),signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,200);const task=await response.json();
  assert.equal(app.store.get('tasks',task.id).state,'QUEUED');
  release(original());assert.equal((await (await pending).json()).monitor.health,'COMPLETE');
  app.store.observationWindow=()=>{throw Error('private-secret');};
  assert.equal((await (await fetch(app.url+'/api/v0/monitor',{headers})).json()).monitor.health,'UNAVAILABLE');
  assert.equal((await fetch(app.url+'/api/v0/tasks/'+task.id+'/cancel',{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(3000)})).status,200);
  assert.equal(app.store.get('tasks',task.id).state,'CANCELLED');
 }finally {release?.(original());await pending;await app.close();await rm(dir,{recursive:true,force:true});}
});

test('invalid limits cannot create unbounded queries, single flight and unknown populations stay honest',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mon901-'));const app=await createGateway({dir,port:0,token:'owner',nodeToken:'worker',roomsDisabled:true});
 try {
  for(const limit of [0,257,Infinity,-1,1.5])assert.throws(()=>app.store.observationWindow({limit}),RangeError);
  let calls=0;const observer=createObservation({read:()=>{calls++;return {...app.store.observationWindow(),counts:null};}});
  const a=observer.refresh(),b=observer.refresh();assert.equal(a,b);await a;assert.equal(calls,1);assert.equal(observer.snapshot().health,'UNAVAILABLE');
  const good=createObservation({read:()=>app.store.observationWindow()});await good.refresh();const copy=good.snapshot();copy.health='LIE';assert.notEqual(good.snapshot().health,'LIE');
 }finally {await app.close();await rm(dir,{recursive:true,force:true});}
});

test('deleted historical prefix and tail cannot be reported as complete history',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mon901-'));const app=await createGateway({dir,port:0,token:'owner',nodeToken:'worker',roomsDisabled:true});
 try {
  for(let i=0;i<4;i++)app.store.event('TASK_CREATED','Q-history');
  app.store.db.prepare('DELETE FROM events WHERE seq<=2 OR seq=5').run();
  const view=await createObservation({read:()=>app.store.observationWindow()}).refresh();
  assert.equal(view.completeness.historyGap,true);assert.equal(view.health,'PARTIAL');
  assert.equal(view.completeness.canonicalHighWatermark,5);
 }finally {await app.close();await rm(dir,{recursive:true,force:true});}
});

test('Gateway shares outstanding observation and retains stale last view on later source failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mon901-'));const app=await createGateway({dir,port:0,token:'owner',nodeToken:'worker',roomsDisabled:true});
 const headers={Authorization:'Bearer owner','X-City-Api-Version':'0','X-City-Schema-Version':'0'};
 const original=app.store.observationWindow.bind(app.store);const releases=[];let calls=0;let entered;const live=new Promise(r=>{entered=r;});
 app.store.observationWindow=()=>{calls++;entered();return new Promise(r=>{releases.push(r);});};
 let seen=0,secondSeen;const witnessed=new Promise(r=>{secondSeen=r;});const emit=Server.prototype.emit;
 Server.prototype.emit=function(event,...args){const result=emit.call(this,event,...args);if(event==='request'&&args[0].url==='/api/v0/monitor'&&++seen===2)secondSeen();return result;};
 const first=fetch(app.url+'/api/v0/monitor',{headers});
 try {
  await live;const second=fetch(app.url+'/api/v0/monitor',{headers});
  await witnessed;await Promise.resolve();
  for(const release of releases)release(original());const [a,b]=await Promise.all([first,second]);await a.json();await b.json();assert.equal(calls,1);
  app.store.observationWindow=()=>{throw Error('source failed');};
  const failed=(await (await fetch(app.url+'/api/v0/monitor',{headers})).json()).monitor;
  assert.equal(failed.health,'UNAVAILABLE');assert.equal(failed.stale,true);assert.ok(failed.events.length>0);
 }finally {Server.prototype.emit=emit;for(const release of releases)release(original());await first;await app.close();await rm(dir,{recursive:true,force:true});}
});
