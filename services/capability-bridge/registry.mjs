import {readFileSync} from 'node:fs';
import {createCapabilityRegistry} from '../../city/00-foundation/03-capability-fabric/capability-fabric/registry.mjs';
import {describeOwnership} from '../../city/00-foundation/03-capability-fabric/capability-fabric/routing.mjs';

const root=new URL('../../',import.meta.url);
const ref=(districtId,buildingId,moduleId)=>({districtId,buildingId,moduleId});
export const moduleKey=({districtId,buildingId,moduleId})=>`${districtId}/${buildingId}/${moduleId}`;

/**
 * The five providers this City currently composes.
 *
 * These used to be a literal list that the registry simply re-exported. They are
 * now *registrations* into the capability fabric's registry, which resolves by
 * capability id, orders by priority, refuses a capability two owners claim, and
 * revokes everything an owner provided when it goes away. The declarations are
 * unchanged, so the accepted V0.3 behaviour is preserved exactly.
 */
export const ADAPTER_PROVIDERS=[
 {capabilityId:'planning.document.intake',name:'Document Intake',owner:'provider.planning.document-intake',priority:50,moduleRefs:['ingestion-core','document-readers'].map(id=>ref('09-planning-knowledge','02-document-intake',id)),operations:['read'],inputKind:'document',describes:'Read a bounded document from an existing product surface.'},
 {capabilityId:'planning.knowledge.query',name:'Knowledge Query',owner:'provider.planning.knowledge-query',priority:50,moduleRefs:[ref('09-planning-knowledge','01-knowledge-service','knowledge-core')],operations:['query','fromDocument'],inputKind:'knowledge',describes:'Answer a query from the knowledge core.'},
 {capabilityId:'engineering.skill.inspect',name:'Skill Inspect',owner:'provider.engineering.skill-inspect',priority:50,moduleRefs:[ref('02-engineering','02-worker-gateway','skill-intake')],operations:['inspect','validate','catalog','archive'],inputKind:'skill',describes:'Inspect or validate a skill without installing it.'},
 {capabilityId:'research.evidence.review',name:'Evidence Review',owner:'provider.research.evidence-review',priority:50,moduleRefs:[ref('06-research','01-research-institute','evidence-engine')],operations:['review','tamper'],inputKind:'evidence',describes:'Review an evidence bundle for integrity and references.'},
 {capabilityId:'presentation.theme.lab',name:'Theme Lab',owner:'provider.presentation.theme-lab',priority:50,moduleRefs:[ref('11-entertainment','01-entertainment-centre','theme-engine')],operations:['generate','build'],inputKind:'theme',describes:'Generate or build a theme package inside a sandbox.'},
];
/** The legacy export name, kept so existing callers keep working. */
export const ADAPTERS=ADAPTER_PROVIDERS.map(provider=>({id:provider.capabilityId,name:provider.name,moduleRefs:provider.moduleRefs,operations:provider.operations,inputKind:provider.inputKind}));

/**
 * District kinds. `infrastructure` districts (00-foundation) own the city's runtime
 * kernel, not user-facing capabilities, so their modules are never enumerated as
 * capability descriptors. Without this, a kernel module would appear on the Web and
 * Android capability lists as an "unavailable" capability awaiting a bridge — which
 * would advertise something that by design has no product operation.
 */
export const DISTRICT_KINDS=['infrastructure','domain'];

/**
 * Build the City capability descriptors.
 *
 * Every module of a `domain` district appears exactly once: the modules a provider
 * already covers are described through their provider, and every other module is
 * described as itself with no operations — a capability that exists but cannot be
 * invoked yet, which is an honest state rather than a hidden one. Modules of an
 * `infrastructure` district are the runtime kernel and are not capability
 * descriptors at all, so they are filtered out before anything is described.
 */
export function registry(manifest=JSON.parse(readFileSync(new URL('city/CITY_IMPLEMENTATION_MANIFEST.json',root))),adapters=ADAPTER_PROVIDERS){
 const modules=manifest.districts.filter(d=>(d.kind??'domain')!=='infrastructure').flatMap(d=>d.buildings.flatMap(b=>b.modules.map(m=>({...m,ref:ref(d.id,b.id,m.id)}))));
 const index=new Map();
 for(const m of modules){const key=moduleKey(m.ref);if(index.has(key))throw Error('Duplicate qualified module identity');index.set(key,m);}
 const lifecycleFor=moduleRef=>index.get(moduleKey(moduleRef))?.lifecycle??'UNAVAILABLE';

 // A real registry, populated from the provider declarations rather than asserted.
 const fabric=createCapabilityRegistry();
 for(const provider of adapters){
  const result=fabric.register(provider);
  if(result.ok!==true)throw Error(`Capability registration refused: ${result.reason}`);
 }

 const covered=new Set(adapters.flatMap(a=>a.moduleRefs.map(moduleKey)));
 const ownershipOf=(moduleRefs,hasAdapter,capabilityId,operations)=>{
  const ownership=describeOwnership({moduleRefs,lifecycleFor,hasAdapter});
  return{...ownership,capabilityId,operations:operations.map(operationId=>({operationId}))};
 };
 const described=adapters.map(provider=>{
  const ownership=ownershipOf(provider.moduleRefs,true,provider.capabilityId,provider.operations);
  return{capabilityId:provider.capabilityId,name:provider.name,moduleRefs:ownership.moduleRefs,moduleLifecycles:ownership.moduleLifecycles,cityLifecycle:ownership.cityLifecycle,moduleState:ownership.moduleState,bridgeState:ownership.bridgeState,operations:ownership.operations,inputKind:provider.inputKind,owner:provider.owner,priority:provider.priority,fallback:provider.fallback??null};
 });
 const uncovered=modules.filter(m=>!covered.has(moduleKey(m.ref))).map(m=>{
  const capabilityId='city.'+moduleKey(m.ref);
  const ownership=ownershipOf([m.ref],false,capabilityId,[]);
  return{capabilityId,name:m.en??m.id,moduleRefs:ownership.moduleRefs,moduleLifecycles:ownership.moduleLifecycles,cityLifecycle:ownership.cityLifecycle,moduleState:ownership.moduleState,bridgeState:ownership.bridgeState,operations:ownership.operations,inputKind:'unavailable',owner:`module.${moduleKey(m.ref)}`,priority:50,fallback:null};
 });
 return[...described,...uncovered];
}

/**
 * The registered provider records, for a composition lock or a report.
 *
 * A capability that no module covers is deliberately absent: the lock pins who
 * *provides* something, and a module nobody has wired up provides nothing.
 */
export function composedProviders(manifest,adapters=ADAPTER_PROVIDERS){
 return adapters.map(provider=>({capabilityId:provider.capabilityId,owner:provider.owner,version:null}));
}
