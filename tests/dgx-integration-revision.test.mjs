import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createGovernanceService} from '../services/dev-gateway/governance.mjs';
import {draft} from './fixtures/dgx-case.mjs';
const claim=(id='claim:1')=>({case_ref:'case-1',candidate_sha:'a'.repeat(40),claim_ref:id,participant_ref:'p1',node_ref:'n1',subject_ref:'artifact:one',predicate_ref:'checked:'+id,assertion_value:true,evidence_refs:['evidence:one'],assumptions:['scope limited'],uncertainty:['claim uncertainty'],type:'FACT',severity:'MAJOR'});
const review=()=>({case_ref:'case-1',candidate_sha:'a'.repeat(40),participant_ref:'p1',verdict:'REQUEST_CHANGES',review_scope:['claim:1'],checked_claim_refs:['claim:1'],checked_evidence_refs:['evidence:one'],objections:[],receipt_ref:'review:1'});
const fixture=()=>{const dir=mkdtempSync(join(tmpdir(),'dgx-revision-')),s=createGovernanceService({dir,ports:{verifyParticipantReceipt:()=>true,pcf:{compileExecutionCapsule:()=>({capsule_ref:'pcf:1'}),validateResultEnvelope:()=>({valid:true})}}});let c=s.create(draft());return {dir,s,c};};
test('DGX result requires trusted refs and case/node/snapshot identity even for authenticated receipts',()=>{
 const {dir,s,c}=fixture();try{
  assert.throws(()=>s.act('case-1',{action:'RESULT',expected_revision:c.revision,node_ref:'n1',canonical_refs:{task_ref:'task:one'},receipt:{participant_ref:'p1',explicit_result:'ok',assumptions:[],evidence_refs:[],uncertainty:[],unresolved_questions:[],proposed_next_action:'review'}}),/CANONICAL_EXECUTION_REFS_UNAVAILABLE/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('DGX reviews are scoped to integration revision and archived after correction',()=>{
 const {dir,s}=fixture();try{
  let c=s.act('case-1',{action:'CLAIM',expected_revision:1,receipt:claim()});
  assert.throws(()=>s.act('case-1',{action:'FINAL_REVIEW',expected_revision:c.revision,receipt:review()}),/REVIEW_CONTENT_REVISION_REQUIRED/);
  c=s.act('case-1',{action:'FINAL_REVIEW',expected_revision:c.revision,receipt:{...review(),content_revision:c.content_revision}});
  c=s.act('case-1',{action:'EXTEND_GRAPH',expected_revision:c.revision,nodes:[],reason:'correction evidence',evidence_refs:['evidence:two']});
  assert.equal(c.reviews.length,0);assert.equal(c.review_history[0].verdict,'REQUEST_CHANGES');
  c=s.act('case-1',{action:'FINAL_REVIEW',expected_revision:c.revision,receipt:{...review(),verdict:'APPROVE',content_revision:c.content_revision,receipt_ref:'review:2'}});assert.equal(c.reviews[0].verdict,'APPROVE');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('DGX release cannot introduce claims evidence assumptions outside collected candidate',()=>{
 const {dir,s}=fixture();try{
  let c=s.act('case-1',{action:'CLAIM',expected_revision:1,receipt:claim()});
  for(const input of [{accepted_claim_refs:['forged']},{accepted_claim_refs:['claim:1'],accepted_evidence_refs:['forged']},{accepted_claim_refs:['claim:1'],accepted_evidence_refs:['evidence:one'],accepted_assumptions:['forged']}]){
   c=s.act('case-1',{action:'EVALUATE_RELEASE',expected_revision:c.revision,input});assert.ok(c.release.blocks.includes('ACCEPTED_REFERENCES_OUTSIDE_COLLECTED_CANDIDATE'));
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('DGX release preserves claim uncertainty and unresolved questions',()=>{
 const {dir,s}=fixture();try{
  let c=s.act('case-1',{action:'CLAIM',expected_revision:1,receipt:claim()});c=s.act('case-1',{action:'EVALUATE_RELEASE',expected_revision:c.revision,input:{}});assert.ok(c.release.residual_uncertainty.includes('claim uncertainty'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
