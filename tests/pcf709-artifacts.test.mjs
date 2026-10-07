import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,rename,unlink,readdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createArtifactStore,sha256} from '../services/personal-compute-fabric/artifacts.mjs';
import * as cache from '../services/personal-compute-fabric/cache.mjs';
test('pins and leases survive restart and revoked bytes are visibly deleted',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pcf709-'));try{
 const config={root,maxBytes:100,maxItems:2,authorize:()=>true},s=createArtifactStore(config),meta={owner:'o',dataScope:'d',expiresAt:100,schema:'bytes'};
 const ref=await s.publish(Buffer.from('bytes'),meta,0);await s.pin(ref.id,{},0);assert.equal((await createArtifactStore(config).evict({},1)).deleted.length,0);
 await s.unpin(ref.id,{},1);await s.lease(ref.id,{},20,1);assert.equal((await s.evict({},2)).deleted.length,0);
 assert.equal((await s.revoke(ref.id,{},2)).state,'DELETED');await assert.rejects(s.read(ref,{},3));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('corruption and authorization revoked before publication keep bytes unavailable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pcf709-'));try{
 let publishAllowed=false;const s=createArtifactStore({root,maxBytes:10,maxItems:2,authorize:({operation})=>operation!=='PUBLISH'||publishAllowed}),metadata={owner:'o',dataScope:'d',expiresAt:100,schema:'bytes'},source={digest:sha256('abc'),size:3,version:1};
 const t=await s.beginTransfer(source,metadata,{},0);await s.appendTransfer(t.id,Buffer.from('abc'),0,source,{},1);
 await assert.rejects(s.finishTransfer(t.id,{},2),/ARTIFACT_UNAUTHORIZED/);await assert.rejects(s.read({...source,id:t.id},{},2),/ARTIFACT_UNKNOWN/);
 publishAllowed=true;await writeFile(join(root,t.id+'.blob.partial'),'abd');await assert.rejects(s.finishTransfer(t.id,{},3),/TRANSFER_DIGEST/);
 assert.equal((await s.cancelTransfer(t.id,{},4)).state,'DELETED');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('authorization revoked during direct publication removes partial and restores quota',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pcf709-'));try{
 let checks=0;const s=createArtifactStore({root,maxBytes:3,maxItems:1,authorize:()=>++checks===1}),metadata={owner:'o',dataScope:'d',expiresAt:100,schema:'bytes'};
 await assert.rejects(s.publish(Buffer.from('abc'),metadata,0),/ARTIFACT_UNAUTHORIZED/);
 assert.equal((await readdir(root)).filter(f=>f.endsWith('.partial')||f.endsWith('.blob')).length,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('expired and revoked partials can be authorized cancelled with visible cleanup failure and retry',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pcf709-'));try{
 let fail=false;const config={root,maxBytes:6,maxItems:1,authorize:()=>true,storageIo:{unlink:async p=>{if(fail&&p.endsWith('.partial'))throw Object.assign(new Error('injected'),{code:'EACCES'});return unlink(p);}}};
 const s=createArtifactStore(config),metadata={owner:'o',dataScope:'d',expiresAt:5,schema:'bytes'},source={digest:sha256('abcdef'),size:6,version:1};
 const t=await s.beginTransfer(source,metadata,{},0);await s.appendTransfer(t.id,Buffer.from('abc'),0,source,{},1);
 fail=true;assert.equal((await s.cancelTransfer(t.id,{},6)).state,'DELETE_FAILED');
 await assert.rejects(s.appendTransfer(t.id,Buffer.from('def'),3,source,{},2),/TRANSFER_CANCELLED/);
 fail=false;assert.equal((await s.cleanupExpiredTransfers({},6)).deleted[0],t.id);
 await s.beginTransfer(source,{...metadata,expiresAt:10},{},6);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('transfer publish recovers index fault and descriptor cleanup fault idempotently without double quota',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pcf709-'));try{
 let failIndex=true,failCleanup=true;const config={root,maxBytes:6,maxItems:1,authorize:()=>true,storageIo:{rename:async(a,b)=>{if(failIndex&&b.endsWith('index.json'))throw Object.assign(new Error('injected ENOSPC'),{code:'ENOSPC'});return rename(a,b);},unlink:async p=>{if(failCleanup&&p.endsWith('.transfer.json'))throw Object.assign(new Error('injected cleanup'),{code:'EACCES'});return unlink(p);}}};
 const s=createArtifactStore(config),metadata={owner:'o',dataScope:'d',expiresAt:100,schema:'bytes'},source={digest:sha256('abcdef'),size:6,version:1};
 const t=await s.beginTransfer(source,metadata,{},0);await s.appendTransfer(t.id,Buffer.from('abcdef'),0,source,{},1);
 await assert.rejects(s.finishTransfer(t.id,{},2),/injected ENOSPC/);
 failIndex=false;const next=createArtifactStore(config),ref=await next.finishTransfer(t.id,{},3);assert.equal(ref.id,t.id);assert.deepEqual(await next.read(ref,{},4),Buffer.from('abcdef'));
 assert.equal((await next.transferStatus(t.id,{},4)).state,'PUBLISHED_CLEANUP_FAILED');
 failCleanup=false;assert.deepEqual(await next.finishTransfer(t.id,{},5),ref);assert.deepEqual(await next.finishTransfer(t.id,{},6),ref);
 assert.equal((await readdir(root)).filter(p=>p.endsWith('.blob')).length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('cancelled journal-owned blob after chained index and cleanup faults remains counted unavailable storage',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pcf709-'));try{
 let failIndex=true,failDelete=true;const config={root,maxBytes:6,maxItems:2,authorize:()=>true,storageIo:{rename:async(a,b)=>{if(failIndex&&b.endsWith('index.json'))throw Object.assign(new Error('injected index'),{code:'ENOSPC'});return rename(a,b);},unlink:async p=>{if(failDelete&&p.endsWith('.blob'))throw Object.assign(new Error('injected delete'),{code:'EACCES'});return unlink(p);}}};
 const s=createArtifactStore(config),metadata={owner:'o',dataScope:'d',expiresAt:100,schema:'bytes'},source={digest:sha256('abc'),size:3,version:1};
 const t=await s.beginTransfer(source,metadata,{},0);await s.appendTransfer(t.id,Buffer.from('abc'),0,source,{},1);
 await assert.rejects(s.finishTransfer(t.id,{},2),/injected index/);failIndex=false;
 assert.equal((await s.cancelTransfer(t.id,{},3)).state,'DELETE_FAILED');
 await assert.rejects(s.read({...source,id:t.id},{},4),/ARTIFACT_UNKNOWN/);
 const other=await s.publish(Buffer.from('xyz'),metadata,4);assert.deepEqual(await s.read(other,{},5),Buffer.from('xyz'));
 await assert.rejects(s.publish(Buffer.from('z'),metadata,5),/CACHE_QUOTA/);
 failDelete=false;assert.deepEqual((await s.cleanupExpiredTransfers({},6)).deleted,[t.id]);
 const last=await s.publish(Buffer.from('z'),metadata,7);assert.deepEqual(await s.read(last,{},8),Buffer.from('z'));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('repository input manifest includes explicit dirty content and refuses secrets and traversal',()=>{
 const input={repository:'https://example.invalid/repo',commit:'a'.repeat(40),dirty:[{path:'src/main.mjs',bytes:Buffer.from('modified')} ]};
 const manifest=cache.repositorySnapshotManifest(input);assert.equal(manifest.dirty[0].digest,sha256('modified'));assert.equal(manifest.dirty[0].size,8);
 assert.throws(()=>cache.repositorySnapshotManifest({...input,dirty:[{path:'.env',bytes:Buffer.from('secret')}]}),/REPOSITORY_SECRET/);
 assert.throws(()=>cache.repositorySnapshotManifest({...input,dirty:[{path:'../escape',bytes:Buffer.from('x')}]}),/REPOSITORY_PATH/);
});
test('transfer descriptors cannot overwrite owner authorization or schema',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pcf709-'));try{
 const s=createArtifactStore({root,maxBytes:100,maxItems:2,authorize:()=>true}),source={digest:sha256('x'),size:1,version:1},metadata={owner:'o',dataScope:'d',expiresAt:100,schema:'bytes'};
 await assert.rejects(s.beginTransfer({...source,owner:'attacker'},metadata,{},0),/TRANSFER_BINDING/);
 await assert.rejects(s.beginTransfer(source,{...metadata,id:'attacker'}, {},0),/ARTIFACT_METADATA_KEY/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('partial transfer resumes across instances only with matching version and digest',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pcf709-'));try{
 const config={root,maxBytes:100,maxItems:2,authorize:()=>true},s=createArtifactStore(config),bytes=Buffer.from('abcdef'),meta={owner:'o',dataScope:'d',expiresAt:100,schema:'bytes'};
 const transfer=await s.beginTransfer({digest:sha256(bytes),size:6,version:2},meta,{},0);
 await s.appendTransfer(transfer.id,Buffer.from('abc'),0,{digest:sha256(bytes),version:2},{},1);
 const next=createArtifactStore(config);await assert.rejects(next.appendTransfer(transfer.id,Buffer.from('def'),3,{digest:sha256(bytes),version:3},{},2),/TRANSFER_BINDING/);
 await next.appendTransfer(transfer.id,Buffer.from('def'),3,{digest:sha256(bytes),version:2},{},2);
 const ref=await next.finishTransfer(transfer.id,{},3);assert.deepEqual(await next.read(ref,{},4),bytes);
 await writeFile(join(root,'orphan.blob'),'x');await assert.rejects(next.publish(Buffer.from('x'),meta,4),/ARTIFACT_ORPHAN/);
 }finally{await rm(root,{recursive:true,force:true});}
});
