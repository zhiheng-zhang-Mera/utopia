import {renderServices} from './services.js';
import {schedulerPanel} from './scheduler.js';
// UXI-301: the scheduler presentation feed, refreshed alongside the snapshot. When it is missing the
// panel says it is not being reported rather than rendering a healthy or idle surface.
let schedulerFeed=null;
import {renderTerminal,TERMINAL_PAGES} from './terminal.js';
import { t, applyTranslations, getLocale, setLocale, subscribe, formatTime, SUPPORTED_LOCALES, localeLabel } from './i18n/index.js';
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let token=sessionStorage.getItem('city-token')||'',city=null,page=location.pathname==='/pairing'?'Pairing':'Home',selected=null,ws,generation=0,timer,refreshing=false,pending=false,connection='OFFLINE',selectedNode=null,pairing=null,pairingBusy=false,pairingEpoch=0,pairingNotice='',terminal=null,externalPage=TERMINAL_PAGES.includes(page),homeRoomsData=null,homeRoomsError='';
// JOIN-502 ONBOARDING STATE. `nearby` is what the last browse found; `joinAsk` is the ask this surface
// has outstanding, if any. They are separate because discovery is repeatable and an ask is a single
// bounded episode: a fresh browse must never silently replace or re-create an ask that a human on the
// other machine is being asked to decide.
let nearby=null,nearbyBusy=false,nearbyError='',joinAsk=null,joinBusy=false,joinError='',joinPoll=null,joinAskEpoch=0;
/** Metres of trust: this is the whole reason the claim exists. Only the browser that created the ask
 *  holds this secret, so a second machine on the same LAN cannot adopt the ask by reading the City. It
 *  lives in sessionStorage, never localStorage: it is a tab-scoped episode, not a device credential. */
const CLAIM_KEY='utopia.join.claim';
function joinClaim(){let claim=null;try{claim=sessionStorage.getItem(CLAIM_KEY);}catch{}if(!claim){claim=(crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(36).slice(2))+Math.random().toString(36).slice(2);try{sessionStorage.setItem(CLAIM_KEY,claim);}catch{}}return claim;}
/** A per-installation hint so the City can recognise a retrying client instead of stacking duplicate
 *  approval cards. It is a REFERENCE, not an identity: the City stores no key against it and the
 *  approver sees it only as context. Durable identity arrives with device enrollment (JOIN-503). */
function installationHint(){let hint=null;try{hint=localStorage.getItem('utopia.installation');}catch{}if(!hint){hint='install-'+Math.random().toString(36).slice(2,12);try{localStorage.setItem('utopia.installation',hint);}catch{}}return hint;}
const finished=t=>['COMPLETED','FAILED','CANCELLED'].includes(t.state);
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
// JOIN-502: the nearby-City adapter and the ask-to-join lifecycle. The adapter is a pure module, so the
// dedup/freshness rules can be tested without a browser; this file owns only state and rendering.
import {nearbyCities, probeNearby} from './discovery.js';
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
// JOIN-502: the joining surface holds no City credential yet - that is what it is asking for - so these
// three calls authenticate with the CLAIM it generated instead. The envelope carries apiVersion 0 like
// every other call, and an error message is passed through rather than flattened, because "not approved
// yet" and "rejected" need different words on screen.
async function joinApi(path,body){const r=await fetch('/api/v0/join/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(8000)});const x=await r.json().catch(()=>null);if(x&&x.apiVersion!==0)throw Error('Protocol mismatch: this client requires version 0');if(!r.ok){const e=Error(x?.error||('join request failed: '+r.status));e.status=r.status;throw e;}return x;}
// The browse is authenticated (it is served by the City that owns this page) while the ask is not: the
// City being asked is the one the browse found, which this page has no credential for.
async function browseApi(path){const r=await fetch('/api/v0/'+path,{method:'GET',headers:{Authorization:'Bearer '+token,'X-City-Api-Version':'0','X-City-Schema-Version':'0'},signal:AbortSignal.timeout(8000)});const x=await r.json().catch(()=>null);if(!r.ok)throw Error(x?.error||('browse failed: '+r.status));return x;}
/**
 * JOIN-502: ASK a nearby City to let this installation join.
 *
 * WHY THIS IS A NAVIGATION AND NOT A POST. `join/request` is a route on the City being asked, and that
 * City is a different origin from the page that discovered it. The gateway serves no CORS headers (the
 * pairing exchange has the same property, see exchangeInvite), so a cross-origin POST would be refused
 * by the browser - and "fix" for that would mean opening the City's join routes to any web page, which
 * is a worse trade than carrying the ask in a fragment. So the browse happens here, and the ASK is
 * carried to the target origin in its own fragment, exactly like the `#pair=` invite already does.
 * Browsers never send a fragment to a server, so the claim secret is not written into any City log,
 * and the target page strips it from the address bar as soon as it has read it.
 *
 * The ask is `{hint, claim}` and nothing else that matters: `displayName` is re-derived at the target
 * from the page's own surface label, so the value on the approval card is the one the joining surface
 * actually calls itself, not one this page could have forged for it.
 */
function askToJoin(endpoint, cityRef){
 const target=String(endpoint||'').replace(/\/$/,'');
 if(!/^https?:\/\/[^\s]+$/.test(target)){joinError='join.errorUnreachable';render();return;}
 const claim=joinClaim();
 const fragment=new URLSearchParams({v:'1',hint:installationHint(),claim});
 if(cityRef)fragment.set('city',String(cityRef).slice(0,80));
 // SAME ORIGIN: `location.assign` with only a fragment added is a SAME-DOCUMENT navigation, so the page
 // would not reload, the boot path would never run, and the ask would silently never be recorded - which
 // is exactly how this failed the first time it was exercised. Asking the page we are already on is also
 // the case where nothing needs carrying anywhere, so the ask is delivered directly.
 if(target===location.origin.replace(/\/$/,'')){resumeJoin({hint:fragment.get('hint'),claim,cityRef:cityRef||null});return;}
 // CROSS ORIGIN: destroy this City's session credential before leaving, the same rule the invite switch
 // follows - a credential for the City we are leaving is dead weight at the new one.
 destroyLocalToken();
 location.assign(target+'/#join='+encodeURIComponent(fragment.toString()));
}
/** JOIN-502: arriving with an ask to deliver. The browse handed the ask to this origin in its fragment,
 *  so this function is what turns "a nearby PC picked this City" into a recorded request. It is
 *  idempotent by construction: the City recognises the installation hint and answers with the row it
 *  already has rather than creating a second approval card. */
async function resumeJoin({hint, claim, cityRef}){
 const pending={hint,claim,cityRef};
 try{
  /** The pinned identity is CHECKED, never trusted. A link that names a City different from the one that
   *  received it is a mis-addressed ask, and delivering it here would ask the wrong owner to approve
   *  another City's join. */
  if(cityRef&&city&&cityRef!==city.cityId){joinError='join.errorRejected';render();return;}
  const ask=await joinApi('request',{displayName:webClientLabel(),platform:navigator.platform||'browser',installationHint:typeof pending.hint==='string'?pending.hint:installationHint(),origin:location.origin,claim:pending.claim});
  if(!ask?.id)throw Error('that City created no join request');
  joinAsk={requestId:ask.id,state:ask.state,claim:pending.claim,joinEndpoint:location.origin,displayName:webClientLabel(),hint:pending.hint??null};
  render();
  waitForDecision(joinAsk);
 }catch(err){
  joinAsk=null;joinError=joinErrorKey(err);render();
 }
}
function joinErrorKey(error){
 if(error?.status===403)return 'join.errorRejected';
 if(error?.status===429)return 'join.errorBusy';
 if(error?.status===404)return 'join.errorUnreachable';
 return 'join.errorUnreachable';
}
/** A refused ask still has a STATE, and the state is what the surface shows. Reporting every failure as
 *  EXPIRED is how a rejection first reached the user as "no longer valid" - true of the request, useless
 *  to the person reading it. The status decides which terminal state is true. */
function joinTerminalState(error){
 if(error?.status===403)return 'REJECTED';
 return 'EXPIRED';
}
/** Poll until the owner decides. Bounded, cancellable, and it NEVER creates a second ask: approval
 *  leads to exactly one credential exchange, and every terminal state stops the poll for good. All
 *  calls are SAME-ORIGIN, because this runs on the City being joined (see askToJoin). */
function waitForDecision(ask){
 clearInterval(joinPoll);const epoch=++joinAskEpoch;const deadline=Date.now()+10*60*1000;
 joinPoll=setInterval(async()=>{
  if(epoch!==joinAskEpoch||!joinAsk||joinAsk.requestId!==ask.requestId){clearInterval(joinPoll);return;}
  if(Date.now()>deadline){clearInterval(joinPoll);joinAsk={...joinAsk,state:'EXPIRED'};render();return;}
  try{
   const state=await joinApi('status',{requestId:ask.requestId,claim:ask.claim});
   if(state.state!==joinAsk.state){joinAsk={...joinAsk,state:state.state};render();}
   if(state.state==='APPROVED'){
    clearInterval(joinPoll);
    const collected=await joinApi('exchange',{requestId:ask.requestId,claim:ask.claim});
    if(!collected?.credential)throw Error('that City approved the request but returned no credential');
    // The City's credential becomes this tab's session credential exactly as a pasted token would. It is
    // session-scoped on purpose: durable device identity is JOIN-503's work, not a browser's.
    token=collected.credential;try{sessionStorage.setItem('city-token',token);}catch{}
    joinAsk={...joinAsk,state:'CONSUMED'};
    $('#pair').hidden=true;$('#content').hidden=false;connect();
   }
  }catch(err){
   clearInterval(joinPoll);
   // A refused claim is the requester's own ask being answered; anything else is the City going away.
   joinAsk={...joinAsk,state:joinTerminalState(err)};
   joinError=joinErrorKey(err);
   render();
  }
 },2000);
}
function clearPairing(message=''){pairing=null;pairingEpoch++;pairingNotice=message;}
function go(next){clearPairing();page=next;selected=null;selectedNode=null;externalPage=TERMINAL_PAGES.includes(next);if(terminal&&externalPage)terminal.onNav();document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('selected',b.dataset.page===page));if(!externalPage)homeRoomsData=null;render();window.scrollTo({top:0});}
/* JOIN-502: the nearby-City onboarding surface. Three honest states, and the fallbacks are ALWAYS on
   screen: what was found (or that nothing was found, or that discovery is unavailable on this build),
   the ask-to-join control, and the existing QR / code / link / manual entries. A discovery failure
   must never look like an empty network, and a discovered City must never look like a credential -
   the row says outright that nothing is trusted yet. */
function nearbyRows(){
 if(nearbyBusy)return `<p class="muted">${esc(t('join.searching'))}</p>`;
 if(nearbyError)return `<p class="muted">${esc(t('join.unavailable'))} · ${esc(t(nearbyError))}</p>`;
 if(!nearby)return `<p class="muted">${esc(t('join.notSearched'))}</p>`;
 if(!nearby.length)return `<p class="muted">${esc(t('join.none'))}</p>`;
 return `<ul class="nearby-list">`+nearby.map(c=>`<li class="nearby-row"><div><strong>${esc(c.displayName)}</strong><p class="muted">${esc(t('join.transport',{transport:t('join.transport.'+c.transport)}))} · <span class="task-id">${esc(c.endpoint||c.address||'')}</span></p><p class="muted">${esc(t('join.notTrusted'))}</p></div><button class="primary" data-join-request="${esc(c.endpoint||'')}" data-join-ref="${esc(c.cityRef||'')}" ${joinBusy||!c.endpoint?'disabled':''}>${esc(t('join.request'))}</button></li>`).join('')+`</ul>`;
}
function joinAskView(){
 if(!joinAsk)return joinError?`<p class="muted" role="alert">${esc(t(joinError))}</p>`:'';
 const endpoint=joinAsk.endpoint?`<span class="task-id">${esc(joinAsk.endpoint)}</span>`:'';
 if(joinAsk.state==='PENDING')return `<p class="muted">${esc(t('join.waiting'))} ${endpoint}</p>`;
 if(joinAsk.state==='APPROVED')return `<p class="muted">${esc(t('join.approved'))} ${endpoint}</p>`;
 if(joinAsk.state==='REJECTED')return `<p class="muted" role="alert">${esc(t('join.rejected'))} ${endpoint}</p>`;
 return `<p class="muted" role="alert">${esc(t('join.gone'))} ${endpoint}</p>`;
}
function nearbySection(){
 return `<h3>${esc(t('join.title'))}</h3><p class="muted">${esc(t('join.hint'))}</p>${joinAskView()}<button id="nearby-browse" ${nearbyBusy||joinBusy?'disabled':''}>${esc(t('join.browse'))}</button>${nearbyRows()}<p class="muted">${esc(t('join.bleUnavailable'))}</p>`;
}
/** The owner's side of the same flow: asks waiting for a decision on an already trusted surface. Each
 *  card carries only what the workbook allows - the requested name, platform, a short non-secret
 *  reference and the local context - and no MAC is asked for or shown as authority. */
function ownerJoinSection(){
 const pending=city.joinRequests??[];
 if(!pending.length)return `<h3>${esc(t('join.requests.title'))}</h3><p class="muted">${esc(t('join.requests.none'))}</p>`;
 return `<h3>${esc(t('join.requests.title'))}</h3>`+pending.map(r=>joinRequestCard(r)).join('');
}
function joinRequestCard(r){
 const decided=r.state==='APPROVED';
 const actions=decided?'':`<button class="primary" data-join-approve="${esc(r.id)}">${esc(t('join.requests.approve'))}</button><button data-join-reject="${esc(r.id)}">${esc(t('join.requests.reject'))}</button>`;
 const detail=t('join.requests.detail',{ref:r.installationHint||t('device.unknown'),origin:r.origin||t('join.requests.local')});
 return `<article class="join-request" data-join-row="${esc(r.id)}"><div class="row"><div><strong>${esc(r.displayName)}</strong><p class="muted">${esc(r.platform||t('device.unknown'))} · <span class="task-id">${esc(r.shortRef)}</span></p><p class="muted">${esc(detail)}</p></div>${badge(decided?'ONLINE':'UNKNOWN',decided?t('join.requests.approved'):t('join.requests.waiting'))}</div>${actions}</article>`;
}
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
function status(s){if(s!=='ONLINE')clearPairing('pairing.reconnect');connection=s;$('#connection').textContent=t('connection.'+s.toLowerCase());$('#connection').className=s==='ONLINE'?'online':'';$('#run').disabled=s!=='ONLINE';render();}
async function refresh(){if(refreshing){pending=true;return;}if(externalPage&&city)return;refreshing=true;try{const gen=generation;const snapshot=await api('city');if(gen!==generation)return;city=snapshot;syncRunTargets();try{schedulerFeed=await api('presentation');}catch{schedulerFeed=null;}if(pairing&&city.descriptor?.pairingSessionId!==pairing.pairingSessionId)clearPairing('pairing.unavailable');$('#pair').hidden=true;$('#content').hidden=false;$('#error').textContent='';render();}finally{refreshing=false;if(pending){pending=false;refresh().catch(disconnected);}}}
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
 const d=city.discovery||{},remaining=pairing?Math.max(0,Math.ceil((Date.parse(pairing.expiresAt)-Date.now())/1000)):0;
 return `<section class="panel"><h2>${esc(t('pairing.title'))} ${esc(city.displayName||t('pairing.yourCity'))}</h2><p>${esc(t('settings.cityUrl'))}: ${esc(cityUrl())}</p><p class="task-id">${esc(t('pairing.cityId'))}: ${esc(city.cityId||t('device.unknown'))}</p><p>${esc(t('pairing.session'))}: ${esc(pairing?.pairingSessionId||city.descriptor?.pairingSessionId||t('pairing.none'))}</p><p class="muted">${esc(pairingNotice?t(pairingNotice):'')}</p>${pairing?`<div class="pairing-material"><div id="pairing-qr" role="img" aria-label="${esc(t('pairing.qr'))}"></div><div><p>${esc(t('pairing.code'))}</p><strong id="pairing-code">${esc(pairing.shortCode)}</strong><p id="pairing-countdown">${esc(t('pairing.countdown',{seconds:remaining}))}</p><p>${esc(t('pairing.single'))}</p></div></div><div class="pairing-share"><h3>${esc(t('pairing.share'))}</h3><p class="muted">${esc(t('pairing.shareHint'))}</p><textarea id="pairing-invite" readonly rows="3" spellcheck="false">${esc(pairing.qrPayload)}</textarea><button id="copy-invite">${esc(t('pairing.copy'))}</button><p class="muted" id="copy-note"></p></div>`:''}<button id="generate-pairing" ${connection!=='ONLINE'||pairingBusy?'disabled':''}>${pairing?t('pairing.refresh'):t('pairing.generate')}</button><p class="muted">${esc(t('pairing.explanation'))}</p><h3>${esc(t('section.connectionDiagnostics'))}</h3><p>mDNS: ${esc(d.mdns?.state||'UNKNOWN')} · ${esc(d.mdns?.reason||'')}</p><p>Bluetooth: ${esc(d.ble?.state||'UNKNOWN')} · ${esc(d.ble?.reason||'')}</p><p>Gateway: ${esc(connection)}</p><details><summary>${esc(t('common.runDetails'))}</summary><div class="task-id">apiVersion 0 · schemaVersion 0</div></details><h3>${esc(t('pairing.choose'))}</h3><ol><li><strong>QR:</strong> ${esc(t('pairing.qrHelp'))}</li><li><strong>${esc(t('pairing.lan'))}:</strong> ${esc(t('pairing.lanHelp'))}</li><li><strong>${esc(t('pairing.ble'))}:</strong> ${esc(t('pairing.bleHelp'))}</li><li><strong>${esc(t('pairing.manual'))}:</strong> ${esc(t('pairing.manualHelp'))}</li></ol><p>${esc(t('pairing.plane'))}</p><p class="lan-warning">LAN DEVELOPMENT ONLY · NOT FOR PUBLIC INTERNET</p></section>`;
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
 // JOIN-502: the onboarding block belongs to the DISCONNECTED panel, and it is injected here rather
 // than written into index.html so the shell document keeps its single responsibility and the two
 // surfaces cannot drift apart. It renders before a token exists, which is the state it is for. The
 // signature keeps a re-render from rebuilding the block mid-click: the buttons must not be replaced
 // under the pointer between mousedown and click.
 const host=$('#nearby-host');
 if(host){const signature=JSON.stringify([nearbyBusy,joinBusy,joinError,joinAsk&&joinAsk.state,nearby&&nearby.length,nearbyError!=='']);if(host.dataset.rendered!==signature){host.dataset.rendered=signature;host.innerHTML=nearbySection();}}
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
 if(page==='Pairing'){$('#view').innerHTML=pairingView()+ownerJoinSection();if(pairing&&$('#pairing-qr'))$('#pairing-qr').innerHTML=pairing.qrSvg;}
 const detail=city.tasks.find(t=>t.id===selected);$('#detail').hidden=!detail;if(detail)$('#detail').innerHTML=`<h2>${esc(detail.type)}</h2><div class="task-id">${esc(detail.id)}</div><p>${badge(detail.state)} · ${esc(detail.assignedNodeId||t('status.waitingNode'))}</p><progress max="100" value="${detail.progress}"></progress><h3>${esc(t('section.checkpoint'))}</h3><pre>${esc(JSON.stringify(detail.lastCheckpoint,null,2))}</pre><h3>${esc(t('section.result'))}</h3><pre>${esc(JSON.stringify(detail.result||detail.error,null,2))}</pre>${!finished(detail)?`<button id="cancel">${esc(t('task.cancel'))}</button>`:''}<h3>${esc(t('section.taskEvents'))}</h3>${events(city.events.filter(e=>e.taskId===detail.id))}`;
 const device=city.nodes.find(n=>n.id===selectedNode);if(device){$('#detail').hidden=false;$('#detail').innerHTML=`<h2>${esc(device.displayName)}</h2><p>${nodeBadge(device)} · ${esc(device.metadata?.platform)} · ${esc(t('device.agent'))} ${esc(device.agentVersion||t('device.unknown'))}</p><p class="task-id">${esc(device.id)}</p><p>${esc(t('device.lastSeen'))} ${esc(age(device.lastHeartbeatAt))}</p>${metrics(device)}<h3>${esc(t('device.capabilities'))}</h3><p>${esc(device.capabilities.join(' / '))}</p><h3>${esc(t('device.currentTasks'))}</h3>${taskRows(tasks.filter(t=>t.assignedNodeId===device.id&&!finished(t)),t('device.noTasks'))}<h3>${esc(t('device.recentEvents'))}</h3>${events(city.events.filter(e=>e.payload?.nodeId===device.id||tasks.some(t=>t.id===e.taskId&&t.assignedNodeId===device.id)).slice(-12),true)||`<p class="muted">${esc(t('device.noEvents'))}</p>`}`;}
}
document.addEventListener('click',async e=>{const nav=e.target.closest('[data-page]'),task=e.target.closest('[data-task]'),node=e.target.closest('[data-node]'),locale=e.target.closest('[data-locale]'),goto=e.target.closest('[data-goto]'),room=e.target.closest('[data-home-room]'),schedAction=e.target.closest('[data-scheduler-action]');if(locale)setLocale(locale.dataset.locale);if(goto)go(goto.dataset.goto);if(nav)go(nav.dataset.page);if(room)go('Rooms');if(node){selectedNode=node.dataset.node;selected=null;render();$('#detail').scrollIntoView({behavior:'smooth'});}if(task){selectedNode=null;selected=task.dataset.task;render();$('#detail').scrollIntoView({behavior:'smooth'});}
// UXI-301: a scheduler action the user takes must REALLY RETURN to the backend, which is an acceptance
// item the independent review checks. The route comes from the shared ACTION_WIRING table, and the
// task id from the button, so the panel and this dispatcher cannot disagree about what is wired.
if(schedAction){const token=schedAction.dataset.schedulerAction,taskRef=schedAction.dataset.schedulerTask,route=schedAction.dataset.schedulerRoute,providerRef=schedAction.dataset.schedulerProvider;schedAction.disabled=true;try{if(route==='cancel'){await api('tasks/'+encodeURIComponent(taskRef)+'/cancel',{});}else if(route==='create'){await api('tasks',{type:'CHECKPOINT_DEMO'});}else if(route==='providerChoice'){if(!providerRef)throw new Error('no provider was offered to choose from');await api('tasks/'+encodeURIComponent(taskRef)+'/provider-choice',{providerRef});}else{/* local acknowledgement: nothing to send */}await refresh();}catch(err){$('#error').textContent=err.message;schedAction.disabled=false;}}
if(e.target.id==='nearby-browse'){nearbyBusy=true;nearbyError='';render();try{const result=await browseApi('join/nearby');nearby=nearbyCities(result?.nearby??[]);}catch(err){nearbyError=joinErrorKey(err);nearby=null;}finally{nearbyBusy=false;render();}}
// JOIN-502: the browse above reads the LOCAL City's LAN view; this ask goes to the City the browse
// found, which is a different origin - the reason it carries a claim secret instead of a credential.
if(e.target.dataset?.joinRequest){askToJoin(e.target.dataset.joinRequest,e.target.dataset.joinRef||null);}// An owner decision returns to the backend, then the UI re-reads canonical state. It never mutates the
// local row: an approval the City did not record must not look approved on screen.
if(e.target.dataset?.joinApprove||e.target.dataset?.joinReject){const id=e.target.dataset.joinApprove||e.target.dataset.joinReject;const action=e.target.dataset.joinApprove?'approve':'reject';e.target.disabled=true;try{await api('join/requests/'+encodeURIComponent(id)+'/'+action,{});await refresh();}catch(err){$('#error').textContent=err.message;e.target.disabled=false;}}
if(e.target.id==='copy-invite'){const box=$('#pairing-invite'),note=$('#copy-note');const done=ok=>{if(note)note.textContent=t(ok?'pairing.copied':'pairing.copyManual');};const fallback=()=>{try{box.focus();box.select();return document.execCommand('copy');}catch{return false;}};if(navigator.clipboard?.writeText){navigator.clipboard.writeText(box.value).then(()=>done(true)).catch(()=>done(fallback()));}else done(fallback());}
if(e.target.id==='generate-pairing'){const epoch=++pairingEpoch;pairingBusy=true;pairing=null;render();try{const result=await api('pairing/session',{});if(epoch===pairingEpoch&&page==='Pairing'&&connection==='ONLINE'){pairing=result;pairingNotice='';}}catch(err){$('#error').textContent=err.message;}finally{pairingBusy=false;render();}}if(e.target.id==='cancel'){try{await api('tasks/'+selected+'/cancel',{});await refresh();}catch(err){$('#error').textContent=err.message;}}if(e.target.id==='disconnect'){clearPairing();token='';$('#token').value='';sessionStorage.removeItem('city-token');++generation;clearTimeout(timer);ws?.close();$('#pair').hidden=false;$('#content').hidden=true;go('Home');status('OFFLINE');}});
$('#connect').onclick=async()=>{const value=$('#token').value.trim();$('#token').value='';const invite=parseInvite(value);if(invite){try{const done=await exchangeInvite(invite);if(done?.navigating)return;if(!done?.credential)throw Error('the City returned no credential for that invite');token=done.credential;sessionStorage.setItem('city-token',token);$('#pair').hidden=true;$('#content').hidden=false;connect();}catch(err){$('#error').textContent=err.message;}return;}token=value;sessionStorage.setItem('city-token',token);connect();};
$('#ask-form').addEventListener('submit',e=>{e.preventDefault();ask($('#ask-text').value);});
$('#run').onclick=async()=>{try{$('#run').disabled=true;const target=$('#run-target')?.value||'';if(target){const created=await api('actions',{route:'CITY_TASK',target:'city.task',operation:'CHECKPOINT_DEMO',input:{targetDeviceRef:target},idempotencyKey:(crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+Math.random())});const id=created?.action?.backendRef?.taskId;if(!id)throw new Error(created?.action?.error?.message||'the City refused the targeted task');selectedNode=null;selected=id;}else{const task=await api('tasks',{type:'CHECKPOINT_DEMO'});selectedNode=null;selected=task.id;}await refresh();}catch(e){$('#error').textContent=e.message;}finally{$('#run').disabled=connection!=='ONLINE';}};
window.addEventListener('offline',()=>{disconnected();ws?.close();});window.addEventListener('online',connect);
setInterval(()=>{if(token&&ws?.readyState===1)refresh().catch(e=>{disconnected(e);ws.close();});},4000);
setInterval(()=>{if(pairing&&Date.now()>=Date.parse(pairing.expiresAt)){clearPairing('pairing.expired');render();}else if(pairing&&$('#pairing-countdown'))$('#pairing-countdown').textContent=t('pairing.countdown',{seconds:Math.max(0,Math.ceil((Date.parse(pairing.expiresAt)-Date.now())/1000))});if(city&&(page==='Home'||page==='Devices'))render();},1000);
window.addEventListener('pagehide',()=>{clearPairing();render();});
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
// JOIN-502: an ASK handed over in the fragment by a page that discovered this City. The destination is
// read before anything else, because a mis-addressed ask must be refused rather than delivered to the
// wrong owner - a link naming another City is not evidence that this City should approve it.
const bootJoinParams=new URLSearchParams(location.hash.replace(/^#/,''));
const bootJoin=bootJoinParams.get('join');
if(bootJoin)history.replaceState(null,'',location.pathname+location.search);
if(bootJoin){
 try{
  const parsed=new URLSearchParams(bootJoin);
  const claim=parsed.get('claim');
  const cityRef=parsed.get('city');
  const hint=parsed.get('hint');
  if(typeof claim!=='string'||claim.length<16||claim.length>200)throw Object.assign(Error('this join link carries no usable claim'),{status:400});
  const here=(await joinApi('info'))?.cityId??null;
  if(!here)throw Object.assign(Error('this City did not state its identity'),{status:404});
  if(cityRef&&cityRef!==here)throw Object.assign(Error('this join link names a different City'),{status:409});
  await resumeJoin({hint,claim,cityRef:here});
 }catch(err){console.error('join ask could not be delivered',err&&err.message);joinAsk=null;joinError=joinErrorKey(err);render();}
}
if(token)connect();else status('OFFLINE');
if(token){$('#pair').hidden=true;$('#content').hidden=false;mountTerminal();}
