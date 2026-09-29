import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTask } from '../agents/reference-node/runner.mjs';
test('runner stops file side effects when gateway has made task terminal',async()=>{
 let writes=0;
 const adapter={create:async()=>{writes++;},cleanup:async()=>{},checkpoint:async()=>{},hash:async()=>''};
 await executeTask({id:'Q-test',type:'CHECKPOINT_DEMO'},adapter,async()=>({state:'FAILED'}),0);
 assert.equal(writes,0);
});
test('runner returns failed report for retry when transport is unavailable',async()=>{
 const adapter={cleanup:async()=>{}};
 const pending=await executeTask({id:'Q-test',type:'WAIT'},adapter,async()=>{throw new Error('Disconnected');},0);
 assert.equal(pending.state,'FAILED');assert.match(pending.error,/Disconnected/);
});
