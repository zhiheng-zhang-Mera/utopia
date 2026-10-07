import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdjudication} from '../contracts/deliberative-governance-v2/adjudication.mjs';
const context=()=>{const c=({case_ref:'case-1',conflict_ref:'conflict-1',type:'FACT',neutral_statement:'Two claims disagree on result',question:'Which result is supported?',snapshot:{request_ref:'request:1',accepted_requirements:['use evidence'],canonical_state_refs:['task:1'],evidence_refs:['evidence:1'],domain_constraints:[],known_unknowns:['result'],snapshot_version:1},canonical_evidence_refs:['evidence:1'],parties:['author-a','author-b'],origin:{participant_ref:'author-a',agent_ref:'a',session_ref:'sa'},adjudicator:{participant_ref:'judge',agent_ref:'judge-agent',session_ref:'fresh',authored_node_refs:[],conflict_of_interest:false},node_ref:'n1'});c.party_origins=[c.origin,{participant_ref:'author-b',agent_ref:'b',session_ref:'sb'}];return c;};
const findings=()=>({material_facts:['record observed'],missing_evidence:[],candidate_interpretations:['A','B'],provisional_objections:[],needs_more_evidence:[],evidence_refs:['evidence:1']});
const defence=party=>({participant_ref:party,claim:'supported result',supporting_evidence_refs:['evidence:1'],assumptions:[],critique_of_alternative:'incomplete',what_evidence_would_change_my_mind:'new artifact',confidence_if_available:null,disposition:'MAINTAIN'});
const result=()=>({new_information_from_defence:[],changed_findings:[],unchanged_findings:['record observed'],final_verdict:'MERGED',evidence_refs:['evidence:1']});
test('DGX005 Pass A never exposes defence and Pass B cannot run before A',()=>{
 const a=createAdjudication(context());assert.equal(a.passAInput().defences,undefined);assert.throws(()=>a.submitDefence(defence('author-a')));assert.throws(()=>a.finalize(result()));
 a.recordPassA(findings());a.submitDefence(defence('author-a'));a.submitDefence({...defence('author-b'),disposition:'PARTIAL_ACCEPT'});
 assert.equal(a.passBInput().defences.length,2);const r=a.finalize(result());assert.equal(r.final_verdict,'MERGED');assert.deepEqual(r.pass_a_findings,findings());assert.throws(()=>a.recordPassA(findings()));
});
test('DGX005 self adjudication, authored dispute and same context refused',()=>{
 for(const changes of [{participant_ref:'author-b'},{authored_node_refs:['n1']},{session_ref:'sa'},{conflict_of_interest:true}])assert.throws(()=>createAdjudication({...context(),adjudicator:{...context().adjudicator,...changes}}));
 assert.throws(()=>createAdjudication({...context(),type:'VOTE'}));
});
test('DGX005 both wrong and evidence required remain explicit; missing evidence never yields certainty',()=>{
 const a=createAdjudication(context());a.recordPassA({...findings(),needs_more_evidence:['missing artifact']});
 assert.throws(()=>a.finalize(result()));const r=a.finalize({...result(),final_verdict:'MORE_EVIDENCE_REQUIRED',evidence_refs:[]});assert.equal(r.final_verdict,'MORE_EVIDENCE_REQUIRED');
 const b=createAdjudication(context());b.recordPassA(findings());b.submitDefence(defence('author-a'));b.submitDefence(defence('author-b'));assert.equal(b.finalize({...result(),final_verdict:'BOTH_REJECTED'}).final_verdict,'BOTH_REJECTED');
});
test('DGX005 defence cannot impersonate a party or overwrite prior record and API copies are isolated',()=>{
 const a=createAdjudication(context());a.recordPassA(findings());assert.throws(()=>a.submitDefence(defence('outsider')));a.submitDefence(defence('author-a'));assert.throws(()=>a.submitDefence(defence('author-a')));
 const view=a.passBInput();view.defences[0].claim='tampered';assert.notEqual(a.passBInput().defences[0].claim,'tampered');
 assert.throws(()=>a.finalize({...result(),final_verdict:'A_ACCEPTED'}));
});
test('DGX005 submitted finals cannot overwrite canonical provenance and snapshot extras cannot leak defence',()=>{
 assert.throws(()=>createAdjudication({...context(),snapshot:{...context().snapshot,defences:['anchoring narrative']}}));
 const a=createAdjudication(context());a.recordPassA(findings());a.submitDefence(defence('author-a'));a.submitDefence(defence('author-b'));
 assert.throws(()=>a.finalize({...result(),case_ref:'other',adjudicator_ref:'author-a',pass_a_findings:{},defences:[]}));
 assert.equal(a.finalize(result()).case_ref,'case-1');
});
test('DGX005 judge must be independent of both disputing parties',()=>{
 const c=context();c.party_origins[1].session_ref=c.adjudicator.session_ref;assert.throws(()=>createAdjudication(c));
});
