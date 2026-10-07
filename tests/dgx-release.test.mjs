import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRelease,createAppealPolicy} from '../contracts/deliberative-governance-v2/release.mjs';
const sha='a'.repeat(40);
const input=()=>({case_ref:'case-1',candidate_sha:sha,participants:['p1','p2'],accepted_claim_refs:['claim:1'],accepted_evidence_refs:['evidence:1'],accepted_assumptions:[],unresolved_uncertainty:['bounded simulation'],integration_delta_refs:['delta:1'],required_domain_gates:['RESEARCH'],domain_receipt_refs:['domain:1'],independence_receipt_refs:['independence:1'],reviews:[{participant_ref:'p1',case_ref:'case-1',candidate_sha:sha,verdict:'APPROVE',review_scope:['claim:1'],checked_claim_refs:['claim:1'],checked_evidence_refs:['evidence:1'],objections:[],receipt_ref:'review:1'},{participant_ref:'p2',case_ref:'case-1',candidate_sha:sha,verdict:'APPROVE_WITH_MINOR_NOTES',review_scope:['claim:1'],checked_claim_refs:['claim:1'],checked_evidence_refs:['evidence:1'],objections:[],receipt_ref:'review:2'}],objections:[],dissent:[{participant_ref:'p2',statement:'prefer different method',evidence_refs:['evidence:1']}],owner_only:false,owner_authorization_ref:null,integration_claims_supported:true});
const verified={verifyReview:()=>true,readDomainReceipt:()=>({state:'PASS',domain:'RESEARCH',candidate_sha:sha}),readIndependenceReceipt:()=>({eligible:true,candidate_sha:sha}),verifyIntegration:()=>true};
test('DGX006 all participants review scoped exact candidate; minor dissent is retained',()=>{
 const r=evaluateRelease(input(),verified);assert.equal(r.state,'PASS');assert.equal(r.dissent.length,1);assert.deepEqual(r.residual_uncertainty,['bounded simulation']);
 for(const changes of [{reviews:[]},{participants:['p1','p2','p3']},{candidate_sha:'main'},{integration_claims_supported:false}])assert.notEqual(evaluateRelease({...input(),...changes},verified).state,'PASS');
});
test('DGX006 no votes can override critical major or blocking reviewer',()=>{
 for(const severity of ['CRITICAL','MAJOR'])assert.equal(evaluateRelease({...input(),objections:[{severity,resolved:false,statement:'unsafe'}]},verified).state,'BLOCKED');
 const r=input();r.reviews[1].verdict='BLOCK';assert.equal(evaluateRelease(r,verified).state,'BLOCKED');
 assert.equal(evaluateRelease({...input(),objections:[{severity:'UNKNOWN',resolved:false}]},verified).state,'BLOCKED');
});
test('DGX006 missing trusted receipts and stale/cross-case reviews fail closed',()=>{
 assert.equal(evaluateRelease(input()).state,'BLOCKED');
 for(const port of [{...verified,readDomainReceipt:()=>null},{...verified,readIndependenceReceipt:()=>({eligible:false})},{...verified,verifyReview:()=>false},{...verified,verifyIntegration:()=>false}])assert.equal(evaluateRelease(input(),port).state,'BLOCKED');
 const r=input();r.reviews[1].candidate_sha='b'.repeat(40);assert.equal(evaluateRelease(r,verified).state,'BLOCKED');r.reviews[1].candidate_sha=sha;r.reviews[1].case_ref='other';assert.equal(evaluateRelease(r,verified).state,'BLOCKED');
});
test('DGX006 Owner-only boundary needs independently resolved authorization',()=>{
 const r={...input(),owner_only:true,owner_authorization_ref:'owner:1'};
 assert.equal(evaluateRelease(r,verified).state,'OWNER_REQUIRED');assert.equal(evaluateRelease(r,{...verified,verifyOwnerAuthorization:()=>true}).state,'PASS');
});
test('DGX006 bounded appeal requires new evidence or specific procedural/factual error',()=>{
 const a=createAppealPolicy({max_appeals:2});assert.throws(()=>a.submit({case_ref:'case-1',reason:'disagree',new_evidence_refs:[],procedure_violation:null,factual_error:null}));
 const appeal={case_ref:'case-1',reason:'new evidence',new_evidence_refs:['evidence:two'],procedure_violation:null,factual_error:null};
 assert.equal(a.submit(appeal).state,'REOPEN_INTEGRATION');assert.throws(()=>a.submit(appeal));assert.equal(a.submit({...appeal,new_evidence_refs:[],procedure_violation:'review skipped'}).state,'REOPEN_INTEGRATION');assert.equal(a.submit({...appeal,new_evidence_refs:['evidence:three']}).state,'OWNER_REQUIRED');
});
