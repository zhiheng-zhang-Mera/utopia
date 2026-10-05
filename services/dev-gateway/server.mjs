import http from 'node:http';
import {resolve} from 'node:path';
import {hostname,networkInterfaces} from 'node:os';
import {createBridge} from '../capability-bridge/bridge.mjs';
import {MAX_REQUEST_BYTES,refuse} from '../../contracts/capability-bridge-v1/protocol.mjs';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes as randomBytesBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Store } from './store.mjs';
import { Pairing } from './pairing.mjs';
// JOIN-503: device enrollment and tokenless routine reconnect. The registrar is a seam over the City's own
// RF-001 identity lifecycle (see services/dev-gateway/enrollment.mjs) - it mints installation credentials, issues
// short-lived SESSION credentials for the browser, and answers "may this installation act?".
import { createEnrollmentRegistrar, EnrollmentError, DEFAULT_SESSION_TTL_MS } from './enrollment.mjs';
import {memberSnapshot} from './members.mjs';
// The identity lifecycle's own error type. A refusal from RF-001's rules (`rebind_proof_required`, `clone_detected`,
// `already_bound`, …) is a typed client error, not a gateway fault, so it must not surface as a 500.
import { DeviceIdentityError } from '../../city/00-foundation/02-city-node-network/device-identity/index.mjs';
import { validateTelemetry } from '../../contracts/pairing-v1/descriptor.mjs';
import { startDiscovery } from './discovery.mjs';
// JOIN-502: the approval seam for a nearby PC. It records an ASK and releases the existing City
// credential only after an already trusted device approves - it is not a second trust store, and
// discovery grants nothing on its own.
import { createJoinRequests, shortRef } from './join.mjs';
// S1: the OUTBOUND-DIAL relay, now wired to a real WebSocket. `relay.mjs` decides who may register, what may
// travel (a named list of existing payloads), and how a forwarded answer comes back; the gateway below is what
// gives it a socket, and nothing here re-implements any of those three decisions.
import { createRelayHub, createRelayDispatcher, RELAY_PAYLOAD_PATHS } from './relay.mjs';
import { browseNearby, browseBluetooth, joinCapability, hostCarrierFacts } from './nearby.mjs';
// `node:os` is imported for ONE purpose: publishing what this host can honestly say about itself as a City carrier
// (cores and memory), so a REMOTE surface can weigh this machine against its own and against other PCs it can see.
// Nothing here reads identity or user data.
import { cpus as osCpus, freemem as osFreemem, totalmem as osTotalmem } from 'node:os';
import { envelope, terminal, validateCommand } from '../../contracts/city-control-v0/protocol.mjs';
// Product closeout (T1–T3): the Room Pack, the canonical Action facade and the
// deterministic Ask / Do router. The Room Hub is reached over loopback only; nothing here
// exposes its port, and no route in this phase can reach Boss or Hns.
import { createRoomPack } from './rooms.mjs';
import { createActions } from './actions.mjs';
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
// City Core (MB-006). Whether work interrupted by a restart may resume is decided by the
// migrated checkpoint-gate module instead of an inline state test.
import { checkpointGate, unboundCheckpointPort } from '../../city/02-engineering/04-restart-recovery-station/checkpoint-gate/index.mjs';

const now=()=>new Date().toISOString();
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const equals=(a,b)=>Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
// Utopia's placement policy, unchanged: a node must be online and expose both of these.
// Exported so the consumption test asserts against the gateway's real policy instead of
// restating it (a restated copy could be wrong in the same way the policy is wrong).
export const REQUIRED_TASK_CAPABILITIES=['task.execute.safe','filesystem.temp'];
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
export async function createGateway({host='127.0.0.1',port=4310,dir='.runtime',token,nodeToken,heartbeatTimeout=8000,pairingClock=Date.now,pairingTtlMs=300000,discoveryEnabled=false,nearbyTimeoutMs=2000,roomHubUrl=process.env.CITY_ROOMS_URL,roomsDisabled=process.env.CITY_ROOMS_DISABLED==='1',hostId=process.env.CITY_HOST_ID,roomFetch,deviceClock=Date.now,hostDeviceId:requestedHostDeviceId,hostJoin=null}) {
  if(!token||!nodeToken||token===nodeToken) throw new Error('Separate control and node tokens are required');
  if(host==='0.0.0.0'||host==='::') throw new Error('Configure an explicit loopback or LAN interface');
  const store=new Store(dir); const wss=new WebSocketServer({noServer:true}); let closed=false;
  // MESH-301: WHICH control surfaces are attached to this City, and what each of them calls itself.
  //
  // The identity is declared on the event-stream handshake and travels in the CLIENT_CONNECTED /
  // CLIENT_DISCONNECTED payloads, so "the Android client is here, as PERM00" becomes a canonical fact with
  // its own `seq` that every surface can converge on - rather than something each surface infers privately
  // from the state of its own socket. A surface that declares nothing is still recorded, with nulls: an
  // anonymous client is a fact too, and omitting the event would make it invisible to the other surfaces.
  const hostDeviceId=requestedHostDeviceId||'dev-'+store.cityId.replaceAll('-','');
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
      const found=transport==='ble'?await browseBluetooth():await browseNearby({interface:host,timeoutMs:nearbyTimeoutMs});
      return {nearby:found.candidates.map(c=>({cityRef:c.cityId??c.cityRef,displayName:c.displayName,address:c.address,port:c.port,transport:c.transport,lastSeenAt:c.lastSeenAt,stale:c.stale,grantsTrust:false,carrierFacts:c.carrierFacts??null})),bounded:found.bounded===true,discovered:found.discovered??0,unavailable:found.unavailable===true,reason:found.reason??(found.unavailable?'MDNS_UNAVAILABLE':null)};
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
  const emit=(type,id,payload,actor)=>{const e=store.event(type,id,payload,actor); for(const c of wss.clients) if(c.readyState===1)c.send(JSON.stringify(envelope({event:e})));return e;};
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
  const change=(task,state,patch={},event='TASK_'+state)=>store.atomic(()=>{Object.assign(task,patch,{state,updatedAt:now()});store.put('tasks',task);emit(event,task.id,{state,progress:task.progress,...patch},task.assignedNodeId||'gateway');return task;});
  // City Core (MB-006). Whether work interrupted by a restart may resume is decided by the
  // migrated checkpoint-gate module, not by an inline state test. Utopia's policy travels as
  // data: a task that was still QUEUED never started, so no checkpoint is required and the
  // gate authorizes it (it stays queued); a task that had started would lose work, and
  // Utopia binds no checkpoint port, so the donor's fail-closed default refuses it — the
  // same outcome, error text and event the inline sweep produced. timeoutMs is 0 because the
  // unbound port answers synchronously and a timeout budget would be meaningless.
  const resumeGate=checkpointGate({port:unboundCheckpointPort(),timeoutMs:0});
  for(const t of store.list('tasks')){
    if(terminal.includes(t.state))continue;
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
  // Product closeout (T1–T3). The Room Hub is reached over loopback only, and the Action
  // facade is the single user-facing record over Rooms, capabilities and City tasks.
  const rooms=createRoomPack({baseUrl:roomHubUrl,disabled:roomsDisabled,fetchImpl:roomFetch});
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
  const targetVerdict=targetDeviceRef=>classifyTarget({targetDeviceRef,nodes:store.list('nodes'),claimNodeFor,acceptsWork,requiredCapabilities:REQUIRED_TASK_CAPABILITIES});
  let acceptingTasks=true;
  const createCityTask=(type,options={})=>{
    if(!acceptingTasks)fail(503,'This host is changing City role; no new local work accepted');
    // Parsed before the transaction: a malformed field is a client error, not a half-written task.
    const intent=readTargetIntent(options.targetDeviceRef);
    if(intent.ok===false)refuse(intent.code,422,intent.message);
    if(intent.present){
      // KNOWN is a creation-time gate because the workbook requires the target to reference a City node
      // identity. OFFLINE and INELIGIBLE are NOT refusals: the task is created and WAITS, because a user may
      // legitimately queue work for a device that is currently away, and pretending otherwise would be the
      // silent rerouting this task forbids. The distinction is persisted, not merely decided.
      const verdict=targetVerdict(intent.value);
      if(verdict.state==='UNKNOWN')refuse(TARGET_REASONS.UNKNOWN,422,`no City node identity "${intent.value}" is known to this City`);
      return store.atomic(()=>{
        const t={id:'Q-'+randomUUID(),type,domain:'system',state:'QUEUED',createdAt:now(),updatedAt:now(),assignedNodeId:null,progress:0,lastCheckpoint:null,result:null,error:null,
          [STRICT_TARGET_FIELD]:intent.value,targetIntentAt:now(),targetStateAtCreation:verdict.state};
        store.put('tasks',t);emit('COMMAND_ACCEPTED',t.id);emit('TASK_CREATED',t.id);
        if(verdict.state!=='ELIGIBLE')emit('TASK_TARGET_WAITING',t.id,{targetDeviceRef:intent.value,targetState:verdict.state,reason:verdict.reason},'user');
        return t;
      });
    }
    return store.atomic(()=>{const t={id:'Q-'+randomUUID(),type,domain:'system',state:'QUEUED',createdAt:now(),updatedAt:now(),assignedNodeId:null,progress:0,lastCheckpoint:null,result:null,error:null};store.put('tasks',t);emit('COMMAND_ACCEPTED',t.id);emit('TASK_CREATED',t.id);return t;});
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
  // INTEGRATION (JOIN-502 + JOIN-503): ONE snapshot carries both additions. The earlier de-duplication regex in
  // this branch's resolver matched the UNION line instead of JOIN-502's stale one (both begin with the same text
  // and the union ends with `joinRequests:join.snapshot()`), so it removed `joinRequests` and every JOIN-502 test
  // failed on the listing being undefined. Restored here, with `enrolledDevice` kept from JOIN-503.
  const isLocalRequest=req=>{const address=req?.socket?.remoteAddress?.replace(/^::ffff:/,'');return address==='127.0.0.1'||address==='::1'||Object.values(networkInterfaces()).flat().some(n=>n?.address===address);};
  const members=()=>memberSnapshot({store,installations:enrollment.list(),surfaces:liveSurfaces(),hostDeviceId});
  const memberRef=req=>req.citySession?req.citySession.installation.deviceId:hostDeviceId;
  const snapshot=(req)=>envelope({hostDeviceId,currentMemberRef:req?.citySession?memberRef(req):isLocalRequest(req)?hostDeviceId:null,members:members(),hostJoinAvailable:Boolean(hostJoin)&&!req?.citySession&&isLocalRequest(req),status:'ONLINE',updatedAt:now(),cityId:store.cityId,displayName:store.cityName,descriptor:pairing.descriptor(),discovery:discoveryState,nodes:store.list('nodes'),controlSurfaces:liveSurfaces(),tasks:store.list('tasks'),events:store.events(),capabilities:bridge.registry(),invocations:bridge.list(),joinRequests:join.snapshot(),
    // JOIN-503: the surface that is asking is told which INSTALLATION it is. A control-token client gets null
    // (it is the owner, not an enrolled installation), which is exactly what the Settings page needs in order to
    // show an enrollment summary for an enrolled client and the engineering fallback for a control-token one.
    enrolledDevice:req?.citySession?enrollment.describe(req.citySession.session.installationId):null});
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
        const components={gateway:{state:'READY'},rooms:{state:roomState.available?'READY':'UNAVAILABLE',reason:roomState.available?null:roomState.reason,hubUrl:roomState.hubUrl}};
        const degraded=Object.values(components).some(c=>c.state!=='READY');
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
      if(!publicJoin&&!legacyPublicPairing&&!selfAuthenticating)auth(req,nodeRoute&&path!=='/api/v0/node/sharing');
      if(!legacyPublicPairing)version(req);
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
      else if(req.method==='POST' && path==='/api/v0/pairing/session'){
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
          out={...exchanged,apiVersion:0,schemaVersion:0,enrollment:{
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
      else if(req.method==='POST' && path==='/api/v0/node/sharing'){
        const b=await body(req);if(memberRef(req)!==b.id)fail(403,'Only this device may change its resource sharing');if(typeof b.enabled!=='boolean')fail(400,'Sharing requires enabled boolean');const n=required('nodes',b.id);out=store.put('nodes',{...n,sharingEnabled:b.enabled});emit('NODE_SHARING_CHANGED',null,{nodeId:b.id,enabled:b.enabled});
      }
      else if(req.method==='POST' && path==='/api/v0/members/messages'){
        const b=await body(req);const sender=memberRef(req);const target=members().find(m=>m.deviceId===b.targetDeviceId);if(!target)fail(404,'Target is not a member of this City');
        if(typeof b.text!=='string'||!b.text.trim()||b.text.length>4096)fail(400,'Message must contain 1–4096 characters');
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
      // --- Pre-assistant product closeout (T1–T3) --------------------------------
      // Rooms: truthful availability plus the catalog, through the authenticated path.
      else if(req.method==='GET' && path==='/api/v0/rooms')out={rooms:await rooms.probe()};
      // Canonical Action facade. Repeating an idempotency key replays, never re-executes.
      else if(req.method==='GET' && path==='/api/v0/actions')out={actions:actions.list(new URL(req.url,'http://city').searchParams.get('limit')??undefined)};
      else if(req.method==='GET' && /^\/api\/v0\/actions\/[^/]+$/.test(path))out={action:actions.get(decodeURIComponent(path.split('/').at(-1)))||refuse('ACTION_NOT_FOUND',404)};
      else if(req.method==='POST' && path==='/api/v0/actions')out=await actions.create(await body(req));
      // Deterministic Ask / Do. There is no model in this path and no BOSS/HNS route.
      else if(req.method==='GET' && path==='/api/v0/ask/targets')out={targets:await askTargets()};
      else if(req.method==='POST' && path==='/api/v0/ask')out={ask:await handleAsk(await body(req),{actions,targets:await askTargets(),roomState:await rooms.probe()})};
      else if(req.method==='POST' && path==='/api/v0/host/join'){
        if(req.citySession||!hostJoin||!isLocalRequest(req))fail(403,'Only the local host owner may change its role');out=await hostJoin.start(await body(req));
      }
      else if(req.method==='GET' && path==='/api/v0/host/join/status'){
        if(req.citySession||!hostJoin)fail(403,'Only the local host owner may read the join ticket');out=await hostJoin.status(new URL(req.url,'http://city').searchParams.get('ticketId'));
      }
      else if(req.method==='GET' && path==='/api/v0/nodes')out={nodes:store.list('nodes')};
      else if(req.method==='GET' && path==='/api/v0/tasks')out={tasks:store.list('tasks')};
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
        const prior=store.get('nodes',b.id);
        for(const t of store.list('tasks'))if(t.assignedNodeId===b.id&&!terminal.includes(t.state))change(t,'FAILED',{error:'Node re-registered; interrupted work is not replayed.'});
        out=store.put('nodes',{id:b.id,devicePrincipalId:b.id,displayName:b.displayName.slice(0,100),metadata:{platform:String(b.metadata?.platform||'unknown')},agentVersion:typeof b.agentVersion==='string'?b.agentVersion.slice(0,30):'0.1.0',...telemetry(b),sharingEnabled:prior?.sharingEnabled??true,capabilities:b.capabilities,online:true,lastHeartbeatAt:now()});
        if(!prior?.online){
          emit('NODE_ONLINE',null,{nodeId:b.id});
          // MESH-301: a strict task that was waiting for this device becomes claimable the moment the device
          // returns. Emitted so offline/reconnect convergence is visible in the canonical event stream instead
          // of having to be inferred from whatever claim happens to come next.
          for(const t of store.list('tasks'))if(isWaitingForTarget(t,terminal)&&t[STRICT_TARGET_FIELD]===b.id)emit('TASK_TARGET_READY',t.id,{targetDeviceRef:b.id},'gateway');
        }
      } else if(req.method==='POST' && path==='/api/v0/node/heartbeat'){
        const b=await body(req);assertOwnNode(req,b.id);const n=required('nodes',b.id);const metrics=telemetry(b);if(!n.online)emit('NODE_ONLINE',null,{nodeId:n.id});out=store.put('nodes',{...n,...metrics,online:true,lastHeartbeatAt:now()});
      } else if(req.method==='POST' && path==='/api/v0/node/claim'){
        const b=await body(req);assertOwnNode(req,b.id);const n=required('nodes',b.id);
        const ready=acceptsWork(claimNodeFor(n),{requiredCapabilities:REQUIRED_TASK_CAPABILITIES});
        const busy=store.list('tasks').some(t=>t.assignedNodeId===n.id&&!terminal.includes(t.state));
        // UXI-391: a QUEUED task may be handed out only to a device the handoff bridge allows. A task that
        // was transferred to B stays RESERVED for B, and a device the guard shows as its current holder is the
        // only one that may take it - so a recovered A cannot re-claim work that has already moved to B.
        //
        // MESH-301: a strict target is a STRONGER guard than a reservation, and it is applied first. The
        // reservation is the City's own post-hoc repair and may be released when the reserved device dies; the
        // user's target may never be released, so a strict task whose device is away stays unclaimed rather
        // than being handed to whoever is healthy. `claimAllowedByTarget` returns true for every untargeted
        // task, which is what keeps the pre-existing scheduler behaviour unchanged.
        const claimable=t=>t.state==='QUEUED'&&claimAllowedByTarget(t,n.id)&&handoff.claimAllowed({subjectRef:t.id,deviceRef:n.id,reservedFor:typeof t.handoffTargetRef==='string'&&t.handoffTargetRef.length>0?t.handoffTargetRef:null});
        const t=ready&&!busy&&n.sharingEnabled!==false?store.list('tasks').find(claimable):null;
        if(t)handoff.noteAssignment({subjectRef:t.id,deviceRef:n.id});
        // A bare `task: null` cannot tell a device "there is no work" from "there is work and it is not
        // yours". The withheld set is the difference, stated as data; nodes that ignore it are unaffected.
        const withheld=withheldTasks({tasks:store.list('tasks'),deviceRef:n.id,terminal});
        out={task:t?change(t,'ASSIGNED',{assignedNodeId:n.id}):null,...(withheld.length>0?{withheld}:{})};
      } else if(req.method==='POST' && path==='/api/v0/node/report'){
        const b=await body(req);assertOwnNode(req,b.id);const t=required('tasks',b.taskId);if(t.assignedNodeId!==b.id)fail(403,'Task belongs to another node');
        if(terminal.includes(t.state)){out=t;}else{
          const allowed=(t.state==='ASSIGNED'&&['RUNNING','FAILED'].includes(b.state))||(t.state==='RUNNING'&&['RUNNING','COMPLETED','FAILED'].includes(b.state));
          if(!allowed)fail(409,'Invalid task transition');
          if(!Number.isFinite(b.progress)||b.progress<t.progress||b.progress>100)fail(400,'Invalid progress');
          const patch={progress:b.progress};for(const k of ['lastCheckpoint','result','error'])if(b[k]!==undefined)patch[k]=b[k];
          out=change(t,b.state,patch,b.state==='RUNNING'?(t.state==='ASSIGNED'?'TASK_STARTED':'TASK_CHECKPOINTED'):'TASK_'+b.state);
        }
      }else fail(404,'Not found');
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(envelope(out)));
    }catch(e){
      // JOIN-503: an enrollment refusal is a typed fact (which installation, which ladder rung), so its code
      // travels with the response instead of being flattened into prose. No secret is ever part of either shape.
      if(e instanceof EnrollmentError){res.writeHead(e.status||403,{'Content-Type':'application/json'});res.end(JSON.stringify(envelope({error:e.code,errorCode:e.code,detail:e.detail})));return;}
      // A refusal from the identity lifecycle itself (RF-001's rules) carries the same kind of typed code. The
      // refused facts are all client errors: a missing rebind proof, a clone, an already-bound installation.
      if(e instanceof DeviceIdentityError){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify(envelope({error:e.code,errorCode:e.code,detail:e.detail})));return;}
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
    for(const n of store.list('nodes'))if(n.online&&Date.now()-Date.parse(n.lastHeartbeatAt)>heartbeatTimeout){store.put('nodes',{...n,online:false});emit('NODE_OFFLINE',null,{nodeId:n.id});}
    // UXI-391 REPAIR A/B: honour a decline that had nowhere to go, and release a reservation whose device died.
    try{honourDeclinedHandoffs();}catch(e){console.error('handoff sweep failed',e);}
  },1000);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  // `pairing` was published on the LAN before the OS chose the port (port 0 in tests), so the join
  // capability endpoint and the discovery record both have to be re-read from the live endpoint after
  // listen. JOIN-502 only reads `pairing.descriptor()` at request time, so there is nothing to re-publish
  // here - recorded so the next reader does not mistake the assignment below for a join fix.
  pairing.endpoint=`http://${host}:${server.address().port}`;
  if(discoveryEnabled)discovery=await startDiscovery({descriptor:pairing.descriptor(),onStatus:s=>{discoveryState=s;}});
  return {url:pairing.endpoint,store,join,relay,quiesce:value=>{acceptingTasks=!value;},close:async()=>{if(closed)return;closed=true;bridge.close();join.close();relay.close();clearInterval(timer);await discovery?.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>server.close(r));store.close();}};
}
