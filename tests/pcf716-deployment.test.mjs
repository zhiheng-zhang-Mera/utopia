import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import * as deployment from '../services/personal-compute-fabric/deployment.mjs';
const config={version:'1',schemaVersion:1,port:49000,credentialReference:'existing-enrollment-file',profile:'STANDARD_DEVICES'};
const checks={writable:true,portAvailable:true,freeBytes:2000000,versionsCompatible:true};
// The service script is PowerShell. CI has PowerShell 7 (`pwsh`) while a plain Windows workstation may only have
// Windows PowerShell 5.1 (`powershell.exe`); hard-coding one of the two means the check silently NEVER RUNS wherever
// the other is installed, and the red result would prove nothing about the product. The host is therefore discovered,
// and a machine with neither is reported as a typed NOT_RUN instead of a failure. No assertion is weakened by this.
function powershellHost(){
 for(const candidate of ['pwsh','powershell.exe']){
  try{if(spawnSync(candidate,['-NoProfile','-Command','$PSVersionTable.PSVersion.Major'],{encoding:'utf8'}).status===0)return candidate;}catch{}
 }
 return null;
}
const POWERSHELL=powershellHost();
const requirePowershell=POWERSHELL===null?{skip:'NOT_RUN: this machine has no PowerShell host (pwsh or powershell.exe), so scripts/pcf-service.ps1 cannot be exercised here'}:{};
test('716 preflight rejects unsafe configuration and host conditions',()=>{
 assert.equal(typeof deployment.preflightDeployment,'function');
 for(const [input,reason] of [[{config:null},'CONFIG_MISSING'],[{config:{...config,token:'secret'}},'CREDENTIAL_VALUE_FORBIDDEN'],[{checks:{...checks,writable:false}},'PERMISSION_DENIED'],[{checks:{...checks,portAvailable:false}},'PORT_OCCUPIED'],[{checks:{...checks,freeBytes:0}},'DISK_QUOTA'],[{checks:{...checks,versionsCompatible:false}},'MIXED_VERSION']]) assert.equal(deployment.preflightDeployment({config,checks,...input}).reason,reason);
 assert.equal(deployment.preflightDeployment({config,checks}).state,'READY');
});
test('716 lifecycle defaults opt out and dry run; install duplicate and undrained upgrade refuse',async()=>{
 assert.equal(typeof deployment.createDeploymentController,'function');
 const c=deployment.createDeploymentController({config,checks});
 assert.equal((await c.execute('INSTALL')).reason,'EXPLICIT_OPT_IN_REQUIRED');
 assert.equal((await c.execute('INSTALL',{optIn:true})).state,'PROPOSED');
 assert.equal(c.manifest().installed,false);
 assert.equal((await c.execute('INSTALL',{optIn:true,dryRun:false})).state,'INSTALLED');
 assert.equal((await c.execute('INSTALL',{optIn:true,dryRun:false})).reason,'ALREADY_INSTALLED');
 assert.equal((await c.execute('UPDATE',{optIn:true,dryRun:false,target:{...config,version:'2'}})).reason,'DRAIN_REQUIRED');
});
test('716 update requires completed drain, uses ordered canary and rolls back failed verification',async()=>{
 const calls=[];const adapter=Object.fromEntries(['start','stop','drain','checkpoint','canary','switchVersion','verify','rollback'].map(name=>[name,async()=>{calls.push(name);return name==='verify'?false:true;} ]));
 const c=deployment.createDeploymentController({config,checks,adapter});const options={optIn:true,dryRun:false};
 await c.execute('INSTALL',options);await c.execute('START',options);await c.execute('DRAIN',options);
 const result=await c.execute('UPDATE',{...options,target:{...config,version:'2'}});
 assert.equal(result.state,'ROLLED_BACK');assert.equal(c.manifest().version,'1');assert.deepEqual(calls,['start','drain','checkpoint','canary','switchVersion','verify','rollback']);
 assert.equal((await c.execute('ROLLBACK',{...options,target:{...config,schemaVersion:2}})).reason,'SCHEMA_ROLLBACK_UNSAFE');
});
test('716 failed canary never switches; rollback failure remains attention',async()=>{
 const options={optIn:true,dryRun:false};let switches=0;
 const c=deployment.createDeploymentController({config,checks,adapter:{drain:async()=>true,checkpoint:async()=>true,canary:async()=>false,switchVersion:async()=>{switches++;}}});await c.execute('INSTALL',options);await c.execute('DRAIN',options);
 assert.equal((await c.execute('UPDATE',{...options,target:{...config,version:'2'}})).reason,'CANARY_FAILED');assert.equal(switches,0);
 const bad=deployment.createDeploymentController({config,checks,adapter:{rollback:async()=>false}});await bad.execute('INSTALL',options);assert.equal((await bad.execute('ROLLBACK',{...options,target:config})).state,'ATTENTION');
});
test('716 bounded logs omit credentials and health probe rejects credentials',async()=>{
 assert.equal(typeof deployment.appendBoundedLog,'function');
 let records=[];for(let i=0;i<100;i++)records=deployment.appendBoundedLog(records,{action:'START',state:'RUNNING',token:'secret'},{maxEntries:4,maxBytes:256});assert.ok(records.length<=4);assert.ok(Buffer.byteLength(JSON.stringify(records))<=256);assert.ok(!JSON.stringify(records).includes('secret'));
 assert.equal((await deployment.boundedHealthCheck('http://user:secret@localhost/')).reason,'HEALTH_URL_INVALID');
});
test('716 independent owned child survives absent control surface and stops through its adapter',async()=>{
 const {spawn}=await import('node:child_process');const {once}=await import('node:events');let child;
 const adapter={start:async()=>{child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});await once(child,'spawn');return true;},drain:async()=>true,checkpoint:async()=>true,stop:async()=>{const exited=once(child,'exit');child.kill();await exited;return true;}};
 const c=deployment.createDeploymentController({config,checks,adapter});const options={optIn:true,dryRun:false};
 try{await c.execute('INSTALL',options);assert.equal((await c.execute('START',options)).state,'RUNNING');assert.doesNotThrow(()=>process.kill(child.pid,0));await c.execute('DRAIN',options);assert.equal((await c.execute('STOP',options)).state,'STOPPED');assert.equal((await c.execute('UNINSTALL',options)).state,'UNINSTALLED');}finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill();}
});
test('716 PowerShell opt-out never reads missing config or creates candidate',requirePowershell,async()=>{
 const {spawnSync}=await import('node:child_process');const result=spawnSync(POWERSHELL,['-NoProfile','-File','scripts/pcf-service.ps1','-Action','INSTALL','-CandidateDirectory','Z:/missing-candidate','-ConfigFile','Z:/missing-config'],{encoding:'utf8'});assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).reason,'EXPLICIT_OPT_IN_REQUIRED');
});
test('716 review duplicate START preserves one owned runtime',async()=>{
 let starts=0,stops=0;const c=deployment.createDeploymentController({config,checks,adapter:{start:async()=>{starts++;return true;},stop:async()=>{stops++;return true;}}});const options={optIn:true,dryRun:false};await c.execute('INSTALL',options);await c.execute('START',options);assert.equal((await c.execute('START',options)).reason,'ALREADY_RUNNING');assert.equal(starts,1);await c.execute('STOP',options);assert.equal(stops,1);
});
test('716 review restored running manifest cannot uninstall unknown runtime',async()=>{
 let stops=0;const c=deployment.createDeploymentController({config,checks,initialManifest:{installed:true,running:true},adapter:{stop:async()=>{stops++;return true;}}});const result=await c.execute('UNINSTALL',{optIn:true,dryRun:false});assert.equal(result.reason,'OWNED_RUNTIME_UNKNOWN');assert.equal(c.manifest().installed,true);assert.equal(stops,0);
});
test('716 review restored owned runtime reconciles before stopping and uninstalling',async()=>{
 const calls=[];const c=deployment.createDeploymentController({config,checks,initialManifest:{installed:true,running:true,runtimeIdentity:'fixture-boot-1'},adapter:{reconcileOwnedRuntime:async identity=>{calls.push(identity);return true;},stop:async()=>{calls.push('stop');return true;}}});assert.equal((await c.execute('UNINSTALL',{optIn:true,dryRun:false})).state,'UNINSTALLED');assert.deepEqual(calls,['fixture-boot-1','stop']);
});
test('716 review invalid rollback never calls adapter or corrupts manifest',async()=>{
 let calls=0;const c=deployment.createDeploymentController({config,checks,initialManifest:{installed:true},adapter:{rollback:async()=>{calls++;return true;}}});for(const target of [{schemaVersion:1},{...config,port:0},{...config,credentialReference:''},{...config,token:'secret'}])assert.equal((await c.execute('ROLLBACK',{optIn:true,dryRun:false,target})).state,'REFUSED');assert.equal(calls,0);assert.equal(c.manifest().version,'1');
});
test('716 review real ancestor junction cannot redirect candidate metadata writes',requirePowershell,async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,symlinkSync,unlinkSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawnSync}=await import('node:child_process');const fixture=mkdtempSync(join(tmpdir(),'pcf716-junction-'));const actual=join(fixture,'actual');const junction=join(fixture,'alias');mkdirSync(actual);const configFile=join(fixture,'config.json');writeFileSync(configFile,JSON.stringify(config));
 try{symlinkSync(actual,junction,'junction');const result=spawnSync(POWERSHELL,['-NoProfile','-File','scripts/pcf-service.ps1','-Action','INSTALL','-CandidateDirectory',join(junction,'candidate'),'-ConfigFile',configFile,'-OptIn','-Apply'],{encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/REPARSE_POINT_FORBIDDEN/);assert.equal(existsSync(join(actual,'candidate','pcf-candidate-manifest.json')),false);}finally{if(existsSync(junction))unlinkSync(junction);rmSync(fixture,{recursive:true,force:true});}
});
