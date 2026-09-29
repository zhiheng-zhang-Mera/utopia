import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceStatus} from '../scripts/lib/skill-acceptance-status.mjs';
test('successful live transport cannot mask broken offline product behavior',()=>{
  assert.equal(acceptanceStatus('ok',[true,false,true]),'FAIL');
  assert.equal(acceptanceStatus('failed',[true,true,true]),'BLOCKED_EXTERNAL');
  assert.equal(acceptanceStatus('failed',[false,true,true]),'FAIL');
  assert.equal(acceptanceStatus('ok',[true,true,true]),'PASS');
});
