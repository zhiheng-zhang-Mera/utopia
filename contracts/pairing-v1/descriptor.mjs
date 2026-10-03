export const descriptorVersion=1;
export const BLE_SERVICE_UUID='6f9a0001-6c53-4b92-a319-75746f706961';
export const FRESHNESS_MS=10000;
export function validateDescriptor(value,at=Date.now()){
 if(!value||value.descriptorVersion!==1||value.apiVersion!==0||value.schemaVersion!==0)throw new Error('Unsupported discovery or control protocol version');
 const e=value.endpoint;
 if(typeof value.cityId!=='string'||!value.cityId||!e||!['http','https'].includes(e.scheme)||typeof e.host!=='string'||!/^[a-zA-Z0-9.-]+$/.test(e.host)||!Number.isInteger(e.port)||e.port<1||e.port>65535)throw new Error('Invalid city endpoint');
 if(value.expiresAt!==null&&value.expiresAt!==undefined&&(!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=at))throw new Error('Pairing session expired');
 return value;
}
export const endpointUrl=d=>`${d.endpoint.scheme}://${d.endpoint.host}:${d.endpoint.port}`;
export function parseQr(raw,at=Date.now()){
 const u=new URL(raw);
 if(u.protocol!=='utopia:'||u.hostname!=='pair'||u.searchParams.get('v')!=='1')throw new Error('Unsupported pairing QR');
 const host=new URL(u.searchParams.get('host')||'');
 if(host.username||host.password||host.search||host.hash||host.pathname!=='/')throw new Error('Invalid pairing endpoint');
 const d={descriptorVersion:1,cityId:u.searchParams.get('city'),endpoint:{scheme:host.protocol.slice(0,-1),host:host.hostname,port:Number(host.port||(host.protocol==='https:'?443:80))},apiVersion:0,schemaVersion:0,pairingSessionId:u.searchParams.get('session'),expiresAt:u.searchParams.get('expires'),secret:u.searchParams.get('secret')};
 if(!d.pairingSessionId||!d.secret||!d.expiresAt)throw new Error('Incomplete pairing QR');
 return validateDescriptor(d,at);
}
export function mergeDiscovered(items,descriptor){validateDescriptor(descriptor);const prior=items.find(d=>d.cityId===descriptor.cityId);if(prior&&endpointUrl(prior)!==endpointUrl(descriptor))throw new Error('Conflicting endpoints for the same City identity');return [...items.filter(d=>d.cityId!==descriptor.cityId),descriptor];}
// JOIN-502: `join` tells a browsing client, from the advertisement alone, that this City accepts the
// approve-then-join protocol. It is a capability flag, never a secret and never an identity: a City
// that omits it is simply not a join target, which keeps "unavailable" honest instead of guessed.
export function mdnsTxt(d){return {v:'1',city:d.cityId,api:'0',schema:'0',session:d.pairingSessionId||'',join:'1'};}
export function validateTelemetry(t){
 const num=(v,max=Number.MAX_SAFE_INTEGER)=>v===null||(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max);
 if(!t||!Number.isFinite(Date.parse(t.observedAt))||!num(t.uptimeSeconds)||!t.cpu||!(t.cpu.usagePercent===null||num(t.cpu.usagePercent,100)))throw new Error('Invalid telemetry timestamp, uptime or CPU');
 for(const k of ['memory','disk']){
  const m=t[k];if(m===null)continue;
  if(!m||!num(m.usedBytes)||!num(m.totalBytes)||(m.usedBytes!==null&&m.totalBytes!==null&&m.usedBytes>m.totalBytes)||(k==='disk'&&(!num(m.freeBytes)||(m.freeBytes!==null&&m.totalBytes!==null&&m.freeBytes>m.totalBytes))))throw new Error('Invalid '+k+' telemetry');
 }
 return t;
}
export function telemetryStatus(node,connected,at=Date.now()){
 if(!connected)return 'UNKNOWN';if(!node.online)return 'OFFLINE';
 const age=at-Date.parse(node.telemetry?.observedAt);return Number.isFinite(age)&&age>=-5000&&age<=FRESHNESS_MS?'ONLINE':'UNKNOWN';
}
