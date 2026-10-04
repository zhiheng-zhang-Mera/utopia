// Member identity is independent from a browser socket and from a computing agent.
export function memberSnapshot({store,installations,surfaces,hostDeviceId}) {
 const nodes=store.list('nodes');const members=new Map();const retired=new Set(installations.filter(i=>i.deviceId&&i.state==='RETIRED'&&!installations.some(other=>other.deviceId===i.deviceId&&other.state==='BOUND')).map(i=>i.deviceId));
 const add=(id,patch)=>members.set(id,{deviceId:id,online:false,computeOnline:false,sharingEnabled:false,capabilities:[],...members.get(id),...patch});
 add(hostDeviceId,{displayName:nodes.find(n=>n.id===hostDeviceId)?.displayName||store.cityName,role:'PRIMARY',online:true});
 for(const i of installations)if(i.deviceId&&i.state==='BOUND')add(i.deviceId,{displayName:i.displayName,role:i.deviceId===hostDeviceId?'PRIMARY':'MEMBER',installationId:i.installationId});
 for(const n of nodes){if(retired.has(n.id))continue;if(n.id==='alien-reference-node'&&nodes.some(x=>x.id===hostDeviceId))continue;const prior=members.get(n.id);add(n.id,{displayName:prior?.displayName||n.displayName,role:prior?.role||'COMPUTE_NODE',nodeId:n.id,computeOnline:n.online,online:prior?.online||n.online,sharingEnabled:n.sharingEnabled!==false,capabilities:n.capabilities,telemetry:n.telemetry,lastHeartbeatAt:n.lastHeartbeatAt,metadata:n.metadata,agentVersion:n.agentVersion});}
 for(const s of surfaces)if(s.clientRef&&!retired.has(s.clientRef)){const prior=members.get(s.clientRef);add(s.clientRef,{displayName:prior?.displayName||s.clientLabel||'Web',role:prior?.role||'CONTROL_ONLY',online:true,controlOnline:true});}
 return [...members.values()];
}
