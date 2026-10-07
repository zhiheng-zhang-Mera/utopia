import test from 'node:test';
import assert from 'node:assert/strict';
import {DOMAIN_PROFILES,validateDomainGate} from '../contracts/deliberative-governance-v2/profiles.mjs';
const sha='c'.repeat(40);
const engineering=()=>({domain:'ENGINEERING',candidate_sha:sha,executor_host_ref:'Alien',executor_ref:'author',reviewer_host_ref:'Mech',reviewer_ref:'reviewer',reviewer_session_ref:'fresh-session',review_sha:sha,ci:{head_sha:sha,conclusion:'success',run_ref:'ci:1'},verifier:{head_sha:sha,verdict:'PASS',evidence_refs:['test:1']},formal_review:{head_sha:sha,verdict:'PASS',evidence_refs:['review:1']},evidence_refs:['test:1','review:1']});
test('DGX004 Engineering adapter preserves exact head CI verifier and opposite-host floor',()=>{
 assert.equal(validateDomainGate('ENGINEERING',engineering()).state,'PASS');
 for(const changes of [{reviewer_host_ref:'Alien'},{review_sha:'main'},{candidate_sha:null},{formal_review:{head_sha:sha,verdict:'NOT_RUN',evidence_refs:[]}},{ci:{head_sha:'d'.repeat(40),conclusion:'success',run_ref:'ci:1'}},{reviewer_ref:'author'}])assert.notEqual(validateDomainGate('ENGINEERING',{...engineering(),...changes}).state,'PASS');
 assert.equal(DOMAIN_PROFILES.ENGINEERING.independence_floor.host_independence,true);
});
test('DGX004 Research evidence gate delegates professional review and rejects missing methods',()=>{
 const r={domain:'RESEARCH',candidate_sha:sha,method_ref:'method:1',claim_refs:['claim:1'],evidence_refs:['evidence:1'],reproducibility_ref:'replay:1',domain_review:{head_sha:sha,verdict:'PASS',evidence_refs:['review:1']}};
 assert.equal(validateDomainGate('RESEARCH',r).state,'PASS');assert.notEqual(validateDomainGate('RESEARCH',{...r,method_ref:null}).state,'PASS');
});
test('DGX004 Health professional seam never claims unimplemented clinical capability',()=>{
 assert.equal(validateDomainGate('HEALTH',{clinical_simulator_available:true,verdict:'PASS'}).state,'CAPABILITY_UNAVAILABLE');
 assert.equal(validateDomainGate('HEALTH',null).state,'CAPABILITY_UNAVAILABLE');assert.throws(()=>validateDomainGate('UNKNOWN',{}));
});
