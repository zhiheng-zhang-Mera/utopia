import {getLocale} from './i18n/index.js';
const L=(en,zh)=>getLocale()==='zh-CN'?zh:en;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createGovernanceView(){
 let state=null;
 return {reset(){state=null;},render(root,{contextKey,online,api,isCurrent}){
  if(!state||state.contextKey!==contextKey)state={contextKey,draft:'',data:null,result:null,error:'',busy:false};
  const s=state;s.online=online;const current=()=>state===s&&isCurrent();
  root.innerHTML=`<section class="panel"><h2>${L('Governance process','审议治理过程')}</h2><p>${L('See how a request was split, who contributed, what evidence supports it, and what remains unresolved.','查看请求如何拆分、谁参与、证据是什么，以及哪些问题尚未解决。')}</p><button id="governance-refresh">${L('Refresh cases','刷新案例')}</button><p id="governance-error" role="alert"></p><div id="governance-list"></div><details><summary id="governance-import-details">${L('Import an explicit case','导入显式案例')}</summary><label for="governance-draft">${L('Case document','案例文档')}</label><textarea id="governance-draft" rows="10" style="width:100%;box-sizing:border-box" spellcheck="false"></textarea><button id="governance-create">${L('Save case','保存案例')}</button><p>${L('Saving a case records a governance plan. Execution and release still require verified evidence.','保存案例仅登记治理计划。执行与发布仍需经过验证的证据。')}</p></details></section><section class="panel" style="margin-top:12px"><h2>${L('Process capsule','过程摘要')}</h2><div id="governance-l0"></div><details><summary id="governance-l1-toggle">${L('Claims, objections and adjudication','主张、异议与仲裁')}</summary><pre id="governance-l1"></pre></details><details><summary id="governance-l2-toggle">${L('Technical evidence','技术证据')}</summary><pre id="governance-l2"></pre></details></section>`;
  const show=()=>{
   if(!current()||!root.querySelector('#governance-list'))return;
   root.querySelector('#governance-error').textContent=s.error;
   const data=s.data?.governance;
   root.querySelector('#governance-list').innerHTML=(data&&data.health!=='READY'?`<p role="alert">${L('Case evidence is incomplete or unavailable.','案例证据不完整或不可用。')} ${esc(data.errors?.join(', '))}</p>`:'')+(data?.cases??[]).map(c=>`<button data-governance-case="${esc(c.case_ref)}">${esc(c.case_ref)} · ${esc(c.release_state)}</button>`).join('');
   const capsule=s.result?.governance?.process_capsule;
   root.querySelector('#governance-l0').innerHTML=capsule?`<p role="status">${L('Release gate','发布门')}：${esc(capsule.L0.release_gate.state)}</p>${capsule.L0.active_risk?`<p role="alert">${L('Active risk or unverified evidence remains.','仍存在风险或未验证证据。')}</p>`:''}<dl><dt>${L('Accepted scope','已接受范围')}</dt><dd>${esc(capsule.L0.accepted_scope.join(' · '))}</dd><dt>${L('Decomposition','问题拆分')}</dt><dd>${esc(capsule.L0.decomposition_summary.map(x=>x.question).join(' · '))}</dd><dt>${L('Participants','参与者')}</dt><dd>${esc(capsule.L0.participants.map(x=>x.participant_ref+' / '+x.role).join(' · ')||L('Not assigned','尚未分配'))}</dd><dt>${L('Uncertainty','不确定性')}</dt><dd>${esc(capsule.L0.residual_uncertainty.join(' · ')||L('None recorded','未记录'))}</dd><dt>${L('Conflicts','冲突')}</dt><dd>${esc(capsule.L0.material_conflicts.map(x=>x.statement).join(' · ')||L('None recorded','未记录'))}</dd><dt>${L('Validation','验证')}</dt><dd>${esc(capsule.L0.validation_performed.map(x=>x.evidence_ref+' / '+x.state).join(' · ')||L('Not observed','未观察'))}</dd><dt>${L('Warnings','警告')}</dt><dd>${esc(capsule.L0.warnings.join(' · '))}</dd></dl><details><summary>${L('Assignment, results and decisions','分配、结果与决策')}</summary><pre>${esc(JSON.stringify({assignment:capsule.L0.assignment_basis,outcomes:capsule.L0.node_outcomes,adjudication:capsule.L0.adjudication_outcomes,release:capsule.L0.release_gate},null,2))}</pre></details>`:`<p>${L('Select a case to inspect its process.','选择一个案例以查看过程。')}</p>`;
   root.querySelector('#governance-l1').textContent=capsule?JSON.stringify(capsule.L1,null,2):'';
   root.querySelector('#governance-l2').textContent=capsule?JSON.stringify(capsule.L2,null,2):'';
   for(const button of root.querySelectorAll('button'))button.disabled=s.busy||!s.online;
  };
  const run=async fn=>{if(s.busy||!s.online)return;s.busy=true;s.error='';show();try{await fn();}catch(e){if(current())s.error=e.message;}finally{s.busy=false;show();}};
  const load=async()=>{const data=await api('governance');if(current())s.data=data;};
  root.querySelector('#governance-draft').value=s.draft;
  root.querySelector('#governance-draft').oninput=e=>{s.draft=e.target.value;};
  root.querySelector('#governance-refresh').onclick=()=>run(load);
  root.querySelector('#governance-list').onclick=e=>{const b=e.target.closest('[data-governance-case]');if(b)run(async()=>{const r=await api('governance/'+encodeURIComponent(b.dataset.governanceCase));if(current())s.result=r;});};
  root.querySelector('#governance-create').onclick=()=>run(async()=>{const r=await api('governance',JSON.parse(s.draft));if(current()){s.result=r;show();}await load();});
  show();if(!s.data&&!s.busy&&online)run(load);
 }};
}
