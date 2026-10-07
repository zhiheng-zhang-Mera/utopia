import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGovernanceService} from '../services/dev-gateway/governance.mjs';
import {draft} from './fixtures/dgx-case.mjs';
test('DGX007 governance case survives restart; immutable identity and bounded revisions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgx-service-'));try{
  let s=createGovernanceService({dir,readTask:()=>({state:'RUNNING'})});const r=s.create(draft());assert.equal(r.revision,1);assert.equal(r.process_capsule.L0.release_gate.state,'NOT_RUN');assert.throws(()=>s.create(draft()));
  s=createGovernanceService({dir,readTask:()=>({state:'RUNNING'})});assert.equal(s.inspect('case-1').revision,1);assert.equal(s.list().cases.length,1);
  assert.throws(()=>s.act('case-1',{action:'EXTEND_GRAPH',expected_revision:0,nodes:[],reason:'x',evidence_refs:['e:1']}));
  const r2=s.act('case-1',{action:'EXTEND_GRAPH',expected_revision:1,nodes:[],reason:'new evidence noted',evidence_refs:['e:1']});assert.equal(r2.revision,2);
  assert.throws(()=>s.act('case-1',{action:'SET_TASK_STATE',expected_revision:2}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('DGX007 missing upstream ports cannot fabricate assignments results or release',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgx-ports-'));try{
  const s=createGovernanceService({dir});s.create(draft());
  assert.throws(()=>s.act('case-1',{action:'ASSIGN',expected_revision:1,request:{}}),/CAPABILITY_FACTS_UNAVAILABLE/);
  assert.throws(()=>s.act('case-1',{action:'RESULT',expected_revision:1}),/PCF_726_UNAVAILABLE/);
  assert.throws(()=>s.act('case-1',{action:'FINAL_REVIEW',expected_revision:1}),/PARTICIPANT_RECEIPT_UNAVAILABLE/);
  const r=s.act('case-1',{action:'EVALUATE_RELEASE',expected_revision:1,input:{state:'PASS'}});assert.equal(r.process_capsule.L0.release_gate.state,'BLOCKED');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('DGX007 corrupt/unavailable governance storage is observable and isolated',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgx-bad-'));try{
  writeFileSync(join(dir,'case-1.json'),'malformed');const s=createGovernanceService({dir});assert.equal(s.list().health,'DEGRADED');assert.throws(()=>s.inspect('case-1'));
  writeFileSync(join(dir,'file'),'cannot be a directory');const broken=createGovernanceService({dir:join(dir,'file','governance')});assert.equal(broken.list().health,'UNAVAILABLE');assert.throws(()=>broken.create(draft()));
  assert.throws(()=>s.inspect('../escape'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('DGX990 two-pass case information boundary survives restart before defence is admitted',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgx-phases-'));try{
  const ports={verifyParticipantReceipt:()=>true,readParticipantFacts:id=>({participant_ref:id,agent_ref:'agent-'+id,session_ref:'session-'+id,authored_node_refs:id==='judge'?[]:['n1'],conflict_of_interest:false}),readConflictParties:()=>['a','b']};let s=createGovernanceService({dir,ports});s.create(draft());
  let c=s.act('case-1',{action:'CONFLICT',expected_revision:1,conflict:{conflict_ref:'conflict-1',node_ref:'n1',type:'FACT',severity:'MAJOR',statement:'results disagree',resolved:false}});
  const context={case_ref:'case-1',conflict_ref:'conflict-1',node_ref:'n1',type:'FACT',neutral_statement:'results disagree',question:'which result is supported?',canonical_evidence_refs:['evidence:one'],parties:['a','b'],origin:{participant_ref:'a',agent_ref:'agent-a',session_ref:'session-a'},adjudicator:{participant_ref:'judge',agent_ref:'agent-j',session_ref:'session-j',authored_node_refs:[],conflict_of_interest:false}};
  c=s.act('case-1',{action:'START_ADJUDICATION',expected_revision:c.revision,context,receipt:{participant_ref:'judge'}});
  assert.throws(()=>s.act('case-1',{action:'DEFENCE',expected_revision:c.revision,conflict_ref:'conflict-1',receipt:{participant_ref:'a'}}),/PASS_A/);
  c=s.act('case-1',{action:'PASS_A',expected_revision:c.revision,conflict_ref:'conflict-1',receipt:{participant_ref:'judge',findings:{material_facts:['one artifact'],missing_evidence:[],candidate_interpretations:['A','B'],provisional_objections:[],needs_more_evidence:[],evidence_refs:['evidence:one']}}});
  s=createGovernanceService({dir,ports});assert.equal(s.inspect('case-1').adjudication_sessions[0].pass_a_findings.material_facts[0],'one artifact');
  for(const party of ['a','b'])c=s.act('case-1',{action:'DEFENCE',expected_revision:c.revision,conflict_ref:'conflict-1',receipt:{participant_ref:party,claim:'supported',supporting_evidence_refs:['evidence:one'],assumptions:[],critique_of_alternative:'incomplete',what_evidence_would_change_my_mind:'new evidence',confidence_if_available:null,disposition:'MAINTAIN'}});
  c=s.act('case-1',{action:'PASS_B',expected_revision:c.revision,conflict_ref:'conflict-1',receipt:{participant_ref:'judge',new_information_from_defence:[],changed_findings:[],unchanged_findings:['one artifact'],final_verdict:'BOTH_REJECTED',evidence_refs:['evidence:one']}});
  assert.equal(c.adjudications[0].final_verdict,'BOTH_REJECTED');assert.equal(c.process_capsule.L0.release_gate.state,'NOT_RUN');
  assert.deepEqual(c.participants.map(x=>x.participant_ref).sort(),['a','b','judge']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('DGX003 service rejects forged author host and adjudicator session in otherwise valid receipts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgx-origin-'));try{
  const facts=id=>({participant_ref:id,agent_ref:'agent-'+id,session_ref:'session-'+id,physical_host_ref:'Alien',authored_node_refs:id==='author'?['n1']:[],conflict_of_interest:false,roles:['DOMAIN_REVIEW'],capabilities:['review'],ready:true,facts_ref:'fabric:'+id});
  const s=createGovernanceService({dir,ports:{readCandidates:()=>[facts('reviewer')],readParticipantFacts:facts,readTaskAuthorship:()=>['author']}});s.create(draft());
  const c=s.act('case-1',{action:'ASSIGN',expected_revision:1,request:{task_ref:'task:one',problem_node_ref:'n1',role:'DOMAIN_REVIEW',origin:{participant_ref:'author',agent_ref:'agent-author',session_ref:'session-author',physical_host_ref:'fictional'}}});
  assert.equal(c.assignments[0].selected_participant,null);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('DGX007 persisted encoding respects the same byte bound as the reader',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgx-size-'));try{
  const s=createGovernanceService({dir}),d=draft();d.graph.extra=Array.from({length:64},()=>Array.from({length:61},()=>[0]));
  const c=s.create(d);assert.equal(c.case_ref,'case-1');assert.ok(statSync(join(dir,'case-1.json')).size<=131072);assert.equal(s.list().health,'READY');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('DGX006 pending appeal cannot be erased by recalculating the same release',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgx-appeal-'));try{
  const s=createGovernanceService({dir});s.create(draft());const c=s.act('case-1',{action:'APPEAL',expected_revision:1,appeal:{reason:'procedure violation',new_evidence_refs:[],procedure_violation:'review skipped',factual_error:null}});
  const next=s.act('case-1',{action:'EVALUATE_RELEASE',expected_revision:c.revision,input:{}});assert.ok(next.release.blocks.includes('APPEAL_PENDING'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('DGX005 accepted contributor claims discover conflict and force revalidation without deleting evidence',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgx-claims-'));try{
  const s=createGovernanceService({dir,ports:{verifyParticipantReceipt:()=>true}});s.create(draft());let revision=1,c;
  for(const [id,value] of [['a',true],['b',false]]){
   c=s.act('case-1',{action:'CLAIM',expected_revision:revision,receipt:{case_ref:'case-1',candidate_sha:'a'.repeat(40),claim_ref:'claim-'+id,participant_ref:id,node_ref:'n1',subject_ref:'artifact:one',predicate_ref:'validation:passed',assertion_value:value,evidence_refs:['evidence:'+id],assumptions:[],uncertainty:[],type:'FACT',severity:'MAJOR'}});revision=c.revision;
  }
  assert.equal(c.claims.length,2);assert.equal(c.conflicts.length,1);assert.equal(c.process_capsule.L0.active_risk,true);assert.equal(c.participants.length,2);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('DGX990 integrated candidate cannot lower the immutable Owner-only case boundary',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgx-owner-boundary-'));try{
  const sha='a'.repeat(40),ports={verifyParticipantReceipt:()=>true,readExecutionRefs:()=>({task_ref:'task:one',candidate_sha:sha}),pcf:{compileExecutionCapsule:()=>({capsule_ref:'pcf:1'}),validateResultEnvelope:()=>({valid:true})},release:{verifyReview:()=>true,readDomainReceipt:()=>({case_ref:'case-1',candidate_sha:sha,domain:'ENGINEERING',state:'PASS'}),readIndependenceReceipt:()=>({case_ref:'case-1',candidate_sha:sha,participant_refs:['p1'],eligible:true}),verifyIntegration:()=>true}};
  const s=createGovernanceService({dir,ports}),d={...draft(),owner_only:true};let c=s.create(d);
  c=s.act('case-1',{action:'CLAIM',expected_revision:c.revision,receipt:{case_ref:'case-1',candidate_sha:sha,claim_ref:'claim:1',participant_ref:'p1',node_ref:'n1',subject_ref:'artifact:one',predicate_ref:'validation:passed',assertion_value:true,evidence_refs:['evidence:one'],assumptions:[],uncertainty:[],type:'FACT',severity:'MAJOR'}});
  c=s.act('case-1',{action:'RESULT',expected_revision:c.revision,node_ref:'n1',canonical_refs:{task_ref:'task:one'},receipt:{case_ref:'case-1',node_ref:'n1',snapshot_version:1,participant_ref:'p1',explicit_result:'verified',assumptions:[],evidence_refs:['evidence:one'],uncertainty:[],unresolved_questions:[],proposed_next_action:'independent review'}});
  c=s.act('case-1',{action:'FINAL_REVIEW',expected_revision:c.revision,receipt:{case_ref:'case-1',candidate_sha:sha,content_revision:c.content_revision,participant_ref:'p1',verdict:'APPROVE',review_scope:['claim:1'],checked_claim_refs:['claim:1'],checked_evidence_refs:['evidence:one'],objections:[],receipt_ref:'review:1'}});
  const input={accepted_claim_refs:['claim:1'],accepted_evidence_refs:['evidence:one'],accepted_assumptions:[],integration_delta_refs:['delta:1'],domain_receipt_refs:['domain:1'],independence_receipt_refs:['independence:1'],owner_only:false,owner_authorization_ref:null,integration_claims_supported:true};
  c=s.act('case-1',{action:'EVALUATE_RELEASE',expected_revision:c.revision,input});assert.equal(c.release.state,'OWNER_REQUIRED');assert.equal(c.owner_only,true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
