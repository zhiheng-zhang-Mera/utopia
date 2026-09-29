import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { checkpointGate, unboundCheckpointPort } from '../city/02-engineering/04-restart-recovery-station/checkpoint-gate/index.mjs';

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
 * City Core consumption (MB-006).
 *
 * The gateway no longer decides by an inline state test whether work interrupted by a
 * restart may resume: the migrated `city/02-engineering/04-restart-recovery-station/
 * checkpoint-gate` module does. Utopia's policy travels as data — a task still QUEUED never
 * started, so no checkpoint is required and the gate authorizes it; a task that had started
 * would lose work, and Utopia binds no checkpoint port, so the donor's fail-closed default
 * refuses it. This test proves the restart sweep is real and that the Core reaches the same
 * verdict for the same policy.
 */
test('the post-restart resume decision is owned by the migrated checkpoint gate', async () => {
  const dir = await mkdtemp(resolve('.scratch-restart-'));
  let app;
  try {
    app = await createGateway({ host:'127.0.0.1', port:0, dir, token:'ctl', nodeToken:'nd' });
    const request = (path, body, token='ctl') => fetch(app.url+'/api/v0/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:body?JSON.stringify(body):undefined});
    const node = (path, data) => request('node/'+path, data, 'nd');

    // A task that starts, and one that is never claimed. The first claim takes the first
    // QUEUED task, so the started one is created first and the queued one is left alone.
    const started = await (await request('tasks',{type:'WAIT'})).json();
    const queued = await (await request('tasks',{type:'WAIT'})).json();
    await node('register',{id:'n1',displayName:'n1',metadata:{platform:'reference'},capabilities:['task.execute.safe','filesystem.temp']});
    const claimed = await (await node('claim',{id:'n1'})).json();
    assert.equal(claimed.task.id,started.id,'the started task is the one that was claimed');
    const running = await node('report',{id:'n1',taskId:started.id,state:'RUNNING',progress:10});
    assert.equal(running.status,200);
    assert.equal((await running.json()).state,'RUNNING');

    // Restart the gateway on the same store: the sweep runs at boot.
    await app.close();
    app = await createGateway({ host:'127.0.0.1', port:0, dir, token:'ctl', nodeToken:'nd' });

    assert.equal((await (await request('tasks/'+queued.id)).json()).state,'QUEUED','work that never started stays queued');
    const after = await (await request('tasks/'+started.id)).json();
    assert.equal(after.state,'FAILED');
    assert.equal(after.error,'Gateway restarted during execution; create a new task to retry safely.');

    // The Core, given the same policy and the same two states, reaches the same two verdicts.
    const gate = checkpointGate({ port: unboundCheckpointPort(), timeoutMs: 0 });
    assert.equal((await gate.prepare('application', false)).authorized, true, 'nothing to lose means no checkpoint is required');
    assert.equal((await gate.prepare('application', true)).authorized, false, 'a bound-less checkpoint means cannot verify, so do not resume');
  } finally { if(app) await app.close(); await rm(dir,{recursive:true,force:true}); }
});
