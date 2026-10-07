import {safe,freeze} from './core.mjs';
export function projectProcessCapsule(input,{readTask}={}){
 const c=safe(input),warnings=[],nodes=[];
 for(const n of c.graph.nodes){
  let canonical=null;
  try{canonical=n.canonical_task_ref&&typeof readTask==='function'?readTask(n.canonical_task_ref):null;}catch{}
  const state=canonical?.state??null;
  if(n.canonical_task_ref&&!state)warnings.push('CANONICAL_TASK_UNAVAILABLE:'+n.node_id);
  if(state&&n.status_projection!=='NOT_OBSERVED'&&n.status_projection!==state)warnings.push('PROBLEM_GRAPH_RECONCILIATION:'+n.node_id);
  if(['FAILED','BLOCKED','CANCELLED'].includes(state))warnings.push('CANONICAL_TASK_RISK:'+n.node_id);
  nodes.push({...n,canonical_state:state,canonical_source:'SHARED_TASK_CORE'});
 }
 const conflicts=c.conflicts??[],adjudications=c.adjudications??[],release=c.release??{state:'NOT_RUN',blocks:[]};
 const material=conflicts.filter(x=>x.resolved!==true||['CRITICAL','MAJOR'].includes(x.severity));
 const unresolved=conflicts.some(x=>x.resolved!==true)||adjudications.some(x=>['MORE_EVIDENCE_REQUIRED','OWNER_REQUIRED'].includes(x.final_verdict));
 const uncertainty=[...new Set([...(c.snapshot.known_unknowns??[]),...(c.results??[]).flatMap(x=>[...(x.uncertainty??[]),...(x.unresolved_questions??[])]),...(c.claims??[]).flatMap(x=>x.uncertainty??[])])];
 const activeRisk=warnings.length>0||unresolved||release.state!=='PASS';
 return freeze({schema_version:2,case_ref:c.case_ref,authoritative:false,
  L0:{request_ref:c.snapshot.request_ref,accepted_scope:c.snapshot.accepted_requirements,decomposition_summary:nodes.map(n=>({node_ref:n.node_id,question:n.question_or_verification,canonical_task_ref:n.canonical_task_ref??null,canonical_state:n.canonical_state})),participants:c.participants??[],assignment_basis:(c.assignments??[]).map(x=>({participant_ref:x.selected_participant,role:x.role,score_components:x.score_components,independence_floor:x.required_independence_profile,facts_ref:x.facts_ref})),node_outcomes:(c.results??[]).map(x=>({node_ref:x.node_ref,explicit_result:x.explicit_result,evidence_refs:x.evidence_refs})),material_conflicts:material.map(x=>({conflict_ref:x.conflict_ref,severity:x.severity,resolved:x.resolved,statement:x.statement})),adjudication_outcomes:adjudications.map(x=>({conflict_ref:x.conflict_ref,verdict:x.final_verdict})),validation_performed:c.validation??[],residual_uncertainty:uncertainty,release_gate:release,active_risk:activeRisk,warnings},
  L1:{problem_graph:nodes,claims:c.claims??[],results:c.results??[],objections:c.objections??[],defences:c.defences??[],adjudications,dissent:c.dissent??[]},
  L2:{candidate_sha:c.candidate_sha??null,snapshot_version:c.snapshot.snapshot_version??null,technical_evidence:c.technical_evidence??[],assignment_receipts:c.assignments??[],release_receipt:release,source_refs:c.snapshot.canonical_state_refs??[]}
 });
}
