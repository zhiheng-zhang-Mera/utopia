// Plans only. Existing launcher remains the actual runtime authority.
export function planDeployment({action,optIn=false,currentSchema,targetSchema,ready=false}){const refuse=reason=>({state:'REFUSED',reason,automaticInstall:false});if(!['INSTALL','START','DRAIN','STOP','UNINSTALL','ROLLBACK'].includes(action))return refuse('ACTION_UNSUPPORTED');if(optIn!==true)return refuse('EXPLICIT_OPT_IN_REQUIRED');if(action==='ROLLBACK'&&currentSchema!==targetSchema)return refuse('SCHEMA_ROLLBACK_UNSAFE');if(action==='START'&&ready!==true)return refuse('PREFLIGHT_REQUIRED');return {state:'PROPOSED',action,automaticInstall:false,requiresOperatorExecution:true,credentialHandling:'EXISTING_ENROLLMENT_REFERENCE_ONLY',defaultProfile:'STANDARD_DEVICES'};}

const refusal = reason => ({state:'REFUSED',reason,automaticInstall:false});
const cleanConfig = c => ({version:c.version,schemaVersion:c.schemaVersion,port:c.port,credentialReference:c.credentialReference,profile:c.profile||'STANDARD_DEVICES'});
function validateDeploymentConfig(config) {
 if(!config)return refusal('CONFIG_MISSING');
 if(typeof config!=='object'||!config.version||!Number.isInteger(config.schemaVersion)||!Number.isInteger(config.port)||config.port<1024||config.port>65535)return refusal('CONFIG_CORRUPT');
 if(Object.keys(config).some(k=>/token|password|secret|credentialValue/i.test(k)))return refusal('CREDENTIAL_VALUE_FORBIDDEN');
 if(typeof config.credentialReference!=='string'||!config.credentialReference.trim())return refusal('CREDENTIAL_REFERENCE_REQUIRED');
 return {state:'VALID',config:cleanConfig(config)};
}
export function preflightDeployment({config,checks={}}={}) {
 const valid=validateDeploymentConfig(config);if(valid.state!=='VALID')return valid;
 if(checks.writable!==true)return refusal('PERMISSION_DENIED');
 if(checks.portAvailable!==true)return refusal('PORT_OCCUPIED');
 if(!Number.isFinite(checks.freeBytes)||checks.freeBytes<1048576)return refusal('DISK_QUOTA');
 if(checks.versionsCompatible!==true)return refusal('MIXED_VERSION');
 return {state:'READY',minimumPrivilege:'CURRENT_USER',automaticInstall:false,config:cleanConfig(config)};
}
export function createDeploymentController({config,checks,adapter={},initialManifest}={}) {
 let current=config?cleanConfig(config):null;let installed=initialManifest?.installed===true;let running=initialManifest?.running===true;let restoredRuntimeUnverified=running;let runtimeIdentity=initialManifest?.runtimeIdentity??null;let drained=false;let busy=false;let attention=null;
 const manifest=()=>({...current,installed,running,runtimeIdentity,drained,attention,profile:current?.profile||'STANDARD_DEVICES',serviceInstalled:false,autostart:false,authority:'EXISTING_WINDOWS_LAUNCHER',credentialHandling:'EXISTING_ENROLLMENT_REFERENCE_ONLY'});
 async function invoke(name,...args){if(typeof adapter[name]!=='function')throw new Error('ADAPTER_REQUIRED_'+name.toUpperCase());return await adapter[name](...args);}
 async function execute(action,{optIn=false,dryRun=true,target}={}) {
  if(optIn!==true)return refusal('EXPLICIT_OPT_IN_REQUIRED');
  if(!['INSTALL','START','STOP','DRAIN','UNINSTALL','UPDATE','ROLLBACK','STANDARD_DEVICES'].includes(action))return refusal('ACTION_UNSUPPORTED');
  if(busy)return refusal('DEPLOYMENT_BUSY');
  if(action==='START'&&running)return refusal('ALREADY_RUNNING');
  if(action==='ROLLBACK'){const valid=validateDeploymentConfig(target);if(valid.state!=='VALID')return valid;}
  if(action==='ROLLBACK'&&target?.schemaVersion!==current?.schemaVersion)return refusal('SCHEMA_ROLLBACK_UNSAFE');
  if(action==='UPDATE'&&!drained)return refusal('DRAIN_REQUIRED');
  if(['INSTALL','START','UPDATE'].includes(action)){const preflight=preflightDeployment({config:action==='UPDATE'?target:config,checks});if(preflight.state!=='READY')return preflight;}
  if(action==='INSTALL'&&installed)return refusal('ALREADY_INSTALLED');
  if(action!=='INSTALL'&&!installed)return refusal('NOT_INSTALLED');
  if(dryRun!==false)return {state:'PROPOSED',action,automaticInstall:false,requiresOperatorExecution:true};
  busy=true;
  try {
   if(restoredRuntimeUnverified){
    if(typeof runtimeIdentity!=='string'||!runtimeIdentity.trim()||typeof adapter.reconcileOwnedRuntime!=='function'||await adapter.reconcileOwnedRuntime(runtimeIdentity)!==true)return refusal('OWNED_RUNTIME_UNKNOWN');
    restoredRuntimeUnverified=false;
   }
   if(action==='INSTALL'){installed=true;return {state:'INSTALLED',manifest:manifest()};}
   if(action==='START'){if(await invoke('start',manifest())!==true)return refusal('START_FAILED');running=true;drained=false;}
   if(action==='DRAIN'){if(await invoke('drain')!==true)return refusal('DRAIN_INCOMPLETE');if(await invoke('checkpoint')!==true)return refusal('CHECKPOINT_INCOMPLETE');drained=true;}
   if(action==='STOP'||action==='UNINSTALL'){if(running&&await invoke('stop')!==true)return refusal('STOP_FAILED');running=false;if(action==='UNINSTALL')installed=false;}
   if(action==='STANDARD_DEVICES'){current={...current,profile:'STANDARD_DEVICES'};}
   if(action==='ROLLBACK'){if(await invoke('rollback',cleanConfig(target))!==true){attention='ROLLBACK_FAILED';return {state:'ATTENTION',reason:attention,manifest:manifest()};}current=cleanConfig(target);}
   if(action==='UPDATE') {
    if(target.schemaVersion!==current.schemaVersion)return refusal('SCHEMA_MIGRATION_GATE_REQUIRED');
    const previous={...current};
    if(await invoke('canary',cleanConfig(target))!==true)return refusal('CANARY_FAILED');
    try{if(await invoke('switchVersion',cleanConfig(target))!==true||await invoke('verify',cleanConfig(target))!==true)throw new Error('VERIFY_FAILED');current=cleanConfig(target);drained=false;}
    catch{if(await invoke('rollback',previous)!==true){attention='ROLLBACK_FAILED';return {state:'ATTENTION',reason:attention,manifest:manifest()};}current=previous;return {state:'ROLLED_BACK',manifest:manifest()};}
   }
   return {state:action==='UNINSTALL'?'UNINSTALLED':action==='DRAIN'?'DRAINED':action==='STOP'?'STOPPED':action==='START'?'RUNNING':'READY',manifest:manifest()};
  }catch(error){attention=error.message?.startsWith('ADAPTER_REQUIRED_')?error.message:'LIFECYCLE_FAILED';return {state:'ATTENTION',reason:attention,manifest:manifest()};}finally{busy=false;}
 }
 return {execute,manifest};
}
export async function boundedHealthCheck(url,{timeoutMs=2000,fetchImpl=fetch}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>10000)return refusal('HEALTH_TIMEOUT_INVALID');
 try{const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash)return refusal('HEALTH_URL_INVALID');const response=await fetchImpl(url,{signal:AbortSignal.timeout(timeoutMs)});return {state:response.ok?'HEALTHY':'UNHEALTHY',status:response.status};}catch{return {state:'UNHEALTHY',reason:'HEALTH_UNAVAILABLE'};}
}
export function appendBoundedLog(records,event,{maxEntries=256,maxBytes=65536}={}){
 if(!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>4096||!Number.isInteger(maxBytes)||maxBytes<128||maxBytes>1048576)throw new Error('LOG_BOUND_INVALID');
 const safe={action:String(event.action||'').slice(0,32),state:String(event.state||'').slice(0,32),reason:String(event.reason||'').slice(0,80)};
 const result=[...records,safe].slice(-maxEntries);while(Buffer.byteLength(JSON.stringify(result))>maxBytes&&result.length)result.shift();return result;
}
