import {createHash} from 'node:crypto';
export const TRACE_SCHEMA_VERSION=1;
export const METRIC_NAMES=['latencyMs','backoffMs','cpuPercent','memoryBytes','autonomousSpanMs','taskTransitionCount'];
const refNames=['taskRef','actionRef','deviceRef','nodeRef','handoffRef','routeRef','cityRef'];
const dimensionNames=['experimentRef','experimentRunRef','providerRef','modelRef','channelRef','retryIndex','failureCode','recoveryRef','ownerInterventionReason','eligibilityState','wakeEventRef','wakeConditionRef','rescanReasonRef','authoritySurface','truthSourceRef','sourceWorkbook','watchlistIds','highestGrade','capabilityRef','capabilityState','expectedIdentity','observedIdentity','evidenceIdentity','continuationRef','predecessorHostRef','successorHostRef','autonomyEvent','ruleLifecycle','supervision','semanticIntegration'];
const authorityNames=['CANONICAL_EVENT','MISSION_BOOK','CAPABILITY_REGISTRY','GIT','CI','REVIEW','RUNTIME','UI'];
const eligibilityNames=['TEMPORARILY_UNCLAIMABLE','STRUCTURALLY_INELIGIBLE','GLOBAL_EXTERNAL_BLOCK','POOL_TERMINAL','ELIGIBLE'];
const grades=['G1_MATURE','G2_CROWDED','G3_SPARSE_ACTIVE','G4_RARE_SYSTEMIC'];
const interventionReasons=['AUTHENTICATION','APPROVAL','ENVIRONMENT','POLICY','REQUIREMENTS','EXTERNAL_STATE','CORRECTION','OTHER','NOT_OBSERVABLE'];
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const requireFact=(ok,field)=>{if(!ok)throw Object.assign(new Error('Invalid trace field: '+field),{code:'TRACE_INPUT_INVALID',field});};
const exactTime=(v,field)=>{requireFact(typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v)),field);return v;};
const ref=(v,field)=>{requireFact(typeof v==='string'&&v.length<=180&&/^[A-Za-z0-9_./:#-]+$/.test(v),field);return v;};
const knownKeys=(value,keys,field)=>{requireFact(plain(value),field);for(const key of Object.keys(value))requireFact(keys.includes(key),field+'.'+key);};
const stable=value=>Array.isArray(value)?'['+value.map(stable).join(',')+']':plain(value)?'{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}':JSON.stringify(value);
const copy=value=>JSON.parse(JSON.stringify(value));
function structuredDimension(name,value){
 const keys={ruleLifecycle:['ruleRef','ruleVersionSha','sourceFailureRef','introducedAt','supersedesRef','conflictsWithRef','scopeRef','activationCount','recurrencePrevented','falseBlockObserved','retiredAt','retirementReasonRef'],supervision:['category','batchable','avoidable','priorDiagnosisRef','repeatedRootCause','escalatedAt','resumedAt','durationMs'],semanticIntegration:['acceptedSourceShas','integrationSha','componentCiRefs','componentReviewRefs','invariantRef','driftType','repairRef']}[name];
 knownKeys(value,keys,name);
 for(const[k,v]of Object.entries(value)){if(v==null)continue;if(k==='acceptedSourceShas'){requireFact(Array.isArray(v)&&v.length<=16&&v.every(x=>typeof x==='string'&&/^[0-9a-f]{40}$/.test(x)),k);}else if(k==='componentCiRefs'||k==='componentReviewRefs'){requireFact(Array.isArray(v)&&v.length<=16,k);v.forEach(x=>ref(x,k));}else if(k.endsWith('Sha'))requireFact(typeof v==='string'&&/^[0-9a-f]{40}$/.test(v),k);else if(k.endsWith('At'))exactTime(v,k);else if(['batchable','avoidable','repeatedRootCause','recurrencePrevented','falseBlockObserved'].includes(k))requireFact(typeof v==='boolean',k);else if(k==='activationCount')requireFact(Number.isSafeInteger(v)&&v>=0,k);else if(k==='durationMs')requireFact(typeof v==='number'&&Number.isFinite(v)&&v>=0,k);else ref(v,k);}
 if(name==='supervision'&&value.category!=null)requireFact(['HIGH_VALUE_DECISION','AVOIDABLE_TECHNICAL_ESCALATION','REPEAT_CLARIFICATION','APPROVAL_ONLY','RECOVERY_REQUIRED','AMBIGUOUS_REQUIREMENT','PERMISSION_OR_VALUE_JUDGMENT'].includes(value.category),'supervision.category');
}
export function canonicalEventRecord(event){
 requireFact(plain(event),'event');
 const refs={};if(event.taskId)refs.taskRef=event.taskId;
 for(const [key,name] of [['nodeId','nodeRef'],['deviceId','deviceRef'],['actionId','actionRef'],['handoffId','handoffRef']])if(typeof event.payload?.[key]==='string')refs[name]=event.payload[key];
 return {eventId:event.id,type:event.type,timestamp:event.timestamp,sourceSeq:event.seq,sourceClock:'CANONICAL_EVENT_WALL_UTC',canonicalRefs:refs};
}
export function normalizeTraceRecord(raw,context){
 knownKeys(raw,['eventId','type','timestamp','sourceSeq','sourceClock','canonicalRefs','dimensions','metrics'],'raw');
 ref(raw.eventId,'eventId');requireFact(typeof raw.type==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(raw.type),'type');exactTime(raw.timestamp,'timestamp');
 requireFact(raw.sourceSeq==null||Number.isSafeInteger(raw.sourceSeq)&&raw.sourceSeq>0,'sourceSeq');
 const refs=raw.canonicalRefs??{};knownKeys(refs,refNames,'canonicalRefs');for(const [k,v]of Object.entries(refs))if(v!=null)ref(v,k);
 const dimensions=raw.dimensions??{};knownKeys(dimensions,dimensionNames,'dimensions');
 for(const [k,v]of Object.entries(dimensions)){
  if(v==null)continue;
  if(['ruleLifecycle','supervision','semanticIntegration'].includes(k))structuredDimension(k,v);
  else if(k==='watchlistIds'){requireFact(Array.isArray(v)&&v.length<=16&&v.every(x=>typeof x==='string'&&/^RS-[A-Z0-9-]{1,80}$/.test(x)),k);}
  else if(k==='capabilityState'){knownKeys(v,['implementation','backendWiring','reachability','intent'],k);for(const state of Object.values(v))requireFact(typeof state==='string'&&/^[A-Z_]{1,50}$/.test(state),k);}
  else if(k==='retryIndex')requireFact(Number.isSafeInteger(v)&&v>=0,k);
  else ref(v,k);
 }
 if(dimensions.authoritySurface!=null)requireFact(authorityNames.includes(dimensions.authoritySurface),'authoritySurface');
 if(dimensions.eligibilityState!=null)requireFact(eligibilityNames.includes(dimensions.eligibilityState),'eligibilityState');
 if(dimensions.highestGrade!=null)requireFact(grades.includes(dimensions.highestGrade),'highestGrade');
 if(dimensions.ownerInterventionReason!=null)requireFact(interventionReasons.includes(dimensions.ownerInterventionReason),'ownerInterventionReason');
 for(const key of ['expectedIdentity','observedIdentity','evidenceIdentity'])if(dimensions[key]!=null)requireFact(/^[0-9a-f]{40}$/.test(dimensions[key]),key);
 const measures=raw.metrics??{};knownKeys(measures,METRIC_NAMES,'metrics');for(const [k,v]of Object.entries(measures))if(v!=null)requireFact(typeof v==='number'&&Number.isFinite(v)&&v>=0&&(k!=='cpuPercent'||v<=100),k);
 requireFact(plain(context),'context');ref(context.runId,'runId');ref(context.collectorEpoch,'collectorEpoch');exactTime(context.capturedAt,'capturedAt');requireFact(typeof context.monotonicNs==='string'&&/^\d+$/.test(context.monotonicNs),'monotonicNs');
 const softwareRefs=context.softwareRefs??{};knownKeys(softwareRefs,['softwareSha','configRef','implementationSha','reviewSha','ciRunId','evidenceSha'],'softwareRefs');for(const [k,v]of Object.entries(softwareRefs))if(v!=null){if(k.endsWith('Sha'))requireFact(/^[0-9a-f]{40}$/.test(v),k);else ref(v,k);}
 const annotations=[];
 if(context.duplicate===true)annotations.push('DUPLICATE_EVENT');
 if(raw.sourceSeq!=null&&context.previousSourceSeq!=null){if(raw.sourceSeq<context.previousSourceSeq)annotations.push('OUT_OF_ORDER_EVENT');else if(raw.sourceSeq>context.previousSourceSeq+1)annotations.push('SOURCE_SEQUENCE_GAP');}
 if(Date.parse(context.capturedAt)-Date.parse(raw.timestamp)>60000)annotations.push('STALE_SOURCE_TIMESTAMP');
 if(context.previousSourceAt&&Date.parse(raw.timestamp)<Date.parse(context.previousSourceAt))annotations.push('SOURCE_TIMESTAMP_REGRESSED');
 const missingFields=['experimentRef','experimentRunRef','providerRef','modelRef','channelRef'].filter(k=>dimensions[k]==null);
 for(const k of ['softwareSha','configRef'])if(softwareRefs[k]==null)missingFields.push(k);
 const sourceClock=raw.sourceClock??'NOT_OBSERVABLE';requireFact(['CANONICAL_EVENT_WALL_UTC','HOST_WALL_UTC','EXTERNAL_DECLARED_WALL_UTC','NOT_OBSERVABLE'].includes(sourceClock),'sourceClock');if(sourceClock==='NOT_OBSERVABLE')missingFields.push('sourceClock');
 const metrics=Object.fromEntries(METRIC_NAMES.map(k=>[k,{value:measures[k]??null,reason:measures[k]==null?'NOT_OBSERVABLE: measurement not provided':null}]));
 return {schemaVersion:TRACE_SCHEMA_VERSION,transformRef:'research-trace-normalize-v1',sourceDigest:createHash('sha256').update(stable(raw)).digest('hex'),eventId:raw.eventId,type:raw.type,runId:context.runId,sourceSeq:raw.sourceSeq??null,timestamp:raw.timestamp,clocks:{source:sourceClock,sourceSemantics:'event occurrence as declared by source',capturedAt:context.capturedAt,captureSource:'HOST_WALL_UTC',monotonicNs:context.monotonicNs,monotonicSource:'PROCESS_HRTIME',epoch:context.collectorEpoch},canonicalRefs:copy(refs),dimensions:copy(dimensions),provenance:{refSemantics:'DECLARED_EXACT_IDENTITY; external verification required',softwareSha:softwareRefs.softwareSha??null,configRef:softwareRefs.configRef??null,implementationSha:softwareRefs.implementationSha??null,reviewSha:softwareRefs.reviewSha??null,ciRunId:softwareRefs.ciRunId??null,evidenceSha:softwareRefs.evidenceSha??null},metrics,missingFields,annotations};
}
