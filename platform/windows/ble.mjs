import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isIPv4 } from 'node:net';
export const BLE_SERVICE_UUID='6f9a0001-6c53-4b92-a319-75746f706961';
export function encodeBleLocator(host,port){
 if(!isIPv4(host)||host==='0.0.0.0'||!Number.isInteger(port)||port<1||port>65535)throw Error('BLE requires a valid IPv4 endpoint and port');
 return Buffer.from([1,...host.split('.').map(Number),port>>8,port&255]);
}
export function encodeBleAdvertisement(host,port){return Buffer.concat([Buffer.from(BLE_SERVICE_UUID.replaceAll('-',''),'hex'),encodeBleLocator(host,port)]);}
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
