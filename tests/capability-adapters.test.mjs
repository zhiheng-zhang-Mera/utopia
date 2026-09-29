import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeAdapter} from '../services/capability-bridge/adapters.mjs';
import {registry} from '../services/capability-bridge/registry.mjs';
import {digest} from '../contracts/capability-bridge-v1/protocol.mjs';
import {buildSample} from '../city/09-planning-knowledge/02-document-intake/document-readers/samples.mjs';
import {buildTar} from '../city/02-engineering/02-worker-gateway/skill-intake/tests/fixtures.mjs';
const run=(id,op,input)=>invokeAdapter(id,op,input);
test('document bytes flow through real readers and into temporary knowledge',async()=>{
 for(const ext of ['txt','json','yaml','docx','xlsx','pdf']){
  const bytes=['docx','xlsx','pdf'].includes(ext)?(await buildSample(ext)).bytes:Buffer.from(ext==='json'?'{"city":"Utopia"}':ext==='yaml'?'city: Utopia':'Utopia document');
  const input={fileName:'sample.'+ext,base64:Buffer.from(bytes).toString('base64')};
  const a=await run('planning.document.intake','read',input),b=await run('planning.document.intake','read',input);
  assert.ok(a.sections.length,ext);assert.equal(digest(a),digest(b),ext);
  const k=await run('planning.knowledge.query','fromDocument',{document:a,query:'Utopia'});assert.ok(k.matches.length);assert.equal(k.temporary,true);
 }
});
test('evidence review is deterministic and tampering never gets rehashed',async()=>{
 const input={sample:true};const a=await run('research.evidence.review','review',input),b=await run('research.evidence.review','review',input);
 assert.equal(digest(a),digest(b));assert.ok(a.bundle.integrityRoot);assert.equal(a.bundle.decision,'PASS');
 await assert.rejects(run('research.evidence.review','tamper',input),{code:'ARTIFACT_HASH_MISMATCH'});
 await assert.rejects(run('research.evidence.review','review',{artifacts:[]}),{code:'TASK_REQUIRED'});
});
test('theme generation returns a reproducible PNG and validation',async()=>{
 const a=await run('presentation.theme.lab','generate',{seed:'same'}),b=await run('presentation.theme.lab','generate',{seed:'same'});
 assert.equal(digest(a),digest(b));assert.equal(Buffer.from(a.previewPngBase64,'base64').subarray(1,4).toString(),'PNG');assert.equal(a.globalApply,false);
});
test('future promoted module stays pending and all five existing adapters still execute',async()=>{
 const manifest=JSON.parse(readFileSync('city/CITY_IMPLEMENTATION_MANIFEST.json'));
 // 02-engineering is a domain district, so the fixture module lands in the
 // described catalog rather than in the filtered-out infrastructure kernel. The
 // total descriptor count is stated relative to the current census only: an
 // absolute count is exactly what broke on three Missions, because every newly
 // declared module adds a descriptor. The adapter invariants stay absolute.
 const baseline=registry(manifest);
 manifest.districts.find(d=>d.id==='02-engineering').buildings[0].modules.push({id:'future',en:'Future',lifecycle:'PROMOTED'});
 const catalog=registry(manifest);
 assert.equal(catalog.find(x=>x.moduleRefs?.[0]?.moduleId==='future').bridgeState,'BRIDGE_PENDING');
 assert.equal(catalog.length,baseline.length+1,'exactly one descriptor is added, and it is the future module');
 assert.equal(catalog.filter(c=>c.bridgeState==='AVAILABLE').length,5,'the five existing adapters are unaffected');
 assert.equal(catalog.filter(c=>c.bridgeState==='AVAILABLE').length,baseline.filter(c=>c.bridgeState==='AVAILABLE').length);
 assert.equal(catalog.filter(c=>c.bridgeState==='AVAILABLE').length,baseline.filter(c=>c.bridgeState==='AVAILABLE').length);
 const inputs={document:{fileName:'sample.txt',base64:Buffer.from('Utopia').toString('base64')},knowledge:{entries:[],query:'Utopia'},skill:{ref:'owner/repo'},evidence:{sample:true},theme:{seed:'future-module-check'}};for(const descriptor of catalog.filter(c=>c.bridgeState==='AVAILABLE'))assert.ok(await invokeAdapter(descriptor.capabilityId,descriptor.operations[0].operationId,inputs[descriptor.inputKind]));
});
test('malformed and oversized inputs have explicit refusals',async()=>{
 await assert.rejects(run('planning.document.intake','read',{fileName:'bad.json',base64:Buffer.from('{').toString('base64')}));
 await assert.rejects(run('planning.document.intake','read',{fileName:'large.txt',base64:Buffer.alloc(1024*1024+1).toString('base64')}),{code:'INPUT_TOO_LARGE'});
 await assert.rejects(run('engineering.skill.inspect','inspect',{ref:'owner/repo@main/../../escape'}),{code:'INVALID_REFERENCE'});
 await assert.rejects(run('engineering.skill.inspect','archive',{base64:buildTar([{path:'../../escape',data:Buffer.from('x')},{path:'safe.txt',data:Buffer.from('safe')}]).toString('base64')}),{code:'UNSAFE_ARCHIVE'});
});
