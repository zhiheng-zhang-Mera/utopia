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
import {researchMarkup, researchView, assertPrimarySurfacesClean} from './research-surface.js';
const states=new WeakMap();
// Local escaper for the one message this page still builds itself (the storage-unavailable line inside the list, which
// the accepted REX-801 suite reads from that element). Dropping it while moving the other fragments into
// researchMarkup threw "esc is not defined" inside show(), which left every control disabled - caught by running the
// accepted browser suite, not by my own shape test.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const L=(en,zh)=>getLocale()==='zh-CN'?zh:en;
export function renderResearch(container,online,api,contextKey,capabilities={}){
 let state=states.get(container);
 if(!state||state.key!==contextKey){state={key:contextKey,draft:'',data:null,campaigns:null,artifact:null,observationErrors:[],result:null,error:'',busy:false,exported:''};states.set(container,state);}
 state.online=online;
 // The artifact export needs the session credential, which lives in the page shell; passing the capability in keeps this
 // module from reaching for a token it does not own.
 state.exportArtifact=typeof capabilities.exportArtifact==='function'?capabilities.exportArtifact:null;
 state.owner=capabilities.owner===true;
 let root=container.querySelector('#research-shell');
 if(!root||root.dataset.locale!==getLocale()||root._researchState!==state){
  container.innerHTML=`<section id="research-shell" class="panel"><p id="research-intro"></p><div id="research-alerts"></div><details id="research-direct" open><summary id="research-direct-summary"></summary><button id="research-refresh"></button><div id="research-list"></div><details id="research-vocabulary-details"><summary id="research-vocabulary-summary"></summary><pre id="research-vocabulary"></pre></details><label for="research-manifest" id="research-manifest-label"></label><textarea id="research-manifest" rows="12"></textarea><label id="research-import-label"><input id="research-import" type="file" accept=".json,application/json"></label><button id="research-validate"></button><button id="research-register"></button><p id="research-error" role="alert"></p><pre id="research-result" role="status" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></details><details id="research-runs" open><summary id="research-runs-summary"></summary><div id="research-run"></div></details><details id="research-metrics" open><summary id="research-metrics-summary"></summary><div id="research-metrics-body"></div></details><details id="research-export"><summary id="research-export-summary"></summary><p id="research-export-hint"></p><button id="research-export-json"></button><button id="research-export-csv"></button><p id="research-export-status" role="status"></p></details><details id="research-technical"><summary id="research-technical-summary"></summary><div id="research-technical-body"></div></details></section>`;
  root=container.querySelector('#research-shell');root.dataset.locale=getLocale();root._researchState=state;
  const current=()=>root.isConnected&&container.querySelector('#research-shell')===root&&states.get(container)===state;
  const take=(sections,id)=>sections.find(section=>section.id===id)??{title:'',items:[],controls:[]};
  const show=()=>{
   if(!current())return;
   const artifact=state.artifact?.artifact;
   const view=researchView({...(state.data??{}),live:state.campaigns?.live??null,unfinished:state.campaigns?.unfinished,
    receiptWindow:state.campaigns?.receiptWindow,campaignStoreState:state.campaigns?.storeState,campaignStoreReason:state.campaigns?.storeReason,
    observationErrors:state.observationErrors,runUnavailable:state.observationErrors.some(row=>row.source==='campaigns'),
    metrics:{reported:artifact?.metrics??[],notMeasured:artifact?.metrics?.filter(row=>row.value==='NOT_MEASURED')??[]},
    exclusions:artifact?.exclusions??[],provenance:artifact?{manifest:artifact.manifest,rawPointers:artifact.rawPointers,metrics:artifact.metrics.map(row=>({metric:row.metric,provenance:row.provenance})),checksums:state.artifact.checksums}:null},{locale:getLocale()});
   // REX-807 requires the primary product surfaces to stay free of research controls, and the workbook's own claim is
   // that this guard "is data, not a convention". It was neither: `researchView` was called without `primarySurfaces`, so
   // the list was always empty and the check only ever ran inside its own test. The navigation is where a pollution
   // would actually appear, so the guard is fed from the REAL nav here - every entry outside the Advanced group is a
   // primary surface - and promoting Research into the primary nav now throws on the page instead of shipping. Outside a
   // document (the shape tests render the page into a stub container) the declared defaults are used, so the guard is
   // never skipped silently in a browser and never invents a surface list it could not read.
   const primarySurfaces=(()=>{try{const nav=[...document.querySelectorAll('nav [data-page]')].filter(node=>!node.closest('.nav-group')).map(node=>node.dataset.page).filter(Boolean);return nav.length?nav:['home','ask','devices'];}catch{return ['home','ask','devices'];}})();
   assertPrimarySurfacesClean(view,{primarySurfaces});
   const markup=researchMarkup(view,{locale:getLocale()});
   root.querySelector('#research-intro').textContent=L('Research is an advanced surface: describe and validate an experiment here. Registering does not run tasks and does not grant fault permissions.','研究属于高级面：在此描述并验证实验。登记不会执行任务，也不会授予故障注入权限。');
   root.querySelector('#research-alerts').innerHTML=markup.alerts;
   const direct=take(view.sections,'experiments'),runs=take(view.sections,'runs'),metrics=take(view.sections,'metrics'),technical=take(view.sections,'diagnostics');
   root.querySelector('#research-direct-summary').textContent=`${direct.title} · ${L('create, validate, register','创建、验证、登记')}`;
   root.querySelector('#research-runs-summary').textContent=runs.title;
   root.querySelector('#research-metrics-summary').textContent=metrics.title;
   root.querySelector('#research-technical-summary').textContent=`${technical.title} · ${L('exact manifests, identifiers, unplaced fields','完整清单、标识符、未归位字段')}`;
   root.querySelector('#research-export-summary').textContent=L('Export research artifact','导出研究工件');
   root.querySelector('#research-export-hint').textContent=L('The artifact is built from the campaign receipts this City holds. Metrics it cannot derive leave as NOT_MEASURED with their reason.','工件由本城持有的 campaign 回执生成；无法推导的指标以 NOT_MEASURED 带原因交出。');
   root.querySelector('#research-export-json').textContent=L('Download artifact (JSON)','下载工件（JSON）');
   root.querySelector('#research-export-csv').textContent=L('Download metrics (CSV)','下载指标（CSV）');
   root.querySelector('#research-export-status').textContent=L('Owner session required.','需要 Owner 会话。');
   root.querySelector('#research-refresh').textContent=L('Refresh experiments','刷新实验');
   root.querySelector('#research-vocabulary-summary').textContent=L('Manifest fields and supported values','清单字段与支持的值');
   root.querySelector('#research-manifest-label').textContent=L('Experiment manifest JSON','实验清单 JSON');
   const importInput=root.querySelector('#research-import');importInput.parentElement.firstChild.textContent=L('Import JSON file','导入 JSON 文件');
   root.querySelector('#research-validate').textContent=L('Validate without registering','仅验证，不登记');
   root.querySelector('#research-register').textContent=L('Register manifest','登记清单');
   // The vocabulary disclosure is part of the accepted REX-801 contract for this page and stays exactly where it was,
   // inside the open direct-control section: the layering added sections, it did not remove what reviewers relied on.
   root.querySelector('#research-vocabulary').textContent=state.data?.research?JSON.stringify(state.data.research,null,2):'';
   // The list shows the human summary; the identifier is carried as a title attribute and folded into Technical details.
   // The storage-unavailable sentence is ALSO rendered here because the accepted REX-801 web suite reads it from this
   // element; the alert above repeats it for the layering. Both are true statements, so both exist.
   const unavailable=state.data?.storeState==='UNAVAILABLE'?`<p role="alert">${L('Experiment storage is unavailable. Validated manifests cannot be filed.','实验存储不可用。验证后的清单无法保存。')} ${esc(state.data.storeReason)}</p>`:'';
   root.querySelector('#research-list').innerHTML=unavailable+markup.list;
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
   // Export needs a session credential, not only a live connection, so it is disabled with a stated reason rather than
   // failing silently when the shell does not supply the capability.
   const exportReady=state.owner&&typeof state.exportArtifact==='function';
   for(const id of ['#research-export-json','#research-export-csv']){const button=root.querySelector(id);if(button)button.disabled=state.busy||!state.online||!exportReady;}
   const exportStatus=root.querySelector('#research-export-status');
   if(exportStatus)exportStatus.textContent=(exportReady?L("Owner session detected: the export reads this City's own receipts.",'已检测到 Owner 会话：导出读取本城自己的回执。'):L('Owner session required.','需要 Owner 会话。'))+(state.exported?` ${L('Last export:','上次导出：')} ${state.exported}`:'');
  };
  const run=async operation=>{
   if(state.busy||!state.online)return;
   state.busy=true;state.error='';show();
   try{const value=await operation();if(current())state.result=value;}catch(error){if(current())state.error=error.message;}
   finally{state.busy=false;show();}
  };
  // Independent reads retain explicit failures rather than turn an unavailable run into an idle one.
  const list=async()=>{
   const sources=['experiments','campaigns',...(state.owner?['artifacts']:[])];
   const results=await Promise.allSettled(sources.map(source=>api('research/'+source)));
   if(current()){
    state.observationErrors=[];state.artifact=null;state.campaigns=null;
    results.forEach((result,index)=>{
     const source=sources[index];
     if(result.status==='fulfilled'){if(source==='experiments')state.data=result.value;else if(source==='campaigns')state.campaigns=result.value;else state.artifact=result.value;}
     else{state.observationErrors.push({source,code:result.reason?.code??'',reason:result.reason?.message??String(result.reason)});if(source==='experiments')state.data=null;}
    });
   }
   if(results[0].status==='rejected')throw results[0].reason;
   return results[0].value;
  };
  const editor=root.querySelector('#research-manifest');editor.value=state.draft;
  editor.style.cssText='display:block;box-sizing:border-box;width:100%;min-height:16rem;margin:12px 0;padding:12px;color:var(--ink);background:var(--void);border:1px solid var(--ink-2);font-family:monospace;resize:vertical';
  root.querySelector('#research-result').style.maxHeight='28rem';root.querySelector('#research-result').style.overflow='auto';
  root.querySelector('#research-manifest').oninput=e=>{state.draft=e.target.value;};
  root.querySelector('#research-refresh').onclick=()=>run(list);
  // Export is a DIRECT_CONTROL the workbook names, and before this it existed only as an HTTP endpoint: the workbook's
  // rule is that the research capability is usable WITHOUT a console or raw API call, so the control is real here and
  // downloads what the gateway answers.
  const exportArtifact=async format=>{
   if(!state.owner||!state.exportArtifact)throw Error(L('Owner session required.','需要 Owner 会话。'));
   // The capability answers with what it wrote; storing the NAME is what lets the page show which artifact the
   // operator just downloaded. Reading a string here silently stored '' and the page reported nothing.
   const result=await state.exportArtifact(format);
   if(current())state.exported=result?.name??'';
   return result;
  };
  root.querySelector('#research-export-json').onclick=()=>run(()=>exportArtifact('json'));
  root.querySelector('#research-export-csv').onclick=()=>run(()=>exportArtifact('csv'));
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
