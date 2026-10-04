import {appendFile,mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export function createFileStorage(directory,byteLimit){
 const path=resolve(directory,'trace.jsonl');
 return {
  async load(){const records=[];let retentionTruncated=false;for(const file of [resolve(directory,'trace.previous.jsonl'),path]){let size;try{size=(await stat(file)).size;}catch(error){if(error.code==='ENOENT')continue;throw error;}if(size>byteLimit)throw Object.assign(new Error('Trace retention limit exceeded'),{code:'TRACE_STORAGE_OVERSIZE'});if(file!==path)retentionTruncated=true;records.push(...(await readFile(file,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line)));}return{records,retentionTruncated};},
  async append(line){await mkdir(directory,{recursive:true});const bytes=Buffer.byteLength(line);if(bytes>byteLimit)throw Object.assign(new Error('Trace record too large'),{code:'TRACE_RECORD_OVERSIZE'});let size=0;try{size=(await stat(path)).size;}catch(error){if(error.code!=='ENOENT')throw error;}if(size>byteLimit)throw Object.assign(new Error('Trace retention limit exceeded'),{code:'TRACE_STORAGE_OVERSIZE'});let rotated=false;if(size+bytes>byteLimit){await writeFile(resolve(directory,'trace.previous.jsonl'),await readFile(path));await writeFile(path,'');rotated=true;}await appendFile(path,line);return{rotated};}
 };
}
