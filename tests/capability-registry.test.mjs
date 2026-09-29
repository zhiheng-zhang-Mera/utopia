import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registry} from '../services/capability-bridge/registry.mjs';
import {invokeAdapter} from '../services/capability-bridge/adapters.mjs';
const load=()=>JSON.parse(readFileSync('city/CITY_IMPLEMENTATION_MANIFEST.json'));
const documentBuilding=m=>m.districts.find(d=>d.id==='09-planning-knowledge').buildings.find(b=>b.id==='02-document-intake');
const intake=m=>registry(m).find(c=>c.capabilityId==='planning.document.intake');
const unbridged=m=>registry(m).filter(c=>c.inputKind==='unavailable');
test('qualified identities keep duplicate names independent and cannot replace missing dependencies',()=>{
 // The last district is used rather than the first so the fixture does not
 // depend on which district happens to sort first in the manifest census.
 const m=load();const baseline=unbridged(m).length;
 m.districts.at(-1).buildings.push({id:'other-building',modules:[{id:'document-readers',lifecycle:'PROMOTED'}]});
 const c=intake(m);assert.equal(c.moduleRefs.length,2);assert.deepEqual(c.moduleRefs[1],{districtId:'09-planning-knowledge',buildingId:'02-document-intake',moduleId:'document-readers'});
 const other=unbridged(m);assert.equal(other.length,baseline+1);assert.equal(other.at(-1).bridgeState,'BRIDGE_PENDING');
 documentBuilding(m).modules.pop();assert.equal(intake(m).bridgeState,'DEGRADED');
});
test('registry restricts mixed module lifecycle and exposes every dependency lifecycle',()=>{
 for(const [lifecycle,expected] of [['PLANNED','BRIDGE_PENDING'],['INCUBATING','BRIDGE_PENDING'],['PROMOTED','AVAILABLE'],['ACTIVE','AVAILABLE'],['DEPRECATED','UNAVAILABLE'],['UNKNOWN','DEGRADED']]){
  const m=load();documentBuilding(m).modules[0].lifecycle='PROMOTED';documentBuilding(m).modules[1].lifecycle=lifecycle;const c=intake(m);
  assert.equal(c.bridgeState,expected,lifecycle);assert.deepEqual(c.moduleLifecycles.map(x=>x.lifecycle),['PROMOTED',lifecycle]);
  assert.equal(c.cityLifecycle,lifecycle==='PROMOTED'?'PROMOTED':'MIXED');
 }
});
test('unbridged duplicate module names receive different qualified capability IDs',()=>{
 const m=load();
 const buildings=m.districts[2].buildings.length;
 for(const b of m.districts[2].buildings)b.modules.push({id:'parser',lifecycle:'PROMOTED'});
 const added=unbridged(m).filter(c=>c.capabilityId.endsWith('/parser'));
 assert.equal(added.length,buildings);
 assert.equal(new Set(added.map(c=>c.capabilityId)).size,buildings,'a duplicate module name in a second building must not reuse the first qualified identity');
});
test('Theme advertises implemented generate and build operations and refuses validate',async()=>{
 assert.deepEqual(registry().find(c=>c.capabilityId==='presentation.theme.lab').operations,[{operationId:'generate'},{operationId:'build'}]);
 await assert.rejects(invokeAdapter('presentation.theme.lab','validate',{}),{code:'OPERATION_BLOCKED'});
});
