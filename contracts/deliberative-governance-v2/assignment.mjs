import {safe,requireThat,ref,list,freeze} from './core.mjs';
import {DOMAIN_PROFILES} from './profiles.mjs';
export const INDEPENDENCE_DIMENSIONS=Object.freeze(['role_authorship_independence','agent_or_session_independence','model_family_independence','host_independence','environment_independence','hardware_or_toolchain_independence','conflict_of_interest_recusal']);
const differ=(a,b)=>ref(a)&&ref(b)&&a!==b;
export function checkIndependence(candidate,origin,profile,nodeRef){
 safe({candidate,origin,profile});
 requireThat(profile&&Object.entries(profile).every(([k,v])=>INDEPENDENCE_DIMENSIONS.includes(k)&&typeof v==='boolean'),'INVALID_INDEPENDENCE_PROFILE');
 const observed={
  role_authorship_independence:differ(candidate.participant_ref,origin.participant_ref)&&list(candidate.authored_node_refs,ref)&&!candidate.authored_node_refs.includes(nodeRef),
  agent_or_session_independence:differ(candidate.agent_ref,origin.agent_ref)&&differ(candidate.session_ref,origin.session_ref),
  model_family_independence:differ(candidate.model_family_ref,origin.model_family_ref),
  host_independence:differ(candidate.physical_host_ref,origin.physical_host_ref),
  environment_independence:differ(candidate.environment_ref,origin.environment_ref),
  hardware_or_toolchain_independence:differ(candidate.toolchain_ref,origin.toolchain_ref),
  conflict_of_interest_recusal:candidate.conflict_of_interest===false
 };
 const missing=Object.keys(profile).filter(k=>profile[k]&&!observed[k]);return freeze({eligible:missing.length===0,observed,missing});
}
const SCORE_KEYS=['domain_fit','completion_rate','uphold_rate','evidence_quality','readiness','recent_failure_penalty'];
export function assignParticipant(input,candidateInputs,{scoringAvailable=true}={}){
 const r=safe(input),candidates=safe(candidateInputs);
 requireThat(ref(r.task_ref)&&ref(r.problem_node_ref)&&ref(r.role)&&ref(r.domain)&&list(r.required_capabilities,ref)&&r.origin,'ASSIGNMENT_CONTEXT_REQUIRED');
 requireThat(Array.isArray(candidates)&&candidates.length<=64,'CANDIDATE_LIMIT');
 const ids=new Set();for(const c of candidates){requireThat(ref(c.participant_ref)&&!ids.has(c.participant_ref),'DUPLICATE_PARTICIPANT');ids.add(c.participant_ref);}
 const floor={...r.independence_floor};
 // This is the existing domain floor, not DGX's future Review Independence v2.
 //
 // The ENGINEERING floor is a property of the DOMAIN, and it used to be selected by the literal `role==='DOMAIN_REVIEW'`
 // while the profile's own `required_reviewer_roles` was read by nobody. `governance.mjs` passes `role` straight through
 // from HTTP JSON, so an acceptance probe showed the same ENGINEERING review task selecting a SAME-HOST reviewer once the
 // caller spelled the role `REVIEW`: the floor came out `{}` and `host_independence` was never checked. A floor that can
 // be dropped by relabelling the task is not a floor. Every role in an ENGINEERING case that the profile does not declare
 // as an EXECUTOR role is now held to the profile's own floor, so the vocabulary lives in one place and cannot be
 // sidestepped by spelling.
 const domainProfile=DOMAIN_PROFILES[r.domain];
 if(r.domain==='ENGINEERING'&&!(domainProfile?.required_executor_roles??[]).includes(r.role))Object.assign(floor,domainProfile.independence_floor);
 if(r.role==='GOVERNANCE_ADJUDICATOR')Object.assign(floor,{role_authorship_independence:true,agent_or_session_independence:true,conflict_of_interest_recusal:true});
 // Validate vocabulary even when no candidates are available.
 requireThat(Object.entries(floor).every(([k,v])=>INDEPENDENCE_DIMENSIONS.includes(k)&&typeof v==='boolean'),'INVALID_INDEPENDENCE_PROFILE');
 const rejected=[],eligible=[];
 for(const c of candidates){
  const independence=checkIndependence(c,r.origin,floor,r.problem_node_ref);
  const reason=!ref(c.facts_ref)?'CANONICAL_FACTS_UNAVAILABLE':c.ready!==true?'RESOURCE_UNAVAILABLE':!list(c.roles,ref)||!c.roles.includes(r.role)?'ROLE_UNAVAILABLE':!list(c.capabilities,ref)||!r.required_capabilities.every(k=>c.capabilities.includes(k))?'CAPABILITY_UNAVAILABLE':!independence.eligible?'INDEPENDENCE:'+independence.missing.join(','):null;
  if(reason){rejected.push({participant_ref:c.participant_ref,reason});continue;}
  const facts=c.score_facts;
  const scored=scoringAvailable&&facts&&SCORE_KEYS.every(k=>typeof facts[k]==='number'&&Number.isFinite(facts[k])&&facts[k]>=0&&facts[k]<=1);
  eligible.push({candidate:c,independence,components:scored?Object.fromEntries(SCORE_KEYS.map(k=>[k,facts[k]])):null,score:scored?facts.domain_fit+facts.completion_rate+facts.uphold_rate+facts.evidence_quality+facts.readiness-facts.recent_failure_penalty:null});
 }
 // If any eligible candidate lacks scoring facts, avoid an unfair partial ranking.
 const allScored=eligible.length>0&&eligible.every(x=>x.score!==null);
 eligible.sort((a,b)=>(allScored?b.score-a.score:0)||a.candidate.participant_ref.localeCompare(b.candidate.participant_ref));
 const selected=eligible[0];
 return freeze({schema_version:2,task_ref:r.task_ref,problem_node_ref:r.problem_node_ref,candidate_set:[...ids],selected_participant:selected?.candidate.participant_ref??null,role:r.role,score_components:selected?.components??null,required_independence_profile:floor,observed_independence_facts:selected?.independence.observed??null,facts_ref:selected?.candidate.facts_ref??null,rejected_or_unavailable_reason:rejected,fallback_or_escalation:!selected?'OWNER_REQUIRED':allScored?'NONE':'ELIGIBILITY_ONLY',authority:'ASSIGNMENT_RECOMMENDATION_ONLY'});
}
