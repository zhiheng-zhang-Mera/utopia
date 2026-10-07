import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
const script=readFileSync(new URL('../scripts/verify-dgx-series.mjs',import.meta.url));
function fixture(body){
 const parent=mkdtempSync(join(tmpdir(),'dgx-runner-')),root=join(parent,'source');mkdirSync(root);
 for(const dir of ['scripts','tests','contracts/deliberative-governance-v2'])mkdirSync(join(root,dir),{recursive:true});
 writeFileSync(join(root,'scripts/verify-dgx-series.mjs'),script);
 writeFileSync(join(root,'tests/pcf726-capsule.test.mjs'),`import test from 'node:test';import assert from 'node:assert/strict';test('actual registered test',()=>{${body}});`);
 writeFileSync(join(root,'contracts/deliberative-governance-v2/acceptance-matrix.json'),JSON.stringify({scenarios:Array.from({length:13},(_,i)=>({scenario:i+1,tests:['tests/pcf726-capsule.test.mjs']}))}));
 const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 git('init','-b','Alien-GPT-DGX');git('config','user.email','fixture@example.invalid');git('config','user.name','DGX fixture');git('add','.');git('commit','-m','fixture');
 const sha=git('rev-parse','HEAD'),out=join(parent,'evidence');
 return {parent,root,sha,out,run(){return spawnSync(process.execPath,['scripts/verify-dgx-series.mjs','--expected-sha',sha,'--out',out],{cwd:root,encoding:'utf8',timeout:30000,env:{...process.env,NODE_TEST_CONTEXT:'child-v8'}});},cleanup(){assert.equal(dirname(resolve(parent)),resolve(tmpdir()));rmSync(parent,{recursive:true,force:true});}};
}
test('DGX whole-series runner executes failing child tests despite inherited Node test context',()=>{
 const f=fixture(`assert.fail('registered failure must execute');`);try{const r=f.run();assert.equal(r.status,1,r.stdout+r.stderr);const receipt=JSON.parse(readFileSync(join(f.out,'SERIES_EVIDENCE.json'),'utf8'));assert.equal(receipt.result,'FAIL');assert.match(readFileSync(join(f.out,'tests.txt'),'utf8'),/registered failure must execute/);}finally{f.cleanup();}
});
test('DGX whole-series runner records positive executed test count with inherited context cleared',()=>{
 const f=fixture('assert.equal(1,1);');try{const r=f.run();assert.equal(r.status,0,r.stdout+r.stderr);const receipt=JSON.parse(readFileSync(join(f.out,'SERIES_EVIDENCE.json'),'utf8'));assert.equal(receipt.executed_tests,1);assert.equal(receipt.result,'PASS');}finally{f.cleanup();}
});
