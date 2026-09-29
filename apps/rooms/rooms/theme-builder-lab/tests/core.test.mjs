import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {intent,design,prepareDraft} from '../core/design/designer.mjs';
import {createAssetGenerator} from '../core/assets/pipeline/generator.mjs';
import {render} from '../core/assets/pipeline/fallback.mjs';
import {validate,validateBundle} from '../core/assets/pipeline/validator.mjs';
import {alphaStats,contentBounds} from '../core/assets/pipeline/processor.mjs';
import {buildThemePackage} from '../core/build/builder.mjs';
import * as png from '../../../../../city/11-entertainment/01-entertainment-centre/theme-engine/raster/png.mjs';

const observation={viewport:{width:800,height:600},safe_region:{x:0,y:0,width:800,height:600},critical_regions:[{x:300,y:0,width:500,height:600}]};
const entry={kind:'wallpaper',surface:'owned_surface',width:256,height:256,transparent:false,path:'assets/wallpapers/wallpaper.png'};
const pixel=()=>{const canvas=png.createCanvas(256,256);for(let i=0;i<canvas.data.length;i+=4){canvas.data[i]=(i*19)%253;canvas.data[i+1]=(i/4)%251;canvas.data[i+2]=Math.floor(i/1024)%249;canvas.data[i+3]=255;}return png.canvasToPng(canvas);};
const sandbox=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'utopia-d9-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};

test('same prompt gives byte-stable offline intent; explicit styles change the design',()=>{
 assert.deepEqual(intent('blue research compact'),intent('blue research compact'));
 assert.equal(intent('purple cyber').design_language,'cyber_hud');
 assert.equal(intent('green minimal static').design_language,'minimal_neutral');
 assert.equal(design({intent:intent('blue research')}).palette,'steel_blue');
});
test('observation bounds and critical regions constrain placement; missing observation is truthful',()=>{
 const observed=prepareDraft({prompt:'blue anime assistant',observation});
 assert.equal(observed.asset_plan.degraded,false);
 for(const asset of observed.asset_plan.asset_plan.filter(a=>a.position)){
  const box=asset.position.box;assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=800&&box.y+box.height<=600);
  assert.ok(box.x+box.width<=300,'placement must avoid the critical region');
 }
 const unknown=prepareDraft({prompt:'blue assistant'});assert.equal(unknown.asset_plan.degraded,true);assert.equal(unknown.surface_plan.degraded,true);
 assert.equal(unknown.surface_plan.surfaces.find(s=>s.surface==='protected_external_surface').writes,false);
});
test('procedural pixels are deterministic and character alpha has real content bounds',()=>{
 const options={kind:'surface_character',palette:{base:'#101724',accent:'#4d93f8'},spec:{width:256,height:256,transparent:true},seed:'stable'};
 const a=render(options).canvas,b=render(options).canvas;
 assert.deepEqual(png.canvasToPng(a),png.canvasToPng(b));assert.ok(alphaStats(a).transparentRatio>0.05);assert.ok(contentBounds(a));
 assert.equal(validate({kind:options.kind,buffer:png.canvasToPng(a),spec:options.spec}).ok,true);
});
test('valid injected image is measured and accepted; bad image retries then falls back',async()=>{
 let calls=0;const good=await createAssetGenerator({imageGenerator:async()=>pixel()}).generate({entry});
 assert.equal(good.disabled,false);assert.equal(good.provenance,'image-model');assert.equal(good.validation.ok,true);
 const bad=await createAssetGenerator({imageGenerator:async()=>{calls++;return Buffer.from('invalid');},retries:1}).generate({entry});
 assert.equal(calls,2);assert.equal(bad.disabled,false);assert.equal(bad.provenance,'procedural-fallback');assert.equal(bad.degraded,true);
});
test('timeout retries and falls back; invalid fallback disables only its asset',async()=>{
 let calls=0;const generator=createAssetGenerator({imageGenerator:()=>{calls++;return new Promise(()=>{});},timeoutMs:10,retries:1});
 const result=await generator.generate({entry});assert.equal(calls,2);assert.equal(result.provenance,'procedural-fallback');
 const isolated=createAssetGenerator({fallbackRenderer:options=>options.kind==='wallpaper'?{canvas:png.createCanvas(256,256)}:render(options)});
 assert.equal((await isolated.generate({entry})).disabled,true);
 assert.equal((await isolated.generate({entry:{kind:'surface_character',surface:'owned_surface',width:256,height:256,transparent:true},palette:{base:'#101724',accent:'#4d93f8'}})).disabled,false);
});
test('pixel-invalid image falls back and protected surface never calls an image generator',async()=>{
 let calls=0;const flat=png.createCanvas(256,256);flat.data.fill(255);
 const generator=createAssetGenerator({imageGenerator:async()=>{calls++;return Buffer.concat([png.canvasToPng(flat),Buffer.alloc(3000)]);},retries:0});
 const fallback=await generator.generate({entry});assert.equal(fallback.provenance,'procedural-fallback');assert.equal(fallback.disabled,false);
 assert.ok(generator.history().some(row=>row.outcome==='model_pixels_rejected'));
 const before=calls,refused=await generator.generate({entry:{...entry,surface:'protected_external_surface'}});assert.equal(refused.disabled,true);assert.equal(calls,before);
});
test('pixel validator refuses opaque characters, flat images, dimension drift and budgets',()=>{
 const buffer=pixel();assert.equal(validate({kind:'surface_character',buffer,spec:{width:256,height:256,transparent:true}}).ok,false);
 assert.equal(validate({kind:'wallpaper',buffer,spec:{width:1000,height:1000}}).ok,false);
 assert.equal(validateBundle({assets:[{kind:'wallpaper',buffer,spec:entry}],maxBytes:10}).ok,false);
});
test('builder validates then atomically publishes a stable self-contained sandbox package',async t=>{
 const root=sandbox(t),draft=prepareDraft({prompt:'blue research compact no persona',observation});
 const a=await buildThemePackage({draft,outDir:path.join(root,'one'),sandboxRoot:root});
 assert.equal(a.ok,true,JSON.stringify(a.issues));assert.equal(a.validation.ok,true);assert.ok(fs.existsSync(path.join(root,'one','preview.png')));
 const b=await buildThemePackage({draft,outDir:path.join(root,'two'),sandboxRoot:root});assert.equal(b.ok,true,JSON.stringify(b.issues));assert.equal(a.packageDigest,b.packageDigest);
 assert.ok(fs.readdirSync(root).every(n=>!n.startsWith('.build-')));
});
test('builder refuses escape, existing output, protected writes, excess overlay and partial failure',async t=>{
 const root=sandbox(t),draft=prepareDraft({prompt:'blue research'});
 assert.equal((await buildThemePackage({draft,outDir:path.resolve(root,'../escape'),sandboxRoot:root})).ok,false);
 fs.mkdirSync(path.join(root,'existing'));fs.writeFileSync(path.join(root,'existing','keep.txt'),'keep');
 assert.equal((await buildThemePackage({draft,outDir:path.join(root,'existing'),sandboxRoot:root})).ok,false);assert.equal(fs.readFileSync(path.join(root,'existing','keep.txt'),'utf8'),'keep');
 for(const [name,mutate] of [['protected',d=>{d.surface_plan.surfaces.find(s=>s.protected).writes=true;}],['overlay',d=>{d.overlay_plan.components.global_tint.opacity=0.99;}],['escape-asset',d=>{d.asset_plan.asset_plan[0].path='../outside.png';}]]){
  const invalid=structuredClone(draft);mutate(invalid);const result=await buildThemePackage({draft:invalid,outDir:path.join(root,name),sandboxRoot:root});assert.equal(result.ok,false,name);assert.equal(fs.existsSync(path.join(root,name)),false);
 }
 const invalid=structuredClone(draft);invalid.tokens['color.label.primary']='#000000';
 const result=await buildThemePackage({draft:invalid,outDir:path.join(root,'invalid'),sandboxRoot:root});assert.equal(result.ok,false);assert.equal(fs.existsSync(path.join(root,'invalid')),false);assert.deepEqual(fs.readdirSync(root),['existing']);
});

test('disabled planned assets leave no resurrected token or dangling persona reference',async t=>{
 const root=sandbox(t),draft=prepareDraft({prompt:'blue anime assistant'});
 draft.asset_plan.asset_plan.find(a=>a.kind==='persona_avatar').max_edge=1;
 draft.asset_plan.asset_plan.find(a=>a.kind==='wallpaper').width=1;
 draft.tokens['asset.wallpaper']='data:image/png;base64,'+pixel().toString('base64');
 const result=await buildThemePackage({draft,sandboxRoot:root,outDir:path.join(root,'disabled')});
 assert.equal(result.ok,true,JSON.stringify(result.issues));
 assert.ok(result.degradation.disabled.some(a=>a.kind==='persona_avatar'));
 assert.ok(result.degradation.disabled.some(a=>a.kind==='wallpaper'));
 assert.equal(result.tokens['asset.wallpaper'],'none');assert.equal(result.persona.avatar,null);
});
test('empty or malformed observations cannot claim an observed plan',()=>{
 for(const observation of [{},{viewport:{}},{viewport:{width:-1,height:500}},{viewport:{width:500,height:500},critical_regions:'invalid'},{viewport:{width:800,height:600},safe_region:{x:9000,y:0,width:100,height:100},critical_regions:[]}])assert.throws(()=>prepareDraft({prompt:'blue assistant',observation}),/OBSERVATION/);
});
test('rejection after final image sizing still retries then tries procedural fallback',async()=>{
 let models=0,fallbacks=0;
 const generator=createAssetGenerator({imageGenerator:async()=>{models++;return pixel();},retries:1,fallbackRenderer:options=>{fallbacks++;return render(options);}});
 const result=await generator.generate({entry:{...entry,width:512,height:256,max_edge:16}});
 assert.equal(models,2);assert.equal(fallbacks,1);assert.equal(result.disabled,true);
});
