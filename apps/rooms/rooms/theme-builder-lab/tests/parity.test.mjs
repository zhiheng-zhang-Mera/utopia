import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {intent,design} from '../core/design/designer.mjs';
import {planAssets,planSurfaces} from '../core/planning/planner.mjs';
import {render} from '../core/assets/pipeline/fallback.mjs';
import {alphaStats,contentBounds} from '../core/assets/pipeline/processor.mjs';
import {validate} from '../core/assets/pipeline/validator.mjs';
import {canvasToPng} from '../../../../../city/11-entertainment/01-entertainment-centre/theme-engine/raster/png.mjs';
const oracle=JSON.parse(fs.readFileSync(new URL('./fixtures/donor-oracle.json',import.meta.url),'utf8'));
// Published D2/D6 vocabulary adaptation; oracle bytes were produced by donor CJS.
function vocabulary(value){let text=JSON.stringify(value);for(const [a,b]of [
 ['official_overlay_texture','overlay_texture'],['official_shell_frame','shell_frame'],['official-shell-frame','shell-frame'],['hns_character','surface_character'],['official_character','overlay_character'],['official_skin','overlay_skin'],['hns_native','owned_surface'],['official_shell','external_shell'],['official_overlay','owned_overlay'],['official_renderer','protected_external_surface'],
 ['official.shell.','shell.'],['official.overlay.','overlay.'],['official.renderer.','external.renderer.'],['hns.','surface.'],['assets/official/','assets/overlay/'],['hns-character','surface-character'],['official-character','overlay-character'],['official-skin','overlay-skin'],['official-overlay-texture','overlay-texture'],['--hns-','--utopia-'],['--utopia-official-shell-','--utopia-shell-'],['--utopia-official-','--utopia-overlay-'],['official.tint','overlay.tint'],['official.vignette','overlay.vignette'],['official.scanline','overlay.scanline'],['official.frame_glow','overlay.frame_glow'],['official.texture','overlay.texture'],['official.character','overlay.character']])text=text.split(a).join(b);return JSON.parse(text);}
test('pinned donor intent, token and slot decisions match four frozen oracle vectors',()=>{
 assert.equal(oracle.donor,'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b');assert.equal(oracle.blobs.length,13);
 for(const vector of oracle.vectors){const actual=intent(vector.prompt),draft=design({intent:actual});assert.deepEqual(actual,vocabulary(vector.intent),vector.prompt);assert.deepEqual(draft.tokens,vocabulary(vector.tokens),vector.prompt);assert.deepEqual(draft.components,vocabulary(vector.components),vector.prompt);}
});
test('pinned donor plan vocabulary, asset requests and protected write semantics are preserved',()=>{
 for(const vector of oracle.vectors){const i=intent(vector.prompt),draft=design({intent:i});const projected=entry=>{const {kind,surface,path,width,height,transparent,framing}=entry;return{kind,surface,path,width,height,transparent,framing};};
  assert.deepEqual(planAssets({intent:i,design:draft}).asset_plan.map(projected),vocabulary(vector.plans.assets.asset_plan).map(projected));
  assert.deepEqual(planSurfaces({intent:i}).surfaces.map(s=>({surface:s.surface,writes:s.writes,protected:s.protected})),vocabulary(vector.plans.surface.surfaces).map(s=>({surface:s.surface,writes:s.writes,protected:s.protected})));
 }
});
test('three original procedural PNG digests, alpha/bounds and pixel verdicts match donor',()=>{
 for(const vector of oracle.pixelVectors){const kind=vocabulary(vector.kind),canvas=render({kind,spec:vector.spec,palette:{base:'#101724',accent:'#4d93f8'},seed:'d9-oracle'}).canvas,buffer=canvasToPng(canvas);
  assert.equal(createHash('sha256').update(buffer).digest('hex'),vector.sha256,kind);assert.deepEqual(alphaStats(canvas),vector.alpha);assert.deepEqual(contentBounds(canvas),vector.bounds);assert.equal(validate({kind,buffer,spec:vector.spec}).ok,vector.validation.ok);
 }
});
