import test from 'node:test';
import assert from 'node:assert/strict';
import {projectProcessCapsule} from '../contracts/deliberative-governance-v2/projection.mjs';
const input=()=>({case_ref:'case-1',candidate_sha:'a'.repeat(40),snapshot:{request_ref:'request:1',accepted_requirements:['bounded scope'],known_unknowns:['not deployed']},graph:{nodes:[{node_id:'n1',question_or_verification:'verify',canonical_task_ref:'task:1',status_projection:'COMPLETE'}]},participants:[{participant_ref:'p1',role:'EXECUTOR'}],assignments:[{selected_participant:'p1',role:'EXECUTOR',score_components:null,required_independence_profile:{host_independence:true},facts_ref:'fabric:1'}],results:[{node_ref:'n1',explicit_result:'verified',evidence_refs:['evidence:1'],uncertainty:['local-only']}],conflicts:[],adjudications:[],validation:[{evidence_ref:'test:1',state:'PASS'}],release:{state:'NOT_RUN',blocks:[]},dissent:[],technical_evidence:[{ref:'evidence:1',sha:'a'.repeat(40),artifact_ref:'artifact:1'}]});
test('DGX007 L0 retains uncertainty and release gate; L2 preserves exact evidence',()=>{
 const r=projectProcessCapsule(input(),{readTask:()=>({state:'COMPLETED'})});assert.equal(r.L0.release_gate.state,'NOT_RUN');assert.ok(r.L0.residual_uncertainty.includes('local-only'));assert.equal(r.L2.technical_evidence[0].sha,'a'.repeat(40));assert.equal(r.authoritative,false);
});
test('DGX007 canonical status wins and graph drift warning bubbles into L0',()=>{
 const r=projectProcessCapsule(input(),{readTask:()=>({state:'FAILED'})});assert.equal(r.L0.active_risk,true);assert.match(r.L0.warnings.join(','),/RECONCILIATION/);assert.equal(r.L1.problem_graph[0].canonical_state,'FAILED');
 const unavailable=projectProcessCapsule(input(),{readTask:()=>{throw Error('down')}});assert.equal(unavailable.L0.active_risk,true);assert.match(unavailable.L0.warnings.join(','),/UNAVAILABLE/);
});
test('DGX007 material conflict and more-evidence adjudication remain visible with progressive disclosure',()=>{
 const r=projectProcessCapsule({...input(),conflicts:[{conflict_ref:'c1',severity:'MAJOR',resolved:false,statement:'two incompatible claims'}],adjudications:[{conflict_ref:'c1',final_verdict:'MORE_EVIDENCE_REQUIRED',pass_a_findings:{material_facts:['one']},defences:[{claim:'A'}]}]},{});
 assert.equal(r.L0.active_risk,true);assert.equal(r.L0.material_conflicts[0].conflict_ref,'c1');assert.equal(r.L1.adjudications[0].defences.length,1);assert.equal(JSON.stringify(r.L0).includes('defences'),false);
});
