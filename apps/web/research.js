import {getLocale} from './i18n/index.js';
const states=new WeakMap();
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const L=(en,zh)=>getLocale()==='zh-CN'?zh:en;
export function renderResearch(container,online,api,contextKey){
 let state=states.get(container);
 if(!state||state.key!==contextKey){state={key:contextKey,draft:'',data:null,result:null,error:'',busy:false};states.set(container,state);}
 state.online=online;
 let root=container.querySelector('#research-shell');
 if(!root||root.dataset.locale!==getLocale()||root._researchState!==state){
  container.innerHTML=`<section id="research-shell" class="panel"><p>${L('Describe and validate an experiment. Registering does not run tasks or grant fault permissions.','描述并验证实验。登记不会执行任务，也不会授予故障注入权限。')}</p><button id="research-refresh">${L('Refresh experiments','刷新实验')}</button><div id="research-list"></div><details><summary>${L('Manifest fields and supported values','清单字段与支持的值')}</summary><p>${L('JSON fields: experimentId, question, topology, hosts, workers, controlSurfaces, variables, repetitions, seedPolicy, requiredCapabilities, stopConditions, artifactPolicy, acceptance, softwareRefs. Use an exact software commit.','JSON 字段：experimentId、question、topology、hosts、workers、controlSurfaces、variables、repetitions、seedPolicy、requiredCapabilities、stopConditions、artifactPolicy、acceptance、softwareRefs。请填写软件完整提交 SHA。')}</p><pre id="research-vocabulary"></pre></details><label for="research-manifest">${L('Experiment manifest JSON','实验清单 JSON')}</label><textarea id="research-manifest" rows="12"></textarea><label>${L('Import JSON file','导入 JSON 文件')}<input id="research-import" type="file" accept=".json,application/json"></label><button id="research-validate">${L('Validate without registering','仅验证，不登记')}</button><button id="research-register">${L('Register manifest','登记清单')}</button><p id="research-error" role="alert"></p><pre id="research-result" role="status" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></section>`;
  root=container.querySelector('#research-shell');root.dataset.locale=getLocale();root._researchState=state;
  const current=()=>root.isConnected&&container.querySelector('#research-shell')===root&&states.get(container)===state;
  const show=()=>{
   if(!current())return;
   root.querySelector('#research-error').textContent=state.error;
   const result=state.result;
   const compact=result?.validation?{validation:result.validation}:result?.experiment?{experiment:result.experiment}:result?.registered?{registered:result.registered,experimentId:result.experimentId,status:result.status,replayed:result.replayed}:result?.experiments?{experiments:result.experiments,broken:result.broken}:result;
   root.querySelector('#research-result').textContent=compact?JSON.stringify(compact,null,2):'';
   root.querySelector('#research-vocabulary').textContent=state.data?.research?JSON.stringify(state.data.research,null,2):'';
   root.querySelector('#research-list').innerHTML=(state.data?.experiments??[]).map(e=>`<button data-experiment="${esc(e.experimentId)}">${esc(e.experimentId)} · ${esc(e.status)}</button>`).join('');
   for(const button of root.querySelectorAll('button'))button.disabled=state.busy||!state.online;
   root.querySelector('#research-import').disabled=state.busy||!state.online;
   root.querySelector('#research-manifest').disabled=state.busy;
  };
  const run=async operation=>{
   if(state.busy||!state.online)return;
   state.busy=true;state.error='';show();
   try{const value=await operation();if(current())state.result=value;}catch(error){if(current())state.error=error.message;}
   finally{state.busy=false;show();}
  };
  const list=async()=>{const data=await api('research/experiments');if(current())state.data=data;return data;};
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
}
