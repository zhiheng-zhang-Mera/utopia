import test from 'node:test';
import assert from 'node:assert/strict';
import {createCatalog} from '../catalog.mjs';

test('catalog describes source resolution and preview without promising installation', async () => {
  const catalog=createCatalog({fetchJson:async()=>({items:[{repository:{owner:{login:'public'},name:'sample'},path:'skills/demo/SKILL.md'}]})});
  const result=await catalog.search({includeLive:true});
  for(const entry of [...result.offline.entries,...result.live]){
    assert.equal(entry.resolvable,true);
    assert.equal(Object.hasOwn(entry,'installable'),false);
    assert.equal(Object.hasOwn(entry,'install'),false);
  }
  assert.equal(catalog.get('bundled-commit-message').previewable,true);
  assert.deepEqual(catalog.get('bundled-commit-message').source,{kind:'bundled',id:'bundled-commit-message'});
});
