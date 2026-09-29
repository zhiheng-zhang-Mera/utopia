import Bonjour from 'bonjour-service';
import { mdnsTxt } from '../../contracts/pairing-v1/descriptor.mjs';
export async function startDiscovery({descriptor,onStatus}){
 let closed=false,service=null,ble=null,bonjour=null;
 const status={mdns:{state:'STARTING'},ble:{state:'STARTING'}};
 const update=(kind,value)=>{status[kind]=value;if(!closed)onStatus({...status});};
 try{
  bonjour=new Bonjour({interface:descriptor.endpoint.host},e=>update('mdns',{state:'ERROR',reason:e.code||'mDNS socket unavailable'}));
  const publish=d=>{
   if(closed)return;
   service=bonjour.publish({name:'Utopia-'+d.cityId.slice(0,8),type:'utopia-city',protocol:'tcp',host:'utopia-'+d.cityId.slice(0,8)+'.local',port:d.endpoint.port,disableIPv6:true,txt:mdnsTxt(d)});
   // Bind advertised A records to the configured interface, excluding stale NIC addresses.
   const records=service.records.bind(service);service.records=()=>records().filter(r=>r.type!=='A'||r.data===d.endpoint.host).map(r=>({...r,ttl:30}));
   service.on('up',()=>update('mdns',{state:'ACTIVE'}));service.on('error',()=>update('mdns',{state:'ERROR',reason:'Service publication failed'}));
  };
  publish(descriptor);
  const change=d=>{if(closed)return;if(service)service.stop(()=>publish(d));else publish(d);};
  try{const {startBle}=await import('../../platform/windows/ble.mjs');ble=await startBle({host:descriptor.endpoint.host,port:descriptor.endpoint.port,onStatus:s=>update('ble',s)});}catch(e){update('ble',{state:'ERROR',reason:'BLE adapter unavailable: '+e.code});}
  return {status,update:change,close:async()=>{closed=true;await ble?.close();if(bonjour)await new Promise(r=>bonjour.unpublishAll(()=>bonjour.destroy(r)));}};
 }catch(e){update('mdns',{state:'ERROR',reason:e.code||'mDNS initialization failed'});return {status,update:()=>{},close:async()=>{closed=true;await ble?.close();bonjour?.destroy();}};}
}
