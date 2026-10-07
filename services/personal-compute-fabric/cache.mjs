// Storage-backed bounded cache behavior lives in the authorized artifact adapter.
export {createArtifactStore as createBoundedCache} from './artifacts.mjs';
import {sha256} from './artifacts.mjs';
import {requireThat as ok,freeze} from './validation.mjs';
// Explicit caller-selected files only. This never walks, pulls, or copies a repository.
export function repositorySnapshotManifest({repository,commit,dirty=[]}){
 ok(typeof repository==='string'&&repository.length>0&&!/@/.test(repository)&&/^[a-f0-9]{40,64}$/.test(commit),'REPOSITORY_IDENTITY');
 const seen=new Set();const files=dirty.map(({path,bytes})=>{
  ok(typeof path==='string'&&path.length>0&&!/[:\\\u0000]/.test(path)&&!path.startsWith('/')&&path.split('/').every(p=>p&&p!=='.'&&p!=='..')&&!seen.has(path),'REPOSITORY_PATH');
  ok(!/(^|\/)(\.git|\.env[^/]*|\.ssh|credentials[^/]*|secrets?[^/]*)(\/|$)/i.test(path)&&! /\.(pem|key|p12|pfx)$/i.test(path),'REPOSITORY_SECRET');
  ok(Buffer.isBuffer(bytes),'REPOSITORY_CONTENT');seen.add(path);return {path,size:bytes.length,digest:sha256(bytes)};
 }).sort((a,b)=>a.path.localeCompare(b.path));
 const value={version:1,repository,commit,dirty:files};return freeze({...value,digest:sha256(JSON.stringify(value))});
}
