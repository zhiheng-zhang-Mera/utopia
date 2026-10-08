import test from 'node:test';
import assert from 'node:assert/strict';
import {assignParticipant,checkIndependence} from '../contracts/deliberative-governance-v2/assignment.mjs';
const origin={participant_ref:'author',agent_ref:'agent-a',session_ref:'session-a',physical_host_ref:'Alien',environment_ref:'env-a',model_family_ref:'family-a',toolchain_ref:'tool-a'};
const candidate=(id='reviewer')=>({participant_ref:id,agent_ref:'agent-b',session_ref:'session-b',physical_host_ref:'Mech',environment_ref:'env-b',model_family_ref:'family-b',toolchain_ref:'tool-b',roles:['DOMAIN_REVIEW'],authored_node_refs:[],conflict_of_interest:false,capabilities:['review'],ready:true,facts_ref:'fabric:'+id,score_facts:{domain_fit:1,completion_rate:0.9,uphold_rate:0.8,evidence_quality:1,readiness:1,recent_failure_penalty:0}});
const request=()=>({task_ref:'task:one',problem_node_ref:'n1',role:'DOMAIN_REVIEW',domain:'ENGINEERING',required_capabilities:['review'],independence_floor:{role_authorship_independence:true,agent_or_session_independence:true,conflict_of_interest_recusal:true},origin});
test('DGX003 score only ranks eligible candidates and opposite physical host is nonoptional',()=>{
 const same={...candidate('same'),physical_host_ref:'Alien'};const r=assignParticipant(request(),[same,candidate()]);
 assert.equal(r.selected_participant,'reviewer');assert.equal(r.required_independence_profile.host_independence,true);assert.match(r.rejected_or_unavailable_reason[0].reason,/host/);
});
test('DGX003 unavailable facts, recusal, author identity and unknown dimension fail closed',()=>{
 for(const changes of [{physical_host_ref:null},{participant_ref:'author'},{authored_node_refs:['n1']},{conflict_of_interest:true},{conflict_of_interest:null},{agent_ref:'agent-a'},{session_ref:'session-a'}]){
  const r=assignParticipant(request(),[{...candidate(),...changes}]);assert.equal(r.selected_participant,null);assert.equal(r.fallback_or_escalation,'OWNER_REQUIRED');
 }
 assert.throws(()=>checkIndependence(candidate(),origin,{imaginary_independence:true},'n1'));
});
test('DGX003 missing score service uses deterministic eligibility fallback, never removes floor',()=>{
 const candidates=[{...candidate('z'),score_facts:null},{...candidate('a'),score_facts:null}];
 const r=assignParticipant(request(),candidates,{scoringAvailable:false});assert.equal(r.selected_participant,'a');assert.equal(r.fallback_or_escalation,'ELIGIBILITY_ONLY');
 const before=structuredClone(candidates);assignParticipant(request(),candidates);assert.deepEqual(candidates,before);
});
test('DGX003 resource unavailable and no capability cannot win with reputation',()=>{
 for(const c of [{...candidate(),ready:false},{...candidate(),capabilities:[]},{...candidate(),facts_ref:null}])assert.equal(assignParticipant(request(),[c]).selected_participant,null);
 assert.throws(()=>assignParticipant(request(),[candidate(),candidate()]));
});
test('DGX990 scenario 13: the ENGINEERING review floor follows the DOMAIN, not the caller\'s spelling of the role',()=>{
 // Found while accepting the four-series integration pack. The floor was selected by the literal `role==='DOMAIN_REVIEW'`
 // while `DOMAIN_PROFILES.ENGINEERING.required_reviewer_roles` was read by nobody, and `governance.mjs` passes `role`
 // straight through from request JSON. A probe therefore reached a SAME-HOST reviewer by calling the same review task
 // `REVIEW`: floor `{}`, host_independence never checked. A floor that a relabelled request can drop is not a floor.
 const reviewer={...candidate('reviewer'),physical_host_ref:'Alien',roles:['DOMAIN_REVIEW','REVIEW','PEER_REVIEW']};
 for(const role of ['DOMAIN_REVIEW','REVIEW','PEER_REVIEW']){
  const r=assignParticipant({...request(),role},[reviewer]);
  assert.equal(r.required_independence_profile.host_independence,true,`role ${role} must carry the domain floor`);
  assert.equal(r.selected_participant,null,`role ${role} must not select the author's own host`);
  assert.match(r.rejected_or_unavailable_reason[0].reason,/host/);
 }
 // The executor role is the one role the ENGINEERING profile does NOT hold to the reviewer floor, so it still assigns.
 const executor={...candidate('executor'),physical_host_ref:'Alien',roles:['EXECUTOR']};
 const allowed=assignParticipant({...request(),role:'EXECUTOR'},[executor]);
 assert.equal(allowed.selected_participant,'executor');
 assert.equal(allowed.required_independence_profile.host_independence,undefined);
});
