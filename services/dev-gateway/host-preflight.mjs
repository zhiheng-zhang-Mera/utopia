import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
const run=promisify(execFile);
export async function findRunningCities({processes,listeners,fetchImpl=fetch,excludePid=process.pid,runImpl=run}={}) {
 if(processes===undefined) {
  if(process.platform!=='win32')return [];
  let answers;
  // A cold/busy Windows inventory can exceed its budget. Retry one complete observation;
  // a failed scan never counts as an empty host and cannot authorize a new City.
  for(let attempt=0;attempt<2;attempt++){
   const results=await Promise.allSettled([
    runImpl('powershell',['-NoLogo','-NoProfile','-NonInteractive','-Command',`@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress`],{windowsHide:true,timeout:30000}),
    runImpl('netstat',['-ano','-p','tcp'],{windowsHide:true,timeout:10000})
   ]);
   const failures=results.filter(result=>result.status==='rejected');
   const failure=failures.find(result=>!result.reason.killed)||failures[0];
   if(!failure){answers=results.map(result=>result.value);break;}
   const error=failure.reason;
   if(attempt===0&&error.killed)continue;
   throw Object.assign(new Error('Could not confirm existing host Gateways; no City may be started: '+error.message),{code:error.killed?'HOST_SCAN_TIMEOUT':'HOST_SCAN_FAILED',cause:error});
  }
  const parsed=JSON.parse(answers[0].stdout||'[]');processes=Array.isArray(parsed)?parsed:[parsed];listeners=answers[1].stdout;
 }
 const cities=new Map();
 for(const process of processes) {
  if(process.ProcessId===excludePid)continue;
  const command=String(process.CommandLine||'').replaceAll('\\','/');
  const args=[...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map(match=>match[1]??match[2]??match[3]);
  const script=args.find(arg=>/^[A-Za-z]:\//.test(arg)&&arg.endsWith('/services/dev-gateway/main.mjs'));
  const relative=args.some(arg=>arg.replace(/^\.\//,'')==='services/dev-gateway/main.mjs');
  if(!script&&!relative)continue;
  const sockets=String(listeners).split(/\r?\n/).map(line=>line.trim().split(/\s+/)).filter(parts=>parts[0]==='TCP'&&parts[3]==='LISTENING'&&Number(parts[4])===process.ProcessId).slice(0,8);
  let identified=false,unresolvedEndpoint=null;
  for(const socket of sockets) {
   const matchAddress=socket[1].match(/^(.*):(\d+)$/);if(!matchAddress)continue;
   let host=matchAddress[1];const port=Number(matchAddress[2]);if(port===4389)continue;
   if(host==='0.0.0.0'||host==='[::]')host='127.0.0.1';
   const endpoint=`http://${host}:${port}`;
   unresolvedEndpoint ||= endpoint;
   try {
    const response=await fetchImpl(endpoint+'/api/v0/pairing/info',{headers:{'X-City-Api-Version':'0','X-City-Schema-Version':'0'},signal:AbortSignal.timeout(1500)});
    if(!response.ok)continue;const info=await response.json();if(!info.cityId||!info.descriptor?.endpoint)continue;
    const sourceRoot=script?script.slice(0,-'/services/dev-gateway/main.mjs'.length):null;
    const dataDir=sourceRoot?resolve(sourceRoot,'.runtime'):null;
    const configFile=dataDir?['local-config.json','local-token.json'].map(name=>resolve(dataDir,name)).find(existsSync):null;
    cities.set(process.ProcessId+':'+info.cityId,{kind:'utopia-legacy-host',state:'ONLINE',cityId:info.cityId,displayName:info.displayName,endpoint,gatewayPid:process.ProcessId,sourceRoot,dataDir,configFile});
    identified=true;
   } catch { /* Non-Gateway auxiliary listeners cannot establish another City. */ }
  }
  if(!identified&&unresolvedEndpoint)cities.set(process.ProcessId+':unresolved',{kind:'utopia-legacy-host',state:'UNAVAILABLE',endpoint:unresolvedEndpoint,gatewayPid:process.ProcessId});
 }
 return [...cities.values()];
}
