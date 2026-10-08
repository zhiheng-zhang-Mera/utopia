import test from 'node:test';
import assert from 'node:assert/strict';
const feature=await import('../services/dev-gateway/owner-control-intents.mjs').catch(()=>({}));
const context={isOwner:true,nodes:[{id:'dev-alien',displayName:'Alien',online:true},{id:'dev-mech',displayName:'Mech',online:true}],remoteOperation:{enabled:true,allowlist:['git','node'],workspaces:['D:/work']},agentJob:{enabled:true}};
const prepare=(request,ctx=context)=>{assert.equal(typeof feature.prepareOwnerControlAsk,'function','owner control draft resolver must exist');return feature.prepareOwnerControlAsk(request,ctx);};

test('Chinese remote request produces an editable draft, without guessing purpose or cwd',()=>{
 const out=prepare({text:'在 Alien 上运行 git 查看版本'});
 assert.equal(out.status,'DRAFT_REQUIRED');assert.equal(out.action,null);assert.equal(out.draft.kind,'REMOTE_OPERATION');
 assert.equal(out.draft.targetDeviceRef,'dev-alien');assert.equal(out.draft.operation.executable,'git');
 assert.deepEqual(out.draft.operation.argv,['--version']);assert.equal(out.draft.operation.cwd,'');assert.equal(out.draft.operation.purpose,'');
 assert.ok(out.draft.missingFields.includes('cwd'));assert.ok(out.draft.missingFields.includes('purpose'));
});
test('explicit English quoted fields and JSON argv are data, including shell punctuation',()=>{
 const out=prepare({text:'run git on Alien; cwd "D:/work"; purpose "check literal arguments"; argv ["log", "--grep=a; b"]',confirm:true});
 assert.equal(out.status,'DRAFT_REQUIRED');assert.equal(out.action,null);assert.deepEqual(out.draft.operation.argv,['log','--grep=a; b']);
 assert.equal(out.draft.operation.cwd,'D:/work');assert.equal(out.draft.operation.purpose,'check literal arguments');
});
test('Agent request carries the actual instruction and still needs a title/purpose',()=>{
 const out=prepare({text:'让 Alien 的 Agent 检查项目测试'});
 assert.equal(out.draft.kind,'AGENT_JOB');assert.equal(out.draft.targetDeviceRef,'dev-alien');assert.equal(out.draft.job.instruction,'检查项目测试');
 assert.equal(out.draft.job.title,'');assert.equal(out.draft.job.purpose,'');assert.equal(out.action,null);
});
test('device name ambiguity remains unselected, even if both are online',()=>{
 const out=prepare({text:'run git on Alien'}, {...context,nodes:[{id:'a',displayName:'Alien-PC',online:true},{id:'b',displayName:'Alien-Laptop',online:true}]});
 assert.equal(out.draft.targetDeviceRef,'');assert.equal(out.draft.nodeMatchState,'AMBIGUOUS');assert.equal(out.draft.deviceCandidates.length,2);
});
test('unknown program is carried for review, never silently replaced with an allowed one',()=>{
 const out=prepare({text:'run cmd on Alien'});assert.equal(out.draft.operation.executable,'cmd');assert.ok(out.draft.missingFields.includes('allowlisted executable'));
});
test('member cannot prepare owner controls, including a forged selection/confirm',()=>{
 for(const operation of ['OWNER_REMOTE_OPERATION','AGENT_JOB'])assert.throws(()=>prepare({text:'anything',selection:{route:'CITY_TASK',target:'city.task',operation},confirm:true},{...context,isOwner:false}),e=>e.status===403&&e.code.endsWith('OWNER_REQUIRED'));
});
test('switch OFF is unavailable, not successful and not an executable draft',()=>{
 const out=prepare({text:'run git on Alien'}, {...context,remoteOperation:{enabled:false}});assert.equal(out.status,'UNAVAILABLE');assert.equal(out.draft,null);assert.equal(out.action,null);
});
test('legacy commands fall through unchanged and two owner targets are discoverable',()=>{
 for(const selection of [{route:'CITY_TASK',target:'city.task',operation:'WAIT'},{route:'ROOM',target:'knowledge',operation:'knowledge.search'},{route:'CAPABILITY',target:'capability',operation:'query'}])assert.equal(prepare({text:'run git on Alien',selection,confirm:true}),null,'explicit manual selection wins');
 assert.equal(prepare({text:'hash D:/file.txt'}),null);assert.equal(typeof feature.ownerControlTargets,'function');
 const targets=feature.ownerControlTargets(context);assert.equal(targets.length,2);assert.ok(targets.every(t=>t.sideEffect===true&&t.route==='CITY_TASK'));
 assert.ok(feature.ownerControlTargets({...context,isOwner:false}).every(t=>t.available===false));
});
