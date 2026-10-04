import test from 'node:test';
import assert from 'node:assert/strict';
test('startup preflight recognizes old absolute Windows paths and refuses duplicate Cities',async()=>{
 const {findRunningCities}=await import('../services/dev-gateway/host-preflight.mjs');
 const processes=[{ProcessId:12,CommandLine:'D:\\node-runtime\\node.exe "D:\\old install\\services\\dev-gateway\\main.mjs"'},{ProcessId:13,CommandLine:'node.exe unrelated.mjs'}];
 const listeners='  TCP    192.168.1.3:4999   0.0.0.0:0   LISTENING   12\n  TCP    127.0.0.1:5000  0.0.0.0:0   LISTENING 13';
 const found=await findRunningCities({processes,listeners,fetchImpl:async()=>({ok:true,json:async()=>({cityId:'old-city',displayName:'旧城',descriptor:{endpoint:{scheme:'http',host:'192.168.1.3',port:4999}}})})});
 assert.equal(found.length,1);assert.equal(found[0].cityId,'old-city');assert.equal(found[0].gatewayPid,12);
 assert.equal(found[0].sourceRoot.replaceAll('\\','/'),'D:/old install');
});
test('an interrupted Windows inventory is an explicit blocking error, never an empty host', {skip:process.platform!=='win32'},async()=>{
 const {findRunningCities}=await import('../services/dev-gateway/host-preflight.mjs');
 await assert.rejects(findRunningCities({runImpl:async()=>{throw Object.assign(new Error('inventory timeout'),{killed:true});}}),error=>error.code==='HOST_SCAN_TIMEOUT');
});
test('a relative Gateway path with an inconclusive identity probe blocks startup',async()=>{
 const {findRunningCities}=await import('../services/dev-gateway/host-preflight.mjs');
 const found=await findRunningCities({processes:[{ProcessId:12,CommandLine:'node ./services/dev-gateway/main.mjs'}],listeners:'TCP 127.0.0.1:4999 0.0.0.0:0 LISTENING 12',fetchImpl:async()=>{throw new Error('busy');}});
 assert.equal(found.length,1);assert.equal(found[0].state,'UNAVAILABLE');assert.equal(found[0].gatewayPid,12);
});
