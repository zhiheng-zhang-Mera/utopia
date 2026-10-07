import {requireThat as ok,text,strings,copy,freeze} from './validation.mjs';
export function normalizeExecutionProvider(input){
  const p=copy(input);ok(p.version===1,'PROVIDER_VERSION');ok(text(p.id)&&text(p.platform)&&strings(p.capabilities)&&strings(p.workloadKinds),'PROVIDER_SHAPE');
  ok(['ENFORCED','COOPERATIVE','UNKNOWN'].includes(p.isolation),'ISOLATION_UNKNOWN');ok(typeof p.ready==='boolean','READINESS_UNKNOWN');
  // ENFORCED needs a separately verified boundary report; a string declaration is not enforcement.
  if(p.isolation==='ENFORCED')ok(p.boundaryEvidence?.verified===true&&text(p.boundaryEvidence.reference),'BOUNDARY_EVIDENCE_REQUIRED');
  return freeze(p);
}
export function describeExecutorBoundary(provider,{requireHardIsolation=false}={}){const p=normalizeExecutionProvider(provider);if(requireHardIsolation)ok(p.isolation==='ENFORCED','HARD_ISOLATION_UNAVAILABLE');return freeze({providerId:p.id,enforcement:p.isolation,evidence:p.boundaryEvidence??null});}
