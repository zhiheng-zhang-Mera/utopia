import {safe,requireThat,ref,text,list,freeze} from './core.mjs';
const SHA=/^[a-f0-9]{40}$/;
const VERDICTS=['APPROVE','APPROVE_WITH_MINOR_NOTES','REQUEST_CHANGES','BLOCK'];
const resolve=(fn,...args)=>{try{return typeof fn==='function'?fn(...args):null;}catch{return null;}};
// Receipt readers are trusted host ports. A JSON boolean from a participant is not a gate.
export function evaluateRelease(input,ports={}){
 const r=safe(input),blocks=[];
 const block=(ok,reason)=>{if(!ok)blocks.push(reason);};
 block(ref(r.case_ref)&&typeof r.candidate_sha==='string'&&SHA.test(r.candidate_sha),'EXACT_CANDIDATE_REQUIRED');
 block(list(r.participants,ref)&&r.participants.length>0&&new Set(r.participants).size===r.participants.length,'PARTICIPANTS_REQUIRED');
 for(const k of ['accepted_claim_refs','accepted_evidence_refs','accepted_assumptions','unresolved_uncertainty','integration_delta_refs','required_domain_gates','domain_receipt_refs','independence_receipt_refs'])block(list(r[k]),'INVALID_'+k.toUpperCase());
 block(Array.isArray(r.reviews)&&Array.isArray(r.objections)&&Array.isArray(r.dissent),'REVIEW_OBJECTION_DISSENT_REQUIRED');
 if(blocks.length)return freeze({schema_version:2,case_ref:r.case_ref??null,candidate_sha:r.candidate_sha??null,state:'BLOCKED',blocks,dissent:r.dissent??[],residual_uncertainty:r.unresolved_uncertainty??[]});
 block(r.accepted_claim_refs.length>0&&r.accepted_evidence_refs.length>0,'ACCEPTED_CLAIMS_EVIDENCE_REQUIRED');
 const reviews=new Map();
 for(const review of r.reviews){
  block(r.participants.includes(review.participant_ref)&&!reviews.has(review.participant_ref),'UNEXPECTED_OR_DUPLICATE_REVIEWER');reviews.set(review.participant_ref,review);
  block(review.case_ref===r.case_ref&&review.candidate_sha===r.candidate_sha,'REVIEW_IDENTITY_MISMATCH');
  block(VERDICTS.includes(review.verdict),'REVIEW_VERDICT_INVALID');
  block(list(review.review_scope,ref)&&review.review_scope.length>0&&list(review.checked_claim_refs,ref)&&review.checked_claim_refs.length>0&&list(review.checked_evidence_refs,ref)&&review.checked_evidence_refs.length>0,'SCOPED_REVIEW_REQUIRED');
  block(review.checked_claim_refs?.every(x=>r.accepted_claim_refs.includes(x))&&review.checked_evidence_refs?.every(x=>r.accepted_evidence_refs.includes(x)),'REVIEW_CHECKS_OUTSIDE_CANDIDATE');
  block(resolve(ports.verifyReview,review,r)===true,'REVIEW_RECEIPT_UNVERIFIED');
  block(!['BLOCK','REQUEST_CHANGES'].includes(review.verdict),'PARTICIPANT_REQUESTS_CHANGES');
  block(Array.isArray(review.objections),'REVIEW_OBJECTIONS_REQUIRED');
 }
 block(r.participants.every(p=>reviews.has(p)),'PARTICIPANT_REVIEW_MISSING');
 block(r.accepted_claim_refs.every(c=>r.reviews.some(v=>v.checked_claim_refs?.includes(c))),'CLAIM_REVIEW_COVERAGE_MISSING');
 const objections=[...r.objections,...r.reviews.flatMap(v=>v.objections??[])];
 for(const o of objections){
  block(['CRITICAL','MAJOR','MINOR','NOTE'].includes(o.severity)&&typeof o.resolved==='boolean','OBJECTION_SEVERITY_OR_RESOLUTION_UNKNOWN');
  if(['CRITICAL','MAJOR'].includes(o.severity))block(o.resolved===true&&ref(o.resolution_receipt_ref)&&resolve(ports.verifyObjectionResolution,o,r)===true,'MATERIAL_OBJECTION_UNRESOLVED');
 }
 const domainReceipts=r.domain_receipt_refs.map(x=>resolve(ports.readDomainReceipt,x,r));
 block(r.required_domain_gates.length>0,'DOMAIN_GATES_REQUIRED');
 for(const domain of r.required_domain_gates)block(domainReceipts.some(x=>x?.domain===domain&&x?.case_ref===r.case_ref&&x?.candidate_sha===r.candidate_sha&&x?.state==='PASS'),'DOMAIN_GATE_NOT_PASS:'+domain);
 const independence=r.independence_receipt_refs.map(x=>resolve(ports.readIndependenceReceipt,x,r));
 block(independence.length>0&&independence.every(v=>v?.eligible===true&&v?.case_ref===r.case_ref&&v?.candidate_sha===r.candidate_sha&&list(v?.participant_refs,ref))&&r.participants.every(p=>independence.some(v=>v?.participant_refs?.includes(p))),'INDEPENDENCE_UNVERIFIED');
 block(r.integration_claims_supported===true&&resolve(ports.verifyIntegration,r)===true,'INTEGRATION_CLAIMS_UNSUPPORTED');
 block(typeof r.owner_only==='boolean','OWNER_BOUNDARY_UNKNOWN');
 const ownerMissing=r.owner_only===true&&!(ref(r.owner_authorization_ref)&&resolve(ports.verifyOwnerAuthorization,r.owner_authorization_ref,r)===true);
 return freeze({schema_version:2,case_ref:r.case_ref,candidate_sha:r.candidate_sha,state:blocks.length?'BLOCKED':ownerMissing?'OWNER_REQUIRED':'PASS',blocks,dissent:r.dissent,residual_uncertainty:r.unresolved_uncertainty,review_receipt_refs:r.reviews.map(v=>v.receipt_ref??null),evidence_refs:r.accepted_evidence_refs,release_execution_authority:false});
}
export function createAppealPolicy({max_appeals=2}={}){
 requireThat(Number.isSafeInteger(max_appeals)&&max_appeals>=1&&max_appeals<=5,'APPEAL_BOUND_REQUIRED');
 const records=new Map();
 return {submit(input){
  const a=safe(input);requireThat(Object.keys(a).every(k=>['case_ref','reason','new_evidence_refs','procedure_violation','factual_error'].includes(k)),'APPEAL_AUTHORITY_FIELD_FORBIDDEN');requireThat(ref(a.case_ref)&&text(a.reason)&&list(a.new_evidence_refs,ref),'APPEAL_CONTRACT_REQUIRED');
  requireThat(a.new_evidence_refs.length>0||text(a.procedure_violation)||text(a.factual_error),'APPEAL_NEW_BASIS_REQUIRED');
  const prior=records.get(a.case_ref)??[];
  requireThat(!prior.some(p=>JSON.stringify([p.new_evidence_refs,p.procedure_violation,p.factual_error])===JSON.stringify([a.new_evidence_refs,a.procedure_violation,a.factual_error])),'DUPLICATE_APPEAL');
  if(prior.length>=max_appeals)return freeze({case_ref:a.case_ref,state:'OWNER_REQUIRED',attempt:prior.length+1,reason:'APPEAL_BUDGET_EXHAUSTED'});
  prior.push(freeze(a));records.set(a.case_ref,prior);return freeze({...a,state:'REOPEN_INTEGRATION',attempt:prior.length});
 },snapshot(){return structuredClone([...records.entries()]);}};
}
