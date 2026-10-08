import {CONNECTOR_PORT} from '../../contracts/engineering-reference-connectors-v1/reference-connectors.mjs';
import {requireThat as ok,copy} from './validation.mjs';
export function bindEngineeringExecutor(connector,manifest){
 ok(manifest?.version===1&&typeof manifest.id==='string','ENGINEERING_PROVIDER_VERSION');for(const method of CONNECTOR_PORT.methods)ok(typeof connector?.[method]==='function','CONNECTOR_METHOD_'+method);
 return {
  providerId:manifest.id,
  probe:()=>connector.probe(),version:()=>connector.version(),auth:()=>connector.auth(),readiness:()=>connector.readiness(),health:()=>connector.health(),
  async submit(request){const readiness=await connector.readiness();ok(readiness.state==='READY','REAL_PROVIDER_UNAVAILABLE');ok(request.capsule&&request.inputArtifact&&request.isolatedWorktree&&request.approved===true,'ENGINEERING_APPROVAL_OR_INPUT_REQUIRED');return connector.submit(copy(request));},
  startOrAttach:request=>connector.startOrAttach(copy(request)),events:request=>connector.events(copy(request)),result:request=>connector.result(copy(request)),control:request=>connector.control(copy(request)),
  evidenceClass:'CONNECTOR_CONTRACT_ONLY_UNTIL_REAL_PROVIDER_RUN',
 };
}
