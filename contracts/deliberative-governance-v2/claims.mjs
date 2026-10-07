import {createHash} from 'node:crypto';
import {safe,requireThat,ref,list,freeze} from './core.mjs';
import {CONFLICT_TYPES} from './adjudication.mjs';
export function validateClaim(input){
 const c=safe(input);requireThat(['claim_ref','participant_ref','node_ref','subject_ref','predicate_ref'].every(k=>ref(c[k])),'CLAIM_IDENTITY_REQUIRED');
 requireThat(['string','boolean','number'].includes(typeof c.assertion_value)&&!(typeof c.assertion_value==='number'&&!Number.isFinite(c.assertion_value)),'CANONICAL_ASSERTION_VALUE_REQUIRED');
 requireThat(list(c.evidence_refs,ref)&&list(c.assumptions)&&list(c.uncertainty),'CLAIM_EVIDENCE_UNCERTAINTY_REQUIRED');
 requireThat(CONFLICT_TYPES.includes(c.type)&&['CRITICAL','MAJOR','MINOR'].includes(c.severity),'CLAIM_CLASSIFICATION_REQUIRED');
 return freeze({...c,schema_version:2});
}
// Detect only contradictions of the same declared predicate. Narrative disagreement
// requires an explicit conflict declaration, rather than an invented semantic verdict.
export function detectConflicts(inputs){
 requireThat(Array.isArray(inputs)&&inputs.length<=64,'CLAIM_LIMIT');const claims=inputs.map(validateClaim).sort((a,b)=>a.claim_ref.localeCompare(b.claim_ref));
 requireThat(new Set(claims.map(c=>c.claim_ref)).size===claims.length,'DUPLICATE_CLAIM');const conflicts=[];
 for(let i=0;i<claims.length;i++)for(let j=i+1;j<claims.length;j++){
  const a=claims[i],b=claims[j];if(a.subject_ref!==b.subject_ref||a.predicate_ref!==b.predicate_ref||a.assertion_value===b.assertion_value)continue;
  requireThat(conflicts.length<64,'CONFLICT_LIMIT');
  const claim_refs=[a.claim_ref,b.claim_ref],conflict_ref='conflict-'+createHash('sha256').update(JSON.stringify(claim_refs)).digest('hex').slice(0,24);
  const severity=[a.severity,b.severity].includes('CRITICAL')?'CRITICAL':[a.severity,b.severity].includes('MAJOR')?'MAJOR':'MINOR';
  conflicts.push({conflict_ref,node_ref:a.node_ref,type:a.type===b.type?a.type:'INTERPRETATION',severity,resolved:false,statement:'Contradictory explicit assertions for '+a.subject_ref+' / '+a.predicate_ref,claim_refs,parties:[...new Set([a.participant_ref,b.participant_ref])],evidence_refs:[...new Set([...a.evidence_refs,...b.evidence_refs])],detection:'STRUCTURED_PREDICATE_CONTRADICTION'});
 }
 return freeze(conflicts);
}
