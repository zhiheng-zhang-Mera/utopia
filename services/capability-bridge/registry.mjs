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
/**
 * District kinds. `infrastructure` districts (00-foundation) own the city's runtime
 * kernel, not user-facing capabilities, so their modules are never enumerated as
 * capability descriptors. Without this, a kernel module would appear on the Web and
 * Android capability lists as an "unavailable" capability awaiting a bridge — which
 * would advertise something that by design has no product operation.
 */
export const DISTRICT_KINDS=['infrastructure','domain'];
export function registry(manifest=JSON.parse(readFileSync(new URL('city/CITY_IMPLEMENTATION_MANIFEST.json',root))),adapters=ADAPTERS){
 // Two independent exclusions, and both are kept because they answer different questions:
 //  - a district declared `kind: "infrastructure"` is runtime kernel, not a capability
 //    surface (MB-001's `00-foundation`);
 //  - a module declaring `"capabilityProvider": false` is adapter infrastructure that
 //    really exists in a domain district but exposes no user-facing capability (MB-003's
 //    Worker Gateway modules).
 // Enumerating either as a capability would advertise to Web and Android an "unavailable"
 // capability awaiting a bridge that is not going to be built.
 const modules=manifest.districts
  .filter(d=>(d.kind??'domain')!=='infrastructure')
  .flatMap(d=>d.buildings.flatMap(b=>b.modules.filter(m=>m.capabilityProvider!==false).map(m=>({...m,ref:ref(d.id,b.id,m.id)}))));
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
