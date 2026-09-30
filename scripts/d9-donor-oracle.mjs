import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const root=path.resolve('.runtime/donors/d9');
fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({type:'commonjs'}));
const paths=['builder.js','designer.js','assets/planner.js','assets/generator.js','assets/processor.js','assets/validator.js','assets/fallback.js'];
const reused=['contract.js','surface.js','validator.js','asset-factory.js','png.js','color.js'];
const blobs=[...paths,...reused].map(file=>{
 const data=fs.readFileSync(path.join(root,file));
 return{file,role:paths.includes(file)?'NEW_D9':'REUSE_PROMOTED',gitBlob:crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'),sha256:crypto.createHash('sha256').update(data).digest('hex'),requires:[...data.toString().matchAll(/require\('([^']+)'\)/g)].map(m=>m[1])};
});
for(const row of blobs)for(const dep of row.requires){if(dep.startsWith('node:'))continue;const file=path.posix.normalize(path.posix.join(path.posix.dirname(row.file),dep+'.js'));if(![...paths,...reused].includes(file))throw Error('closure escaped: '+file);}
const expected=JSON.parse(fs.readFileSync('city/00-foundation/05-control-centre/theme-engine/tests/fixtures/d9-donor-oracle.json','utf8'));
for(const blob of blobs){if(expected.blobs.find(item=>item.file===blob.file)?.gitBlob!==blob.gitBlob)throw Error('Pinned donor blob mismatch: '+blob.file);}
const require=createRequire(path.join(root,'oracle.cjs'));
const designer=require('./designer.js'),planner=require('./assets/planner.js'),fallback=require('./assets/fallback.js'),png=require('./png.js'),processor=require('./assets/processor.js'),validator=require('./assets/validator.js');
const prompts=['blue research compact no persona','purple cyber neon assistant','green minimal static','银发助手，蓝色科研工作站，紧凑布局'];
const normalize=value=>JSON.parse(JSON.stringify(value, (key,v)=>['interpreted_at','generated_at','at'].includes(key)?'1970-01-01T00:00:00.000Z':v));
const vectors=prompts.map(prompt=>{const intent=designer.interpret(prompt),draft=designer.design({intent});return{prompt,intent:normalize(intent),tokens:draft.tokens,components:draft.components,plans:normalize({surface:planner.planSurfaces({intent}),assets:planner.planAssets({intent,design:draft}),overlay:planner.planOverlay({intent,design:draft})})};});
const pixelVectors=['wallpaper','panel_texture','hns_character'].map(kind=>{const spec={width:256,height:256,transparent:kind==='hns_character'},result=fallback.render({kind,spec,palette:{base:'#101724',accent:'#4d93f8'},seed:'d9-oracle'});const buffer=png.canvasToPng(result.canvas);return{kind,spec,sha256:crypto.createHash('sha256').update(buffer).digest('hex'),alpha:processor.alphaStats(result.canvas),bounds:processor.contentBounds(result.canvas),validation:validator.validate({kind,buffer,spec})};});
fs.writeFileSync('.runtime/d9-oracle.json',JSON.stringify({donor:'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b',blobs,vectors,pixelVectors},null,2)+'\n');
console.log(JSON.stringify({closure:'PASS',newFiles:paths.length,reusedFiles:reused.length,intentVectors:vectors.length,pixelVectors:pixelVectors.length,modelRefinementPresent:typeof designer.interpretWithModel==='function'}));
