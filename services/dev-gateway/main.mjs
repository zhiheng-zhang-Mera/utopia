import {createGateway} from './server.mjs';
import {reserveHostCity} from './host-city.mjs';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {findRunningCities} from './host-preflight.mjs';
import {Store} from './store.mjs';
import {hostname} from 'node:os';
import {createHostJoin} from './host-join.mjs';
import {startMemberAgent,demoteLocalHost} from './member-runtime.mjs';
import {readDeviceFile} from '../../apps/client/device-enrollment.mjs';
import {resolveLifecycle} from './host-lifecycle.mjs';
async function main() {
process.env.CITY_MANAGE_SERVICES ??= '1';
const reservation = await reserveHostCity({requestedDataDir:process.env.CITY_DATA || '.runtime',coordinationPort:Number(process.env.CITY_COORDINATION_PORT||4389)});
if (!reservation.owner) {
  console.log('Utopia Gateway already reserved on this host: '+(reservation.record.endpoint || 'starting'));
  return;
}
let app, agent, roomHub, closeTimer;
const clientDir=process.env.UTOPIA_CLIENT_STATE_DIR||resolve(process.env.LOCALAPPDATA||reservation.dataDir,'Utopia/client');
const deviceFile=resolve(clientDir,'device-enrollment.json');
const closeRooms = () => new Promise((yes,no) => roomHub.server.close(error=>error ? no(error) : yes()));
// CITY_LIFECYCLE decides three things at once, and they belong together:
//   page    - single machine, one person: the City follows the page that opened it (see createGateway)
//   service - single machine, hosting for other devices: never exits on its own (the host start script uses this)
//   online  - joining/being joined: the ONLY mode in which a stored host role is honoured (联机角色调整)
// The default is `page`, because the ordinary way a person starts Utopia is by opening it on one machine.
// A member agent IS an online start by construction: it exists to be online in another City, which is why the launcher
// spawns it with CITY_MEMBER_FILE and without a page or a hosting role. See host-lifecycle.mjs for why that is not a
// convenience: leaving it out was a real regression, where the member agent started as a PRIMARY City of its own - a
// host City launched where the caller had deliberately asked for none - and it was caught by hosted CI in
// tests/host-city-launcher.test.mjs rather than by anything on this host.
const {lifecycle:CITY_LIFECYCLE,online:onlineLifecycle,memberAgentFile,roleIgnored:CITY_ROLE_IGNORED,gatewayLifecycle}=resolveLifecycle(process.env);
let closing = false;
async function shutdown(reason) {
  if (closing) return;
  closing = true;
  if (reason) console.log('Utopia Host stopping: '+reason);
  if (agent) await agent.stop();
  clearTimeout(closeTimer);
  if (app) await app.close();
  if (roomHub) await closeRooms();
  await reservation.close();
}
try {
  // Older installations do not own the coordination socket. Refuse an already
  // listening legacy Gateway rather than creating a second City beside it.
  const existing=await findRunningCities();
  if(existing.length)throw new Error('Another City is already running on this host: '+existing.map(city=>city.endpoint).join(', '));
  mkdirSync(reservation.dataDir, {recursive:true});
  if (reservation.expectedCityId) {
    const store = new Store(reservation.dataDir);
    const matches = store.cityId === reservation.expectedCityId;
    store.close();
    if (!matches) throw new Error('Registered City database identity mismatch; restore the canonical database');
  }
  const configFile = resolve(reservation.dataDir, 'local-config.json');
  const legacyFile = resolve(reservation.dataDir, 'local-token.json');
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile,'utf8')) : existsSync(legacyFile) ? JSON.parse(readFileSync(legacyFile,'utf8')) : {};
  config.token ||= process.env.CITY_TOKEN || randomBytes(24).toString('base64url');
  config.nodeToken ||= process.env.CITY_NODE_TOKEN || randomBytes(24).toString('base64url');
  writeFileSync(configFile, JSON.stringify(config), {mode:0o600});
  // ROLE IS IGNORED UNLESS WE ARE GOING ONLINE. A stored member selection (`role.json`) or a leftover device
  // enrollment used to divert an ordinary single-machine start into a member agent for some other City: the person
  // opened Utopia on their own machine and got a client for a City that was not running here. Both diversion paths
  // are therefore gated on 联机 - the role is adjusted when entering online mode and nowhere else.
  const selection=onlineLifecycle?reservation.selection:{role:'PRIMARY'};
  const selectedMemberFile=onlineLifecycle?(memberAgentFile||(selection.role==='MEMBER'?selection.memberEnrollmentFile:!reservation.hasRoleSelection&&readDeviceFile(deviceFile)?deviceFile:null)):null;
  const enrolled=selectedMemberFile?readDeviceFile(selectedMemberFile):null;
  if(enrolled&&selection.role==='MEMBER'&&selection.cityId&&enrolled.cityId!==selection.cityId)throw new Error('Saved member City identity mismatch; no PRIMARY fallback started');
  if(selectedMemberFile&&!enrolled)throw new Error('Selected member credential unavailable; no PRIMARY fallback started');
  if(enrolled){
    agent=await startMemberAgent({record:enrolled,workspace:resolve(clientDir,'workspace')});
    await reservation.publish({state:'ONLINE',role:'MEMBER',endpoint:enrolled.endpoint,cityId:enrolled.cityId,deviceId:enrolled.deviceId,memberEnrollmentFile:selectedMemberFile,configFile:null,servicesManaged:true});
    console.log('Utopia member '+enrolled.endpoint);
  }else{
  if (process.env.CITY_MANAGE_SERVICES === '1' && process.env.CITY_ROOMS_DISABLED !== '1') {
    const {startRoomHub} = await import('../../apps/rooms/hub/server.mjs');
    roomHub = await startRoomHub({host:'127.0.0.1',port:Number(process.env.ROOMS_PORT || 4320),runtimeDir:resolve(reservation.dataDir,'rooms')});
    process.env.CITY_ROOMS_URL = roomHub.url;
  }
  let broker;const hostJoin={start:input=>broker.start(input),status:id=>broker.status(id)};
  app = await createGateway({host:process.env.CITY_HOST||'127.0.0.1',port:Number(process.env.CITY_PORT||4310),dir:reservation.dataDir,token:config.token,nodeToken:config.nodeToken,discoveryEnabled:process.env.CITY_DISCOVERY_DISABLED!=='1',hostJoin,lifecycle:gatewayLifecycle,pageIdleMs:Number(process.env.CITY_PAGE_IDLE_MS||8000),onLifecycleExit:reason=>{shutdown(reason).then(()=>process.exit(0)).catch(error=>{console.error('Utopia Host shutdown failed',error);process.exit(1);});}});
  if (process.env.CITY_MANAGE_SERVICES === '1') {
    const {startAgent} = await import('../../agents/reference-node/agent.mjs');
    agent = await startAgent({url:app.url,token:config.nodeToken,id:'dev-'+app.store.cityId.replaceAll('-',''),displayName:config.deviceName||hostname(),workspace:resolve(reservation.dataDir,'workspace')});
  }
  const startup = {CITY_LIFECYCLE, CITY_ROLE_IGNORED:CITY_ROLE_IGNORED?'1':'0', CITY_MANAGE_SERVICES:process.env.CITY_MANAGE_SERVICES ?? '0',CITY_ROOMS_DISABLED:process.env.CITY_ROOMS_DISABLED ?? '0',ROOMS_PORT:process.env.ROOMS_PORT ?? '4320',CITY_DISCOVERY_DISABLED:process.env.CITY_DISCOVERY_DISABLED ?? '0',CITY_TELEMETRY_DISABLED:process.env.CITY_TELEMETRY_DISABLED ?? '0'};
  await reservation.publish({state:'ONLINE',role:'PRIMARY',persistRole:onlineLifecycle,deviceId:'dev-'+app.store.cityId.replaceAll('-',''),endpoint:app.url,cityId:app.store.cityId,configFile,servicesManaged:process.env.CITY_MANAGE_SERVICES==='1',startup});
  broker=createHostJoin({localCityId:app.store.cityId,localEndpoint:app.url,deviceFile,deviceId:'dev-'+app.store.cityId.replaceAll('-',''),canJoin:()=>!app.store.list('tasks').some(t=>!['COMPLETED','FAILED','CANCELLED'].includes(t.state)),transition:async record=>{
    const result=await demoteLocalHost({record,app,agent,closeRooms:roomHub?async()=>{await closeRooms();roomHub=null;}:null,reservation,memberEnrollmentFile:deviceFile,workspace:resolve(clientDir,'workspace')});agent=result.agent;closeTimer=result.timer;
    await reservation.publish({role:'MEMBER',memberEnrollmentFile:deviceFile});
    result.retired.then(()=>{app=null;}).catch(error=>console.error('Local City retirement failed',error));
  }});
  console.log('Utopia Gateway '+app.url);
  }
} catch (error) {
  if (agent) await agent.stop();
  if (app) await app.close();
  if (roomHub) await closeRooms();
  await reservation.close();
  throw error;
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{
  await shutdown('signal '+signal);
  process.exitCode = 0;
});
}
await main();
