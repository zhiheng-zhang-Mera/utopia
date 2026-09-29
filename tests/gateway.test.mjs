import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';

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
  } finally { if(app) await app.close(); await rm(dir,{recursive:true,force:true}); }
});
