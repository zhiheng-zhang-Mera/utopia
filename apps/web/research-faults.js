import {getLocale} from './i18n/index.js';
const states=new WeakMap(),L=(en,zh)=>getLocale()==='zh-CN'?zh:en;
export function renderFaults(container,online,api,key){
 let state=states.get(container);if(!state||state.key!==key){state={key,active:null,busy:false,data:null};states.set(container,state);}state.online=online;
 let root=container.querySelector('#fault-danger');
 if(!root||root._state!==state||root.dataset.locale!==getLocale()){
  root?.remove();root=document.createElement('details');root.id='fault-danger';root.className='panel';root._state=state;root.dataset.locale=getLocale();container.append(root);
  root.innerHTML=`<summary>${L('Advanced / Danger Zone: controlled faults','高级 / 危险区：受控故障')}</summary><p>${L('Affects every task on the selected worker for a bounded time. Heartbeat loss may mark it offline and fail active work. Provider unavailable refuses claims. Delay result holds reports. Duplicate event repeats research observation only. Emergency stop removes injection; failed tasks still require a new run.','在有限时间内影响所选 worker 的全部任务。心跳丢失可能使其离线并导致活动任务失败；执行入口不可用会拒绝领取；结果延迟会暂缓回报；重复事件只重复研究观察。紧急停止解除注入，已失败任务仍需新建运行。')}</p>
  <label>${L('Explicit target worker','明确目标 worker')}<select id="fault-node"></select></label><label>${L('Fault class','故障类型')}<select id="fault-kind"></select></label>
  <label>${L('Bounded duration (ms, max 30000)','有界时长（毫秒，最多 30000）')}<input id="fault-duration" type="number" min="1" max="30000" value="10000"></label>
  <p id="fault-confirmation-hint"></p><label>${L('Type confirmation','输入确认内容')}<input id="fault-confirmation" autocomplete="off"></label>
  <button id="fault-start">${L('Confirm and inject','确认并注入')}</button><button id="fault-stop">${L('Emergency stop selected fault','紧急停止所选故障')}</button><button id="fault-refresh">${L('Refresh recovery and history','刷新恢复状态与历史')}</button><p id="fault-store-status" role="status"></p><p id="fault-error" role="alert"></p><div id="fault-list"></div><pre id="fault-output" role="status" style="white-space:pre-wrap;max-height:24rem;overflow:auto"></pre>`;
  const current=()=>root.isConnected&&states.get(container)===state&&container.querySelector('#fault-danger')===root;
  const show=()=>{if(!current())return;root.querySelector('#fault-output').textContent=state.data?JSON.stringify(state.data,null,2):'';root.querySelector('#fault-start').disabled=state.busy||!state.online||state.storeUnavailable;root.querySelector('#fault-store-status').textContent=state.storeUnavailable?L('Fault storage is unavailable. Injection is disabled; normal City tasks remain available.','故障存储不可用，注入已禁用；普通City任务仍可使用。'):'';root.querySelector('#fault-refresh').disabled=state.busy||!state.online;root.querySelector('#fault-stop').disabled=!state.online||!state.active;};
  const action=async(fn,emergency=false)=>{if(!state.online||state.busy&&!emergency)return;state.busy=true;root.querySelector('#fault-error').textContent='';show();try{const data=await fn();if(current())state.data=data;}catch(error){if(current())root.querySelector('#fault-error').textContent=error.message;}finally{state.busy=false;show();}};
  const hint=()=>{root.querySelector('#fault-confirmation-hint').textContent=L('Required confirmation: ','必须输入的确认内容：')+'FAULT:'+root.querySelector('#fault-kind').value+':'+root.querySelector('#fault-node').value;root.querySelector('#fault-confirmation').value='';};
  const refresh=async()=>{
   const [data,nodes]=await Promise.all([api('research/faults'),api('nodes')]);if(!current())return data;
   state.storeUnavailable=data.storeState==='UNAVAILABLE';
   const kinds=root.querySelector('#fault-kind');if(!kinds.options.length)for(const kind of data.kinds){const option=document.createElement('option');option.value=kind;option.textContent=kind;kinds.append(option);}
   const selected=root.querySelector('#fault-node').value;const target=root.querySelector('#fault-node');target.replaceChildren();for(const node of nodes.nodes.filter(n=>n.online)){const option=document.createElement('option');option.value=node.id;option.textContent=node.displayName+' · '+node.id;target.append(option);}if([...target.options].some(o=>o.value===selected))target.value=selected;
   root.querySelector('#fault-confirmation-hint').textContent=L('Required confirmation: ','必须输入的确认内容：')+'FAULT:'+kinds.value+':'+target.value;
   const list=root.querySelector('#fault-list');list.replaceChildren();for(const row of data.faults){const button=document.createElement('button');button.textContent=row.kind+' · '+row.nodeId+' · '+row.status;button.onclick=()=>action(async()=>{state.active=row.faultId;return api('research/faults/'+row.faultId);});list.append(button);}
   return state.active?api('research/faults/'+state.active):data;
  };
  root.querySelector('#fault-node').onchange=hint;root.querySelector('#fault-kind').onchange=hint;
  root.querySelector('#fault-start').onclick=()=>action(async()=>{const data=await api('research/faults',{kind:root.querySelector('#fault-kind').value,nodeId:root.querySelector('#fault-node').value,durationMs:Number(root.querySelector('#fault-duration').value),confirmation:root.querySelector('#fault-confirmation').value});if(current()){state.active=data.fault.faultId;root.querySelector('#fault-confirmation').value='';}return data;});
  root.querySelector('#fault-stop').onclick=()=>action(()=>api('research/faults/'+state.active+'/stop',{}),true);
  root.querySelector('#fault-refresh').onclick=()=>action(refresh);
  const poll=()=>{if(!current())return;if(state.online&&!state.busy&&root.open)action(refresh);setTimeout(poll,1000);};root._show=show;show();action(refresh);setTimeout(poll,1000);
 }
 root._show();
}
