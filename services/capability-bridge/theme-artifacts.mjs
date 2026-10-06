import fs from 'node:fs';
import path from 'node:path';
const jobName=/^I-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Gateway-owned artifacts, bounded independently of retained invocation details.
 *
 * A STORE THE CITY CANNOT CREATE IS DEGRADED, NOT FATAL. This constructor used to call mkdirSync and realpathSync
 * unguarded, and it is reached from createBridge during City construction - so one file where `<runtime>/theme-packages`
 * belongs made createGateway throw EEXIST and the City never started (measured against merged main 213f9f9f, see
 * mission-book/reports/REX-PROGRAMME/DEFECT_RESEARCH_STORE_HARDENING.md). The theme lab is one capability; the City's
 * tasks, nodes and execution paths do not depend on it, so its storage failure must degrade that capability and nothing
 * else. The bridge already turns an `allocate` throw into the typed BUILD_STORAGE_UNAVAILABLE invocation failure, which
 * is exactly the behaviour this repair preserves.
 *
 * Two of the three entry points are deliberately asymmetric:
 * - `allocate` reports failure by THROWING, because a build with nowhere to put its package has not happened.
 * - `finish` reports failure by RECORDING it and returning, because by then the package exists and its digest is already
 *   computed. Throwing here would let a bookkeeping fault erase a real, verified result - the bridge's own catch turns
 *   any throw into BUILD_STORAGE_UNAVAILABLE, which would then be a lie about the build.
 * Either way the store flips to UNAVAILABLE, so health states the truth from the moment it is known rather than only
 * after a restart.
 */
export function createThemeArtifacts(root,{keep=8}={}) {
 root=path.resolve(root);
 let storeState='READY',storeReason=null;
 const degrade=error=>{storeState='UNAVAILABLE';storeReason=String(error?.code??error?.message??'THEME_ARTIFACT_STORE_UNAVAILABLE').slice(0,120);return storeReason;};
 const unavailable=()=>Object.assign(Error('BUILD_STORAGE_UNAVAILABLE'),{code:'BUILD_STORAGE_UNAVAILABLE',detail:storeReason});
 try{
  fs.mkdirSync(root,{recursive:true});
  if(fs.realpathSync(root)!==root)throw Object.assign(Error('THEME_ARTIFACT_ROOT_LINK'),{code:'THEME_ARTIFACT_ROOT_LINK'});
 }catch(error){degrade(error);}
 const active=new Set();
 const jobs=()=>fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&jobName.test(e.name));
 const remove=id=>{if(!jobName.test(id))throw Error('INVALID_ARTIFACT_ID');fs.rmSync(path.join(root,id),{recursive:true,force:true});};
 const prune=()=>{const completed=jobs().filter(e=>!active.has(e.name)).map(e=>({id:e.name,time:fs.statSync(path.join(root,e.name)).mtimeMs})).sort((a,b)=>b.time-a.time);for(const old of completed.slice(keep))remove(old.id);};
 // A root that was good when the City started can still stop being one - a hand edit, a foreign tool, a disk fault.
 // Construction-time bookkeeping therefore runs only while the root is known good, and is never allowed to take the
 // City down with it.
 if(storeState==='READY')try{
  // Completion survives pruning of unrelated invocation summaries.
  for(const job of jobs())if(!fs.existsSync(path.join(root,job.name,'.completed')))remove(job.name);
  prune();
 }catch(error){degrade(error);}
 return{
  state:()=>storeState,
  reason:()=>storeReason,
  allocate(id){if(storeState!=='READY')throw unavailable();if(!jobName.test(id))throw Error('INVALID_ARTIFACT_ID');const target=path.join(root,id);try{fs.mkdirSync(target);}catch(error){degrade(error);throw unavailable();}active.add(id);return target;},
  finish(id,success){active.delete(id);if(storeState!=='READY')return;try{if(!success)remove(id);else{fs.writeFileSync(path.join(root,id,'.completed'),'completed\n',{flag:'wx'});const now=new Date();fs.utimesSync(path.join(root,id),now,now);}prune();}catch(error){degrade(error);}}
 };
}
