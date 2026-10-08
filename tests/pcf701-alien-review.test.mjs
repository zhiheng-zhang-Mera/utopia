import test from 'node:test';
import assert from 'node:assert/strict';
import {createSystemAdapter} from '../services/personal-compute-fabric/adapters.mjs';

const windowsAdapter = (snapshots) => {
  let index=0;
  return createSystemAdapter({os:{platform:()=> 'win32',totalmem:()=>100,freemem:()=>50,loadavg:()=>[0,0,0],cpus:()=>snapshots[Math.min(index++,snapshots.length-1)]},statfsFn:async()=>({bsize:1,blocks:100,bavail:50})});
};
const cpu=(user,idle)=>[{times:{user,nice:0,sys:0,irq:0,idle}}];

test('Alien CPU: Windows warmup must not publish the loadavg placeholder zero',async()=>{
  const result=await windowsAdapter([cpu(100,100)]).sample(1000);
  assert.equal(result.sample.cpu,undefined);
  assert.ok(result.notes.some(x=>x.includes('cpu')));
});
test('Alien CPU: Windows samples a real counter interval instead of loadavg zeros',async()=>{
  const adapter=windowsAdapter([cpu(100,100),cpu(150,150)]);
  await adapter.sample(1000);const result=await adapter.sample(1100);
  assert.equal(result.sample.cpu.value,0.5);
  assert.ok(result.sample.cpu.source.includes('cpu-time'));
});
test('Alien CPU: counter reset is unknown and reestablishes the next interval',async()=>{
  const adapter=windowsAdapter([cpu(100,100),cpu(10,10),cpu(20,20)]);
  await adapter.sample(1000);assert.equal((await adapter.sample(1100)).sample.cpu,undefined);
  assert.equal((await adapter.sample(1200)).sample.cpu.value,0.5);
});
test('Alien CPU: absent or unchanged counters never claim an observed zero',async()=>{
  for(const snapshots of [[[],[]],[cpu(1,1),cpu(1,1)]]){
    const adapter=windowsAdapter(snapshots);await adapter.sample(1000);
    assert.equal((await adapter.sample(1100)).sample.cpu,undefined);
  }
});
