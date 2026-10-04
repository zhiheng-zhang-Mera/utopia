import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isIPv4 } from 'node:net';
export const BLE_SERVICE_UUID='6f9a0001-6c53-4b92-a319-75746f706961';
export function encodeBleLocator(host,port){
 if(!isIPv4(host)||host==='0.0.0.0'||!Number.isInteger(port)||port<1||port>65535)throw Error('BLE requires a valid IPv4 endpoint and port');
 return Buffer.from([1,...host.split('.').map(Number),port>>8,port&255]);
}
export function encodeBleAdvertisement(host,port){return Buffer.concat([Buffer.from(BLE_SERVICE_UUID.replaceAll('-',''),'hex'),encodeBleLocator(host,port)]);}
export function decodeBleAdvertisement(value){
 const bytes=Buffer.from(value);
 if(bytes.length!==23||!bytes.subarray(0,16).equals(Buffer.from(BLE_SERVICE_UUID.replaceAll('-',''),'hex'))||bytes[16]!==1)return null;
 const host=[...bytes.subarray(17,21)].join('.'),port=bytes.readUInt16BE(21);
 if(host==='0.0.0.0'||host==='255.255.255.255'||port===0)return null;
 return `http://${host}:${port}`;
}
/** Bounded radio scan, using the same manufacturer locator Android already reads. */
export async function scanBle({timeoutMs=5000,platform=process.platform,spawnImpl=spawn}={}){
 if(platform!=='win32')return {endpoints:[],unavailable:true,reason:'WINDOWS_API_UNAVAILABLE'};
 const budget=Math.max(100,Math.min(5000,Number(timeoutMs)||5000));
 return new Promise(resolve=>{
  const endpoints=new Set();let child,buffer='',settled=false,reason=null,done=false;
  const finish=()=>{if(settled)return;settled=true;clearTimeout(watchdog);if(child&&!child.killed)child.kill();resolve({endpoints:[...endpoints],unavailable:!!reason||!done,reason:reason||(!done?'BLUETOOTH_SCAN_FAILED':null)});};
  const watchdog=setTimeout(()=>{reason='BLUETOOTH_SCAN_TIMEOUT';finish();},budget+6000);
  try{child=spawnImpl('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./ble-scanner.ps1',import.meta.url)),'-TimeoutMs',String(budget)],{windowsHide:true,stdio:['ignore','pipe','pipe']});}
  catch{reason='POWERSHELL_START_FAILED';finish();return;}
  child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);try{const row=JSON.parse(line);if(row.payload&&/^[0-9a-f]{46}$/i.test(row.payload)){const endpoint=decodeBleAdvertisement(Buffer.from(row.payload,'hex'));if(endpoint&&endpoints.size<32)endpoints.add(endpoint);}if(row.state==='ERROR'||row.state==='HARDWARE_BLOCKED')reason=row.reason||'BLUETOOTH_SCAN_FAILED';if(row.state==='DONE')done=true;}catch{}}});
  child.stderr.on('data',()=>{});
  child.on('error',()=>{reason='POWERSHELL_START_FAILED';finish();});
  child.on('close',finish);
 });
}
export async function startBle({host,port,onStatus=()=>{},platform=process.platform}){
 const payload=encodeBleAdvertisement(host,port);let child,closed=false,last;
 const status=s=>{last=s;onStatus(s);};
 const close=async()=>{if(closed)return;closed=true;if(child&&!child.killed){child.stdin.end('stop\n');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>{const t=setTimeout(()=>{child.kill();r();},3000);t.unref();})]);}status({state:'STOPPED'});};
 if(platform!=='win32'){status({state:'ERROR',reason:'WINDOWS_API_UNAVAILABLE'});return {close};}
 child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./ble-advertiser.ps1',import.meta.url)),'-Payload',payload.toString('hex')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let buffer='';child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);try{const s=JSON.parse(line);if(['ACTIVE','HARDWARE_BLOCKED','ERROR','STOPPED'].includes(s.state))status(s);}catch{}}});
 child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
 child.on('error',()=>status({state:'ERROR',reason:'POWERSHELL_START_FAILED'}));
 child.on('exit',code=>{if(!closed&&last?.state!=='HARDWARE_BLOCKED'&&last?.state!=='ERROR')status({state:'ERROR',reason:'PUBLISHER_EXIT_'+code});});
 return {close};
}
