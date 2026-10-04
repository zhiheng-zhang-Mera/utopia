import {t} from './i18n/index.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createResearchTraceView(){
 let context=null,connectivity=null,epoch=0,data=null,error=null,pending=false;
 function reset(){context=null;connectivity=null;epoch++;data=null;error=null;pending=false;}
 function render(host,{contextKey,online,api,isCurrent}){
  if(contextKey!==context||online!==connectivity){reset();context=contextKey;connectivity=online;}
  const current=()=>context===contextKey&&connectivity===online&&isCurrent();
  function draw(){if(!current())return;
   const trace=data;
   host.innerHTML=`<section class="panel" id="research-trace" data-loaded="${Boolean(trace||error)}"><h2>${esc(t('trace.title'))}</h2><p>${esc(t('trace.hint'))}</p><button id="trace-refresh" ${pending||!online?'disabled':''}>${esc(t('trace.refresh'))}</button>${!online?`<p>${esc(t('trace.offline'))}</p>`:pending&&!trace?`<p>${esc(t('terminal.loading'))}</p>`:''}${error?`<p role="status">${esc(error)}</p>`:''}${trace?`<p>${esc(t(trace.recording?'trace.recording':'trace.stopped'))} · ${esc(trace.storageState)} · ${esc(trace.completeness)}</p><p>${esc(t('trace.types'))}: ${esc(trace.recordedTypes.join(', ')||t('trace.none'))}</p><p>${esc(t('trace.experiment'))}: ${esc(trace.experimentRunRef??trace.experimentRunReason)}</p><h3>${esc(t('trace.metrics'))}</h3><ul>${Object.entries(trace.metricsAvailability).map(([key,value])=>`<li>${esc(key)}: ${esc(value.available?t('trace.available'):value.reason)}</li>`).join('')}</ul><h3>${esc(t('trace.failures'))}</h3><p>${esc(trace.failures.map(row=>row.code).join(', ')||t('trace.none'))}</p><p>${esc(t('trace.dropped'))}: ${esc(trace.droppedRecords)} · ${esc(t('trace.retention'))}: ${esc(trace.retentionTruncated)}</p><details id="trace-technical"><summary>${esc(t('common.runDetails'))}</summary><p>${esc(t('trace.declared'))}</p><pre>${esc(JSON.stringify({runId:trace.runId,experimentRunRef:trace.experimentRunRef,counterScope:trace.counterScope,records:trace.records},null,2))}</pre></details>`:''}</section>`;
   host.querySelector('#trace-refresh').onclick=()=>load();
  }
  async function load(){if(pending||!online||!current())return;const requestEpoch=++epoch;pending=true;error=null;draw();try{
   const result=await api('research/trace');if(requestEpoch!==epoch||!current())return;data=result.trace;
  }catch(reason){if(requestEpoch!==epoch||!current())return;error=t(reason?.status===403?'trace.ownerRequired':'trace.unavailable');
  }finally{if(requestEpoch===epoch){pending=false;if(current())draw();}}}
  draw();if(online&&!data&&!error&&!pending)void load();
 }
 return {render,reset};
}
