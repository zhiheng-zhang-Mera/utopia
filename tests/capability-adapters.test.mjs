import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeAdapter} from '../services/capability-bridge/adapters.mjs';
import {registry} from '../services/capability-bridge/registry.mjs';
import {digest} from '../contracts/capability-bridge-v1/protocol.mjs';
import {buildSample} from '../city/09-planning-knowledge/02-document-intake/document-readers/samples.mjs';
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
});
test('theme generation returns a reproducible PNG and validation',async()=>{
 const a=await run('presentation.theme.lab','generate',{seed:'same'}),b=await run('presentation.theme.lab','generate',{seed:'same'});
 assert.equal(digest(a),digest(b));assert.equal(Buffer.from(a.previewPngBase64,'base64').subarray(1,4).toString(),'PNG');assert.equal(a.globalApply,false);
});
test('future promoted module stays pending and does not hide existing adapters',()=>{
 const catalog=registry({districts:[{buildings:[{modules:[{id:'future',en:'Future',lifecycle:'PROMOTED'}]}]}]});
 assert.equal(catalog.find(x=>x.capabilityId==='city.future').bridgeState,'BRIDGE_PENDING');assert.equal(catalog.length,6);
});
test('malformed and oversized inputs have explicit refusals',async()=>{
 await assert.rejects(run('planning.document.intake','read',{fileName:'bad.json',base64:Buffer.from('{').toString('base64')}));
 await assert.rejects(run('planning.document.intake','read',{fileName:'large.txt',base64:Buffer.alloc(1024*1024+1).toString('base64')}),{code:'INPUT_TOO_LARGE'});
 await assert.rejects(run('engineering.skill.inspect','inspect',{ref:'owner/repo@main/../../escape'}),{code:'INVALID_REFERENCE'});
});
