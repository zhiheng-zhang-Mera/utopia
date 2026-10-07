// Member identity is independent from a browser socket and from a computing agent.
//
// THE HOST IS NOT AUTOMATICALLY ONLINE. An earlier version added the host principal with `online: true` unconditionally,
// so a freshly opened City showed its own machine as a live device that had never joined anything - the exact complaint
// "when I open the City my own device is already online and it is the main city". Presence is now derived from evidence:
// the host is present when a member surface of THIS City is actually connected, or when the host's own node has a live
// heartbeat. The principal still EXISTS from the start (it is the identity the surface will take when it joins), but it
// is not claimed to be present until something proves it.
//
// The legacy-node exclusion is by IDENTITY, not by ID string equality: the host's node row is whatever node belongs to
// the host principal or carries the host's own hostname, so a City whose node id is `dev-<cityId>` (or any other id) is
// still recognised as "this machine" instead of being listed a second time.
const isText = value => typeof value === 'string' && value.trim().length > 0;

/** Is a node row this City's OWN machine? Matched on principal, or on the host's own default node id. The hostname
 *  alone is NOT enough: two Cities can run on one machine (a local host and a remote City it joined), and folding the
 *  other City's worker into this host would hide it as a member - measured, that is exactly what a hostname-only rule
 *  did to the cross-City member test. */
export const isHostOwnNode = (node, {hostDeviceId, hostnames = []} = {}) => {
  if (!node || typeof node !== 'object') return false;
  if (isText(hostDeviceId) && (node.id === hostDeviceId || node.devicePrincipalId === hostDeviceId)) return true;
  const nodeHost = node.metadata?.hostname;
  const looksLikeDefaultHostNode = typeof node.id === 'string' && node.id.startsWith('host-');
  return looksLikeDefaultHostNode && isText(nodeHost) && hostnames.some(name => isText(name) && name.toLowerCase() === nodeHost.toLowerCase());
};

export function memberSnapshot({store,installations,surfaces,hostDeviceId,hostnames=[]}) {
 const nodes=store.list('nodes');const members=new Map();
 const retired=new Set(installations.filter(i=>i.deviceId&&i.state==='RETIRED'&&!installations.some(other=>other.deviceId===i.deviceId&&other.state==='BOUND')).map(i=>i.deviceId));
 const add=(id,patch)=>members.set(id,{deviceId:id,online:false,computeOnline:false,sharingEnabled:false,capabilities:[],...members.get(id),...patch});
 // The host principal exists from the start, but presence is EARNED below by a connected surface or a live node.
 // Persistent history can contain both launcher and reference-agent identities. Pick one live execution target,
 // preferring the canonical principal on ties; an offline alias must not overwrite its capabilities or presence.
 const hostNode=nodes.filter(n=>!retired.has(n.id)&&isHostOwnNode(n,{hostDeviceId,hostnames})).sort((a,b)=>
  Number(b.online===true)-Number(a.online===true)||Number(b.id===hostDeviceId)-Number(a.id===hostDeviceId)||String(a.id).localeCompare(String(b.id)))[0];
 add(hostDeviceId,{displayName:hostNode?.displayName||store.cityName,role:'PRIMARY',nodeId:hostNode?.id??null,online:false});
 for(const i of installations)if(i.deviceId&&i.state==='BOUND')add(i.deviceId,{displayName:i.displayName,role:i.deviceId===hostDeviceId?'PRIMARY':'MEMBER',installationId:i.installationId});
 // Node rows that are NOT this machine's own node are separate compute members. This machine's node row is folded into
 // the host principal above instead of appearing twice.
 for(const n of nodes){
  if(retired.has(n.id))continue;
  if(isHostOwnNode(n,{hostDeviceId,hostnames})){if(n===hostNode)add(hostDeviceId,{nodeId:n.id,computeOnline:n.online===true,sharingEnabled:n.sharingEnabled!==false,capabilities:n.capabilities,telemetry:n.telemetry,lastHeartbeatAt:n.lastHeartbeatAt,metadata:n.metadata,agentVersion:n.agentVersion});continue;}
  const prior=members.get(n.id);
  add(n.id,{displayName:prior?.displayName||n.displayName,role:prior?.role||'COMPUTE_NODE',nodeId:n.id,computeOnline:n.online===true,online:prior?.online||n.online===true,sharingEnabled:n.sharingEnabled!==false,capabilities:n.capabilities,telemetry:n.telemetry,lastHeartbeatAt:n.lastHeartbeatAt,metadata:n.metadata,agentVersion:n.agentVersion});
 }
 // A CONNECTED surface is real presence: this City is being driven right now from that device.
 for(const s of surfaces)if(s.clientRef&&!retired.has(s.clientRef)){const prior=members.get(s.clientRef);add(s.clientRef,{displayName:prior?.displayName||s.clientLabel||'Web',role:prior?.role||'CONTROL_ONLY',online:true,controlOnline:true});}
 // The host is present only if one of its own surfaces is connected, or its own node is live.
 const host=members.get(hostDeviceId);
 if(host&&(surfaces.some(s=>s.clientRef===hostDeviceId)||(host.nodeId&&nodes.some(n=>n.id===host.nodeId&&n.online===true))))add(hostDeviceId,{online:true});
 return [...members.values()];
}
