import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRouter,sendJson} from '../../shared/http.mjs';
import {defaultRuntimeDir} from '../../shared/atomic-store.mjs';
import {intent,prepareDraft} from './core/design/designer.mjs';
import {buildThemePackage,summarizeBuild} from './core/build/builder.mjs';

export const OBSERVATION_PRESET={viewport:{width:1280,height:800},safe_region:{x:0,y:0,width:1280,height:800},critical_regions:[{x:0,y:0,width:800,height:700}]};
export function createThemeBuilderRoom({runtimeDir=defaultRuntimeDir()}={}) {
 const sandbox=path.resolve(runtimeDir,'theme-builder-lab');let building=false;
 const handle=createRouter(['intent','plan','build'].map(operation=>({method:'POST',pattern:'/'+operation,handle:async({res,readJson})=>{
  const input=await readJson();if(typeof input.prompt!=='string'||input.prompt.length>2000||!['none','desktop'].includes(input.observation??'none'))return sendJson(res,400,{error:'INVALID_THEME_INPUT'});
  if(building)return sendJson(res,409,{error:'BUILD_IN_PROGRESS'});
  try{
   if(operation==='intent')return sendJson(res,200,intent(input.prompt));
   const observation=input.observation==='desktop'?OBSERVATION_PRESET:null,draft=prepareDraft({prompt:input.prompt,observation});
   if(operation==='plan')return sendJson(res,200,{observed:!!observation,degraded:draft.asset_plan.degraded,surface_plan:draft.surface_plan,overlay_plan:draft.overlay_plan,asset_plan:draft.asset_plan});
   building=true;fs.mkdirSync(sandbox,{recursive:true});
   if(input.injectFailure===true)draft.image_generator=async()=>{throw Error('Injected image failure for local acceptance');};
   const result=await buildThemePackage({draft,sandboxRoot:sandbox,outDir:path.join(sandbox,'package-'+randomUUID())});
   const summary=summarizeBuild(result,draft);
   // This disposable Room retains at most eight of its own generated packages.
   const packages=fs.readdirSync(sandbox,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^package-[0-9a-f-]{36}$/.test(e.name)).map(e=>({path:path.join(sandbox,e.name),time:fs.statSync(path.join(sandbox,e.name)).mtimeMs})).sort((a,b)=>b.time-a.time);
   for(const old of packages.slice(8))fs.rmSync(old.path,{recursive:true,force:true});
   sendJson(res,200,summary);
  }catch(error){sendJson(res,400,{ok:false,verdict:'HOLD',reason:error.message,globalThemeApply:false});}finally{building=false;}
 }})));
 return{id:'theme-builder-lab',handle};
}
