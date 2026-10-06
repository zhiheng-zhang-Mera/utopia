// REX-807: the Research / Experiments entry.
//
// The page used to be one flat technical pane: a manifest textarea, two buttons, and the raw JSON answer printed
// underneath. It was reachable but not usable without reading identifiers and exact config - the control surface
// existed, the LAYER did not. This page now renders the layer that apps/web/research-surface.js computes:
//
//   * visible alerts first (storage outage, unreadable records, exclusions, unmeasured metrics, an unfinished run) so
//     nothing important is only implied by an empty list;
//   * experiments as human summaries with their identifiers folded into the collapsed Technical details, never as the
//     primary label;
//   * the manifest editor and the validate/register/import controls grouped as the DIRECT_CONTROL section;
//   * the Advanced danger zone left to research-faults.js, which already renders itself as a collapsed <details> with
//     an explicit typed confirmation;
//   * a Technical details section that also lists any payload field this view does not place yet, so a gateway
//     addition becomes visible instead of vanishing.
//
// The view model is pure, so the shape can be asserted without a browser; this file only renders it.
import {getLocale} from './i18n/index.js';
import {renderFaults} from './research-faults.js';
import {researchMarkup, researchView} from './research-surface.js';
const states=new WeakMap();
const L=(en,zh)=>getLocale()==='zh-CN'?zh:en;
export function renderResearch(container,online,api,contextKey){
 let state=states.get(container);
 if(!state||state.key!==contextKey){state={key:contextKey,draft:'',data:null,campaigns:null,result:null,error:'',busy:false};states.set(container,state);}
 state.online=online;
 let root=container.querySelector('#research-shell');
 if(!root||root.dataset.locale!==getLocale()||root._researchState!==state){
  container.innerHTML=`<section id="research-shell" class="panel"><p id="research-intro"></p><div id="research-alerts"></div><details id="research-direct" open><summary id="research-direct-summary"></summary><button id="research-refresh"></button><div id="research-list"></div><label for="research-manifest" id="research-manifest-label"></label><textarea id="research-manifest" rows="12"></textarea><label id="research-import-label"><input id="research-import" type="file" accept=".json,application/json"></label><button id="research-validate"></button><button id="research-register"></button><p id="research-error" role="alert"></p><pre id="research-result" role="status" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></details><details id="research-runs" open><summary id="research-runs-summary"></summary><div id="research-run"></div></details><details id="research-metrics" open><summary id="research-metrics-summary"></summary><div id="research-metrics-body"></div></details><details id="research-technical"><summary id="research-technical-summary"></summary><div id="research-technical-body"></div></details></section>`;
  root=container.querySelector('#research-shell');root.dataset.locale=getLocale();root._researchState=state;
  const current=()=>root.isConnected&&container.querySelector('#research-shell')===root&&states.get(container)===state;
  const take=(sections,id)=>sections.find(section=>section.id===id)??{title:'',items:[],controls:[]};
  const show=()=>{
   if(!current())return;
   const view=researchView({...(state.data??{}),live:state.campaigns?.live??null,faults:state.campaigns?.faults??null},{locale:getLocale()});
   const markup=researchMarkup(view,{locale:getLocale()});
   root.querySelector('#research-intro').textContent=L('Research is an advanced surface: describe and validate an experiment here. Registering does not run tasks and does not grant fault permissions.','研究属于高级面：在此描述并验证实验。登记不会执行任务，也不会授予故障注入权限。');
   root.querySelector('#research-alerts').innerHTML=markup.alerts;
   const direct=take(view.sections,'experiments'),runs=take(view.sections,'runs'),metrics=take(view.sections,'metrics'),technical=take(view.sections,'diagnostics');
   root.querySelector('#research-direct-summary').textContent=`${direct.title} · ${L('create, validate, register','创建、验证、登记')}`;
   root.querySelector('#research-runs-summary').textContent=runs.title;
   root.querySelector('#research-metrics-summary').textContent=metrics.title;
   root.querySelector('#research-technical-summary').textContent=`${technical.title} · ${L('exact manifests, identifiers, unplaced fields','完整清单、标识符、未归位字段')}`;
   root.querySelector('#research-refresh').textContent=L('Refresh experiments','刷新实验');
   root.querySelector('#research-manifest-label').textContent=L('Experiment manifest JSON','实验清单 JSON');
   const importInput=root.querySelector('#research-import');importInput.parentElement.firstChild.textContent=L('Import JSON file','导入 JSON 文件');
   root.querySelector('#research-validate').textContent=L('Validate without registering','仅验证，不登记');
   root.querySelector('#research-register').textContent=L('Register manifest','登记清单');
   // The list shows the human summary; the identifier is carried as a title attribute and folded into Technical details.
   root.querySelector('#research-list').innerHTML=markup.list;
   root.querySelector('#research-run').innerHTML=markup.run;
   root.querySelector('#research-metrics-body').innerHTML=markup.metrics;
   root.querySelector('#research-technical-body').innerHTML=markup.technical;
   root.querySelector('#research-error').textContent=state.error;
   const result=state.result;
   const compact=result?.validation?{validation:result.validation}:result?.experiment?{experiment:result.experiment}:result?.registered?{registered:result.registered,experimentId:result.experimentId,status:result.status,replayed:result.replayed,persisted:result.persisted,persistFailure:result.persistFailure}:result?.experiments?{experiments:result.experiments,broken:result.broken,storeState:result.storeState,storeReason:result.storeReason}:result;
   root.querySelector('#research-result').textContent=compact?JSON.stringify(compact,null,2):'';
   for(const button of root.querySelectorAll('button'))button.disabled=state.busy||!state.online;
   importInput.disabled=state.busy||!state.online;
   root.querySelector('#research-manifest').disabled=state.busy;
  };
  const run=async operation=>{
   if(state.busy||!state.online)return;
   state.busy=true;state.error='';show();
   try{const value=await operation();if(current())state.result=value;}catch(error){if(current())state.error=error.message;}
   finally{state.busy=false;show();}
  };
  // Two reads, because the layer needs both: the experiment registry and the live run it is about.
  const list=async()=>{
   const [data,campaigns]=await Promise.all([api('research/experiments'),api('research/campaigns').catch(()=>null)]);
   if(current()){state.data=data;state.campaigns=campaigns;}
   return data;
  };
  const editor=root.querySelector('#research-manifest');editor.value=state.draft;
  editor.style.cssText='display:block;box-sizing:border-box;width:100%;min-height:16rem;margin:12px 0;padding:12px;color:var(--ink);background:var(--void);border:1px solid var(--ink-2);font-family:monospace;resize:vertical';
  root.querySelector('#research-result').style.maxHeight='28rem';root.querySelector('#research-result').style.overflow='auto';
  root.querySelector('#research-manifest').oninput=e=>{state.draft=e.target.value;};
  root.querySelector('#research-refresh').onclick=()=>run(list);
  root.querySelector('#research-list').onclick=e=>{const button=e.target.closest('[data-experiment]');if(button)run(()=>api('research/experiments/'+encodeURIComponent(button.dataset.experiment)));};
  root.querySelector('#research-import').onchange=e=>run(async()=>{const file=e.target.files?.[0];if(!file)return null;if(file.size>256*1024)throw Error(L('File exceeds 256 KiB','文件超过 256 KiB'));const draft=await file.text();JSON.parse(draft);if(current()){state.draft=draft;root.querySelector('#research-manifest').value=draft;}return {imported:true,registered:false};});
  root.querySelector('#research-validate').onclick=()=>run(()=>api('research/experiments/validate',{manifest:JSON.parse(state.draft)}));
  root.querySelector('#research-register').onclick=()=>run(async()=>{
   const result=await api('research/experiments',{manifest:JSON.parse(state.draft)});
   if(current()){
    state.result=result;show();
    try{await list();}catch(error){if(current())state.error=L('Registered; experiment list refresh failed: ','登记成功；实验列表刷新失败：')+error.message;}
   }
   return result;
  });
  root._show=show;show();if(!state.data&&online)run(list);
 }
 root._show();
 // The danger zone renders itself as a collapsed <details> with a typed confirmation; it needs a document, so a
 // non-browser harness (the shape tests) can render this page without one.
 if(typeof document!=='undefined')renderFaults(container,online,api,contextKey);
}
