import '../contracts/city-roads/document-knowledge-v1/tests/conformance.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {invokeAdapter} from '../services/capability-bridge/adapters.mjs';
import {digest} from '../contracts/capability-bridge-v1/protocol.mjs';

// Observed before extraction at frozen hardening main 393f3b8, using the exact
// public v0.3 fixtures. These constants do not derive expectations from the SDK.
const expected={txt:'5fac73d18400ed5eebc4543bb29ab126df718780c33f60724a0884a10591680f',json:'0f46d5f7a9664d538019cca7fdd3b4e0ffd2ca6031f1a8e0ea210047b406e6a4',yaml:'0f46d5f7a9664d538019cca7fdd3b4e0ffd2ca6031f1a8e0ea210047b406e6a4',docx:'9480da6e205d89ab092a0c813443780c2478ff9c6c59e8b42f583d53754d6cce',xlsx:'4be6bd9315d4ed33c0de8aeb65163b59c469bf2aa3e0613e4996834d76026791',pdf:'959ffcf50eddc79de2e97137014ca70f5e552e4a59ee2aa1b48ca96d6e031a15'};
test('Bridge Road extraction preserves all six published document retrieval digests',async()=>{
 for(const [ext,want] of Object.entries(expected)){
  const bytes=readFileSync(new URL('../evidence/raw/v0.3/fixture-sample.'+ext,import.meta.url));
  const document=await invokeAdapter('planning.document.intake','read',{fileName:'sample.'+ext,base64:bytes.toString('base64')});
  const result=await invokeAdapter('planning.knowledge.query','fromDocument',{document,query:'Utopia'});assert.equal(digest(result),want,ext);
 }
});
