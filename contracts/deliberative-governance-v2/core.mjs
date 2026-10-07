// Governance plans reference canonical tasks; they never own their lifecycle.
export const VERSION=2;
export const CONSTITUTION=Object.freeze(['evidence > vote','author/executor cannot arbitrate own dispute','critical/major unresolved objection blocks release','no silent uncertainty suppression','minority dissent retained','reputation affects assignment, not truth','no agent self-expands authority','Owner-only boundary remains Owner-controlled','decomposition preserves Owner intent','no hidden chain-of-thought exchange']);
export function refuse(code){throw Object.assign(new Error(code),{code});}
export function requireThat(value,code){if(!value)refuse(code);}
export function text(value){return typeof value==='string'&&value.trim().length>0&&value.length<=4096;}
export function ref(value){return text(value)&&value.length<=256;}
export function list(value,predicate=text){return Array.isArray(value)&&value.length<=128&&value.every(predicate);}
export function freeze(value){if(value&&typeof value==='object'){for(const x of Object.values(value))freeze(x);Object.freeze(value);}return value;}
export function safe(value){
 let count=0;
 const walk=(v,depth)=>{
  requireThat(depth<=12&&++count<=8192,'PAYLOAD_LIMIT');
  if(v===null||typeof v==='boolean')return;
  if(typeof v==='number'){requireThat(Number.isFinite(v),'INVALID_NUMBER');return;}
  if(typeof v==='string'){requireThat(v.length<=4096,'TEXT_LIMIT');return;}
  requireThat(v&&typeof v==='object'&&(Array.isArray(v)||[Object.prototype,null].includes(Object.getPrototypeOf(v))),'PLAIN_DATA_REQUIRED');
  if(Array.isArray(v))requireThat(v.length<=128,'ARRAY_LIMIT');
  for(const [key,child] of Object.entries(v)){
   const normalized=key.replace(/([a-z0-9])([A-Z])/g,'$1_$2').replace(/[^a-zA-Z0-9]+/g,'_').toLowerCase();
   requireThat(!['__proto__','constructor','prototype'].includes(key),'RESERVED_KEY');
   requireThat(!/(chain_?of_?thought|hidden_?(reasoning|thought)|scratchpad)/.test(normalized),'PRIVATE_REASONING_FORBIDDEN');
   requireThat(!/(^|_)(api_?token|token|secret|password|credential|api_?key)s?($|_)/.test(normalized)||/_(ref|refs|handle)$/.test(normalized),'SECRET_FORBIDDEN');
   requireThat(!['canonical_task_state','city_task_state','task_owner_truth','device_trust_state','capability_registry_truth','reputation_database'].includes(normalized),'FOREIGN_AUTHORITY_FORBIDDEN');
   walk(child,depth+1);
  }
 };
 walk(value,0);requireThat(Buffer.byteLength(JSON.stringify(value))<=131072,'PAYLOAD_LIMIT');return structuredClone(value);
}
export function createSnapshot(input){
 const s=safe(input);
 requireThat(Object.keys(s).every(k=>['request_ref','accepted_requirements','canonical_state_refs','evidence_refs','domain_constraints','known_unknowns','snapshot_version','schema_version'].includes(k)),'SNAPSHOT_UNKNOWN_FIELD');
 requireThat(ref(s.request_ref)&&Number.isSafeInteger(s.snapshot_version)&&s.snapshot_version>0,'SNAPSHOT_ID_REQUIRED');
 for(const key of ['accepted_requirements','canonical_state_refs','evidence_refs','domain_constraints','known_unknowns'])requireThat(list(s[key]),'SNAPSHOT_'+key.toUpperCase());
 requireThat(s.accepted_requirements.length>0,'OWNER_INTENT_REQUIRED');
 return freeze({...s,schema_version:VERSION});
}
export function validateGraph(input,snapshot){
 const g=safe(input),s=createSnapshot(snapshot);
 requireThat(ref(g.graph_id)&&ref(g.snapshot_ref)&&g.request_ref===s.request_ref,'GRAPH_IDENTITY_MISMATCH');
 requireThat(JSON.stringify(g.accepted_requirements)===JSON.stringify(s.accepted_requirements),'OWNER_INTENT_CHANGED');
 requireThat(Array.isArray(g.nodes)&&g.nodes.length>0&&g.nodes.length<=64,'GRAPH_NODE_LIMIT');
 requireThat(list(g.provenance,x=>Number.isSafeInteger(x.revision)&&x.revision>0&&text(x.reason)&&list(x.evidence_refs,ref))&&g.provenance.length>0,'GRAPH_PROVENANCE_REQUIRED');
 requireThat(g.provenance.every((p,i)=>p.revision===i+1),'GRAPH_PROVENANCE_ORDER');
 const ids=new Set();
 for(const n of g.nodes){
  requireThat(ref(n.node_id)&&!ids.has(n.node_id),'DUPLICATE_NODE');ids.add(n.node_id);
  requireThat(text(n.question_or_verification)&&text(n.expected_output_contract)&&text(n.stop_condition),'BOUNDED_NODE_REQUIRED');
  requireThat(list(n.dependencies,ref)&&new Set(n.dependencies).size===n.dependencies.length&&list(n.required_capabilities,ref)&&list(n.input_refs,ref),'NODE_REFS_REQUIRED');
  requireThat(n.independence_floor&&Object.values(n.independence_floor).every(v=>typeof v==='boolean'),'INDEPENDENCE_FLOOR_REQUIRED');
  requireThat(ref(n.status_projection)&&(!n.canonical_task_ref||ref(n.canonical_task_ref)),'TASK_REFERENCE_REQUIRED');
 }
 const visiting=new Set(),done=new Set(),byId=new Map(g.nodes.map(n=>[n.node_id,n]));
 const visit=id=>{requireThat(ids.has(id),'UNKNOWN_DEPENDENCY');requireThat(!visiting.has(id),'GRAPH_CYCLE');if(done.has(id))return;visiting.add(id);for(const d of byId.get(id).dependencies)visit(d);visiting.delete(id);done.add(id);};
 for(const id of ids)visit(id);
 return freeze({...g,schema_version:VERSION,authoritative:false});
}
export function extendGraph(graph,change,snapshot){
 safe(change);requireThat(list(change.nodes,n=>n&&typeof n==='object')&&text(change.reason)&&list(change.evidence_refs,ref)&&change.evidence_refs.length>0,'EXTENSION_PROVENANCE_REQUIRED');
 return validateGraph({...graph,nodes:[...graph.nodes,...change.nodes],provenance:[...graph.provenance,{revision:graph.provenance.length+1,reason:change.reason,evidence_refs:change.evidence_refs}]},snapshot);
}
export function compileTaskCapsule(node,snapshot,pcfPort,canonicalRefs){
 requireThat(typeof pcfPort?.compileExecutionCapsule==='function','PCF_726_UNAVAILABLE');
 const s=createSnapshot(snapshot);safe(node);safe(canonicalRefs);
 requireThat(ref(node.node_id)&&text(node.stop_condition),'BOUNDED_NODE_REQUIRED');
 requireThat(ref(node.canonical_task_ref)&&canonicalRefs?.task_ref===node.canonical_task_ref,'TASK_CAPSULE_CANONICAL_MISMATCH');
 const substrate=safe(pcfPort.compileExecutionCapsule(canonicalRefs,{input_refs:node.input_refs,output_contract:node.expected_output_contract,stop_condition:node.stop_condition,independence_floor_ref:node.node_id}));
 return freeze({schema_version:VERSION,substrate,node_ref:node.node_id,snapshot_version:s.snapshot_version,request_ref:s.request_ref,question:node.question_or_verification,independence_floor:node.independence_floor,domain_constraints:s.domain_constraints});
}
export function validateGovernanceResult(capsule,input,pcfPort){
 requireThat(typeof pcfPort?.validateResultEnvelope==='function','PCF_726_UNAVAILABLE');
 const r=safe(input);requireThat(text(r.explicit_result)&&text(r.proposed_next_action),'EXPLICIT_RESULT_REQUIRED');
 for(const key of ['assumptions','evidence_refs','uncertainty','unresolved_questions'])requireThat(list(r[key]),'RESULT_'+key.toUpperCase());
 requireThat(pcfPort.validateResultEnvelope(capsule.substrate,r)?.valid===true,'PCF_RESULT_REJECTED');
 return freeze({...r,schema_version:VERSION,node_ref:capsule.node_ref,snapshot_version:capsule.snapshot_version});
}
