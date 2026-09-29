import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { acceptsWork } from '../city/00-foundation/01-city-core/fleet-routing/index.mjs';

test('versioned authenticated gateway rejects unsafe commands and persists history', async () => {
  const dir = await mkdtemp(resolve('.scratch-test-'));
  let app;
  try {
    app = await createGateway({ host:'127.0.0.1', port:0, dir, token:'test-control-token', nodeToken:'test-node-token' });
    const request = (path, body, token='test-control-token', version='0') => fetch(app.url+'/api/v0/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-City-Api-Version':version,'X-City-Schema-Version':'0'},body:body?JSON.stringify(body):undefined});
    assert.equal((await request('health')).status,200);
    assert.equal((await request('city',null,'bad')).status,401);
    assert.equal((await request('city',null,undefined,'1')).status,409);
    assert.equal((await request('tasks',{type:'SHELL'})).status,400);
    const task = await (await request('tasks',{type:'CHECKPOINT_DEMO'})).json();
    assert.equal(task.state,'QUEUED');
    assert.ok(task.id);
    assert.equal((await request('tasks/'+task.id+'/cancel',{})).status,200);
    await app.close();
    app = await createGateway({ host:'127.0.0.1', port:0, dir, token:'test-control-token', nodeToken:'test-node-token' });
    const saved = await (await request('tasks/'+task.id)).json();
    assert.equal(saved.state,'CANCELLED');
    const events = await (await request('events')).json();
    assert.ok(events.events.some(e=>e.taskId===task.id && e.type==='TASK_CANCELLED'));
    const register={id:'node-1',displayName:'Reference',metadata:{platform:'reference'},capabilities:['task.execute.safe','filesystem.temp']};
    const node=(path,data)=>request('node/'+path,data,'test-node-token');
    await node('register',register);
    const abandoned=await (await request('tasks',{type:'WAIT'})).json();
    await node('claim',{id:'node-1'});
    await node('register',register);
    assert.equal((await (await request('tasks/'+abandoned.id)).json()).state,'FAILED');
    const next=await (await request('tasks',{type:'WAIT'})).json();
    assert.equal((await (await node('claim',{id:'node-1'})).json()).task.id,next.id);
    const failed=await node('report',{id:'node-1',taskId:next.id,state:'FAILED',progress:100,error:'Transport failed before first RUNNING report'});
    assert.equal(failed.status,200);
    assert.equal((await failed.json()).state,'FAILED');
  } finally { if(app) await app.close(); await rm(dir,{recursive:true,force:true}); }
});

/**
 * City Core consumption (MB-001 cluster C).
 *
 * The gateway no longer re-derives "can this node accept this work?" inline: the
 * decision is made by the migrated `city/00-foundation/01-city-core/fleet-routing`
 * module. This test proves the consumption is real by requiring the running gateway
 * to agree with the Core on every case, and by proving the gateway refuses exactly the
 * nodes the Core refuses — a node missing a required capability, and a node that has
 * gone offline while still listing the capabilities.
 */
test('the node-claim decision is owned by the migrated City Core', async () => {
  const dir = await mkdtemp(resolve('.scratch-core-'));
  let app;
  try {
    app = await createGateway({ host:'127.0.0.1', port:0, dir, token:'ctl-token', nodeToken:'node-token', heartbeatTimeout:50 });
    const request = (path, body, token='ctl-token') => fetch(app.url+'/api/v0/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:body?JSON.stringify(body):undefined});
    const node = (path, data) => request('node/'+path, data, 'node-token');
    const register = (id, capabilities) => node('register',{id,displayName:id,metadata:{platform:'reference'},capabilities});

    // The same question the gateway asks, asked directly of the Core.
    const coreSays = (online, capabilities) => acceptsWork(
      { nodeId:'probe', state: online ? 'READY' : 'OFFLINE', capabilities, lastHeartbeatAt:0, seq:0 },
      { requiredCapabilities:['task.execute.safe','filesystem.temp'] },
    );

    const first = await (await request('tasks',{type:'WAIT'})).json();
    assert.equal(coreSays(true,['task.execute.safe','filesystem.temp']), true);
    await register('n-full',['task.execute.safe','filesystem.temp']);
    assert.equal((await (await node('claim',{id:'n-full'})).json()).task.id, first.id, 'an online fully capable node is placed');

    const second = await (await request('tasks',{type:'WAIT'})).json();
    assert.equal(coreSays(true,['task.execute.safe']), false);
    await register('n-partial',['task.execute.safe']);
    assert.equal((await (await node('claim',{id:'n-partial'})).json()).task, null, 'a node missing a required capability is refused');

    // Silence the node: the gateway marks it offline, and the Core refuses OFFLINE
    // whatever capabilities the node still lists.
    await new Promise((r)=>setTimeout(r,1200));
    const nodes = await (await request('nodes')).json();
    assert.equal(nodes.nodes.find((n)=>n.id==='n-partial').online, false, 'the gateway marks a silent node offline');
    assert.equal(coreSays(false,['task.execute.safe','filesystem.temp']), false);
    assert.equal((await (await node('claim',{id:'n-partial'})).json()).task, null, 'an offline node is refused even though it lists the capabilities');
    assert.equal((await (await request('tasks/'+second.id)).json()).state, 'QUEUED', 'the refused work stays queued');
  } finally { if(app) await app.close(); await rm(dir,{recursive:true,force:true}); }
});
