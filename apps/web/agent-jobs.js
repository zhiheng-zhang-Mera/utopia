import {getLocale} from './i18n/index.js';
import {captureFocus, restoreFocus, detailsOpen} from './view-persistence.js';
const L=(en,zh)=>getLocale()==='zh-CN'?zh:en;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/**
 * CITY-AGENT-JOB — the owner's control surface for the OTHER kind of remote work.
 *
 * The sibling surface (`remote-operation.js`) makes a machine run a program the City named and hands back the bytes it
 * produced. This one is the honest counterpart for the case the City cannot verify at all: the machine on the far end is
 * driven by an AGENT, so the City hands over a REQUEST and takes back a REPORT. Both are DIRECT_CONTROL, and 14A's
 * obligations are the same - a discoverable entry, a control that really reaches the canonical backend, the real result,
 * a confirmation, and a way to stop - but the SURFACE has one extra duty that the other does not:
 *
 *   IT MUST NOT LET A REPORT LOOK LIKE A VERIFICATION. Everything in the job list below is labelled by who said it. The
 *   City's own words (`QUEUED`, `RUNNING`, `COMPLETED`, the node that took it) appear as state; the agent's words appear
 *   under "what the agent says", with its own declared evidence class, and with the City's standing statement that the
 *   report carries no acceptance authority. Rendering the two in one undifferentiated block is exactly how "the agent
 *   said it worked" would come to be read as "the City found that it worked".
 *
 * Two smaller decisions worth being able to check:
 *   THE DEADLINE IS A PROJECTION, and says so. No scheduler runs, so a job past its deadline is shown as expired while
 *   the canonical task still shows the state it actually reached.
 *   REFERENCES, NOT SECRETS. An input line is a NAME and either a reference the far side resolves itself; the City
 *   refuses a credential-shaped key or value by name, so the form does not offer a field that could hold a token.
 */
export function createAgentJobsView(){
 let state=null,pendingDraft=null;
 return {seedDraft(draft,contextKey){pendingDraft={draft:structuredClone(draft),contextKey};},reset(){if(state?.timer)clearTimeout(state.timer);state=null;pendingDraft=null;},render(root,{contextKey,online,api,isCurrent}){
  if(!state||state.contextKey!==contextKey)state={contextKey,draft:{nodeRef:'',title:'',instruction:'',purpose:'',refs:'',deadlineMinutes:'30'},confirm:'',data:null,nodes:[],error:'',busy:false,timer:null,dangerOpen:false};
  if(pendingDraft){if(pendingDraft.contextKey===contextKey){const d=pendingDraft.draft;Object.assign(state.draft,{nodeRef:d.targetDeviceRef??'',title:d.job?.title??'',instruction:d.job?.instruction??'',purpose:d.job?.purpose??'',confirm:''});state.requestText=d.requestText;}pendingDraft=null;}
  if(!online)state.draft.confirm='';
  const s=state;s.online=online;const current=()=>state===s&&isCurrent();
  // The page is re-rendered on every City event and every four seconds, so the Danger Zone's open state and the field
  // being typed into are carried across the rebuild rather than being thrown away with the DOM.
  const focus=captureFocus(root);
  root.innerHTML=`<section class="panel"><h2>${L('Agent jobs','智能体任务')}</h2>
   <p>${L('Ask an agent on another of this City\u2019s machines to do something and report back. The City carries the request and records the answer; it cannot see inside an agent, so it never presents the answer as something it verified.','请本城另一台机器上的智能体做一件事并回报。本城负责传递请求与记录答复；本城无法看到智能体内部，因此绝不把答复当作自己验证过的结论。')}</p>
   <p id="aj-state" role="status"></p>
   <p id="aj-error" role="alert"></p>
   <button id="aj-refresh">${L('Refresh','刷新')}</button></section>
   <section class="panel" style="margin-top:12px"><h2>${L('Ask for something','请求智能体执行')}</h2>
   <label for="aj-node">${L('Machine whose agent should answer','应答智能体所在的机器')}</label><select id="aj-node"></select>
   <label for="aj-title">${L('Short title','简短标题')}</label><input id="aj-title" autocomplete="off">
   <label for="aj-instruction">${L('What to do, in words','要做什么（用文字描述）')}</label><textarea id="aj-instruction" rows="5"></textarea>
   <label for="aj-refs">${L('References, one per line as name=ref (optional)','引用，每行 name=ref（可选）')}</label><textarea id="aj-refs" rows="3" spellcheck="false"></textarea>
   <label for="aj-purpose">${L('Why (required)','目的（必填）')}</label><input id="aj-purpose" autocomplete="off">
   <label for="aj-deadline">${L('Deadline (minutes)','截止时间（分钟）')}</label><input id="aj-deadline" inputmode="numeric">
   <details id="aj-danger"${detailsOpen(s,'dangerOpen')}><summary id="aj-danger-summary">${L('Danger Zone — ask a remote agent to act','危险区 — 请求远端智能体行动')}</summary>
   <p>${L('This hands a real request to whatever agent is answering for that machine. The City records what you asked, who took it and what came back - but the answer is the agent\u2019s own claim, and the City will say so. Type the title below to confirm.','这会把一个真实请求交给那台机器上应答的智能体。本城会记录你请求了什么、由谁领取、返回了什么——但答复是智能体自己的说法，本城会明确标注。请在下方输入标题以确认。')}</p>
   <label for="aj-confirm">${L('Type the title to confirm','输入标题以确认')}</label><input id="aj-confirm" autocomplete="off" spellcheck="false">
   <button id="aj-dispatch">${L('Ask it','发出请求')}</button></details></section>
   <section class="panel" style="margin-top:12px"><h2>${L('Jobs and what came back','任务与答复')}</h2><div id="aj-list"></div></section>`;
  const show=()=>{
   if(!current()||!root.querySelector('#aj-list'))return;
   root.querySelector('#aj-error').textContent=s.error;
   const config=s.data?.config??null;
   const exposure=s.data?.exposure??null;
   root.querySelector('#aj-state').textContent=config?(config.enabled===true
     ?L('Enabled. Jobs can be handed to a machine whose agent answers for it.','已启用。可以把任务交给有智能体应答的机器。')
     :L('This City has not enabled agent jobs. Nothing can be dispatched.','本城未启用智能体任务，无法派发。')):'';
   if(exposure&&s.data)root.querySelector('#aj-state').textContent+=` ${L('Class','等级')}: ${esc(exposure.exposureClass)}`;
   const wanted=s.draft.nodeRef;
   root.querySelector('#aj-node').innerHTML=`<option value=""></option>`+s.nodes.map(n=>`<option value="${esc(n.id)}"${n.id===wanted?' selected':''}>${esc(n.displayName??n.id)}${n.online?'':' ('+L('offline','离线')+')'}</option>`).join('');
   for(const [id,key] of [['aj-title','title'],['aj-instruction','instruction'],['aj-refs','refs'],['aj-purpose','purpose'],['aj-deadline','deadlineMinutes'],['aj-confirm','confirm']]){
    const node=root.querySelector('#'+id);if(node&&node.value!==String(s.draft[key]??''))node.value=s.draft[key]??'';
   }
   const rows=s.data?.jobs??[];
   root.querySelector('#aj-list').innerHTML=rows.length?rows.map(job=>{
    const report=job.report;
    const validation=job.reportValidation;
    // The City's own facts and the agent's claims are rendered in SEPARATE blocks, in that order, so the reader always
    // knows which one they are looking at.
    const cityFacts=`<p>${L('State','状态')}: <span data-aj-state="${esc(job.state)}">${esc(job.state)}</span> · ${L('taken by','领取者')} ${esc(job.assignedNodeId??L('nobody yet','尚无'))}${job.deadline?.projectedState?` · <span data-aj-deadline="${esc(job.deadline.projectedState)}">${esc(job.deadline.projectedState)}</span> (${L('deadline passed','已过截止时间')})`:''}</p>
     <p>${L('Why','目的')}: ${esc(job.job?.purpose??'')}</p>`;
    const agentClaims=report?`<div data-aj-report>
      <p><strong>${L('What the agent says','智能体的说法')}</strong>: ${esc(report.state??'')} · ${L('evidence','证据类别')} <span data-aj-evidence="${esc(report.evidence??'')}">${esc(report.evidence??'')}</span></p>
      <p>${esc(report.summary??'')}</p>
      ${(report.artifacts??[]).length?`<ul>${report.artifacts.map(a=>`<li><code>${esc(a.name)}</code> ${esc(a.sha256??'')}</li>`).join('')}</ul>`:''}
      ${report.reason?`<p role="alert">${L('Reason given','给出的原因')}: ${esc(report.reason)}</p>`:''}
      <p role="note">${L('This is the agent\u2019s own claim. The City did not verify it.','这是智能体自己的说法，本城并未验证。')}</p>
      ${validation&&validation.valid===false?`<p role="alert">${L('The City refused this report','本城拒绝了该回执')}: ${esc(validation.code)}</p>`:''}</div>`:`<p>${L('No report yet.','尚无答复。')}</p>`;
    // Taking delivery is shown as its OWN state, because "the agent answered" and "the answer was taken" are different
    // facts: an answer nobody has collected is the one that gets asked for twice. The receipt is printed with its own
    // authority line so delivery can never be read as agreement with what the agent said.
    const delivery=job.consumption?`<p data-aj-consumed="${esc(job.consumption.receiptDigest)}">${L('Collected','已收讫')}: ${esc(job.consumption.consumedAt)} · <code>${esc(job.consumption.authority)}</code>${job.consumption.note?` · ${esc(job.consumption.note)}`:''}</p>`
      :(report?`<button data-aj-consume="${esc(job.taskId)}">${L('Mark the report as collected','标记该报告已收讫')}</button>`:'');
    const running=['QUEUED','ASSIGNED','RUNNING'].includes(job.state);
    return `<article class="aj-row" data-job="${esc(job.taskId)}"><p><strong>${esc(job.job?.title??L('untitled job','未命名任务'))}</strong></p>
     ${cityFacts}
     ${job.targetStateDetail?`<p role="alert">${L('Waiting: the target cannot take this job yet','等待中：目标暂时无法领取该任务')} — ${esc(job.targetStateDetail)}</p>`:(job.targetStateAtCreation==='INELIGIBLE'?`<p role="alert">${L('The target was not eligible for this job: its agent does not answer for jobs yet.','目标不具备资格：该机器的智能体尚未声明可领取任务。')}</p>`:'')}
     ${job.error?`<p role="alert">${esc(typeof job.error==='string'?job.error:JSON.stringify(job.error))}</p>`:''}
     <details><summary>${L('What was asked','请求内容')}</summary><pre>${esc(job.job?.instruction??'')}</pre>${(job.job?.inputs??[]).length?`<pre>${esc((job.job.inputs??[]).map(i=>i.name+'='+(i.ref??i.text??'')).join('\n'))}</pre>`:''}</details>
     ${agentClaims}
     ${delivery}
     ${running?`<button data-aj-stop="${esc(job.taskId)}">${L('Withdraw the request','撤回请求')}</button>`:''}</article>`;
   }).join(''):`<p>${L('No agent job has been dispatched from this City.','本城尚未派发过智能体任务。')}</p>`;
   for(const button of root.querySelectorAll('button'))button.disabled=s.busy||!s.online;
   // Re-evaluated on every paint, so the button cannot be live while the typed confirmation is wrong.
   const dispatch=root.querySelector('#aj-dispatch');
   if(dispatch)dispatch.disabled=dispatch.disabled||!(config?.enabled&&s.draft.title&&s.draft.instruction&&s.draft.purpose&&s.draft.confirm===s.draft.title);
   // A job that is still out keeps its state fresh without the owner pressing Refresh, and the poll stops on its own
   // when nothing is pending and is cleared when the page is left, so it cannot outlive the view.
   if(s.timer)clearTimeout(s.timer);
   const pending=(s.data?.jobs??[]).some(job=>['QUEUED','ASSIGNED','RUNNING'].includes(job.state));
   if(pending&&s.online)s.timer=setTimeout(async()=>{if(!current())return;try{await load();}catch{/* the next paint reports it */}if(current())show();},1500);
  };
  const run=async fn=>{if(s.busy||!s.online)return;s.busy=true;s.error='';show();try{await fn();}catch(e){if(current())s.error=e.message;}finally{s.busy=false;show();}};
  const load=async()=>{const [data,nodes]=await Promise.all([api('node/jobs'),api('nodes')]);if(current()){s.data=data;s.nodes=nodes.nodes??[];}};
  const invalidate=()=>{s.pendingFingerprint=null;s.pendingKey=null;s.draft.confirm='';root.querySelector('#aj-confirm').value='';};
  const bind=(id,key)=>root.querySelector('#'+id).oninput=e=>{s.draft[key]=e.target.value;if(key!=='confirm')invalidate();show();};
  for(const [id,key] of [['aj-title','title'],['aj-instruction','instruction'],['aj-refs','refs'],['aj-purpose','purpose'],['aj-deadline','deadlineMinutes'],['aj-confirm','confirm']])bind(id,key);
  // Opening or closing the zone is the OWNER's state, so it is remembered in the view rather than in an attribute the
  // next re-render discards.
  root.querySelector('#aj-danger').ontoggle=e=>{s.dangerOpen=e.target.open;};
  root.querySelector('#aj-node').onchange=e=>{s.draft.nodeRef=e.target.value;invalidate();show();};
  root.querySelector('#aj-refresh').onclick=()=>run(load);
  root.querySelector('#aj-list').onclick=e=>{
   const stop=e.target.closest('[data-aj-stop]');
   // Withdrawing is the CANONICAL cancel route every task already uses - the job has no second control plane, and the
   // City's record of the owner's decision is the one the task state machine keeps.
   if(stop)run(async()=>{await api('tasks/'+encodeURIComponent(stop.dataset.ajStop)+'/cancel',{});await load();});
   // Taking delivery is the owner's own act, recorded as a receipt by the City. It is NOT a verification, and the
   // receipt says so on its face; the button therefore never reads "accept".
   const consume=e.target.closest('[data-aj-consume]');
   if(consume)run(async()=>{await api('node/jobs/'+encodeURIComponent(consume.dataset.ajConsume)+'/consumed',{});await load();});
  };
  root.querySelector('#aj-dispatch').onclick=()=>run(async()=>{
   // A reference line is `name=ref`. A line without `=` is refused here rather than sent as a nameless input, because
   // the City's own refusal for that is a 422 the owner should not have to decode.
   const inputs=[];let line=0;
   for(const raw of s.draft.refs.split('\n')){
    const text=raw.trim();line++;
    if(text==='')continue;
    const at=text.indexOf('=');
    if(at<=0){s.error=L(`Reference line ${line} must read name=ref`,`第 ${line} 行引用必须写成 name=ref`);return;}
    inputs.push({name:text.slice(0,at).trim(),ref:text.slice(at+1).trim()});
   }
   const job={title:s.draft.title.trim(),instruction:s.draft.instruction.trim(),purpose:s.draft.purpose.trim()};
   if(inputs.length)job.inputs=inputs;
   const minutes=Number(s.draft.deadlineMinutes);
   if(Number.isSafeInteger(minutes)&&minutes>0)job.deadlineMs=minutes*60000;
   const body={intent:s.requestText??'Agent job',route:'CITY_TASK',target:'city.task',operation:'AGENT_JOB',input:{targetDeviceRef:s.draft.nodeRef,job}};
   const fingerprint=JSON.stringify(body);
   if(s.pendingFingerprint!==fingerprint){s.pendingFingerprint=fingerprint;s.pendingKey=crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+Math.random();}
   let created;
   try{created=await api('actions',{...body,idempotencyKey:s.pendingKey});s.pendingFingerprint=null;s.pendingKey=null;}
   catch(error){if(Number.isInteger(error.status)){s.pendingFingerprint=null;s.pendingKey=null;}throw error;}
   // A refusal is a RESULT the owner must see: the Action facade reports it as a refused action rather than as a thrown
   // error, so it is surfaced instead of being swallowed by a successful-looking response.
   if(created?.action?.status==='REFUSED')s.error=`${created.action.error?.code}: ${created.action.error?.message}`;
   s.draft.confirm='';
   await load();
  });
  show();restoreFocus(root,focus);if(!s.data&&!s.busy&&online)run(load);
 }};
}
