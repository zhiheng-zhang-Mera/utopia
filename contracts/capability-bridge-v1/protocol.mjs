import {createHash} from 'node:crypto';
export const MAX_FILE_BYTES=1024*1024;
export const MAX_REQUEST_BYTES=1500000;
export class CapabilityError extends Error {
 constructor(code,status=400){super(code);this.code=code;this.status=status;}
}
export const refuse=(code,status=400)=>{throw new CapabilityError(code,status);};
export function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
 if(typeof value==='number'&&!Number.isFinite(value))refuse('INVALID_NUMBER');
 return value;
}
export const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function fileBytes(input){
 if(typeof input.base64!=='string'||input.base64.length>Math.ceil(MAX_FILE_BYTES/3)*4)refuse('INPUT_TOO_LARGE',413);
 if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64))refuse('INVALID_BASE64');
 const bytes=Buffer.from(input.base64,'base64');if(bytes.length>MAX_FILE_BYTES)refuse('INPUT_TOO_LARGE',413);return bytes;
}
export function objectInput(value){if(!value||typeof value!=='object'||Array.isArray(value))refuse('INVALID_INPUT');return value;}
