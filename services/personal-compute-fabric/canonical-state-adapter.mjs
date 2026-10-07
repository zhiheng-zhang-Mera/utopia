// Auxiliary reservations and attempts share the existing canonical SQLite owner.
// No PCF task table, replica, token database or separate writer exists.
import {requireThat as ok,copy} from './validation.mjs';
const KEY='pcf.execution.v1';const empty=()=>({version:0,epoch:0,reservations:[],attempts:[],completedKeys:[]});
export function createCanonicalStateAdapter(store){
 const read=()=>{const row=store.db.prepare('SELECT value FROM settings WHERE key=?').get(KEY);return row?JSON.parse(row.value):empty();};
 return {
  snapshot:()=>copy(read()),
  transaction(expectedVersion,mutate){return store.atomic(()=>{const state=read();if(expectedVersion!==undefined)ok(state.version===expectedVersion,'STALE_CANONICAL_VERSION');const result=mutate(state,{getTask:id=>store.get('tasks',id),putTask:t=>store.put('tasks',t)});state.version++;store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY,JSON.stringify(state));return {...result,version:state.version};});},
 };
}
