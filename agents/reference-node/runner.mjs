import {spawn} from 'node:child_process';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/**
 * OWNER_REMOTE_OPERATION - the node half.
 *
 * The City normalised and authorised the operation; this function runs it. It re-checks the one property it can still
 * check cheaply, because a node that blindly trusts a payload is a node that can be talked into anything by anything
 * that can reach it: an operation that does not declare `shell:false` is refused here rather than run.
 *
 * Everything is bounded. Output is capped at the byte ceiling the operation declared and truncation is REPORTED (a
 * silently shortened log is worse than a long one); the timeout kills the child; and while the child runs the node
 * asks the City whether the task is still RUNNING, because a process on another machine can only be stopped from
 * where it runs.
 */
async function executeOwnerOperation(task,report,stepDelay){
 const op=task.operation;
 const refusal=code=>({state:'FAILED',progress:100,error:code});
 if(!op||typeof op!=='object')return refusal('OPERATION_MISSING');
 if(op.shell!==false)return refusal('OPERATION_NOT_SHELL_FREE');
 if(typeof op.executable!=='string'||!Array.isArray(op.argv)||typeof op.cwd!=='string')return refusal('OPERATION_INCOMPLETE');
 const cap=Number.isSafeInteger(op.maxOutputBytes)&&op.maxOutputBytes>0?op.maxOutputBytes:262144;
 const timeoutMs=Number.isSafeInteger(op.timeoutMs)&&op.timeoutMs>0?op.timeoutMs:120000;
 // A fast program can finish before the first status poll, so the ASSIGNED -> RUNNING edge is claimed up front rather
 // than left to a timer. Two things follow from doing it here: the City's transition guard is satisfied, and a City
 // that will not record the start is a City whose output nobody would see - so the program is NOT started at all.
 try{const current=await report({state:'RUNNING',progress:1,lastCheckpoint:{step:'operation-starting'}});if(current&&current.state!=='RUNNING')return {state:'CANCELLED',progress:100,error:'cancelled before start'};}
 catch{return refusal('OPERATION_START_UNOBSERVED');}
 const started=Date.now();
 return await new Promise(resolve=>{
  let stdout='',stderr='',truncated=false,timedOut=false,cancelled=false,settled=false;
  const receipt=(state,exitCode,error)=>({operationDigest:op.operationDigest,state,exitCode,timedOut,stdout,stderr,truncated,durationMs:Date.now()-started,error:error??null});
  let child;
  try{child=spawn(op.executable,[...op.argv],{shell:false,cwd:op.cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});}
  catch(error){return resolve({state:'FAILED',progress:100,error:'SPAWN_FAILED',result:receipt('FAILED',null,String(error.message??error))});}
  const append=(stream,chunk)=>{
   const bytes=Buffer.from(chunk.toString('utf8'),'utf8');
   const used=Buffer.byteLength(stream==='out'?stdout:stderr);
   const room=cap-used;
   if(room<=0){truncated=true;return;}
   if(bytes.length>room)truncated=true;
   const slice=bytes.subarray(0,room).toString('utf8');
   if(stream==='out')stdout+=slice;else stderr+=slice;
  };
  child.stdout.on('data',chunk=>append('out',chunk));
  child.stderr.on('data',chunk=>append('err',chunk));
  const terminate=()=>{try{child.kill('SIGKILL');}catch{/* already gone */}};
  const timer=setTimeout(()=>{timedOut=true;terminate();},timeoutMs);
  // The City is the only thing that knows the task was cancelled. A failed status call is NOT a licence to stop a
  // running program: the loop keeps asking, and only an explicit non-RUNNING answer kills the child.
  const poll=setInterval(async()=>{
   if(settled)return;
   try{const current=await report({state:'RUNNING',progress:50,lastCheckpoint:{step:'operation-running'}});if(current&&current.state!=='RUNNING'){cancelled=true;terminate();}}
   catch{/* keep the program running and ask again */ }
  },Math.max(1000,stepDelay));
  const finish=(exitCode,spawnError)=>{
   if(settled)return;settled=true;clearTimeout(timer);clearInterval(poll);
   const state=cancelled?'CANCELLED':timedOut||spawnError?'FAILED':exitCode===0?'COMPLETED':'FAILED';
   const failure=timedOut?`timed out after ${timeoutMs} ms`:spawnError?String(spawnError.code??spawnError.message??spawnError):exitCode===0?undefined:`exit code ${exitCode}`;
   resolve({state,progress:100,result:receipt(state,exitCode??null,failure??null),...(failure?{error:failure}:{})});
  };
  child.on('error',error=>finish(null,error));
  child.on('close',code=>finish(code,null));
 });
}

export async function executeTask(task,adapter,report,stepDelay=1200){
 if(task.type==='OWNER_REMOTE_OPERATION'){
  const outcome=await executeOwnerOperation(task,report,stepDelay);
  try{await report(outcome);}catch{return {state:outcome.state,progress:100,error:outcome.error};}
  return;
 }
 let result={};
 const update=async(progress,lastCheckpoint)=>{const t=await report({state:'RUNNING',progress,lastCheckpoint});if(t.state!=='RUNNING')throw new Error('Task is no longer running: '+t.state);};
 try {
  await update(0,null);
  if(task.type==='WAIT'){
   for(let i=1;i<=5;i++){await sleep(stepDelay);await update(i*18,{step:'wait',tick:i});}result={waitedMs:stepDelay*5};
  }else{
   const bytes=await adapter.create(task.id);const checkpoint={step:'artifact-written',bytes};
   await adapter.checkpoint(task.id,checkpoint);await update(30,checkpoint);await sleep(stepDelay);
   if(['HASH_TEMP_ARTIFACT','CHECKPOINT_DEMO'].includes(task.type)){
    const sha256=await adapter.hash(task.id);result={bytes,sha256};await adapter.checkpoint(task.id,{step:'hashed',sha256});await update(75,{step:'hashed',sha256});await sleep(stepDelay);
   }else result={bytes,operation:task.type};
   await adapter.cleanup(task.id);result.cleaned=true;
  }
  await report({state:'COMPLETED',progress:100,result});
 }catch(e){await adapter.cleanup(task.id);const failure={state:'FAILED',progress:100,error:e.message};try{await report(failure);}catch{return failure;}}
}
