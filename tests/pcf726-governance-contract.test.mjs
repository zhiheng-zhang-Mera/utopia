import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {compileExecutionCapsule,validateResultEnvelope,createResultLedger} from '../contracts/personal-compute-fabric-v1/execution-capsule.mjs';
const refs=()=>({task_ref:'task:one',action_ref:'action:one',parent_ref:'parent:one',stage_ref:'stage:verify',attempt:1,epoch:2,origin_device_ref:'device:owner',parent_session_ref:'session:owner',execution_device_ref:'device:worker',boot_ref:'boot:one',provider_ref:'provider:one',session_ref:'session:worker',user_ref:'owner:one',base_sha:'a'.repeat(40),candidate_sha:'b'.repeat(40)});
const spec=()=>({fact_version:1,input_refs:['e:one'],write_scope:[],output_contract:'explicit_result',stop_condition:'evidence missing',permission_ref:'permission:one',budget_ref:'budget:one',expires_at:'2099-01-01T00:00:00.000Z',independence_floor_ref:'n1'});
const receipt=c=>({...c.canonical_refs,capsule_ref:c.capsule_ref,result_sha:c.canonical_refs.candidate_sha,sequence:1,outcome:'SUCCEEDED',exit_code:0,stdout_summary:'bounded output',stderr_summary:'',artifacts:[{artifact_ref:'artifact:one',sha256:createHash('sha256').update('bytes').digest('hex')}],validation_evidence_refs:['verify:one'],explicit_result:'verified',assumptions:[],evidence_refs:['verify:one'],uncertainty:['not formal acceptance'],unresolved_questions:[],proposed_next_action:'series review'});
const trusted={now:()=>Date.parse('2026-10-07T00:00:00Z'),readArtifact:()=>Buffer.from('bytes')};
test('PCF726 versioned capsule retains canonical identity and bounded scope; legacy tasks remain untouched',()=>{
 const legacy=refs(),c=compileExecutionCapsule(legacy,spec());assert.equal(c.schema_version,1);assert.equal(c.canonical_refs.epoch,2);assert.deepEqual(legacy,refs());assert.ok(Object.isFrozen(c));assert.deepEqual(c.approved_spec.write_scope,[]);
 assert.throws(()=>compileExecutionCapsule({...legacy,session_ref:null},spec()));
 assert.throws(()=>compileExecutionCapsule(legacy,{...spec(),hidden_reasoning:'private'}));
 assert.throws(()=>compileExecutionCapsule(legacy,{...spec(),input_refs:Array(129).fill('x')}));
});
test('PCF726 result correlation never treats transport or exit zero as acceptance',()=>{
 const c=compileExecutionCapsule(refs(),spec()),r=receipt(c),v=validateResultEnvelope(c,r,trusted);assert.equal(v.valid,true);assert.equal(v.acceptance_authority,false);
 for(const key of ['task_ref','action_ref','parent_ref','stage_ref','origin_device_ref','parent_session_ref','execution_device_ref','boot_ref','provider_ref','session_ref','user_ref','base_sha','candidate_sha','capsule_ref','result_sha'])assert.equal(validateResultEnvelope(c,{...r,[key]:'wrong'},trusted).valid,false,key);
 for(const key of ['attempt','epoch'])assert.equal(validateResultEnvelope(c,{...r,[key]:99},trusted).valid,false,key);
 assert.equal(validateResultEnvelope(c,{...r,artifacts:[]},trusted).valid,false);
 assert.equal(validateResultEnvelope(c,r,{...trusted,readArtifact:()=>Buffer.from('tampered')}).valid,false);
 assert.equal(validateResultEnvelope(c,r,{...trusted,now:()=>Date.parse('2100-01-01')}).valid,false);
 assert.equal(validateResultEnvelope(c,{...r,validation_evidence_refs:[],uncertainty:[]},trusted).valid,false);
 assert.equal(validateResultEnvelope(c,{...r,chain_of_thought:'private'},trusted).valid,false);
 assert.equal(validateResultEnvelope(c,{...r,stdout_summary:'x'.repeat(4097)},trusted).valid,false);
});
test('PCF726 explicit result ledger rejects replay and out of order after restart',()=>{
 const c=compileExecutionCapsule(refs(),spec()),r=receipt(c),ledger=createResultLedger();
 assert.equal(validateResultEnvelope(c,{...r,sequence:2},{...trusted,ledger}).valid,false);
 assert.equal(validateResultEnvelope(c,r,{...trusted,ledger}).valid,true);
 assert.equal(validateResultEnvelope(c,r,{...trusted,ledger}).valid,false);
 const restarted=createResultLedger(ledger.snapshot());assert.equal(validateResultEnvelope(c,r,{...trusted,ledger:restarted}).valid,false);
});
