import {spawn,execFileSync} from 'node:child_process';
import {realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {bindEngineeringExecutor} from './engineering-executor-adapter.mjs';
import {requireThat as ok,copy,freeze} from './validation.mjs';

export function buildCodexInvocation({workspace,prompt,resumeSession}={}){
 ok(!resumeSession,'OWNED_SESSION_RESUME_UNSUPPORTED');ok(typeof workspace==='string'&&typeof prompt==='string'&&prompt.length<=16384,'CLI_INPUT');
 return {args:['exec','--ignore-user-config','--json','--sandbox','workspace-write','--cd',workspace,'-'],stdin:prompt};
}
async function verifyWorkspace(request){
 ok(isAbsolute(request.isolatedWorktree)&&/^[a-f0-9]{40}$/.test(request.baseSha),'ISOLATED_WORKTREE_REQUIRED');
 const cwd=await realpath(request.isolatedWorktree);
 const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:65536}).trim();
 ok(await realpath(git('rev-parse','--show-toplevel'))===cwd,'WORKTREE_ROOT');
 ok(git('rev-parse','HEAD')===request.baseSha,'BASE_SHA_MISMATCH');
 ok(git('status','--porcelain')==='','DIRTY_WORKTREE_SNAPSHOT_REQUIRED');
 // Require a linked worktree, not a caller's primary checkout.
 ok(git('rev-parse','--git-dir')!==git('rev-parse','--git-common-dir'),'ISOLATED_WORKTREE_REQUIRED');
 return {baseSha:request.baseSha,workspace:cwd};
}

/** Owned process handles only; canonical tasks remain in the injected City service. */
export function createEngineeringRuntime(options={}){
 options={...options,environment:freeze(copy(options.environment??{})),fixtureArgs:options.fixtureArgs?freeze(copy(options.fixtureArgs)):undefined};
 const {executable='codex',approved=false,authReady=false,componentFixture=false,fixtureArgs,validateWorkspace=verifyWorkspace,hostId=null,bootId=null,maxBytes=1048576,maxEvents=2048,timeoutMs=60000,callbackTimeoutMs=5000,environment={},onStart,persistReceipt}=options;
 ok(Number.isSafeInteger(callbackTimeoutMs)&&callbackTimeoutMs>0&&callbackTimeoutMs<=60000,'CALLBACK_BOUNDS');
 ok(Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=4194304&&Number.isSafeInteger(maxEvents)&&maxEvents>0&&maxEvents<=4096&&Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=3600000,'RUNTIME_BOUNDS');
 ok(!fixtureArgs||componentFixture,'FIXTURE_ONLY');
 ok(!options.validateWorkspace||componentFixture,'FIXTURE_ONLY');
 ok(!componentFixture||executable===process.execPath,'FIXTURE_EXECUTABLE');
 ok(componentFixture||(typeof onStart==='function'&&typeof persistReceipt==='function')||!approved,'DURABLE_OWNER_CALLBACKS_REQUIRED');
 const runs=new Map(),attempts=new Set();
 const ready=approved&&(authReady||componentFixture);
 const get=id=>{ok(runs.has(id),'OWNED_SESSION_REQUIRED');return runs.get(id);};
 const snapshot=run=>({...run.evidence,state:run.state,processClosed:run.closed,durableReceipt:run.durableReceipt===true,ownedStartPersisted:run.ownedStartPersisted===true,exitCode:run.exitCode,signal:run.signal,backendSessionId:run.backendSessionId,reason:run.reason,eventCount:run.events.length,bytes:run.bytes,processTreeTermination:'NOT_PROVEN',unknownSideEffects:true,providerInference:'NOT_MEASURED'});
 async function boundedOwnerCallback(callback,run,phase){
  const controller=new AbortController();let current=true,timer;
  const context=Object.freeze({signal:controller.signal,fenceId:randomUUID(),sessionId:run.evidence.sessionId,taskId:run.evidence.taskId,attemptId:run.evidence.attemptId,phase,isCurrent:()=>current&&!controller.signal.aborted});
  const operation=Promise.resolve().then(()=>callback(freeze(copy(snapshot(run))),context));
  const deadline=new Promise((_resolve,reject)=>{timer=setTimeout(()=>{current=false;controller.abort();reject(Object.assign(new Error(phase+'_TIMEOUT'),{code:phase+'_TIMEOUT'}));},callbackTimeoutMs);});
  try{return await Promise.race([operation,deadline]);}finally{clearTimeout(timer);current=false;}
 }
 const api={
  async probe(){return {state:'UNKNOWN',installation:'NOT_PROBED',realProviderAcceptance:'NOT_RUN'};},
  async version(){return {version:null,state:'NOT_RUN'};},
  async auth(){return {state:authReady?'READY':'UNKNOWN',credentialRead:false};},
  async readiness(){return {state:ready?'READY':'NOT_READY',realProviderAcceptance:'NOT_RUN',reason:ready?null:'EXPLICIT_PROVIDER_APPROVAL_AND_AUTH_REQUIRED'};},
  capabilities(){return {operations:['code.generate','code.review'],controls:['CANCEL'],resume:'UNSUPPORTED'};},
  async startOrAttach(request={}){ok(!request.backendSessionId&&!request.backend_run_ref,'OWNED_SESSION_REQUIRED');ok(request.sessionId,'EXPLICIT_OWNED_SESSION_REQUIRED');return snapshot(get(request.sessionId));},
  async submit(request){
   request=freeze(copy(request));
   ok(ready,'REAL_PROVIDER_UNAVAILABLE');ok(request.approved===true&&typeof request.taskId==='string'&&typeof request.attemptId==='string','ENGINEERING_APPROVAL_REQUIRED');
   ok(runs.size<256,'OWNED_SESSION_LIMIT');ok(!attempts.has(request.attemptId),'DUPLICATE_ATTEMPT');const validated=freeze(copy(await validateWorkspace(request)));ok(validated.baseSha===request.baseSha&&isAbsolute(validated.workspace),'WORKSPACE_VALIDATION_RESULT');request=freeze({...request,isolatedWorktree:validated.workspace,baseSha:validated.baseSha});ok(!attempts.has(request.attemptId),'DUPLICATE_ATTEMPT');ok(runs.size<256,'OWNED_SESSION_LIMIT');
   const plan=buildCodexInvocation({workspace:request.isolatedWorktree,prompt:request.prompt});
   const env={};for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
   for(const [key,value] of Object.entries(environment)){ok(['CODEX_HOME','HOME','USERPROFILE'].includes(key)&&typeof value==='string','ENV_ALLOWLIST');env[key]=value;}
   ok(componentFixture||isAbsolute(env.CODEX_HOME??''),'ISOLATED_CODEX_HOME_REQUIRED');
   const sessionId=randomUUID();const run={state:'RUNNING',closed:false,exitCode:null,signal:null,backendSessionId:null,reason:null,events:[],bytes:0,evidence:{sessionId,taskId:request.taskId,attemptId:request.attemptId,hostId,bootId,baseSha:request.baseSha,worktree:request.isolatedWorktree,pid:null,evidenceClass:componentFixture?'REAL_SUBPROCESS_COMPONENT_FIXTURE':'REAL_PROVIDER_ACCEPTANCE_NOT_RUN'}};
   const child=spawn(executable,fixtureArgs??plan.args,{cwd:request.isolatedWorktree,env,shell:false,stdio:['pipe','pipe','pipe'],windowsHide:true});attempts.add(request.attemptId);runs.set(sessionId,run);run.child=child;run.evidence.pid=child.pid??null;
   let pending='';const decoder=new StringDecoder('utf8');const stop=reason=>{run.reason??=reason;child.kill();};
   const timer=setTimeout(()=>stop('TIMEOUT'),timeoutMs);
   child.stdout.on('data',chunk=>{
    run.bytes+=chunk.length;if(run.bytes>maxBytes){stop('OUTPUT_LIMIT');return;}pending+=decoder.write(chunk);
    let split;while((split=pending.indexOf('\n'))>=0){const line=pending.slice(0,split);pending=pending.slice(split+1);if(!line.trim())continue;
     try{const event=JSON.parse(line);ok(event&&typeof event==='object'&&!Array.isArray(event),'JSONL_OBJECT');if(run.events.length>=maxEvents){stop('EVENT_LIMIT');return;}run.events.push(event);if(event.type==='thread.started'&&typeof event.thread_id==='string'){ok(!run.backendSessionId||run.backendSessionId===event.thread_id,'SESSION_CHANGED');run.backendSessionId=event.thread_id;}}catch{stop('INVALID_JSONL');}
    }
   });
   child.stderr.on('data',chunk=>{run.bytes+=chunk.length;if(run.bytes>maxBytes)stop('OUTPUT_LIMIT');});
   child.stdin.on('error',()=>{});
   let startSettled;const startGate=new Promise(resolve=>{startSettled=resolve;});
   run.done=new Promise(resolve=>{child.on('error',()=>{run.reason??='SPAWN_FAILED';});child.on('close',async(code,signal)=>{clearTimeout(timer);run.closed=true;run.exitCode=code;run.signal=signal;await startGate;const completed=run.events.some(e=>e.type==='turn.completed');if(pending.trim())run.reason??='TRUNCATED_JSONL';run.state=run.reason==='OWNED_START_PERSISTENCE_TIMEOUT'?'ATTENTION':run.reason==='CANCEL_REQUESTED'?'CANCELLED':code===0&&!run.reason&&completed&&run.backendSessionId?'SUCCEEDED':'FAILED';if(typeof persistReceipt==='function')try{await boundedOwnerCallback(persistReceipt,run,'RECEIPT_PERSISTENCE');run.durableReceipt=run.state!=='ATTENTION';}catch(error){run.reason=error.code==='RECEIPT_PERSISTENCE_TIMEOUT'?error.code:'RECEIPT_PERSISTENCE_FAILED';run.state='ATTENTION';}resolve(snapshot(run));});});
   try{if(typeof onStart==='function'){await boundedOwnerCallback(onStart,run,'OWNED_START_PERSISTENCE');run.ownedStartPersisted=true;}startSettled();if(!run.closed&&!run.reason)child.stdin.end(componentFixture?'':plan.stdin);}catch(error){run.reason=error.code==='OWNED_START_PERSISTENCE_TIMEOUT'?error.code:'OWNED_START_PERSISTENCE_FAILED';startSettled();child.kill();await run.done;}
   return snapshot(run);
  },
  async events({sessionId,cursor=0}){const run=get(sessionId);ok(Number.isSafeInteger(cursor)&&cursor>=0&&cursor<=run.events.length,'EVENT_CURSOR');return {sessionId,events:structuredClone(run.events.slice(cursor)),cursor:run.events.length};},
  async result({sessionId}){const run=get(sessionId);ok(run.closed&&run.durableReceipt,'DURABLE_RECEIPT_REQUIRED');return snapshot(run);},
  async wait(sessionId){return get(sessionId).done;},
  async control({sessionId,operation}){ok(operation==='CANCEL','UNSUPPORTED_OPERATION');const run=get(sessionId);if(!run.closed){run.reason??='CANCEL_REQUESTED';run.child.kill();}return {applied:run.closed,requested:true,processClosed:run.closed,unknownSideEffects:true};},
  async health(){return {state:ready?'READY':'NOT_READY',active:[...runs.values()].filter(r=>!r.closed).length,realProviderAcceptance:'NOT_RUN',restartRecovery:'UNSUPPORTED'};},
 };
 return Object.freeze(api);
}
export function bindEngineeringRuntime(options,manifest={version:1,id:'codex-cli-pcf-candidate'}){return bindEngineeringExecutor(createEngineeringRuntime(options),manifest);}
