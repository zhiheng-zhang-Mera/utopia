// Shared bounded input validation; no ambient authority or clock.
export function requireThat(condition,code){if(!condition)throw Object.assign(new Error(code),{code});}
export const text=v=>typeof v==='string'&&v.length>0&&v.length<=256;
export const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
export function strings(v){return Array.isArray(v)&&v.length<=256&&v.every(text);}
export function freeze(v){if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;}
export function bounded(value){
  let count=0;const seen=new WeakSet();
  function walk(v,depth){requireThat(depth<=16&&++count<=4096,'PAYLOAD_LIMIT');if(v&&typeof v==='object'){requireThat(!seen.has(v),'CYCLIC_INPUT');seen.add(v);for(const x of Object.values(v))walk(x,depth+1);seen.delete(v);}else if(typeof v==='number')requireThat(Number.isFinite(v),'INVALID_NUMBER');else if(typeof v==='string')requireThat(v.length<=16384,'TEXT_LIMIT');else requireThat(v===null||typeof v==='boolean'||v===undefined,'INVALID_VALUE');}
  walk(value,0);requireThat(Buffer.byteLength(JSON.stringify(value))<=65536,'PAYLOAD_LIMIT');return value;
}
export const copy=v=>structuredClone(bounded(v));
export const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
