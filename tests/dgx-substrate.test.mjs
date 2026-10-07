import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {compileExecutionCapsule,validateResultEnvelope} from '../contracts/personal-compute-fabric-v1/execution-capsule.mjs';
import {compileTaskCapsule} from '../contracts/deliberative-governance-v2/core.mjs';
import {createGovernanceService} from '../services/dev-gateway/governance.mjs';
import {draft} from './fixtures/dgx-case.mjs';
const canonical=()=>({task_ref:'task:one',action_ref:'action:one',parent_ref:'parent:one',stage_ref:'stage:one',attempt:1,epoch:1,origin_device_ref:'owner:one',parent_session_ref:'session:owner',execution_device_ref:'device:worker',boot_ref:'boot:one',provider_ref:'provider:one',session_ref:'session:worker',user_ref:'user:one',base_sha:'b'.repeat(40),candidate_sha:'a'.repeat(40)});
const approved={write_scope:[],permission_ref:'permission:one',budget_ref:'budget:one',expires_at:'2099-01-01',fact_version:1};
const pcf={compileExecutionCapsule:(r,s)=>compileExecutionCapsule(r,{...approved,...s}),validateResultEnvelope:(c,r)=>validateResultEnvelope(c,r,{readArtifact:()=>Buffer.from('artifact')})};
const result=c=>({...canonical(),capsule_ref:c.substrate.capsule_ref,result_sha:'a'.repeat(40),participant_ref:'worker',sequence:1,outcome:'SUCCEEDED',exit_code:0,stdout_summary:'checked',stderr_summary:'',artifacts:[{artifact_ref:'artifact:one',sha256:createHash('sha256').update('artifact').digest('hex')}],validation_evidence_refs:['verify:one'],explicit_result:'verified artifact',assumptions:[],evidence_refs:['verify:one'],uncertainty:['controlled conformance'],unresolved_questions:[],proposed_next_action:'series review'});
test('DGX002 real PCF thin extension rejects another canonical task before compilation',()=>{
 const d=draft();assert.throws(()=>compileTaskCapsule(d.graph.nodes[0],d.snapshot,pcf,{...canonical(),task_ref:'task:other'}),/TASK_CAPSULE_CANONICAL_MISMATCH/);
});
test('DGX990 real substrate result binds trusted execution identity and survives restart with joint reviewer',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgx-substrate-'));try{
  const d=draft(),capsule=compileTaskCapsule(d.graph.nodes[0],d.snapshot,pcf,canonical());
  const ports={pcf,verifyParticipantReceipt:r=>r.participant_ref==='worker',readExecutionRefs:()=>canonical()};
  let service=createGovernanceService({dir,ports});service.create(d);
  const action={action:'RESULT',expected_revision:1,node_ref:'n1',canonical_refs:{...canonical(),execution_device_ref:'forged'},receipt:result(capsule)};
  const c=service.act('case-1',action);assert.equal(c.results.length,1);assert.equal(c.results[0].explicit_result,'verified artifact');
  assert.ok(c.participants.some(p=>p.participant_ref==='worker'));assert.ok(c.validation.some(v=>v.node_ref==='n1'));assert.ok(c.technical_evidence.some(v=>v.capsule_ref===capsule.substrate.capsule_ref));
  service=createGovernanceService({dir,ports});assert.equal(service.inspect('case-1').results.length,1);
  assert.throws(()=>service.act('case-1',{...action,expected_revision:c.revision}),/NODE_RESULT_IMMUTABLE/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('DGX990 cross-candidate substrate receipt cannot enter the case or remove uncertainty',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgx-cross-result-'));try{
  const d=draft(),c=compileTaskCapsule(d.graph.nodes[0],d.snapshot,pcf,canonical()),service=createGovernanceService({dir,ports:{pcf,verifyParticipantReceipt:()=>true,readExecutionRefs:()=>({...canonical(),candidate_sha:'c'.repeat(40)})}});service.create(d);
  assert.throws(()=>service.act('case-1',{action:'RESULT',expected_revision:1,node_ref:'n1',canonical_refs:canonical(),receipt:result(c)}));assert.equal(service.inspect('case-1').revision,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
