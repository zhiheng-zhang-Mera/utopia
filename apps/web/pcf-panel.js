const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderFabricPanel(projection,locale='en'){
 const zh=locale==='zh-CN';
 const title=zh?'高级：个人算力织网':'Advanced: personal compute fabric';
 const absent=zh?'当前身份无法读取算力织网状态':'Fabric status is unavailable to this identity';
 if(!projection)return `<details><summary>${title}</summary><p>${absent}</p></details>`;
 const pending=zh?'候选完整流待验证；资源共享不代表执行器就绪。':'Complete-flow candidate awaits verification; sharing does not imply executor readiness.';
 return `<details id="pcf-panel"><summary>${title}</summary><p>${pending}</p><p>${escape(projection.state)} · ${zh?'运行':'Running'}: ${escape(projection.running)} · ${zh?'预留':'Reservations'}: ${escape(projection.reservations)}</p><p>${zh?'回执返回':'Result returned'}: ${escape(projection.resultReturned)} · ${zh?'Agent 已消费':'Agent consumed'}: ${escape(projection.agentConsumed)}</p><button disabled>${zh?'完整流验证后开放控制':'Controls await full-flow verification'}</button></details>`;
}
