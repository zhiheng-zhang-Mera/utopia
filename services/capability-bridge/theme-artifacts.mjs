import fs from 'node:fs';
import path from 'node:path';
const jobName=/^I-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Gateway-owned artifacts, bounded independently of retained invocation details. */
export function createThemeArtifacts(root,{keep=8}={}) {
 root=path.resolve(root);fs.mkdirSync(root,{recursive:true});
 if(fs.realpathSync(root)!==root)throw Error('THEME_ARTIFACT_ROOT_LINK');
 const active=new Set();
 const jobs=()=>fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&jobName.test(e.name));
 const remove=id=>{if(!jobName.test(id))throw Error('INVALID_ARTIFACT_ID');fs.rmSync(path.join(root,id),{recursive:true,force:true});};
 const prune=()=>{const completed=jobs().filter(e=>!active.has(e.name)).map(e=>({id:e.name,time:fs.statSync(path.join(root,e.name)).mtimeMs})).sort((a,b)=>b.time-a.time);for(const old of completed.slice(keep))remove(old.id);};
 // Completion survives pruning of unrelated invocation summaries.
 for(const job of jobs())if(!fs.existsSync(path.join(root,job.name,'.completed')))remove(job.name);
 prune();
 return{
  allocate(id){if(!jobName.test(id))throw Error('INVALID_ARTIFACT_ID');const target=path.join(root,id);fs.mkdirSync(target);active.add(id);return target;},
  finish(id,success){active.delete(id);if(!success)remove(id);else{fs.writeFileSync(path.join(root,id,'.completed'),'completed\n',{flag:'wx'});const now=new Date();fs.utimesSync(path.join(root,id),now,now);}prune();}
 };
}
