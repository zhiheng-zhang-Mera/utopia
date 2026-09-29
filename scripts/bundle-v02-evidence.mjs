import {readFileSync,writeFileSync,readdirSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root='evidence/raw/v0.2';mkdirSync(root,{recursive:true});
const privateDir='.runtime/evidence/v0.2';
const secretConfig=JSON.parse(readFileSync('.runtime/local-config.json'));
function checkText(body,name){for(const secret of Object.values(secretConfig))if(typeof secret==='string'&&secret&&body.includes(secret))throw Error('Sensitive credential found');if(/(?:C:|D:)[\\/]|serialNumber|qrPayload|qrSvg|shortCode"\s*:|secret"\s*:|utopia:\/\/pair\?/i.test(body))throw Error('Private field/path found in '+name);}
function save(name,value){const body=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';checkText(body,name);writeFileSync(root+'/'+name,body);}
const sha256=body=>createHash('sha256').update(body).digest('hex');
const readEvents=file=>existsSync(file)?readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x)):[];
// Keep original candidate and targeted radio-fix trials separate, with their own exact provenance.
for(const name of readdirSync(privateDir).filter(n=>/^(?:(?:manual|mdns|ble|qr)(?:-radiofix(?:-[a-zA-Z0-9_-]+)?)?|mdns-wrong-code|manual-qr-restoration|qr-autozoom(?:-restoration)?|manual-autozoom-restoration)-runs\.json$/.test(n))){
 const prefix=name.slice(0,-'-runs.json'.length),mode=prefix.split('-')[0],file=privateDir+'/'+name;
 const runs=JSON.parse(readFileSync(file)),events=readEvents(privateDir+'/'+prefix+'-events.jsonl'),publishedEvents=[];
 save(name,runs);
 const results=runs.map(run=>{
  const driverStart=run.start||run.startTimestamp||null,driverEnd=run.end||run.endTimestamp||null;
  const start=events.find(e=>e.event==='start'&&e.mode===mode&&(run.trialId?e.trialId===run.trialId:e.timestamp>=driverStart&&e.timestamp<=driverEnd));
  const selected=start?events.filter(e=>e.trialId===start.trialId&&(run.trialId||e.timestamp<=driverEnd)):[];
  publishedEvents.push(...selected);
  const at=event=>selected.find(e=>e.event===event)?.timestamp||null;
  const delta=(end,begin)=>end&&begin?Date.parse(end)-Date.parse(begin):null;
  const counter=key=>{const values=selected.map(x=>x[key]).filter(Number.isFinite);return values.length?Math.max(...values):null;};
  const row={...run,trialId:start?.trialId||run.trialId||null,mode,codeSha:run.codeSha,apkSha256:run.apkSha256,driverStartTimestamp:driverStart,driverEndTimestamp:driverEnd,startTimestamp:at('start'),discoveryTimestamp:at('discovery'),pairingSubmittedTimestamp:at('pairingSubmitted'),authenticatedTimestamp:at('authenticated'),snapshotLoadedTimestamp:at('snapshotLoaded'),websocketOnlineTimestamp:at('websocketOnline'),success:run.success,errorClass:run.errorClass,userActions:counter('userActions'),retryCount:counter('retryCount'),driver:run.driver,observationEndedAt:driverEnd,sourceFile:name,sourceSha256:sha256(readFileSync(file)),eventAssociationObserved:!!start};
  row.discoveryLatencyMs=delta(row.discoveryTimestamp,row.startTimestamp);row.pairingExchangeLatencyMs=delta(row.authenticatedTimestamp,row.pairingSubmittedTimestamp);row.timeToOnlineMs=delta(row.websocketOnlineTimestamp,row.startTimestamp);
  save(`${prefix}-${run.run}-events.jsonl`,selected.map(e=>JSON.stringify(e)).join('\n')+'\n');return row;
 });save(prefix+'-trials.json',results);save(prefix+'-events.jsonl',publishedEvents.map(e=>JSON.stringify(e)).join('\n')+'\n');
}
// Each camera-negative invocation gets its own publication names; never collapse shared-session trials.
const negativeBundles=[];
for(const entry of readdirSync(privateDir,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^qr-negative-[0-9TZ.\-]+$/.test(e.name))){
 const runsPath=privateDir+'/'+entry.name+'/runs.json',eventsPath=privateDir+'/'+entry.name+'/events.jsonl';if(!existsSync(runsPath))continue;
 const raw=readFileSync(runsPath),record=JSON.parse(raw),runsFile=entry.name+'-runs.json',eventsFile=entry.name+'-events.jsonl';
 const driverProvenance=typeof record.driverSha256==='string'?{driverSha256:record.driverSha256,workingTreeDirty:record.workingTreeDirty??null,driverHashMissingInOriginal:false}:{driverSha256:null,workingTreeDirty:record.workingTreeDirty??null,driverHashMissingInOriginal:true,driverProvenanceNote:'Original invocation did not record its helper hash. HEAD alone cannot bind a modified driver; no current helper hash has been assigned retrospectively.'};
 save(runsFile,{...record,...driverProvenance,sourceDirectory:entry.name,sourceRunsSha256:sha256(raw)});
 const log=readEvents(eventsPath),ids=new Set((record.runs||[]).map(r=>r.trialId).filter(Boolean));
 const selected=log.filter(e=>ids.has(e.trialId));save(eventsFile,selected.map(e=>JSON.stringify(e)).join('\n')+'\n');
 negativeBundles.push({runsFile,eventsFile,...driverProvenance,sourceDirectory:entry.name,sourceRunsSha256:sha256(raw),sourceEventsSha256:existsSync(eventsPath)?sha256(readFileSync(eventsPath)):null,codeSha:record.codeSha??null,apkSha256:record.apkSha256??null,status:record.status??null,trialRows:(record.runs||[]).length,limitations:'Preserves original failures, stage diagnostics, sessionGroup and sharedExpiredSession. Shared-session scans are not independent expiry sessions.'});
}
if(negativeBundles.length)save('qr-negative-index.json',{kind:'REAL_CAMERA_NEGATIVE_PILOT_INDEX',bundles:negativeBundles});
if(existsSync(privateDir+'/pre-position-qr-events.jsonl'))save('historical-pre-position-qr-events.jsonl',readFileSync(privateDir+'/pre-position-qr-events.jsonl','utf8'));
const connectionLog=existsSync(privateDir+'/recovery-events.jsonl')?readFileSync(privateDir+'/recovery-events.jsonl','utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
for(const kind of ['wifi','gateway','node']){const file=privateDir+'/'+kind+'-recovery.json';if(existsSync(file)){
 const rows=JSON.parse(readFileSync(file)).map(row=>{
  const selected=connectionLog.filter(e=>Date.parse(e.timestamp)>=Date.parse(row.disconnectAt)&&Date.parse(e.timestamp)<=Date.parse(row.onlineObservedAt)&&/connection_|websocketOnline/.test(e.event));
  const resumed=selected.filter(e=>Date.parse(e.timestamp)>=Date.parse(row.restoreAt));
  const offline=row.observations.find(o=>o.at===row.offlineObservedAt);
  save(`${kind}-${row.run}-connection-events.jsonl`,selected.map(e=>JSON.stringify(e)).join('\n')+'\n');
  return {...row,reconnectStartedAt:resumed.find(e=>e.event==='connection_RECONNECTING')?.timestamp||null,onlineRecoveredAt:kind==='node'?row.onlineObservedAt:(resumed.find(e=>e.event==='websocketOnline')?.timestamp||null),staleGreenObserved:offline?(kind==='node'?offline.android.at(-1)==='ONLINE':offline.android.includes('ONLINE')):null,observationLimitations:'staleGreenObserved describes the confirmed-outage UI observation only, not continuous absence. UI dump and Web reads are sequential. Node restart does not disconnect the client control channel; reconnectStartedAt may be null.'};
 });save(kind+'-recovery.json',rows);
}}
const discoverySources=[{kind:'mdns',name:'discovery-recovery-mdns-and-ble-attempt.json'},{kind:'ble',name:'discovery-recovery.json'}],discoveryFiles=[];
for(const {kind,name} of discoverySources){const file=privateDir+'/'+name;if(!existsSync(file))continue;const raw=readFileSync(file),source=JSON.parse(raw),destination=kind+'-discovery-recovery.json';save(destination,{...source,sourceFile:name,sourceSha256:sha256(raw),selection:'Only '+kind+' rows from this source; source SHA and installed APK hash retained unchanged.',runs:source.runs.filter(row=>row.kind===kind)});discoveryFiles.push(destination);}
// Replace the formerly ambiguous combined output with an index; each mechanism retains its own source/APK.
if(discoveryFiles.length)save('discovery-recovery.json',{kind:'DISCOVERY_EVIDENCE_INDEX',files:discoveryFiles,limitations:['Mechanisms may have different source commits and installed APK hashes. Read each file; do not treat earlier rows as current-APK passes.']});
for(const name of ['integration-preservation.json','telemetry-consistency.json','task-regression.json','qr-device-center.json','post-qr-restoration-host.json','post-autozoom-restoration-host.json','android-autozoom-unit-tests.json','android-autozoom-initial-unit-tests.json','ci-autozoom-product.json']){const file=privateDir+'/'+name;if(existsSync(file))save(name,JSON.parse(readFileSync(file)));}
if(existsSync(privateDir+'/telemetry-consistency.json')){
 const t=JSON.parse(readFileSync(privateDir+'/telemetry-consistency.json')),host=t.samples.find(s=>s.host?.observedAt===t.androidObservedAt)?.host;
 const gb=n=>(n/1024**3).toFixed(1)+' GB';
 const cpu=n=>typeof n==='number'?n.toFixed(1)+'%':'Unavailable';
 t.androidRenderedValuesMatch=!!host&&[`CPU: ${cpu(host.cpu.usagePercent)}`,`Memory: ${gb(host.memory.usedBytes)} / ${gb(host.memory.totalBytes)}`,`Disk: ${gb(host.disk.usedBytes)} / ${gb(host.disk.totalBytes)} · Free ${gb(host.disk.freeBytes)}`,`Uptime: ${Math.trunc(host.uptimeSeconds)} seconds`].every(v=>t.androidDisplayedMetrics.includes(v));
 t.webRenderedValuesMatch=t.samples.some(s=>s.host?.observedAt===s.web?.observedAt&&s.webDisplayedMetrics?.includes(cpu(s.host.cpu.usagePercent))&&s.webDisplayedMetrics.includes(gb(s.host.memory.usedBytes))&&s.webDisplayedMetrics.includes(gb(s.host.disk.freeBytes)));
 save('telemetry-consistency.json',t);
}
for(const name of readdirSync(privateDir).filter(n=>/^(?:android-telemetry|(?:wifi|gateway|node)-\d+-offline|(?:ble|mdns)-discovery-\d+-(?:before|unavailable|recovered))\.xml$/.test(n)))save(name,readFileSync(privateDir+'/'+name,'utf8'));
for(const name of ['android-devices.png','web-devices.png'])if(existsSync(privateDir+'/'+name))writeFileSync(root+'/'+name,readFileSync(privateDir+'/'+name));
const historical=[];
for(const name of ['pre-integration-task-regression.json','pre-integration-telemetry-consistency.json','pre-autozoom-task-regression.json','pre-autozoom-telemetry-consistency.json','pre-position-qr-runs.json','qr-usb-interrupted-runs.json','qr-onboarding-attempt-runs.json','pre-fix-mdns-runs.json','pre-permission-fix-ble-runs.json','manual-harness-attempt-runs.json','mdns-harness-attempt-runs.json','mdns-scroll-attempt-runs.json','pre-radio-fix-discovery-recovery.json','mdns-wrong-code-driver-attempt.json','mdns-wrong-code-status-overwrite-runs.json','pre-apk-provenance-telemetry-consistency.json','pre-apk-provenance-task-regression.json','discovery-recovery-driver-attempt.json','discovery-recovery-mdns-and-ble-attempt.json'])if(existsSync(privateDir+'/'+name)){const raw=readFileSync(privateDir+'/'+name),record=JSON.parse(raw),provenanceCaveat=name.startsWith('pre-apk-provenance-')?{installedApkHashMissingInOriginal:true,provenanceNote:'Original record lacks an installed APK hash. No hash has been assigned retrospectively.'}:name==='mdns-wrong-code-status-overwrite-runs.json'?{diagnosticNote:'Historical driver observation: submitted rejection was followed by discovery status overwriting the displayed error. Preserve the original failure; this record is not a final rejection-UI pass.'}:{},snapshotCaveat=name.includes('discovery-recovery')?{originalSnapshotReferencesUnresolved:true,originalSnapshotReferenceNote:'Snapshot references are original private filenames, not links to current published XML. Earlier XML was not preserved before reruns and filenames overlap; no association with newer snapshots is asserted.'}:{};historical.push({file:name,...provenanceCaveat,...snapshotCaveat,sourceSha256:sha256(raw),applicability:'Historical or driver attempt; not counted as final candidate passes. Mechanism-specific selected observations, if published separately, retain their original source/APK.',record});save('historical-'+name,{sourceFile:name,...provenanceCaveat,...snapshotCaveat,sourceSha256:sha256(raw),applicability:'Historical or driver evidence, not final candidate passes',record});}
save('historical-attempts.json',{limitations:['The first mDNS preliminary runs used APK bd3f2b6c56ea8db23547c2b7cc56bf1b3e78c34ddd25813d1c322d2ec4ee9b43 with uncommitted implementation; exact source commit was not bound.','Manual observer timeout is retained despite the private app log recording authentication and WebSocket ONLINE. Subsequent driver added handling for the OS save-password prompt; causal attribution remains an inference.'],historical});
const environment={scope:'PILOT: one Alien Windows host and one Android physical device',android:{model:'OPPO PERM00',apiLevel:31},transport:'Same local network, HTTP development deployment',limitations:['UI-driven pilots include ADB and UI hierarchy inspection overhead; timeToOnline is not a natural-user speed benchmark.','userActions counts primary app button actions; keyboard characters, OS permission gestures and harness setup are excluded.','Discovery and recovery observations are sampled, not continuous; zero transient stale duration cannot be inferred.','QR camera trials require physical positioning and are not substituted by injected deep links.']};save('environment.json',environment);
const manifest=readdirSync(root).filter(x=>x!=='manifest.json').sort().map(file=>{const body=readFileSync(root+'/'+file);if(/\.(?:json|jsonl|xml|txt|md)$/.test(file))checkText(body.toString('utf8'),file);return {file,sha256:sha256(body)};});save('manifest.json',{generatedAt:new Date().toISOString(),files:manifest});console.log('Sanitized evidence files:',manifest.length);
