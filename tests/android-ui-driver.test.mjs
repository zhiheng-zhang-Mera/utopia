import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTree} from '../scripts/android-ui-driver.mjs';
test('Android UI evidence parser preserves single-quoted JSON and double-quoted attributes',()=>{
 const [parent,child]=parseTree(`<node text="Details" bounds="[0,0][10,10]"><node text='{&#10;"sha256":"abc"&#10;}' bounds="[1,1][9,9]" /></node>`);
 assert.equal(child.text,'{\n"sha256":"abc"\n}');assert.equal(child.parent,parent);assert.deepEqual(child.box,[1,1,9,9]);
});
