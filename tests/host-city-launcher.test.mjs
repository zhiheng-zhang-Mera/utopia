import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, copyFile, symlink, rm, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readHostCity} from '../services/dev-gateway/host-city.mjs';
import {createGateway} from '../services/dev-gateway/server.mjs';
import {writeDeviceFile} from '../apps/client/device-enrollment.mjs';
const run = promisify(execFile);
const root = resolve(import.meta.dirname,'..');

test('two installation launchers share one City across ports and recover the same identity after a crash', {timeout:180000}, async () => {
  try {await readHostCity(); throw new Error('Host integration requires a free coordination port; refusing to disturb an active City');}
  catch(error) {if(error.cause?.code!=='ECONNREFUSED') throw error;}
  const dir=await mkdtemp(resolve('.scratch-host-launch-'));
  const env={...process.env,UTOPIA_HOST_STATE_DIR:resolve(dir,'host'),UTOPIA_CLIENT_STATE_DIR:resolve(dir,'client'),CITY_DISCOVERY_DISABLED:'1',CITY_MANAGE_SERVICES:'1',CITY_ROOMS_DISABLED:'0',ROOMS_PORT:'0',CITY_TELEMETRY_DISABLED:'1'};
  let owned;
  const launch=async (install,port) => JSON.parse((await run(process.execPath,[resolve(dir,install,'scripts/utopia-client-launcher.mjs'),'--host','127.0.0.1','--port',String(port),'--no-open','--json'],{env,timeout:90000})).stdout);
  const stop=async () => {
    if(!owned) return;
    assert.ok(owned.dataDir.startsWith(dir), 'never stop a City outside the test fixture');
    if(process.platform==='win32') await run('taskkill',['/PID',String(owned.gatewayPid),'/F']).catch(()=>{});
    else process.kill(owned.gatewayPid,'SIGKILL');
    owned=null;
    for(let i=0;i<100;i++) {try {await readHostCity();} catch(error) {if(error.cause?.code==='ECONNREFUSED') return; throw error;} await new Promise(r=>setTimeout(r,50));}
    throw new Error('Crashed Gateway did not release the host reservation');
  };
  try {
    for(const install of ['a','b']) {
      await mkdir(resolve(dir,install,'scripts'),{recursive:true});
      await copyFile(resolve(root,'scripts/utopia-client-launcher.mjs'),resolve(dir,install,'scripts/utopia-client-launcher.mjs'));
      for(const script of ['start-city.ps1','stop-city.ps1','restart-gateway.ps1','host-processes.ps1']) await copyFile(resolve(root,'scripts',script),resolve(dir,install,'scripts',script));
      for(const folder of ['apps','services']) await symlink(resolve(root,folder),resolve(dir,install,folder),process.platform==='win32'?'junction':'dir');
    }
    const results=await Promise.all([launch('a',0),launch('b',0)]);
    owned=results[0];
    assert.deepEqual(results[0],results[1]);
    const record=await readHostCity();
    assert.equal(record.servicesManaged,true);
    const repeat=await launch('b',4999);
    assert.deepEqual(repeat,owned,'a different requested port cannot start another City');
    const cityId=owned.cityId;
    const dataDir=owned.dataDir;
    if(process.platform==='win32') {
      writeDeviceFile(resolve(dir,'client/device-enrollment.json'),{endpoint:'http://127.0.0.1:1',cityId:'remote-enrolled-city',installationId:'i',instanceId:'n',credentialId:'c',credentialSecret:'s',deviceId:'d'});
      await run('powershell',['-NoProfile','-File',resolve(dir,'a/scripts/start-city.ps1'),'-Port','4997','-NoRooms','-DisableDiscovery','-DisableTelemetry'],{env,timeout:60000});
      assert.equal((await readHostCity()).gatewayPid,owned.gatewayPid,'host startup bypasses remote enrollment and reuses the existing process');
      await run('powershell',['-NoProfile','-File',resolve(dir,'b/scripts/restart-gateway.ps1')],{env,timeout:90000});
      owned=await readHostCity();
      assert.equal(owned.cityId,cityId);
      assert.equal(owned.startup.ROOMS_PORT,'0','restart preserves the original Rooms port setting');
      assert.equal(owned.startup.CITY_ROOMS_DISABLED,'0','repeated start cannot override a running City');
      assert.equal(owned.startup.CITY_DISCOVERY_DISABLED,'1');
      await rm(resolve(dir,'client/device-enrollment.json'));
    }
    await stop();
    owned=await launch('b',0);
    assert.equal(owned.cityId,cityId);
    assert.equal(owned.dataDir,dataDir);
    await stop();
    const pointer=resolve(dir,'host/city.json');
    const saved=JSON.parse(await readFile(pointer,'utf8'));
    await writeFile(pointer,JSON.stringify({...saved,cityId:'a-different-registered-city'}));
    await assert.rejects(run(process.execPath,[resolve(root,'services/dev-gateway/main.mjs')],{env,timeout:20000}),error=>error.stderr.includes('database identity mismatch'));
    assert.equal(JSON.parse(await readFile(pointer,'utf8')).cityId,'a-different-registered-city','startup cannot overwrite the persisted identity pin');
  } finally {
    if(!owned) {try {const record=await readHostCity(); if(record.dataDir?.startsWith(dir)) owned=record;} catch {}}
    await stop();
    await rm(dir,{recursive:true,force:true});
  }
});

test('forgetting migrated enrollment cannot import the legacy credential again', async () => {
  const dir=await mkdtemp(resolve('.scratch-forget-enrollment-'));
  const env={...process.env,UTOPIA_CLIENT_STATE_DIR:resolve(dir,'client')};
  const script=resolve(dir,'install/scripts/utopia-client-launcher.mjs');
  try {
    await mkdir(resolve(dir,'install/scripts'),{recursive:true});
    await copyFile(resolve(root,'scripts/utopia-client-launcher.mjs'),script);
    for(const folder of ['apps','services']) await symlink(resolve(root,folder),resolve(dir,'install',folder),process.platform==='win32'?'junction':'dir');
    writeDeviceFile(resolve(dir,'install/.runtime/device-enrollment.json'),{endpoint:'http://127.0.0.1:1',cityId:'legacy-city',installationId:'i',instanceId:'n',credentialId:'c',credentialSecret:'s',deviceId:'d'});
    await run(process.execPath,[script,'--forget-device'],{env,timeout:10000});
    await assert.rejects(run(process.execPath,[script,'--enroll','invalid','--enroll-host','http://127.0.0.1:1'],{env,timeout:10000}));
    const {existsSync}=await import('node:fs');
    assert.equal(existsSync(resolve(dir,'client/device-enrollment.json')),false);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('remote short code enrolls and reconnects to its target without launching a host City', {timeout:30000}, async () => {
  const dir=await mkdtemp(resolve('.scratch-remote-launch-'));
  const app=await createGateway({host:'127.0.0.1',port:0,dir:resolve(dir,'remote'),token:'remote-owner',nodeToken:'remote-node'});
  const env={...process.env,UTOPIA_CLIENT_STATE_DIR:resolve(dir,'client'),UTOPIA_HOST_STATE_DIR:resolve(dir,'unused-host')};
  const launch=async args=>run(process.execPath,[resolve(root,'scripts/utopia-client-launcher.mjs'),...args,'--no-open','--json'],{env,timeout:12000});
  try {
    const session=await fetch(app.url+'/api/v0/pairing/session',{method:'POST',headers:{Authorization:'Bearer remote-owner','Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:'{}'});
    // Owner creates a real one-time session; the client uses only its short code and URL.
    assert.equal(session.ok,true);
    const invite=await session.json();
    const enrolled=JSON.parse((await launch(['--enroll-code',invite.shortCode,'--enroll-host',app.url])).stdout);
    assert.equal(enrolled.endpoint,app.url);
    assert.equal(JSON.parse((await launch(['--port','4998'])).stdout).cityId,app.store.cityId);
    await app.close();
    await assert.rejects(launch([]),error=>error.stderr.includes('CITY_UNREACHABLE'));
    const {existsSync}=await import('node:fs');
    assert.equal(existsSync(resolve(dir,'unused-host')),false);
  } finally {await app.close(); await rm(dir,{recursive:true,force:true});}
});
