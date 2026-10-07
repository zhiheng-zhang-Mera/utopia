import {requireThat as ok,finite,text} from './validation.mjs';
export function fairQueue(tasks,{lastAppId=null,now,agingMs=30000,maxItems=256}={}){
 ok(Array.isArray(tasks)&&tasks.length<=maxItems&&maxItems<=256&&finite(now)&&finite(agingMs)&&agingMs>0,'FAIR_QUEUE_LIMIT');const groups=new Map();
 for(const task of tasks){ok(text(task.id)&&text(task.appId)&&finite(task.queuedAt)&&task.queuedAt<=now,'QUEUE_RECORD');const list=groups.get(task.appId)??[];list.push(task);groups.set(task.appId,list);}for(const list of groups.values())list.sort((a,b)=>a.queuedAt-b.queuedAt||a.id.localeCompare(b.id));
 const out=[];while(groups.size){const apps=[...groups.keys()].sort((a,b)=>{const x=groups.get(a)[0],y=groups.get(b)[0],oldX=now-x.queuedAt>=agingMs,oldY=now-y.queuedAt>=agingMs;if(oldX!==oldY)return oldX?-1:1;if(oldX)return x.queuedAt-y.queuedAt||a.localeCompare(b);if(a===lastAppId&&b!==lastAppId)return 1;if(b===lastAppId&&a!==lastAppId)return -1;return x.queuedAt-y.queuedAt||a.localeCompare(b);});const app=apps[0],list=groups.get(app);out.push(list.shift());lastAppId=app;if(!list.length)groups.delete(app);}return out;
}
