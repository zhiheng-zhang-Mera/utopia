import test from 'node:test';
import assert from 'node:assert/strict';
import {createSnapshot, validateGraph, extendGraph, compileTaskCapsule, validateGovernanceResult, CONSTITUTION} from '../contracts/deliberative-governance-v2/core.mjs';
export const snapshotInput=()=>({request_ref:'owner/request/1',accepted_requirements:['preserve intent'],canonical_state_refs:['task:one'],evidence_refs:['evidence:one'],domain_constraints:['owner-only release'],known_unknowns:['PCF acceptance unavailable'],snapshot_version:1});
export const nodeInput=(id='n1')=>({node_id:id,question_or_verification:'check evidence',dependencies:[],required_capabilities:['review'],independence_floor:{agent_or_session_independence:true},input_refs:['evidence:one'],expected_output_contract:'explicit evidence result',stop_condition:'missing evidence => stop',status_projection:'NOT_OBSERVED',canonical_task_ref:'task:one'});
export const graphInput=()=>({graph_id:'graph-1',snapshot_ref:'snapshot-1',request_ref:'owner/request/1',accepted_requirements:['preserve intent'],nodes:[nodeInput()],provenance:[{revision:1,reason:'Owner accepted decomposition',evidence_refs:['evidence:one']}]});
test('DGX002 immutable shared snapshot retains unknowns and requires versioned facts',()=>{
 const s=createSnapshot(snapshotInput());assert.equal(s.schema_version,2);assert.ok(Object.isFrozen(s.known_unknowns));assert.throws(()=>s.known_unknowns.push('x'));
 assert.throws(()=>createSnapshot({...snapshotInput(),snapshot_version:0}));assert.throws(()=>createSnapshot({...snapshotInput(),request_ref:''}));
 assert.ok(CONSTITUTION.includes('evidence > vote'));
});
test('DGX002 DAG preserves Owner scope and rejects cycles, orphan edges and authority',()=>{
 assert.equal(validateGraph(graphInput(),createSnapshot(snapshotInput())).nodes.length,1);
 for(const nodes of [[{...nodeInput(),dependencies:['n1']}],[{...nodeInput(),dependencies:['missing']}],[nodeInput(),nodeInput()]])assert.throws(()=>validateGraph({...graphInput(),nodes},createSnapshot(snapshotInput())));
 assert.throws(()=>validateGraph({...graphInput(),accepted_requirements:[]},createSnapshot(snapshotInput())));
 assert.throws(()=>validateGraph({...graphInput(),canonical_task_state:'COMPLETE'},createSnapshot(snapshotInput())));
});
test('DGX002 controlled DAG growth cannot rewrite prior nodes or erase provenance',()=>{
 const s=createSnapshot(snapshotInput()),g=validateGraph(graphInput(),s);
 const next=extendGraph(g,{nodes:[{...nodeInput('n2'),dependencies:['n1']}],reason:'new evidence',evidence_refs:['evidence:two']},s);
 assert.equal(next.provenance.length,2);assert.equal(g.nodes.length,1);assert.throws(()=>extendGraph(g,{nodes:[nodeInput()],reason:'overwrite',evidence_refs:['evidence:two']},s));
});
test('DGX002 private reasoning and credentials rejected recursively with normalized keys',()=>{
 for(const key of ['chainOfThought','hidden_reasoning','apiToken','__proto__']){
  const input=snapshotInput();input.extra=JSON.parse(`{"${key}":"secret"}`);assert.throws(()=>createSnapshot(input));
 }
 assert.throws(()=>createSnapshot({...snapshotInput(),known_unknowns:['a'.repeat(5000)]}));
});
test('DGX002 PCF remains the substrate owner and unavailable port is typed',()=>{
 const s=createSnapshot(snapshotInput()),g=validateGraph(graphInput(),s);
 assert.throws(()=>compileTaskCapsule(g.nodes[0],s,null),/PCF_726_UNAVAILABLE/);
 const port={compileExecutionCapsule:()=>({capsule_ref:'pcf:1'}),validateResultEnvelope:()=>({valid:true})};
 const capsule=compileTaskCapsule(g.nodes[0],s,port,{task_ref:'task:one'});
 const receipt={explicit_result:'verified',assumptions:[],evidence_refs:['evidence:one'],uncertainty:['limited scope'],unresolved_questions:[],proposed_next_action:'independent review'};
 assert.equal(validateGovernanceResult(capsule,receipt,port).explicit_result,'verified');
 assert.throws(()=>validateGovernanceResult(capsule,{...receipt,chain_of_thought:'private'},port));
 assert.throws(()=>validateGovernanceResult(capsule,receipt,{validateResultEnvelope:()=>({valid:false})}));
});
