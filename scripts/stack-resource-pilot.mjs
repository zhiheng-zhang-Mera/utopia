import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const exec=promisify(execFile),filename=fileURLToPath(import.meta.url);
if(process.argv[2]==='--worker'){
 let app,closing=false;
 const close=async()=>{if(closing)return;closing=true;try{await(app?.stop?.()??app?.close?.());}finally{process.exit(0);}};
 process.on('message',m=>{if(m==='stop')void close();});process.on('disconnect',()=>void close());
 process.on('SIGTERM',()=>void close());
 try{
  if(process.argv[3]==='gateway'){
   const {createGateway}=await import('../services/dev-gateway/server.mjs');
   app=await createGateway({host:process.env.CITY_RESOURCE_HOST,port:4311,dir:process.env.CITY_RESOURCE_DIR,token:process.env.CITY_TOKEN,nodeToken:process.env.CITY_NODE_TOKEN,discoveryEnabled:process.env.CITY_DISCOVERY_DISABLED!=='1'});
  }else{
   const {startAgent}=await import('../agents/reference-node/agent.mjs');
   app=await startAgent({url:`http://${process.env.CITY_RESOURCE_HOST}:4311`,token:process.env.CITY_NODE_TOKEN,workspace:process.env.CITY_RESOURCE_DIR+'/workspace',id:'resource-pilot-node',displayName:'Resource pilot',telemetryEnabled:process.env.CITY_TELEMETRY_DISABLED!=='1'});
  }
  process.send?.({ready:true});
 }catch(e){process.send?.({error:e.code||'WORKER_START_FAILED'});process.exit(1);}
}else{
 if(process.platform!=='win32')throw Error('This full-stack pilot requires Windows process counters');
 const host=process.env.CITY_RESOURCE_HOST;
 if(!isIPv4(host||'')||host.startsWith('127.')||!Object.values(networkInterfaces()).flat().some(n=>n?.address===host&&!n.internal))throw Error('Set CITY_RESOURCE_HOST to the explicit local LAN IPv4 interface; this pilot advertises a temporary City on port 4311');
 const durationMs=Number(process.env.UTOPIA_RESOURCE_PILOT_MS||30000);
 if(!Number.isInteger(durationMs)||durationMs<3000||durationMs>300000)throw Error('Duration must be 3000..300000 ms');
 const launch=(role,env)=>{
  const child=spawn(process.execPath,[filename,'--worker',role],{env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  const ready=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error(role+' readiness timeout')),20000);child.once('error',reject);child.once('exit',()=>{clearTimeout(timeout);reject(Error(role+' exited before readiness'));});child.on('message',m=>{clearTimeout(timeout);if(m.ready)resolve();else reject(Error(m.error||'Worker failed'));});});
  return {child,ready};
 };
 const stop=async child=>{if(!child||child.exitCode!==null)return;const ended=new Promise(r=>child.once('exit',r));if(child.connected)child.send('stop');let timeout;await Promise.race([ended,new Promise(r=>{timeout=setTimeout(()=>{child.kill();r();},8000);})]);clearTimeout(timeout);};
 const powershell=script=>exec('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,maxBuffer:4*1024*1024});
 const run=async enabled=>{
  const mode=enabled?'normal':'baseline',dir='.runtime/resource-city/'+new Date().toISOString().replaceAll(':','-')+'-'+mode;
  const env={...process.env,CITY_RESOURCE_HOST:host,CITY_RESOURCE_DIR:dir,CITY_TOKEN:randomBytes(32).toString('hex'),CITY_NODE_TOKEN:randomBytes(32).toString('hex'),CITY_DISCOVERY_DISABLED:enabled?'0':'1',CITY_TELEMETRY_DISABLED:enabled?'0':'1'};
  let gateway,node;
  try{
   gateway=launch('gateway',env);await gateway.ready;node=launch('node',env);await node.ready;
   const snapshot=async()=>{const r=await fetch(`http://${host}:4311/api/v0/city`,{headers:{Authorization:'Bearer '+env.CITY_TOKEN,'X-City-Api-Version':'0','X-City-Schema-Version':'0'},signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error('Pilot snapshot HTTP '+r.status);return r.json();};
   await sleep(5000);const before=await snapshot();
   const children=await powershell(`@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${gateway.child.pid}' | Where-Object { $_.Name -eq 'powershell.exe' } | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress`);
   const publisherPids=children.stdout.trim()?([JSON.parse(children.stdout)].flat()):[];
   const roles=[{id:gateway.child.pid,role:'gateway'},{id:node.child.pid,role:'reference_node'},...publisherPids.map(id=>({id,role:'ble_publisher'}))];
   // Static numeric process IDs only; neither process command lines nor environments are read.
   const script=`$ErrorActionPreference='Stop'; $ids=@(${roles.map(r=>r.id).join(',')}); $watch=[Diagnostics.Stopwatch]::StartNew(); $rows=@(); do { $processes=@(foreach($processId in $ids){ $p=Get-Process -Id $processId -ErrorAction SilentlyContinue; if($p){ @{id=$processId;cpuSeconds=$p.TotalProcessorTime.TotalSeconds;rssBytes=$p.WorkingSet64} } }); $rows+=@{elapsedMs=$watch.Elapsed.TotalMilliseconds;observedAt=[DateTime]::UtcNow.ToString('o');processes=$processes}; if($watch.Elapsed.TotalMilliseconds -ge ${durationMs}){break}; Start-Sleep -Milliseconds 1000 } while($true); ConvertTo-Json -InputObject $rows -Depth 5 -Compress`;
   const measured=await powershell(script);const samples=JSON.parse(measured.stdout).map(s=>({...s,processes:s.processes.map(p=>({role:roles.find(r=>r.id===p.id).role,cpuSeconds:p.cpuSeconds,rssBytes:p.rssBytes}))}));
   const after=await snapshot();
   const elapsedMs=samples.at(-1).elapsedMs-samples[0].elapsedMs;
   const countersComplete=samples.every(s=>s.processes.length===roles.length);
   const totalCpu=s=>s.processes.reduce((n,p)=>n+p.cpuSeconds,0),totalRss=s=>s.processes.reduce((n,p)=>n+p.rssBytes,0);
   const discoveryActive=!enabled||(before.discovery?.mdns?.state==='ACTIVE'&&before.discovery?.ble?.state==='ACTIVE'&&after.discovery?.mdns?.state==='ACTIVE'&&after.discovery?.ble?.state==='ACTIVE'&&publisherPids.length>0);
   const modeVerified=[before,after].every(s=>Boolean(s.nodes?.[0]?.telemetry)===enabled&&s.nodes?.[0]?.online===true&&(enabled||(s.discovery?.mdns?.state==='DISABLED'&&s.discovery?.ble?.state==='DISABLED')));
   return {mode,status:countersComplete&&discoveryActive&&modeVerified?'PILOT':'INCOMPLETE',startedAt:samples[0].observedAt,endedAt:samples.at(-1).observedAt,elapsedMs,discoveryBefore:before.discovery,discoveryAfter:after.discovery,telemetryPresentBefore:Boolean(before.nodes?.[0]?.telemetry),telemetryPresentAfter:Boolean(after.nodes?.[0]?.telemetry),processRoles:roles.map(r=>r.role),countersComplete,discoveryActive,modeVerified,cpuPercentOfOneLogicalCore:countersComplete?(totalCpu(samples.at(-1))-totalCpu(samples[0]))/(elapsedMs/1000)*100:null,meanCombinedRssBytes:countersComplete?samples.reduce((n,s)=>n+totalRss(s),0)/samples.length:null,samples};
  }finally{await stop(node?.child);await stop(gateway?.child);}
 };
 let codeSha=null,worktreeModified=null;try{codeSha=(await exec('git',['rev-parse','HEAD'])).stdout.trim();worktreeModified=Boolean((await exec('git',['status','--porcelain'])).stdout.trim());}catch{}
 const runs=[];for(const enabled of [false,true]){try{runs.push(await run(enabled));}catch(e){runs.push({mode:enabled?'normal':'baseline',status:'INCOMPLETE',errorClass:e.code||e.constructor.name,cpuPercentOfOneLogicalCore:null,meanCombinedRssBytes:null});}}
 const result={schemaVersion:1,status:runs.every(r=>r.status==='PILOT')?'PILOT':'INCOMPLETE',scope:'gateway_reference_node_and_ble_publisher_processes',codeSha,worktreeModified,environment:{platform:process.platform,architecture:process.arch,nodeVersion:process.version},protocol:{durationMsPerMode:durationMs,warmupMs:5000,processCounterIntervalMs:1000,port:4311,repetitionsPerMode:1,order:['baseline','normal'],command:'Set CITY_RESOURCE_HOST to a local LAN IPv4, then node scripts/stack-resource-pilot.mjs'},limitations:['Single sequential baseline/normal pair on a shared host; uncontrolled workload noise and order effects.','CPU counts the Gateway, reference Node and WinRT publisher processes; excludes shared Windows services, kernel work outside these counters and the measurement process.','WorkingSet64 sums may double-count shared pages across processes.','Get-Process instrumentation is identical across modes but its host perturbation is not removed.','Initialization before the five-second warmup and process startup are excluded.','No Android/Web clients, user tasks, network-byte measurement or long-term resource conclusions.','A temporary City is genuinely advertised on the explicit LAN interface during normal measurement.'],runs};
 await mkdir('evidence/raw/v0.2',{recursive:true});await writeFile('evidence/raw/v0.2/stack-resource-pilot.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({status:result.status,runs:runs.map(({mode,status,cpuPercentOfOneLogicalCore,meanCombinedRssBytes})=>({mode,status,cpuPercentOfOneLogicalCore,meanCombinedRssBytes}))}));
}
