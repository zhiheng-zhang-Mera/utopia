import * as hostOs from 'node:os';
import { readDisk } from '../../platform/windows/telemetry.mjs';
export function createTelemetrySampler({enabled=true,os=hostOs,disk=readDisk,interval=3000,now=()=>new Date()}={}) {
 let previous=null,value=null,timer,stopped=false,inFlight;
 const safe=fn=>{try{const n=fn();return Number.isFinite(n)&&n>=0?n:null;}catch{return null;}};
 async function collect(){
  if(!enabled||stopped)return null;
  let current=null,usagePercent=null;
  try{const cpus=os.cpus();if(cpus.length)current=cpus.reduce((a,c)=>({idle:a.idle+c.times.idle,total:a.total+Object.values(c.times).reduce((x,y)=>x+y,0)}),{idle:0,total:0});}catch{}
  if(previous&&current){const total=current.total-previous.total,idle=current.idle-previous.idle;if(total>0&&idle>=0&&idle<=total)usagePercent=100*(1-idle/total);}
  previous=current;
  const totalBytes=safe(()=>os.totalmem()),free=safe(()=>os.freemem());
  let volume={usedBytes:null,freeBytes:null,totalBytes:null};try{volume=await disk();}catch{}
  value={observedAt:now().toISOString(),cpu:{usagePercent},memory:{usedBytes:totalBytes!==null&&free!==null?totalBytes-free:null,totalBytes},disk:volume,uptimeSeconds:safe(()=>os.uptime())};return value;
 }
 const sample=()=>inFlight??(inFlight=collect().finally(()=>{inFlight=null;}));
 return {sample,latest:()=>value,start:async()=>{await sample();if(enabled&&!timer&&!stopped){timer=setInterval(()=>void sample(),interval);timer.unref?.();}},stop:()=>{stopped=true;clearInterval(timer);}};
}
