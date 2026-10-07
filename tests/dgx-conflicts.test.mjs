import test from 'node:test';
import assert from 'node:assert/strict';
import {validateClaim,detectConflicts} from '../contracts/deliberative-governance-v2/claims.mjs';
const claim=(id,value)=>({claim_ref:id,participant_ref:id,node_ref:'n1',subject_ref:'artifact:1',predicate_ref:'validation:passed',assertion_value:value,evidence_refs:['evidence:'+id],assumptions:[],uncertainty:[],type:'FACT',severity:'MAJOR'});
test('DGX005 structured contradictory claims are retained and produce deterministic material conflict',()=>{
 const inputs=[claim('a',true),claim('b',false)];const before=structuredClone(inputs),conflicts=detectConflicts(inputs);
 assert.equal(conflicts.length,1);assert.equal(conflicts[0].severity,'MAJOR');assert.equal(conflicts[0].resolved,false);assert.deepEqual(conflicts[0].claim_refs,['a','b']);assert.deepEqual(inputs,before);assert.deepEqual(detectConflicts([...inputs].reverse()),conflicts);
});
test('DGX005 agreement or different predicate is not manufactured into a dispute',()=>{
 assert.equal(detectConflicts([claim('a',true),claim('b',true)]).length,0);
 assert.equal(detectConflicts([claim('a',true),{...claim('b',false),predicate_ref:'another:predicate'}]).length,0);
 assert.throws(()=>validateClaim({...claim('a',true),evidence_refs:null}));assert.throws(()=>detectConflicts([claim('a',true),claim('a',false)]));
});
