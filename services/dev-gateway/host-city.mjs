import {createServer} from 'node:http';
import {existsSync, mkdirSync, readFileSync, writeFileSync, renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {homedir} from 'node:os';

export const HOST_CITY_PORT = 4389;
const kind = 'utopia-city-host-v1';
export const hostStateDir = () => resolve(process.env.UTOPIA_HOST_STATE_DIR || resolve(process.env.ProgramData || homedir(), 'Utopia/host'));

export async function readHostCity(port = HOST_CITY_PORT) {
  const response = await fetch(`http://127.0.0.1:${port}/`, {signal: AbortSignal.timeout(1500)});
  const record = await response.json();
  if (record.kind !== kind) throw new Error('Host coordination port belongs to another application');
  return record;
}

// The OS owns the reservation. A crash releases it without stale lock-file deletion.
export async function reserveHostCity({stateDir = hostStateDir(), requestedDataDir, coordinationPort = HOST_CITY_PORT} = {}) {
  let record = {kind, state: 'STARTING', gatewayPid: process.pid};
  const server = createServer((req, res) => {
    res.writeHead(200, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
    res.end(JSON.stringify(record));
  });
  try {
    await new Promise((yes, no) => {server.once('error', no); server.listen(coordinationPort, '127.0.0.1', yes);});
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    return {owner:false, record:await readHostCity(coordinationPort)};
  }
  const close = () => new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
  try {
    mkdirSync(stateDir, {recursive:true});
    const pointer = resolve(stateDir, 'city.json');
    const roleFile=resolve(stateDir,'role.json');
    const selection=existsSync(roleFile)?JSON.parse(readFileSync(roleFile,'utf8')):{role:'PRIMARY'};
    if(!['PRIMARY','MEMBER'].includes(selection.role)||(selection.role==='MEMBER'&&typeof selection.memberEnrollmentFile!=='string'))throw new Error('Invalid selected host role; no fallback City started');
    let dataDir, expectedCityId;
    if (existsSync(pointer)) {
      const saved = JSON.parse(readFileSync(pointer, 'utf8'));
      if (saved.kind !== kind || typeof saved.dataDir !== 'string' || !saved.dataDir) throw new Error('Invalid host City registry');
      dataDir = resolve(saved.dataDir);
      expectedCityId = saved.cityId;
      if (saved.cityId && !existsSync(resolve(dataDir,'city.sqlite'))) throw new Error('The registered City database is missing; restore it before starting');
    } else {
      dataDir = requestedDataDir && existsSync(resolve(requestedDataDir, 'city.sqlite')) ? resolve(requestedDataDir) : resolve(stateDir, 'city');
      writeFileSync(`${pointer}.tmp`, JSON.stringify({kind, dataDir}), {mode:0o600});
      renameSync(`${pointer}.tmp`, pointer);
    }
    record = {...record, dataDir};
    return {owner:true, dataDir, expectedCityId, selection, hasRoleSelection:existsSync(roleFile), stateDir, get record() {return record;}, coordinationPort:server.address().port, close,
      publish:async update => {
        record = {...record, ...update, kind, dataDir};
        if(update.role==='MEMBER'&&record.memberEnrollmentFile){writeFileSync(roleFile+'.tmp',JSON.stringify({role:'MEMBER',cityId:record.cityId,memberEnrollmentFile:record.memberEnrollmentFile}),{mode:0o600});renameSync(roleFile+'.tmp',roleFile);}
        else if(update.role==='PRIMARY'){writeFileSync(roleFile+'.tmp',JSON.stringify({role:'PRIMARY'}),{mode:0o600});renameSync(roleFile+'.tmp',roleFile);}
        if (update.state === 'ONLINE' && update.role !== 'MEMBER' && existsSync(resolve(dataDir,'city.sqlite'))) {
          writeFileSync(`${pointer}.tmp`, JSON.stringify({kind,dataDir,cityId:update.cityId}), {mode:0o600});
          renameSync(`${pointer}.tmp`,pointer);
        }
      }};
  } catch (error) {await close(); throw error;}
}
