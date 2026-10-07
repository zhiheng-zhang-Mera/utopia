import {requireThat as ok,copy,freeze} from './validation.mjs';
export function projectOrigin(task,events,{auth,after,limit=128}){
 ok(auth.authorized===true&&auth.deviceId===task.originDeviceId&&auth.sessionId===task.parentSessionId,'ORIGIN_UNAUTHORIZED');ok(Number.isSafeInteger(after)&&after>=0&&Number.isInteger(limit)&&limit>0&&limit<=256,'CURSOR_LIMIT');
 const unique=[...new Map(events.filter(e=>Number.isSafeInteger(e.seq)&&e.seq>after).map(e=>[e.seq,e])).values()].sort((a,b)=>a.seq-b.seq);const window=unique.slice(0,limit);
 return freeze({taskId:task.id,actionId:task.actionId,state:task.state,result:copy(task.pcfResult??null),events:copy(window.filter(e=>e.taskId===task.id)),cursor:window.at(-1)?.seq??after,gap:window.length>0&&window[0].seq>after+1,reconcileRequired:unique.length>limit||window.length>0&&window[0].seq>after+1,agentConsumed:task.pcfConsumedSessionId===auth.sessionId});
}
