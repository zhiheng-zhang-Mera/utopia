import {finite} from './validation.mjs';
export function estimateCost(candidate){
 const names=['inputMs','coldStartMs','executeMs','returnMs'];const intervals=names.map(n=>candidate.cost?.[n]);
 if(!finite(candidate.queueMs)||intervals.some(v=>!Array.isArray(v)||v.length!==2||!v.every(finite)||v[0]>v[1]))return {state:'UNKNOWN',intervalMs:null,calibrationVersion:null};
 return {state:'ESTIMATED',intervalMs:[0,1].map(i=>candidate.queueMs+intervals.reduce((sum,v)=>sum+v[i],0)),calibrationVersion:candidate.cost.calibrationVersion??null};
}
