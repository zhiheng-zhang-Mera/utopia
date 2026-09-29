import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { REQUIRED_TASK_CAPABILITIES } from '../services/dev-gateway/server.mjs';
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
 * module. Two things are proved separately, because they can fail separately:
 *
 *   - the gateway's *policy* is the expected one (a fixed-expectation table over the
 *     gateway's own HTTP responses, including a case that only passes if both
 *     `task.execute.safe` and `filesystem.temp` are still required);
 *   - the gateway's *decision procedure* is the Core's (the running gateway agrees with
 *     a direct `acceptsWork` call for the same node shape, using the policy the gateway
 *     itself exports so the two halves cannot drift apart silently).
 */
function gatewayProbe(app) {
  const request = (path, body, token='ctl-token') => fetch(app.url+'/api/v0/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:body?JSON.stringify(body):undefined});
  return { request, node:(path,data)=>request('node/'+path,data,'node-token') };
}

/** What the migrated Core says about a node with this liveness and these capabilities. */
const coreSays = (online, capabilities) => acceptsWork(
  { nodeId:'probe', state: online ? 'READY' : 'OFFLINE', capabilities, lastHeartbeatAt:0, seq:0 },
  { requiredCapabilities:REQUIRED_TASK_CAPABILITIES },
);

test('the gateway places work on exactly the nodes its own policy and the Core both accept', async () => {
  const dir = await mkdtemp(resolve('.scratch-core-'));
  let app;
  try {
    app = await createGateway({ host:'127.0.0.1', port:0, dir, token:'ctl-token', nodeToken:'node-token', heartbeatTimeout:50 });
    const { request, node } = gatewayProbe(app);
    const register = (id, capabilities) => node('register',{id,displayName:id,metadata:{platform:'reference'},capabilities});
    const claim = async (id) => (await (await node('claim',{id})).json()).task;

    // Fixed expectations first: these are the outcomes the policy must produce, stated
    // independently of the Core so a wrong REQUIRED_TASK_CAPABILITIES cannot satisfy them.
    assert.deepEqual([...REQUIRED_TASK_CAPABILITIES].sort(), ['filesystem.temp','task.execute.safe'],
      'the gateway requires both capabilities the original inline predicate required');

    const partial = await (await request('tasks',{type:'WAIT'})).json();
    await register('n-partial',['task.execute.safe']);
    assert.equal(await claim('n-partial'), null,
      'a node offering only one of the two required capabilities is refused even when it is the only node and work is waiting');
    assert.equal((await (await request('tasks/'+partial.id)).json()).state, 'QUEUED');
    assert.equal((await (await request('tasks/'+partial.id)).json()).assignedNodeId, null);

    // The work the partial node was refused is exactly the work the capable node gets.
    await register('n-full',['task.execute.safe','filesystem.temp']);
    assert.equal((await claim('n-full')).id, partial.id, 'an online fully capable node is placed on the work the partial node left queued');
    assert.equal(await claim('n-full'), null, 'a busy node is not given a second task');

    // Now the same cases asked directly of the migrated Core: the gateway's decision
    // procedure must be the Core's, so the two must agree on every probe.
    assert.equal(coreSays(true,['task.execute.safe']), false, 'the Core refuses the partial node');
    assert.equal(coreSays(true,['task.execute.safe','filesystem.temp']), true, 'the Core accepts the fully capable node');

    // Silence the node: the gateway marks it offline, and the Core refuses OFFLINE
    // whatever capabilities the node still lists.
    await new Promise((r)=>setTimeout(r,1200));
    const nodes = await (await request('nodes')).json();
    assert.equal(nodes.nodes.find((n)=>n.id==='n-full').online, false, 'the gateway marks a silent node offline');
    assert.equal(coreSays(false,['task.execute.safe','filesystem.temp']), false, 'the Core refuses an offline node whatever it lists');
    const queued = await (await request('tasks',{type:'WAIT'})).json();
    assert.equal(await claim('n-full'), null, 'an offline node is refused even though it lists the capabilities');
    assert.equal((await (await request('tasks/'+queued.id)).json()).state, 'QUEUED', 'the refused work stays queued');
    assert.equal((await (await request('tasks/'+queued.id)).json()).assignedNodeId, null);
  } finally { if(app) await app.close(); await rm(dir,{recursive:true,force:true}); }
});

/**
 * Restart / recovery durability (MB-001 Verification gate: 重启/恢复后 durable
 * task/audit 身份不被伪造为成功).
 *
 * Work that was genuinely started and then interrupted by a gateway restart must be
 * reported as FAILED with its real progress and its original identity, and must never
 * be resurrected as a completed task or replayed by a fresh process. The interrupted
 * task's id is captured before the restart and asserted afterwards, so a restart that
 * silently minted a new identity would fail this test.
 */
test('an interrupted task is never falsified as success across a gateway restart', async () => {
  const dir = await mkdtemp(resolve('.scratch-restart-'));
  let app;
  try {
    app = await createGateway({ host:'127.0.0.1', port:0, dir, token:'ctl-token', nodeToken:'node-token' });
    const request = (path, body, token='ctl-token') => fetch(app.url+'/api/v0/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:body?JSON.stringify(body):undefined});
    const node = (path, data) => request('node/'+path, data, 'node-token');

    const task = await (await request('tasks',{type:'WAIT'})).json();
    await node('register',{id:'n-restart',displayName:'n-restart',metadata:{platform:'reference'},capabilities:['task.execute.safe','filesystem.temp']});
    assert.equal((await (await node('claim',{id:'n-restart'})).json()).task.id, task.id);
    assert.equal((await (await node('report',{id:'n-restart',taskId:task.id,state:'RUNNING',progress:20})).json()).state,'RUNNING');

    // The process dies with the task genuinely in flight.
    await app.close();
    app = await createGateway({ host:'127.0.0.1', port:0, dir, token:'ctl-token', nodeToken:'node-token' });

    const recovered = await (await request('tasks/'+task.id)).json();
    assert.equal(recovered.id, task.id, 'the durable identity survives the restart unchanged');
    assert.notEqual(recovered.state, 'COMPLETED', 'interrupted work is not falsified as success');
    assert.equal(recovered.state, 'FAILED');
    assert.equal(recovered.progress, 20, 'the reported progress is kept, not rounded up');
    assert.match(recovered.error, /restarted during execution/);

    const nodes = await (await request('nodes')).json();
    assert.equal(nodes.nodes.find((n)=>n.id==='n-restart').online, false, 'a restarted gateway assumes no node is still online');
    assert.equal((await (await node('claim',{id:'n-restart'})).json()).task, null, 'an offline node cannot take fresh work');

    const events = await (await request('events')).json();
    assert.ok(events.events.some((e)=>e.taskId===task.id && e.type==='TASK_FAILED'), 'the failure is journaled, not silent');

    // The audit journal is itself durable and ordered across the restart.
    const created = events.events.findIndex((e)=>e.taskId===task.id && e.type==='TASK_CREATED');
    const failed = events.events.findIndex((e)=>e.taskId===task.id && e.type==='TASK_FAILED');
    assert.ok(created >= 0 && failed > created, 'recovery appends after the original history rather than replacing it');
  } finally { if(app) await app.close(); await rm(dir,{recursive:true,force:true}); }
});
