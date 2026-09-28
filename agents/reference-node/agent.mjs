import { FilesystemAdapter } from '../../platform/windows/filesystem.mjs';
import { executeTask } from './runner.mjs';
import { platform } from 'node:os';
export async function startAgent({url,token,workspace='.runtime/workspace',id='alien-reference-node',displayName='Alien-PC',interval=1000,stepDelay=1200}){
 let stopped=false,busy=false,timer,active=Promise.resolve();
 const api=async(path,data)=>{const r=await fetch(url+'/api/v0/node/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:JSON.stringify(data),signal:AbortSignal.timeout(4000)});const body=await r.json();if(!r.ok)throw new Error(body.error);if(body.apiVersion!==0||body.schemaVersion!==0)throw new Error('Protocol mismatch');return body;};
 const register=()=>api('register',{id,displayName,metadata:{platform:platform()},capabilities:['task.execute.safe','filesystem.temp']});
 const tick=async()=>{
  if(stopped)return;
  try{try{await api('heartbeat',{id});}catch{await register();}
   if(!busy){const {task}=await api('claim',{id});if(task){busy=true;active=executeTask(task,new FilesystemAdapter(workspace),patch=>api('report',{id,taskId:task.id,...patch}),stepDelay).finally(()=>{busy=false;});}}
  }catch{/* Retry on next heartbeat; no tight retry loop. */}
  if(!stopped)timer=setTimeout(tick,interval);
 };
 await register();await tick();
 return {stop:async()=>{stopped=true;clearTimeout(timer);await active;}};
}
