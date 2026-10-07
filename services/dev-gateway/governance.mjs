// Bounded governance documents, not a canonical task store or an executor.
import {mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync,statSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {safe,requireThat,ref,list,createSnapshot,validateGraph,extendGraph,compileTaskCapsule,validateGovernanceResult} from '../../contracts/deliberative-governance-v2/core.mjs';
import {assignParticipant} from '../../contracts/deliberative-governance-v2/assignment.mjs';
import {checkIndependence} from '../../contracts/deliberative-governance-v2/assignment.mjs';
import {DOMAIN_PROFILES} from '../../contracts/deliberative-governance-v2/profiles.mjs';
import {createAdjudication} from '../../contracts/deliberative-governance-v2/adjudication.mjs';
import {evaluateRelease,createAppealPolicy} from '../../contracts/deliberative-governance-v2/release.mjs';
import {projectProcessCapsule} from '../../contracts/deliberative-governance-v2/projection.mjs';
const ID=/^[a-z][a-z0-9-]{2,63}$/;
export function createGovernanceService({dir,readTask,ports={}}={}){
 requireThat(typeof dir==='string'&&dir.length>0,'GOVERNANCE_DIRECTORY_REQUIRED');const root=resolve(dir);let unavailable=false;
 try{mkdirSync(root,{recursive:true});}catch{unavailable=true;}
 const pathOf=id=>{requireThat(typeof id==='string'&&ID.test(id),'INVALID_CASE_ID');return join(root,id+'.json');};
 const load=id=>{
  requireThat(!unavailable,'GOVERNANCE_STORE_UNAVAILABLE');const path=pathOf(id);requireThat(existsSync(path),'CASE_NOT_FOUND');
  requireThat(statSync(path).size<=131072,'CASE_STORAGE_LIMIT');const c=safe(JSON.parse(readFileSync(path,'utf8')));
  requireThat(c.case_ref===id&&Number.isSafeInteger(c.revision)&&c.revision>0,'CASE_STORAGE_CORRUPT');
  createSnapshot(c.snapshot);validateGraph(c.graph,c.snapshot);return c;
 };
 const save=c=>{
  requireThat(!unavailable,'GOVERNANCE_STORE_UNAVAILABLE');safe(c);const path=pathOf(c.case_ref),temp=path+'.'+randomUUID()+'.tmp';
  // No case state changes are accepted until atomic persistence succeeds.
  const bytes=JSON.stringify(c);requireThat(Buffer.byteLength(bytes)<=131072,'CASE_STORAGE_LIMIT');
  try{writeFileSync(temp,bytes,{flag:'wx'});renameSync(temp,path);}catch{requireThat(false,'GOVERNANCE_PERSISTENCE_FAILED');}
 };
 const inspect=id=>{const c=load(id);return {...c,process_capsule:projectProcessCapsule(c,{readTask}),ports:{pcf726:typeof ports.pcf?.compileExecutionCapsule==='function'?'AVAILABLE':'UNAVAILABLE',capability_facts:typeof ports.readCandidates==='function'?'AVAILABLE':'UNAVAILABLE',participant_receipts:typeof ports.verifyParticipantReceipt==='function'?'AVAILABLE':'UNAVAILABLE'}};};
 const inventory=()=>{
  if(unavailable)return {health:'UNAVAILABLE',cases:[],errors:['GOVERNANCE_STORE_UNAVAILABLE'],authoritative:false};
  const cases=[],errors=[];let names;try{names=readdirSync(root);}catch{return {health:'UNAVAILABLE',cases:[],errors:['GOVERNANCE_STORE_READ_FAILED'],authoritative:false};}
  for(const name of names.filter(n=>n.endsWith('.json')).slice(0,33))try{const c=load(name.slice(0,-5));cases.push({case_ref:c.case_ref,domain:c.domain,revision:c.revision,release_state:c.release.state});}catch{errors.push('CASE_STORAGE_CORRUPT:'+name.slice(0,64));}
  if(names.filter(n=>n.endsWith('.json')).length>32)errors.push('CASE_WINDOW_LIMIT');
  return {health:errors.length?'DEGRADED':'READY',cases,errors,authoritative:false};
 };
 const create=input=>{
  const d=safe(input);pathOf(d.case_ref);requireThat(!existsSync(pathOf(d.case_ref)),'CASE_ALREADY_EXISTS');requireThat(inventory().cases.length<32,'CASE_CAPACITY');
  requireThat(Object.hasOwn(DOMAIN_PROFILES,d.domain)&&/^[a-f0-9]{40}$/.test(d.candidate_sha),'DOMAIN_EXACT_HEAD_REQUIRED');
  const snapshot=createSnapshot(d.snapshot),graph=validateGraph(d.graph,snapshot);
  const c={schema_version:2,case_ref:d.case_ref,domain:d.domain,candidate_sha:d.candidate_sha,snapshot,graph,revision:1,participants:[],assignments:[],results:[],conflicts:[],adjudication_sessions:[],adjudications:[],validation:[],reviews:[],appeals:[],dissent:[],claims:[],objections:[],technical_evidence:[],release:{state:'NOT_RUN',blocks:['INDEPENDENT_EVIDENCE_NOT_OBSERVED']}};
  save(c);return inspect(c.case_ref);
 };
 const verifyParticipant=(receipt,c)=>{requireThat(typeof ports.verifyParticipantReceipt==='function','PARTICIPANT_RECEIPT_UNAVAILABLE');requireThat(ports.verifyParticipantReceipt(receipt,c)===true,'PARTICIPANT_RECEIPT_REJECTED');};
 const participantFacts=(id,c)=>{requireThat(typeof ports.readParticipantFacts==='function','PARTICIPANT_FACTS_UNAVAILABLE');const facts=safe(ports.readParticipantFacts(id,c));requireThat(facts?.participant_ref===id,'PARTICIPANT_FACTS_MISMATCH');return facts;};
 const act=(id,input)=>{
  const a=safe(input),c=load(id);requireThat(a.expected_revision===c.revision,'CASE_REVISION_CONFLICT');
  const node=id=>{const n=c.graph.nodes.find(x=>x.node_id===id);requireThat(n,'UNKNOWN_PROBLEM_NODE');return n;};
  switch(a.action){
   case 'EXTEND_GRAPH':c.graph=extendGraph(c.graph,a,c.snapshot);break;
   case 'ASSIGN':{
    requireThat(typeof ports.readCandidates==='function','CAPABILITY_FACTS_UNAVAILABLE');
    const n=node(a.request.problem_node_ref);requireThat(a.request.task_ref===n.canonical_task_ref,'ASSIGNMENT_TASK_MISMATCH');
    requireThat(typeof ports.readTaskAuthorship==='function','TASK_AUTHORSHIP_UNAVAILABLE');const authors=ports.readTaskAuthorship(n.canonical_task_ref,c);requireThat(list(authors,ref)&&authors.includes(a.request.origin?.participant_ref),'TASK_AUTHORSHIP_MISMATCH');
    const origin=participantFacts(a.request.origin.participant_ref,c);
    const candidates=ports.readCandidates(a.request,c);const receipt=assignParticipant({...a.request,origin,domain:c.domain,required_capabilities:n.required_capabilities,independence_floor:{...a.request.independence_floor,...n.independence_floor}},candidates);
    c.assignments.push(receipt);if(receipt.selected_participant&&!c.participants.some(p=>p.participant_ref===receipt.selected_participant))c.participants.push({participant_ref:receipt.selected_participant,role:receipt.role});break;
   }
   case 'RESULT':{
    requireThat(ports.pcf,'PCF_726_UNAVAILABLE');verifyParticipant(a.receipt,c);const n=node(a.node_ref);
    const capsule=compileTaskCapsule(n,c.snapshot,ports.pcf,a.canonical_refs);const r=validateGovernanceResult(capsule,a.receipt,ports.pcf);
    requireThat(!c.results.some(x=>x.node_ref===n.node_id),'NODE_RESULT_IMMUTABLE');c.results.push(r);break;
   }
   case 'CONFLICT':{
    const x=safe(a.conflict);node(x.node_ref);requireThat(ref(x.conflict_ref)&&['FACT','METHOD','INTERPRETATION','EXECUTION','REQUIREMENT'].includes(x.type)&&['CRITICAL','MAJOR','MINOR'].includes(x.severity)&&ref(x.statement)&&x.resolved===false,'CONFLICT_CONTRACT_REQUIRED');
    requireThat(!c.conflicts.some(v=>v.conflict_ref===x.conflict_ref),'DUPLICATE_CONFLICT');c.conflicts.push(x);break;
   }
   case 'START_ADJUDICATION':{
    verifyParticipant(a.receipt,c);const x=c.conflicts.find(x=>x.conflict_ref===a.context.conflict_ref);requireThat(x&&!c.adjudication_sessions.some(y=>y.context.conflict_ref===x.conflict_ref),'CONFLICT_NOT_PENDING');
    requireThat(a.context.case_ref===c.case_ref&&a.context.node_ref===x.node_ref,'ADJUDICATION_CASE_MISMATCH');
    requireThat(a.receipt.participant_ref===a.context.adjudicator.participant_ref,'ADJUDICATOR_RECEIPT_IDENTITY');
    requireThat(typeof ports.readConflictParties==='function','CONFLICT_PARTIES_UNAVAILABLE');const parties=ports.readConflictParties(x.conflict_ref,c);
    requireThat(list(parties,ref)&&parties.length===2,'CONFLICT_PARTIES_REQUIRED');
    const adjudicator=participantFacts(a.context.adjudicator.participant_ref,c),party_origins=parties.map(id=>participantFacts(id,c));
    const floor={...a.context.independence_floor,role_authorship_independence:true,agent_or_session_independence:true,conflict_of_interest_recusal:true};
    requireThat(party_origins.every(p=>checkIndependence(adjudicator,p,floor,x.node_ref).eligible),'ADJUDICATOR_NOT_INDEPENDENT');
    const context={...a.context,parties,adjudicator,origin:party_origins[0],party_origins,independence_floor:floor};
    createAdjudication({...context,snapshot:c.snapshot});
    for(const [id,role] of [...parties.map(id=>[id,'DISPUTE_PARTY']),[adjudicator.participant_ref,'GOVERNANCE_ADJUDICATOR']])if(!c.participants.some(p=>p.participant_ref===id))c.participants.push({participant_ref:id,role});
    c.adjudication_sessions.push({context,pass_a_findings:null,defences:[],receipt:null});break;
   }
   case 'PASS_A':case 'DEFENCE':case 'PASS_B':{
    verifyParticipant(a.receipt,c);const session=c.adjudication_sessions.find(x=>x.context.conflict_ref===a.conflict_ref);
    requireThat(session&&!session.receipt,'ADJUDICATION_NOT_PENDING');const judge=createAdjudication({...session.context,snapshot:c.snapshot});
    if(session.pass_a_findings)judge.recordPassA(session.pass_a_findings);
    for(const d of session.defences)judge.submitDefence(d);
    if(a.action==='PASS_A'){
     requireThat(a.receipt.participant_ref===session.context.adjudicator.participant_ref,'ADJUDICATOR_RECEIPT_IDENTITY');session.pass_a_findings=judge.recordPassA(a.receipt.findings);
    }else if(a.action==='DEFENCE'){session.defences.push(judge.submitDefence(a.receipt));}
    else{
     requireThat(a.receipt.participant_ref===session.context.adjudicator.participant_ref,'ADJUDICATOR_RECEIPT_IDENTITY');session.receipt=judge.finalize(a.receipt);c.adjudications.push(session.receipt);
     const x=c.conflicts.find(x=>x.conflict_ref===a.conflict_ref);x.resolved=!['MORE_EVIDENCE_REQUIRED','OWNER_REQUIRED'].includes(session.receipt.final_verdict);x.resolution_receipt_ref=session.receipt.conflict_ref;
    }break;
   }
   case 'FINAL_REVIEW':{
    verifyParticipant(a.receipt,c);requireThat(a.receipt.case_ref===c.case_ref&&a.receipt.candidate_sha===c.candidate_sha&&c.participants.some(p=>p.participant_ref===a.receipt.participant_ref),'REVIEW_CASE_MISMATCH');
    requireThat(!c.reviews.some(r=>r.participant_ref===a.receipt.participant_ref),'FINAL_REVIEW_IMMUTABLE');c.reviews.push(a.receipt);break;
   }
   case 'DISSENT':verifyParticipant(a.receipt,c);requireThat(c.participants.some(p=>p.participant_ref===a.receipt.participant_ref)&&ref(a.receipt.statement),'DISSENT_PARTICIPANT_REQUIRED');c.dissent.push(a.receipt);break;
   case 'APPEAL':{
    const policy=createAppealPolicy({max_appeals:2});for(const x of c.appeals)policy.submit({case_ref:x.case_ref,reason:x.reason,new_evidence_refs:x.new_evidence_refs,procedure_violation:x.procedure_violation,factual_error:x.factual_error});const receipt=policy.submit({...a.appeal,case_ref:c.case_ref});if(receipt.state!=='OWNER_REQUIRED')c.appeals.push(receipt);else c.appeal_escalation=true;c.release={state:receipt.state,blocks:['APPEAL_PENDING']};break;
   }
   case 'RESOLVE_APPEAL':{
    requireThat(typeof ports.verifyAppealResolution==='function'&&ports.verifyAppealResolution(a.receipt,c)===true,'APPEAL_RESOLUTION_UNVERIFIED');
    requireThat(a.receipt.case_ref===c.case_ref&&a.receipt.candidate_sha===c.candidate_sha&&ref(a.receipt.receipt_ref)&&list(a.receipt.evidence_refs,ref)&&a.receipt.evidence_refs.length>0,'APPEAL_RESOLUTION_IDENTITY');
    if(c.appeal_escalation)requireThat(typeof ports.release?.verifyOwnerAuthorization==='function'&&ports.release.verifyOwnerAuthorization(a.receipt.owner_authorization_ref,c)===true,'OWNER_ESCALATION_UNRESOLVED');
    requireThat(Number.isInteger(a.receipt.attempt)&&a.receipt.attempt>=1&&a.receipt.attempt<=c.appeals.length,'UNKNOWN_APPEAL');
    c.appeals[a.receipt.attempt-1].resolution_receipt_ref=a.receipt.receipt_ref;c.appeal_escalation=false;break;
   }
   case 'EVALUATE_RELEASE':{
    // Case identity, participants and collected results cannot be replaced by request JSON.
    c.release=evaluateRelease({...a.input,case_ref:c.case_ref,candidate_sha:c.candidate_sha,participants:c.participants.map(p=>p.participant_ref),reviews:c.reviews,objections:c.conflicts,dissent:c.dissent,unresolved_uncertainty:[...c.snapshot.known_unknowns,...c.results.flatMap(x=>x.uncertainty)],required_domain_gates:[c.domain]},ports.release);
    if(c.results.length!==c.graph.nodes.length)c.release={...c.release,state:'BLOCKED',blocks:[...c.release.blocks,'NODE_RESULTS_INCOMPLETE']};break;
   }
   default:requireThat(false,'UNKNOWN_GOVERNANCE_ACTION');
  }
  // Any change invalidates a previous candidate release verdict.
  if(!['EVALUATE_RELEASE','APPEAL'].includes(a.action))c.release={state:'NOT_RUN',blocks:['CASE_CHANGED_REVALIDATION_REQUIRED']};
  if(c.appeal_escalation||c.appeals.some(x=>!ref(x.resolution_receipt_ref)))c.release={...c.release,state:c.appeal_escalation?'OWNER_REQUIRED':'BLOCKED',blocks:[...c.release.blocks,'APPEAL_PENDING']};
  c.revision++;save(c);return inspect(id);
 };
 return {create,inspect,list:inventory,act};
}
