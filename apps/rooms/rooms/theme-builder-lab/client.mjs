export async function mount(root,api,kit) {
 let alive=true,busy=false;
 const prompt=kit.el('textarea',{id:'tb-prompt',rows:'3'});prompt.value='blue research compact no persona';
 const observation=kit.el('select',{id:'tb-observation'},[kit.el('option',{value:'none',text:'No observation / 无观测'}),kit.el('option',{value:'desktop',text:'Desktop preset / 桌面观测样例'})]);
 const failure=kit.el('input',{id:'tb-failure',type:'checkbox',style:'width:auto'}),status=kit.el('p',{id:'tb-status',text:'Ready / 就绪'}),summary=kit.el('p',{id:'tb-summary'}),report=kit.el('pre',{id:'tb-report',style:'white-space:pre-wrap;max-height:480px;overflow:auto'}),preview=kit.el('img',{id:'tb-preview',alt:'Built theme package preview',style:'max-width:100%;display:none'});
 const controls=kit.el('div',{class:'row'});
 const buttons=['intent','plan','build'].map((operation,index)=>{const button=kit.el('button',{id:'tb-'+operation,type:'button',text:['Generate intent / 生成意图','Plan / 计划','Build package / 构建包'][index]});button.onclick=()=>run(operation);controls.append(button);return button;});
 root.append(kit.el('h2',{text:'Theme Builder Lab / 主题构建实验室'}),kit.el('p',{text:'Offline sandbox preview. No global theme application. / 离线沙箱预览，不应用到全局主题。'}),kit.el('label',{for:'tb-prompt',text:'Prompt / 需求'}),prompt,kit.el('label',{for:'tb-observation',text:'Observation / 布局观测'}),observation,kit.el('label',{style:'display:flex;align-items:center;gap:8px'},[failure,kit.el('span',{text:' Inject image failure / 注入图像失败'})]),controls,status,summary,preview,report);
 async function run(operation){if(busy)return;busy=true;buttons.forEach(b=>b.disabled=true);status.textContent='Working / 处理中';preview.style.display='none';
  try{const result=await api.post('/'+operation,{prompt:prompt.value,observation:observation.value,injectFailure:failure.checked});if(!alive)return;const {previewDataUri,...text}=result;report.textContent=JSON.stringify(text,null,2);status.textContent=result.verdict||'Ready / 就绪';summary.textContent=operation==='build'&&result.ok?`${result.observed?'Observed layout / 已观测布局':'No observation: conservative layout / 无观测：保守布局'} · ${result.files.length} files / 文件 · ${result.fallback.degraded_assets.length} fallback / 回退 · ${result.fallback.disabled.length} disabled / 禁用`:'';if(previewDataUri){preview.src=previewDataUri;preview.style.display='block';}}
  catch(error){if(alive){status.textContent='HOLD';report.textContent=error.message;}}
  finally{busy=false;if(alive)buttons.forEach(b=>b.disabled=false);}
 }
 return()=>{alive=false;};
}
