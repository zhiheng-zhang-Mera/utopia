import { readdir,readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
for(const root of ['docs','evidence','data-records']){
 const zh=await readdir(root+'/zh-CN'),en=await readdir(root+'/en');assert.deepEqual(zh.sort(),en.sort(),root+' missing language pair');
 for(const name of zh){const a=await readFile(root+'/zh-CN/'+name,'utf8'),b=await readFile(root+'/en/'+name,'utf8');
 const facts=s=>[...s.matchAll(/^(?:FACT|STATUS|SHA|TASK_ID|PAIR_STATUS):.*$/gm)].map(m=>m[0]).sort();assert.deepEqual(facts(a),facts(b),root+'/'+name+' facts differ');}
 console.log(root+': PAIR_STATUS = SYNCHRONIZED');
}
