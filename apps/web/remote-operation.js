import {getLocale} from './i18n/index.js';
import {captureFocus, restoreFocus, detailsOpen} from './view-persistence.js';
const L=(en,zh)=>getLocale()==='zh-CN'?zh:en;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/**
 * CITY-REMOTE-OPERATION — the owner's control surface.
 *
 * CONSTRUCTION_RULES 14A puts this capability in DIRECT_CONTROL, which is not a filing decision but a list of
 * obligations: a discoverable entry, a control that really reaches the canonical backend, the REAL result of the
 * owner's own action (accepted / running / refused / completed / failed), a confirmation before the high-impact part,
 * and a way to stop it. A page that only documents the API would fail every one of them.
 *
 * Two decisions the reader should be able to check rather than trust:
 *
 *   ARGUMENTS ARE ONE PER LINE. A single "command line" box would have to invent a quoting rule, and any quoting rule
 *   is a shell by another name. JSON arrays preserve empty strings and newlines; the legacy one-per-line form remains available, so
 *   what the owner typed and what the node runs are the same list - a space or a quote in an argument is just data.
 *
 *   THE DANGER ZONE IS A GATE, NOT A LABEL. The dispatch button lives behind a collapsed region and a typed
 *   confirmation, and the page will not send the request without it. The disabled-by-default state is shown as a fact
 *   read from the City, not inferred from a missing button.
 */
export function createRemoteOperationView(){
 let state=null,pendingDraft=null;
 return {seedDraft(draft,contextKey){pendingDraft={draft:structuredClone(draft),contextKey};},reset(){if(state?.timer)clearTimeout(state.timer);state=null;pendingDraft=null;},render(root,{contextKey,online,api,isCurrent}){
  if(!state||state.contextKey!==contextKey)state={contextKey,draft:{nodeRef:'',executable:'',argv:'',cwd:'',purpose:'',timeoutMs:'',maxOutputBytes:''},confirm:'',data:null,nodes:[],error:'',busy:false,open:null,timer:null,dangerOpen:false};
  if(pendingDraft){if(pendingDraft.contextKey===contextKey){const d=pendingDraft.draft;Object.assign(state.draft,{nodeRef:d.targetDeviceRef??'',executable:d.operation?.executable??'',argv:JSON.stringify(d.operation?.argv??[]),cwd:d.operation?.cwd??'',purpose:d.operation?.purpose??'',confirm:''});state.requestText=d.requestText;}pendingDraft=null;}
  if(!online)state.draft.confirm='';
  const s=state;s.online=online;const current=()=>state===s&&isCurrent();
  // The page is re-rendered on every City event and every four seconds, so the Danger Zone's open state and the field
  // being typed into are carried across the rebuild rather than being thrown away with the DOM. Without this an owner
  // typing their confirmation had the region snap shut underneath them - and browser tests failed "element is not
  // visible" whenever the four-second tick landed mid-run.
  const focus=captureFocus(root);
  root.innerHTML=`<section class="panel"><h2>${L('Remote operation','远程操作')}</h2>
   <p>${L('Run an approved program on one of this City\u2019s machines, as the City owner. The City never uses a shell: the executable and its arguments are passed as a list, and the working directory must be inside a workspace this City declared at startup.','以城市 Owner 身份在本城某台机器上运行一个已批准的程序。本城从不使用 shell：可执行文件与参数以列表传递，工作目录必须位于本城启动时声明的工作区内。')}</p>
   <p id="rop-state" role="status"></p>
   <p id="rop-error" role="alert"></p>
   <button id="rop-refresh">${L('Refresh','刷新')}</button></section>
   <section class="panel" style="margin-top:12px"><h2>${L('Run a program','运行程序')}</h2>
   <label for="rop-node">${L('Target machine','目标机器')}</label><select id="rop-node"></select>
   <label for="rop-executable">${L('Executable (must be on the allowlist)','可执行文件（必须在允许列表内）')}</label><input id="rop-executable" autocomplete="off" spellcheck="false">
   <label for="rop-argv">${L('Arguments: JSON array or one per line','参数：JSON 数组或每行一个')}</label><textarea id="rop-argv" rows="4" spellcheck="false"></textarea>
   <label for="rop-cwd">${L('Working directory','工作目录')}</label><input id="rop-cwd" autocomplete="off" spellcheck="false">
   <label for="rop-purpose">${L('Why (required)','目的（必填）')}</label><input id="rop-purpose" autocomplete="off">
   <div class="rop-bounds"><label for="rop-timeout">${L('Timeout (ms)','超时（毫秒）')}</label><input id="rop-timeout" inputmode="numeric">
   <label for="rop-output">${L('Output cap (bytes)','输出上限（字节）')}</label><input id="rop-output" inputmode="numeric"></div>
   <details id="rop-danger"${detailsOpen(s,'dangerOpen')}><summary id="rop-danger-summary">${L('Danger Zone — run on another machine','危险区 — 在另一台机器上运行')}</summary>
   <p>${L('This starts a real program on the machine you selected. The City records what it ran, where, why and what came back. Type the executable name below to confirm.','这会在你选定的机器上启动一个真实程序。本城会记录运行了什么、在哪里、为什么，以及返回了什么。请在下方输入可执行文件名以确认。')}</p>
   <label for="rop-confirm">${L('Type the executable name to confirm','输入可执行文件名以确认')}</label><input id="rop-confirm" autocomplete="off" spellcheck="false">
   <button id="rop-dispatch">${L('Run it','运行')}</button></details></section>
   <section class="panel" style="margin-top:12px"><h2>${L('Recent operations','最近的操作')}</h2><div id="rop-list"></div></section>`;
  const show=()=>{
   if(!current()||!root.querySelector('#rop-list'))return;
   root.querySelector('#rop-error').textContent=s.error;
   const config=s.data?.config??null;
   const exposure=s.data?.exposure??null;
   root.querySelector('#rop-state').textContent=config?(config.enabled===true
     ?L(`Enabled. Allowed: ${(config.allowlist??[]).join(', ')||'nothing'}. Workspaces: ${(config.workspaces??[]).join(', ')||'none'}.`,
         `已启用。允许：${(config.allowlist??[]).join('、')||'无'}。工作区：${(config.workspaces??[]).join('、')||'无'}。`)
     :L('This City has not enabled remote operation. Nothing can be dispatched.','本城未启用远程操作，无法派发任何任务。')):'';
   if(exposure&&s.data)root.querySelector('#rop-state').textContent+=` ${L('Class','等级')}: ${esc(exposure.exposureClass)}`;
   const wanted=s.draft.nodeRef;
   root.querySelector('#rop-node').innerHTML=`<option value=""></option>`+s.nodes.map(n=>`<option value="${esc(n.id)}"${n.id===wanted?' selected':''}>${esc(n.displayName??n.id)}${n.online?'':' ('+L('offline','离线')+')'}</option>`).join('');
   for(const [id,key] of [['rop-executable','executable'],['rop-argv','argv'],['rop-cwd','cwd'],['rop-purpose','purpose'],['rop-timeout','timeoutMs'],['rop-output','maxOutputBytes'],['rop-confirm','confirm']]){
    const node=root.querySelector('#'+id);if(node&&node.value!==String(s.draft[key]??''))node.value=s.draft[key]??'';
   }
   const rows=s.data?.operations??[];
   root.querySelector('#rop-list').innerHTML=rows.length?rows.map(op=>{
    const receipt=op.receipt;
    const verdict=receipt?(receipt.valid?L('receipt verified by the City','回执已由本城复核'):L('receipt REFUSED','回执被拒绝')+': '+esc(receipt.code)):L('no receipt yet','尚无回执');
    const running=op.state==='RUNNING'||op.state==='QUEUED'||op.state==='ASSIGNED';
    return `<article class="rop-row" data-op="${esc(op.taskId)}"><p><strong>${esc(op.executable??'')} ${esc((op.argv??[]).join(' '))}</strong></p>
     <p>${L('State','状态')}: <span data-rop-state="${esc(op.state)}">${esc(op.state)}</span> · ${L('on','于')} ${esc(op.assignedNodeId??L('unassigned','未分配'))} · ${L('exit','退出码')} ${receipt&&receipt.valid?esc(String(receipt.exitCode)):'—'}</p>
     <p>${L('Why','目的')}: ${esc(op.purpose??'')}</p>
     <p>${esc(verdict)}${receipt&&receipt.valid&&receipt.timedOut?L(' · timed out',' · 已超时'):''}</p>
     ${op.targetStateDetail?`<p role="alert">${L('Waiting: the target cannot take this operation yet','等待中：目标暂时无法执行该操作')} — ${esc(op.targetStateDetail)}</p>`:(op.targetStateAtCreation==='INELIGIBLE'?`<p role="alert">${L('The target was not eligible for this operation.','目标不具备执行该操作的资格。')}</p>`:'')}
     ${op.error?`<p role="alert">${esc(typeof op.error==='string'?op.error:JSON.stringify(op.error))}</p>`:''}
     <details><summary>${L('What came back','返回内容')}</summary><pre>${esc(op.result?.stdout??'')}</pre><pre>${esc(op.result?.stderr??'')}</pre>${op.result?.truncated?`<p role="alert">${L('The output was truncated at the declared cap.','输出已在声明的上限处截断。')}</p>`:''}</details>
     ${running?`<button data-rop-stop="${esc(op.taskId)}">${L('Stop','停止')}</button>`:''}</article>`;
   }).join(''):`<p>${L('No operation has been dispatched from this City.','本城尚未派发过任何操作。')}</p>`;
   for(const button of root.querySelectorAll('button'))button.disabled=s.busy||!s.online;
   // The gate is re-evaluated on every paint, so the button can never be live while the confirmation is wrong.
   const dispatch=root.querySelector('#rop-dispatch');
   if(dispatch)dispatch.disabled=dispatch.disabled||!(config?.enabled&&s.draft.executable&&s.draft.confirm===s.draft.executable);
   // An operation that is still out has to keep showing its progress without the owner pressing Refresh: 14A requires
   // the owner to SEE accepted / running / completed, and an operation that only moves when someone clicks a button
   // is a surface that reports the state it had at dispatch time. The poll stops on its own when nothing is pending
   // and is cleared when the page is left, so it cannot outlive the view.
   if(s.timer)clearTimeout(s.timer);
   const pending=(s.data?.operations??[]).some(op=>['QUEUED','ASSIGNED','RUNNING'].includes(op.state));
   if(pending&&s.online)s.timer=setTimeout(async()=>{if(!current())return;try{await load();}catch{/* the next paint reports it */}if(current())show();},1000);
  };
  const run=async fn=>{if(s.busy||!s.online)return;s.busy=true;s.error='';show();try{await fn();}catch(e){if(current())s.error=e.message;}finally{s.busy=false;show();}};
  const load=async()=>{const [data,nodes]=await Promise.all([api('node/operations'),api('nodes')]);if(current()){s.data=data;s.nodes=nodes.nodes??[];}};
  const invalidate=()=>{s.draft.confirm='';root.querySelector('#rop-confirm').value='';};
  const bind=(id,key)=>root.querySelector('#'+id).oninput=e=>{s.draft[key]=e.target.value;if(key!=='confirm')invalidate();show();};
  for(const [id,key] of [['rop-executable','executable'],['rop-argv','argv'],['rop-cwd','cwd'],['rop-purpose','purpose'],['rop-timeout','timeoutMs'],['rop-output','maxOutputBytes'],['rop-confirm','confirm']])bind(id,key);
  root.querySelector('#rop-danger').ontoggle=e=>{s.dangerOpen=e.target.open;};
  root.querySelector('#rop-node').onchange=e=>{s.draft.nodeRef=e.target.value;invalidate();show();};
  root.querySelector('#rop-refresh').onclick=()=>run(load);
  root.querySelector('#rop-list').onclick=e=>{
   const stop=e.target.closest('[data-rop-stop]');
   if(stop)run(async()=>{await api('tasks/'+encodeURIComponent(stop.dataset.ropStop)+'/cancel',{});await load();});
  };
  root.querySelector('#rop-dispatch').onclick=()=>run(async()=>{
   const operation={executable:s.draft.executable.trim(),argv:parseRemoteArgv(s.draft.argv),cwd:s.draft.cwd.trim(),purpose:s.draft.purpose.trim()};
   if(s.draft.timeoutMs!=='')operation.timeoutMs=Number(s.draft.timeoutMs);
   if(s.draft.maxOutputBytes!=='')operation.maxOutputBytes=Number(s.draft.maxOutputBytes);
   const created=await api('actions',{intent:s.requestText??'Remote operation',route:'CITY_TASK',target:'city.task',operation:'OWNER_REMOTE_OPERATION',
    input:{targetDeviceRef:s.draft.nodeRef,operation},
    idempotencyKey:(crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+Math.random())});
   // A refusal is a RESULT the owner must see. The Action facade reports it as a refused action rather than as a
   // thrown error, so it is surfaced here instead of being swallowed by a successful-looking response.
   if(created?.action?.status==='REFUSED')s.error=`${created.action.error?.code}: ${created.action.error?.message}`;
   s.draft.confirm='';
   await load();
  });
  show();restoreFocus(root,focus);if(!s.data&&!s.busy&&online)run(load);
 }};
}

export function parseRemoteArgv(value){
 const raw=String(value??'');
 if(raw.trim().startsWith('[')){const result=JSON.parse(raw);if(!Array.isArray(result)||!result.every(v=>typeof v==='string'))throw new TypeError('argv JSON must be an array of strings');return result;}
 return raw.split('\n').filter(v=>v!=='');
}
