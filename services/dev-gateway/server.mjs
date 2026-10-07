import http from 'node:http';
import {resolve} from 'node:path';
import {hostname,networkInterfaces} from 'node:os';
import {createBridge} from '../capability-bridge/bridge.mjs';
import {MAX_REQUEST_BYTES,refuse} from '../../contracts/capability-bridge-v1/protocol.mjs';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID, randomBytes as randomBytesBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Store } from './store.mjs';
import {createCanonicalStateAdapter} from '../personal-compute-fabric/canonical-state-adapter.mjs';
import {createGatewayFabric,validateGatewayFabricConfig} from '../personal-compute-fabric/gateway-adapter.mjs';
import {buildFabricProjection} from '../personal-compute-fabric/presentation.mjs';
import {createObservation} from './observation.mjs';
import {createGovernanceService} from './governance.mjs';
import {createPcfGovernancePort} from './governance-pcf-port.mjs';
import {createExecutionProfileController} from './execution-profile.mjs';
import {createTraceCollector} from '../research-trace/index.mjs';
import {createFaultController} from './research/faults.mjs';
// REX-806: the artifact exporter. It derives every metric from records this City holds, or reports NOT_MEASURED with a
// reason - it never fills a gap with a zero, which is why the export lives behind its own module rather than inline here.
import {buildArtifact, artifactFiles, checksumsFor, NOT_MEASURED} from './research/artifact.mjs';
import { Pairing } from './pairing.mjs';
// JOIN-503: device enrollment and tokenless routine reconnect. The registrar is a seam over the City's own
// RF-001 identity lifecycle (see services/dev-gateway/enrollment.mjs) - it mints installation credentials, issues
// short-lived SESSION credentials for the browser, and answers "may this installation act?".
import { createEnrollmentRegistrar, EnrollmentError, DEFAULT_SESSION_TTL_MS } from './enrollment.mjs';
import {memberSnapshot} from './members.mjs';
// The identity lifecycle's own error type. A refusal from RF-001's rules (`rebind_proof_required`, `clone_detected`,
// `already_bound`, 鈥? is a typed client error, not a gateway fault, so it must not surface as a 500.
import { DeviceIdentityError } from '../../city/00-foundation/02-city-node-network/device-identity/index.mjs';
import { validateTelemetry } from '../../contracts/pairing-v1/descriptor.mjs';
import { startDiscovery } from './discovery.mjs';
// The ONE place the City can make another machine run a program. Off by default; the contract owns every refusal.
import { normalizeRemoteOperation, validateRemoteOperationReceipt, REMOTE_OPERATION_EXPOSURE } from '../../contracts/city-remote-operation-v1/operation.mjs';
import { requiredCapabilitiesForTask } from './node-task-capabilities.mjs';
// The sibling channel: the City hands a remote AGENT a request and takes back a report it cannot verify, so the report
// must declare what kind of claim it is rather than arriving looking like a verification.
import { normalizeAgentJob, validateAgentJobReport, isJobExpired, consumptionReceipt, validateConsumptionRequest, REPORT_STATE_TO_TASK_STATE, AGENT_REPORTABLE_STATES, AGENT_JOB_EXPOSURE } from '../../contracts/city-agent-job-v1/job.mjs';
// JOIN-502: the approval seam for a nearby PC. It records an ASK and releases the existing City
// credential only after an already trusted device approves - it is not a second trust store, and
// discovery grants nothing on its own.
import { createJoinRequests, shortRef } from './join.mjs';
// S1: the OUTBOUND-DIAL relay, now wired to a real WebSocket. `relay.mjs` decides who may register, what may
// travel (a named list of existing payloads), and how a forwarded answer comes back; the gateway below is what
// gives it a socket, and nothing here re-implements any of those three decisions.
import { createRelayHub, createRelayDispatcher, RELAY_PAYLOAD_PATHS } from './relay.mjs';
import { browseNearby, browseBluetooth, joinCapability, hostCarrierFacts, isSelfAdvertisement } from './nearby.mjs';
// `node:os` is imported for ONE purpose: publishing what this host can honestly say about itself as a City carrier
// (cores and memory), so a REMOTE surface can weigh this machine against its own and against other PCs it can see.
// Nothing here reads identity or user data.
import { cpus as osCpus, freemem as osFreemem, totalmem as osTotalmem } from 'node:os';
import { envelope, taskTypes, terminal, validateCommand } from '../../contracts/city-control-v0/protocol.mjs';
// Product closeout (T1鈥揟3): the Room Pack, the canonical Action facade and the
// deterministic Ask / Do router. The Room Hub is reached over loopback only; nothing here
// exposes its port, and no route in this phase can reach Boss or Hns.
import { createRoomPack } from './rooms.mjs';
import { createActions, OWNER_TASK_TYPES } from './actions.mjs';
import { buildTargets, handleAsk } from './intents.mjs';
import { serveWeb } from './static.mjs';
// UXI-301: the scheduler presentation feed producer. Consumes the frozen RS-290 contract read-only.
import { buildPresentationFeed, routeInputsFor, routePlanFor } from './presentation.mjs';
import { createHandoffBridge } from './handoff.mjs';
// MESH-301 Step 3: the strict target-device routing intent. Pure module, unit-tested on its own; the
// gateway supplies the liveness facts so this file cannot grow a second opinion about "online".
import { STRICT_TARGET_FIELD, TARGET_REASONS, classifyTarget, claimAllowedByTarget, isStrictTarget, isWaitingForTarget, readTargetIntent, withheldTasks } from './targeting.mjs';
// City Core (MB-001 cluster C). The "can this node accept this work?" decision is
// owned by the migrated fleet-routing module instead of being re-derived inline
// here. Utopia's own policy travels as data (REQUIRED_TASK_CAPABILITIES and
// claimNodeFor below), so this is an equivalence-preserving rewiring, not a new rule.
import { acceptsWork } from '../../city/00-foundation/01-city-core/fleet-routing/index.mjs';
// WBC-602: the Node Role / Capability / Resource descriptor. Pure, additive and read-only: it projects a node
// record that already exists into the shape a capability/resource scheduler would need, and translates a record
// written before the contract into a conservative one. It schedules nothing and owns no state.
import { describeLegacyNode, availabilityFrom, NODE_ROLES } from '../../contracts/node-descriptor-v1/node-descriptor.mjs';
// REX-801: the experiment manifest contract and its registry. A manifest describes an experiment that is meant
// to be reproducible; it owns no work, grants no fault authority, and never invents a default for a missing
// field. The registry is file-backed and lives outside the task-keyed City store on purpose.
import { createExperimentRegistry } from './research/registry.mjs';
// REX-803: the controlled scenario runner. It owns no work of its own - every run it performs is a canonical City
// task created through the same path the product's own task route uses - and it never touches canonical task truth.
import { createScenarioRunner, ScenarioRunnerError } from './scenario-runner.mjs';
import { createReplayEngine, replayTarget, ReplayError } from './research/replay.mjs';
import { ARTIFACT_RETENTION, SEED_POLICIES, STOP_CONDITION_KINDS, TOPOLOGIES, ExperimentManifestError } from '../../contracts/experiment-manifest-v1/manifest.mjs';
// City Core (MB-006). Whether work interrupted by a restart may resume is decided by the
// migrated checkpoint-gate module instead of an inline state test.
import { checkpointGate, unboundCheckpointPort } from '../../city/02-engineering/04-restart-recovery-station/checkpoint-gate/index.mjs';
// WBC-601: the execution backend seam. The Windows Alien/Mech path is now an *implementation* of a versioned
// port (`execution-backend-v1`) rather than the only shape execution can take, so a future Workbench node pool
// is a second registration instead of a rewrite of this file. What matters here is what did NOT change: the
// claim/report decisions below are still the frozen ones, evaluated in the same order by the same functions,
// and `STANDARD_DEVICES` is enabled unconditionally so no configuration can make the current path unavailable.
import {
  DEFAULT_EXECUTION_PROFILE,
  createExecutionBackendRegistry,
  describeExecutionBackend,
} from '../../contracts/execution-backend-v1/execution-backend.mjs';
import { createStandardDevicesBackend } from './execution-backend/standard-devices.mjs';
import { createWorkerPoolBackend } from './execution-backend/worker-pool.mjs';

const now=()=>new Date().toISOString();
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const equals=(a,b)=>Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
// Utopia's placement policy, unchanged: a node must be online and expose both of these.
// Exported so the consumption test asserts against the gateway's real policy instead of
// restating it (a restated copy could be wrong in the same way the policy is wrong).
export const REQUIRED_TASK_CAPABILITIES=['task.execute.safe','filesystem.temp'];
// The node-side support vocabulary lives in its own module because the execution backend needs the same rule at claim
// time and may not import this file. See node-task-capabilities.mjs for why the rule exists at all.
export const REMOTE_OPERATION_CAPABILITY='city.remote-operation.v1';
const requiredCapabilitiesFor=type=>requiredCapabilitiesForTask(type,REQUIRED_TASK_CAPABILITIES);
// S1: a pipe is a doorway, so it is rate-limited. Sized generously for a join handshake (which is a handful of
// calls over minutes) and tightly enough that a peer cannot use the City's join routes as a request amplifier.
export const RELAY_REQUESTS_PER_SECOND=20;
// The Core's node shape, filled from the gateway's own liveness truth. A node that is
// not online is OFFLINE, and the Core refuses an OFFLINE node whatever it lists.
const claimNodeFor=n=>({nodeId:n.id,state:n.online?'READY':'OFFLINE',capabilities:n.capabilities,lastHeartbeatAt:Date.parse(n.lastHeartbeatAt)||0,seq:0});
// INTEGRATION (JOIN-502 + JOIN-503): the union signature. JOIN-502's browse budget (`nearbyTimeoutMs`) and
// JOIN-503's enrollment clock (`deviceClock`) are BOTH required - the browse route reads the first and the
// enrollment registry reads the second. Dropping either one produces a ReferenceError at request time rather than
// at load time, which is why this is stated here: the first attempt at this merge kept only `deviceClock` and every
// JOIN-502 test failed with "nearbyTimeoutMs is not defined".
export async function createGateway({host='127.0.0.1',port=4310,dir='.runtime',token,nodeToken,heartbeatTimeout=8000,pairingClock=Date.now,pairingTtlMs=300000,discoveryEnabled=false,nearbyTimeoutMs=2000,roomHubUrl=process.env.CITY_ROOMS_URL,roomsDisabled=process.env.CITY_ROOMS_DISABLED==='1',hostId=process.env.CITY_HOST_ID,roomFetch,deviceClock=Date.now,hostDeviceId:requestedHostDeviceId,hostJoin=null,researchTraceStorage,researchTraceSoftwareRefs={},governancePorts={},pcf=null,nearbyBrowser=browseNearby,remoteOperation=null,agentJob=null}) {
  if(!token||!nodeToken||token===nodeToken) throw new Error('Separate control and node tokens are required');
  if(host==='0.0.0.0'||host==='::') throw new Error('Configure an explicit loopback or LAN interface');
  if(pcf?.enabled===true&&!requestedHostDeviceId)throw new Error('PCF_LOCAL_APPROVAL_REQUIRED: explicit hostDeviceId required');
  validateGatewayFabricConfig(pcf,requestedHostDeviceId);
  const store=new Store(dir); const wss=new WebSocketServer({noServer:true}); let closed=false;
  const observation=createObservation({read:()=>store.observationWindow()});
  const governance=createGovernanceService({dir:resolve(dir,'governance'),readTask:ref=>store.get('tasks',ref.replace(/^task:/,'')),ports:{...governancePorts,pcf:governancePorts.pcf??createPcfGovernancePort(governancePorts)}});
  const researchTrace=createTraceCollector({directory:resolve(dir,'research-trace'),sourceStreamRef:store.cityId,storage:researchTraceStorage,softwareRefs:researchTraceSoftwareRefs});
  // MESH-301: WHICH control surfaces are attached to this City, and what each of them calls itself.
  //
  // The identity is declared on the event-stream handshake and travels in the CLIENT_CONNECTED /
  // CLIENT_DISCONNECTED payloads, so "the Android client is here, as PERM00" becomes a canonical fact with
  // its own `seq` that every surface can converge on - rather than something each surface infers privately
  // from the state of its own socket. A surface that declares nothing is still recorded, with nulls: an
  // anonymous client is a fact too, and omitting the event would make it invisible to the other surfaces.
  // The host principal's stable id. `||` rather than `??` and a non-empty check, because an EMPTY STRING is not an
  // identity: measured live, a City opened with an empty id produced hostDeviceId "" and memberSnapshot then added an
  // `undefined` member, whose presence the Devices surface showed as a device of its own.
  const requestedHostId=typeof requestedHostDeviceId==='string'&&requestedHostDeviceId.trim().length?requestedHostDeviceId.trim():null;
  const hostDeviceId=requestedHostId||'dev-'+store.cityId.replaceAll('-','');
  // Hostnames that mean "this machine", used to recognise the host's own node row whatever id it carries.
  const hostNames=[hostname(),store.cityName].filter(name=>typeof name==='string'&&name.trim().length);
  const gatewayFabric=createGatewayFabric({pcf,store,dir,deviceId:hostDeviceId});
  const controlSurfaces=new Map();
  // D-R1 (Mech's review finding, reproduced before this was written). `controlSurfaces` is keyed by SOCKET,
  // but the EVENT is a fact about the CLIENT - and the first version emitted a ref-level CLIENT_DISCONNECTED
  // whenever ANY socket for that ref closed. One surface can hold several sockets (a reconnect overlap, a
  // second tab), so the late close of a superseded socket announced that the client had LEFT while it was
  // still there. It happened in production: `seq 473 CLIENT_DISCONNECTED android-PERM00` with no
  // CLIENT_CONNECTED afterwards, so anyone reconstructing "which surfaces are online" from canonical events
  // concluded the Android surface left at 03:32:35 and never returned - a false negative emitted by the City
  // itself, against the workbook's requirement that every device can see what the others are doing.
  //
  // The rule that fixes it, and the reason it is a count rather than a flag: a ref is PRESENT while it has at
  // least one live socket. So CONNECTED is emitted when the count rises from zero and DISCONNECTED when it
  // falls to zero - never on an individual socket's fate.
  const surfaceCounts=new Map();
  const surfaceLabels=new Map();
  const refKey=ref=>ref??'\u0000anonymous';
  const liveSurfaces=()=>{
    // One row per CLIENT, not per socket: the earliest live socket's connectedAt, because that is when the
    // surface actually arrived. Two rows for one ref was Mech's first symptom.
    const byRef=new Map();
    for(const s of controlSurfaces.values()){
      const k=refKey(s.clientRef);const prior=byRef.get(k);
      if(!prior||Date.parse(s.connectedAt)<Date.parse(prior.connectedAt))byRef.set(k,s);
    }
    return [...byRef.values()];
  };
  const readClientIdentity=params=>{
    const ref=params.get('clientRef');const label=params.get('clientLabel');
    if(ref!==null&&ref!==''&&!/^[a-zA-Z0-9-]{1,80}$/.test(ref))fail(400,'clientRef must match [a-zA-Z0-9-]{1,80}');
    return {clientRef:ref?ref:null,clientLabel:label?String(label).slice(0,100):null};
  };
  let discovery=null,discoveryState={mdns:{state:'DISABLED'},ble:{state:'DISABLED'}};
  const nearbyScans=new Map();
  async function searchNearby(transport='lan'){
    if(!['lan','ble'].includes(transport))fail(400,'Unknown discovery transport');
    if(nearbyScans.has(transport))return nearbyScans.get(transport);
    const scan=(async()=>{
      const found=transport==='ble'?await browseBluetooth():await nearbyBrowser({interface:host==='localhost'||host==='::1'||/^127\./.test(host)?undefined:host,timeoutMs:nearbyTimeoutMs});
      // A CITY MUST NOT DISCOVER ITSELF. mDNS/DNS-SD returns every advertisement on the segment, including this City's
      // own, so the City appeared in its own neighbour list - the complaint "I can search up my own main city, it is a
      // duplicate". Self is decided by IDENTITY (the City id the advertisement carries) and, when an advertisement does
      // not identify a City, by THIS City's own address:port. It is deliberately not decided by display name, which two
      // machines may legitimately share. The excluded count is reported so a reader can see the filter did something
      // rather than silently shrinking the list.
      const selfCityId=store.cityId;
      const selfAddresses=new Set([...(Array.isArray(found.selfAddresses)?found.selfAddresses:[]),...Object.values(networkInterfaces()).flat().map(n=>n?.address),host,'127.0.0.1','::1','localhost'].filter(value=>typeof value==='string'&&value.trim().length).map(value=>value.trim().toLowerCase()));
      // The scan can OUTLIVE the listener: the browse above waits for up to nearbyTimeoutMs, and a City that is being
      // closed inside that window has already released its socket, so `server.address()` returns null. Reading `.port`
      // off it threw a bare TypeError out of a public request handler, and because nothing catches it the whole process
      // died - a discovery scan must never be able to kill the City. A port we cannot read is "this City's own address
      // cannot decide self"; identity still can, and `isSelfAdvertisement` already treats a non-integer selfPort that
      // way, so the neighbour list stays correct instead of crashing.
      const selfPort=()=>{const address=server.address();return address&&Number.isInteger(address.port)?address.port:null;};
      const isSelf=candidate=>isSelfAdvertisement(candidate,{selfCityId,selfAddresses,selfPort:selfPort()});
      const candidates=found.candidates.filter(candidate=>!isSelf(candidate));
      const excludedSelf=found.candidates.length-candidates.length;
      return {nearby:candidates.map(c=>({cityRef:c.cityId??c.cityRef,displayName:c.displayName,address:c.address,port:c.port,transport:c.transport,lastSeenAt:c.lastSeenAt,stale:c.stale,grantsTrust:false,carrierFacts:c.carrierFacts??null})),bounded:found.bounded===true,discovered:found.discovered??0,excludedSelf,unavailable:found.unavailable===true,reason:found.reason??(found.unavailable?'MDNS_UNAVAILABLE':null)};
    })();
    nearbyScans.set(transport,scan);
    try{return await scan;}finally{nearbyScans.delete(transport);}
  }
  const pairing=new Pairing({displayName:store.cityName,cityId:store.cityId,endpoint:`http://${host}:${port}`,credential:token,clock:pairingClock,ttlMs:pairingTtlMs,onChange:d=>discovery?.update(d)});
  const SESSION_PREFIX='sess:';
  // The credential the BROWSER receives. The bare session id is not a credential on its own - the prefix is what
  // makes the auth path route it to the enrollment registry - so this is the one place the two are joined.
  const sessionCredential=sessionId=>SESSION_PREFIX+sessionId;
  // A `sess:`-prefixed bearer is routed to the enrollment registry. The check is a startsWith on purpose: the
  // distinction between "a session credential" and "the control token" must not depend on how the caller's value
  // happens to be shaped beyond that prefix.
  const SESSION_BEARER='Bearer '+SESSION_PREFIX;
  // JOIN-503. Sessions are what the BROWSER holds; the durable installation credential stays with the device.
  // Entropy and the clock are injected so acceptance is decidable in tests rather than dependent on a real
  // clock - the same discipline the identity module itself follows.
  const enrollment=createEnrollmentRegistrar({
    put:(table,record)=>store.put(table,record),
    list:table=>store.list(table),
    get:(table,id)=>store.get(table,id),
    now:()=>deviceClock(),
    randomBytes:n=>randomBytesBytes(n),
    emit:(type,payload)=>emit(type,null,payload??{},'gateway'),
  });
  // JOIN-502. A join decision has to be visible to the other surfaces as a CANONICAL event rather than
  // only as a snapshot field, so the store reports every transition and this forwards it. The store is
  // created after `emit` exists, because a transition that is recorded without its event would leave
  // the surfaces disagreeing about a request a human is being asked to decide.
  let join=null;
  const telemetry=b=>{if(b.telemetry===undefined)return {};if(b.telemetry===null)return {telemetry:null};try{validateTelemetry(b.telemetry);return {telemetry:b.telemetry};}catch(e){fail(400,e.message);}};
  const observeResources=b=>{if(!b.telemetry)return;researchTrace.record({eventId:'resource-'+randomUUID(),type:'RESOURCE_OBSERVATION',timestamp:b.telemetry.observedAt,sourceClock:'EXTERNAL_DECLARED_WALL_UTC',canonicalRefs:{nodeRef:b.id},metrics:{cpuPercent:b.telemetry.cpu.usagePercent,memoryBytes:b.telemetry.memory?.usedBytes??null}});};
  let transactionTrace=null;
  let faults=null;
  const captureResearch=e=>faults?faults.capture(e):researchTrace.captureCanonical(e);
  const atomicWithTrace=fn=>{const staged=[];transactionTrace=staged;try{const result=store.atomic(fn);transactionTrace=null;for(const event of staged)captureResearch(event);return result;}finally{transactionTrace=null;}};
  const emit=(type,id,payload,actor)=>{const e=store.event(type,id,payload,actor);if(transactionTrace)transactionTrace.push(e);else captureResearch(e);for(const c of wss.clients) if(c.readyState===1)c.send(JSON.stringify(envelope({event:e})));return e;};
  join=createJoinRequests({file:resolve(dir,'join-requests.json'),clock:pairingClock,credential:token,onChange:(kind,view)=>{
    const type={created:'JOIN_REQUEST_CREATED',approved:'JOIN_REQUEST_APPROVED',rejected:'JOIN_REQUEST_REJECTED',consumed:'JOIN_REQUEST_CONSUMED',updated:'JOIN_REQUEST_UPDATED'}[kind]||'JOIN_REQUEST_UPDATED';
    // The payload is the bounded public row: no claim digest, no secret, nothing that becomes a
    // credential. `grantsTrust:false` rides along so no consumer can read the event as trust.
    emit(type,view.id,{requestId:view.id,shortRef:view.shortRef,displayName:view.displayName,platform:view.platform,state:view.state,grantsTrust:false},'city');
  }});
  // INTEGRATION S1: THE RELAY PIPE, now actually connected to a socket. `relay.mjs` was the transport and nothing
  // dialled it, so `choosePath` could return `relay-in-city` while no path existed. This hub is the City end of
  // that path: a peer that cannot be dialled opens an OUTBOUND WebSocket to `/api/v0/relay` and registers.
  //
  // ADMISSION REUSES CREDENTIALS THIS CITY ALREADY ISSUES - no second kind is invented here:
  //   * a `sess:` credential (JOIN-503) is resolved against the enrollment registry, and the peer ref comes from
  //     the SESSION's installation, never from what the peer claims about itself;
  //   * the control token admits the owner's own machine under the ref it declares.
  // A peer that presents NEITHER is still admitted, and that is a decision with a reason rather than an oversight:
  // the whole point of this pipe is the PC that is not in the City yet (that is what "asking to join" means), and
  // `join/request` is already a public route - forwarding it grants nothing. What the credential DOES buy is
  // ATTRIBUTION (`verified`), and what EVERY peer is still refused is anything outside `RELAY_PAYLOAD_PATHS`, so
  // this pipe can never become an open proxy.
  // A relay frame is answered by running the City's OWN handler for that payload, in-process.
  //
  // WHY IN-PROCESS AND NOT A SELF-CALL OVER HTTP: this server binds ONE explicit interface, so a City listening only
  // on its LAN address has no guaranteed loopback URL - and guessing one would break on exactly the machines this
  // feature exists for. Nothing here is remote, so nothing here should travel.
  //
  // WHAT IT REFUSES: only the payload list the relay already enforces is handled, and these handlers are the PUBLIC
  // join handshake plus the tokenless session route - no owner or installation operation is reachable from a pipe.
  // The list is checked here as well as in `relay.mjs` rather than trusted across the boundary.
  const relayRate=new Map();
  const executeRelayPayload=async({peerRef,path,method,body})=>{
    // A pipe is a doorway, so it gets a rate: a peer that hammers the City's join routes must be slowed down rather
    // than being allowed to fill the pending-request table with asks nobody asked for.
    const nowMs=Date.now();const windowStart=nowMs-1000;
    const recent=(relayRate.get(peerRef)??[]).filter(at=>at>windowStart);
    if(recent.length>=RELAY_REQUESTS_PER_SECOND)throw Object.assign(new Error('this relay peer is sending requests too quickly'),{status:429});
    recent.push(nowMs);relayRate.set(peerRef,recent);
    const verb=method==='GET'?'GET':'POST';
    try {
      let handled;
      if(path==='/api/v0/join/info'){
        handled=joinCapability(pairing.descriptor(),discoveryState,hostCarrierFacts({
          cores: typeof osCpus === 'function' ? osCpus().length : null,
          totalMemoryBytes: osTotalmem(),
          freeMemoryBytes: osFreemem(),
        }));
      } else if(path==='/api/v0/join/nearby'){
        handled=await searchNearby();
      } else if(path==='/api/v0/join/request'){handled=join.request(body??{});}
      else if(path==='/api/v0/join/status'){handled=join.status(body??{});}
      else if(path==='/api/v0/join/exchange'){handled=exchangeJoin(body??{});}
      else if(path==='/api/v0/device/session'){
        // The tokenless reconnect, and ONLY that half of it: an install credential exchange. A session-refresh call
        // needs a credential the pipe's peer does not have, so it has nothing to refresh here.
        const b=body??{};
        const opened=b.installationId?enrollment.openSession({installationId:b.installationId,instanceId:b.instanceId,credentialId:b.credentialId,credentialSecret:b.credentialSecret}):enrollment.refreshSession(String(b.sessionId??'').replace(SESSION_PREFIX,''));
        handled={apiVersion:0,schemaVersion:0,credential:sessionCredential(opened.session.sessionId),session:{sessionId:opened.session.sessionId,expiresAt:opened.session.expiresAt,issuedAt:opened.session.issuedAt},installation:enrollment.describe(opened.installation.installationId),cityId:store.cityId};
      } else throw Object.assign(new Error(`the relay does not carry ${path}`),{status:403});
      return {ok:true,status:200,payload:envelope(handled),error:null};
    } catch(error) {
      const status=Number.isFinite(error?.status)?error.status:500;
      return {ok:false,status,payload:envelope({error:status===500?'Gateway error':error.message,...(error.code?{errorCode:error.code}:{}),...(error.detail?{detail:error.detail}:{})}),error:String(error?.message??error)};
    }
  };
  const relayAdmit=hello=>{
    const raw=typeof hello?.credential==='string'?hello.credential:'';
    const declared=typeof hello?.installationId==='string'?hello.installationId.trim().slice(0,120):'';
    const label=typeof hello?.label==='string'?hello.label.slice(0,100):null;
    if(raw!==''){
      // A credential was PRESENTED, so it must resolve. Falling through to "anonymous" on a bad one would let a
      // revoked device keep a pipe simply by presenting the credential that was revoked.
      if(raw.startsWith(SESSION_PREFIX)){
        try {
          const resolved=enrollment.checkSession(raw.slice(SESSION_PREFIX.length));
          // The ref comes from the SESSION's installation, never from what the peer says about itself.
          return {accepted:true,peerRef:resolved.session.installationId,label,verified:true,role:'enrolled-session'};
        } catch(error) {
          return {accepted:false,reason:error?.code??'CREDENTIAL_REFUSED'};
        }
      }
      const bearer=raw.startsWith('Bearer ')?raw.slice(7):raw;
      // An EMPTY presented credential is not the control token, and must not be: `raw` being non-empty is the whole
      // reason this branch is entered.
      if(bearer===''||!equals('Bearer '+bearer,'Bearer '+token))return {accepted:false,reason:'CREDENTIAL_MISMATCH'};
      return {accepted:true,peerRef:'control:'+(declared||'owner'),label,verified:true,role:'control-token'};
    }
    if(declared==='')return {accepted:false,reason:'NO_PEER_REF'};
    return {accepted:true,peerRef:declared,label,verified:false,role:'joining-peer'};
  };
  // THE CODEC IS THE IDENTITY, and that is a bug fix rather than a preference. `relaySendFor` already produces the
  // wire text (`JSON.stringify`) because a WebSocket frame is a string, so the hub's default JSON codec serialised
  // it a SECOND time: the peer received a JSON *string containing* JSON, and every forwarded request died with
  // `RELAY_TIMEOUT` while both ends looked healthy. The hub's own tests passed because they inject the identity
  // codec - which is exactly the shape this gateway now uses.
  const relay=createRelayHub({admit:relayAdmit,codec:{encode:value=>value,decode:text=>JSON.parse(String(text))}});
  // A dialling peer DECLARES where its own City lives; recorded per peer and cleared when its pipe closes.
  const relayOrigins=new Map();
  const relayDispatch=(peerRef,raw)=>createRelayDispatcher({relay,execute:executeRelayPayload})(peerRef,raw);
  // S1: the frames the City sends its own end of the pipe are the join/approve handshake carried by `relay.mjs`.
  // Nothing here writes to disk and nothing here becomes a trust store - the pipe only moves the request.
  const relayOnMessage=(peerRef,raw)=>{Promise.resolve().then(()=>relayDispatch(peerRef,raw)).then(result=>{if(result && result.handled!==true&&result.delivered!==true&&result.settled!==true)console.warn('relay frame ignored',JSON.stringify(result));
    // A forwarded frame returns work to RUN rather than a promise to await: the socket handler must not block on a
    // slow peer, and the asking peer's own wait is bounded by the hub's request timeout.
    if(result&&typeof result.settleLater==='function')result.settleLater().then(outcome=>{if(outcome?.delivered!==true)console.warn('relay answer not delivered',outcome?.reason);}).catch(error=>console.error('relay forward failed',error?.stack??error));}).catch(error=>console.error('relay frame failed',error?.stack??error));};
  const change=(task,state,patch={},event='TASK_'+state)=>atomicWithTrace(()=>{if(task.executionBackendId==='pcf-v1')refuse('PCF_SERVICE_OWNED',409);Object.assign(task,patch,{state,updatedAt:now()});store.put('tasks',task);emit(event,task.id,{state,progress:task.progress,...patch},task.assignedNodeId||'gateway');return task;});
  // City Core (MB-006). Whether work interrupted by a restart may resume is decided by the
  // migrated checkpoint-gate module, not by an inline state test. Utopia's policy travels as
  // data: a task that was still QUEUED never started, so no checkpoint is required and the
  // gate authorizes it (it stays queued); a task that had started would lose work, and
  // Utopia binds no checkpoint port, so the donor's fail-closed default refuses it 鈥?the
  // same outcome, error text and event the inline sweep produced. timeoutMs is 0 because the
  // unbound port answers synchronously and a timeout budget would be meaningless.
  const resumeGate=checkpointGate({port:unboundCheckpointPort(),timeoutMs:0});
  for(const t of store.list('tasks')){
    if(t.executionBackendId==='pcf-v1'||terminal.includes(t.state))continue;
    const {authorized}=await resumeGate.prepare('application',t.state!=='QUEUED');
    if(!authorized)change(t,'FAILED',{error:'Gateway restarted during execution; create a new task to retry safely.'});
  }
  for(const n of store.list('nodes'))store.put('nodes',{...n,online:false});
  emit('CITY_STARTED',null,{schemaVersion:0});
  const auth=(req,node=false)=>{
    const raw=req.headers.authorization||'';
    // JOIN-503: a browser may present a SESSION credential instead of the City's control token. The session is
    // resolved against the enrollment registry on EVERY request (never cached), so revoking an installation
    // stops the very next call - including the WebSocket handshake a reconnect would use.
    if(raw.startsWith(SESSION_BEARER)){
      const presented=raw.slice(SESSION_BEARER.length);
      req.citySession=enrollment.checkSession(presented);
      return;
    }
    if(!equals(raw,'Bearer '+(node?nodeToken:token)))fail(401,'Invalid pairing token');
  };
  const version=req=>{if(req.headers['x-city-api-version']!=='0'||req.headers['x-city-schema-version']!=='0')fail(409,'Protocol mismatch: apiVersion=0 and schemaVersion=0 required');};
  const assertNewAdmission=installation=>{if(installation?.deviceId&&(installation.deviceId===hostDeviceId||store.get('nodes',installation.deviceId)||enrollment.devices().some(d=>d.deviceId===installation.deviceId)))refuse('DEVICE_ID_ALREADY_EXISTS',409,'An admission cannot assume an existing device identity');};

  const exchangeJoin=b=>{let result;assertNewAdmission(b.installation);const approved=join.status(b);const exchanged=join.exchange(b);
        if(b.installation){const enrolled=enrollment.enroll({displayName:approved.displayName,platform:approved.platform,deviceId:b.installation.deviceId??null,instanceId:b.installation.instanceId??null});const opened=enrollment.openSession({installationId:enrolled.installation.installationId,instanceId:enrolled.installation.instanceId,credentialId:enrolled.credential.credentialId,credentialSecret:enrolled.credential.credentialSecret});result={...exchanged,cityId:store.cityId,credential:sessionCredential(opened.session.sessionId),enrollment:{deviceId:enrolled.installation.deviceId,installationId:enrolled.installation.installationId,instanceId:enrolled.installation.instanceId,credentialId:enrolled.credential.credentialId,credentialSecret:enrolled.credential.credentialSecret,displayName:enrolled.device.displayName}};if(b.installation.browserOnly)result={apiVersion:0,schemaVersion:0,accepted:true,cityId:store.cityId,credential:sessionCredential(opened.session.sessionId),member:{deviceId:enrolled.installation.deviceId,displayName:enrolled.device.displayName}};}else result=exchanged;return result;};
  const assertOwnNode=(req,id)=>{if(req.citySession&&memberRef(req)!==id)fail(403,'A member can only operate its own node');};
  const bridge=createBridge(store,emit,{artifactRoot:resolve(dir,'theme-packages')});
  // UXI-391: the ownership-transfer bridge. planRoute decides and never acts; this consumes its decision and
  // executes the move under the City's single-execution guard, so REMOTE_HANDOFF is a state with an execution
  // behind it rather than a label.
  const handoff=createHandoffBridge();
  // UXI-391 REPAIR A/B (Mech's review finding, reproduced independently before this was written).
  //
  // THE DEFECT: the plan was consumed ONLY inside the switch-declined route, so the transfer was attempted at
  // the single instant the user declined. If no alternate was eligible at that instant the user's RECORDED
  // intent was dropped in silence - the run stayed on a dead device for ever, nothing failed, and nothing
  // retried. Measured, not argued: with the decline posted while no second device existed and an eligible
  // alternate brought online afterwards, the surface reached REMOTE_HANDOFF and the run still did not move;
  // posting the decline a SECOND time moved it at once, which is what proved the intent was never lost, only
  // never re-evaluated.
  //
  // REPAIR A makes the recorded intent durable: the same plan is re-considered on the Gateway's existing
  // one-second sweep, so a decline that had nowhere to go is honoured as soon as it can be. The planner stays
  // pure and never acts - this is the caller deciding to consume its decision - and repeated execution is
  // prevented by the bridge's own guards (the assignment guard's epoch, and its ALREADY_TRANSFERRED branch).
  //
  // REPAIR B stops a reservation from stranding a run: `handoffTargetRef` reserves the task for the chosen
  // device and `claimAllowed` refuses every other one, so if the chosen device then dies the task is
  // unclaimable by anyone. A reservation whose device stays offline beyond a bounded grace period is released,
  // which puts the run back in front of the whole fleet instead of in front of nobody.
  const RESERVATION_GRACE_MS=15000;
  const applyHandoffMove=(task,move)=>change(task,'QUEUED',{assignedNodeId:null,progress:0,lastCheckpoint:null,handoffFromRef:move.from,handoffTargetRef:move.to,handoffReservedAt:now(),handoffTargetOfflineSince:null,handoffEpoch:move.epoch,attempts:(task.attempts??0)+1,history:[...(task.history??[]),`handoff:${move.from}->${move.to}@epoch${move.epoch}`]},'TASK_HANDOFF_TRANSFERRED');
  const considerHandoff=task=>{
    const inputs=routeInputsFor({task,nodes:store.list('nodes'),tasks:store.list('tasks')});
    return handoff.consider({task,decided:routePlanFor({task,...inputs})});
  };
  const honourDeclinedHandoffs=()=>{
    for(const task of store.list('tasks')){
      if(terminal.includes(task.state))continue;
      // MESH-301: a device the user named is not the fleet's to move. Re-planning a strict task would be
      // silent rerouting WITH a paper trail, which is worse than the silent version, because the trail would
      // make it look authorised. It is skipped here as well as in the decline handler: this sweep is the one
      // that keeps re-planning, so it is the one that would eventually move the run.
      if(isStrictTarget(task))continue;
      // Only a run the user actually declined a switch on: everything else has no handoff intent to honour,
      // and re-planning the whole pool every second would be work nobody asked for.
      if(task.switchDeclined!==true)continue;
      if(typeof task.handoffTargetRef==='string'&&task.handoffTargetRef.length>0){
        const target=store.list('nodes').find(n=>n.id===task.handoffTargetRef);
        if(target&&target.online===true){
          if(task.handoffTargetOfflineSince)change(task,task.state,{handoffTargetOfflineSince:null});
          continue; // the reservation is live, so there is nothing to re-plan
        }
        if(!task.handoffTargetOfflineSince){change(task,task.state,{handoffTargetOfflineSince:now()});continue;}
        if(Date.now()-Date.parse(task.handoffTargetOfflineSince)>RESERVATION_GRACE_MS){
          // Release the guard's hold BEFORE clearing the persisted reservation: clearing only the field left
          // the dead device named as the holder in memory, and every other device went on being refused.
          handoff.releaseReservation({subjectRef:task.id,deviceRef:task.handoffTargetRef});
          change(task,'QUEUED',{assignedNodeId:null,progress:0,lastCheckpoint:null,handoffTargetRef:null,handoffReservedAt:null,handoffTargetOfflineSince:null},'TASK_HANDOFF_RESERVATION_RELEASED');
        }
        continue;
      }
      const move=considerHandoff(task);
      if(move.outcome==='TRANSFERRED')applyHandoffMove(task,move);
      // A refusal here is transient by nature; emitting it every second would be noise, and the endpoint path
      // still reports refusals when a user action produces one.
    }
  };
  // Product closeout (T1鈥揟3). The Room Hub is reached over loopback only, and the Action
  // facade is the single user-facing record over Rooms, capabilities and City tasks.
  const rooms=createRoomPack({baseUrl:roomHubUrl,disabled:roomsDisabled,fetchImpl:roomFetch});
  // WBC-602: the Node Role / Capability / Resource descriptor, projected READ-ONLY.
  //
  // WHY A PROJECTION AND NOT A STORED RECORD. A descriptor derived from the node's current liveness, sharing
  // flag and telemetry would go stale the moment the next heartbeat landed, and a stale descriptor stored
  // beside the canonical record is exactly how a second, disagreeing truth starts. So the canonical node
  // record stays the only stored node truth, and the descriptor is computed from it at read time.
  //
  // WHY IT IS ADDITIVE. The raw `nodes` list is untouched; `nodeDescriptors` is a new sibling field. A surface
  // that does not know about descriptors sees precisely what it saw before, and a node record written before
  // this contract existed still translates (roles from LEGACY_DEFAULT, unknown resources as UNKNOWN rather than
  // zero). `availabilityFrom` is told the fleet-routing verdict rather than deriving one, because whether a node
  // accepts work is already decided in one place and this file must not grow a second opinion about it.
  const ableNode=n=>acceptsWork(claimNodeFor(n),{requiredCapabilities:REQUIRED_TASK_CAPABILITIES})===true;
  const nodeDescriptors=()=>store.list('nodes').map(node=>{
    const able=ableNode(node);
    const busy=store.list('tasks').some(task=>task.assignedNodeId===node.id&&!terminal.includes(task.state));
    // DEFECT FOUND BY THIS TASK'S OWN TEST, REPAIRED HERE. The first version of this projection passed the
    // Core's verdict straight through, so a device whose owner had withdrawn sharing reported
    // `acceptingWork: true` beside `sharingEnabled: false` 鈥?a descriptor that contradicts itself on the one
    // question a scheduler reads it for. `acceptingWork` is now the conjunction the claim path actually
    // applies: the Core accepts this node AND its owner still shares it. "This is an execution resource"
    // (isExecutionResource), "the Core accepts it" (the node's capabilities/liveness) and "it will take work
    // right now" (acceptingWork) are three separate facts, and each one is stated.
    const sharingEnabled=node.sharingEnabled!==false;
    return describeLegacyNode(node,{
      availability:availabilityFrom({
        acceptingWork:able&&sharingEnabled&&!busy,
        state:node.online===true?'ONLINE':'OFFLINE',
        reason:node.online!==true?'ENDPOINT_OFFLINE':(!sharingEnabled?'SHARING_DISABLED_BY_OWNER':(!able?'ENDPOINT_NOT_ACCEPTING_WORK':busy?'ENDPOINT_BUSY':null)),
        sharingEnabled,
      }),
    });
  });
  // Is some real node currently able to accept the work Utopia places? Decided by the
  // migrated fleet-routing module, exactly as `/api/v0/node/claim` decides it.
  const cityAvailability=()=>{
    const able=store.list('nodes').some(n=>acceptsWork(claimNodeFor(n),{requiredCapabilities:REQUIRED_TASK_CAPABILITIES})===true);
    return able?{available:true,reason:null}:{available:false,reason:'no online node advertises task.execute.safe and filesystem.temp'};
  };
  // MESH-301 Step 3. ONE creation path, so the low-level `/tasks` route and the user-facing Action
  // facade cannot drift apart on targeting. The low-level route deliberately still accepts only `type`
  // (`validateCommand` rejects every other key), so strict targeting reaches the City through the Action
  // facade, where idempotency already exists - that is the "user-level path first" option the workbook
  // prefers, and it avoids reopening a frozen wire contract.
  // The verdict is asked per TASK TYPE, not one fleet-wide rule: a machine that can run an ordinary City task may not
  // implement the node half of a remote operation, and "eligible" has to mean "eligible for THIS task".
  const targetVerdict=(targetDeviceRef,type)=>classifyTarget({targetDeviceRef,nodes:store.list('nodes'),claimNodeFor,acceptsWork,requiredCapabilities:requiredCapabilitiesFor(type)});
  let acceptingTasks=true;
  // The owner's remote-operation configuration, frozen at startup. Nothing a request can send may widen it: the
  // allowlist and the workspace roots are decisions made by the person who owns the machines, once, at launch.
  const remoteOperationConfig=Object.freeze({
    enabled:remoteOperation?.enabled===true,
    allowlist:Object.freeze([...(remoteOperation?.allowlist??[])]),
    workspaces:Object.freeze([...(remoteOperation?.workspaces??[])]),
  });
  // Agent jobs are gated by their OWN switch. A City may legitimately want to run a repository's tooling on another
  // machine without wanting to hand free-form requests to whatever agent happens to be there, and one switch for both
  // would have made that choice for it.
  const agentJobConfig=Object.freeze({enabled:agentJob?.enabled===true});
  const createCityTask=(type,options={})=>{
    if(!acceptingTasks)fail(503,'This host is changing City role; no new local work accepted');
    // REX-803: a campaign run is an ORDINARY canonical task, and this one optional field is the only thing that
    // distinguishes it. It is written so that after a restart the work a dead campaign started can be found by
    // reference instead of by guessing which QUEUED task looked like research. It is an annotation, not a new
    // authority: nothing reads it to decide placement, targeting, or state.
    const researchRunRef=typeof options.researchRunRef==='string'&&options.researchRunRef.length>0?{researchRunRef:options.researchRunRef.slice(0,180)}:{};
    // OWNER_REMOTE_OPERATION is the one task type that carries a payload. It is normalised HERE, before the
    // transaction, so every refusal (disabled, executable not allowed, cwd outside the workspace, bounds, purpose) is
    // a client error returned to the owner rather than a half-written task a node might later be handed. The frozen
    // operation is stored on the canonical task, which is what the node executes and what the City re-checks against
    // the receipt - there is no second copy of it anywhere.
    const remoteOperationField=type==='OWNER_REMOTE_OPERATION'?{operation:normalizeRemoteOperation(options.operation,{enabled:remoteOperationConfig.enabled,allowlist:remoteOperationConfig.allowlist,workspaceRoots:remoteOperationConfig.workspaces})}:{};
    // An AGENT_JOB carries a request for a remote agent instead of a program for a remote machine. Normalised here for
    // the same reason: every refusal is a client error, not a half-written task an agent might later be handed.
    const agentJobField=type==='AGENT_JOB'?{job:normalizeAgentJob(options.job,agentJobConfig)}:{};
    // Parsed before the transaction: a malformed field is a client error, not a half-written task.
    const intent=readTargetIntent(options.targetDeviceRef);
    if(intent.ok===false)refuse(intent.code,422,intent.message);
    if(intent.present){
      // KNOWN is a creation-time gate because the workbook requires the target to reference a City node
      // identity. OFFLINE and INELIGIBLE are NOT refusals: the task is created and WAITS, because a user may
      // legitimately queue work for a device that is currently away, and pretending otherwise would be the
      // silent rerouting this task forbids. The distinction is persisted, not merely decided.
      const verdict=targetVerdict(intent.value,type);
      if(verdict.state==='UNKNOWN')refuse(TARGET_REASONS.UNKNOWN,422,`no City node identity "${intent.value}" is known to this City`);
      return atomicWithTrace(()=>{
        const t={id:'Q-'+randomUUID(),type,domain:'system',state:'QUEUED',createdAt:now(),updatedAt:now(),assignedNodeId:null,progress:0,lastCheckpoint:null,result:null,error:null,...researchRunRef,...remoteOperationField,...agentJobField,
          [STRICT_TARGET_FIELD]:intent.value,targetIntentAt:now(),targetStateAtCreation:verdict.state,targetStateDetail:verdict.detail??null};
        store.put('tasks',t);emit('COMMAND_ACCEPTED',t.id);emit('TASK_CREATED',t.id);
        if(verdict.state!=='ELIGIBLE')emit('TASK_TARGET_WAITING',t.id,{targetDeviceRef:intent.value,targetState:verdict.state,reason:verdict.reason},'user');
        return t;
      });
    }
    return atomicWithTrace(()=>{const t={id:'Q-'+randomUUID(),type,domain:'system',state:'QUEUED',createdAt:now(),updatedAt:now(),assignedNodeId:null,progress:0,lastCheckpoint:null,result:null,error:null,...researchRunRef,...remoteOperationField,...agentJobField};store.put('tasks',t);emit('COMMAND_ACCEPTED',t.id);emit('TASK_CREATED',t.id);return t;});
  };
  const cityTasks={
    terminal,
    get:id=>store.get('tasks',id),
    nodes:()=>store.list('nodes'),
    availability:cityAvailability,
    targetVerdict,
    create:createCityTask,
  };
  const actions=createActions({store,rooms,bridge,cityTasks,host:hostId||hostname()});
  // Every routable target with its own truthful availability. Nothing here is BOSS/HNS.
  const askTargets=async()=>{const roomState=await rooms.probe();return buildTargets({roomState,capabilities:bridge.registry(),cityAvailability:cityAvailability(),roomsAvailable:roomState.available});};
  const body=async (req,limit=16384)=>{let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>limit){if(limit===MAX_REQUEST_BYTES)refuse('INPUT_TOO_LARGE',413);fail(413,'Request too large');}chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{if(limit===MAX_REQUEST_BYTES)refuse('INVALID_JSON');fail(400,'Invalid JSON');}};
  const required=(table,id)=>store.get(table,id)||fail(404,'Not found');
  // WBC-601: THE EXECUTION BACKEND SEAM.
  //
  // Which execution profile this City runs, and which backends may serve it. Two decisions are recorded here
  // rather than left to a default that a later edit could change by accident:
  //
  //   1. `STANDARD_DEVICES` is registered UNCONDITIONALLY. It is not the fallback of a missing Workbench; it is
  //      the baseline the product already runs on, and the hard compatibility invariant of this programme is
  //      that a City with no Workbench and no Linux server is fully startable and fully executable.
  //   2. Future profiles are NOT enabled, and naming one does not enable it. `CITY_EXECUTION_PROFILE` may only
  //      select a profile that WBC-601 actually ships; anything else is refused at startup with the supported
  //      set named, because a City that silently ran the wrong profile would make every later "the pool did it"
  //      claim unverifiable. Enabling WORKER_POOL/HYBRID is WBC-603/604's work, not a configuration toggle.
  const enabledBackends=['standard-devices',...(process.env.CITY_EXECUTION_BACKENDS??'').split(',').map(v=>v.trim()).filter(Boolean)];
  const unsupportedBackends=enabledBackends.filter(id=>id!=='standard-devices');
  if(unsupportedBackends.length>0)throw new Error(`No execution backend implementation exists for ${unsupportedBackends.join(', ')}; only standard-devices is implemented. A future backend is enabled by shipping it, not by naming it.`);
  const executionProfile=process.env.CITY_EXECUTION_PROFILE??DEFAULT_EXECUTION_PROFILE;
  if(executionProfile!==DEFAULT_EXECUTION_PROFILE)throw new Error(`Execution profile ${executionProfile} is not enabled by this release; supported profiles: ${DEFAULT_EXECUTION_PROFILE}`);
  const executionBackends=createExecutionBackendRegistry({defaultProfile:DEFAULT_EXECUTION_PROFILE});
  // WBC-604: the profile becomes a RUNTIME decision. The startup value is only an initial seed; from here on the
  // controller owns it, persists it, and gates every switch on the registry's own readiness answer. A dormant backend
  // reports ABSENT rather than throwing at the caller, which is what keeps "the pool is not there yet" from becoming a
  // City that will not start.
  const profileController=createExecutionProfileController({dir, initial:executionProfile, readinessOf:profile=>{try{return executionBackends.forProfile(profile).readiness();}catch(error){return {state:error?.code==='BACKEND_DORMANT'?'ABSENT':'UNAVAILABLE',reason:error?.message??'backend unavailable'};}}});
  const currentProfile=()=>profileController.profile();
  // The port is built over the gateway's OWN primitives - its node liveness shape, its strict-target guard, its
  // handoff reservation guard, its canonical transition writer - so the backend cannot grow a second opinion
  // about any of them. `claimNodeFor`/`acceptsWork` are the very functions the Core is asked through elsewhere
  // in this file, and `REQUIRED_TASK_CAPABILITIES` is exported by this module, so the policy has one home.
  const standardDevices=createStandardDevicesBackend({
    store,
    terminal,
    claimNodeFor,
    requiredCapabilities:REQUIRED_TASK_CAPABILITIES,
    claimAllowedByTarget,
    handoffClaimAllowed:args=>handoff.claimAllowed(args),
    noteAssignment:args=>handoff.noteAssignment(args),
    withheldTasks,
    changeTask:change,
    requireRecord:required,
    fail,
  });
  executionBackends.register(standardDevices);
  // Registration is inert: no adapter, discovery, credentials or startup probe.
  executionBackends.register(createWorkerPoolBackend());
  // Read at request time through the registry, never captured as the raw port: a later backend registration
  // must be able to take effect without every route holding a stale reference.
  const executionBackend=()=>executionBackends.active(currentProfile());
  // REX-801: the research experiment registry.
  //
  // The capability vocabulary is taken from the LIVE bridge rather than from a constant, so "this manifest
  // requires a capability nobody provides" is decided against what this City can actually do right now 鈥?the
  // workbook's unknown-capability gate is only meaningful if it is answered by the real provider list. The
  // documents live under the git-ignored runtime directory as files (see research/registry.mjs for why the City's
  // task-keyed store is the wrong home for a description), and nothing here executes anything: the routes can
  // list, create, validate and inspect an experiment, and that is all.
  const experiments=createExperimentRegistry({
    dir:resolve(dir,'research','experiments'),
    knownCapabilities:bridge.registry().map(descriptor=>descriptor.capabilityId),
  });
  // REX-803: the controlled campaign surface - the half that EXECUTES the experiments REX-801 only describes.
  //
  // WHAT A CAMPAIGN IS HERE. A campaign is one described experiment run as N repetitions of one canonical scenario.
  // Every run creates an ORDINARY canonical task through `createCityTask`, the same path the product's own task
  // route uses, and the run's outcome is the terminal state of that real task. The runner owns no work: it never
  // writes a task, never assigns one, never completes one, and never invents a scenario. A research runner that
  // simulated execution would be measuring the simulator, which is why there is no simulation path here at all.
  //
  // THE SCENARIO VOCABULARY IS THE PRODUCT'S OWN TASK TYPES, read from the frozen wire contract rather than
  // maintained by hand beside it: a scenario the City cannot execute must not be selectable, and a hand-written
  // list is a list that drifts from the contract it claims to describe.
  const campaignScenarios=taskTypes.map(id=>({id,kind:'CANONICAL_TASK',description:`one canonical ${id} task, observed to a terminal state`}));
  const campaignWorkers=()=>store.list('nodes').filter(node=>node.online===true&&ableNode(node)&&node.sharingEnabled!==false).map(node=>node.id);
  // TOPOLOGY READINESS IS A MEASUREMENT, NOT A PROMISE. The experiment declares hosts, workers and control surfaces;
  // a campaign refuses to start unless every declared identity is live in THIS City at that moment. A campaign that
  // started on a topology it did not actually have would produce numbers nobody could reproduce.
  const campaignReadiness=context=>{
    const manifest=context?.manifest??null;
    if(!manifest)return {state:'READY',missing:[],workers:campaignWorkers(),surfaces:liveSurfaces().map(surface=>surface.clientRef),identitySemantics:'NO_TOPOLOGY_DECLARED'};
    const workers=campaignWorkers();
    const surfaces=liveSurfaces().map(surface=>surface.clientRef).filter(Boolean);
    const missing=[...new Set([...manifest.hosts,...manifest.workers].filter(id=>!workers.includes(id)).concat(manifest.controlSurfaces.filter(id=>!surfaces.includes(id))))];
    return {state:missing.length===0?'READY':'NOT_READY',missing,workers,surfaces,identitySemantics:'CANONICAL_LIVE_REFS'};
  };
  // A run reference is `<campaignId>:<repetition index>`: stable across a restart, unique per repetition, and the
  // only handle a recovered process has on work whose task id it never saw.
  const researchRunRef=(campaignId,index)=>`${campaignId}:${index}`;
  const cancelCampaignTask=taskId=>{const task=store.get('tasks',taskId);if(task&&!terminal.includes(task.state))change(task,'CANCELLED');};
  const campaigns=createScenarioRunner({
    dir:resolve(dir,'research'),
    scenarios:campaignScenarios,
    readiness:campaignReadiness,
    runOnce:async({scenario,campaignId,index,seed,control,context})=>{
      // THE DECLARED WORKERS COME FROM THE MANIFEST, AND THIS READ USED TO MISS THEM. The campaign context carries the
      // topology under `context.manifest.workers`; the first version read only `context.workers`, which the route never
      // sets, so the array was ALWAYS empty and the placement rule below never executed. Every run was created
      // untargeted and the assignment the receipt recorded was whichever able worker claimed first. With ONE worker -
      // every fixture in this task's suite, and both physical campaigns, because the Android handset was a control
      // surface rather than a worker - that is indistinguishable from the rule working. The two-worker rehearsal found
      // it on its first run: "6 of 6 campaign task(s) were created with no targetDeviceRef".
      const workers=context?.manifest?.workers??context?.workers??[];
      // The seed is USED, not decorative. With no explicit target the repetition's own derived seed selects among the
      // experiment's declared workers, so the same campaign places the same repetition on the same device, on any
      // host. With an explicit target the operator's choice wins, and the run says which rule was applied.
      const target=replayTarget(context,seed);
      let task;
      try{task=createCityTask(scenario.id,{...(target?{targetDeviceRef:target}:{}),researchRunRef:researchRunRef(campaignId,index)});}
      catch(error){return {state:'FAILED',reason:`the canonical task could not be created: ${error?.message??error}`};}
      // Rule: a stop or a timeout must reach the work. The cleanup is registered with the runner, so it runs whether
      // the stop came from the operator or from the run outliving its timeout.
      control.onCancel(()=>cancelCampaignTask(task.id));
      while(true){
        if(control.cancelled()){
          cancelCampaignTask(task.id);
          return {state:'CANCELLED',reason:control.reason(),result:{taskRef:task.id,assignedNodeId:store.get('tasks',task.id)?.assignedNodeId??null}};
        }
        const current=store.get('tasks',task.id);
        if(!current)return {state:'FAILED',reason:'the canonical task disappeared while its campaign was running',result:{taskRef:task.id}};
        if(terminal.includes(current.state)){
          // AN OUTSIDE CANCELLATION IS A CANCELLATION, NOT A FAILURE (finding R-2). When an operator cancels the run's
          // canonical task from outside the campaign, the work did not fail - it was cancelled - and recording that as
          // FAILED mis-attributed the cause. The reason still names exactly what happened, so a reader can tell a
          // campaign-stop cancellation from someone else's cancellation.
          if(current.state==='CANCELLED')return {state:'CANCELLED',reason:'the canonical task was cancelled outside the campaign',result:{taskRef:current.id,state:current.state,assignedNodeId:current.assignedNodeId??null}};
          return current.state==='COMPLETED'
            ? {state:'MEASURED',result:{taskRef:current.id,state:current.state,assignedNodeId:current.assignedNodeId??null,result:current.result??null}}
            : {state:'FAILED',reason:`the canonical task ended ${current.state}${current.error?`: ${current.error}`:''}`,result:{taskRef:current.id,state:current.state,assignedNodeId:current.assignedNodeId??null}};
        }
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    },
    // ONE announcement per settled run, emitted by the runner rather than by the run: a run that ended by timeout or
    // by a stop is announced here too, so the research trace can never be missing the runs that went wrong - which
    // are precisely the ones a reader needs.
    onRunRecord:({campaign,run})=>{
      const dimensions={experimentRunRef:researchRunRef(campaign.campaignId,run.index)};
      if(campaign.context?.experimentId)dimensions.experimentRef=campaign.context.experimentId;
      // A dimension is a reference, so the reason travels as a bounded, sanitised code; the full reason stays in the
      // run row and in the campaign receipt, where free text belongs.
      if(run.reason)dimensions.failureCode=String(run.reason).slice(0,60).replace(/[^A-Za-z0-9_./:#-]/g,'_');
      // `deviceRef` belongs to canonicalRefs, not to dimensions: it names the real node that executed the task, and
      // putting it in the dimension set made every receipt fail validation with TRACE_INPUT_INVALID - which the
      // collector reported as a failed record rather than as a thrown error, so the campaign looked traced and was
      // not. Caught by this task's own route test.
      const canonicalRefs={...(run.result?.taskRef?{taskRef:run.result.taskRef}:{}),...(run.result?.assignedNodeId?{deviceRef:run.result.assignedNodeId}:{})};
      researchTrace.record({
        eventId:researchRunRef(campaign.campaignId,run.index),
        type:'RESEARCH_RUN_RECEIPT',
        timestamp:now(),
        sourceClock:'HOST_WALL_UTC',
        ...(Object.keys(canonicalRefs).length>0?{canonicalRefs}:{}),
        dimensions,
        metrics:{latencyMs:run.durationMs??null},
      });
    },
    // Recovery hands the orphaned repetition back as a REFERENCE and the City finds the task by it. Nothing is
    // inferred from a task's shape, its age, or the order it happens to appear in.
    cancelRun:({campaignId,index})=>{for(const task of store.list('tasks'))if(task.researchRunRef===researchRunRef(campaignId,index)&&!terminal.includes(task.state))change(task,'CANCELLED');},
  });
  // THE EXPERIMENT'S OWN STOP CONDITIONS BOUND THE CAMPAIGN. A campaign that ignored the MAX_FAILURES its manifest
  // declared would not be the experiment that was described, and a caller may only make a declared bound TIGHTER.
  // MIN_SUCCESSFUL_RUNS is read from stopConditions and NOT from acceptance.minimumSuccessfulRuns: the latter is a
  // criterion for judging the result, and turning it into a stop would end the campaign at the first passing subset.
  const campaignLimits=(manifest,requested=null)=>{
    // An unknown limit key is REFUSED, not ignored: a caller who typed `maxFailure` must not be left believing they
    // bounded the campaign when nothing was bounded.
    for(const key of Object.keys(requested??{}))if(!['wallClockMs','maxFailures','minSuccessfulRuns'].includes(key))refuse('LIMITS_INVALID',422);
    const declared=kind=>{const found=(manifest.stopConditions??[]).filter(condition=>condition.kind===kind).map(condition=>condition.value);return found.length===0?null:Math.min(...found);};
    const limits={};
    for(const [kind,key] of [['MAX_WALL_CLOCK_MS','wallClockMs'],['MAX_FAILURES','maxFailures'],['MIN_SUCCESSFUL_RUNS','minSuccessfulRuns']]){
      const value=declared(kind);
      if(value!==null)limits[key]=value;
    }
    for(const key of ['wallClockMs','maxFailures','minSuccessfulRuns']){
      const asked=requested?.[key];
      if(asked===undefined||asked===null)continue;
      if(!Number.isSafeInteger(asked)||asked<1)refuse('LIMITS_INVALID',422);
      if(limits[key]!==undefined&&asked>limits[key])refuse('LIMITS_EXCEED_DECLARED',422);
      limits[key]=asked;
    }
    return Object.keys(limits).length>0?limits:null;
  };
  // The receipt has to be readable without the registry, so the experiment's declared facts travel WITH the campaign.
  // It is a copy of a frozen document, not a second source of truth: the registry remains the only thing that can
  // answer what the experiment was.
  //
  // A SHORT, STABLE IDENTITY RATHER THAN THE REGISTRY'S `digest` FIELD. REX-801's record exposes `digest` as the
  // CANONICAL SERIALISATION of the manifest, not a hash of it, so using that value directly made every campaign seed
  // `experimentId@<the entire manifest as JSON>` - found by running the first campaign on real hardware (defect D-7).
  // Hashing it here gives a 32-character identity that is still a pure function of the registered document, so two
  // hosts running the same manifest still derive the same seed sequence.
  const experimentIdentity=record=>createHash('sha256').update(typeof record?.digest==='string'?record.digest:JSON.stringify(record?.manifest??null)).digest('hex').slice(0,32);
  const campaignContext=(described,targetDeviceRef)=>Object.freeze({experimentId:described.experimentId,manifestIdentity:experimentIdentity(described),manifest:Object.freeze({topology:described.manifest.topology,hosts:described.manifest.hosts,workers:described.manifest.workers,controlSurfaces:described.manifest.controlSurfaces,repetitions:described.manifest.repetitions,seedPolicy:described.manifest.seedPolicy,baseSeed:described.manifest.baseSeed,stopConditions:described.manifest.stopConditions,acceptance:described.manifest.acceptance,softwareRefs:described.manifest.softwareRefs}),targetDeviceRef:targetDeviceRef??null});
  const replays=createReplayEngine({receipt:id=>campaigns.receipt(id),experiment:id=>experiments.get(id),register:manifest=>experiments.register(manifest),
    start:options=>campaigns.start(options),identity:experimentIdentity,context:campaignContext,limits:campaignLimits,
    preflight:context=>{
      if(campaigns.progress().state==='RUNNING'||campaigns.unfinished())throw new ReplayError('REPLAY_BUSY','finish or explicitly resolve the current campaign before replay');
      if(campaigns.storeState()!=='READY')throw new ReplayError('REPLAY_STORE_UNAVAILABLE','campaign receipt storage is unavailable');
      if(campaignReadiness(context).state!=='READY')throw new ReplayError('REPLAY_TOPOLOGY_NOT_READY','the recorded topology is not currently live; unavailable conditions cannot be replayed deterministically');
    }});
  // UNION (REX series merge, in the owner-granted window): this fault controller and the campaign/replay
  // controllers above are independent - none of the three references another - so all of them are constructed here,
  // and the single return at the end of this function exposes every one of them with a teardown that releases all.
  faults=createFaultController({dir:resolve(dir,'research','faults'),node:id=>store.get('nodes',id),trace:researchTrace});
  // What a research surface needs in order to build a valid manifest, published with every research response so
  // the contract is discoverable from the contract itself: the topologies this release can describe, the seed
  // policies, the stop-condition kinds, the retention levels, and the LIVE capability vocabulary that the
  // unknown-capability gate is decided against. None of it is a copy that can drift, because the capability list
  // is read from the bridge on each request.
  const researchFacts=()=>({
    contractVersion:experiments.contractVersion,
    topologies:Object.keys(TOPOLOGIES),
    topologyRequirements:TOPOLOGIES,
    seedPolicies:SEED_POLICIES,
    stopConditionKinds:STOP_CONDITION_KINDS,
    artifactRetention:ARTIFACT_RETENTION,
    capabilityVocabulary:bridge.registry().map(descriptor=>descriptor.capabilityId),
    ownsTaskState:false,
    grantsFaultAuthority:false,
    executesExperiments:false,
  });

  // INTEGRATION (JOIN-502 + JOIN-503): ONE snapshot carries both additions. The earlier de-duplication regex in
  // this branch's resolver matched the UNION line instead of JOIN-502's stale one (both begin with the same text
  // and the union ends with `joinRequests:join.snapshot()`), so it removed `joinRequests` and every JOIN-502 test
  // failed on the listing being undefined. Restored here, with `enrolledDevice` kept from JOIN-503.
  const isLocalRequest=req=>{const address=req?.socket?.remoteAddress?.replace(/^::ffff:/,'');return address==='127.0.0.1'||address==='::1'||Object.values(networkInterfaces()).flat().some(n=>n?.address===address);};
  const members=()=>memberSnapshot({store,installations:enrollment.list(),surfaces:liveSurfaces(),hostDeviceId,hostnames:hostNames});
  const memberRef=req=>req.citySession?req.citySession.installation.deviceId:hostDeviceId;
  const snapshot=(req)=>envelope({hostDeviceId,currentMemberRef:req?.citySession?memberRef(req):isLocalRequest(req)?hostDeviceId:null,members:members(),hostJoinAvailable:Boolean(hostJoin)&&!req?.citySession&&isLocalRequest(req),status:'ONLINE',updatedAt:now(),cityId:store.cityId,displayName:store.cityName,descriptor:pairing.descriptor(),discovery:discoveryState,nodes:store.list('nodes'),controlSurfaces:liveSurfaces(),tasks:store.list('tasks'),events:store.events(),capabilities:bridge.registry(),invocations:bridge.list(),joinRequests:join.snapshot(),
    // JOIN-503: the surface that is asking is told which INSTALLATION it is. A control-token client gets null
    // (it is the owner, not an enrolled installation), which is exactly what the Settings page needs in order to
    // show an enrollment summary for an enrolled client and the engineering fallback for a control-token one.
    enrolledDevice:req?.citySession?enrollment.describe(req.citySession.session.installationId):null,
    // WBC-601: which execution profile is serving this City, as an observable fact rather than an internal
    // detail. It is a DESCRIPTOR only - it names the backend and its mode, never a device - so a surface can
    // say "these runs are placed by STANDARD_DEVICES" without gaining any authority over placement. A future
    // backend appears here by being registered; nothing in this field can enable one.
    executionBackend:{profile:executionProfile,backend:describeExecutionBackend(executionBackends.active(executionProfile)),registered:executionBackends.list()}});
  // JOIN-502: `joinRequests` carries only LIVE ask rows (PENDING / APPROVED) as bounded public views,
  // so an already connected trusted surface can show "someone nearby wants to join" without polling a
  // second endpoint. It deliberately contains no claim digest and no credential, and each row declares
  // grantsTrust:false, so the surface cannot read the list as a device list.
  const server=http.createServer(async(req,res)=>{
    try {
      const path=new URL(req.url,'http://city').pathname;
      if(!path.startsWith('/api/')){
        // The Web control surface is served from apps/web with containment checking, so a
        // new product page does not require a transport change.
        if(await serveWeb(res,path))return;
        fail(404,'Not found');
      }
      // Health has to be able to say "degraded". It used to be the constant `healthy`, so a
      // supervisor polling this endpoint could not see a dead Room Hub even though the product
      // surfaces were telling the truth about it.
      //
      // The status code stays 200 on purpose: the Gateway itself is serving, and a 503 here
      // would make every "is the process up?" probe misreport a healthy process as absent. The
      // degradation is stated explicitly instead, in `status` and in `components`.
      if(path==='/api/v0/health'){
        const roomState=await rooms.probe();
        // WBC-601: the execution backend is reported as its own component with its own readiness word. It is
        // NOT part of the degraded calculation on purpose: "no device is online right now" is a normal state of
        // a peer-to-peer City, not a broken gateway, and making it degrade the whole City would recreate exactly
        // the kind of global blocker this programme forbids. Readiness is stated so a supervisor can see it.
        const backendState=executionBackend().readiness();
        const components={gateway:{state:'READY'},rooms:{state:roomState.available?'READY':'UNAVAILABLE',reason:roomState.available?null:roomState.reason,hubUrl:roomState.hubUrl},execution:{state:backendState.state,reason:backendState.reason,detail:backendState.detail,profile:executionProfile,backendId:standardDevices.backendId,ready:backendState.ready,endpointCount:backendState.endpointCount,readyEndpointCount:backendState.readyEndpointCount},artifacts:bridge.artifactStore()};
        // `execution` is deliberately excluded from the degraded calculation: having no device online at this
        // instant is a normal state of a peer-to-peer City, not a broken gateway, and folding it in would make a
        // supervisor unable to tell the two apart. The word is still reported, so it is visible where it matters.
        // `artifacts` is excluded for the same reason: the theme lab is ONE capability, and a City that cannot
        // persist theme builds is still a City that runs tasks, rooms and execution paths. Folding it in would let
        // one stray file at <runtime>/theme-packages make every "is the process up?" probe call a live City dead.
        const degraded=components.gateway.state!=='READY'||components.rooms.state!=='READY';
        res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
        res.end(JSON.stringify(envelope({status:degraded?'degraded':'healthy',components})));
        return;
      }
      // A joining PC holds no City credential yet, which is the entire point of asking to join. These
      // four routes are therefore reachable without one, and every one of them is either public
      // information (what City is this), a request that grants nothing, or an operation gated by the
      // requester's own claim secret. EVERY decision route is authenticated and stays out of this list.
      //
      // The VERSION check still applies to them. The first version gated it on `!publicPairing`, so a
      // public join route got no version check at all - which is the opposite of what the protocol
      // wants - and the browser's own /api/v0/join/info call then failed 409 because it sent no version
      // headers. The check now describes the actual rule: pairing/info and pairing/exchange are the only
      // two routes that skip it, and they do so because they predate the header and their callers are
      // already deployed.
      const nodeRoute=path.startsWith('/api/v0/node/');
      // REX-801: research routes are CONTROL-credential routes. A node credential describes a worker, and an
      // experiment description is an owner-level act of research governance: it names required capabilities, stop
      // conditions and acceptance criteria for work that will be placed on those workers. Letting a worker
      // register the experiment it will be judged by would make the acceptance criteria self-certified.
      const researchRoute=path.startsWith('/api/v0/research/');
      // REX-803: spending the fleet on an experiment is the OWNER's act even more plainly than describing one. An
      // enrolled installation may read its own City, but it may not start, stop or inspect a campaign: the control
      // credential is the only thing that reaches these routes, exactly as for the research trace and the execution
      // profile. Stated as an explicit refusal rather than left to the shape of the credential check above.
      const campaignRoute=path==='/api/v0/research/campaigns'||path.startsWith('/api/v0/research/campaigns/')||path==='/api/v0/research/replays'||path.startsWith('/api/v0/research/replays/');
      // INTEGRATION: JOIN-502's OWN auth preamble used to stand here and has been removed. The text-level union
      // kept both, so this earlier one ran FIRST and authenticated before `publicJoin` existed, which made every
      // join route answer 401 while the code behind it was correct (`ask 0 answered 401` in the JOIN-502 suite).
      // The union preamble below is the one that names all three exemption kinds, so it is the only one kept.
      // REVIEW, JOIN-502 second pass: the BROWSE is now public, and that is a decision with a stated reason.
      // A joining PC holds no credential - that is the premise of the whole join flow - and the connection screen
      // must be able to LIST the nearby PCs before anybody has typed anything. As developed, this route was
      // authenticated, so a disconnected surface's own browse answered 401 and the "your PCs" list could never
      // populate on the very screen that needs it. WHAT IT DISCLOSES: the same City identities, addresses and
      // capability summaries this City ALREADY multicasts over mDNS to every machine on the link, so the
      // incremental disclosure of the unauthenticated route is nil. WHAT IT DOES NOT DO: it grants nothing (every
      // row carries grantsTrust:false), the browse is bounded in both directions, and every DECISION route - the
      // request list, approve, reject - stays authenticated.
      const publicJoin=path==='/api/v0/join/info'||path==='/api/v0/join/request'||path==='/api/v0/join/status'||path==='/api/v0/join/exchange'||path==='/api/v0/join/nearby';
      const legacyPublicPairing=path==='/api/v0/pairing/info'||path==='/api/v0/pairing/exchange';
      // INTEGRATION: `selfAuthenticating` belongs to THIS preamble, not to the one that was removed above - keeping
      // it in the removed block left the union preamble unaware of it, so /device/session answered 401 and every
      // JOIN-503 enrollment test failed with the same "Invalid pairing token" as an unauthenticated request.
      const selfAuthenticating=req.method==='POST'&&path==='/api/v0/device/session';
      // The operation log is an OWNER surface, not a node surface: it is reached with the City's control token, so it
      // is excluded from the node-token requirement exactly as `/node/sharing` already was. Leaving it inside
      // `nodeRoute` would have made the owner's own read surface unreachable to the owner.
      const ownerNodeRoute=path==='/api/v0/node/operations'||path==='/api/v0/node/jobs'||path.startsWith('/api/v0/node/jobs/');
      if(!publicJoin&&!legacyPublicPairing&&!selfAuthenticating)auth(req,nodeRoute&&path!=='/api/v0/node/sharing'&&!ownerNodeRoute&&!researchRoute);
      if(path.startsWith('/api/v0/research/faults')&&req.citySession)refuse('RESEARCH_OWNER_REQUIRED',403,'Fault controls require the City owner');
      if(!legacyPublicPairing)version(req);
      // REX-803: the campaign surface is owner-only, and the refusal names the reason rather than the credential.
      if(campaignRoute&&req.citySession)refuse('RESEARCH_OWNER_REQUIRED',403);
      let out;
      // JOIN-502 answers first, in the SAME chain as everything below: a second `if` chain would run
      // after a join route had already produced `out` and overwrite it with `undefined`, so every join
      // route answered 404 while doing its work correctly. The defect was caught by the first
      // end-to-end probe of this path, not by inspection.
      // CARRIER FACTS: what kind of carrier THIS host would be, published so a remote client can score it against
      // its own machine and the other PCs it can see - without them, "which PC should host" could only be decided
      // by network path, i.e. by whoever answered first. Measured per request rather than cached, because free
      // memory is exactly the number that changes and a stale value would make a busy machine look idle.
      // attachment/metered are left null on purpose: node cannot tell us whether the link is wired or metered, and
      // a guess published to other machines would be indistinguishable from a measurement.
      if(req.method==='GET' && path==='/api/v0/join/info')out=joinCapability(pairing.descriptor(),discoveryState,hostCarrierFacts({
        cores: typeof osCpus === 'function' ? osCpus().length : null,
        totalMemoryBytes: osTotalmem(),
        freeMemoryBytes: osFreemem(),
      }));
      else if(req.method==='POST' && path==='/api/v0/join/request')out=join.request(await body(req));
      else if(req.method==='POST' && path==='/api/v0/join/status')out=join.status(await body(req));
      else if(req.method==='POST' && path==='/api/v0/join/exchange')out=exchangeJoin(await body(req));
      // JOIN-502: the BROWSE. A browser cannot listen to multicast DNS, so the surface asks the City
      // that serves this page, which browses `_utopia-city._tcp` on its own LAN and answers with rows.
      // The wire shape is flat and bounded ON PURPOSE: the RF-003 candidate is an internal contract
      // object, and shipping it to a browser surface would both leak its internals and invite the
      // surface to re-derive trust rules it has no business deriving.
      else if(req.method==='GET' && path==='/api/v0/join/nearby'){
        out=await searchNearby(new URL(req.url,'http://city').searchParams.get('transport')||'lan');
        // `cityRef` is the FULL City identity read from the City's own capability endpoint, not the short
        // mDNS prefix: it is what the join fragment pins and what the receiving City checks itself
        // against, and a prefix would make that check fail on a legitimate hand-off.
      }
      else if(req.method==='GET' && path==='/api/v0/pairing/info')out=pairing.info();
      // UNION (CEX-704 onto the JOIN-590 integration): main's owner-only minting guard and CEX-704's
      // expectedSessionState precondition belong to the SAME route, so they are composed into one handler rather
      // than concatenated - the mechanical pass left two bodies and a stray block here.
      else if(req.method==='POST' && path==='/api/v0/pairing/session'){
        if(req.citySession)refuse('SESSION_CANNOT_MINT_PAIRING',403,'Only the City owner may create a pairing code');
        const b=await body(req);
        if(b.expectedSessionState!==undefined){
          if(!['IDLE','USED','EXPIRED','LOCKED'].includes(b.expectedSessionState))refuse('PAIRING_STATE_INVALID',400,'A known terminal pairing state is required');
          const current=pairing.info();
          if(current.activeSession||current.sessionState!==b.expectedSessionState)refuse('PAIRING_STATE_CHANGED',409,'Pairing state changed; refresh before generating');
        }
        out=await pairing.create();
      }
      else if(req.method==='POST' && path==='/api/v0/pairing/exchange'){
        const b=await body(req);
        assertNewAdmission(b.installation);const exchanged=pairing.exchange(b);
        // JOIN-503: a joining installation that declared itself during the exchange is ENROLLED in the same
        // breath, because the pairing exchange IS the owner's proof that this installation may join. The
        // response keeps the existing `credential` field untouched (an old client must not break), and adds an
        // enrollment block carrying the DURABLE installation credential plus a first SESSION. Only the enrolling
        // device ever sees the durable secret; the City keeps nothing but its fingerprint.
        if(b.installation&&typeof b.installation==='object'){
          const enrolled=enrollment.enroll({
            deviceId:b.installation.deviceId??null,
            displayName:b.installation.displayName||b.installation.hostname||'Utopia client',
            platform:b.installation.platform??null,
            instanceId:b.installation.instanceId??null,
          });
          const opened=enrollment.openSession({
            installationId:enrolled.installation.installationId,
            instanceId:enrolled.installation.instanceId,
            credentialId:enrolled.credential.credentialId,
            credentialSecret:enrolled.credential.credentialSecret,
          });
          out={...exchanged,credential:sessionCredential(opened.session.sessionId),apiVersion:0,schemaVersion:0,enrollment:{
            installationId:enrolled.installation.installationId,
            instanceId:enrolled.installation.instanceId,
            deviceId:enrolled.installation.deviceId,
            displayName:enrolled.device.displayName,
            credentialId:enrolled.credential.credentialId,
            credentialSecret:enrolled.credential.credentialSecret,
            session:{credential:sessionCredential(opened.session.sessionId),expiresAt:opened.session.expiresAt},
          }};
        } else out=exchanged;
        if(b.installation?.browserOnly&&out.enrollment){const e=out.enrollment;out={apiVersion:0,schemaVersion:0,cityId:store.cityId,credential:e.session.credential,member:{deviceId:e.deviceId,displayName:e.displayName}};}
      }
      // JOIN-503. The enrollment surface. `enroll` needs the CONTROL token because it mints authority; the
      // browser reaches it only through the pairing page the owner already authorised. Nothing here is reachable
      // by a session credential, so a joined device cannot enroll a second device for itself.
      else if(req.method==='POST' && path==='/api/v0/device/enroll'){
        const b=await body(req);
        if(req.citySession)refuse('SESSION_CANNOT_ENROLL',403,'an enrolled session cannot mint another installation');
        out=enrollment.enroll({deviceId:b.deviceId??null,displayName:b.displayName,platform:b.platform??null,unbound:b.unbound===true});
      }
      // The reconnect path. Called with installation credentials it MINTS a session; called with an existing
      // session credential it refreshes (the web surface's routine restart case). No user input in either shape.
      else if(req.method==='POST' && path==='/api/v0/device/session'){
        const b=await body(req);
        // The credential decides which of two things is being asked:
        //   * an ENROLLED SESSION presenting its own session id -> refresh that session (nothing durable involved);
        //   * installation credentials -> prove identity and mint a session. There is no user input in either
        //     shape, which is what "tokenless routine reconnect" means in practice.
        const opened=(!req.citySession&&b.installationId)
          ? enrollment.openSession({installationId:b.installationId,instanceId:b.instanceId,credentialId:b.credentialId,credentialSecret:b.credentialSecret})
          : enrollment.refreshSession(req.citySession?req.citySession.session.sessionId:String(b.sessionId??'').replace(SESSION_PREFIX,''));
        out={apiVersion:0,schemaVersion:0,credential:sessionCredential(opened.session.sessionId),session:{sessionId:opened.session.sessionId,expiresAt:opened.session.expiresAt,issuedAt:opened.session.issuedAt},installation:enrollment.describe(opened.installation.installationId),cityId:store.cityId};
      }
      // Mech's formal review D-2 (accepted). The roster is the OWNER's view of the City. Before this, a `sess:`
      // credential was answered with every installation and device record in the City - while the very same
      // session was refused the authority to enroll or rebind. Those two facts cannot both be right: a session
      // belongs to ONE installation (workbook section 3), so it sees itself and nothing else, and the Settings
      // surface still works for the owner because the owner holds the control token.
      //
      // THIS IS D-2 TAKEN ONE STEP FURTHER THAN THE REVIEW'S MINIMUM: `cloneFindings` is a CITY-WIDE population
      // scan, and it names other installations' ids and credential fingerprints. Scoping only the `installations`
      // array would still have handed a session a map of every installation whose credential is duplicated, so a
      // session gets an empty scan and the scope is stated in the payload rather than left to be inferred.
      else if(req.method==='GET' && path==='/api/v0/device/installations'){
        const mine=req.citySession?req.citySession.session.installationId:null;
        out={apiVersion:0,schemaVersion:0,cityId:store.cityId,
          installations:mine?enrollment.list().filter(entry=>entry.installationId===mine):enrollment.list(),
          cloneFindings:mine?[]:enrollment.cloneFindings(),
          scope:mine?'OWN_INSTALLATION':'CITY'};
      }
      // A reinstall is BOUND again only by an explicit rebind carrying proof (RF-001's rule). Until then the
      // installation holds an identity with no logical device and can do nothing, which is the state a fresh
      // install is supposed to be in.
      else if(req.method==='POST' && /^\/api\/v0\/device\/installations\/[^/]+\/rebind$/.test(path)){
        const b=await body(req);const installationId=decodeURIComponent(path.split('/').at(-2));
        if(req.citySession)refuse('SESSION_CANNOT_REBIND',403,'an enrolled session cannot rebind installations');
        out={apiVersion:0,schemaVersion:0,installation:enrollment.rebind({installationId,deviceId:b.deviceId,proof:b.proof})};
      }
      // Mech's formal review D-1 (accepted, required repair). THE DEFECT I SHIPPED: this route required only
      // `auth()`, and `auth()` accepts a `sess:` credential - so any enrolled installation could revoke ANY OTHER
      // installation, including the client the owner was using, with nothing but the short-lived session
      // credential a browser keeps in sessionStorage. That is privilege escalation across installations. It also
      // contradicted my own boundary: the sibling routes already refuse a session with SESSION_CANNOT_ENROLL /
      // SESSION_CANNOT_REBIND, and the comment I wrote on the enrollment route states the intent in as many words.
      // Enforcing it on two of three routes is not a boundary, it is a gap.
      //
      // THE RULE, stated once so the next route cannot miss it: a session credential may act on ITS OWN
      // installation and on nothing else. Leaving the City is legitimate and affects nobody, so a self-revoke is
      // allowed; revoking another installation is the owner's act and needs the control token.
      else if(req.method==='POST' && /^\/api\/v0\/device\/installations\/[^/]+\/revoke$/.test(path)){
        const b=await body(req);const installationId=decodeURIComponent(path.split('/').at(-2));
        const mine=req.citySession?req.citySession.session.installationId:null;
        if(mine&&mine!==installationId)refuse('SESSION_CANNOT_REVOKE_OTHER',403,'an enrolled session may only revoke its own installation');
        out={apiVersion:0,schemaVersion:0,revoked:enrollment.revoke({installationId,reason:b.reason??'revoked_by_owner'}),scope:mine?'OWN_INSTALLATION':'CITY'};
        const revokedRef=out.revoked.deviceId;const n=store.get('nodes',revokedRef);if(n)store.put('nodes',{...n,online:false});for(const [socket,surface] of controlSurfaces)if(surface.clientRef===revokedRef)socket.close(1008,'Device revoked');emit('MEMBER_REVOKED',null,{deviceId:revokedRef});
      }
      else if(req.method==='GET' && path==='/api/v0/research/trace'){
        if(req.citySession)refuse('RESEARCH_OWNER_REQUIRED',403,'Research trace requires the City owner');
        out={trace:researchTrace.snapshot()};
      }
      else if(req.method==='GET' && path==='/api/v0/capabilities')out={capabilities:bridge.registry()};
      else if(req.method==='GET' && path==='/api/v0/capability-invocations')out={invocations:bridge.list(new URL(req.url,'http://city').searchParams.get('limit')??undefined)};
      else if(req.method==='GET' && /^\/api\/v0\/capability-invocations\/[^/]+$/.test(path))out=bridge.get(decodeURIComponent(path.split('/').at(-1)))||refuse('INVOCATION_NOT_FOUND',404);
      else if(req.method==='GET' && /^\/api\/v0\/capabilities\/[^/]+$/.test(path))out=bridge.registry().find(c=>c.capabilityId===decodeURIComponent(path.split('/').at(-1)))||refuse('CAPABILITY_NOT_FOUND',404);
      else if(req.method==='POST' && /^\/api\/v0\/capabilities\/[^/]+\/invoke$/.test(path))out=await bridge.invoke(decodeURIComponent(path.split('/').at(-2)),await body(req,MAX_REQUEST_BYTES));
      else if(req.method==='PATCH' && path==='/api/v0/city/name') {
        if(req.headers.authorization!=='Bearer '+token)fail(403,'Only the City owner can rename the City');
        const b=await body(req);pairing.displayName=store.renameCity(b.displayName);
        discovery?.update(pairing.descriptor());emit('CITY_RENAMED',null,{displayName:store.cityName});
        out={cityId:store.cityId,displayName:store.cityName};
      }
      else if(req.method==='GET' && path==='/api/v0/city')out=snapshot(req);
      // WBC-604 control surface. Owner-only: the execution profile decides where work runs, which is a
      // user/permission-level decision, so a member session may read nothing and change nothing here.
      else if(req.method==='GET' && path==='/api/v0/execution-profile'){
        if(req.citySession)fail(403,'Only the City owner may read the execution profile control surface');
        out={executionProfile:profileController.state()};
      }
      else if(req.method==='POST' && path==='/api/v0/execution-profile'){
        if(req.citySession)fail(403,'Only the City owner may change the execution profile');
        const b=await body(req);
        try{
          const receipt=b.action==='ROLLBACK'?profileController.rollback():profileController.change(b.profile);
          out={receipt,executionProfile:profileController.state()};
        }catch(error){refuse(error.code??'PROFILE_CHANGE_REFUSED',409,error.message);}
      }
      else if(req.method==='GET' && path==='/api/v0/monitor')out={monitor:await observation.refresh(),governance:req.headers.authorization==='Bearer '+token?governance.overview():{authoritative:false,health:'OWNER_ONLY'}};
      else if(path==='/api/v0/governance'||/^\/api\/v0\/governance\/[^/]+(?:\/actions)?$/.test(path)){
        if(req.headers.authorization!=='Bearer '+token)fail(403,'Only the City owner may inspect governance evidence');
        try{
          if(req.method==='GET'&&path==='/api/v0/governance')out={governance:governance.list()};
          else if(req.method==='POST'&&path==='/api/v0/governance')out={governance:governance.create(await body(req))};
          else if(req.method==='GET'&&!path.endsWith('/actions'))out={governance:governance.inspect(decodeURIComponent(path.split('/').at(-1)))};
          else if(req.method==='POST'&&path.endsWith('/actions'))out={governance:governance.act(decodeURIComponent(path.split('/').at(-2)),await body(req))};
          else fail(405,'Governance method unavailable');
        }catch(error){refuse(error.code??'GOVERNANCE_DOCUMENT_UNAVAILABLE',409,error.message);}
      }
      else if(req.method==='GET' && path==='/api/v0/pcf'){
        if(req.citySession)fail(403,'Only the City owner may read the fabric control surface');
        out={fabric:buildFabricProjection(createCanonicalStateAdapter(store).snapshot(),{backendConfigured:Boolean(gatewayFabric),serviceState:gatewayFabric?.service.health().state,tasks:store.list('tasks')}),...(gatewayFabric?{service:gatewayFabric.service.health(),parentSessionId:gatewayFabric.context.sessionId}:{})};
      }
      else if(gatewayFabric && path.startsWith('/api/v0/pcf/')){
        if(req.citySession)refuse('PCF_OWNER_REQUIRED',403);
        if(req.headers.origin && req.headers.origin!==pairing.endpoint)refuse('PCF_ORIGIN_REFUSED',403);
        const service=gatewayFabric.service,context=gatewayFabric.context;
        try{
          if(req.method==='POST'&&path==='/api/v0/pcf/submit'){
            const b=await body(req);
            if((b.parentSessionId!==undefined&&b.parentSessionId!==context.sessionId)||b.originDeviceId!==undefined||b.deviceId!==undefined)refuse('PCF_CALLER_BINDING',403);
            out=await service.submit({...b,parentSessionId:context.sessionId},context);
          }else{
            const match=/^\/api\/v0\/pcf\/tasks\/([^/]+)(?:\/(cancel|collect|acknowledge))?$/.exec(path);
            if(!match)refuse('PCF_ROUTE_NOT_FOUND',404);
            const taskId=decodeURIComponent(match[1]),operation=match[2];
            if(req.method==='GET'&&!operation)out={task:await service.inspect(taskId,context)};
            else if(req.method==='POST'&&['cancel','collect','acknowledge'].includes(operation)){
              const b=await body(req);
              if(Object.keys(b).some(key=>key!==(operation==='acknowledge'?'digest':'')))refuse('PCF_CALLER_BINDING',403);
              out=operation==='acknowledge'?await service.acknowledge(taskId,context,b.digest):await service[operation](taskId,context);
            }else refuse('PCF_ROUTE_NOT_FOUND',404);
          }
        }catch(error){if(error.status)throw error;refuse(error.code??'PCF_REFUSED',409,error.message);}
      }
      else if(req.method==='POST' && path==='/api/v0/node/sharing'){
        const b=await body(req);if(memberRef(req)!==b.id)fail(403,'Only this device may change its resource sharing');if(typeof b.enabled!=='boolean')fail(400,'Sharing requires enabled boolean');const n=required('nodes',b.id);out=store.put('nodes',{...n,sharingEnabled:b.enabled});emit('NODE_SHARING_CHANGED',null,{nodeId:b.id,enabled:b.enabled});
      }
      else if(req.method==='POST' && path==='/api/v0/members/messages'){
        const b=await body(req);const sender=memberRef(req);const target=members().find(m=>m.deviceId===b.targetDeviceId);if(!target)fail(404,'Target is not a member of this City');
        if(typeof b.text!=='string'||!b.text.trim()||b.text.length>4096)fail(400,'Message must contain 1鈥?096 characters');
        const rows=store.list('member_messages');if(rows.length>=256){const old=rows.find(m=>m.state==='RECEIVED');if(!old)fail(429,'Message capacity reached');store.db.prepare('DELETE FROM member_messages WHERE id=?').run(old.id);}
        const message=store.put('member_messages',{id:randomUUID(),senderDeviceId:sender,targetDeviceId:b.targetDeviceId,text:b.text.trim(),state:'PENDING',createdAt:now(),receivedAt:null});out={message};emit('MEMBER_MESSAGE_AVAILABLE',null,{messageId:message.id,targetDeviceId:message.targetDeviceId});
      }
      else if(req.method==='GET' && path==='/api/v0/members/messages')out={messages:store.list('member_messages').filter(m=>m.senderDeviceId===memberRef(req)||m.targetDeviceId===memberRef(req))};
      else if(req.method==='POST' && /^\/api\/v0\/members\/messages\/[^/]+\/receipt$/.test(path)){
        await body(req);const message=required('member_messages',decodeURIComponent(path.split('/').at(-2)));if(message.targetDeviceId!==memberRef(req))fail(403,'Only recipient may confirm receipt');out={message:store.put('member_messages',{...message,state:'RECEIVED',receivedAt:message.receivedAt||now()})};emit('MEMBER_MESSAGE_RECEIVED',null,{messageId:message.id});
      }
      // UXI-301: the scheduler presentation feed. READ-ONLY, and it decides nothing - it reports the
      // RS-202 eligibility the City's own modules already produced, mapped through the frozen RS-290
      // contract so the UI can show user language instead of scheduler vocabulary. Finished tasks are
      // excluded by default because a scheduler status surface is about work in flight.
      else if(req.method==='GET' && path==='/api/v0/presentation')out=buildPresentationFeed({tasks:store.list('tasks'),nodes:store.list('nodes'),generatedAt:now()});
      // --- Pre-assistant product closeout (T1鈥揟3) --------------------------------
      // Rooms: truthful availability plus the catalog, through the authenticated path.
      else if(req.method==='GET' && path==='/api/v0/rooms')out={rooms:await rooms.probe()};
      // Canonical Action facade. Repeating an idempotency key replays, never re-executes.
      else if(req.method==='GET' && path==='/api/v0/actions')out={actions:actions.list(new URL(req.url,'http://city').searchParams.get('limit')??undefined)};
      else if(req.method==='GET' && /^\/api\/v0\/actions\/[^/]+$/.test(path))out={action:actions.get(decodeURIComponent(path.split('/').at(-1)))||refuse('ACTION_NOT_FOUND',404)};
      else if(req.method==='POST' && path==='/api/v0/actions'){
        const actionBody=await body(req);
        // OWNER ONLY, checked before the Action is recorded so a member's attempt leaves no half-made request behind.
        // `req.citySession` is set exactly when the caller presented an enrolled session credential instead of the
        // City's control token, so this is the same boundary the research fault controls and the execution profile
        // already use - not a new notion of "owner".
        //
        // The set of owner-only task types is read from the SAME list the Action facade uses, so a type added there
        // cannot be forgotten here and quietly become member-reachable. Each type still names its OWN refusal code,
        // because "which owner-only surface refused me" is what a caller has to act on.
        if(actionBody?.route==='CITY_TASK'&&OWNER_TASK_TYPES.includes(actionBody?.operation)&&req.citySession){
          const agentJob=actionBody.operation==='AGENT_JOB';
          refuse(agentJob?'AGENT_JOB_OWNER_REQUIRED':'REMOTE_OPERATION_OWNER_REQUIRED',403,agentJob?'Agent jobs require the City owner':'Remote operation requires the City owner');
        }
        out=await actions.create(actionBody);
      }
      // Deterministic Ask / Do. There is no model in this path and no BOSS/HNS route.
      else if(req.method==='GET' && path==='/api/v0/ask/targets')out={targets:await askTargets()};
      else if(req.method==='POST' && path==='/api/v0/ask')out={ask:await handleAsk(await body(req),{actions,targets:await askTargets(),roomState:await rooms.probe()})};
      else if(req.method==='POST' && path==='/api/v0/host/join'){
        if(req.citySession||!hostJoin||!isLocalRequest(req))fail(403,'Only the local host owner may change its role');out=await hostJoin.start(await body(req));
      }
      else if(req.method==='GET' && path==='/api/v0/host/join/status'){
        if(req.citySession||!hostJoin)fail(403,'Only the local host owner may read the join ticket');out=await hostJoin.status(new URL(req.url,'http://city').searchParams.get('ticketId'));
      }
      else if(req.method==='GET' && path==='/api/v0/nodes')out={nodes:store.list('nodes'),nodeDescriptors:nodeDescriptors()};
      else if(req.method==='GET' && path==='/api/v0/tasks')out={tasks:store.list('tasks')};
      // The owner's view of the remote-operation surface. Owner-only for the same reason the dispatch is: a member
      // must not see what programs are being run on the other machines, and the operations carry command lines.
      // Every receipt is re-checked against the operation the City dispatched before it is shown, so this surface
      // cannot present a node's claim as if the City had accepted it.
      else if(req.method==='GET' && path==='/api/v0/node/operations'){
        if(req.citySession)refuse('REMOTE_OPERATION_OWNER_REQUIRED',403,'Remote operation requires the City owner');
        const wanted=Number(new URL(req.url,'http://city').searchParams.get('limit')??20);
        const limit=Number.isSafeInteger(wanted)&&wanted>0?Math.min(50,wanted):20;
        const rows=store.list('tasks').filter(task=>task.type==='OWNER_REMOTE_OPERATION')
          .sort((a,b)=>String(b.createdAt??'').localeCompare(String(a.createdAt??''))).slice(0,limit)
          .map(task=>({taskId:task.id,state:task.state,progress:task.progress,assignedNodeId:task.assignedNodeId,createdAt:task.createdAt,updatedAt:task.updatedAt,
            targetStateAtCreation:task.targetStateAtCreation??null,targetStateDetail:task.targetStateDetail??null,
            executable:task.operation?.executable??null,argv:task.operation?.argv??[],cwd:task.operation?.cwd??null,purpose:task.operation?.purpose??null,
            timeoutMs:task.operation?.timeoutMs??null,maxOutputBytes:task.operation?.maxOutputBytes??null,shell:task.operation?.shell??null,
            operationDigest:task.operation?.operationDigest??null,error:task.error??null,result:task.result??null,
            receipt:task.operation&&task.result?validateRemoteOperationReceipt(task.operation,task.result):null}));
        out={exposure:REMOTE_OPERATION_EXPOSURE,config:{enabled:remoteOperationConfig.enabled,allowlist:remoteOperationConfig.allowlist,workspaces:remoteOperationConfig.workspaces},operations:rows};
      }
      // The owner's view of the AGENT-JOB surface: what was asked of a remote agent, who took it, and what came back.
      // Owner-only for the same reason the operation log is - a job states what the owner wants done on another machine,
      // and a report is an agent's answer about it.
      //
      // Everything shown here is either the City's own record or explicitly labelled as the agent's claim:
      //  * `deadline.state` is a PROJECTION. The City does not run a scheduler, so an expired job is reported as expired
      //    rather than silently rewritten, and `task.state` still says what the canonical task says.
      //  * `report.validation` re-runs the contract on every read. It never upgrades the agent's claim into a
      //    verification, which is why `acceptanceAuthority` is false on every accepted report and travels with it.
      else if(req.method==='GET' && path==='/api/v0/node/jobs'){
        if(req.citySession)refuse('AGENT_JOB_OWNER_REQUIRED',403,'Agent jobs require the City owner');
        const wanted=Number(new URL(req.url,'http://city').searchParams.get('limit')??20);
        const limit=Number.isSafeInteger(wanted)&&wanted>0?Math.min(50,wanted):20;
        const rows=store.list('tasks').filter(task=>task.type==='AGENT_JOB')
          .sort((a,b)=>String(b.createdAt??'').localeCompare(String(a.createdAt??''))).slice(0,limit)
          .map(task=>{
            const expired=task.job?isJobExpired({...task.job,state:task.state,createdAt:task.createdAt}):null;
            const deadlineAt=task.job&&Number.isFinite(Date.parse(task.createdAt))?new Date(Date.parse(task.createdAt)+task.job.deadlineMs).toISOString():null;
            return {taskId:task.id,state:task.state,progress:task.progress,assignedNodeId:task.assignedNodeId,createdAt:task.createdAt,updatedAt:task.updatedAt,
              targetStateAtCreation:task.targetStateAtCreation??null,targetStateDetail:task.targetStateDetail??null,
              // A job with no normalised request is not presented as an empty one: the missing piece is named.
              job:task.job?{title:task.job.title,instruction:task.job.instruction,purpose:task.job.purpose,inputs:task.job.inputs,expect:task.job.expect,
                deadlineMs:task.job.deadlineMs,jobDigest:task.job.jobDigest}:null,
              jobDigest:task.job?.jobDigest??null,
              jobState:task.job?null:'JOB_RECORD_MISSING',
              deadline:{deadlineAt,expired:expired===true,projectedState:task.job&&expired&&!terminal.includes(task.state)?'EXPIRED':null},
              // Taking delivery is a fact about the READER, so it is reported beside the report rather than inside it,
              // and the three states are distinguishable: there is nothing to collect yet / it is waiting to be
              // collected / it was collected. Collapsing those into a boolean would make "nobody has read this" and
              // "this failed" look the same.
              consumptionState:task.result?(task.consumptionReceipt?'COLLECTED':'AWAITING_COLLECTION'):'NOTHING_TO_COLLECT',
              consumption:task.consumptionReceipt??null,
              error:task.error??null,report:task.result??null,
              reportValidation:task.job&&task.result?validateAgentJobReport(task.job,task.result):null};
          });
        out={exposure:AGENT_JOB_EXPOSURE,config:{enabled:agentJobConfig.enabled},jobs:rows};
      }
      // The owner TAKES DELIVERY of a report. Owner-only, and idempotent by construction: the FIRST consumption is the
      // record, and a later call carrying a different note is refused rather than allowed to rewrite what was recorded.
      // A recorded act is not edited - the same rule the rest of this City follows for user decisions.
      else if(req.method==='POST' && /^\/api\/v0\/node\/jobs\/[^/]+\/consumed$/.test(path)){
        if(req.citySession)refuse('AGENT_JOB_OWNER_REQUIRED',403,'Agent jobs require the City owner');
        const taskId=decodeURIComponent(path.split('/').at(-2));
        const t=required('tasks',taskId);
        if(t.type!=='AGENT_JOB')refuse('NOT_AN_AGENT_JOB',409,`task ${taskId} is not an agent job`);
        const b=await body(req);
        const wanted=typeof b?.note==='string'&&b.note.trim()!==''?b.note.trim():null;
        if(t.consumptionReceipt){
          // Re-taking delivery of the same report is not an error - a caller may simply repeat itself - but it returns
          // the receipt that was recorded rather than issuing a new one.
          if(wanted!==null&&wanted!==(t.consumptionNote??null))refuse('CONSUMPTION_ALREADY_RECORDED',409,'this report was already taken; a recorded delivery is not rewritten');
          out={consumption:t.consumptionReceipt,idempotent:true,consumptionState:'COLLECTED'};
        } else {
          const verdict=validateConsumptionRequest(t.job,t.result);
          if(verdict.ok!==true)refuse(verdict.code,409,`there is nothing to take delivery of: ${verdict.code}`);
          const receipt=consumptionReceipt({taskId,job:t.job,report:t.result,consumedAt:now(),consumedBy:hostDeviceId??null,note:wanted});
          change(t,t.state,{consumedAt:receipt.consumedAt,consumedBy:receipt.consumedBy,consumptionNote:receipt.note,consumptionReceipt:receipt},'AGENT_JOB_REPORT_CONSUMED');
          out={consumption:receipt,idempotent:false,consumptionState:'COLLECTED'};
        }
      }
      else if(req.method==='GET' && path==='/api/v0/events')out={events:store.events()};
      // JOIN-502 owner decisions. These are AUTHENTICATED: deciding who joins is exactly the authority
      // a control credential carries, and an unauthenticated decision route would let any machine that
      // can reach the LAN approve itself.
      else if(req.method==='GET' && path==='/api/v0/join/requests')out=join.list();
      else if(req.method==='POST' && /^\/api\/v0\/join\/requests\/[^/]+\/approve$/.test(path))out=join.approve({requestId:decodeURIComponent(path.split('/').at(-2))});
      else if(req.method==='POST' && /^\/api\/v0\/join\/requests\/[^/]+\/reject$/.test(path))out=join.reject({requestId:decodeURIComponent(path.split('/').at(-2))});
      else if(req.method==='GET' && /^\/api\/v0\/tasks\/[^/]+$/.test(path))out=required('tasks',path.split('/').at(-1));
      else if(req.method==='POST' && path==='/api/v0/tasks'){
        const b=await body(req);validateCommand(b);
        out=createCityTask(b.type);
      } else if(req.method==='POST' && /^\/api\/v0\/tasks\/[^/]+\/cancel$/.test(path)){
        const t=required('tasks',path.split('/').at(-2));if(terminal.includes(t.state))fail(409,'Task already finished');out=change(t,'CANCELLED');
      } else if(req.method==='POST' && /^\/api\/v0\/tasks\/[^/]+\/provider-choice$/.test(path)){
          // UXI-301: THE SWITCH PATH, made really executable. The workbook's gate requires the switch and
          // no-switch paths both be genuinely executable and that the user's choice really returns to the
          // backend, and the independent review checks exactly that.
          //
          // The CITY records the choice; it does not let the UI decide placement, because the UI never
          // sent a placement - it relayed one explicit user instruction, which is the opposite of the UI
          // recomputing selection. Returning the task to QUEUED is the honest consequence of "use a
          // different service".
          const b=await body(req);
          if(typeof b.providerRef!=='string'||b.providerRef.length===0||b.providerRef.length>200)fail(400,'providerRef must be a non-empty string');
          const t=required('tasks',path.split('/').at(-2));
          if(terminal.includes(t.state))fail(409,'Task already finished');
          out=change(t,'QUEUED',{assignedNodeId:null,chosenProviderRef:b.providerRef,userChoiceAt:now()});
          emit('TASK_PROVIDER_CHOSEN',t.id,{providerRef:b.providerRef},'user');
      } else if(req.method==='POST' && /^\/api\/v0\/tasks\/[^/]+\/switch-declined$/.test(path)){
          const b=await body(req);
          // UXI-301: the user declined the provider switch. That is the ONE condition RS-202's planner
          // reaches ALTERNATE_DEVICE on, and it means "do not switch provider - use another of my own
          // devices instead". Recorded as an explicit user intent that the routing planner then acts on,
          // rather than as a flag set by a test.
          const t=required('tasks',path.split('/').at(-2));
          if(terminal.includes(t.state))fail(409,'Task already finished');
          const explicitAlternate=b.decision==='ALTERNATE_DEVICE';
          if(b.decision!==undefined&&!explicitAlternate)refuse('CHOICE_INVALID',400,'Unsupported scheduler decision');
          if(explicitAlternate&&(typeof b.expectedUpdatedAt!=='string'||!Number.isFinite(Date.parse(b.expectedUpdatedAt))))refuse('CHOICE_INVALID',400,'A current task revision is required');
          if(explicitAlternate&&t.alternateDeviceDecisionRevision===b.expectedUpdatedAt){out=t;}else{
          if(explicitAlternate){
            if(t.updatedAt!==b.expectedUpdatedAt)refuse('CHOICE_STALE',409,'The task changed; refresh before choosing');
            const entry=buildPresentationFeed({tasks:store.list('tasks'),nodes:store.list('nodes')}).tasks.find(entry=>entry.taskId===t.id);
            const choice=entry?.userChoices?.alternateDevice;
            if(!choice?.allowed)refuse(choice?.reason??'NO_SWITCH_DECISION',409,'Another device cannot be selected for this task right now');
          }
          out=change(t,t.state,{switchDeclined:true,userDeclinedSwitchAt:now(),...(explicitAlternate?{alternateDeviceDecisionRevision:b.expectedUpdatedAt}:{})});
          emit('TASK_SWITCH_DECLINED',t.id,{},'user');
          // UXI-391: THIS is where the plan is consumed. The user's decline is the only condition under which
          // RS-202 reaches ALTERNATE_DEVICE, so the orchestration plans over live City state and executes the
          // transfer the planner decided - the planner itself stays pure and never acts. If the stage is
          // DIRECT, SWITCH_OFFERED or QUEUED nothing moves, and that is recorded rather than papered over.
          {
            if(isStrictTarget(out)){
              // MESH-301. Declining a provider switch means "do not change the service". It cannot also mean
              // "use another of my devices", because the user has already said which device this run belongs
              // to - so the plan is not consumed here at all, and the refusal is recorded instead of enacted.
              emit('TASK_HANDOFF_REFUSED',out.id,{reason:TARGET_REASONS.BOUND,from:null,to:out[STRICT_TARGET_FIELD]},'gateway');
            } else {
              const move=considerHandoff(out);
              if(move.outcome==='TRANSFERRED'){
                // progress:0 is deliberate - the new holder starts the task from the beginning, and the protocol
                // requires monotonic progress, so carrying the dead holder's progress across would be rejected by
                // the next report. handoffTargetRef is what survives a gateway restart and keeps the task
                // reserved for the device it moved to, so a recovered A cannot re-claim it.
                out=applyHandoffMove(out,move);
              } else if(move.outcome==='REFUSED'){
                emit('TASK_HANDOFF_REFUSED',out.id,{reason:move.reason,from:move.from??null,to:move.to??null},'gateway');
              }
            }
          }
          }
      } else if(req.method==='POST' && path==='/api/v0/node/register'){
        const b=await body(req);assertOwnNode(req,b.id);if(req.citySession)b.displayName=enrollment.describe(req.citySession.session.installationId)?.displayName;
        if(!/^[a-zA-Z0-9-]{1,80}$/.test(b.id||'')||typeof b.displayName!=='string'||!Array.isArray(b.capabilities)||!b.capabilities.every(c=>typeof c==='string'))fail(400,'Invalid node registration');
        if(b.roles!==undefined&&(!Array.isArray(b.roles)||b.roles.length<1||b.roles.length>NODE_ROLES.length||!b.roles.every(role=>NODE_ROLES.includes(role))||!b.roles.includes('EXECUTION_NODE')))fail(400,'Registered worker roles must include EXECUTION_NODE and use the supported vocabulary');
        const prior=store.get('nodes',b.id);
        const roles=b.roles??prior?.roles;
        for(const t of store.list('tasks'))if(t.assignedNodeId===b.id&&!terminal.includes(t.state))change(t,'FAILED',{error:'Node re-registered; interrupted work is not replayed.'});
        out=store.put('nodes',{id:b.id,devicePrincipalId:b.id,displayName:b.displayName.slice(0,100),metadata:{platform:String(b.metadata?.platform||'unknown'),osName:b.metadata?.osName?String(b.metadata.osName).slice(0,60):null,osRelease:b.metadata?.osRelease?String(b.metadata.osRelease).slice(0,40):null,arch:b.metadata?.arch?String(b.metadata.arch).slice(0,20):null,archName:b.metadata?.archName?String(b.metadata.archName).slice(0,40):null,runtimeVersion:b.metadata?.runtimeVersion?String(b.metadata.runtimeVersion).slice(0,24):null,hostname:b.metadata?.hostname?String(b.metadata.hostname).slice(0,80):null},agentVersion:typeof b.agentVersion==='string'?b.agentVersion.slice(0,30):'0.1.0',...telemetry(b),...(roles?{roles:[...new Set(roles)].sort()}:{}),sharingEnabled:prior?.sharingEnabled??true,capabilities:b.capabilities,online:true,lastHeartbeatAt:now()});
        // UNION (JOIN-590 closeout integration): the branch integrated here carried a pre-WBC-602 copy of this write
        // WITHOUT `roles`, and concatenating both made the older one overwrite the newer - which silently dropped a
        // DECLARED role set and is exactly what the WBC-602 review test caught. The newer write is kept alone.
        observeResources(b);
        if(!prior?.online){
          emit('NODE_ONLINE',null,{nodeId:b.id});
          // MESH-301: a strict task that was waiting for this device becomes claimable the moment the device
          // returns. Emitted so offline/reconnect convergence is visible in the canonical event stream instead
          // of having to be inferred from whatever claim happens to come next.
          for(const t of store.list('tasks'))if(isWaitingForTarget(t,terminal)&&t[STRICT_TARGET_FIELD]===b.id)emit('TASK_TARGET_READY',t.id,{targetDeviceRef:b.id},'gateway');
        }
      } else if(req.method==='POST' && path==='/api/v0/node/heartbeat'){
        const b=await body(req);assertOwnNode(req,b.id);const n=required('nodes',b.id);const metrics=telemetry(b);await faults.before('heartbeat',b.id);if(!n.online)emit('NODE_ONLINE',null,{nodeId:n.id});out=store.put('nodes',{...n,...metrics,online:true,lastHeartbeatAt:now()});faults.success('heartbeat',b.id);
      } else if(req.method==='POST' && path==='/api/v0/node/descriptor'){
        // WBC-602: what this City believes about one node's roles, capabilities, resources and availability 鈥?        // read-only and computed at request time, so a node can see the descriptor a future scheduler would read
        // without this route gaining any authority over its own role or resources. A POST is used because the
        // node credential authenticates the node route family; nothing is written.
        const b=await body(req);assertOwnNode(req,b.id);required('nodes',b.id);
        out={descriptor:nodeDescriptors().find(descriptor=>descriptor.nodeId===b.id)??null};
      } else if(req.method==='POST' && path==='/api/v0/node/claim'){
        const b=await body(req);assertOwnNode(req,b.id);
        required('nodes',b.id);
        // WBC-601: the decision moved behind the execution backend port and did NOT change. The guard order is
        // still strict-target first, then the handoff reservation, then the endpoint's own readiness/busy/sharing
        // gate, and the withheld set is still returned as data. The lookup above is kept so that an unknown node
        // id answers the same typed 404 it answered before the seam existed.
        await faults.before('claim',b.id);out=executionBackend().claim({nodeId:b.id});faults.success('claim',b.id);
      } else if(req.method==='POST' && path==='/api/v0/node/report'){
        const b=await body(req);assertOwnNode(req,b.id);
        required('nodes',b.id);
        // AGENT-JOB: the City cannot see whether an agent told the truth, but it CAN check that the report is about the
        // job it actually dispatched and that the claim is internally consistent - and it checks HERE, before the report
        // becomes the task's stored result. Validating only at the read surface would leave an agent's unchecked claim
        // sitting inside the canonical task, and a reader would have to already know to distrust it.
        //
        // The gate is on the TASK's type and on the task reaching a terminal state - so it uses the CANONICAL task
        // vocabulary, not the job's. Getting that wrong is not a detail: this check first read `TERMINAL_JOB_STATES`,
        // whose words are SUCCEEDED/FAILED/EXPIRED, so a report written as `COMPLETED` (the one an agent actually sends
        // when it succeeds) skipped validation entirely and reached the backend unchecked. A test that bound a report to
        // the WRONG job is what caught it.
        //
        // It is also never gated on the shape of what arrived: a report that simply omitted `jobDigest` must not skip
        // the check, while an intermediate RUNNING progress report carries no job report at all and must still be
        // accepted, or the owner would lose sight of work in flight.
        const reportedTask=required('tasks',b.taskId);
        if(reportedTask.type==='AGENT_JOB'&&terminal.includes(b.state)){
          const verdict=validateAgentJobReport(reportedTask.job,b.result);
          if(verdict.valid!==true)refuse(verdict.code,422,`Agent report refused: ${verdict.code}`);
          // The terminal state being written to the canonical task must be the SAME statement as the report's own, and
          // the two vocabularies are translated by one named table rather than by string coincidence.
          const expected=REPORT_STATE_TO_TASK_STATE[verdict.state];
          // An agent may report an OUTCOME. Cancellation is the owner's decision and expiry is the City's, so both are
          // refused by name instead of being believed about a decision the agent does not own.
          if(!AGENT_REPORTABLE_STATES.includes(verdict.state))refuse('REPORT_STATE_NOT_AGENT_DECIDABLE',409,`an agent may not report ${verdict.state}; an agent reports an outcome, not a cancellation or an expiry`);
          if(b.state!==expected)refuse('REPORT_TASK_STATE_MISMATCH',409,`report says ${verdict.state} (= ${expected}) but the task state would be ${String(b.state)}`);
        }
        await faults.before('report',b.id);out=executionBackend().report({taskId:b.taskId,nodeId:b.id,state:b.state,progress:b.progress,lastCheckpoint:b.lastCheckpoint,result:b.result,error:b.error});faults.success('report',b.id);
      }
      // REX-803 - the campaign control surface, DIRECT_CONTROL per the programme's exposure rules: the owner picks a
      // described experiment and a scenario, sets the repetitions, starts, stops, and inspects progress including
      // every run that produced no measurement and the reason it did not. Four operations and nothing else. Like the
      // REX-801 contract above it, this surface executes only canonical City tasks through the product's own creation
      // path; it has no second executor and no way to state an outcome the canonical task did not reach.
      // REX-806: the artifact export surfaces. Owner-only for the same reason the trace and fault surfaces are - an
      // artifact exposes the City's whole research history, and a member session must not read it.
      //
      // The artifact is built from what this City actually holds: its campaign receipts, the canonical tasks those runs
      // produced, the experiment registry and the trace records scoped to those campaigns. Metrics that cannot be
      // derived from those records leave as NOT_MEASURED with their reason; nothing here fills a gap with a zero.
      else if(path==='/api/v0/research/artifacts'||path==='/api/v0/research/artifacts/preview'){
        if(req.citySession)refuse('RESEARCH_OWNER_REQUIRED',403,'Research artifact export requires the City owner');
        const held=[],sourceReadFailures=[];
        const receiptWindow=campaigns.receiptWindow();
        if(receiptWindow.truncated)sourceReadFailures.push({name:'campaign-receipt-window',reason:'RECEIPT_WINDOW_TRUNCATED',total:receiptWindow.total,returned:receiptWindow.receipts.length});
        for(const entry of receiptWindow.receipts){
          if(entry.state==='UNREADABLE'||entry.reason==='RECEIPT_UNREADABLE'){
            sourceReadFailures.push({name:entry.file??entry.campaignId??'<unidentified receipt>',reason:entry.reason??'RECEIPT_UNREADABLE'});
            continue;
          }
          try{
            const receipt=campaigns.receipt(entry.campaignId);
            if(!receipt||receipt.state==='UNREADABLE'||receipt.reason==='RECEIPT_UNREADABLE')sourceReadFailures.push({name:entry.campaignId??entry.file,reason:'RECEIPT_UNREADABLE'});
            else held.push(receipt);
          }
          catch{sourceReadFailures.push({name:entry.campaignId??entry.file??'<unidentified receipt>',reason:'RECEIPT_UNREADABLE'});}
        }
        const live=campaigns.progress();
        if(live?.campaignId&&['COMPLETED','STOPPED','REFUSED','FAILED','INTERRUPTED'].includes(live.state)
          &&!held.some(row=>row.campaignId===live.campaignId)&&!sourceReadFailures.some(row=>String(row.name).startsWith(live.campaignId))){
          sourceReadFailures.push({name:live.campaignId,reason:'LATEST_RECEIPT_MISSING'});
        }
        if(held.length===0)refuse('ARTIFACT_NO_SOURCE',422,'no readable campaign receipt is held by this City');
        const artifact=buildArtifact({
          cityId:store.cityId,
          generatedAt:new Date().toISOString(),
          environment:{cityEndpoint:null,nodeRuntime:process.version,platform:process.platform,surface:'CITY_ROUTE'},
          topology:{nodes:store.list('nodes').map(node=>({id:node.id,online:node.online===true})),controlSurfaces:liveSurfaces().map(surface=>surface.clientRef),members:members().map(member=>member.deviceId).filter(Boolean)},
          receipts:held,
          sourceReadFailures,
          tasks:store.list('tasks'),
          experiments:experiments.list().experiments,
          traceRecords:researchTrace.snapshot().records,
        });
        if(path==='/api/v0/research/artifacts/preview'){
          // Bounded on purpose: a preview that returned everything would be the export wearing a smaller name.
          const limit=Math.max(1,Math.min(Number(new URL(req.url,'http://city').searchParams.get('limit')??10)||10,100));
          out={preview:{manifest:artifact.manifest,metricAvailability:artifact.metrics.map(row=>({metric:row.metric,scope:row.scope,available:row.value!==NOT_MEASURED})),exclusions:artifact.exclusions,rows:artifact.dataset.slice(0,limit),rowsShown:Math.min(limit,artifact.dataset.length),rowsTotal:artifact.dataset.length}};
        } else if(new URL(req.url,'http://city').searchParams.get('format')==='csv'){
          const files=artifactFiles(artifact);
          out={metricsCsv:files['metrics.csv'],checksums:checksumsFor(files),sourceCoverage:artifact.manifest.sourceCoverage??{status:'NO_KNOWN_SOURCE_LOSS'}};
        } else {
          const files=artifactFiles(artifact);
          out={artifact,checksums:checksumsFor(files)};
        }
      }
      else if(path==='/api/v0/research/replays'&&req.method==='GET'){
        out={mechanisms:replays.mechanisms(),supportedScenarios:['WAIT'],sources:campaigns.receipts(),receiptWindow:campaigns.receiptWindow(),research:researchFacts()};
      } else if(path==='/api/v0/research/replays'&&req.method==='POST'){
        const b=await body(req);
        const started=replays.start(b);
        emit('RESEARCH_CAMPAIGN_STARTED',null,{campaignId:started.campaignId,experimentId:started.experimentId,scenarioId:campaigns.progress().scenarioId,repetitions:1,resumed:false},'user');
        out={started,progress:campaigns.progress(),research:researchFacts()};
      } else if(req.method==='GET'&&/^\/api\/v0\/research\/replays\/[^/]+$/.test(path)){
        out={comparison:replays.compare(decodeURIComponent(path.split('/').at(-1))),research:researchFacts()};
      } else if(path==='/api/v0/research/campaigns'&&req.method==='GET'){
        // `topology` publishes the identities this City can actually offer RIGHT NOW, because a manifest has to
        // declare them and the only honest place to read them is the City. Without it an owner writing a manifest
        // guesses at the control-surface ref of their own browser (this surface's first browser test did exactly
        // that and was refused), and a guessed identity produces a campaign that can never start.
        // `receiptWindow` states how much history stands behind the bounded list, so a reader can tell "three campaigns"
        // from "three of four hundred". `receipts` is kept as the array form for callers that only want the rows.
        out={scenarios:campaigns.scenarios(),topology:{workers:campaignWorkers(),surfaces:liveSurfaces().map(surface=>({ref:surface.clientRef,label:surface.clientLabel})).filter(surface=>surface.ref)},live:campaigns.progress(),unfinished:campaigns.unfinished()!==null,receipts:campaigns.receipts(),receiptWindow:campaigns.receiptWindow(),storeState:campaigns.storeState(),storeReason:campaigns.storeReason(),experiments:experiments.list({status:'VALIDATED'}).experiments,research:researchFacts()};
      } else if(path==='/api/v0/research/campaigns'&&req.method==='POST'){
        const b=await body(req);
        // The experiment must exist and be VALIDATED: an experiment that was rejected has no seed sequence and no
        // declared topology, so running it would be running a description nobody accepted. `experiments.get` answers a
        // typed 404 for an unknown id, and a rejected record is refused here rather than turned into a campaign.
        const described=experiments.get(b.experimentId);
        if(described.status!=='VALIDATED')throw new ExperimentManifestError('NOT_REGISTERED',`experiment ${String(b.experimentId)} was rejected and cannot be run`,described.issues??[]);
        const manifest=described.manifest;
        const scenarioId=String(b.scenarioId??'');
        if(!campaignScenarios.some(scenario=>scenario.id===scenarioId))refuse('SCENARIO_UNKNOWN',422);
        // No default is invented: the manifest's own repetition count is the experiment's, and a campaign may only ask
        // for FEWER repetitions than the experiment described. Asking for more is refused by name, because the
        // manifest's declared count and its MAX_REPETITIONS stop condition are the description the result is judged by.
        const repetitions=b.repetitions===undefined||b.repetitions===null?manifest.repetitions:b.repetitions;
        if(!Number.isSafeInteger(repetitions)||repetitions<1)refuse('REPETITIONS_INVALID',422);
        if(repetitions>manifest.repetitions)refuse('REPETITIONS_EXCEED_DECLARED',422);
        if(b.targetDeviceRef!==undefined&&b.targetDeviceRef!==null&&!manifest.workers.includes(b.targetDeviceRef))refuse('INVALID_CAMPAIGN_TARGET',422);
        if(b.limits!==undefined&&b.limits!==null&&(typeof b.limits!=='object'||Array.isArray(b.limits)))refuse('LIMITS_INVALID',422);
        // The campaign seed is the experiment's IMMUTABLE IDENTITY unless the operator names one, so two runs of the
        // same registered manifest on two hosts derive the same seed sequence without anyone passing a number around.
        const seed=typeof b.seed==='string'&&b.seed.trim().length>0?b.seed.trim().slice(0,120):`${described.experimentId}@${experimentIdentity(described)}`;
        const started=campaigns.start({
          scenarioId,
          repetitions,
          warmup:b.warmup===undefined||b.warmup===null?0:b.warmup,
          resume:b.resume===true,
          abandon:b.abandon===true,
          seed,
          seedIndexOffset:b.resume===true?(b.seedIndexOffset??0):0,
          timeout:b.timeoutMs===undefined||b.timeoutMs===null?undefined:b.timeoutMs,
          limits:campaignLimits(manifest,b.limits??null),
          context:campaignContext(described,b.targetDeviceRef??null),
        });
        emit('RESEARCH_CAMPAIGN_STARTED',null,{campaignId:started.campaignId,experimentId:described.experimentId,scenarioId,repetitions,resumed:Boolean(started.resumed)},'user');
        out={started,progress:campaigns.progress(),research:researchFacts()};
      } else if(path==='/api/v0/research/campaigns/stop'&&req.method==='POST'){
        const b=await body(req);
        const live=campaigns.progress();
        // A stale surface must not be able to stop a campaign it is not looking at. The guard applies while a campaign
        // is actually RUNNING: stopping an already-finished campaign is a plain no-op that answers `stopped: false`,
        // not a conflict, or a UI left open on a finished campaign could never be told the truth.
        if(live.state==='RUNNING'&&typeof b.campaignId==='string'&&b.campaignId.length>0&&b.campaignId!==live.campaignId)refuse('CAMPAIGN_MISMATCH',409);
        const stop=campaigns.stop({reason:typeof b.reason==='string'&&b.reason.trim().length>0?b.reason.trim().slice(0,200):'stopped by the City owner'});
        emit('RESEARCH_CAMPAIGN_STOP_REQUESTED',null,{campaignId:live.campaignId,stopped:stop.stopped},'user');
        out={stop,progress:campaigns.progress(),research:researchFacts()};
      } else if(req.method==='GET'&&/^\/api\/v0\/research\/campaigns\/[^/]+$/.test(path)){
        out={campaign:campaigns.receipt(decodeURIComponent(path.split('/').at(-1))),research:researchFacts()};
      }
      // REX-801 鈥?the Research control contract. Four stable operations, all authenticated with the control
      // credential: list, inspect, create-or-import (validate then register), and validate-before-run. There is
      // deliberately NO run/stop here: this contract describes experiments, and executing them belongs to
      // REX-803. A caller that expects a run endpoint will get a typed 404 rather than a surprise.
      //
      // Note the shape of the refusals: a malformed manifest is NEVER repaired into a valid one. Registration
      // answers with the full issue list (409 when the id is already taken by different content, 422 when the
      // manifest is invalid), so the caller can see exactly why, and the rejection is persisted as evidence by
      // the registry itself.
      else if(path==='/api/v0/research/faults'&&req.method==='GET')out=faults.list();
      else if(path==='/api/v0/research/faults'&&req.method==='POST')out={fault:faults.start(await body(req))};
      else if(req.method==='GET'&&/^\/api\/v0\/research\/faults\/[^/]+$/.test(path))out={fault:faults.get(decodeURIComponent(path.split('/').at(-1)))};
      else if(req.method==='POST'&&/^\/api\/v0\/research\/faults\/[^/]+\/stop$/.test(path))out={fault:faults.stop(decodeURIComponent(path.split('/').at(-2)))};
      else if(path==='/api/v0/research/experiments'&&req.method==='GET'){
        const query=new URL(req.url,'http://city').searchParams.get('status');
        out={...experiments.list({status:query&&query.length>0?query:null}),research:researchFacts()};
      } else if(path==='/api/v0/research/experiments'&&req.method==='POST'){
        const b=await body(req,65536);
        const result=experiments.register(b.manifest??b);
        // A refused manifest is PERSISTED as evidence by the registry and then answered as a typed refusal with
        // the whole issue list: 422 for "you sent an invalid description", 409 for "that id is already taken by
        // different content" (which is thrown by the registry itself).
        if(result.record.status==='REJECTED'){
          emit('RESEARCH_EXPERIMENT_REJECTED',null,{experimentId:result.record.experimentId,issueCount:result.record.issues.length},'user');
          throw new ExperimentManifestError('REJECTED',`${result.record.issues.length} issue(s) in the submitted manifest`,result.record.issues);
        }
        if(!result.replayed)emit('RESEARCH_EXPERIMENT_REGISTERED',null,{experimentId:result.record.experimentId,topology:result.record.manifest.topology,repetitions:result.record.manifest.repetitions},'user');
        // A manifest that was validated but could not be FILED says so: the refusal reason travels with the response
        // instead of being dropped between the registry and the caller (found by this repair's own guard).
        out={registered:true,replayed:result.replayed,persisted:result.persisted,...(result.persistFailure?{persistFailure:result.persistFailure}:{}),...result.record,research:researchFacts()};
      } else if(req.method==='POST'&&path==='/api/v0/research/experiments/validate'){
        const b=await body(req,65536);
        const verdict=experiments.validate(b.manifest??b);
        emit('RESEARCH_EXPERIMENT_VALIDATED',null,{experimentId:verdict.experimentId,ok:verdict.ok,issueCount:verdict.issues.length},'user');
        out={validation:verdict,research:researchFacts()};
      } else if(req.method==='GET'&&/^\/api\/v0\/research\/experiments\/[^/]+\/seeds$/.test(path)){
        const id=decodeURIComponent(path.split('/').at(-2));
        const requested=new URL(req.url,'http://city').searchParams.get('repetitions');
        const repetitions=requested===null||requested===''?null:Number(requested);
        if(repetitions!==null&&(!Number.isSafeInteger(repetitions)||repetitions<1))refuse('INVALID_FIELD',400,'repetitions must be a positive integer when given');
        out={seeds:experiments.seeds(id,{repetitions}),research:researchFacts()};
      } else if(req.method==='GET'&&/^\/api\/v0\/research\/experiments\/[^/]+$/.test(path)){
        const id=decodeURIComponent(path.split('/').at(-1));
        out={experiment:experiments.get(id),research:researchFacts()};
      } else if(req.method==='POST'&&/^\/api\/v0\/research\/experiments\/[^/]+\/register$/.test(path)){
        // Import-by-id is not offered: an import must carry the manifest itself, so nothing is fetched from an
        // address the City did not choose. Stated as a typed refusal rather than a 404 so the reason is readable.
        refuse('IMPORT_REQUIRES_INLINE_MANIFEST',400);
      } else fail(404,'Not found');
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(envelope(out)));
    }catch(e){
      // JOIN-503: an enrollment refusal is a typed fact (which installation, which ladder rung), so its code
      // travels with the response instead of being flattened into prose. No secret is ever part of either shape.
      if(e instanceof EnrollmentError){res.writeHead(e.status||403,{'Content-Type':'application/json'});res.end(JSON.stringify(envelope({error:e.code,errorCode:e.code,detail:e.detail})));return;}
      // A refusal from the identity lifecycle itself (RF-001's rules) carries the same kind of typed code. The
      // refused facts are all client errors: a missing rebind proof, a clone, an already-bound installation.
      if(e instanceof DeviceIdentityError){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify(envelope({error:e.code,errorCode:e.code,detail:e.detail})));return;}
      // REX-801: a refused experiment manifest is a typed fact with its whole issue list, so a caller can see
      // every reason at once instead of fixing one field per round trip. The rejection is also persisted by the
      // registry, so this response is a view of stored evidence rather than the only copy of it.
      if(e instanceof ExperimentManifestError){res.writeHead(e.status||400,{'Content-Type':'application/json'});res.end(JSON.stringify(envelope({error:e.code,errorCode:e.code,detail:e.detail,issues:e.issues})));return;}
      // REX-803: a refused campaign is a typed fact too (which scenario, which repetitions, which topology was
      // missing), so the refusal travels with its code instead of being flattened into a 500.
      if(e instanceof ScenarioRunnerError){res.writeHead(e.status||400,{'Content-Type':'application/json'});res.end(JSON.stringify(envelope({error:e.code,errorCode:e.code,detail:e.detail})));return;}
      if(e instanceof ReplayError){res.writeHead(e.status,{'Content-Type':'application/json'});res.end(JSON.stringify(envelope({error:e.code,errorCode:e.code,detail:e.message})));return;}
      res.writeHead(e.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify(envelope({error:e.status?e.message:'Gateway error',...(e.code?{errorCode:e.code}:{})})));if(!e.status)console.error(e);}
  });
  // A relay peer is WRITTEN TO by the City (that is the whole point: the City pushes an answer it received down the
  // pipe), so the hub is handed a send function rather than the socket. A pipe whose far end has gone throws here
  // and `relay.forward` turns that into a typed failure for whoever was waiting, instead of a silent no-op.
  const relaySendFor=ws=>frame=>{if(ws.readyState!==1)throw new Error('relay peer is not connected');ws.send(JSON.stringify(frame));};
  server.on('upgrade',(req,socket,head)=>{
    try {
      const u=new URL(req.url,'http://city');
      // S1: the relay pipe. Reached WITHOUT an owner credential by design (the peer that most needs it is the one
      // that has not joined yet); what it may carry is bounded by the payload list, not by this route's auth, and
      // the `admit` policy above is the single place the credential question is settled.
      if(u.pathname==='/api/v0/relay'){
        if(u.searchParams.get('apiVersion')!=='0'||u.searchParams.get('schemaVersion')!=='0')fail(409,'Protocol mismatch');
        // A browser cannot set an Authorization header on a WebSocket, so the credential travels in a subprotocol -
        // the same choice the events stream makes. It arrives base64url-encoded (a subprotocol token cannot contain
        // arbitrary characters) and is decoded HERE, because the admission policy must compare the real credential
        // and not its encoding. The first version compared the encoded form against the raw token, which refused
        // every legitimate dial while the hand-rolled peers in its tests (which sent the token unencoded) passed.
        const presentedToken=String(req.headers['sec-websocket-protocol']??'').split(',').map(p=>p.trim()).find(p=>p.startsWith('city-token.'));
        let presented='';
        if(presentedToken)try{presented=Buffer.from(presentedToken.slice(11),'base64url').toString('utf8');}catch{presented='';}
        const raw=(req.headers.authorization?String(req.headers.authorization).replace(/^Bearer\s+/i,''):presented);
        const verdict=relayAdmit({credential:raw,installationId:u.searchParams.get('installationId')??'',label:u.searchParams.get('label')??''});
        if(verdict.accepted!==true)fail(403,verdict.reason??'the City did not admit this relay peer');
        wss.handleUpgrade(req,socket,head,ws=>{
          let entry=null;
          try {
            entry=relay.register({peerRef:verdict.peerRef,label:verdict.label??null,send:relaySendFor(ws),close:()=>{try{ws.close();}catch{/* already gone */}}});
          } catch(error) {
            try{ws.close(1011,'relay registration refused');}catch{/* nothing to close */}
            console.error('relay registration failed',error);
            return;
          }
          const peerRef=verdict.peerRef;
          // Where this peer's own City lives, if it said. Used as the execution address for a pushed payload.
          const declaredOrigin=String(u.searchParams.get('clientUrl')??'').trim().replace(/\/+$/,'');
          if(/^https?:\/\/[^\s]+$/i.test(declaredOrigin))relayOrigins.set(peerRef,declaredOrigin);
          emit('RELAY_PEER_CONNECTED',null,{peerRef,role:verdict.role??'unknown',verified:verdict.verified===true,label:verdict.label??null},'city');
          // The ready frame carries the ref the CITY decided, so a peer whose ref was taken from its session can see
          // that (and cannot believe it chose its own identity).
          try{ws.send(JSON.stringify(envelope({type:'RELAY_READY',peerRef,role:verdict.role??'unknown',verified:verdict.verified===true,payloads:RELAY_PAYLOAD_PATHS})));}catch{/* the peer vanished between upgrade and hello */}
          ws.on('error',()=>{});
          ws.on('message',data=>relayOnMessage(peerRef,data?.toString?.()??String(data)));
          ws.on('close',()=>{relayOrigins.delete(peerRef);try{if(relay.unregister(peerRef))emit('RELAY_PEER_DISCONNECTED',null,{peerRef,connectedAt:entry.connectedAt},'city');}catch{/* already unregistered */}});
        });
        return;
      }
      if(u.pathname!=='/api/v0/events/stream')fail(404,'Not found');
      // Browser WebSocket cannot set Authorization; token travels in a subprotocol, never a URL.
      const protocols=String(req.headers['sec-websocket-protocol']||'').split(',').map(s=>s.trim());
      if(!req.headers.authorization){const p=protocols.find(p=>p.startsWith('city-token.'));req.headers.authorization='Bearer '+(p?Buffer.from(p.slice(11),'base64url').toString():'');}
      auth(req);if(u.searchParams.get('apiVersion')!=='0'||u.searchParams.get('schemaVersion')!=='0')fail(409,'Protocol mismatch');
      const identity=req.citySession?{clientRef:memberRef(req),clientLabel:enrollment.describe(req.citySession.session.installationId)?.displayName}:readClientIdentity(u.searchParams);
      wss.handleUpgrade(req,socket,head,ws=>{
        const key=refKey(identity.clientRef);
        const liveBefore=surfaceCounts.get(key)??0;
        controlSurfaces.set(ws,{...identity,connectedAt:now()});
        surfaceCounts.set(key,liveBefore+1);
        if(liveBefore===0){surfaceLabels.set(key,identity.clientLabel);emit('CLIENT_CONNECTED',null,{clientRef:identity.clientRef,clientLabel:identity.clientLabel});}
        ws.send(JSON.stringify(envelope({type:'REFRESH'})));
        ws.on('error',()=>{});
        ws.on('close',()=>{
          const gone=controlSurfaces.get(ws);controlSurfaces.delete(ws);
          if(!gone)return;
          const k=refKey(gone.clientRef);
          const liveAfter=Math.max(0,(surfaceCounts.get(k)??1)-1);
          if(liveAfter>0){surfaceCounts.set(k,liveAfter);return;}   // another socket still holds this ref: the client has NOT left
          surfaceCounts.delete(k);
          const label=surfaceLabels.get(k)??gone.clientLabel;surfaceLabels.delete(k);
          if(!closed)emit('CLIENT_DISCONNECTED',null,{clientRef:gone.clientRef,clientLabel:label??null});
        });
      });
    }catch(e){socket.write('HTTP/1.1 '+(e.status||400)+' Rejected\r\nConnection: close\r\n\r\n');socket.destroy();}
  });
  const timer=setInterval(()=>{
    for(const n of store.list('nodes'))if(n.online&&Date.now()-Date.parse(n.lastHeartbeatAt)>heartbeatTimeout){store.put('nodes',{...n,online:false});emit('NODE_OFFLINE',null,{nodeId:n.id});faults.observeOffline(n.id);}
    // UXI-391 REPAIR A/B: honour a decline that had nowhere to go, and release a reservation whose device died.
    try{honourDeclinedHandoffs();}catch(e){console.error('handoff sweep failed',e);}
  },1000);
  const closeGateway=async()=>{if(closed)return;closed=true;await gatewayFabric?.close();await campaigns.close({reason:'CITY_SHUTDOWN'});faults.close();observation.disconnect();bridge.close();join.close();relay.close();clearInterval(timer);await discovery?.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>{server.close(r);server.closeAllConnections();});store.close();await researchTrace.close(100);};
  try{if(gatewayFabric)await gatewayFabric.service.start();}catch(error){await closeGateway();throw error;}
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});}catch(error){await closeGateway();throw error;}
  // `pairing` was published on the LAN before the OS chose the port (port 0 in tests), so the join
  // capability endpoint and the discovery record both have to be re-read from the live endpoint after
  // listen. JOIN-502 only reads `pairing.descriptor()` at request time, so there is nothing to re-publish
  // here - recorded so the next reader does not mistake the assignment below for a join fix.
  pairing.endpoint=`http://${host}:${server.address().port}`;
  if(discoveryEnabled)discovery=await startDiscovery({descriptor:pairing.descriptor(),onStatus:s=>{discoveryState=s;}});
  // UNION (JOIN-590 closeout integration): this single return must expose EVERY capability the integrated branches
  // promised, and its teardown must release every side's resources. Enumerated rather than concatenated on purpose -
  // the first mechanical attempt left two returns here and silently hid `researchTrace` behind the earlier one.
  return {url:pairing.endpoint,store,pcf:gatewayFabric?.service??null,join,relay,researchTrace,campaigns,faults,executionProfile,executionBackends,executionBackend,quiesce:value=>{acceptingTasks=!value;},close:closeGateway};
}
