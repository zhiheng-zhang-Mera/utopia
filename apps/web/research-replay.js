import {t} from './i18n/index.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function createResearchReplayView(){
 let key=null,connectivity=null,generation=0,sources=null,source=null,selected='',runIndex=null,comparison=null,error=null,pending=false,active=null,timer=null,ticks=0;
 const stop=()=>{if(timer)clearTimeout(timer);timer=null;};
 function reset(){stop();generation++;key=null;connectivity=null;sources=null;source=null;selected='';runIndex=null;comparison=null;error=null;pending=false;active=null;ticks=0;}
 function render(getHost,{contextKey,online,api,isCurrent,onStarted=async()=>{}}){
  if(key!==contextKey||connectivity!==online){reset();key=contextKey;connectivity=online;}
  const version=generation;
  const current=()=>version===generation&&key===contextKey&&connectivity===online&&isCurrent();
  const fail=reason=>reason?.status===403?t('rc.ownerRequired'):String(reason?.message??t('rr.unavailable'));
  const runs=()=>source?.runs?.filter(run=>run.warmup===false&&run.result?.taskRef)??[];
  function draw(){
   const host=getHost();if(!current()||!host)return;
   const disabled=!online||pending, running=['RUNNING','PENDING'].includes(comparison?.state);
   const available=runs(),picked=available.find(run=>run.index===runIndex)??null;
   host.innerHTML=`<section id="research-replay" data-loaded="${sources!==null||error!==null}">
    <h3>${esc(t('rr.title'))}</h3><p>${esc(t('rr.hint'))}</p><p id="rr-caveat">${esc(t('rr.caveat'))}</p>
    ${!online?`<p>${esc(t('rc.offline'))}</p>`:''}${error?`<p id="rr-error" role="alert">${esc(error)}</p>`:''}
    <button id="rr-refresh" ${disabled?'disabled':''}>${esc(t('rc.refresh'))}</button>
    <label for="rr-source">${esc(t('rr.source'))}</label><select id="rr-source" ${disabled?'disabled':''}>
      ${(sources??[]).filter(record=>['COMPLETED','STOPPED','FAILED'].includes(record.state)).map(record=>`<option value="${esc(record.campaignId)}" ${record.campaignId===selected?'selected':''}>${esc(record.scenarioId)} · ${esc(record.campaignId)}</option>`).join('')}
    </select><label for="rr-run">${esc(t('rr.run'))}</label><select id="rr-run" ${disabled?'disabled':''}>
      ${available.map(run=>`<option value="${esc(run.index)}" ${run.index===runIndex?'selected':''}>${esc(run.index)} · ${esc(run.state)}</option>`).join('')}
    </select><button id="rr-replay" ${disabled||running||!picked?'disabled':''}>${esc(t('rr.replay'))}</button>
    <button id="rr-ablation" ${disabled||running||!picked||source?.context?.targetDeviceRef||(source?.context?.manifest?.workers?.length??0)<2?'disabled':''}>${esc(t('rr.ablation'))}</button>
    ${!available.length?`<p>${esc(t('rr.noRuns'))}</p>`:''}
    ${comparison?`<div id="rr-comparison"><h4>${esc(t('rr.comparison'))}</h4><p>${esc(comparison.mode??'')} · ${esc(comparison.state)}</p>
      <table><thead><tr><th>${esc(t('rr.value'))}</th><th>${esc(t('rr.original'))}</th><th>${esc(t('rr.replayed'))}</th></tr></thead><tbody>
      ${[['rc.seed',comparison.original?.seed,comparison.replayed?.seed],['rr.worker',comparison.original?.result?.assignedNodeId,comparison.replayed?.result?.assignedNodeId],['rc.state',comparison.original?.state,comparison.replayed?.state],['rc.duration',comparison.original?.durationMs,comparison.replayed?.durationMs]].map(([label,left,right])=>`<tr><td>${esc(t(label))}</td><td>${esc(left??t('rc.notMeasuredValue'))}</td><td>${esc(right??t('rc.notMeasuredValue'))}</td></tr>`).join('')}
      </tbody></table><p>${esc(t('rr.inputs'))}: ${esc(comparison.controlledInputsMatch??t('rc.notMeasuredValue'))}</p>
      <details><summary>${esc(t('rc.technical'))}</summary><pre>${esc(JSON.stringify(comparison,null,2))}</pre></details></div>`:''}
   </section>`;
   host.querySelector('#rr-refresh').onclick=()=>refresh();
   host.querySelector('#rr-source').onchange=event=>{selected=event.target.value;source=null;runIndex=null;comparison=null;active=null;stop();void loadSource();};
   host.querySelector('#rr-run').onchange=event=>{runIndex=Number(event.target.value);draw();};
   host.querySelector('#rr-replay').onclick=()=>execute('REPLAY');
   host.querySelector('#rr-ablation').onclick=()=>execute('ABLATION');
  }
  async function loadSource(){
   if(pending||!online||!current()||!selected)return;
   pending=true;error=null;draw();
   try{const result=await api(`research/campaigns/${encodeURIComponent(selected)}`);if(!current())return;source=result.campaign;runIndex=runs()[0]?.index??null;}
   catch(reason){if(current())error=fail(reason);}
   finally{if(current()){pending=false;draw();}}
  }
  async function refresh(){
   if(pending||!online||!current())return;
   pending=true;error=null;draw();
   try{const result=await api('research/replays');if(!current())return;sources=result.sources??[];if(!sources.some(record=>record.campaignId===selected))selected=sources.find(record=>['COMPLETED','STOPPED','FAILED'].includes(record.state))?.campaignId??'';}
   catch(reason){if(current())error=fail(reason);}
   finally{if(current()){pending=false;draw();if(selected)await loadSource();}}
  }
  async function inspect(){
   if(!active||!current()||!online)return;
   const requested=active;
   try{const result=await api(`research/replays/${encodeURIComponent(requested)}`);if(!current()||active!==requested)return;comparison=result.comparison;draw();}
   catch(reason){if(current()&&active===requested){error=fail(reason);active=null;draw();}}
   if(current()&&active&&['RUNNING','PENDING'].includes(comparison?.state)&&ticks<120){ticks++;timer=setTimeout(()=>{timer=null;void inspect();},750);}
  }
  async function execute(mode){
   if(pending||!online||!current()||!runs().some(run=>run.index===runIndex))return;
   const request={sourceCampaignId:selected,sourceRunIndex:runIndex,mode,disabledMechanisms:mode==='ABLATION'?['alternate-device']:[]};
   pending=true;error=null;comparison=null;stop();draw();
   try{const result=await api('research/replays',request);if(!current())return;active=result.started.campaignId;ticks=0;await onStarted();if(current())await inspect();}
   catch(reason){if(current())error=fail(reason);}
   finally{if(current()){pending=false;draw();}}
  }
  draw();if(online&&sources===null&&!pending&&!error)void refresh();
 }
 return {render,reset};
}
