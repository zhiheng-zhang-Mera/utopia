import {readFileSync} from 'node:fs';
const root=new URL('../../',import.meta.url);
export const ADAPTERS=[
 {id:'planning.document.intake',name:'Document Intake',modules:['ingestion-core','document-readers'],operations:['read'],inputKind:'document'},
 {id:'planning.knowledge.query',name:'Knowledge Query',modules:['knowledge-core'],operations:['query','fromDocument'],inputKind:'knowledge'},
 {id:'engineering.skill.inspect',name:'Skill Inspect',modules:['skill-intake'],operations:['inspect','validate','catalog','archive'],inputKind:'skill'},
 {id:'research.evidence.review',name:'Evidence Review',modules:['evidence-engine'],operations:['review','tamper'],inputKind:'evidence'},
 {id:'presentation.theme.lab',name:'Theme Lab',modules:['theme-engine'],operations:['generate','validate'],inputKind:'theme'},
];
export function registry(manifest=JSON.parse(readFileSync(new URL('city/CITY_IMPLEMENTATION_MANIFEST.json',root))),adapters=ADAPTERS){
 const modules=manifest.districts.flatMap(d=>d.buildings.flatMap(b=>b.modules));
 const covered=new Set(adapters.flatMap(a=>a.modules));
 return [...adapters.map(a=>({capabilityId:a.id,name:a.name,cityLifecycle:modules.find(m=>m.id===a.modules[0])?.lifecycle??'UNAVAILABLE',bridgeState:a.modules.every(id=>modules.some(m=>m.id===id))?'AVAILABLE':'DEGRADED',operations:a.operations.map(operationId=>({operationId})),inputKind:a.inputKind})),...modules.filter(m=>!covered.has(m.id)).map(m=>({capabilityId:'city.'+m.id,name:m.en??m.id,cityLifecycle:m.lifecycle,bridgeState:'BRIDGE_PENDING',operations:[],inputKind:'unavailable'}))];
}
