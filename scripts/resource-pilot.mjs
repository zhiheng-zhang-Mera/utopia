import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createTelemetrySampler } from '../agents/reference-node/telemetry.mjs';

// Independent processes measure only the reference sampler, never the live city.
const durationMs=Number(process.env.UTOPIA_RESOURCE_PILOT_MS||30000);
if(!Number.isInteger(durationMs)||durationMs<3000||durationMs>300000)throw Error('Pilot duration must be 3000..300000 ms');
if(process.argv[2]==='--worker'){
 const enabled=process.argv[3]==='enabled';
 const sampler=createTelemetrySampler({enabled});
 const delay=monitorEventLoopDelay({resolution:20});delay.enable();
 const startedAt=new Date().toISOString(),start=performance.now(),cpuStart=process.cpuUsage();
 const rss=[];const observations=new Set();
 const record=()=>{rss.push({elapsedMs:Math.round(performance.now()-start),rssBytes:process.memoryUsage().rss});const sample=sampler.latest();if(sample)observations.add(sample.observedAt);};
 record();await sampler.start();record();
 const timer=setInterval(record,1000);
 await new Promise(resolve=>setTimeout(resolve,durationMs));
 clearInterval(timer);sampler.stop();record();delay.disable();
 const elapsedMs=performance.now()-start,cpu=process.cpuUsage(cpuStart);
 const values=rss.map(s=>s.rssBytes);
 console.log(JSON.stringify({mode:enabled?'telemetry_enabled':'baseline_disabled',startedAt,endedAt:new Date().toISOString(),elapsedMs,cpu:{userMicroseconds:cpu.user,systemMicroseconds:cpu.system,totalMicroseconds:cpu.user+cpu.system,percentOfOneLogicalCore:((cpu.user+cpu.system)/1000)/elapsedMs*100},rss:{minBytes:Math.min(...values),maxBytes:Math.max(...values),meanBytes:values.reduce((a,b)=>a+b,0)/values.length,samples:rss},eventLoopDelay:{meanMs:Number.isFinite(delay.mean)?delay.mean/1e6:null,p99Ms:delay.percentile(99)/1e6,maxMs:delay.max/1e6},telemetrySampleCount:observations.size}));
}else{
 const run=mode=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--worker',mode],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
  child.on('error',reject);child.on('exit',code=>{if(code!==0)return reject(Error('Pilot child failed: '+errors));try{resolve(JSON.parse(output));}catch(e){reject(e);}});
 });
 let codeSha=null,worktreeModified=null;
 try{codeSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();worktreeModified=Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim());}catch{}
 const runs=[];for(const mode of ['disabled','enabled'])runs.push(await run(mode));
 const result={schemaVersion:1,status:'PILOT',scope:'isolated_reference_telemetry_sampler_process',codeSha,worktreeModified,environment:{platform:process.platform,architecture:process.arch,nodeVersion:process.version},protocol:{durationMsPerProcess:durationMs,telemetryIntervalMs:3000,rssIntervalMs:1000,order:['baseline_disabled','telemetry_enabled'],repetitionsPerMode:1,cpuDenominator:'one_logical_core',command:'node scripts/resource-pilot.mjs'},limitations:['Single sequential pair on a shared host; workload noise and order effects are uncontrolled.','Measures sampler processes only; excludes Gateway, heartbeat transport, Web, Android, mDNS and BLE.','No whole-application or causal overhead conclusion is supported.','RSS includes the Node runtime and imported modules; process startup before worker measurement is excluded.'],runs};
 await mkdir('evidence/raw/v0.2',{recursive:true});
 await writeFile('evidence/raw/v0.2/resource-pilot.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({status:result.status,runs:runs.map(({mode,cpu,rss,telemetrySampleCount})=>({mode,cpu,rssMeanBytes:rss.meanBytes,telemetrySampleCount}))}));
}
