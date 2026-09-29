const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function executeTask(task,adapter,report,stepDelay=1200){
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
