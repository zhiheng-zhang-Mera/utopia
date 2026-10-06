import {getLocale} from './i18n/index.js';
const states=new WeakMap();
const L=(en,zh)=>getLocale()==='zh-CN'?zh:en;
export function renderCampaign(container,online,api,contextKey){
 let state=states.get(container);
 if(!state||state.key!==contextKey){state={key:contextKey,active:null,data:null,busy:false,timer:null};states.set(container,state);}
 state.online=online;
 let root=container.querySelector('#campaign-shell');
 if(!root||root._state!==state||root.dataset.locale!==getLocale()){
  root?.remove();root=document.createElement('section');root.id='campaign-shell';root.className='panel';root._state=state;root.dataset.locale=getLocale();
  root.innerHTML=`<h3>${L('Controlled campaigns','受控重复实验')}</h3><p>${L('Run existing safe tasks. Warmups are retained but excluded from measurements. Restart interrupts; it never silently resumes. Long campaigns run in the background.','执行现有安全任务。预热记录保留，但不计入测量。重启会中断，不会自动续跑。长实验在后台运行。')}</p>
  <label>${L('Registered experiment ID','已登记实验 ID')}<input id="campaign-experiment"></label>
  <label>${L('Scenario','场景')}<select id="campaign-scenario"></select></label>
  <label>${L('Measured repetitions','测量重复次数')}<input id="campaign-repetitions" type="number" min="1" max="1000" value="1"></label>
  <label>${L('Warmups','预热次数')}<input id="campaign-warmups" type="number" min="0" max="100" value="0"></label>
  <label>${L('Run timeout (ms)','单次超时（毫秒）')}<input id="campaign-timeout" type="number" min="1" max="300000" value="30000"></label>
  <button id="campaign-start">${L('Start campaign','开始实验')}</button><button id="campaign-stop">${L('Stop selected campaign','停止所选实验')}</button><button id="campaign-refresh">${L('Refresh campaigns','刷新实验进度')}</button>
  <p id="campaign-error" role="alert"></p><div id="campaign-list"></div><pre id="campaign-output" role="status" style="white-space:pre-wrap;max-height:28rem;overflow:auto"></pre>`;
  container.append(root);
  const current=()=>root.isConnected&&states.get(container)===state&&container.querySelector('#campaign-shell')===root;
  const show=()=>{
   if(!current())return;
   root.querySelector('#campaign-output').textContent=state.data?JSON.stringify(state.data,null,2):'';
   root.querySelector('#campaign-start').disabled=state.busy||!state.online;
   root.querySelector('#campaign-refresh').disabled=state.busy||!state.online;
   root.querySelector('#campaign-stop').disabled=state.busy||!state.online||!state.active;
  };
  const action=async fn=>{if(!state.online||state.busy)return;state.busy=true;root.querySelector('#campaign-error').textContent='';show();try{const data=await fn();if(current()){state.data=data;show();}}catch(error){if(current())root.querySelector('#campaign-error').textContent=error.message;}finally{state.busy=false;show();}};
  const refresh=async()=>{
   const data=await api('research/campaigns');if(!current())return data;
   const selector=root.querySelector('#campaign-scenario');if(!selector.options.length)for(const scenario of data.scenarios){const option=document.createElement('option');option.value=scenario;option.textContent=scenario;selector.append(option);}
   const list=root.querySelector('#campaign-list');list.replaceChildren();for(const row of data.campaigns){const button=document.createElement('button');button.textContent=row.experimentId+' · '+row.status;button.onclick=()=>action(async()=>{state.active=row.campaignId;return api('research/campaigns/'+encodeURIComponent(row.campaignId));});list.append(button);}
   return state.active?api('research/campaigns/'+encodeURIComponent(state.active)):data;
  };
  root.querySelector('#campaign-start').onclick=()=>action(async()=>{const data=await api('research/campaigns',{experimentId:root.querySelector('#campaign-experiment').value.trim(),scenario:root.querySelector('#campaign-scenario').value,repetitions:Number(root.querySelector('#campaign-repetitions').value),warmups:Number(root.querySelector('#campaign-warmups').value),timeoutMs:Number(root.querySelector('#campaign-timeout').value),resumePolicy:'INTERRUPT'});if(current())state.active=data.campaign.campaignId;return data;});
  root.querySelector('#campaign-stop').onclick=()=>action(()=>api('research/campaigns/'+encodeURIComponent(state.active)+'/stop',{}));
  root.querySelector('#campaign-refresh').onclick=()=>action(refresh);
  const poll=()=>{clearTimeout(state.timer);if(!current())return;if(state.online&&!state.busy)action(refresh);state.timer=setTimeout(poll,1000);};
  root._show=show;show();action(refresh);state.timer=setTimeout(poll,1000);
 }
 root._show();
}
