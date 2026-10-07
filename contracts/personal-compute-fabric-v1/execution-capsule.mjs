// PCF-owned execution exchange schema. This module has no DGX or scheduler dependency.
import {createHash} from 'node:crypto';
const SHA=/^[a-f0-9]{40}$/,DIGEST=/^[a-f0-9]{64}$/;
const REF_KEYS=['task_ref','action_ref','parent_ref','stage_ref','origin_device_ref','parent_session_ref','execution_device_ref','boot_ref','provider_ref','session_ref','user_ref'];
const requireThat=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const ref=x=>typeof x==='string'&&x.length>0&&x.length<=256;
const refs=x=>Array.isArray(x)&&x.length<=128&&x.every(ref);
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
function bounded(input){
 let count=0;
 function walk(x,depth){
  requireThat(depth<=12&&++count<=8192,'PCF_PAYLOAD_LIMIT');
  if(x===null||typeof x==='boolean')return;
  if(typeof x==='string'){requireThat(x.length<=4096,'PCF_TEXT_LIMIT');return;}
  if(typeof x==='number'){requireThat(Number.isFinite(x),'PCF_NUMBER');return;}
  requireThat(x&&typeof x==='object'&&(Array.isArray(x)||[Object.prototype,null].includes(Object.getPrototypeOf(x))),'PCF_PLAIN_DATA');
  if(Array.isArray(x))requireThat(x.length<=128,'PCF_ARRAY_LIMIT');
  for(const [key,value] of Object.entries(x)){
   const k=key.replace(/([a-z0-9])([A-Z])/g,'$1_$2').replace(/[^a-z0-9_]/gi,'_').toLowerCase();
   requireThat(!['__proto__','constructor','prototype'].includes(key),'PCF_RESERVED_KEY');
   requireThat(!/(chain_?of_?thought|hidden_?(reasoning|thought)|scratchpad)/.test(k),'PCF_PRIVATE_REASONING');
   requireThat(!/(^|_)(token|secret|password|credential|api_key)($|_)/.test(k)||/_(ref|refs)$/.test(k),'PCF_SECRET');walk(value,depth+1);
  }
 }
 walk(input,0);requireThat(Buffer.byteLength(JSON.stringify(input))<=131072,'PCF_PAYLOAD_LIMIT');return structuredClone(input);
}
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
const hash=x=>createHash('sha256').update(canonical(x)).digest('hex');
export function compileExecutionCapsule(canonicalRefs,approvedSpec){
 const r=bounded(canonicalRefs),s=bounded(approvedSpec);
 requireThat(REF_KEYS.every(k=>ref(r[k]))&&['attempt','epoch'].every(k=>Number.isSafeInteger(r[k])&&r[k]>0)&&SHA.test(r.base_sha)&&SHA.test(r.candidate_sha),'PCF_CANONICAL_IDENTITY_REQUIRED');
 requireThat(refs(s.input_refs)&&refs(s.write_scope)&&ref(s.output_contract)&&ref(s.stop_condition)&&ref(s.permission_ref)&&ref(s.budget_ref)&&ref(s.independence_floor_ref)&&Number.isSafeInteger(s.fact_version)&&s.fact_version>0&&Number.isFinite(Date.parse(s.expires_at)),'PCF_APPROVED_SCOPE_REQUIRED');
 const body={schema_version:1,canonical_refs:r,approved_spec:s};return freeze({...body,capsule_ref:'pcf:'+hash(body)});
}
export function createResultLedger(entries=[]){
 const seen=new Map();for(const entry of bounded(entries)){requireThat(ref(entry.capsule_ref)&&entry.sequence===1&&!seen.has(entry.capsule_ref),'PCF_LEDGER_CORRUPT');seen.set(entry.capsule_ref,entry.sequence);}
 return {accept(id,sequence){if(sequence!==1||seen.has(id)||seen.size>=128)return false;seen.set(id,sequence);return true;},snapshot(){return [...seen].map(([capsule_ref,sequence])=>({capsule_ref,sequence}));}};
}
export function validateResultEnvelope(capsule,receipt,{now=Date.now,readArtifact,ledger}={}){
 try{
  const c=bounded(capsule),r=bounded(receipt),rebuilt=compileExecutionCapsule(c.canonical_refs,c.approved_spec);
  requireThat(c.capsule_ref===rebuilt.capsule_ref&&r.capsule_ref===c.capsule_ref,'PCF_CAPSULE_MISMATCH');
  requireThat([...REF_KEYS,'attempt','epoch','base_sha','candidate_sha'].every(k=>r[k]===c.canonical_refs[k])&&r.result_sha===c.canonical_refs.candidate_sha,'PCF_RESULT_IDENTITY_MISMATCH');
  const timestamp=now();requireThat(Number.isFinite(timestamp)&&timestamp<Date.parse(c.approved_spec.expires_at),'PCF_AUTHORIZATION_EXPIRED');
  requireThat(['SUCCEEDED','FAILED','CANCELLED'].includes(r.outcome)&&Number.isSafeInteger(r.exit_code)&&typeof r.stdout_summary==='string'&&typeof r.stderr_summary==='string'&&r.sequence===1,'PCF_RESULT_OUTCOME_REQUIRED');
  requireThat(refs(r.validation_evidence_refs)&&r.validation_evidence_refs.length>0&&refs(r.evidence_refs)&&r.evidence_refs.length>0,'PCF_VALIDATION_EVIDENCE_REQUIRED');
  requireThat(['assumptions','uncertainty','unresolved_questions'].every(k=>Array.isArray(r[k])&&r[k].length<=128&&r[k].every(v=>typeof v==='string')),'PCF_EXPLICIT_LIMITS_REQUIRED');
  requireThat(Array.isArray(r.artifacts)&&r.artifacts.length>0&&r.artifacts.every(a=>ref(a.artifact_ref)&&DIGEST.test(a.sha256))&&new Set(r.artifacts.map(a=>a.artifact_ref)).size===r.artifacts.length,'PCF_ARTIFACT_REQUIRED');
  requireThat(typeof readArtifact==='function','PCF_ARTIFACT_READER_UNAVAILABLE');
  for(const a of r.artifacts){const bytes=readArtifact(a.artifact_ref,c);requireThat(Buffer.isBuffer(bytes)&&bytes.length<=16*1024*1024&&createHash('sha256').update(bytes).digest('hex')===a.sha256,'PCF_ARTIFACT_DIGEST_MISMATCH');}
  requireThat(!ledger||ledger.accept(c.capsule_ref,r.sequence),'PCF_RESULT_REPLAY_OR_ORDER');
  return freeze({valid:true,schema_version:1,capsule_ref:c.capsule_ref,acceptance_authority:false,transport_authority:false});
 }catch(error){return freeze({valid:false,code:error.code??'PCF_VALIDATION_UNAVAILABLE',acceptance_authority:false});}
}
