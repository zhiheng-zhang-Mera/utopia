// Native host broker: durable installation credentials never pass through the Web surface.
import {randomUUID,randomBytes} from 'node:crypto';
import {enrollWithCity,openDeviceSession,writeDeviceFile,readDeviceFile,forgetDeviceFile} from '../../apps/client/device-enrollment.mjs';
const headers={'X-City-Api-Version':'0','X-City-Schema-Version':'0','Content-Type':'application/json'};
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export function createHostJoin({localCityId,localEndpoint,deviceFile,deviceId,transition,canJoin=()=>true,clock=Date.now}) {
 let current=null;
 const request=async(endpoint,path,data)=>{const r=await fetch(endpoint+'/api/v0/'+path,{method:data?'POST':'GET',headers,body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(8000)});const b=await r.json();if(!r.ok)fail(r.status,b.error||'Join refused');return b;};
 const complete=async(record)=>{
  if(!canJoin())fail(409,'Finish active local tasks before joining another City');
  const session=await openDeviceSession(record);const previous=readDeviceFile(deviceFile);writeDeviceFile(deviceFile,record);
  try{await transition(record);}catch(error){if(previous)writeDeviceFile(deviceFile,previous);else forgetDeviceFile(deviceFile);throw error;}
  Object.assign(current,{state:'JOINED',nextUrl:record.endpoint+'/#session='+encodeURIComponent(session.credential),cityId:record.cityId});
 };
 const run=async(input)=>{
  if(input.mode==='adopt'){const record=readDeviceFile(deviceFile);if(!record||record.endpoint!==input.endpoint)fail(409,'No saved membership for this target City');await complete(record);return;}
  const info=await request(input.endpoint,'pairing/info');if(input.cityId&&input.cityId!==info.cityId)fail(409,'Target City identity changed');if(info.cityId===localCityId)fail(409,'This host already owns that City');
  current.cityId=info.cityId;
  if(input.mode==='request'){
   current.claim=randomBytes(32).toString('hex');const ask=await request(input.endpoint,'join/request',{displayName:input.displayName,platform:process.platform,claim:current.claim,installationHint:deviceId});current.requestId=ask.id;current.state='PENDING';return;
  }
  const invite=input.mode==='invite'?input.invite:{cityId:info.cityId,sessionId:info.descriptor?.pairingSessionId,method:'mdns',shortCode:input.shortCode};
  if(!invite||invite.cityId!==info.cityId)fail(409,'Invitation belongs to another City');
  const {record}=await enrollWithCity({endpoint:input.endpoint,invite,displayName:input.displayName,deviceId});await complete(record);
 };
 const recordFailure=error=>{current.state='FAILED';current.error=String(error.message);};
 const visible=()=>({ticketId:current.ticketId,state:current.state,cityId:current.cityId,requestId:current.requestId,nextUrl:current.nextUrl,error:current.error});
 return {
  start:async(input)=>{
   if(current&&['CONNECTING','PENDING','JOINED'].includes(current.state))fail(409,'A host join is already in progress');
   const u=new URL(input.endpoint);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)fail(400,'Invalid target City URL');
   if(u.origin===localEndpoint)fail(409,'Cannot join the local City');
   if(!['code','invite','request','adopt'].includes(input.mode)||typeof input.displayName!=='string'||!input.displayName.trim()||input.displayName.length>64||/[\u0000-\u001f\u007f]/.test(input.displayName))fail(400,'Invalid admission name or mode');
   if(input.mode==='code'&&!/^\d{6}$/.test(input.shortCode||''))fail(400,'Pairing requires six digits');
   if(!canJoin())fail(409,'Finish active local tasks before joining another City');
   current={ticketId:randomUUID(),state:'CONNECTING',startedAt:clock(),input:{...input,endpoint:u.origin,displayName:input.displayName.trim()}};
   current.operation=run(current.input).catch(recordFailure);return visible();
  },
  status:async ticketId=>{
   if(!current||ticketId!==current.ticketId)fail(404,'Host join ticket not found');
   if(current.state==='PENDING'&&!current.checking){current.checking=true;try{
    if(clock()-current.startedAt>600000)fail(410,'Join request expired');
    const s=await request(current.input.endpoint,'join/status',{requestId:current.requestId,claim:current.claim});
    if(s.approved){current.state='CONNECTING';const b=await request(current.input.endpoint,'join/exchange',{requestId:current.requestId,claim:current.claim,installation:{displayName:current.input.displayName,platform:process.platform,deviceId}});const e=b.enrollment;if(!e||b.cityId!==current.cityId)fail(409,'Remote City did not enroll this host');await complete({version:1,endpoint:current.input.endpoint,cityId:b.cityId,deviceId:e.deviceId,installationId:e.installationId,instanceId:e.instanceId,credentialId:e.credentialId,credentialSecret:e.credentialSecret,displayName:e.displayName});}
    else if(s.terminal)fail(403,'Join request '+s.state);
   }catch(error){recordFailure(error);}finally{current.checking=false;}}
   return visible();
  }
 };
}
