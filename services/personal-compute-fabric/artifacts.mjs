import {mkdir,writeFile,readFile,rename,unlink,stat} from 'node:fs/promises';import {resolve,join} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {requireThat as ok,finite,text,copy,freeze} from './validation.mjs';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
// Explicit storage adapter; digest is integrity, authorize() is permission. No caller-controlled path.
export function createArtifactStore({root,maxBytes,maxItems,authorize}){
 ok(text(root)&&finite(maxBytes)&&maxBytes>0&&Number.isInteger(maxItems)&&maxItems>0&&typeof authorize==='function','ARTIFACT_CONFIG');const base=resolve(root);let tail=Promise.resolve();
 const exclusive=fn=>{const p=tail.then(fn);tail=p.catch(()=>{});return p;};
 const indexPath=join(base,'index.json');const index=async()=>{try{return JSON.parse(await readFile(indexPath,'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw e;}};
 const putIndex=async entries=>{const temp=join(base,randomUUID()+'.index.tmp');await writeFile(temp,JSON.stringify(entries),{flag:'wx'});await rename(temp,indexPath);};
 const path=id=>{ok(typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id),'OPAQUE_ARTIFACT_ID_REQUIRED');return join(base,id+'.blob');};
 return {
  publish(bytes,metadata,now){return exclusive(async()=>{ok(Buffer.isBuffer(bytes)&&bytes.length<=maxBytes,'ARTIFACT_LIMIT');ok(Object.keys(metadata).every(k=>['owner','dataScope','expiresAt','schema'].includes(k)),'ARTIFACT_METADATA_KEY');ok(text(metadata.owner)&&text(metadata.dataScope)&&finite(metadata.expiresAt)&&metadata.expiresAt>now,'ARTIFACT_METADATA');ok(await authorize({operation:'PUBLISH',metadata:copy(metadata),now}),'ARTIFACT_UNAUTHORIZED');await mkdir(base,{recursive:true});const entries=await index();ok(entries.length<maxItems&&entries.reduce((n,e)=>n+e.size,0)+bytes.length<=maxBytes,'CACHE_QUOTA');const ref={...copy(metadata),version:1,id:randomUUID(),digest:sha256(bytes),size:bytes.length};const target=path(ref.id),temp=target+'.partial';await writeFile(temp,bytes,{flag:'wx'});await rename(temp,target);try{await putIndex([...entries,ref]);}catch(e){await unlink(target);throw e;}return freeze(ref);});},
  async read(ref,context,now){path(ref.id);const entries=await index(),stored=entries.find(x=>x.id===ref.id);ok(stored&&stored.digest===ref.digest&&stored.size===ref.size,'ARTIFACT_UNKNOWN');ok(now<stored.expiresAt&&await authorize({operation:'READ',metadata:copy(stored),context:copy(context),now}),'ARTIFACT_UNAUTHORIZED_OR_EXPIRED');const info=await stat(path(stored.id));ok(info.size===stored.size&&info.size<=maxBytes,'ARTIFACT_SIZE');const bytes=await readFile(path(stored.id));ok(sha256(bytes)===stored.digest,'ARTIFACT_DIGEST');return bytes;},
  invalidate(id,context,now){return exclusive(async()=>{const entries=await index(),stored=entries.find(x=>x.id===id);ok(stored&&await authorize({operation:'DELETE',metadata:copy(stored),context:copy(context),now}),'ARTIFACT_UNAUTHORIZED');await unlink(path(id));await putIndex(entries.filter(x=>x.id!==id));return true;});},
 };
}
