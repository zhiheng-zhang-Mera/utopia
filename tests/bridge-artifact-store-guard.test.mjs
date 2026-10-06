import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {createThemeArtifacts} from '../services/capability-bridge/theme-artifacts.mjs';
const headers={Authorization:'Bearer store-guard','X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json'};
const input={prompt:'blue research compact no persona',observationPreset:'desktop',injectFailure:false};
const build=g=>fetch(g.url+'/api/v0/capabilities/presentation.theme.lab/invoke',{method:'POST',headers,body:JSON.stringify({operationId:'build',input})}).then(r=>r.json());
// A reachable Room Hub, so `degraded` in this file can only ever mean the artifact store. If rooms were simply
// switched off, health would legitimately say degraded and the probe could not tell the two causes apart.
const roomFetch=async url=>({ok:true,status:200,text:async()=>JSON.stringify(url.endsWith('/health')?{product:'utopia-room-pack',version:'v1'}:{rooms:[{id:'fixture'}],loaded:['fixture']})});
// Cleanup must never replace the diagnostic. These probes are meant to fail on an unguarded tree, and a failed
// createGateway can leave the store handle open - so a throwing rmSync inside `finally` would report EPERM and
// hide the EEXIST that is the actual finding. Removal is best-effort; the real error is left to surface.
const cleanup=dir=>{try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:50});}catch{}};
// The reason must be the filesystem's own code, never a placeholder. Which code differs by how the path is broken and
// by platform: creating a root that is an existing FILE gives EEXIST, addressing a directory THROUGH a file gives
// ENOTDIR on Linux and ENOENT on Windows (ERROR_PATH_NOT_FOUND), and a vanished root gives ENOENT. All three are
// measured here, so the assertion names the set rather than pretending one code is universal.
const ERRNO=/^(EEXIST|ENOTDIR|ENOENT)$/;

// The merged defect this file guards: createThemeArtifacts ran mkdirSync and realpathSync UNGUARDED, and
// createBridge calls it during createGateway. One file where <runtime>/theme-packages belongs therefore threw
// EEXIST out of createGateway itself and the whole City refused to start - tasks, nodes, rooms and execution
// paths all unavailable because a presentation capability could not make a directory. The existing
// "unavailable artifact storage" test could not see it: it plants the file AFTER the gateway is already up, so
// it only ever exercised allocate(). These probes plant the fault BEFORE construction.
test('theme artifact store degrades on an uncreatable root and refuses typed instead of throwing',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'utopia-artifact-unit-'));
 try{
  const root=path.join(dir,'theme-packages');fs.writeFileSync(root,'a file, not a directory');
  const artifacts=createThemeArtifacts(root);
  assert.equal(artifacts.state(),'UNAVAILABLE');
  assert.match(artifacts.reason(),ERRNO,'the reason is the filesystem truth, not a placeholder');
  assert.throws(()=>artifacts.allocate('I-00000000-0000-0000-0000-000000000001'),error=>error.code==='BUILD_STORAGE_UNAVAILABLE','a degraded store refuses with the same typed code the bridge already maps');
  // finish() has no sandbox to close and must not throw away the caller's outcome by exploding here.
  assert.equal(artifacts.finish('I-00000000-0000-0000-0000-000000000001',true),undefined);
  // A healthy root keeps working, so the guard is not a blanket disable.
  const good=createThemeArtifacts(path.join(dir,'healthy'));
  assert.equal(good.state(),'READY');assert.equal(good.reason(),null);
 }finally{cleanup(dir);}
});

test('a store that breaks after startup is recorded, and losing it cannot erase a finished build',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'utopia-artifact-runtime-'));
 try{
  const root=path.join(dir,'theme-packages'),artifacts=createThemeArtifacts(root);
  const id='I-00000000-0000-0000-0000-000000000002';
  assert.equal(artifacts.state(),'READY');
  const sandbox=artifacts.allocate(id);fs.mkdirSync(path.join(sandbox,'package'));
  // The root disappears between allocate() and finish() - the package is already built and digested by then.
  fs.rmSync(root,{recursive:true,force:true});
  assert.equal(artifacts.finish(id,true),undefined,'bookkeeping must not throw away a result the caller already has');
  assert.equal(artifacts.state(),'UNAVAILABLE','the store flips to UNAVAILABLE the moment it is known to be broken');
  assert.match(artifacts.reason(),ERRNO);
  // The gateway's own catch turns any throw out of this path into a failed invocation, so a bookkeeping fault here
  // would have reported a real, verified build as BUILD_STORAGE_UNAVAILABLE. That is the defect this asymmetry closes.
  assert.throws(()=>artifacts.allocate('I-00000000-0000-0000-0000-000000000003'),error=>error.code==='BUILD_STORAGE_UNAVAILABLE');
 }finally{cleanup(dir);}
});

test('a file at the theme-packages path leaves the City serving and the theme lab typed-failed',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'utopia-artifact-brick-'));let g;
 try{
  const root=path.join(dir,'theme-packages');fs.writeFileSync(root,'a file, not a directory');
  g=await createGateway({dir,port:0,token:'store-guard',nodeToken:'store-guard-node',roomFetch});
  // 1. The City is UP. On the unguarded construction this line is never reached: createGateway throws EEXIST.
  const health=await(await fetch(g.url+'/api/v0/health',{headers})).json();
  assert.equal(health.status,'healthy','one uncreatable capability store must not make a serving City report itself dead');
  assert.equal(health.components.gateway.state,'READY');
  assert.equal(health.components.rooms.state,'READY','the control: rooms are up, so nothing else can explain a degraded word');
  assert.equal(health.components.artifacts.state,'UNAVAILABLE');
  assert.match(health.components.artifacts.reason,ERRNO);
  // 2. The rest of the City really works, not just its health route.
  const created=await(await fetch(g.url+'/api/v0/tasks',{method:'POST',headers,body:JSON.stringify({type:'WAIT'})})).json();
  assert.ok(created.id);assert.equal(g.store.get('tasks',created.id).state,'QUEUED');
  // 3. The degraded capability fails typed and terminally - no orphaned RUNNING row, no thrown 500.
  const failed=await build(g);
  assert.equal(failed.status,'FAILED');assert.equal(failed.errorCode,'BUILD_STORAGE_UNAVAILABLE');
  const snapshot=await(await fetch(g.url+'/api/v0/city',{headers})).json();
  assert.equal(snapshot.invocations.at(-1).status,'FAILED');
  assert.equal(snapshot.invocations.at(-1).errorCode,'BUILD_STORAGE_UNAVAILABLE');
  // 4. Repairing the filesystem repairs the capability: a restart with the file gone is READY and builds again.
  await g.close();g=null;fs.rmSync(root,{recursive:true});
  g=await createGateway({dir,port:0,token:'store-guard',nodeToken:'store-guard-node',roomFetch});
  const repaired=await(await fetch(g.url+'/api/v0/health',{headers})).json();
  assert.equal(repaired.components.artifacts.state,'READY');
  const completed=await build(g);
  assert.equal(completed.status,'COMPLETED',JSON.stringify(completed));
  assert.ok(completed.result.packageDigest);
 }finally{await g?.close();cleanup(dir);}
});

test('degrading the artifact store blocks only the theme lab, never the capability registry',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'utopia-artifact-scope-'));let g;
 try{
  fs.writeFileSync(path.join(dir,'theme-packages'),'a file, not a directory');
  g=await createGateway({dir,port:0,token:'store-guard',nodeToken:'store-guard-node',roomFetch});
  const registry=await(await fetch(g.url+'/api/v0/capabilities',{headers})).json();
  const lab=registry.capabilities.find(c=>c.capabilityId==='presentation.theme.lab');
  // The capability is still advertised and still AVAILABLE: its storage is degraded, not its descriptor, and
  // the degradation is a per-invocation typed refusal rather than a silently missing capability.
  assert.ok(lab);assert.equal(lab.bridgeState,'AVAILABLE');
  const invocations=await(await fetch(g.url+'/api/v0/capability-invocations',{headers})).json();
  assert.ok(Array.isArray(invocations.invocations));
  const unknown=await fetch(g.url+'/api/v0/capabilities/does.not.exist/invoke',{method:'POST',headers,body:JSON.stringify({operationId:'build',input})});
  assert.equal(unknown.status,404,'the degraded store must not turn every capability call into a storage error');
 }finally{await g?.close();cleanup(dir);}
});

test('a store that breaks while the City runs is reported in health, not only after a restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'utopia-artifact-live-'));let g;
 try{
  g=await createGateway({dir,port:0,token:'store-guard',nodeToken:'store-guard-node',roomFetch});
  const root=path.join(dir,'theme-packages');
  assert.equal((await(await fetch(g.url+'/api/v0/health',{headers})).json()).components.artifacts.state,'READY');
  assert.equal((await build(g)).status,'COMPLETED','the control: the capability really works before the store breaks');
  fs.rmSync(root,{recursive:true,force:true});fs.writeFileSync(root,'a file, not a directory');
  const failed=await build(g);
  assert.equal(failed.status,'FAILED');assert.equal(failed.errorCode,'BUILD_STORAGE_UNAVAILABLE');
  // The store is only known to be broken at this instant, and health must say so at this instant: a supervisor that
  // has to restart the City to learn that a capability stopped persisting has been told too late.
  const health=await(await fetch(g.url+'/api/v0/health',{headers})).json();
  assert.equal(health.status,'healthy','the City itself is still serving');
  assert.equal(health.components.artifacts.state,'UNAVAILABLE');
  assert.match(health.components.artifacts.reason,ERRNO);
  const created=await(await fetch(g.url+'/api/v0/tasks',{method:'POST',headers,body:JSON.stringify({type:'WAIT'})})).json();
  assert.ok(created.id);
 }finally{await g?.close();cleanup(dir);}
});
