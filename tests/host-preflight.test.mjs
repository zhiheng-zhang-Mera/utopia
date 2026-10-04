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

test('a cold Windows inventory timeout retries one complete scan before declaring the host empty',{skip:process.platform!=='win32'},async()=>{const{findRunningCities}=await import('../services/dev-gateway/host-preflight.mjs');let cim=0,sockets=0;const found=await findRunningCities({runImpl:async command=>{if(command==='powershell'){if(++cim===1)throw Object.assign(new Error('cold inventory timeout'),{killed:true});return{stdout:'[]'};}sockets++;return{stdout:''};}});assert.deepEqual(found,[]);assert.equal(cim,2);assert.equal(sockets,2,'retry renews the listener observation too');});
test('a persistent inventory timeout refuses after exactly two attempts',{skip:process.platform!=='win32'},async()=>{const{findRunningCities}=await import('../services/dev-gateway/host-preflight.mjs');let attempts=0;await assert.rejects(findRunningCities({runImpl:async command=>{if(command==='powershell'){attempts++;throw Object.assign(new Error('still unavailable'),{killed:true});}return{stdout:''};}}),error=>error.code==='HOST_SCAN_TIMEOUT');assert.equal(attempts,2);});
test('a non-timeout inventory error refuses without retrying',{skip:process.platform!=='win32'},async()=>{const{findRunningCities}=await import('../services/dev-gateway/host-preflight.mjs');let attempts=0;await assert.rejects(findRunningCities({runImpl:async command=>{if(command==='powershell'){attempts++;throw new Error('access denied');}return{stdout:''};}}),error=>error.code==='HOST_SCAN_FAILED');assert.equal(attempts,1);});

test('mixed timeout and non-timeout failures cannot hide a blocking inventory error',{skip:process.platform!=='win32'},async()=>{const{findRunningCities}=await import('../services/dev-gateway/host-preflight.mjs');let attempts=0;await assert.rejects(findRunningCities({runImpl:async command=>{attempts++;if(command==='powershell')throw Object.assign(new Error('timeout'),{killed:true});throw new Error('listener access denied');}}),error=>error.code==='HOST_SCAN_FAILED');assert.equal(attempts,2,'only one complete scan');});
