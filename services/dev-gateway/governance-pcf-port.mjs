import {compileExecutionCapsule,validateResultEnvelope} from '../../contracts/personal-compute-fabric-v1/execution-capsule.mjs';
import {safe,requireThat} from '../../contracts/deliberative-governance-v2/core.mjs';
// Host-owned readers are injected at composition; no HTTP input can install readers.
export function createPcfGovernancePort({readApprovedExecutionSpec,readArtifact,now=Date.now}={}){
 return {
  compileExecutionCapsule(refs,semanticSpec){
   requireThat(typeof readApprovedExecutionSpec==='function','APPROVED_EXECUTION_SPEC_UNAVAILABLE');
   const approved=safe(readApprovedExecutionSpec(refs));
   requireThat(approved.task_ref===refs.task_ref&&approved.user_ref===refs.user_ref&&approved.attempt===refs.attempt&&approved.epoch===refs.epoch,'APPROVED_EXECUTION_IDENTITY_MISMATCH');
   requireThat(approved.fact_version===semanticSpec.fact_version,'APPROVED_FACT_VERSION_MISMATCH');
   requireThat(JSON.stringify(approved.input_refs)===JSON.stringify(semanticSpec.input_refs)&&approved.output_contract===semanticSpec.output_contract&&approved.stop_condition===semanticSpec.stop_condition&&approved.independence_floor_ref===semanticSpec.independence_floor_ref,'APPROVED_EXECUTION_SCOPE_MISMATCH');
   return compileExecutionCapsule(refs,approved);
  },
  validateResultEnvelope(capsule,receipt){return validateResultEnvelope(capsule,receipt,{now,readArtifact});}
 };
}
