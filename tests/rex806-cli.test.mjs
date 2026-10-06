import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

async function exportFixture(mode) {
  const dir=await mkdtemp(join(tmpdir(),'rex806-cli-review-'));
  const config=join(dir,'fixture-config.json');
  await writeFile(config,JSON.stringify({token:'synthetic-fixture-only'}));
  const campaign={campaignId:'campaign-readable',scenarioId:'WAIT',state:'COMPLETED',totalRuns:1,repetitions:1,warmup:0,context:{manifest:{workers:['worker-a']}},runs:[{index:0,state:'MEASURED',measured:true,warmup:false,result:{taskRef:'Q-readable',state:'COMPLETED',assignedNodeId:'worker-a'}}],summary:{planned:1,accounted:1,measured:1,failed:0,timedOut:0,warmup:0}};
  const server=createServer((req,res)=>{
    let body;
    if(req.url==='/api/v0/city') body={cityId:'fixture-city',status:'ONLINE',nodes:[],members:[{deviceId:'device-a',installationId:'installation-a'},{deviceId:'device-b',nodeId:'node-b'}],tasks:[{id:'Q-readable',state:'COMPLETED',createdAt:'2026-10-07T00:00:00Z',updatedAt:'2026-10-07T00:00:01Z'}],events:[]};
    else if(req.url==='/api/v0/research/campaigns') body={receipts:[{campaignId:'campaign-readable'},...(mode==='corrupt'?[{file:'campaign-broken.json',state:'UNREADABLE',reason:'RECEIPT_UNREADABLE'}]:[])],experiments:[],live:mode==='missing'?{campaignId:'campaign-lost',state:'COMPLETED'}:null};
    else if(req.url==='/api/v0/research/campaigns/campaign-readable') body={campaign};
    else if(req.url==='/api/v0/research/trace') body={trace:{records:[]}};
    else {res.writeHead(404);res.end('{}');return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const child=spawn(process.execPath,[resolve('scripts/export-research-artifact.mjs'),'--city','http://127.0.0.1:'+server.address().port,'--config',config,'--out',join(dir,'artifact')]);
    let stderr='';child.stdout.resume();child.stderr.on('data',b=>stderr+=b);
    const code=await new Promise((r,j)=>{child.on('error',j);child.on('close',r);});
    const topology=JSON.parse(await readFile(join(dir,'artifact/topology.json'),'utf8'));
    const failures=JSON.parse(await readFile(join(dir,'artifact/failures.json'),'utf8'));
    return {code,stderr,topology,failures};
  } finally {await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
}

test('REX806 CLI retains canonical deviceId members in the downloaded topology',async()=>{
  const out=await exportFixture('healthy');assert.equal(out.code,0);assert.deepEqual(out.topology.members,['device-a','device-b']);
});
test('REX806 CLI partial download itself names an unreadable receipt without requiring terminal output',async()=>{
  const out=await exportFixture('corrupt');assert.equal(out.code,1);
  assert.ok(out.failures.failures.sourceReadFailures?.some(x=>x.name==='campaign-broken.json'&&x.reason==='RECEIPT_UNREADABLE'));
});
test('REX806 CLI partial download itself names the latest missing receipt',async()=>{
  const out=await exportFixture('missing');assert.equal(out.code,1);
  assert.ok(out.failures.failures.sourceReadFailures?.some(x=>x.name==='campaign-lost'&&x.reason==='LATEST_RECEIPT_MISSING'));
});
