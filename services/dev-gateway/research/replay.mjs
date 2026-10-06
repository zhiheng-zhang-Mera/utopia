// REX-805: replay is new execution with a verifiable source, never an edit of the source.
import {createHash, randomUUID} from 'node:crypto';
import {runSeed} from '../scenario-runner.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const canonical = value => JSON.stringify(value, (_key, inner) => inner && typeof inner === 'object' && !Array.isArray(inner)
  ? Object.fromEntries(Object.keys(inner).sort().map(key => [key, inner[key]])) : inner);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const selectedLimits = source => source.limits ? {...source.limits,...(source.limits.minSuccessfulRuns ? {minSuccessfulRuns:1} : {})} : null;
export const REPLAY_SCHEMA_VERSION = 1;
export const REPLAY_MECHANISMS = Object.freeze([
  'alternate-device', 'handoff', 'retry', 'backoff', 'recovery', 'selected-policy',
  'persistent-work-state', 'structured-handoff', 'identity-provenance', 'dynamic-rescan',
  'independent-review', 'capability-localization', 'user-reachable-terminal', 'versioned-rule-view',
  'owner-escalation', 'semantic-integration',
].map(id => Object.freeze({id, supported: id === 'alternate-device',
  versionedSnapshotRequired: id === 'versioned-rule-view',
  acceptedSourceAndIntegrationShasRequired: id === 'semantic-integration'})));

export class ReplayError extends Error {
  constructor(code, message) {super(message);this.name='ReplayError';this.code=code;this.status=code==='REPLAY_STORE_UNAVAILABLE'?503:['REPLAY_SOURCE_CHANGED','REPLAY_BUSY','REPLAY_TOPOLOGY_NOT_READY'].includes(code)?409:422;}
}
const refuse = (code, message) => {throw new ReplayError(code, message);};

/** This is the real canonical task's target rule, shared with the gateway, not a simulated result. */
export function replayTarget(context, seed) {
  const workers=context?.manifest?.workers??context?.workers??[];
  if(context?.replay?.disabledMechanisms?.includes('alternate-device'))return workers[0]??null;
  return context?.targetDeviceRef??(workers.length?workers[seed%workers.length]:null);
}

export function createReplayEngine({receipt,experiment,register,start,identity,context,limits=manifest=>null,preflight=()=>{}}={}) {
  for(const [name,value] of Object.entries({receipt,experiment,register,start,identity,context,limits,preflight}))if(typeof value!=='function')throw new TypeError(`${name} is required`);

  function sourceOf(sourceCampaignId,sourceRunIndex) {
    if(typeof sourceCampaignId!=='string'||sourceCampaignId.length>80||!Number.isSafeInteger(sourceRunIndex)||sourceRunIndex<0||sourceRunIndex>19999)refuse('REPLAY_SOURCE_INVALID','select a recorded campaign and a bounded run index');
    const source=receipt(sourceCampaignId);
    if(!source||source.campaignId!==sourceCampaignId||!['COMPLETED','STOPPED','FAILED'].includes(source.state)||!source.context?.experimentId||!Array.isArray(source.runs))refuse('REPLAY_SOURCE_INVALID','source must be a readable terminal campaign with experiment context');
    const original=experiment(source.context.experimentId);
    if(!original||original.status!=='VALIDATED'||identity(original)!==source.context.manifestIdentity||canonical(context(original,source.context.targetDeviceRef??null).manifest)!==canonical(source.context.manifest))refuse('REPLAY_SOURCE_INVALID','registered source manifest identity or controlled inputs changed');
    const matches=source.runs.filter(run=>run.index===sourceRunIndex);
    const run=matches[0];
    const offset=source.seedIndexOffset??0;
    if(matches.length!==1||!Number.isSafeInteger(offset)||offset<0||offset+sourceRunIndex>19999||typeof source.campaignSeed!=='string'||!['MEASURED','FAILED','TIMEOUT','CANCELLED','EXCLUDED'].includes(run?.state)||run.warmup!==false||run.measured!==(run.state==='MEASURED')||run.seed!==runSeed(source.campaignSeed,sourceRunIndex+offset)||!run.result?.taskRef||!original.manifest.workers.includes(run.result?.assignedNodeId)||!Number.isSafeInteger(source.timeout)||source.timeout<1||source.timeout>3600000||typeof source.scenarioId!=='string')refuse('REPLAY_SOURCE_INVALID','source run inputs, seed or execution identity are not fully observable');
    if(source.context.targetDeviceRef&&!original.manifest.workers.includes(source.context.targetDeviceRef))refuse('REPLAY_SOURCE_INVALID','source explicit target is outside the manifest');
    const inherited=source.context.replay?.disabledMechanisms??[];
    if(!Array.isArray(inherited)||inherited.length>1||inherited.some(id=>id!=='alternate-device')||run.result.assignedNodeId!==replayTarget(source.context,run.seed))refuse('REPLAY_SOURCE_INVALID','source placement or effective policy contradicts its recorded controls');
    return {source,original,run,inherited,seedIndex:sourceRunIndex+offset};
  }

  function startReplay(request={}) {
    if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(key=>!['sourceCampaignId','sourceRunIndex','mode','disabledMechanisms'].includes(key)))refuse('REPLAY_REQUEST_INVALID','unknown replay controls cannot be silently ignored');
    const {sourceCampaignId,sourceRunIndex,mode='REPLAY',disabledMechanisms=[]}=request;
    const {source,original,run,inherited,seedIndex}=sourceOf(sourceCampaignId,sourceRunIndex);
    if(source.scenarioId!=='WAIT'||original.manifest.references?.faultProfileRef)refuse('REPLAY_CONDITION_UNAVAILABLE','v1 replays stateless WAIT only; filesystem/checkpoint inputs and referenced faults were not snapshotted');
    if(!['REPLAY','ABLATION'].includes(mode)||!Array.isArray(disabledMechanisms)||
      (mode==='REPLAY'?disabledMechanisms.length!==0:disabledMechanisms.length!==1||disabledMechanisms[0]!=='alternate-device'))refuse('ABLATION_UNSUPPORTED','v1 supports only an exact alternate-device ablation; other mechanisms are not implemented');
    if(mode==='ABLATION'&&(inherited.length||source.context.targetDeviceRef||original.manifest.workers.length<2))refuse('ABLATION_INEFFECTIVE','source has no active alternate-device selection to disable');
    preflight(source.context);
    const manifest=copy(original.manifest);
    // Registry documents contain parsed refs, while registration consumes wire strings.
    // Copying the normalized document verbatim fails real registry validation.
    manifest.softwareRefs=manifest.softwareRefs.map(ref=>typeof ref==='string'?ref:`${ref.component}@${ref.identity}`);
    manifest.scenarioRef=original.manifest.references?.scenarioRef??null;
    manifest.faultProfileRef=original.manifest.references?.faultProfileRef??null;
    manifest.experimentId=`replay-${randomUUID()}`;
    manifest.question=`${mode}: ${manifest.question}`.slice(0,1000);
    manifest.repetitions=1;
    manifest.stopConditions=manifest.stopConditions.map(condition=>['MAX_REPETITIONS','MIN_SUCCESSFUL_RUNS'].includes(condition.kind)?{...condition,value:1}:condition);
    const effectiveLimits=limits(manifest,selectedLimits(source));
    const registered=register(manifest);
    if(!registered?.persisted||registered.record?.status!=='VALIDATED')refuse('REPLAY_STORE_UNAVAILABLE','new experiment could not be filed; original evidence remains unchanged');
    const replay={schemaVersion:REPLAY_SCHEMA_VERSION,mode,disabledMechanisms:mode==='ABLATION'?[...disabledMechanisms]:[...inherited],requestedDisabledMechanisms:[...disabledMechanisms],inheritedDisabledMechanisms:[...inherited],
      sourceCampaignId,sourceRunIndex,sourceRunRef:`${sourceCampaignId}:${sourceRunIndex}`,
      sourceExperimentId:original.experimentId,sourceReceiptDigest:digest(source),
      sourceDigestKind:'CANONICAL_PARSED_RECEIPT_SHA256',sourceSeed:run.seed,
      declaredRunCountAdjustment:{repetitions:1,minSuccessfulRuns:source.limits?.minSuccessfulRuns?1:null},
      determinism:'CONTROL_INPUTS_ONLY',
      nondeterministicConditions:['LIVE_RESOURCE_AVAILABILITY','WALL_CLOCK','EXTERNAL_PROVIDER_STATE_NOT_SNAPSHOTTED'],
      currentProcessSoftwareSha:null,currentProcessSoftwareReason:'NOT_OBSERVED: source manifest refs do not attest the current process',
      exactPolicy:(mode==='ABLATION'||inherited.includes('alternate-device'))?'alternate-device@1:SEEDED_WORKER_SELECTION_OFF_PIN_FIRST_DECLARED_WORKER':'SEEDED_WORKER_SELECTION_OR_ORIGINAL_EXPLICIT_TARGET',
    };
    const executionContext={...context(registered.record,source.context.targetDeviceRef??null),replay};
    const started=start({scenarioId:source.scenarioId,repetitions:1,warmup:0,seed:source.campaignSeed,seedIndexOffset:seedIndex,
      timeout:source.timeout,limits:effectiveLimits,context:executionContext});
    return {...started,replay,experimentId:registered.record.experimentId};
  }

  function compare(campaignId) {
    const replay=receipt(campaignId),lineage=replay?.context?.replay;
    if(lineage?.schemaVersion!==REPLAY_SCHEMA_VERSION)refuse('REPLAY_SOURCE_INVALID','campaign has no supported replay lineage');
    const {source,original,run,inherited}=sourceOf(lineage.sourceCampaignId,lineage.sourceRunIndex);
    if(digest(source)!==lineage.sourceReceiptDigest)refuse('REPLAY_SOURCE_CHANGED','source material changed after replay was declared');
    const current=replay.runs?.find(row=>row.index===0);
    if(!current)return {state:'PENDING',campaignId,sourceRunRef:lineage.sourceRunRef,causalPerformanceClaim:false};
    const expectedManifest=copy(source.context.manifest);
    expectedManifest.repetitions=1;
    expectedManifest.stopConditions=expectedManifest.stopConditions.map(condition=>['MAX_REPETITIONS','MIN_SUCCESSFUL_RUNS'].includes(condition.kind)?{...condition,value:1}:condition);
    const projection=manifest=>Object.fromEntries(Object.entries(manifest).filter(([key])=>!['experimentId','question','scenarioRef','faultProfileRef','references'].includes(key)));
    const expectedDisabled=lineage.mode==='ABLATION'?['alternate-device']:(source.context.replay?.disabledMechanisms??[]);
    const controlledInputDifferences=[];
    const check=(name,actual,expected)=>{if(canonical(actual)!==canonical(expected))controlledInputDifferences.push(name);};
    check('scenarioId',replay.scenarioId,source.scenarioId);
    check('seed',current.seed,run.seed);
    check('campaignSeed',replay.campaignSeed,source.campaignSeed);
    check('seedIndexOffset',replay.seedIndexOffset,(source.seedIndexOffset??0)+lineage.sourceRunIndex);
    check('timeout',replay.timeout,source.timeout);
    // The runner persists an absent limit set as {}; the Gateway returns null for that same set.
    // Compare effective bounds, retaining any actual added/changed limits as differences.
    check('limits',replay.limits??{},limits(expectedManifest,selectedLimits(source))??{});
    check('targetDeviceRef',replay.context.targetDeviceRef??null,source.context.targetDeviceRef??null);
    check('manifestControls',projection(replay.context.manifest),projection(expectedManifest));
    check('effectivePolicy',lineage.disabledMechanisms,expectedDisabled);
    check('sourceRunRef',lineage.sourceRunRef,`${source.campaignId}:${lineage.sourceRunIndex}`);
    check('sourceExperimentId',lineage.sourceExperimentId,source.context.experimentId);
    check('sourceSeed',lineage.sourceSeed,run.seed);
    check('sourceDigestKind',lineage.sourceDigestKind,'CANONICAL_PARSED_RECEIPT_SHA256');
    check('requestedDisabledMechanisms',lineage.requestedDisabledMechanisms,lineage.mode==='ABLATION'?['alternate-device']:[]);
    check('inheritedDisabledMechanisms',lineage.inheritedDisabledMechanisms,inherited);
    check('exactPolicy',lineage.exactPolicy,expectedDisabled.includes('alternate-device')?'alternate-device@1:SEEDED_WORKER_SELECTION_OFF_PIN_FIRST_DECLARED_WORKER':'SEEDED_WORKER_SELECTION_OR_ORIGINAL_EXPLICIT_TARGET');
    if(lineage.mode==='ABLATION'&&(inherited.length||source.context.targetDeviceRef||original.manifest.workers.length<2))controlledInputDifferences.push('ineffectiveAblation');
    if(!['REPLAY','ABLATION'].includes(lineage.mode))controlledInputDifferences.push('mode');
    if(replay.context.experimentId===source.context.experimentId||campaignId===source.campaignId)controlledInputDifferences.push('freshIdentity');
    const registered=experiment(replay.context.experimentId);
    check('manifestIdentity',replay.context.manifestIdentity,registered?identity(registered):null);
    const refs=record=>({softwareRefs:record.manifest.softwareRefs.map(ref=>typeof ref==='string'?ref:`${ref.component}@${ref.identity}`),scenarioRef:record.manifest.references?.scenarioRef??record.manifest.scenarioRef??null,faultProfileRef:record.manifest.references?.faultProfileRef??record.manifest.faultProfileRef??null});
    if(registered)check('sourceReferences',refs(registered),refs(original));
    if(registered)check('registeredManifest',replay.context.manifest,context(registered,replay.context.targetDeviceRef??null).manifest);
    if(current.result?.assignedNodeId)check('recordedPlacement',current.result.assignedNodeId,replayTarget(replay.context,current.seed));
    const controlledInputsMatch=controlledInputDifferences.length===0;
    return {state:replay.state,campaignId,sourceRunRef:lineage.sourceRunRef,mode:lineage.mode,disabledMechanisms:lineage.disabledMechanisms,
      controlledInputsMatch,controlledInputDifferences,original:copy(run),replayed:copy(current),
      expectedTarget:replayTarget(replay.context,current.seed),
      placementChanged:(run.result?.assignedNodeId??null)!==(current.result?.assignedNodeId??null),
      durationDeltaMs:Number.isFinite(run.durationMs)&&Number.isFinite(current.durationMs)?current.durationMs-run.durationMs:null,
      causalPerformanceClaim:false,determinism:lineage.determinism,nondeterministicConditions:lineage.nondeterministicConditions};
  }
  return {start:startReplay,compare,mechanisms:()=>REPLAY_MECHANISMS};
}
