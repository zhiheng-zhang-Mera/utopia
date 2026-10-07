import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGovernanceService} from '../services/dev-gateway/governance.mjs';
import {draft} from './fixtures/dgx-case.mjs';
test('DGX007 governance case survives restart; immutable identity and bounded revisions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgx-service-'));try{
  let s=createGovernanceService({dir,readTask:()=>({state:'RUNNING'})});const r=s.create(draft());assert.equal(r.revision,1);assert.equal(r.process_capsule.L0.release_gate.state,'NOT_RUN');assert.throws(()=>s.create(draft()));
  s=createGovernanceService({dir,readTask:()=>({state:'RUNNING'})});assert.equal(s.inspect('case-1').revision,1);assert.equal(s.list().cases.length,1);
  assert.throws(()=>s.act('case-1',{action:'EXTEND_GRAPH',expected_revision:0,nodes:[],reason:'x',evidence_refs:['e:1']}));
  const r2=s.act('case-1',{action:'EXTEND_GRAPH',expected_revision:1,nodes:[],reason:'new evidence noted',evidence_refs:['e:1']});assert.equal(r2.revision,2);
  assert.throws(()=>s.act('case-1',{action:'SET_TASK_STATE',expected_revision:2}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('DGX007 missing upstream ports cannot fabricate assignments results or release',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgx-ports-'));try{
  const s=createGovernanceService({dir});s.create(draft());
  assert.throws(()=>s.act('case-1',{action:'ASSIGN',expected_revision:1,request:{}}),/CAPABILITY_FACTS_UNAVAILABLE/);
  assert.throws(()=>s.act('case-1',{action:'RESULT',expected_revision:1}),/PCF_726_UNAVAILABLE/);
  assert.throws(()=>s.act('case-1',{action:'FINAL_REVIEW',expected_revision:1}),/PARTICIPANT_RECEIPT_UNAVAILABLE/);
  const r=s.act('case-1',{action:'EVALUATE_RELEASE',expected_revision:1,input:{state:'PASS'}});assert.equal(r.process_capsule.L0.release_gate.state,'BLOCKED');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('DGX007 corrupt/unavailable governance storage is observable and isolated',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgx-bad-'));try{
  writeFileSync(join(dir,'case-1.json'),'malformed');const s=createGovernanceService({dir});assert.equal(s.list().health,'DEGRADED');assert.throws(()=>s.inspect('case-1'));
  writeFileSync(join(dir,'file'),'cannot be a directory');const broken=createGovernanceService({dir:join(dir,'file','governance')});assert.equal(broken.list().health,'UNAVAILABLE');assert.throws(()=>broken.create(draft()));
  assert.throws(()=>s.inspect('../escape'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
