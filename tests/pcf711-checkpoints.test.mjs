import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createArtifactStore,sha256} from '../services/personal-compute-fabric/artifacts.mjs';
import {saveCheckpoint,restoreCheckpoint} from '../services/personal-compute-fabric/checkpoint.mjs';
test('approved fenced new attempt restores real chunked CPU state and retains old binding',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pcf711-'));try{
 const store=createArtifactStore({root,maxBytes:100000,maxItems:10,authorize:()=>true});
 const binding={taskId:'t',attemptId:'old',inputDigest:sha256('input'),providerVersion:'1',stageId:'cpu',owner:'owner',dataScope:'private',expiresAt:100,executorVersion:'cpu-v1',runtimeVersion:'node24',modelVersion:'NOT_APPLICABLE_CPU',platform:'portable-js-integer',dependencyDigest:sha256('no-dependencies'),workloadKind:'CPU'};
 const compute=(start,end,sum)=>{for(let i=start;i<end;i++)sum=(sum+i*i)%1000000007;return sum;};
 const ref=await saveCheckpoint(store,{sideEffects:'NONE',cursor:500,sum:compute(0,500,0)},binding,0);
 const target={...binding,attemptId:'new'};
 await assert.rejects(restoreCheckpoint(store,ref,target,1),/CHECKPOINT_BINDING_attemptId/);
 const approval={approved:true,sourceAttemptId:'old',targetFence:'fence-2',validateFence:async(b,request)=>b.attemptId==='new'&&request.sourceBinding.attemptId==='old'&&request.sourceBinding.taskId===b.taskId&&request.targetFence==='fence-2'};
 const state=await restoreCheckpoint(store,ref,target,1,approval);
 assert.equal(sha256(String(compute(state.cursor,1000,state.sum))),sha256(String(compute(0,1000,0))));
 for(const key of ['taskId','inputDigest','providerVersion','modelVersion','executorVersion','runtimeVersion','platform','dependencyDigest'])await assert.rejects(restoreCheckpoint(store,ref,{...target,[key]:key==='dependencyDigest'?sha256('wrong'):'wrong'},1,approval),new RegExp('CHECKPOINT_BINDING_'+key));
 const restarted=createArtifactStore({root,maxBytes:100000,maxItems:10,authorize:()=>true});
 await assert.rejects(restoreCheckpoint(restarted,ref,target,1,approval),/CHECKPOINT_RESTORE_ALREADY_CLAIMED/);
 await assert.rejects(restoreCheckpoint(store,ref,{...target,attemptId:'third'},1,{...approval,validateFence:async()=>false}),/CHECKPOINT_FENCE_REJECTED/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('new attempt recovery rejects absent compatibility and legacy same-attempt remains readable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pcf711-'));try{
 const store=createArtifactStore({root,maxBytes:100000,maxItems:10,authorize:()=>true});
 const binding={taskId:'t',attemptId:'old',inputDigest:sha256('input'),providerVersion:'1',stageId:'cpu',owner:'owner',dataScope:'private',expiresAt:100};
 const ref=await saveCheckpoint(store,{sideEffects:'NONE',cursor:1},binding,0);assert.equal((await restoreCheckpoint(store,ref,binding,1)).cursor,1);
 await assert.rejects(restoreCheckpoint(store,ref,{...binding,attemptId:'new'},1,{approved:true,sourceAttemptId:'old',targetFence:'fence'}),/CHECKPOINT_COMPATIBILITY_REQUIRED/);
 }finally{await rm(root,{recursive:true,force:true});}
});
