import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {hostname} from 'node:os';import {sha256} from './artifacts.mjs';import {requireThat as ok,finite} from './validation.mjs';
export async function executeCpu({operation,values,checkpoint=null,deadlineMs=5000,maxOutputBytes=1048576,signal}){
 ok(['SORT','SUM'].includes(operation)&&Array.isArray(values)&&values.length<=100000&&values.every(v=>typeof v==='number'&&Number.isFinite(v)),'CPU_INPUT');ok(finite(deadlineMs)&&deadlineMs>0&&deadlineMs<=60000&&Number.isInteger(maxOutputBytes)&&maxOutputBytes>0&&maxOutputBytes<=2097152,'EXECUTION_BOUNDS');if(signal?.aborted)throw new Error('CANCELLED');
 const input=JSON.stringify({operation,values,checkpoint});ok(Buffer.byteLength(input)<=2000000,'CPU_INPUT_LIMIT');
 return new Promise((resolve,reject)=>{
  // PATH and user credential environment are deliberately not inherited.
  const child=spawn(process.execPath,[fileURLToPath(new URL('./cpu-worker.mjs',import.meta.url))],{shell:false,windowsHide:true,env:{SystemRoot:process.env.SystemRoot??'',TMP:process.env.TMP??''},stdio:['pipe','pipe','pipe']});let output=[],bytes=0,errorBytes=0,reason=null;
  const stop=why=>{reason??=why;child.kill();};const abort=()=>stop('CANCELLED');signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>stop('TIMEOUT'),deadlineMs);
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxOutputBytes)stop('OUTPUT_LIMIT');else output.push(chunk);});child.stderr.on('data',chunk=>{errorBytes+=chunk.length;if(errorBytes>16384)stop('STDERR_LIMIT');});child.stdin.on('error',()=>{});
  child.once('error',e=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(e);});
  child.once('close',(exitCode,exitSignal)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);const raw=Buffer.concat(output);if(reason||exitCode!==0){resolve({outcome:reason==='CANCELLED'?'CANCELLED':'FAILED',reason:reason??'PROCESS_EXIT',exitCode,exitSignal,pid:child.pid,host:hostname(),isolation:'COOPERATIVE',output:null,outputDigest:null});return;}try{const value=JSON.parse(raw);resolve({outcome:'SUCCEEDED',exitCode:0,pid:child.pid,host:hostname(),isolation:'COOPERATIVE',output:value,outputDigest:sha256(raw)});}catch(e){reject(e);}});
  child.stdin.end(input);
 });
}
