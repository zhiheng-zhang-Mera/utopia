import {createGateway} from '../services/dev-gateway/server.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {WebSocket} from 'ws';
const dir=await mkdtemp(resolve('.runtime/join590-review-'));
const owner='independent-review-fixture-owner';
let app,socket;
try {
 app=await createGateway({host:'127.0.0.1',port:0,dir,token:owner,nodeToken:'review-node'});
 const headers={Authorization:`Bearer ${owner}`,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'};
 const pending=new Map(); let seq=0;
 socket=new WebSocket(app.url.replace(/^http/,'ws')+'/api/v0/relay?apiVersion=0&schemaVersion=0&installationId=independent-android-review');
 await new Promise((ok,bad)=>{socket.on('error',bad);socket.on('message',raw=>{const frame=JSON.parse(raw);if(frame.type==='RELAY_READY'){ok();return;}const call=pending.get(frame.requestId);if(call){clearTimeout(call.timer);pending.delete(frame.requestId);call.ok(frame.response??frame);}});});
 const forward=(path,body={})=>new Promise((ok,bad)=>{const requestId=`review-${++seq}`;const timer=setTimeout(()=>{pending.delete(requestId);bad(new Error('TIMEOUT'));},4000);pending.set(requestId,{ok,timer});socket.send(JSON.stringify({kind:'relay-request',requestId,path,method:'POST',body}));});
 const claim='independent-review-claim';
 const asked=await forward('/api/v0/join/request',{displayName:'Review Android',platform:'android',installationHint:'independent-android-review',claim});
 const id=asked.payload.requestId??asked.payload.id;
 const approved=await fetch(`${app.url}/api/v0/join/requests/${id}/approve`,{method:'POST',headers,body:'{}'});
 const exchanged=await forward('/api/v0/join/exchange',{requestId:id,claim});
 const installs=await (await fetch(app.url+'/api/v0/device/installations',{headers})).json();
 const received=exchanged.payload.credential;
 const elevated=await fetch(app.url+'/api/v0/pairing/session',{method:'POST',headers:{...headers,Authorization:`Bearer ${received}`},body:'{}'});
 console.log(JSON.stringify({head:'b91677d1478950feb79742f618d0c981773d5bb7',scope:'controlled actual Gateway relay; Android-shaped payload',approvedStatus:approved.status,exchangeStatus:exchanged.status,receivedOwnerCredential:received===owner,enrollmentPresent:!!exchanged.payload.enrollment,installationCount:installs.installations?.length??null,ownerSessionMintStatus:elevated.status},null,2));
} finally {socket?.terminate();await app?.close();await rm(dir,{recursive:true,force:true});}
