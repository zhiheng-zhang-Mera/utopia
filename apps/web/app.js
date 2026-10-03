import {renderServices} from './services.js';
import {schedulerPanel} from './scheduler.js';
// UXI-301: the scheduler presentation feed, refreshed alongside the snapshot. When it is missing the
// panel says it is not being reported rather than rendering a healthy or idle surface.
let schedulerFeed=null;
import {renderTerminal,TERMINAL_PAGES} from './terminal.js';
import { t, applyTranslations, getLocale, setLocale, subscribe, formatTime, SUPPORTED_LOCALES, localeLabel } from './i18n/index.js';
// JOIN-501: the temporary pairing code is a SESSION with a lifecycle, not a render artifact. The state machine
// lives in its own module so that "no click = no code", "ACTIVE never rotates" and "USED/EXPIRED then generate
// again" are testable without a browser; this file only asks it questions.
import { createPairingLifecycle, REASON_EXPIRED, REASON_USED, REASON_REVOKED } from './pairing-lifecycle.js';
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let token=sessionStorage.getItem('city-token')||'',city=null,page=location.pathname==='/pairing'?'Pairing':'Home',selected=null,ws,generation=0,timer,refreshing=false,pending=false,connection='OFFLINE',selectedNode=null,pairingBusy=false,pairingEpoch=0,terminal=null,externalPage=TERMINAL_PAGES.includes(page),homeRoomsData=null,homeRoomsError='';
const finished=t=>['COMPLETED','FAILED','CANCELLED'].includes(t.state);
// JOIN-501: ONE lifecycle object owns the pairing session. It restores the SAME still-valid session after a
// reload and refuses to create a second one while one is ACTIVE. Nothing below may create pairing material
// except the explicit click handler.
const pairing=createPairingLifecycle();
// A reason the session stopped being active, expressed as the message key the page shows. The lifecycle module
// names the reason; the copy stays here with the other literals so the i18n key-coverage check sees it.
const pairingReasonMessage=reason=>reason===REASON_EXPIRED?'pairing.expired':reason===REASON_USED?'pairing.used':reason===REASON_REVOKED?'pairing.revoked':'';
// A snapshot for the current page. This is a pure read: rendering, refreshing and reconnecting call it freely
// and cannot change the session by doing so.
const pairingState=()=>pairing.snapshot();
// What the CITY says its one active session is. `pairing/info` is public (no credential) and is the canonical
// truth about whether a session is still live - which the city snapshot alone cannot say, because right after a
// reload the page is still OFFLINE and its descriptor is genuinely empty until the first fetch lands. Reading
// this endpoint creates nothing.
async function canonicalPairingSession(){
 try{
  const r=await fetch('/api/v0/pairing/info',{headers:{'X-City-Api-Version':'0','X-City-Schema-Version':'0'},signal:AbortSignal.timeout(4000)});
  const x=await r.json();
  if(!r.ok||!x)return {known:false};
  return {known:true,sessionId:x.descriptor?.pairingSessionId??null};
 }catch{return {known:false};}
}
// Reconcile a session restored from sessionStorage against the City. A reload must bring back the SAME session
// while it is valid, and must end as USED when another device consumed it while this page was away - but it
// must not read "the City is not carrying an active session" as "your code was used" while the session is
// still live. Only a definite answer from the City may end a restored session.
async function reconcileRestoredPairing(){
 if(pairing.ownerSessionId()===null)return;
 const canonical=await canonicalPairingSession();
 if(!canonical.known)return;
 if(canonical.sessionId===pairing.ownerSessionId())return;
 pairing.clearOnSessionChanged(canonical.sessionId);
 render();
}
// MESH-301: this control surface declares ITSELF on the event-stream handshake.
//
// The REF is generated once per browser profile and persisted, never derived from the label - the same rule
// the worker nodes follow, so a surface can be renamed without becoming a different surface. The LABEL is
// what the user calls it ("Alien Web", "Mech Web") and is deliberately settable, because two browsers on two
// hosts load the SAME canonical City and the page's own origin therefore cannot tell them apart.
function webClientRef(){let ref=null;try{ref=localStorage.getItem('utopia.clientRef');}catch{}if(!ref){ref='web-'+Math.random().toString(36).slice(2,10);try{localStorage.setItem('utopia.clientRef',ref);}catch{}}return ref;}
function webClientLabel(){let label=null;try{label=localStorage.getItem('utopia.clientLabel');}catch{}if(label)return label;return 'Web · '+(navigator.platform||'browser');}
// Exposed so the surface can be named from the console during a run: localStorage.setItem('utopia.clientLabel','Alien Web')
window.utopiaWebSurface={ref:webClientRef,label:webClientLabel,rename:name=>{try{localStorage.setItem('utopia.clientLabel',String(name));}catch{}return String(name);}};
// LOCAL BOOTSTRAP AND SHAREABLE INVITES.
//
// Two things a joining client needs that a bare token cannot give it:
//   1. to be opened ALREADY CONNECTED, so the launcher in the repository root can hand a browser a freshly
//      generated local token without anyone typing it;
//   2. to be handed SOMEBODY ELSE'S City - and that requires the token to say WHICH City it belongs to. An
//      opaque credential cannot, so the shareable form is the same `utopia://pair?...` payload the QR already
//      carries: host + cityId + one-time secret + expiry. Entering that switches City. Entering a bare token
//      keeps the old meaning of "connect to this page's own origin", because nothing else is well defined.
//
// Both arrive in the URL FRAGMENT, which browsers never send to a server, so a credential or a secret in it is
// not written into the City's logs. It is stripped from the address bar as soon as it has been read.
// The invite payload is parsed by a pure module so it can be tested without a browser; see apps/web/invite.js.
import {parseInvite} from './invite.js';
// 销毁本地令牌: the bootstrap token belongs to THIS City. Once this client moves to another City it is dead
// weight, so it is removed here rather than left behind in session storage for a later accidental reuse.
function destroyLocalToken(){try{sessionStorage.removeItem('city-token');}catch{}token='';}
async function exchangeInvite(value){
 // Accepts EITHER the raw invite string or an already-parsed invite. The first version of this only accepted the
 // string, and the connect handler passed it the parsed object instead - so it re-parsed "[object Object]", got
 // null, and the client reported "the City returned no credential" for an invite that was perfectly valid. The
 // type confusion was mine; accepting both shapes removes the trap rather than relying on every caller to
 // remember which one this function wants.
 const parsed=(typeof value==='string')?parseInvite(value):(value&&value.host?value:null);
 if(!parsed)return null;
 const here=location.origin.replace(/\/$/,''),there=String(parsed.host).replace(/\/$/,'');
 if(there!==here){
  // Switching City is a NAVIGATION, not a fetch: `pairing/exchange` is a route on the City that owns the
  // session, and the gateway sends no CORS headers for it, so a cross-origin POST from this page would be
  // refused by the browser. Carrying the invite to the target origin in its fragment keeps the exchange
  // same-origin and keeps the secret out of every server log on the way.
  destroyLocalToken();
  location.assign(there+'/#pair='+encodeURIComponent(parsed.invite));
  return {navigating:true};
 }
 const r=await fetch('/api/v0/pairing/exchange',{method:'POST',headers:{'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:JSON.stringify({cityId:parsed.cityId,method:'qr',sessionId:parsed.sessionId,secret:parsed.secret}),signal:AbortSignal.timeout(8000)});
 const x=await r.json().catch(()=>null);
 // Errors name the City that was actually asked. A generic "no credential" cannot tell "this City refused the
 // invite" from "this client asked the WRONG City", and those need completely different fixes.
 if(!r.ok)throw Error(`the City at ${here} refused that invite: ${x?.error||r.status}`);
 if(!x?.credential)throw Error(`the City at ${here} accepted the invite but returned no credential`);
 return {credential:x.credential};
}
const bootParams=new URLSearchParams(location.hash.replace(/^#/,''));
const bootToken=bootParams.get('token'),bootInvite=bootParams.get('pair');
// Exposed for the same reason window.utopiaWebSurface is: an acceptance run has to be able to exercise the invite
// path directly instead of only through a click, and a feature that can only be exercised by clicking is a
// feature no script can check.
window.utopiaInvite={parse:parseInvite,exchange:exchangeInvite,destroyLocalToken};
if(bootToken||bootInvite)history.replaceState(null,'',location.pathname+location.search);
if(bootToken){token=bootToken;try{sessionStorage.setItem('city-token',token);}catch{}}
// MESH-301: the strict-target choices are built from the City's OWN node list, so a target this surface
// offers is one the City currently knows about. Nothing here is hardcoded, and "Any node" stays reachable:
// a surface that can only issue TARGETED work makes the untargeted regression check impossible to perform
// from that surface, and that check is completion-gate 7.
let runTargetSignature='';
function syncRunTargets(){
 const select=$('#run-target');if(!select)return;
 const nodes=Array.isArray(city?.nodes)?city.nodes:[];
 const signature=nodes.map(n=>n.id).join(',');
 if(signature===runTargetSignature)return;   // rebuild only when the fleet changes, so a live render loop cannot steal the user's choice
 runTargetSignature=signature;
 const current=select.value;
 select.innerHTML='<option value="">Any node</option>'+nodes.map(n=>`<option value="${esc(n.id)}">${esc(n.displayName||n.id)}</option>`).join('');
 select.value=nodes.some(n=>n.id===current)?current:'';
}
async function api(path,body){const r=await fetch('/api/v0/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(path.startsWith('capabilities/')?25000:5000)});const x=await r.json();if(!r.ok)throw Error(x.error);if(x.apiVersion!==0||x.schemaVersion!==0)throw Error('Protocol mismatch: this client requires version 0');return x;}
function clearPairing(message=''){pairing.clear(message);}
// The explicit generator. This is the ONLY function in the page that may create pairing material, and it is reached only from the click handler above. It refuses to run while a session is ACTIVE, so a doubled click or a stale button cannot rotate the code.
async function generatePairing(){
 // The lifecycle refuses while ACTIVE; the busy flag covers the in-flight window so a double click cannot start two sessions either. The existing code is NEVER blanked before the new one exists: if the request fails, the user keeps what they had.
 if(!pairingState().generate.available||pairingBusy||connection!=='ONLINE')return;
 const epoch=++pairingEpoch;pairingBusy=true;render();
 let error='';
 try{
  const result=await api('pairing/session',{});
  if(epoch===pairingEpoch)pairing.create(result);
 }catch(err){error=err.message;}
 finally{
  pairingBusy=false;
  if(error)$('#error').textContent=error;
  render();
 }
}
// JOIN-501: navigation is NOT a reason to destroy a temporary pairing code. The old implementation cleared on
// every `go()`, which is exactly the "code disappears early" behaviour the Owner rule forbids. The session now
// outlives page navigation and is only ended by consumption, expiry, or an explicit action.
function go(next){page=next;selected=null;selectedNode=null;externalPage=TERMINAL_PAGES.includes(next);if(terminal&&externalPage)terminal.onNav();document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('selected',b.dataset.page===page));if(!externalPage)homeRoomsData=null;render();window.scrollTo({top:0});}
function mountTerminal(){if(!TERMINAL_PAGES.includes(page)||!token)return;terminal=renderTerminal($('#view'),city,connection==='ONLINE',api,{page,go,api});}
function ask(input){const value=String(input??'').trim();if(!value||!token)return;if(page!=='Ask/Do')go('Ask/Do');if(!terminal)mountTerminal();terminal?.submit(value);}
function homeRoomRows(data){
 const rooms=(Array.isArray(data.rooms)?data.rooms:[]).slice(0,10);
 if(!rooms.length)return `<p class="muted">${esc(t('terminal.rooms.malformed'))}</p>`;
 if(data.available!==true)return `<p class="muted">${esc(t('terminal.rooms.unavailableTitle'))}${data.reason?' · '+esc(data.reason):''}</p><button data-goto="Rooms">${esc(t('home.rooms.open'))}</button>`;
 return `<p class="muted">${esc(t('home.rooms.count',{count:rooms.length}))}</p><div class="grid home-rooms">`+rooms.map(r=>`<button class="card home-room" data-goto="Rooms"><div class="row"><div><strong>${esc(r.label)}</strong><p class="muted">${esc(r.zh??'')}</p><small class="task-id">${esc(r.number??'')}</small><details><summary>${esc(t('common.runDetails'))}</summary><div class="task-id">${esc(r.id)}</div></details></div>${badge(r.persistent===true?t('terminal.rooms.persistent'):t('terminal.rooms.ephemeral'))}</div><p class="muted">${esc(r.summary??'')}</p></button>`).join('')+`</div><button data-goto="Rooms">${esc(t('home.rooms.open'))}</button>`;
}
function renderHomeRooms(){
 const host=$('#home-rooms-body');if(!host)return;
 host.innerHTML=homeRoomsData?homeRoomRows(homeRoomsData):homeRoomsError?`<p class="muted">${esc(homeRoomsError)}</p>`:`<p class="muted">${esc(t('terminal.loading'))}</p>`;
}
function homeRooms(){
 if(homeRoomsData||homeRoomsError||!token)return renderHomeRooms();
 api('rooms').then(payload=>{homeRoomsData=payload?.rooms??null;if(!homeRoomsData)homeRoomsError=t('terminal.rooms.malformed');}).catch(e=>{homeRoomsError=e.message;}).finally(renderHomeRooms);
}
function status(s){connection=s;$('#connection').textContent=t('connection.'+s.toLowerCase());$('#connection').className=s==='ONLINE'?'online':'';$('#run').disabled=s!=='ONLINE';render();}
async function refresh(){if(refreshing){pending=true;return;}if(externalPage&&city)return;refreshing=true;try{const gen=generation;const snapshot=await api('city');if(gen!==generation)return;city=snapshot;syncRunTargets();try{schedulerFeed=await api('presentation');}catch{schedulerFeed=null;}if(pairing.ownerSessionId()!==null&&city.descriptor?.pairingSessionId!==pairing.ownerSessionId()){const active=pairing.ownerSessionId();canonicalPairingSession().then(c=>{if(!c.known)return;if(c.sessionId===active)return;pairing.clearOnSessionChanged(c.sessionId);render();});}$('#pair').hidden=true;$('#content').hidden=false;$('#error').textContent='';render();}finally{refreshing=false;if(pending){pending=false;refresh().catch(disconnected);}}}
function disconnected(e){status('OFFLINE');if(e?.message)$('#error').textContent=e.message;}
async function connect(){const gen=++generation;clearTimeout(timer);ws?.close();status('RECONNECTING');try{await refresh();if(gen!==generation)return;ws=new WebSocket(location.origin.replace(/^http/,'ws')+'/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef='+encodeURIComponent(webClientRef())+'&clientLabel='+encodeURIComponent(webClientLabel()),['city-v0','city-token.'+btoa(token).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')]);ws.onopen=()=>{if(gen===generation)status('ONLINE');};ws.onmessage=()=>refresh().catch(disconnected);ws.onerror=()=>disconnected();ws.onclose=()=>{if(gen===generation){disconnected();timer=setTimeout(connect,1800);}};}catch(e){if(gen===generation){disconnected(e);timer=setTimeout(connect,2500);}}}
const badge=(stateClass, displayLabel=stateClass)=>`<span class="badge ${esc(stateClass)}">${esc(displayLabel)}</span>`;
const taskRows=(tasks,emptyMessage=t('empty.noTasks'))=>tasks.length?tasks.slice().reverse().map(t=>`<div class="row"><button class="task-open" data-task="${esc(t.id)}">${esc(t.type)}<div class="task-id">${esc(t.id)}</div></button>${badge(t.state)}</div>`).join(''):`<p class="muted">${esc(emptyMessage)}</p>`;
const age=value=>{const ms=Date.now()-Date.parse(value);return Number.isFinite(ms)?t('device.ago',{seconds:Math.max(0,Math.floor(ms/1000))}):t('device.unknown');};
const bytes=value=>Number.isFinite(value)?(value/1024**3).toFixed(1)+' GB':t('device.unknown');
const nodeState=n=>connection!=='ONLINE'?'UNKNOWN':!n.online?'OFFLINE':fresh(n)?'ONLINE':'UNKNOWN';
const nodeBadge=n=>{const state=nodeState(n);const label=state==='UNKNOWN'?t('node.unknown'):t('connection.'+state.toLowerCase());return badge(state,label);};
const fresh=n=>connection==='ONLINE'&&n.online&&Number.isFinite(Date.parse(n.telemetry?.observedAt))&&Date.now()-Date.parse(n.telemetry.observedAt)<=10000&&Date.now()>=Date.parse(n.telemetry.observedAt);
const metrics=n=>{const sample=n.telemetry||{},valid=fresh(n);return `<div class="telemetry ${valid?'fresh':'cached'}"><p class="muted">${valid?t('device.live'):t('device.cached')} · ${esc(t('device.observed'))} ${esc(age(sample.observedAt))}</p><dl class="metrics"><div><dt>CPU</dt><dd>${Number.isFinite(sample.cpu?.usagePercent)?esc(sample.cpu.usagePercent.toFixed(1))+'%':t('device.unknown')}</dd></div><div><dt>${esc(t('device.memory'))}</dt><dd>${bytes(sample.memory?.usedBytes)} / ${bytes(sample.memory?.totalBytes)}</dd></div><div><dt>${esc(t('device.disk'))}</dt><dd>${bytes(sample.disk?.usedBytes)} / ${bytes(sample.disk?.totalBytes)}<small>${esc(t('device.free'))} ${bytes(sample.disk?.freeBytes)}</small></dd></div><div><dt>${esc(t('device.uptime'))}</dt><dd>${Number.isFinite(sample.uptimeSeconds)?Math.floor(sample.uptimeSeconds/3600)+'h '+Math.floor(sample.uptimeSeconds%3600/60)+'m':t('device.unknown')}</dd></div></dl></div>`;};
const nodeRows=()=>city.nodes.map(n=>`<article class="device-card"><div class="row"><div class="node-info"><span class="node-icon" aria-hidden="true"></span><div><button class="task-open" data-node="${esc(n.id)}">${esc(n.displayName)}</button><p class="muted">${esc(n.metadata?.platform)} · ${esc(t('device.agent'))} ${esc(n.agentVersion||t('device.unknown'))}</p><small>${connection==='ONLINE'?'':t('device.cachedPrefix')}${esc(t('device.lastSeen'))} ${esc(age(n.lastHeartbeatAt))}</small></div></div>${nodeBadge(n)}</div>${metrics(n)}</article>`).join('')||`<p class="muted">${esc(t('empty.waitingRuntimeNode'))}</p>`;
const cityUrl=()=>{const e=city.descriptor?.endpoint;return e?e.scheme+'://'+e.host+':'+e.port:location.origin;};
function pairingView(){
 const d=city.discovery||{},ps=pairingState(),remaining=ps.remainingSeconds||0;
 return `<section class="panel"><h2>${esc(t('pairing.title'))} ${esc(city.displayName||t('pairing.yourCity'))}</h2><p>${esc(t('settings.cityUrl'))}: ${esc(cityUrl())}</p><p class="task-id">${esc(t('pairing.cityId'))}: ${esc(city.cityId||t('device.unknown'))}</p><p>${esc(t('pairing.session'))}: ${esc(ps.session?.pairingSessionId||city.descriptor?.pairingSessionId||t('pairing.none'))}</p><p class="muted">${esc(pairingReasonMessage(ps.notice)?t(pairingReasonMessage(ps.notice)):'')}</p>${ps.session?`<div class="pairing-material"><div id="pairing-qr" role="img" aria-label="${esc(t('pairing.qr'))}"></div><div><p>${esc(t('pairing.code'))}</p><strong id="pairing-code">${esc(ps.session.shortCode)}</strong><p id="pairing-countdown">${esc(t('pairing.countdown',{seconds:remaining}))}</p><p>${esc(t('pairing.single'))}</p></div></div><div class="pairing-share"><h3>${esc(t('pairing.share'))}</h3><p class="muted">${esc(t('pairing.shareHint'))}</p><textarea id="pairing-invite" readonly rows="3" spellcheck="false">${esc(ps.session.qrPayload)}</textarea><button id="copy-invite">${esc(t('pairing.copy'))}</button><p class="muted" id="copy-note"></p></div>`:''}<button id="generate-pairing" ${connection!=='ONLINE'||pairingBusy||!ps.generate.available?'disabled':''}>${ps.generate.available?t(ps.generate.label):t('pairing.active')}</button><p class="muted">${esc(t('pairing.explanation'))}</p><h3>${esc(t('section.connectionDiagnostics'))}</h3><p>mDNS: ${esc(d.mdns?.state||'UNKNOWN')} · ${esc(d.mdns?.reason||'')}</p><p>Bluetooth: ${esc(d.ble?.state||'UNKNOWN')} · ${esc(d.ble?.reason||'')}</p><p>Gateway: ${esc(connection)}</p><details><summary>${esc(t('common.runDetails'))}</summary><div class="task-id">apiVersion 0 · schemaVersion 0</div></details><h3>${esc(t('pairing.choose'))}</h3><ol><li><strong>QR:</strong> ${esc(t('pairing.qrHelp'))}</li><li><strong>${esc(t('pairing.lan'))}:</strong> ${esc(t('pairing.lanHelp'))}</li><li><strong>${esc(t('pairing.ble'))}:</strong> ${esc(t('pairing.bleHelp'))}</li><li><strong>${esc(t('pairing.manual'))}:</strong> ${esc(t('pairing.manualHelp'))}</li></ol><p>${esc(t('pairing.plane'))}</p><p class="lan-warning">LAN DEVELOPMENT ONLY · NOT FOR PUBLIC INTERNET</p></section>`;
}
/* UI-101 step 5: the default reading path shows a readable label, and the raw
   internal vocabulary (event type, sequence, task id) lives in a folded
   run-details block instead of being printed on the surface. */
const EVENT_LABELS={'CLIENT_CONNECTED':'event.clientConnected','CITY_STARTED':'event.cityStarted','task.completed':'event.taskCompleted','task.progress':'event.taskProgress','task.cancelled':'event.taskCancelled','node.heartbeat':'event.nodeHeartbeat'};
const events=(list,raw=false)=>list.slice().reverse().map(e=>`<div class="event"><time>${esc(formatTime(e.timestamp))}</time><strong>${esc(raw?e.type:t(EVENT_LABELS[e.type]||'event.other'))}</strong><details><summary>${esc(t('common.runDetails'))}</summary><div class="task-id">${raw?'':' '+esc(e.type)+' · '}#${esc(e.seq)} · ${esc(e.taskId||'City')}</div></details></div>`).join('');
function languageSection(){const current=getLocale();return `<h2>${esc(t('settings.interface'))}</h2><p>${esc(t('settings.language'))}</p><div class="lang-row" id="language">${SUPPORTED_LOCALES.map(l=>`<button class="lang-option${l===current?' selected':''}" data-locale="${esc(l)}" aria-pressed="${l===current}">${esc(localeLabel(l))}</button>`).join('')}</div><p class="muted">${esc(t('settings.languageHint'))}</p>`;}
/* UI-101 step 3: Home leads with the assistant and with what is happening now
   rather than with statistic tiles. The slot is presentational only and exposes no
   control - a rendered control that does nothing is exactly the false-affordance
   defect the UI-000 review already caught once. There is no character art in this
   repository, so the portrait is an honest placeholder silhouette and the copy
   says so; per v2 invariant 4 the assistant's naming, appearance, voice and duty
   are Owner-configurable later. */
const ASSISTANT_ART=`<svg viewBox="0 0 200 240" fill="none" stroke="#5ee7ff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M26 240c0-38 18-58 44-66l30-8 30 8c26 8 44 28 44 66" stroke="#8b5cf6"/><path d="M70 174l30 22 30-22"/><path d="M100 196v44" stroke="#8b5cf6"/><path d="M86 140v22c0 7 6 12 14 12s14-5 14-12v-22"/><path d="M62 96c0-26 17-44 38-44s38 18 38 44c0 30-17 50-38 50S62 126 62 96Z"/><path d="M56 92c2-30 20-50 44-50s42 20 44 50" stroke="#c6f24e"/><path d="M56 92c8 4 14 2 20-4M144 92c-8 4-14 2-20-4" stroke="#c6f24e"/><path d="M100 42c-6 12-6 26 2 36" stroke="#c6f24e"/><path d="M74 100h20M106 100h20"/><path d="M78 112c8 5 16 5 24 0" opacity=".65"/><circle cx="100" cy="184" r="4" stroke="#c6f24e"/></svg>`;
function assistantSlot(){
  const online=city.nodes.filter(n=>n.online);
  return `<section class="operator"><div class="op-frame"><span class="op-side"></span><span class="op-tag">${esc(t('assistant.role'))}</span><div class="op-art">${ASSISTANT_ART}</div><span class="op-slot">SLOT 01</span></div><div class="op-body"><p class="op-role">${esc(t('assistant.role'))} · ASSISTANT</p><p class="op-name">${esc(t('assistant.unassigned'))}</p><p class="op-sub">${esc(t('assistant.note'))}</p><dl class="kv"><dt>${esc(t('assistant.boundDevice'))}</dt><dd>${esc(online[0]?.displayName||t('assistant.pending'))}</dd><dt>${esc(t('assistant.appearance'))}</dt><dd>${esc(t('assistant.placeholderValue'))}</dd><dt>${esc(t('assistant.voice'))}</dt><dd>${esc(t('assistant.disabled'))}</dd><dt>${esc(t('assistant.duty'))}</dt><dd>${esc(t('assistant.pending'))}</dd></dl></div></section>`;
}
function render(){
 $('#ask-form').hidden=$('#content').hidden;
 if(!city){$('#heading').textContent=t('heading.'+page.toLowerCase());if(terminal)terminal.render($('#view'));return;}
 $('#heading').textContent=t('heading.'+page.toLowerCase());$('#updated').textContent=t('status.lastSnapshot',{time:formatTime(city.updatedAt)});
 const tasks=city.tasks;
 if(page==='Home')$('#view').innerHTML=assistantSlot()+`<div class="grid" style="margin-top:14px"><section class="panel"><h2>${esc(t('section.runtimeNodes'))}</h2>${nodeRows()}</section><section class="panel"><h2>${esc(t('section.recentActivity'))}</h2>${events(city.events.slice(-4))}</section></div><section class="panel" style="margin-top:12px" id="home-rooms"><h2>${esc(t('section.homeRooms'))}</h2><p class="muted">${esc(t('home.rooms.hint'))}</p><div id="home-rooms-body"><p class="muted">${esc(t('terminal.loading'))}</p></div></section><section class="panel" style="margin-top:12px"><h2>${esc(t('section.recentTasks'))}</h2>${taskRows(tasks.slice(-5))}</section>`;
 if(page==='Home')homeRooms();
 if(page==='Services')renderServices($('#view'),city,connection==='ONLINE',api);
 // Terminal pages mount lazily: `terminal` is only created once a terminal page is shown,
 // which is why this must not depend on `terminal` already existing.
 if(TERMINAL_PAGES.includes(page)){if(!terminal)mountTerminal();if(terminal)terminal.render($('#view'),city,connection==='ONLINE',api,{page,go,api});}
 if(page==='Devices')$('#view').innerHTML=schedulerPanel(schedulerFeed,{isOnline:connection==='ONLINE',advanced:true})+`<section class="panel">${nodeRows()}</section>`;
 if(page==='Tasks')$('#view').innerHTML=`<section class="panel"><h2>${esc(t('section.taskRegistry'))}</h2>${taskRows(tasks)}</section>`;
 if(page==='Activity')$('#view').innerHTML=`<section class="panel"><h2>${esc(t('section.eventTimeline',{count:city.events.length}))}</h2><button data-goto="Actions">${esc(t('nav.actions'))}</button>${events(city.events)}</section>`;
 if(page==='Settings')$('#view').innerHTML=`<section class="panel">${languageSection()}<h2>${esc(t('section.connectionDiagnostics'))}</h2><p>${esc(t('settings.cityUrl'))}: ${esc(location.origin)}</p><details><summary>${esc(t('common.runDetails'))}</summary><div class="task-id">apiVersion = 0 · schemaVersion = 0</div></details><p>${esc(t('settings.tokenNote'))}</p><button id="disconnect">${esc(t('settings.changeToken'))}</button></section>`;
 if(page==='Pairing'){$('#view').innerHTML=pairingView();const ps=pairingState();if(ps.session&&$('#pairing-qr'))$('#pairing-qr').innerHTML=ps.session.qrSvg;}
 const detail=city.tasks.find(t=>t.id===selected);$('#detail').hidden=!detail;if(detail)$('#detail').innerHTML=`<h2>${esc(detail.type)}</h2><div class="task-id">${esc(detail.id)}</div><p>${badge(detail.state)} · ${esc(detail.assignedNodeId||t('status.waitingNode'))}</p><progress max="100" value="${detail.progress}"></progress><h3>${esc(t('section.checkpoint'))}</h3><pre>${esc(JSON.stringify(detail.lastCheckpoint,null,2))}</pre><h3>${esc(t('section.result'))}</h3><pre>${esc(JSON.stringify(detail.result||detail.error,null,2))}</pre>${!finished(detail)?`<button id="cancel">${esc(t('task.cancel'))}</button>`:''}<h3>${esc(t('section.taskEvents'))}</h3>${events(city.events.filter(e=>e.taskId===detail.id))}`;
 const device=city.nodes.find(n=>n.id===selectedNode);if(device){$('#detail').hidden=false;$('#detail').innerHTML=`<h2>${esc(device.displayName)}</h2><p>${nodeBadge(device)} · ${esc(device.metadata?.platform)} · ${esc(t('device.agent'))} ${esc(device.agentVersion||t('device.unknown'))}</p><p class="task-id">${esc(device.id)}</p><p>${esc(t('device.lastSeen'))} ${esc(age(device.lastHeartbeatAt))}</p>${metrics(device)}<h3>${esc(t('device.capabilities'))}</h3><p>${esc(device.capabilities.join(' / '))}</p><h3>${esc(t('device.currentTasks'))}</h3>${taskRows(tasks.filter(t=>t.assignedNodeId===device.id&&!finished(t)),t('device.noTasks'))}<h3>${esc(t('device.recentEvents'))}</h3>${events(city.events.filter(e=>e.payload?.nodeId===device.id||tasks.some(t=>t.id===e.taskId&&t.assignedNodeId===device.id)).slice(-12),true)||`<p class="muted">${esc(t('device.noEvents'))}</p>`}`;}
}
document.addEventListener('click',async e=>{const nav=e.target.closest('[data-page]'),task=e.target.closest('[data-task]'),node=e.target.closest('[data-node]'),locale=e.target.closest('[data-locale]'),goto=e.target.closest('[data-goto]'),room=e.target.closest('[data-home-room]'),schedAction=e.target.closest('[data-scheduler-action]');if(locale)setLocale(locale.dataset.locale);if(goto)go(goto.dataset.goto);if(nav)go(nav.dataset.page);if(room)go('Rooms');if(node){selectedNode=node.dataset.node;selected=null;render();$('#detail').scrollIntoView({behavior:'smooth'});}if(task){selectedNode=null;selected=task.dataset.task;render();$('#detail').scrollIntoView({behavior:'smooth'});}
// UXI-301: a scheduler action the user takes must REALLY RETURN to the backend, which is an acceptance
// item the independent review checks. The route comes from the shared ACTION_WIRING table, and the
// task id from the button, so the panel and this dispatcher cannot disagree about what is wired.
if(schedAction){const token=schedAction.dataset.schedulerAction,taskRef=schedAction.dataset.schedulerTask,route=schedAction.dataset.schedulerRoute,providerRef=schedAction.dataset.schedulerProvider;schedAction.disabled=true;try{if(route==='cancel'){await api('tasks/'+encodeURIComponent(taskRef)+'/cancel',{});}else if(route==='create'){await api('tasks',{type:'CHECKPOINT_DEMO'});}else if(route==='providerChoice'){if(!providerRef)throw new Error('no provider was offered to choose from');await api('tasks/'+encodeURIComponent(taskRef)+'/provider-choice',{providerRef});}else{/* local acknowledgement: nothing to send */}await refresh();}catch(err){$('#error').textContent=err.message;schedAction.disabled=false;}}
if(e.target.id==='copy-invite'){const box=$('#pairing-invite'),note=$('#copy-note');const done=ok=>{if(note)note.textContent=t(ok?'pairing.copied':'pairing.copyManual');};const fallback=()=>{try{box.focus();box.select();return document.execCommand('copy');}catch{return false;}};if(navigator.clipboard?.writeText){navigator.clipboard.writeText(box.value).then(()=>done(true)).catch(()=>done(fallback()));}else done(fallback());}
if(e.target.id==='generate-pairing'){await generatePairing();}if(e.target.id==='cancel'){try{await api('tasks/'+selected+'/cancel',{});await refresh();}catch(err){$('#error').textContent=err.message;}}if(e.target.id==='disconnect'){clearPairing();token='';$('#token').value='';sessionStorage.removeItem('city-token');++generation;clearTimeout(timer);ws?.close();$('#pair').hidden=false;$('#content').hidden=true;go('Home');status('OFFLINE');}});
$('#connect').onclick=async()=>{const value=$('#token').value.trim();$('#token').value='';const invite=parseInvite(value);if(invite){try{const done=await exchangeInvite(invite);if(done?.navigating)return;if(!done?.credential)throw Error('the City returned no credential for that invite');token=done.credential;sessionStorage.setItem('city-token',token);$('#pair').hidden=true;$('#content').hidden=false;connect();}catch(err){$('#error').textContent=err.message;}return;}token=value;sessionStorage.setItem('city-token',token);connect();};
$('#ask-form').addEventListener('submit',e=>{e.preventDefault();ask($('#ask-text').value);});
$('#run').onclick=async()=>{try{$('#run').disabled=true;const target=$('#run-target')?.value||'';if(target){const created=await api('actions',{route:'CITY_TASK',target:'city.task',operation:'CHECKPOINT_DEMO',input:{targetDeviceRef:target},idempotencyKey:(crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+Math.random())});const id=created?.action?.backendRef?.taskId;if(!id)throw new Error(created?.action?.error?.message||'the City refused the targeted task');selectedNode=null;selected=id;}else{const task=await api('tasks',{type:'CHECKPOINT_DEMO'});selectedNode=null;selected=task.id;}await refresh();}catch(e){$('#error').textContent=e.message;}finally{$('#run').disabled=connection!=='ONLINE';}};
window.addEventListener('offline',()=>{disconnected();ws?.close();});window.addEventListener('online',connect);
setInterval(()=>{if(token&&ws?.readyState===1)refresh().catch(e=>{disconnected(e);ws.close();});},4000);
setInterval(()=>{if(pairing.expireIfDue())render();else{const ps=pairingState();if(ps.session&&$('#pairing-countdown'))$('#pairing-countdown').textContent=t('pairing.countdown',{seconds:ps.remainingSeconds});}if(city&&(page==='Home'||page==='Devices'))render();},1000);
// JOIN-501: leaving the page no longer destroys the code. The material is persisted instead, so a reload restores the SAME session while it is still valid - and a session that expired meanwhile comes back EXPIRED, never as a fresh code. Visibility is handled too: a tab hidden across the expiry moment reconciles the moment it is shown, rather than sitting on a dead code.
window.addEventListener('pagehide',()=>pairing.persist());
document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible')return;if(pairing.expireIfDue())render();});
document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('selected',b.dataset.page===page));
subscribe(()=>{applyTranslations();$('#connection').textContent=t('connection.'+connection.toLowerCase());render();});
applyTranslations();
// A client may have been opened with an INVITE in its fragment (the launcher, or a hand-off from another City).
// Resolving it here means the page arrives already connected to the City the invite names, without the user
// typing anything and without the secret ever reaching a server as part of a URL.
if(bootInvite){
 try{
  const done=await exchangeInvite(bootInvite);
  if(done?.credential){token=done.credential;try{sessionStorage.setItem('city-token',token);}catch{}}
 }catch(err){$('#error').textContent=err.message;}
}
// The stored session is restored BEFORE the first render and reconciled against the City once the first snapshot arrives, so a code another device consumed while this page was away is not shown as ACTIVE.
pairing.restore();
if(token)connect();else status('OFFLINE');
if(token){$('#pair').hidden=true;$('#content').hidden=false;mountTerminal();}
if(pairing.ownerSessionId()!==null)reconcileRestoredPairing().catch(()=>{});
