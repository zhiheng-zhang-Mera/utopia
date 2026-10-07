import {createSnapshot,safe,requireThat,ref,text,list,freeze} from './core.mjs';
import {checkIndependence} from './assignment.mjs';
export const CONFLICT_TYPES=Object.freeze(['FACT','METHOD','INTERPRETATION','EXECUTION','REQUIREMENT']);
export const ADJUDICATION_VERDICTS=Object.freeze(['A_ACCEPTED','B_ACCEPTED','MERGED','BOTH_REJECTED','MORE_EVIDENCE_REQUIRED','OWNER_REQUIRED']);
// The caller supplies explicit findings from an independently authenticated participant.
// This protocol enforces information order; it does not invent a model verdict.
export function createAdjudication(input){
 const c=safe(input);
 requireThat(ref(c.case_ref)&&ref(c.conflict_ref)&&ref(c.node_ref)&&CONFLICT_TYPES.includes(c.type)&&text(c.neutral_statement)&&text(c.question),'CONFLICT_CONTEXT_REQUIRED');
 requireThat(list(c.parties,ref)&&c.parties.length===2&&new Set(c.parties).size===2&&!c.parties.includes(c.adjudicator?.participant_ref),'ADJUDICATOR_IS_PARTY');
 const floor={role_authorship_independence:true,agent_or_session_independence:true,conflict_of_interest_recusal:true,...c.independence_floor};
 // Supplied floor can strengthen, never disable these minimum dimensions.
 Object.assign(floor,{role_authorship_independence:true,agent_or_session_independence:true,conflict_of_interest_recusal:true});
 requireThat(checkIndependence(c.adjudicator,c.origin,floor,c.node_ref).eligible,'ADJUDICATOR_NOT_INDEPENDENT');
 const snapshot=createSnapshot(c.snapshot);
 requireThat(list(c.canonical_evidence_refs,ref),'CANONICAL_EVIDENCE_REQUIRED');
 let findings=null,receipt=null;const defences=[];
 const passAInput=()=>structuredClone({case_ref:c.case_ref,conflict_ref:c.conflict_ref,question:c.question,neutral_statement:c.neutral_statement,snapshot,canonical_evidence_refs:c.canonical_evidence_refs});
 const recordPassA=input=>{
  requireThat(!findings&&!receipt,'PASS_A_ALREADY_RECORDED');const f=safe(input);
  for(const k of ['material_facts','missing_evidence','candidate_interpretations','provisional_objections','needs_more_evidence','evidence_refs'])requireThat(list(f[k]),'PASS_A_'+k.toUpperCase());
  findings=freeze(f);return structuredClone(findings);
 };
 const submitDefence=input=>{
  requireThat(findings&&!receipt,'PASS_A_REQUIRED_OR_FINAL');const d=safe(input);
  requireThat(c.parties.includes(d.participant_ref)&&!defences.some(x=>x.participant_ref===d.participant_ref),'INVALID_OR_DUPLICATE_PARTY');
  requireThat(text(d.claim)&&text(d.critique_of_alternative)&&text(d.what_evidence_would_change_my_mind)&&list(d.supporting_evidence_refs,ref)&&list(d.assumptions),'DEFENCE_CONTRACT_REQUIRED');
  requireThat(['MAINTAIN','WITHDRAW','PARTIAL_ACCEPT','MERGE'].includes(d.disposition),'DEFENCE_DISPOSITION_REQUIRED');
  requireThat(d.confidence_if_available===null||(typeof d.confidence_if_available==='number'&&d.confidence_if_available>=0&&d.confidence_if_available<=1),'INVALID_CONFIDENCE');
  defences.push(freeze(d));return structuredClone(d);
 };
 const passBInput=()=>{requireThat(findings,'PASS_A_REQUIRED');return structuredClone({...passAInput(),pass_a_findings:findings,defences});};
 const finalize=input=>{
  requireThat(findings&&!receipt,'PASS_A_REQUIRED_OR_FINAL');const r=safe(input);
  requireThat(ADJUDICATION_VERDICTS.includes(r.final_verdict),'INVALID_ADJUDICATION_VERDICT');
  for(const k of ['new_information_from_defence','changed_findings','unchanged_findings','evidence_refs'])requireThat(list(r[k]),'PASS_B_'+k.toUpperCase());
  const unresolved=['MORE_EVIDENCE_REQUIRED','OWNER_REQUIRED'].includes(r.final_verdict);
  if(!unresolved){
   requireThat(defences.length===c.parties.length,'DEFENCE_OPPORTUNITY_REQUIRED');
   requireThat(r.evidence_refs.length>0,'VERDICT_EVIDENCE_REQUIRED');
   requireThat(findings.needs_more_evidence.length===0&&findings.missing_evidence.length===0||list(r.resolved_missing_evidence_refs,ref)&&r.resolved_missing_evidence_refs.length>0,'MORE_EVIDENCE_REQUIRED');
  }
  receipt=freeze({schema_version:2,case_ref:c.case_ref,conflict_ref:c.conflict_ref,adjudicator_ref:c.adjudicator.participant_ref,independence_profile:floor,pass_a_findings:findings,defences:[...defences],...r,domain_review_replacement:false});return structuredClone(receipt);
 };
 return {passAInput,recordPassA,submitDefence,passBInput,finalize,snapshot:()=>structuredClone({case_ref:c.case_ref,conflict_ref:c.conflict_ref,state:receipt?'FINAL':findings?'PASS_B':'PASS_A',pass_a_findings:findings,defences,receipt})};
}
