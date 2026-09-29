import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetrySampler } from '../agents/reference-node/telemetry.mjs';
import { readDisk } from '../platform/windows/telemetry.mjs';
import { validateTelemetry } from '../contracts/pairing-v1/descriptor.mjs';
test('CPU uses elapsed counters and unavailable disk remains null',async()=>{
 let idle=100,user=100;
 const sampler=createTelemetrySampler({os:{cpus:()=>[{times:{idle,user}}],totalmem:()=>1000,freemem:()=>400,uptime:()=>42},disk:async()=>{throw Error('unavailable');}});
 const first=await sampler.sample(); assert.equal(first.cpu.usagePercent,null);
 idle+=25;user+=75;const second=await sampler.sample();assert.equal(second.cpu.usagePercent,75);
 assert.deepEqual(second.memory,{usedBytes:600,totalBytes:1000});assert.equal(second.disk.totalBytes,null);assert.equal(second.uptimeSeconds,42);
});
test('disabled sampler never reads host counters',async()=>{
 const sampler=createTelemetrySampler({enabled:false,os:{cpus:()=>{throw Error('read');}}});
 assert.equal(await sampler.sample(),null);assert.equal(sampler.latest(),null);sampler.stop();
});
test('counter reset does not fabricate CPU load and cached sample keeps its timestamp',async()=>{
 let counter=100;let stamp=0;
 const sampler=createTelemetrySampler({os:{cpus:()=>[{times:{idle:counter,user:counter}}],totalmem:()=>100,freemem:()=>40,uptime:()=>2},disk:async()=>({usedBytes:40,freeBytes:60,totalBytes:100}),now:()=>new Date(stamp++)});
 await sampler.sample();counter=10;const next=await sampler.sample();assert.equal(next.cpu.usagePercent,null);
 assert.equal(sampler.latest().observedAt,next.observedAt);assert.equal(stamp,2);sampler.stop();
});
test('native filesystem volume measurement is finite and internally consistent',async()=>{
 const disk=await readDisk();assert.ok(disk.totalBytes>0);assert.ok(disk.freeBytes>=0);assert.equal(disk.usedBytes+disk.freeBytes,disk.totalBytes);
});
test('validator accepts unavailable sampler metrics but rejects invalid numeric measurements',async()=>{
 const unavailable=()=>{throw Error('unavailable');};
 const sampler=createTelemetrySampler({os:{cpus:unavailable,totalmem:unavailable,freemem:unavailable,uptime:unavailable},disk:async()=>{throw Error('unavailable');}});
 const sample=await sampler.sample();assert.doesNotThrow(()=>validateTelemetry(sample));
 assert.deepEqual(sample.disk,{usedBytes:null,freeBytes:null,totalBytes:null});
 for(const invalid of [-1,NaN,Infinity]){
  assert.throws(()=>validateTelemetry({...sample,uptimeSeconds:invalid}));
  assert.throws(()=>validateTelemetry({...sample,memory:{usedBytes:invalid,totalBytes:100}}));
  assert.throws(()=>validateTelemetry({...sample,disk:{usedBytes:0,freeBytes:invalid,totalBytes:100}}));
 }
 assert.throws(()=>validateTelemetry({...sample,memory:{usedBytes:101,totalBytes:100}}));
 assert.throws(()=>validateTelemetry({...sample,disk:{usedBytes:0,freeBytes:101,totalBytes:100}}));
 assert.throws(()=>validateTelemetry({...sample,cpu:{usagePercent:101}}));sampler.stop();
});
