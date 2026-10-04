// One physical host owns one City; joining a remote City never starts a local fallback.
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync} from 'node:fs';
import {networkInterfaces} from 'node:os';
import {resolve} from 'node:path';
import {readHostCity} from '../services/dev-gateway/host-city.mjs';
import {enrollWithCity, forgetDeviceFile, inviteForExchange, openDeviceSession, readDeviceFile, writeDeviceFile} from '../apps/client/device-enrollment.mjs';
const args = process.argv.slice(2);
const has = key => args.includes('--'+key);
const flag = (key, fallback=null) => {const i=args.indexOf('--'+key); return i<0 ? fallback : args[i+1];};
const root=resolve(import.meta.dirname,'..');
const clientDir=process.env.UTOPIA_CLIENT_STATE_DIR || resolve(process.env.LOCALAPPDATA || root,'Utopia/client');
const deviceFile=resolve(clientDir,'device-enrollment.json');
const legacyFile=resolve(root,'.runtime/device-enrollment.json');
const migrationMarker=resolve(clientDir,'legacy-enrollment-handled');
if (!existsSync(deviceFile) && !existsSync(migrationMarker)) {const old=readDeviceFile(legacyFile); if(old) writeDeviceFile(deviceFile,old);}
const say=message=>{if(!has('json')) console.log(message);};
function open(url) {if(!has('no-open')) spawn('cmd.exe',['/c','start','',url],{detached:true,stdio:'ignore',windowsHide:true}).unref();}
const report=record=>console.log(has('json') ? JSON.stringify(record) : 'City: '+record.endpoint+' ('+record.cityId+')');
async function main() {
  if(has('forget-device')) {
    if (!forgetDeviceFile(deviceFile)) throw new Error('Could not remove stored device enrollment');
    mkdirSync(clientDir,{recursive:true}); writeFileSync(migrationMarker,'explicitly forgotten');
    say('Stored device enrollment removed.'); return;
  }
  if(has('enroll') || has('enroll-code')) {
    let invite=has('enroll') ? inviteForExchange(flag('enroll')) : null;
    const endpoint=flag('enroll-host',invite?.host);
    if(!endpoint) throw new Error('Enrollment requires the target City URL (--enroll-host or invitation host).');
    const url=new URL(endpoint);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) throw new Error('Invalid target City URL');
    if(has('enroll-code')) {
      const code=flag('enroll-code');
      if(!/^\d{6}$/.test(code || '')) throw new Error('Pairing code must contain six digits');
      const response=await fetch(url.origin+'/api/v0/pairing/info',{headers:{'X-City-Api-Version':'0','X-City-Schema-Version':'0'},signal:AbortSignal.timeout(8000)});
      if(!response.ok) throw new Error('Target City pairing information unavailable');
      const info=await response.json();
      if(info.sessionState!=='ACTIVE') throw new Error('Target City has no active pairing session');
      invite={cityId:info.cityId,sessionId:info.descriptor?.pairingSessionId,method:'mdns',shortCode:code};
    }
    if(!invite) throw new Error('Invalid City invitation');
    const {record}=await enrollWithCity({endpoint:url.origin,invite,displayName:flag('name','Utopia device')});
    writeDeviceFile(deviceFile,record);
    report({endpoint:record.endpoint,cityId:record.cityId,enrolled:true});
    return;
  }
  const enrolled=readDeviceFile(deviceFile);
  if(enrolled && !has('host-only')) {
    const session=await openDeviceSession(enrolled);
    open(enrolled.endpoint+'/#session='+encodeURIComponent(session.credential));
    report({endpoint:enrolled.endpoint,cityId:enrolled.cityId,enrolled:true});
    return;
  }
  let record;
  try {record=await readHostCity();} catch(error) {
    if(!['ECONNREFUSED'].includes(error.cause?.code)) throw error;
  }
  if(!record) {
    const lan=Object.values(networkInterfaces()).flat().find(i=>i?.family==='IPv4'&&!i.internal&&!i.address.startsWith('169.254.'));
    const host=flag('host',process.env.CITY_HOST||lan?.address||'127.0.0.1');
    const port=flag('port',process.env.CITY_PORT||4391);
    const runtime=resolve(root,'.runtime'); mkdirSync(runtime,{recursive:true});
    const log=openSync(resolve(runtime,'gateway-launch.log'),'a');
    const child=spawn(process.execPath,['services/dev-gateway/main.mjs'],{cwd:root,env:{...process.env,CITY_MANAGE_SERVICES:process.env.CITY_MANAGE_SERVICES ?? '1',CITY_HOST:host,CITY_PORT:String(port),CITY_DATA:runtime},detached:true,stdio:['ignore',log,log],windowsHide:true});
    child.unref(); closeSync(log);
    child.on('error',error=>console.error('Gateway launch failed: '+error.message));
  }
  for(let i=0;i<80 && record?.state!=='ONLINE';i++) {
    await new Promise(yes=>setTimeout(yes,250));
    try {record=await readHostCity();} catch(error) {if(error.cause?.code!=='ECONNREFUSED') throw error;}
  }
  if(record?.state!=='ONLINE') throw new Error('City did not become ready within 20 seconds; inspect .runtime/gateway-launch.log');
  const config=JSON.parse(readFileSync(record.configFile,'utf8'));
  const response=await fetch(record.endpoint+'/api/v0/city',{headers:{Authorization:'Bearer '+config.token,'X-City-Api-Version':'0','X-City-Schema-Version':'0'},signal:AbortSignal.timeout(5000)});
  if(!response.ok || (await response.json()).cityId!==record.cityId) throw new Error('Existing host City identity or credential refused');
  open(record.endpoint+'/#token='+encodeURIComponent(config.token));
  report({endpoint:record.endpoint,cityId:record.cityId,gatewayPid:record.gatewayPid,dataDir:record.dataDir});
}
try {await main();} catch(error) {
  console.error('Utopia: '+(error.code ? error.code+': ' : '')+error.message);
  process.exitCode=6;
}
