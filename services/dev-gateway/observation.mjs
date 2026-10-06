// MON-901: non-authoritative pull sidecar. No timers, listeners, task mutations or decisions.
// MON-903: the `decision` field is filled from an injected, read-only decision snapshot provider. The sidecar still
// decides nothing itself: it projects what the decision overlay recorded, exactly as it projects canonical tasks.
const ref=value=>typeof value==='string'?value.slice(0,160):null;
const base=()=>({schemaVersion:1,authoritative:false,eventSource:'CANONICAL_GATEWAY_STORE',health:'NOT_OBSERVED',nodes:[],edges:[],events:[],evidence:[],decision:[],observedAt:null,projectedAt:null,projectionLatencyMs:null,completeness:null,unsupportedSources:['review','test/CI','model/provider switch']});
export function createObservation({read,decisions=null,clock=()=>Date.now()}={}) {
 if(typeof read!=='function')throw new TypeError('Canonical reader required');
 let view=base(),pending=null,disconnected=false;
 const snapshot=()=>structuredClone(view);
 function refresh(){
  if(disconnected)return Promise.resolve(snapshot());
  if(pending)return pending;
  // Reader runs outside all canonical transition paths, never before a transaction commits.
  pending=Promise.resolve().then(read).then(source=>{
   if(disconnected)return snapshot();
   if(!source||!Number.isInteger(source.limit)||source.limit<1||source.limit>256||!['tasks','nodes','events'].every(k=>Array.isArray(source[k])&&source[k].length<=source.limit))throw Error('Invalid bounded source');
   const time=clock(),nodes=[],edges=[],evidence=[];
   for(const n of source.nodes)nodes.push({kind:'HOST',id:ref(n.id),displayName:ref(n.displayName),online:typeof n.online==='boolean'?n.online:null});
   for(const task of source.tasks){
    const id=ref(task.id),host=ref(task.assignedNodeId);
    nodes.push({kind:'TASK',id,state:ref(task.state),taskType:ref(task.type),hostRef:host,ownerRef:null,ownerObservability:'NOT_OBSERVABLE',progress:typeof task.progress==='number'&&Number.isFinite(task.progress)?task.progress:null});
    if(host)edges.push({from:id,to:host,type:'ASSIGNED_TO',reason:'Canonical task.assignedNodeId',targetPresent:source.nodes.some(n=>n.id===host)});
   }
   const events=source.events.map(e=>{
    const id=ref(e.id),seq=e.seq,pointer={canonicalEventId:id,seq,source:'CANONICAL_GATEWAY_STORE',path:'/api/v0/events',cityId:ref(source.cityId)};
    evidence.push(pointer);
    return {canonicalEventId:id,seq,type:ref(e.type),taskRef:ref(e.taskId),actorRef:ref(e.actor),timestamp:ref(e.timestamp),evidenceRef:id};
   });
   const counts=source.counts;
   if(!counts||!['tasks','nodes','events'].every(k=>Number.isInteger(counts[k])&&counts[k]>=source[k].length))throw Error('Invalid populations');
   const watermark=Number.isInteger(source.eventHighWatermark)&&source.eventHighWatermark>=0?source.eventHighWatermark:null;
   const completeness={tasksOmitted:counts.tasks-source.tasks.length,nodesOmitted:counts.nodes-source.nodes.length,eventsOmitted:counts.events-source.events.length,historyGap:watermark===null||watermark>counts.events||counts.events>source.events.length||(events.length>0&&events[0].seq!==1)||events.some((e,i)=>i>0&&e.seq!==events[i-1].seq+1),firstSeq:events[0]?.seq??null,lastSeq:events.at(-1)?.seq??null,canonicalHighWatermark:watermark,continuous:false};
   const partial=completeness.tasksOmitted>0||completeness.nodesOmitted>0||completeness.eventsOmitted>0||completeness.historyGap;
   const lag=time-Date.parse(source.observedAt);
   // MON-903: decisions are projected from the overlay's own bounded receipt window. A provider that throws is a
   // declared gap, not a broken projection: the monitor must keep answering even when the decision log cannot.
   let decision=[];let decisionFailure=null;
   if(typeof decisions==='function'){try{const snap=decisions();decision=Array.isArray(snap?.decisions)?snap.decisions:[];if(snap?.retentionTruncated)decisionFailure='DECISION_WINDOW_RETENTION_TRUNCATED';}catch{decisionFailure='DECISION_SOURCE_UNAVAILABLE';}}
   view={...base(),cityId:ref(source.cityId),health:partial?'PARTIAL':'COMPLETE',scope:'BOUNDED_CANONICAL_WINDOW',safeSummaryAvailable:false,unobservedTaskRisk:completeness.tasksOmitted>0,nodes,edges,events,evidence,decision,decisionFailure,observedAt:ref(source.observedAt),projectedAt:new Date(time).toISOString(),projectionLatencyMs:Number.isFinite(lag)&&lag>=0?lag:null,completeness};
   return snapshot();
  }).catch(()=>{
   if(!disconnected)view={...view,health:'UNAVAILABLE',failure:'CANONICAL_SOURCE_UNAVAILABLE',stale:true};
   return snapshot();
  }).finally(()=>{pending=null;});return pending;
 }
 return {refresh,snapshot,disconnect(){disconnected=true;view={...view,health:'DISCONNECTED',stale:true};}};
}
