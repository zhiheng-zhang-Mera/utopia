import { FilesystemAdapter } from '../../platform/windows/filesystem.mjs';
import { executeTask } from './runner.mjs';
import { platform,release,arch,hostname,version as osVersion } from 'node:os';
import { createTelemetrySampler } from './telemetry.mjs';
import { platformFacts } from '../../services/dev-gateway/platform-facts.mjs';
export async function startAgent({url,token,workspace='.runtime/workspace',id='host-'+hostname().replace(/[^a-zA-Z0-9-]/g,'-'),displayName=hostname(),interval=1000,stepDelay=1200,telemetryEnabled=process.env.CITY_TELEMETRY_DISABLED!=='1',credentialProvider=null}){
 const telemetry=createTelemetrySampler({enabled:telemetryEnabled});await telemetry.start();
 let stopped=false,busy=false,timer,active=Promise.resolve(),pending=null;
 const api=async(path,data)=>{const credential=credentialProvider?await credentialProvider():token;const r=await fetch(url+'/api/v0/node/'+path,{method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:JSON.stringify(data),signal:AbortSignal.timeout(4000)});const body=await r.json();if(!r.ok)throw new Error(body.error);if(body.apiVersion!==0||body.schemaVersion!==0)throw new Error('Protocol mismatch');return body;};
 const metrics=()=>({agentVersion:'0.2.0',telemetry:telemetry.latest()});
 // The owner's requirement: confirming a machine when it joins includes its OPERATING SYSTEM and version, not only
 // its hardware. `platform()` alone is Node's internal token ("win32") and cannot tell Windows 11 from Windows 10, so
 // the full fact set (name, release, architecture, hostname, runtime) travels with registration.
 const facts=()=>platformFacts({os:{platform,release,arch,hostname,version:osVersion}});
 const register=()=>api('register',{id,displayName,metadata:facts(),capabilities:['task.execute.safe','filesystem.temp'],...metrics()});
 const tick=async()=>{
  if(stopped)return;
  try{try{await api('heartbeat',{id,...metrics()});}catch{await register();}
   if(pending){await api('report',pending);pending=null;}
   if(!busy){const {task}=await api('claim',{id});if(task){busy=true;active=executeTask(task,new FilesystemAdapter(workspace),patch=>api('report',{id,taskId:task.id,...patch}),stepDelay).then(failure=>{if(failure)pending={id,taskId:task.id,...failure};}).finally(()=>{busy=false;});}}
  }catch{/* Retry on next heartbeat; no tight retry loop. */}
  if(!stopped)timer=setTimeout(tick,interval);
 };
 try{await register();await tick();}catch(error){telemetry.stop();throw error;}
 return {stop:async()=>{stopped=true;clearTimeout(timer);telemetry.stop();await active;}};
}
