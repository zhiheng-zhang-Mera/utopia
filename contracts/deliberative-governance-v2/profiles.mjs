import {safe,requireThat,ref,list,freeze} from './core.mjs';
const common={task_decomposition_rules:'preserve accepted requirements',problem_node_types:['QUESTION','VERIFICATION','INTEGRATION'],required_executor_roles:['EXECUTOR'],required_reviewer_roles:['DOMAIN_REVIEW'],evidence_rules:'reference canonical evidence; do not manufacture professional conclusions',validation_hooks:'typed domain gate',conflict_types:['FACT','METHOD','INTERPRETATION','EXECUTION','REQUIREMENT'],adjudication_inputs:['accepted requirements','snapshot','canonical evidence'],criticality_policy:'critical/major unresolved blocks release'};
export const DOMAIN_PROFILES=freeze({
 ENGINEERING:{...common,domain:'ENGINEERING',canonical_owner:'Engineering Foreman',independence_floor:{host_independence:true,role_authorship_independence:true,agent_or_session_independence:true,conflict_of_interest_recusal:true},release_requirements:['exact candidate SHA','CI success','fresh verifier','opposite-host Formal Review']},
 RESEARCH:{...common,domain:'RESEARCH',canonical_owner:'Research Review',independence_floor:{role_authorship_independence:true},release_requirements:['method','evidence','claim','reproducibility','domain review']},
 HEALTH:{...common,domain:'HEALTH',canonical_owner:'Health professional seam',independence_floor:{role_authorship_independence:true,conflict_of_interest_recusal:true},release_requirements:['professional evidence and safety review'],capability_state:'CAPABILITY_UNAVAILABLE',clinical_truth:false}
});
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
export function validateDomainGate(domain,input){
 requireThat(Object.hasOwn(DOMAIN_PROFILES,domain),'UNKNOWN_DOMAIN');
 const r=safe(input),failures=[];
 if(domain==='HEALTH')return freeze({schema_version:2,domain,state:'CAPABILITY_UNAVAILABLE',failures:['CLINICAL_SIMULATOR_NOT_OBSERVED'],professional_truth:false});
 if(!r)return freeze({schema_version:2,domain,state:'NOT_RUN',failures:['DOMAIN_RECEIPT_MISSING']});
 const check=(ok,code)=>{if(!ok)failures.push(code);};
 check(r.domain===domain,'DOMAIN_MISMATCH');check(sha(r.candidate_sha),'EXACT_SHA_REQUIRED');check(list(r.evidence_refs,ref)&&r.evidence_refs.length>0,'DOMAIN_EVIDENCE_REQUIRED');
 const receipt=(x,label)=>{check(x?.head_sha===r.candidate_sha&&sha(x?.head_sha),label+'_HEAD_MISMATCH');check(x?.verdict==='PASS',label+'_NOT_PASS');check(list(x?.evidence_refs,ref)&&x.evidence_refs.length>0,label+'_EVIDENCE_MISSING');};
 if(domain==='ENGINEERING'){
  check(ref(r.executor_host_ref)&&ref(r.reviewer_host_ref)&&r.executor_host_ref!==r.reviewer_host_ref,'OPPOSITE_PHYSICAL_HOST_REQUIRED');
  check(ref(r.executor_ref)&&ref(r.reviewer_ref)&&r.executor_ref!==r.reviewer_ref&&ref(r.reviewer_session_ref),'INDEPENDENT_REVIEWER_REQUIRED');
  check(r.review_sha===r.candidate_sha,'REVIEW_HEAD_MISMATCH');
  check(r.ci?.head_sha===r.candidate_sha&&sha(r.ci?.head_sha)&&r.ci?.conclusion==='success'&&ref(r.ci?.run_ref),'CI_NOT_PASS_AT_HEAD');
  receipt(r.verifier,'VERIFIER');receipt(r.formal_review,'FORMAL_REVIEW');
 }else{
  check(ref(r.method_ref),'METHOD_REQUIRED');check(list(r.claim_refs,ref)&&r.claim_refs.length>0,'CLAIMS_REQUIRED');check(ref(r.reproducibility_ref),'REPRODUCIBILITY_REQUIRED');receipt(r.domain_review,'DOMAIN_REVIEW');
 }
 return freeze({schema_version:2,domain,candidate_sha:r.candidate_sha??null,state:failures.length?'BLOCKED':'PASS',failures,evidence_refs:r.evidence_refs??[]});
}
