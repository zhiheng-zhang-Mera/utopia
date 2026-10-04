import {startAgent} from '../../agents/reference-node/agent.mjs';
import {openDeviceSession} from '../../apps/client/device-enrollment.mjs';
export async function startMemberAgent({record,workspace,interval=1000}) {
 let cached=null;
 const credentialProvider=async()=>{if(!cached||Date.parse(cached.session.expiresAt)-Date.now()<60000)cached=await openDeviceSession(record);return cached.credential;};
 return startAgent({url:record.endpoint,id:record.deviceId,displayName:record.displayName,workspace,credentialProvider,interval});
}

// Prepare the authenticated remote worker before retiring only the caller's local services.
export async function demoteLocalHost({record,app,agent,closeRooms,reservation,memberEnrollmentFile,workspace,retireDelay=1500}) {
 app.quiesce(true);
 if(app.store.list('tasks').some(t=>!['COMPLETED','FAILED','CANCELLED'].includes(t.state))){app.quiesce(false);throw new Error('Finish active local tasks before joining another City');}
 let member;
 try{member=await startMemberAgent({record,workspace});}catch(error){app.quiesce(false);throw error;}
 try{await reservation.publish({state:'ONLINE',role:'MEMBER',memberEnrollmentFile,endpoint:record.endpoint,cityId:record.cityId,deviceId:record.deviceId,configFile:null,servicesManaged:true});if(agent)await agent.stop();}catch(error){await member.stop();app.quiesce(false);throw error;}
 let timer;const retired=new Promise((yes,no)=>{timer=setTimeout(async()=>{try{await app.close();if(closeRooms)await closeRooms();yes();}catch(error){no(error);}},retireDelay);});
 return {agent:member,timer,retired};
}
