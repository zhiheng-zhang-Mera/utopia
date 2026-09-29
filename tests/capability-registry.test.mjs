import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registry} from '../services/capability-bridge/registry.mjs';
import {invokeAdapter} from '../services/capability-bridge/adapters.mjs';
const load=()=>JSON.parse(readFileSync('city/CITY_IMPLEMENTATION_MANIFEST.json'));
const district=(m,id)=>m.districts.find(d=>d.id===id);
const documentBuilding=m=>district(m,'09-planning-knowledge').buildings.find(b=>b.id==='02-document-intake');
const intake=m=>registry(m).find(c=>c.capabilityId==='planning.document.intake');
// The fixtures below address districts by id and keep their counts relative to the
// current census: every City Mission that declares a new district or building would
// otherwise break them, as several already did.
const unbridged=m=>registry(m).filter(c=>c.inputKind==='unavailable');
test('qualified identities keep duplicate names independent and cannot replace missing dependencies',()=>{
 const m=load();const baseline=unbridged(m).length;
 district(m,'02-engineering').buildings.push({id:'other-building',modules:[{id:'document-readers',lifecycle:'PROMOTED'}]});
 const c=intake(m);assert.equal(c.moduleRefs.length,2);assert.deepEqual(c.moduleRefs[1],{districtId:'09-planning-knowledge',buildingId:'02-document-intake',moduleId:'document-readers'});
 const other=registry(m).filter(c=>c.inputKind==='unavailable'&&c.capabilityId==='city.02-engineering/other-building/document-readers');assert.equal(other.length,1);assert.equal(other[0].bridgeState,'BRIDGE_PENDING');
 assert.equal(unbridged(m).length,baseline+1,'a duplicate module name in another building adds exactly one capability, not zero');
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
 // 09-planning-knowledge has two buildings, so "a duplicate module name in a
 // second building" is genuinely exercised. Pointing this fixture at the LAST
 // district silently reduced it to a one-element set, which made the uniqueness
 // assertion below unable to fail — the exact weakening this repair undoes.
 const buildings=district(m,'09-planning-knowledge').buildings.length;
 assert.equal(buildings,2,'the fixture needs a district with two buildings for this property to be real');
 for(const b of district(m,'09-planning-knowledge').buildings)b.modules.push({id:'parser',lifecycle:'PROMOTED'});
 const added=unbridged(m).filter(c=>c.capabilityId.endsWith('/parser'));
 assert.equal(added.length,buildings);
 assert.equal(new Set(added.map(c=>c.capabilityId)).size,buildings,'a duplicate module name in a second building must not reuse the first qualified identity');
});
test('Theme advertises implemented generate and build operations and refuses validate',async()=>{
 assert.deepEqual(registry().find(c=>c.capabilityId==='presentation.theme.lab').operations,[{operationId:'generate'},{operationId:'build'}]);
 await assert.rejects(invokeAdapter('presentation.theme.lab','validate',{}),{code:'OPERATION_BLOCKED'});
});
test('infrastructure modules are never advertised as capabilities',()=>{
 const m=load();
 const core=district(m,'00-foundation');
 assert.equal(core.kind,'infrastructure','00-foundation is city infrastructure, not a domain district');
 const catalog=registry(m);
 for(const b of core.buildings)for(const mod of b.modules){
  assert.equal(catalog.some(c=>c.capabilityId==='city.00-foundation/'+b.id+'/'+mod.id),false,`${mod.id} must not appear as a capability`);
  assert.equal(catalog.some(c=>(c.moduleRefs??[]).some(r=>r.moduleId===mod.id)),false,`${mod.id} must not back a capability`);
 }
 assert.equal(catalog.filter(c=>c.bridgeState==='AVAILABLE').length,5,'the five domain adapters are unaffected');
});
