import http from 'node:http';
import {resolve} from 'node:path';
import {hostname} from 'node:os';
import {createBridge} from '../capability-bridge/bridge.mjs';
import {MAX_REQUEST_BYTES,refuse} from '../../contracts/capability-bridge-v1/protocol.mjs';
import { readFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Store } from './store.mjs';
import { Pairing } from './pairing.mjs';
import { validateTelemetry } from '../../contracts/pairing-v1/descriptor.mjs';
import { startDiscovery } from './discovery.mjs';
import { envelope, terminal, validateCommand } from '../../contracts/city-control-v0/protocol.mjs';
// Product closeout (T1–T3): the Room Pack, the canonical Action facade and the
// deterministic Ask / Do router. The Room Hub is reached over loopback only; nothing here
// exposes its port, and no route in this phase can reach Boss or Hns.
import { createRoomPack } from './rooms.mjs';
import { createActions } from './actions.mjs';
import { buildTargets, handleAsk } from './intents.mjs';
import { serveWeb } from './static.mjs';
// UXI-301: the scheduler presentation feed producer. Consumes the frozen RS-290 contract read-only.
import { buildPresentationFeed } from './presentation.mjs';
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
// The Core's node shape, filled from the gateway's own liveness truth. A node that is
// not online is OFFLINE, and the Core refuses an OFFLINE node whatever it lists.
const claimNodeFor=n=>({nodeId:n.id,state:n.online?'READY':'OFFLINE',capabilities:n.capabilities,lastHeartbeatAt:Date.parse(n.lastHeartbeatAt)||0,seq:0});
export async function createGateway({host='127.0.0.1',port=4310,dir='.runtime',token,nodeToken,heartbeatTimeout=8000,pairingClock=Date.now,pairingTtlMs=300000,discoveryEnabled=false,roomHubUrl=process.env.CITY_ROOMS_URL,roomsDisabled=process.env.CITY_ROOMS_DISABLED==='1',hostId=process.env.CITY_HOST_ID,roomFetch}) {
  if(!token||!nodeToken||token===nodeToken) throw new Error('Separate control and node tokens are required');
  if(host==='0.0.0.0'||host==='::') throw new Error('Configure an explicit loopback or LAN interface');
  const store=new Store(dir); const wss=new WebSocketServer({noServer:true}); let closed=false;
  let discovery=null,discoveryState={mdns:{state:'DISABLED'},ble:{state:'DISABLED'}};
  const pairing=new Pairing({cityId:store.cityId,endpoint:`http://${host}:${port}`,credential:token,clock:pairingClock,ttlMs:pairingTtlMs,onChange:d=>discovery?.update(d)});
  const telemetry=b=>{if(b.telemetry===undefined)return {};if(b.telemetry===null)return {telemetry:null};try{validateTelemetry(b.telemetry);return {telemetry:b.telemetry};}catch(e){fail(400,e.message);}};
  const emit=(type,id,payload,actor)=>{const e=store.event(type,id,payload,actor); for(const c of wss.clients) if(c.readyState===1)c.send(JSON.stringify(envelope({event:e})));return e;};
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
  const auth=(req,node=false)=>{const raw=req.headers.authorization||'';if(!equals(raw,'Bearer '+(node?nodeToken:token)))fail(401,'Invalid pairing token');};
  const version=req=>{if(req.headers['x-city-api-version']!=='0'||req.headers['x-city-schema-version']!=='0')fail(409,'Protocol mismatch: apiVersion=0 and schemaVersion=0 required');};
  const bridge=createBridge(store,emit,{artifactRoot:resolve(dir,'theme-packages')});
  // Product closeout (T1–T3). The Room Hub is reached over loopback only, and the Action
  // facade is the single user-facing record over Rooms, capabilities and City tasks.
  const rooms=createRoomPack({baseUrl:roomHubUrl,disabled:roomsDisabled,fetchImpl:roomFetch});
  // Is some real node currently able to accept the work Utopia places? Decided by the
  // migrated fleet-routing module, exactly as `/api/v0/node/claim` decides it.
  const cityAvailability=()=>{
    const able=store.list('nodes').some(n=>acceptsWork(claimNodeFor(n),{requiredCapabilities:REQUIRED_TASK_CAPABILITIES})===true);
    return able?{available:true,reason:null}:{available:false,reason:'no online node advertises task.execute.safe and filesystem.temp'};
  };
  const cityTasks={
    terminal,
    get:id=>store.get('tasks',id),
    availability:cityAvailability,
    create:type=>store.atomic(()=>{const t={id:'Q-'+randomUUID(),type,domain:'system',state:'QUEUED',createdAt:now(),updatedAt:now(),assignedNodeId:null,progress:0,lastCheckpoint:null,result:null,error:null};store.put('tasks',t);emit('COMMAND_ACCEPTED',t.id);emit('TASK_CREATED',t.id);return t;}),
  };
  const actions=createActions({store,rooms,bridge,cityTasks,host:hostId||hostname()});
  // Every routable target with its own truthful availability. Nothing here is BOSS/HNS.
  const askTargets=async()=>{const roomState=await rooms.probe();return buildTargets({roomState,capabilities:bridge.registry(),cityAvailability:cityAvailability(),roomsAvailable:roomState.available});};
  const body=async (req,limit=16384)=>{let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>limit){if(limit===MAX_REQUEST_BYTES)refuse('INPUT_TOO_LARGE',413);fail(413,'Request too large');}chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{if(limit===MAX_REQUEST_BYTES)refuse('INVALID_JSON');fail(400,'Invalid JSON');}};
  const required=(table,id)=>store.get(table,id)||fail(404,'Not found');
  const snapshot=()=>envelope({status:'ONLINE',updatedAt:now(),cityId:store.cityId,displayName:'Utopia · Alien',descriptor:pairing.descriptor(),discovery:discoveryState,nodes:store.list('nodes'),tasks:store.list('tasks'),events:store.events(),capabilities:bridge.registry(),invocations:bridge.list()});
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
      const nodeRoute=path.startsWith('/api/v0/node/');
      const publicPairing=path==='/api/v0/pairing/info'||path==='/api/v0/pairing/exchange';
      if(!publicPairing)auth(req,nodeRoute);version(req);
      let out;
      if(req.method==='GET' && path==='/api/v0/pairing/info')out=pairing.info();
      else if(req.method==='POST' && path==='/api/v0/pairing/session'){await body(req);out=await pairing.create();}
      else if(req.method==='POST' && path==='/api/v0/pairing/exchange')out=pairing.exchange(await body(req));
      else if(req.method==='GET' && path==='/api/v0/capabilities')out={capabilities:bridge.registry()};
      else if(req.method==='GET' && path==='/api/v0/capability-invocations')out={invocations:bridge.list(new URL(req.url,'http://city').searchParams.get('limit')??undefined)};
      else if(req.method==='GET' && /^\/api\/v0\/capability-invocations\/[^/]+$/.test(path))out=bridge.get(decodeURIComponent(path.split('/').at(-1)))||refuse('INVOCATION_NOT_FOUND',404);
      else if(req.method==='GET' && /^\/api\/v0\/capabilities\/[^/]+$/.test(path))out=bridge.registry().find(c=>c.capabilityId===decodeURIComponent(path.split('/').at(-1)))||refuse('CAPABILITY_NOT_FOUND',404);
      else if(req.method==='POST' && /^\/api\/v0\/capabilities\/[^/]+\/invoke$/.test(path))out=await bridge.invoke(decodeURIComponent(path.split('/').at(-2)),await body(req,MAX_REQUEST_BYTES));
      else if(req.method==='GET' && path==='/api/v0/city')out=snapshot();
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
      else if(req.method==='GET' && path==='/api/v0/nodes')out={nodes:store.list('nodes')};
      else if(req.method==='GET' && path==='/api/v0/tasks')out={tasks:store.list('tasks')};
      else if(req.method==='GET' && path==='/api/v0/events')out={events:store.events()};
      else if(req.method==='GET' && /^\/api\/v0\/tasks\/[^/]+$/.test(path))out=required('tasks',path.split('/').at(-1));
      else if(req.method==='POST' && path==='/api/v0/tasks'){
        const b=await body(req);validateCommand(b);
        out=store.atomic(()=>{const t={id:'Q-'+randomUUID(),type:b.type,domain:'system',state:'QUEUED',createdAt:now(),updatedAt:now(),assignedNodeId:null,progress:0,lastCheckpoint:null,result:null,error:null};store.put('tasks',t);emit('COMMAND_ACCEPTED',t.id);emit('TASK_CREATED',t.id);return t;});
      } else if(req.method==='POST' && /^\/api\/v0\/tasks\/[^/]+\/cancel$/.test(path)){
        const t=required('tasks',path.split('/').at(-2));if(terminal.includes(t.state))fail(409,'Task already finished');out=change(t,'CANCELLED');
      } else if(req.method==='POST' && path==='/api/v0/node/register'){
        const b=await body(req);if(!/^[a-zA-Z0-9-]{1,80}$/.test(b.id||'')||typeof b.displayName!=='string'||!Array.isArray(b.capabilities)||!b.capabilities.every(c=>typeof c==='string'))fail(400,'Invalid node registration');
        const prior=store.get('nodes',b.id);
        for(const t of store.list('tasks'))if(t.assignedNodeId===b.id&&!terminal.includes(t.state))change(t,'FAILED',{error:'Node re-registered; interrupted work is not replayed.'});
        out=store.put('nodes',{id:b.id,devicePrincipalId:b.id,displayName:b.displayName.slice(0,100),metadata:{platform:String(b.metadata?.platform||'unknown')},agentVersion:typeof b.agentVersion==='string'?b.agentVersion.slice(0,30):'0.1.0',...telemetry(b),capabilities:b.capabilities,online:true,lastHeartbeatAt:now()});if(!prior?.online)emit('NODE_ONLINE',null,{nodeId:b.id});
      } else if(req.method==='POST' && path==='/api/v0/node/heartbeat'){
        const b=await body(req);const n=required('nodes',b.id);const metrics=telemetry(b);if(!n.online)emit('NODE_ONLINE',null,{nodeId:n.id});out=store.put('nodes',{...n,...metrics,online:true,lastHeartbeatAt:now()});
      } else if(req.method==='POST' && path==='/api/v0/node/claim'){
        const b=await body(req);const n=required('nodes',b.id);
        const ready=acceptsWork(claimNodeFor(n),{requiredCapabilities:REQUIRED_TASK_CAPABILITIES});
        const busy=store.list('tasks').some(t=>t.assignedNodeId===n.id&&!terminal.includes(t.state));
        const t=ready&&!busy?store.list('tasks').find(t=>t.state==='QUEUED'):null;
        out={task:t?change(t,'ASSIGNED',{assignedNodeId:n.id}):null};
      } else if(req.method==='POST' && path==='/api/v0/node/report'){
        const b=await body(req);const t=required('tasks',b.taskId);if(t.assignedNodeId!==b.id)fail(403,'Task belongs to another node');
        if(terminal.includes(t.state)){out=t;}else{
          const allowed=(t.state==='ASSIGNED'&&['RUNNING','FAILED'].includes(b.state))||(t.state==='RUNNING'&&['RUNNING','COMPLETED','FAILED'].includes(b.state));
          if(!allowed)fail(409,'Invalid task transition');
          if(!Number.isFinite(b.progress)||b.progress<t.progress||b.progress>100)fail(400,'Invalid progress');
          const patch={progress:b.progress};for(const k of ['lastCheckpoint','result','error'])if(b[k]!==undefined)patch[k]=b[k];
          out=change(t,b.state,patch,b.state==='RUNNING'?(t.state==='ASSIGNED'?'TASK_STARTED':'TASK_CHECKPOINTED'):'TASK_'+b.state);
        }
      }else fail(404,'Not found');
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(envelope(out)));
    }catch(e){res.writeHead(e.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify(envelope({error:e.status?e.message:'Gateway error',...(e.code?{errorCode:e.code}:{})})));if(!e.status)console.error(e);}
  });
  server.on('upgrade',(req,socket,head)=>{
    try {
      const u=new URL(req.url,'http://city');if(u.pathname!=='/api/v0/events/stream')fail(404,'Not found');
      // Browser WebSocket cannot set Authorization; token travels in a subprotocol, never a URL.
      const protocols=String(req.headers['sec-websocket-protocol']||'').split(',').map(s=>s.trim());
      if(!req.headers.authorization){const p=protocols.find(p=>p.startsWith('city-token.'));req.headers.authorization='Bearer '+(p?Buffer.from(p.slice(11),'base64url').toString():'');}
      auth(req);if(u.searchParams.get('apiVersion')!=='0'||u.searchParams.get('schemaVersion')!=='0')fail(409,'Protocol mismatch');
      wss.handleUpgrade(req,socket,head,ws=>{emit('CLIENT_CONNECTED');ws.send(JSON.stringify(envelope({type:'REFRESH'})));ws.on('error',()=>{});ws.on('close',()=>{if(!closed)emit('CLIENT_DISCONNECTED');});});
    }catch(e){socket.write('HTTP/1.1 '+(e.status||400)+' Rejected\r\nConnection: close\r\n\r\n');socket.destroy();}
  });
  const timer=setInterval(()=>{for(const n of store.list('nodes'))if(n.online&&Date.now()-Date.parse(n.lastHeartbeatAt)>heartbeatTimeout){store.put('nodes',{...n,online:false});emit('NODE_OFFLINE',null,{nodeId:n.id});}},1000);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  pairing.endpoint=`http://${host}:${server.address().port}`;
  if(discoveryEnabled)discovery=await startDiscovery({descriptor:pairing.descriptor(),onStatus:s=>{discoveryState=s;}});
  return {url:pairing.endpoint,store,close:async()=>{if(closed)return;closed=true;bridge.close();clearInterval(timer);await discovery?.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>server.close(r));store.close();}};
}
