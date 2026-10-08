import { readdir,readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
// THE CONTRACT IS OVER THE WHOLE TREE, NOT ONE LEVEL OF IT. This check used to readdir each language directory and
// read every entry as a file, which silently assumed a flat layout. PCF-700's workbook declares its deliverable at
// docs/{zh-CN,en}/pcf/ownership-map.md, so the first nested pair made the flat read fail with EISDIR (measured in
// hosted CI run 37497553367, step `pnpm check:docs`) instead of checking anything. Relocating the deliverable away
// from its declared path would have been the other option, but the check is the thing that was wrong: a paired
// translation is paired wherever it sits. The path lists are still compared EXACTLY, so a file present in one
// language only - or under a different nested name - fails as before. Empty directories are not part of the contract.
const walk=async(dir,prefix='')=>{
 const out=[];
 for(const item of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
  const rel=prefix+item.name;
  if(item.isDirectory()) out.push(...await walk(dir+'/'+item.name,rel+'/'));
  else out.push(rel);
 }
 return out;
};
for(const root of ['docs','evidence','data-records']){
 const zh=await walk(root+'/zh-CN'),en=await walk(root+'/en');assert.deepEqual(zh,en,root+' missing language pair');
 for(const name of zh){const a=await readFile(root+'/zh-CN/'+name,'utf8'),b=await readFile(root+'/en/'+name,'utf8');
 const facts=s=>[...s.matchAll(/^(?:FACT|STATUS|SHA|CODE-SHA|CLAIM-ID|RUNS|TASK_ID|PAIR_STATUS):.*$/gm)].map(m=>m[0]).sort();assert.deepEqual(facts(a),facts(b),root+'/'+name+' facts differ');}
 console.log(root+': PAIR_STATUS = SYNCHRONIZED');
}
