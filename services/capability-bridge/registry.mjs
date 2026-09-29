import {readFileSync} from 'node:fs';
const root=new URL('../../',import.meta.url);
const ref=(districtId,buildingId,moduleId)=>({districtId,buildingId,moduleId});
export const moduleKey=({districtId,buildingId,moduleId})=>`${districtId}/${buildingId}/${moduleId}`;
export const ADAPTERS=[
 {id:'planning.document.intake',name:'Document Intake',moduleRefs:['ingestion-core','document-readers'].map(id=>ref('09-planning-knowledge','02-document-intake',id)),operations:['read'],inputKind:'document'},
 {id:'planning.knowledge.query',name:'Knowledge Query',moduleRefs:[ref('09-planning-knowledge','01-knowledge-service','knowledge-core')],operations:['query','fromDocument'],inputKind:'knowledge'},
 {id:'engineering.skill.inspect',name:'Skill Inspect',moduleRefs:[ref('02-engineering','02-worker-gateway','skill-intake')],operations:['inspect','validate','catalog','archive'],inputKind:'skill'},
 {id:'research.evidence.review',name:'Evidence Review',moduleRefs:[ref('06-research','01-research-institute','evidence-engine')],operations:['review','tamper'],inputKind:'evidence'},
 {id:'presentation.theme.lab',name:'Theme Lab',moduleRefs:[ref('11-entertainment','01-entertainment-centre','theme-engine')],operations:['generate','build'],inputKind:'theme'},
];
export function registry(manifest=JSON.parse(readFileSync(new URL('city/CITY_IMPLEMENTATION_MANIFEST.json',root))),adapters=ADAPTERS){
 const modules=manifest.districts.flatMap(d=>d.buildings.flatMap(b=>b.modules.map(m=>({...m,ref:ref(d.id,b.id,m.id)}))));
 const index=new Map();
 for(const m of modules){const key=moduleKey(m.ref);if(index.has(key))throw Error('Duplicate qualified module identity');index.set(key,m);}
 const covered=new Set(adapters.flatMap(a=>a.moduleRefs.map(moduleKey)));
 const describe=(refs,hasAdapter)=>{
  const moduleLifecycles=refs.map(r=>({moduleRef:r,lifecycle:index.get(moduleKey(r))?.lifecycle??'UNAVAILABLE'}));
  const states=moduleLifecycles.map(m=>m.lifecycle);
  const bridgeState=states.includes('DEPRECATED')?'UNAVAILABLE':states.some(s=>['PLANNED','INCUBATING'].includes(s))?'BRIDGE_PENDING':states.some(s=>!['PROMOTED','ACTIVE'].includes(s))?'DEGRADED':hasAdapter?'AVAILABLE':'BRIDGE_PENDING';
  return{moduleRefs:refs,moduleLifecycles,cityLifecycle:new Set(states).size===1?states[0]:'MIXED',bridgeState};
 };
 return [...adapters.map(a=>({capabilityId:a.id,name:a.name,...describe(a.moduleRefs,true),operations:a.operations.map(operationId=>({operationId})),inputKind:a.inputKind})),...modules.filter(m=>!covered.has(moduleKey(m.ref))).map(m=>({capabilityId:'city.'+moduleKey(m.ref),name:m.en??m.id,...describe([m.ref],false),operations:[],inputKind:'unavailable'}))];
}
