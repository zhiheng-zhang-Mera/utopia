import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Store } from './store.mjs';
import { envelope, terminal, validateCommand } from '../../contracts/city-control-v0/protocol.mjs';

const now=()=>new Date().toISOString();
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const equals=(a,b)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function createGateway({host='127.0.0.1',port=4310,dir='.runtime',token,nodeToken,heartbeatTimeout=8000}) {
  if(!token||!nodeToken||token===nodeToken) throw new Error('Separate control and node tokens are required');
  if(host==='0.0.0.0'||host==='::') throw new Error('Configure an explicit loopback or LAN interface');
  const store=new Store(dir); const wss=new WebSocketServer({noServer:true}); let closed=false;
  const emit=(type,id,payload,actor)=>{const e=store.event(type,id,payload,actor); for(const c of wss.clients) if(c.readyState===1)c.send(JSON.stringify(envelope({event:e})));return e;};
  const change=(task,state,patch={},event='TASK_'+state)=>store.atomic(()=>{Object.assign(task,patch,{state,updatedAt:now()});store.put('tasks',task);emit(event,task.id,{state,progress:task.progress,...patch},task.assignedNodeId||'gateway');return task;});
  for(const t of store.list('tasks'))if(!terminal.includes(t.state)&&t.state!=='QUEUED')change(t,'FAILED',{error:'Gateway restarted during execution; create a new task to retry safely.'});
  for(const n of store.list('nodes'))store.put('nodes',{...n,online:false});
  emit('CITY_STARTED',null,{schemaVersion:0});
  const auth=(req,node=false)=>{const raw=req.headers.authorization||'';if(!equals(raw,'Bearer '+(node?nodeToken:token)))fail(401,'Invalid pairing token');};
  const version=req=>{if(req.headers['x-city-api-version']!=='0'||req.headers['x-city-schema-version']!=='0')fail(409,'Protocol mismatch: apiVersion=0 and schemaVersion=0 required');};
  const body=async req=>{let s='';for await(const c of req){s+=c;if(s.length>16384)fail(413,'Request too large');}try{return JSON.parse(s||'{}');}catch{fail(400,'Invalid JSON');}};
  const required=(table,id)=>store.get(table,id)||fail(404,'Not found');
  const snapshot=()=>envelope({status:'ONLINE',updatedAt:now(),nodes:store.list('nodes'),tasks:store.list('tasks'),events:store.events()});
  const server=http.createServer(async(req,res)=>{
    try {
      const path=new URL(req.url,'http://city').pathname;
      if(!path.startsWith('/api/')){
        // Static Web Control Surface assets. The allow-list is explicit so this
        // route can never serve arbitrary files; the three /i18n modules are the
        // en and zh-CN language packs plus the i18n runtime.
        const file={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/i18n/en.js':'i18n/en.js','/i18n/zh-CN.js':'i18n/zh-CN.js','/i18n/index.js':'i18n/index.js'}[path];
        if(!file||file.includes('..'))fail(404,'Not found');
        const data=await readFile(new URL('../../apps/web/'+file,import.meta.url));
        res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':'text/css','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end(data);return;
      }
      if(path==='/api/v0/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(envelope({status:'healthy'})));return;}
      const nodeRoute=path.startsWith('/api/v0/node/');auth(req,nodeRoute);version(req);
      let out;
      if(req.method==='GET' && path==='/api/v0/city')out=snapshot();
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
        out=store.put('nodes',{id:b.id,devicePrincipalId:b.id,displayName:b.displayName.slice(0,100),metadata:{platform:String(b.metadata?.platform||'unknown')},capabilities:b.capabilities,online:true,lastHeartbeatAt:now()});if(!prior?.online)emit('NODE_ONLINE',null,{nodeId:b.id});
      } else if(req.method==='POST' && path==='/api/v0/node/heartbeat'){
        const b=await body(req);const n=required('nodes',b.id);if(!n.online)emit('NODE_ONLINE',null,{nodeId:n.id});out=store.put('nodes',{...n,online:true,lastHeartbeatAt:now()});
      } else if(req.method==='POST' && path==='/api/v0/node/claim'){
        const b=await body(req);const n=required('nodes',b.id);
        const ready=n.online&&n.capabilities.includes('task.execute.safe')&&n.capabilities.includes('filesystem.temp');
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
    }catch(e){res.writeHead(e.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify(envelope({error:e.status?e.message:'Gateway error'})));if(!e.status)console.error(e);}
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
  return {url:`http://${host}:${server.address().port}`,store,close:async()=>{if(closed)return;closed=true;clearInterval(timer);for(const ws of wss.clients)ws.terminate();await new Promise(r=>server.close(r));store.close();}};
}
