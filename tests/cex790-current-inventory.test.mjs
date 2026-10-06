import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

test('CEX790 current audit includes reversed routes, owner controls, catalogs and branch-scoped YAML candidates',()=>{
 const dir=mkdtempSync(resolve('.scratch-cex790-'));
 try {
  const records=join(dir,'capability-registry/records');mkdirSync(records,{recursive:true});
  writeFileSync(join(records,'candidate.yaml'),'capability_id: CAP-FUTURE-001\nimplementation:\n  paths: [does-not-exist.mjs]\n  api_or_actions: [GET /api/v0/future]\nstatus:\n  implementation_status: CANDIDATE\nexposure:\n  class: DIRECT_CONTROL\n');
  const git=args=>execFileSync('git',['-C',dir,...args],{stdio:'pipe'});
  git(['init']);git(['add','.']);git(['-c','user.name=Audit Fixture','-c','user.email=audit@example.invalid','commit','-m','audit fixture']);
  const output=join(dir,'output');const historical=readFileSync('evidence/raw/mission-book/CEX-790/capability-inventory.json');
  const run=()=>spawnSync(process.execPath,['scripts/cex790-inventory.mjs'],{encoding:'utf8',env:{...process.env,CEX790_REGISTRY_ROOT:dir,CEX790_OUTPUT_DIR:output}});
  const ok=run();assert.equal(ok.status,0,ok.stderr);
  const inventory=JSON.parse(readFileSync(join(output,'capability-inventory.json')));
  const item=id=>inventory.items.find(i=>i.id===id);
  assert.ok(item('GET /api/v0/research/experiments'));assert.ok(item('POST /api/v0/research/experiments'));
  for(const id of ['GET /api/v0/join/requests','POST /api/v0/join/requests/:id/approve','POST /api/v0/node/sharing']) assert.notEqual(item(id)?.class,'INTERNAL_PROTOCOL',id);
  assert.equal(item('WS /api/v0/relay').class,'INTERNAL_TRANSPORT');
  assert.equal(item('GENERAL_AI').class,'FUTURE_PRODUCT_INTEGRATION');
  assert.equal(item('CAP-FUTURE-001').class,'FUTURE_PRODUCT_INTEGRATION');
  assert.equal(inventory.sources.ask_target,16);assert.equal(inventory.sources.room_catalog,20);
  assert.match(inventory.baseline,/^[a-f0-9]{40}$/);assert.match(inventory.source_hashes['services/dev-gateway/server.mjs'],/^[a-f0-9]{64}$/);
  assert.deepEqual(readFileSync('evidence/raw/mission-book/CEX-790/capability-inventory.json'),historical);
  writeFileSync(join(records,'duplicate.yaml'),'capability_id: CAP-ONE-001\ncapability_id: CAP-TWO-001\nexposure:\n  class: DIRECT_CONTROL\n');
  const invalid=run();assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/unique|duplicate/i);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
