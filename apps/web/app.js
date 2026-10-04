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
// JOIN-503: this surface may be opened with a SESSION credential instead of the City's control token. A session
// belongs to one enrolled installation and expires, so the browser no longer has to hold anything permanent - the
// durable installation credential stays with the machine (the launcher). The module also carries the Settings
// device-identity reads and the revoke action, so the page never builds those requests itself.
import { readSessionFromHash, rememberSession, forgetSession, storedSession, refreshSession, fetchEnrolled, revokeEnrolled, shortIdentity } from './enrollment.js';
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// JOIN-503: a session credential is preferred over a token when the fragment carries one, so a launcher-opened
// client is an ENROLLED client by default and the token path stays the engineering fallback it is meant to be.
const bootSession=readSessionFromHash(location.hash);
const bootDevice=new URLSearchParams(location.hash.slice(1)).get('device');if(bootDevice)try{localStorage.setItem('utopia.hostRef',bootDevice);}catch{}
let selectedMember=null,memberMessages=[],memberDrafts=new Map(),hostJoinPolling=null;
const schedulerPending=new Map();let schedulerContext='',schedulerEpoch=0;
let token=bootSession||storedSession()||sessionStorage.getItem('city-token')||'',city=null,page=location.pathname==='/pairing'?'Pairing':'Home',selected=null,ws,generation=0,timer,refreshing=false,pending=false,connection='OFFLINE',selectedNode=null,pairingBusy=false,pairingEpoch=0,terminal=null,externalPage=TERMINAL_PAGES.includes(page),homeRoomsData=null,homeRoomsError='',enrolledDevices=null,enrolledError='',enrolledNotice='';
// JOIN-502 ONBOARDING STATE. `nearby` is what the last browse found; `joinAsk` is the ask this surface
// has outstanding, if any. They are separate because discovery is repeatable and an ask is a single
// bounded episode: a fresh browse must never silently replace or re-create an ask that a human on the
// other machine is being asked to decide.
let nearby=null,nearbyBusy=false,nearbyError='',joinAsk=null,joinBusy=false,joinError='',joinPoll=null,joinAskEpoch=0;
// N2: the cross-network join. `selfOrigin` is captured ONCE, because a successful join navigates the page to the
// other City and `location.origin` then stops describing the City whose pipe carried the ask.
let selfOrigin=location.origin;
// N3: the invite a person pasted or opened, held between "we have it" and "they confirmed it". It is never written
// to storage: it is one paste, not a remembered credential.
let pendingInvite=null;
const pairDrafts={pair:{value:'',note:'',busy:false},swap:{value:'',note:'',busy:false}};
let pairTarget=null,nearbyTransport='lan',nearbyReason='',nearbyUnavailable=false;
const pairingErrorKey=error=>error?.status===429?'pair.codeLocked':error?.status===403?'pair.codeWrong':error?.status===410?'pair.codeExpired':error?.status===409?'pair.codeIdentity':'pair.codeUnreachable';
function pairNote(prefix,key){pairDrafts[prefix].note=key;const node=$(`#${prefix}-code-note`);if(node)node.textContent=key?t(key):'';}
document.addEventListener('input',e=>{for(const prefix of ['pair','swap'])if(e.target.id===`${prefix}-code`){pairDrafts[prefix].value=e.target.value;pairNote(prefix,'');}});
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
function webClientRef(){if(city?.currentMemberRef)return city.currentMemberRef;try{const hostRef=localStorage.getItem('utopia.hostRef');if(hostRef&&hostRef===city?.hostDeviceId)return hostRef;}catch{}let ref=null;try{ref=localStorage.getItem('utopia.clientRef');}catch{}if(!ref){ref='web-'+Math.random().toString(36).slice(2,10);try{localStorage.setItem('utopia.clientRef',ref);}catch{}}return ref;}
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
import {codeHandoff, exchangeShortCode} from './short-code.js';
// JOIN-502: the nearby-City adapter and the ask-to-join lifecycle. The adapter is a pure module, so the
// dedup/freshness rules can be tested without a browser; this file owns only state and rendering.
import {nearbyCities, probeNearby} from './discovery.js';
// The connection surface: ONE list of every PC this client can reach (this machine included, and any number of
// others), each with the quickest way onto it, plus which one should carry the City for all of them. Pure
// presentation logic, so what it shows is testable without a browser; this file supplies facts and dispatches.
import {buildConnectList, renderConnectList} from './connect-surface.js';
// N2: the cross-network half. `reachForRow` decides whether a row can be reached by NAVIGATING there (same link,
// where the browser can post the ask directly) or only over the relay pipe - which is the whole reason a PC on
// another network needed a transport in the first place.
import {joinCityOverRelay, reachForRow, relayTargetFor} from './relay-join.mjs';
// The dialler itself. Its absence here was a PAGE-LEVEL defect that no module test could see: `askToJoin` referenced
// `dialRelay` while only `relay-join.mjs` was imported, so the module threw `dialRelay is not defined` at load and
// the ENTIRE page failed to initialise. A real browser found it in one run; every unit test passed throughout.
import {dialRelay} from './relay-dial.mjs';
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
 if(there!==here&&city?.hostJoinAvailable&&token){const displayName=window.prompt(t('join.namePrompt'),webClientLabel());if(displayName===null)return null;return nativeHostJoin({endpoint:there,cityId:parsed.cityId,mode:'invite',displayName,invite:{cityId:parsed.cityId,sessionId:parsed.sessionId,secret:parsed.secret,method:'qr'}});}
 if(there!==here){
  // Switching City is a NAVIGATION, not a fetch: `pairing/exchange` is a route on the City that owns the
  // session, and the gateway sends no CORS headers for it, so a cross-origin POST from this page would be
  // refused by the browser. Carrying the invite to the target origin in its fragment keeps the exchange
  // same-origin and keeps the secret out of every server log on the way.
  destroyLocalToken();
  location.assign(there+'/#pair='+encodeURIComponent(parsed.invite));
  return {navigating:true};
 }
 const r=await fetch('/api/v0/pairing/exchange',{method:'POST',headers:{'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:JSON.stringify({cityId:parsed.cityId,method:'qr',sessionId:parsed.sessionId,secret:parsed.secret,installation:{displayName:webClientLabel(),platform:navigator.platform,browserOnly:true}}),signal:AbortSignal.timeout(8000)});
 const x=await r.json().catch(()=>null);
 // Errors name the City that was actually asked. A generic "no credential" cannot tell "this City refused the
 // invite" from "this client asked the WRONG City", and those need completely different fixes.
 if(!r.ok)throw Error(`the City at ${here} refused that invite: ${x?.error||r.status}`);
 if(!x?.credential)throw Error(`the City at ${here} accepted the invite but returned no credential`);
 return {credential:x.credential};
}
const bootParams=new URLSearchParams(location.hash.replace(/^#/,''));
const bootToken=bootParams.get('token'),bootInvite=bootParams.get('pair');
const bootShortPair=bootParams.get('short-pair');
// Exposed for the same reason window.utopiaWebSurface is: an acceptance run has to be able to exercise the invite
// path directly instead of only through a click, and a feature that can only be exercised by clicking is a
// feature no script can check.
// N2: the credential a relay join collected for ANOTHER City arrives here. It is read from the fragment (never the
// query string, which a server would see) and consumed immediately, then the fragment is stripped - the same rule
// the invite and join fragments already follow.
const bootHandoff=bootParams.get('handoff');
if(bootHandoff){
 const handoff=new URLSearchParams(bootHandoff);
 const handed=handoff.get('token')||'';
 if(handed){token=handed;try{sessionStorage.setItem('city-token',token);}catch{}}
}
window.utopiaInvite={parse:parseInvite,exchange:exchangeInvite,destroyLocalToken};
// N2: the relay dialler, exposed for the same reason `window.utopiaInvite` is - an acceptance run has to be able to
// exercise "join a PC on another network" directly. A `dial-outbound` action on the connection list dispatches to
// THIS function, so a script driving it and a user clicking the row take exactly the same path.
window.utopiaRelay={dial:dialRelay,joinCityOverRelay,reachForRow,relayTargetFor,selfOrigin:()=>selfOrigin};
if(bootToken||bootInvite||bootHandoff||bootShortPair)history.replaceState(null,'',location.pathname+location.search);
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
async function api(path,body,method=body?'POST':'GET'){const r=await fetch('/api/v0/'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(path.startsWith('capabilities/')?25000:5000)});const x=await r.json();if(!r.ok)throw Error(x.error);if(x.apiVersion!==0||x.schemaVersion!==0)throw Error('Protocol mismatch: this client requires version 0');return x;}
function clearPairing(message=''){pairing.clear(message);}
// The explicit generator. This is the ONLY function in the page that may create pairing material, and it is reached only from the click handler above. It refuses to run while a session is ACTIVE, so a doubled click or a stale button cannot rotate the code.
/* THE PC LIST. Facts in, rows out - and the facts are deliberately only the ones this client actually has:
   the City this page is served by (`city`), whatever discovery last found (`nearby`), and the PCs this browser has
   joined before (localStorage, a REFERENCE list and not a credential). Nothing here decides trust: a row that
   says "join this PC" goes through the existing JOIN-502 request/approve flow, and the invite channel underneath
   is untouched. */
function rememberedPcs(){try{const raw=localStorage.getItem('utopia.knownPcs');const list=raw?JSON.parse(raw):[];return Array.isArray(list)?list.filter(r=>r&&typeof r==='object'):[];}catch{return [];}}
function rememberPc(row){try{const list=rememberedPcs().filter(r=>r.cityRef!==row.cityRef);list.unshift({cityRef:row.cityRef??null,displayName:row.displayName??null,address:row.address??null,port:row.port??null,lastJoinedAt:new Date().toISOString()});localStorage.setItem('utopia.knownPcs',JSON.stringify(list.slice(0,12)));}catch{/* a browser that refuses storage still works for this view */}}
function connectFacts(){
 // This machine's own City: the endpoint the page was served from, with whatever the City says about itself.
 const self={cityRef:city?.cityId??null,displayName:t('connect.thisMachine'),address:location.hostname||null,port:location.port?Number(location.port):null,transport:'loopback',connected:connection==='ONLINE',attachedNodes:(city?.nodes??[]).length,
  // WHAT THE BROWSER CAN HONESTLY MEASURE ABOUT THIS MACHINE: core count (widely available) and nothing else.
  // Memory is deliberately NOT taken from `navigator.deviceMemory`, which is a coarse, privacy-rounded estimate -
  // publishing an estimate into a score that decides which machine hosts everybody would be exactly the kind of
  // invented fact this feature must not contain. The row therefore shows "cores only" and is marked as thin
  // evidence, which is the truth about what a browser can see.
  carrierFacts:Number.isFinite(navigator.hardwareConcurrency)?{cores:navigator.hardwareConcurrency}:null};
 const discovered=(nearby??[]).map(row=>({cityRef:row.cityRef??null,displayName:row.displayName??null,address:row.address??null,port:row.port??null,transport:row.transport??'lan',carrierFacts:row.carrierFacts??null,grantsTrust:false}));
 const remembered=rememberedPcs();
 const list=buildConnectList({self,nearby:discovered,remembered,translate:(key,params)=>t(key,params)});
 // NOTE: the list is deliberately FROZEN (the module returns immutable snapshots so a render cannot mutate the
 // facts it was given). The first version of this function assigned a field onto it here and crashed the whole
 // page with "Cannot assign to read only property" - a page-level failure that no unit test of the module could
 // see. Anything this file wants to add must be added BEFORE the call, not after.
 return list;
}
let connectSignature='';
function renderConnectSurface(){
 const host=$('#connect-body');if(!host)return;
 const list=connectFacts();
 // Re-render only when the facts change: the buttons must not be replaced under the pointer between mousedown and click.
 const signature=JSON.stringify([list.rows.map(r=>[r.cityRef,r.scope,r.score,r.recommended,r.actions.length]),nearbyBusy,nearbyError,connection]);
 if(host.dataset.rendered===signature)return;
 host.dataset.rendered=signature;
 host.innerHTML=(nearbyBusy?`<p class="muted">${esc(t('connect.searching'))}</p>`:'')+renderConnectList(list,{translate:(key,params)=>t(key,params)});
}
/* Probe once when the connection screen is first shown, so the list is populated without the user having to ask.
   Bounded and idempotent: `nearbyBrowse` itself refuses to overlap, and a failure is reported as "unavailable"
   rather than as an empty world. */
let autoProbed=false;
function autoProbeOnce(){if(autoProbed||connection==='ONLINE')return;autoProbed=true;nearbyBrowse();}
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
function go(next){page=next;selected=null;selectedNode=null;externalPage=TERMINAL_PAGES.includes(next);if(terminal&&externalPage)terminal.onNav();document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('selected',b.dataset.page===page));if(!externalPage)homeRoomsData=null;render();if(next==='Pairing'&&nearby===null&&!nearbyBusy)nearbyBrowse();window.scrollTo({top:0});}
// JOIN-502: the joining surface holds no City credential yet - that is what it is asking for - so these
// three calls authenticate with the CLAIM it generated instead. The envelope carries apiVersion 0 like
// every other call, and an error message is passed through rather than flattened, because "not approved
// yet" and "rejected" need different words on screen.
async function joinApi(path,body){const r=await fetch('/api/v0/join/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(8000)});const x=await r.json().catch(()=>null);if(x&&x.apiVersion!==0)throw Error('Protocol mismatch: this client requires version 0');if(!r.ok){const e=Error(x?.error||('join request failed: '+r.status));e.status=r.status;throw e;}return x;}
// The browse is authenticated (it is served by the City that owns this page) while the ask is not: the
// City being asked is the one the browse found, which this page has no credential for.
async function browseApi(path){const r=await fetch('/api/v0/'+path,{method:'GET',headers:{Authorization:'Bearer '+token,'X-City-Api-Version':'0','X-City-Schema-Version':'0'},signal:AbortSignal.timeout(15000)});const x=await r.json().catch(()=>null);if(!r.ok)throw Error(x?.error||('browse failed: '+r.status));return x;}
/** ONE browse, used by the button in the older section and by the PC list, so the two cannot drift apart. */
async function nearbyBrowse(transport='lan'){if(nearbyBusy)return;nearbyBusy=true;nearbyTransport=transport;nearbyError='';nearbyReason='';nearbyUnavailable=false;render();try{const result=await browseApi('join/nearby'+(transport==='ble'?'?transport=ble':''));nearby=nearbyCities(result?.nearby??[]);nearbyUnavailable=result?.unavailable===true;nearbyReason=result?.reason||'';}catch(err){nearbyError=joinErrorKey(err);nearby=null;}finally{nearbyBusy=false;render();}}
/**
 * INVITE a PC to come here: the existing explicit pairing generation, reused rather than reimplemented.
 *
 * This is the mirror image of `askToJoin`, and it exists because the Owner's requirement is that the connection
 * screen offers BOTH directions from the same list: join THEM, or bring THEM here. It creates a normal pairing
 * session (so the code, the QR and the shareable link all appear in the entry channel below), records the peer as
 * a known PC so it stays on the list next time, and returns whether it worked.
 */
async function invitePeer(row){
 if(!row)return false;
 try{
  await generatePairing();
  const ps=pairingState();
  if(!ps.session)return false;
  rememberPc(row);
  // Point the user at the material that the entry channel already renders rather than duplicating it here.
  const code=$('#pairing-code');if(code)code.scrollIntoView({behavior:'smooth',block:'nearest'});
  return true;
 }catch{return false;}
}
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
 * The ask carries the human-selected device display name across origins. It is
 * untrusted display text, not an identity or an authorization credential.
 *
 * N2 - AND WHEN NAVIGATING THERE IS IMPOSSIBLE. Navigation needs the target to be reachable BY THE BROWSER, which
 * is exactly what a PC on another network behind NAT is not. So a row whose reach is `relay` takes the OTHER road:
 * this City dials the far PC's City over the relay pipe (`relay-dial` + `relay-join`) and the ask travels down that
 * connection instead. The user stays on this page, the claim never leaves the browser, and the fallback is still the
 * fragment navigation + the QR/short-code channel underneath - a failure here must not remove the way in that
 * already worked.
 */
async function askToJoin(endpoint, cityRef, row){
 const target=String(endpoint||'').replace(/\/$/,'');
 if(!/^https?:\/\/[^\s]+$/.test(target)){joinError='join.errorUnreachable';render();return;}
 const entered=window.prompt(t('join.namePrompt'),webClientLabel());
 if(entered===null)return;
 const displayName=entered.trim();
 if(!displayName||displayName.length>64||/[\u0000-\u001f\u007f]/.test(displayName)){joinError='join.nameInvalid';render();return;}
 try{localStorage.setItem('utopia.clientLabel',displayName);}catch{}
 if(city?.hostJoinAvailable&&token&&target!==location.origin){try{await nativeHostJoin({endpoint:target,cityId:cityRef,mode:'request',displayName});}catch(error){$('#error').textContent=error.message;}return;}
 const claim=joinClaim();
 // REMOTE ROWS FIRST, and only when this page really belongs to a City that can carry the ask: with no origin of
 // our own there is no pipe to dial from, and pretending otherwise would strand the user.
 if(row&&reachForRow(row)==='relay'&&selfOrigin){
  const dialTarget=relayTargetFor({...row,address:row.address||target.replace(/^https?:\/\//,'').replace(/\/.*$/,'')},selfOrigin);
  if(dialTarget){
   try{
    const dial=await dialRelay({host:dialTarget.host,port:dialTarget.port,installationId:installationHint(),label:webClientLabel(),clientUrl:selfOrigin});
    joinError='';
    joinAsk={state:'DIALING',claim,joinEndpoint:target,displayName,hint:installationHint(),cityRef:cityRef||null};
    render();
    const result=await joinCityOverRelay({
     forward:(path,body,options)=>dial.forward(path,body,options),
     claim,
     displayName,
     platform:navigator.platform||'browser',
     hint:installationHint(),
     origin:selfOrigin,
     cityRef:cityRef||null,
     onStep:(state,detail)=>{if(state==='PENDING'||state==='APPROVED')joinAsk={...joinAsk,state,requestId:detail?.id??joinAsk.requestId};render();},
    });
    try{dial.close();}catch{}
    if(!result?.credential)throw Error('that City approved the request but returned no credential');
    joinAsk={...joinAsk,state:'CONSUMED'};
    const targetOrigin=new URL(target).origin;
    // A SAME-ORIGIN join needs no navigation: the credential is used right here.
    if(targetOrigin===selfOrigin.replace(/\/$/,'')){
     token=result.credential;try{sessionStorage.setItem('city-token',token);}catch{}
     $('#pair').hidden=true;$('#content').hidden=false;connect();
    }else{
     // CROSS-ORIGIN: the credential belongs to the OTHER City, so carrying it in a fragment is the only way to hand
     // it over without ever putting it in a URL a server sees.
     const handover=new URLSearchParams({v:'1',token:result.credential,city:result.cityId||''});
     destroyLocalToken();
     location.assign(targetOrigin+'/#handoff='+encodeURIComponent(handover.toString()));
    }
    return;
   }catch(err){
    // REPORT, THEN FALL BACK: the relay may be unreachable, refused, or the owner may simply have said no - and a
    // rejection must not be retried by navigating, because navigating would ASK AGAIN.
    joinAsk={state:err?.code==='RELAY_JOIN_REJECTED'?'REJECTED':err?.code==='RELAY_JOIN_EXPIRED'?'EXPIRED':'UNREACHABLE',claim,joinEndpoint:target,displayName,hint:installationHint(),cityRef:cityRef||null};
    joinError=err?.code==='RELAY_JOIN_REJECTED'?'join.errorRejected':joinErrorKey(err);
    render();
    if(err?.fallback===false)return;
   }
  }
 }
 const fragment=new URLSearchParams({v:'1',hint:installationHint(),claim,name:displayName});
 if(cityRef)fragment.set('city',String(cityRef).slice(0,80));
 // SAME ORIGIN: `location.assign` with only a fragment added is a SAME-DOCUMENT navigation, so the page
 // would not reload, the boot path would never run, and the ask would silently never be recorded - which
 // is exactly how this failed the first time it was exercised. Asking the page we are already on is also
 // the case where nothing needs carrying anywhere, so the ask is delivered directly.
 if(target===location.origin.replace(/\/$/,'')){resumeJoin({hint:fragment.get('hint'),claim,cityRef:cityRef||null,displayName});return;}
 // CROSS ORIGIN: destroy this City's session credential before leaving, the same rule the invite switch
 // follows - a credential for the City we are leaving is dead weight at the new one.
 destroyLocalToken();
 location.assign(target+'/#join='+encodeURIComponent(fragment.toString()));
}
/** JOIN-502: arriving with an ask to deliver. The browse handed the ask to this origin in its fragment,
 *  so this function is what turns "a nearby PC picked this City" into a recorded request. It is
 *  idempotent by construction: the City recognises the installation hint and answers with the row it
 *  already has rather than creating a second approval card. */
async function resumeJoin({hint, claim, cityRef, displayName=webClientLabel()}){
 if(typeof displayName!=='string'||!displayName.trim()||displayName.trim().length>64||/[\u0000-\u001f\u007f]/.test(displayName)){joinError='join.nameInvalid';render();return;}
 displayName=displayName.trim();try{localStorage.setItem('utopia.clientLabel',displayName);}catch{}
 const pending={hint,claim,cityRef,displayName};
 try{
  /** The pinned identity is CHECKED, never trusted. A link that names a City different from the one that
   *  received it is a mis-addressed ask, and delivering it here would ask the wrong owner to approve
   *  another City's join. */
  if(cityRef&&city&&cityRef!==city.cityId){joinError='join.errorRejected';render();return;}
  const ask=await joinApi('request',{displayName,platform:navigator.platform||'browser',installationHint:typeof pending.hint==='string'?pending.hint:installationHint(),origin:location.origin,claim:pending.claim});
  if(!ask?.id)throw Error('that City created no join request');
  joinAsk={requestId:ask.id,state:ask.state,claim:pending.claim,joinEndpoint:location.origin,displayName,hint:pending.hint??null};
  render();
  waitForDecision(joinAsk);
 }catch(err){
  joinAsk=null;joinError=joinErrorKey(err);render();
 }
}
function joinErrorKey(error){ if(error?.status===403)return 'join.errorRejected';
 if(error?.status===429)return 'join.errorBusy';
 if(error?.status===404)return 'join.errorUnreachable';
 return 'join.errorUnreachable';
}
/**
 * N3: pair with another PC from EITHER thing a person can actually hold - the link it gave them, or its 6-digit
 * code.
 *
 * TWO STEPS, ON PURPOSE. A link carries the City's address, its identity, the session and the one-time secret, so
 * pasting it is all the WORK there is; but the exchange itself is confirmed once by the person who opened it. That
 * keeps "one paste and done" without letting a link that arrived by accident silently move this browser onto
 * somebody else's City.
 *
 * WHY A BARE CODE IS NOT ENOUGH, said to the user rather than hidden behind a spinner: a 6-digit code is a code, not
 * an address. It cannot reach a City nobody has named yet, so the honest answer is to ask for the link (or the
 * code typed on the OTHER PC, which is the side that knows who it is talking to).
 */
function beginPairingFromInvite(raw,prefix='pair'){
 const value=String(raw??'').trim();
 const linkMatch=value.match(/[?&#]pair=([^&\s]+)/i);
 let payload=linkMatch?decodeURIComponent(linkMatch[1]):value;
 // THE PREFIX HAS TO COME BACK, and this is the defect that made a pasted link do nothing: `?pair=` carries the
 // payload URL-encoded, so what comes out of the query is the INNER query (`v=1&host=…`) - and `parseInvite` quite
 // rightly requires the `utopia://pair?` scheme, because that is what the QR carries. A link that decoded to a
 // perfectly good payload was thrown away one line later, with no error anywhere. Accepting both shapes here is the
 // honest fix: the deep link and the web link are the same material in two wrappers.
 if(!payload.startsWith('utopia://pair')){
  const inner=payload.replace(/^utopia:\/\/pair\?/,'').replace(/^\?/,'');
  if(!/(^|&)(host|session)=/.test(inner))return null;
  payload='utopia://pair?'+inner;
 }
 const parsed=parseInvite(payload);
 if(!parsed)return null;
 pendingInvite={payload,host:parsed.host,cityId:parsed.cityId??null};
 const note=$(`#${prefix}-code-note`);
 if(note)note.textContent=t('pairing.linkReady');
 // Name the machine the invite came from: "an invite from somewhere" is not something a person can check.
 const fromLine=$(`#${prefix}-invite-text`);
 if(fromLine){let where=parsed.host;try{where=new URL(parsed.host).host;}catch{/* keep the raw host if it is not a URL */}
  fromLine.textContent=`${t('pairing.linkReady')} · ${where}`;}
 syncPairEntry();
 return{ok:true,ready:true,host:parsed.host};
}

async function pairWithCode(rawInput=null,prefix='pair'){
 const note=$(`#${prefix}-code-note`),button=$(`#${prefix}-code-connect`),field=$(`#${prefix}-code`);
 const raw=String(rawInput??field?.value??'').trim();
 const say=key=>pairNote(prefix,key);
 if(pairDrafts.pair.busy||pairDrafts.swap.busy)return{ok:false,reason:'BUSY'};
 if(!raw){say('pair.codeEmpty');field?.focus();return{ok:false,reason:'EMPTY'};}
 const started=beginPairingFromInvite(raw,prefix);
 if(started)return started;
 if(/^\d{6}$/.test(raw)){
  const draft=pairDrafts[prefix];draft.value=raw;draft.busy=true;say('pair.codeBusy');if(button)button.disabled=true;
  try{
   const target=pairTarget||{endpoint:location.origin,cityRef:city?.cityId??null,transport:'LAN'};
   const method=target.transport==='BLE_BOOTSTRAP'?'ble':'mdns';
   if(city?.hostJoinAvailable&&token&&new URL(target.endpoint).origin!==location.origin){const displayName=window.prompt(t('join.namePrompt'),webClientLabel());if(displayName===null)return{ok:false,reason:'CANCELLED'};return await nativeHostJoin({endpoint:target.endpoint,cityId:target.cityRef,mode:'code',shortCode:raw,displayName});}
   if(new URL(target.endpoint).origin!==location.origin){
    const handoff=codeHandoff({endpoint:target.endpoint,cityRef:target.cityRef,code:raw,method});
    location.assign(handoff);return{ok:true,navigating:true};
   }
   const done=await exchangeShortCode({code:raw,cityRef:target.cityRef,method,installation:{displayName:webClientLabel(),platform:navigator.platform,browserOnly:true}});
   token=done.credential;forgetSession();sessionStorage.setItem('city-token',token);
   draft.value='';if(field)field.value='';pendingInvite=null;pairTarget=null;say('pair.codeDone');await connect();return{ok:true};
  }catch(error){say(pairingErrorKey(error));return{ok:false,reason:'EXCHANGE_FAILED'};}
  finally{draft.busy=false;syncPairEntry();}
 }
 say('pair.codeBad');
 return{ok:false,reason:'UNRECOGNIZED'};
}

/** The confirmed half: the person who opened the link has accepted it, so the exchange runs now. */
async function acceptPendingInvite(prefix='pair'){
 const button=$(`#${prefix}-invite-accept`),note=$(`#${prefix}-code-note`);
 const say=key=>{if(note)note.textContent=key?t(key):'';};
 if(!pendingInvite){say('pair.codeEmpty');return{ok:false,reason:'NOTHING_PENDING'};}
 if(button)button.disabled=true;say('pair.codeBusy');
 try{
  const done=await exchangeInvite(pendingInvite.payload);
  if(done?.navigating)return{ok:true,navigating:true};
  if(!done?.credential)throw Error(t('pair.codeFailed'));
  token=done.credential;try{sessionStorage.setItem('city-token',token);}catch{}
  $('#pair').hidden=true;$('#content').hidden=false;
  say('pair.codeDone');pendingInvite=null;syncPairEntry();
  connect();
  return{ok:true};
 }catch(error){
  // The City's own refusal decides which sentence is true: a wrong/used code, a locked session, or a dead host are
  // three different things to the person reading it, and collapsing them into "failed" is the defect this project
  // has already had to correct once on the join flow.
  const message=String(error?.message??error);
  say(/locked|too many/i.test(message)?'pair.codeLocked':/refused|incorrect|expired|used/i.test(message)?'pair.codeRejected':'pair.codeFailed');
  return{ok:false,reason:'EXCHANGE_FAILED'};
 }finally{if(button)button.disabled=false;}
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
    const collected=await joinApi('exchange',{requestId:ask.requestId,claim:ask.claim,installation:{browserOnly:true}});
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
// INTEGRATION: stale JOIN-502 pairing display functions removed here. Their replacements are defined earlier in this file, and keeping these
// copies would make two owners of the same pairing display - the defect JOIN-501 was accepted for removing.
/* JOIN-502: the nearby-City onboarding surface. Three honest states, and the fallbacks are ALWAYS on
   screen: what was found (or that nothing was found, or that discovery is unavailable on this build),
   the ask-to-join control, and the existing QR / code / link / manual entries. A discovery failure
   must never look like an empty network, and a discovered City must never look like a credential -
   the row says outright that nothing is trusted yet. */
function nearbyRows(){
 if(nearbyBusy)return `<p class="muted">${esc(t('join.searching'))}</p>`;
 if(nearbyError)return `<p class="muted">${esc(t('join.unavailable'))} · ${esc(t(nearbyError))}</p>`;
 if(nearbyUnavailable){const key=nearbyReason==='BLUETOOTH_DISABLED'?'join.bleOff':nearbyReason==='NO_BLUETOOTH_ADAPTER'||nearbyReason==='LOW_ENERGY_NOT_SUPPORTED'?'join.bleNoAdapter':nearbyTransport==='ble'?'join.bleFailed':'join.lanFailed';return `<p role="status" class="muted">${esc(t(key))}</p>`;}
 if(!nearby)return `<p class="muted">${esc(t('join.notSearched'))}</p>`;
 if(!nearby.length)return `<p class="muted">${esc(t('join.none'))}</p>`;
 return `<ul class="nearby-list">`+nearby.map(c=>`<li class="nearby-row ${pairTarget?.key===c.key?'nearby-selected':''}"><div><strong>${esc(c.displayName)}</strong><p class="muted">${esc(t('join.transport',{transport:t(c.transport==='BLE_BOOTSTRAP'?'join.transport.ble':'join.transport.lan')}))} · <span class="task-id">${esc(c.endpoint||c.address||'')}</span></p><p class="muted">${esc(t('join.notTrusted'))}</p></div><div class="nearby-actions"><button class="primary" data-pair-target="${esc(c.key)}" ${pairDrafts.pair.busy||pairDrafts.swap.busy||!c.endpoint||!c.cityRef?'disabled':''}>${esc(t(pairTarget?.key===c.key?'join.selected':'join.connectCode'))}</button><button data-join-request="${esc(c.endpoint||'')}" data-join-ref="${esc(c.cityRef||'')}" ${joinBusy||!c.endpoint?'disabled':''}>${esc(t('join.request'))}</button></div></li>`).join('')+`</ul>`;
}
function joinAskView(){
 if(!joinAsk)return joinError?`<p class="muted" role="alert">${esc(t(joinError))}</p>`:'';
 const endpoint=joinAsk.endpoint?`<span class="task-id">${esc(joinAsk.endpoint)}</span>`:'';
 if(joinAsk.state==='DIALING')return `<p class="muted">${esc(t('join.relay.dialing'))} ${endpoint}</p>`;
 if(joinAsk.state==='PENDING')return `<p class="muted">${esc(t(joinAsk.hint?'join.relay.waiting':'join.waiting'))} ${endpoint}</p>`;
 if(joinAsk.state==='APPROVED')return `<p class="muted">${esc(t('join.approved'))} ${endpoint}</p>`;
 if(joinAsk.state==='REJECTED')return `<p class="muted" role="alert">${esc(t('join.rejected'))} ${endpoint}</p>`;
 if(joinAsk.state==='UNREACHABLE')return `<p class="muted" role="alert">${esc(t('join.relay.unreachable'))} ${endpoint}</p>`;
 return `<p class="muted" role="alert">${esc(t('join.gone'))} ${endpoint}</p>`;
}
function nearbySection(prefix=''){
 const stem=prefix?prefix+'-':'';
 return `<h3>${esc(t('join.title'))}</h3><p class="muted">${esc(t('join.searchHint'))}</p>${joinAskView()}<div class="discovery-controls"><button id="${stem}nearby-browse" ${nearbyBusy||joinBusy?'disabled':''}>${esc(t('join.browse'))} · Wi-Fi</button><button id="${stem}nearby-ble" ${nearbyBusy||joinBusy?'disabled':''}>${esc(t('join.bleBrowse'))}</button></div>${nearbyRows()}<p class="muted">${esc(t('join.radioHost'))}</p>`;
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
function syncPairEntry(){
 // TWO RENDER PLACES, ONE STATE. The first screen's card is filled once (its markup is static in index.html so the
 // disconnected screen works even before any record exists); the Pairing page's card is re-rendered by
 // `pairingView`. Whichever is on screen, the "an invite is waiting" flag has to agree with `pendingInvite`, or the
 // confirm button appears on one copy and not the other.
 const host=$('#pair-code-card');
 if(host&&host.dataset.rendered!==getLocale()){host.innerHTML=renderPairCodeCard('pair');host.dataset.rendered=getLocale();}
 for(const prefix of ['pair','swap']){
  const target=$(`#${prefix}-target-note`);
  if(target)target.textContent=pairTarget?t('pair.target',{name:pairTarget.displayName,address:pairTarget.endpoint}):t('pair.targetHere',{address:location.origin});
  const busy=pairDrafts.pair.busy||pairDrafts.swap.busy;
  const button=$(`#${prefix}-code-connect`);if(button)button.disabled=busy;
  const field=$(`#${prefix}-code`);if(field)field.disabled=busy;
  const ready=$(`#${prefix}-invite-ready`);
  if(!ready)continue;
  ready.hidden=pendingInvite===null;
  const label=$(`#${prefix}-invite-text`);
  if(label&&pendingInvite){let where=pendingInvite.host;try{where=new URL(pendingInvite.host).host;}catch{/* keep the raw host if it is not a URL */}
   label.textContent=`${t('pairing.linkReady')} · ${where}`;}
 }
}
function status(s){connection=s;$('#connection').textContent=t('connection.'+s.toLowerCase());$('#connection').className=s==='ONLINE'?'online':'';$('#run').disabled=s!=='ONLINE';render();}
async function refresh(){if(refreshing){pending=true;return;}if(externalPage&&city)return;refreshing=true;try{const gen=generation;const snapshot=await api('city');if(gen!==generation)return;city=snapshot;try{memberMessages=(await api('members/messages')).messages||[];for(const message of memberMessages)if(message.targetDeviceId===city.currentMemberRef&&message.state==='PENDING'){await api('members/messages/'+message.id+'/receipt',{});message.state='RECEIVED';}}catch{memberMessages=[];}syncRunTargets();try{schedulerFeed=await api('presentation');}catch{schedulerFeed=null;}if(pairing.ownerSessionId()!==null&&city.descriptor?.pairingSessionId!==pairing.ownerSessionId()){const active=pairing.ownerSessionId();canonicalPairingSession().then(c=>{if(!c.known)return;if(c.sessionId===active)return;pairing.clearOnSessionChanged(c.sessionId);render();});}$('#pair').hidden=true;$('#content').hidden=false;$('#error').textContent='';render();}finally{refreshing=false;if(pending){pending=false;refresh().catch(disconnected);}}}
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
const legacyNodeRows=()=>city.nodes.map(n=>`<article class="device-card"><div class="row"><div class="node-info"><span class="node-icon" aria-hidden="true"></span><div><button class="task-open" data-node="${esc(n.id)}">${esc(n.displayName)}</button><p class="muted">${esc(n.metadata?.platform)} · ${esc(t('device.agent'))} ${esc(n.agentVersion||t('device.unknown'))}</p><small>${connection==='ONLINE'?'':t('device.cachedPrefix')}${esc(t('device.lastSeen'))} ${esc(age(n.lastHeartbeatAt))}</small></div></div>${nodeBadge(n)}</div>${metrics(n)}</article>`).join('')||`<p class="muted">${esc(t('empty.waitingRuntimeNode'))}</p>`;
const ownMemberRef=()=>city?.currentMemberRef||webClientRef();
const nodeRows=()=>!city.members?legacyNodeRows():[...city.members].sort((a,b)=>(a.deviceId===ownMemberRef()?-1:b.deviceId===ownMemberRef()?1:0)).map(m=>{
 const n=city.nodes.find(n=>n.id===m.nodeId);const title=(m.deviceId===ownMemberRef()?t('members.thisDevice')+' · ':'')+m.displayName;
 return '<article class="device-card" data-member-card="'+esc(m.deviceId)+'"><div class="row"><div><button class="task-open" data-member="'+esc(m.deviceId)+'"'+(n?' data-node="'+esc(n.id)+'"':'')+'>'+esc(title)+'</button><p class="muted">'+esc(t('members.role.'+m.role))+' · '+esc(m.computeOnline?(m.sharingEnabled?t('members.sharing'):t('members.notSharing')):t('members.noAgent'))+'</p></div>'+(n?nodeBadge(n):connection!=='ONLINE'?badge('UNKNOWN',t('node.unknown')):badge(m.online?'ONLINE':'OFFLINE',t('connection.'+(m.online?'online':'offline'))))+'</div>'+(n?metrics(n):'')+'</article>';
}).join('');
function memberDetail(m){
 const mine=m.deviceId===ownMemberRef();const history=memberMessages.filter(x=>(x.senderDeviceId===m.deviceId&&x.targetDeviceId===ownMemberRef())||(x.targetDeviceId===m.deviceId&&x.senderDeviceId===ownMemberRef()));
 return '<section id="member-detail" data-member-detail="'+esc(m.deviceId)+'">'+(m.nodeId?'':'<h2>'+esc(m.displayName)+'</h2>')+'<p>'+esc(t('members.role.'+m.role))+'</p>'+(mine&&m.nodeId?'<button id="member-sharing" data-enabled="'+String(!m.sharingEnabled)+'">'+esc(t(m.sharingEnabled?'members.stopSharing':'members.startSharing'))+'</button>':'')+'<h3>'+esc(t('members.messages'))+'</h3><div id="member-message-history">'+history.map(x=>'<p>'+esc(x.text)+' · '+esc(t(x.state==='RECEIVED'?'members.received':'members.pending'))+'</p>').join('')+'</div>'+(!mine?'<form id="member-message-form"><label for="member-message-text">'+esc(t('members.message'))+'</label><input id="member-message-text" maxlength="4096" required value="'+esc(memberDrafts.get(m.deviceId)||'')+'"><button id="member-message-send" type="submit">'+esc(t('members.send'))+'</button></form>':'')+'</section>';
}
async function nativeHostJoin(input){
 const ticket=await api('host/join',input);joinAsk={state:'PENDING',displayName:input.displayName};clearInterval(hostJoinPolling);
 hostJoinPolling=setInterval(async()=>{try{const state=await api('host/join/status?ticketId='+encodeURIComponent(ticket.ticketId));if(state.state==='JOINED'){clearInterval(hostJoinPolling);destroyLocalToken();location.assign(state.nextUrl);}else if(state.state==='FAILED'){clearInterval(hostJoinPolling);$('#error').textContent=state.error;} }catch(error){clearInterval(hostJoinPolling);$('#error').textContent=error.message;}},700);
 return {ok:true,navigating:true};
}
const cityUrl=()=>{const e=city.descriptor?.endpoint;return e?e.scheme+'://'+e.host+':'+e.port:location.origin;};
function renderPairCodeCard(prefix='pair'){
 const draft=pairDrafts[prefix];
 // ONE definition, rendered in TWO places, because the entry is needed in two states and a second copy would drift:
 //   * on the first screen while this client is NOT connected (the state the screen exists for);
 //   * inside the Pairing page, because a CONNECTED client is the state everyone is actually in - and the first
 //     version put this card only inside `#pair`, which is hidden the moment a client connects. The result was an
 //     entry nobody could see, reported exactly as "there is no place to type the pairing code".
 //
 // THE IDS ARE PREFIXED, and that is not cosmetic: two live copies with the same ids make `querySelector` return the
 // hidden one, so the visible card would have looked for its own input and found the other card's.
 return `<h3 id="${prefix}-code-title">${esc(t('pair.codeTitle'))}</h3><p class="muted">${esc(t('pair.codeHint'))}</p><p id="${prefix}-target-note" class="muted"></p><div class="pair-code-row"><input id="${prefix}-code" type="text" autocomplete="off" inputmode="text" value="${esc(draft.value)}" placeholder="${esc(t('pair.codePlaceholder'))}" aria-label="${esc(t('pair.codeTitle'))}"><button id="${prefix}-code-connect" class="primary" ${draft.busy?'disabled':''}>${esc(t('pair.codeConnect'))}</button></div><p class="muted" role="status" aria-live="polite" id="${prefix}-code-note">${esc(draft.note?t(draft.note):'')}</p><div id="${prefix}-invite-ready" hidden><p class="muted" id="${prefix}-invite-text"></p><button id="${prefix}-invite-accept" class="primary">${esc(t('pairing.linkConnect'))}</button></div>`;
}
function pairingView(){ const d=city.discovery||{},ps=pairingState(),remaining=ps.remainingSeconds||0;
 // N3: THE SHAREABLE THING IS A WEB LINK. The `utopia://` payload is kept for the QR and for the Android deep link,
 // but it is NOT what a person can hand to another Windows PC: a custom scheme pasted into a browser's address bar
 // does nothing at all. So the share block leads with a plain http(s) URL the other machine can open, and the raw
 // payload is demoted to a folded detail for whoever needs it.
 const invite=ps.session?.inviteUrl||null;
 const shareBlock=ps.session?`<div class="pairing-share"><h3>${esc(t('pairing.share'))}</h3><p class="muted">${esc(t('pairing.shareHint'))}</p>${invite?`<p class="muted">${esc(t('pairing.linkHint'))}</p><p><a id="pairing-link" class="invite-link" href="${esc(invite)}">${esc(invite)}</a></p><div class="share-row"><button id="copy-invite" class="primary">${esc(t('pairing.copyLink'))}</button><span class="muted" id="copy-note"></span></div>`:''}<details><summary>${esc(t('pairing.raw'))}</summary><textarea id="pairing-invite" readonly rows="3" spellcheck="false">${esc(ps.session.qrPayload)}</textarea><div class="share-row"><button id="copy-raw">${esc(t('pairing.copy'))}</button></div></details></div>`:'';
 return `<section class="panel"><h2>${esc(t('pairing.title'))} ${esc(city.displayName||t('pairing.yourCity'))}</h2><section id="swap-nearby-host">${nearbySection('swap')}</section>${shareBlock}<section id="pairing-card" aria-labelledby="pairing-code-title">${renderPairCodeCard('swap')}</section><p>${esc(t('settings.cityUrl'))}: ${esc(cityUrl())}</p><p class="task-id">${esc(t('pairing.cityId'))}: ${esc(city.cityId||t('device.unknown'))}</p><p>${esc(t('pairing.session'))}: ${esc(ps.session?.pairingSessionId||city.descriptor?.pairingSessionId||t('pairing.none'))}</p><p class="muted">${esc(pairingReasonMessage(ps.notice)?t(pairingReasonMessage(ps.notice)):'')}</p>${ps.session?`<div class="pairing-material"><div id="pairing-qr" role="img" aria-label="${esc(t('pairing.qr'))}"></div><div><p>${esc(t('pairing.code'))}</p><strong id="pairing-code">${esc(ps.session.shortCode)}</strong><p class="muted">${esc(t('pairing.codeHint'))}</p><p id="pairing-countdown">${esc(t('pairing.countdown',{seconds:remaining}))}</p><p>${esc(t('pairing.single'))}</p></div></div>`:''}<button id="generate-pairing" ${connection!=='ONLINE'||pairingBusy||!ps.generate.available?'disabled':''}>${ps.generate.available?t(ps.generate.label):t('pairing.active')}</button><p class="muted">${esc(t('pairing.explanation'))}</p><h3>${esc(t('section.connectionDiagnostics'))}</h3><p>mDNS: ${esc(d.mdns?.state||'UNKNOWN')} · ${esc(d.mdns?.reason||'')}</p><p>Bluetooth: ${esc(d.ble?.state||'UNKNOWN')} · ${esc(d.ble?.reason||'')}</p><p>Gateway: ${esc(connection)}</p><details><summary>${esc(t('common.runDetails'))}</summary><div class="task-id">apiVersion 0 · schemaVersion 0</div></details><h3>${esc(t('pairing.choose'))}</h3><ol><li><strong>QR:</strong> ${esc(t('pairing.qrHelp'))}</li><li><strong>${esc(t('pairing.lan'))}:</strong> ${esc(t('pairing.lanHelp'))}</li><li><strong>${esc(t('pairing.ble'))}:</strong> ${esc(t('pairing.bleHelp'))}</li><li><strong>${esc(t('pairing.manual'))}:</strong> ${esc(t('pairing.manualHelp'))}</li></ol><p>${esc(t('pairing.plane'))}</p><p class="lan-warning">LAN DEVELOPMENT ONLY · NOT FOR PUBLIC INTERNET</p></section>`;
}
/* UI-101 step 5: the default reading path shows a readable label, and the raw
   internal vocabulary (event type, sequence, task id) lives in a folded
   run-details block instead of being printed on the surface. */
const EVENT_LABELS={'CLIENT_CONNECTED':'event.clientConnected','CITY_STARTED':'event.cityStarted','task.completed':'event.taskCompleted','task.progress':'event.taskProgress','task.cancelled':'event.taskCancelled','node.heartbeat':'event.nodeHeartbeat'};
const events=(list,raw=false)=>list.slice().reverse().map(e=>`<div class="event"><time>${esc(formatTime(e.timestamp))}</time><strong>${esc(raw?e.type:t(EVENT_LABELS[e.type]||'event.other'))}</strong><details><summary>${esc(t('common.runDetails'))}</summary><div class="task-id">${raw?'':' '+esc(e.type)+' · '}#${esc(e.seq)} · ${esc(e.taskId||'City')}</div></details></div>`).join('');
function cityNameSection(){return '<h2>'+esc(t('settings.cityName'))+'</h2><form id="city-name-form"><label for="city-name">'+esc(t('settings.cityName'))+'</label><input id="city-name" maxlength="64" required value="'+esc(city.displayName)+'"><button type="submit">'+esc(t('settings.saveCityName'))+'</button></form>';}
function languageSection(){const current=getLocale();return `<h2>${esc(t('settings.interface'))}</h2><p>${esc(t('settings.language'))}</p><div class="lang-row" id="language">${SUPPORTED_LOCALES.map(l=>`<button class="lang-option${l===current?' selected':''}" data-locale="${esc(l)}" aria-label="${esc(localeLabel(l))}" aria-pressed="${l===current}">${esc(localeLabel(l))}</button>`).join('')}</div><p class="muted">${esc(t('settings.languageHint'))}</p>`;}
/* JOIN-503 — the device-identity surface.
   Two states, and the page must not blur them:
     * an ENROLLED client (opened with a session credential) sees WHICH installation it is, when it expires, and
       who else is enrolled, with a revoke action. It is never shown a durable secret, because it does not have
       one - the machine holds it and re-mints sessions on the user's behalf.
     * a CONTROL-TOKEN client (the engineering fallback) is told plainly that it is the owner credential, so a
       user can see that this is not the normal path rather than being left to infer it.
   The list is fetched once per Settings visit and cached, so a render loop cannot turn it into polling. */
function enrolledRows(){
  if(enrolledError)return `<p class="muted">${esc(t('device.enrollmentError'))} ${esc(enrolledError)}</p>`;
  if(!enrolledDevices)return `<p class="muted">${esc(t('terminal.loading'))}</p>`;
  if(!enrolledDevices.length)return `<p class="muted">${esc(t('device.enrollmentEmpty'))}</p>`;
  return enrolledDevices.map(d=>`<div class="row"><div><strong>${esc(d.displayName||t('device.unknown'))}</strong><div class="task-id">${esc(shortIdentity(d.installationId))}</div><small>${esc(t('device.enrolledAt'))} ${esc(formatTime(d.enrolledAt))} · ${esc(d.state)}</small></div><button data-revoke="${esc(d.installationId)}">${esc(t('device.revoke'))}</button></div>`).join('');
}
function deviceSection(){
  const mine=city?.enrolledDevice;
  const summary=mine
    ? `<p class="muted">${esc(t('device.enrolledAs'))}</p><dl class="kv"><dt>${esc(t('device.displayName'))}</dt><dd>${esc(mine.displayName||t('device.unknown'))}</dd><dt>${esc(t('device.installation'))}</dt><dd class="task-id">${esc(shortIdentity(mine.installationId))}</dd><dt>${esc(t('device.state'))}</dt><dd>${esc(mine.state)}</dd></dl>`
    : `<p class="muted">${esc(t('device.ownerToken'))}</p>`;
  return `<h2>${esc(t('section.deviceIdentity'))}</h2>${summary}${enrolledNotice?`<p class="muted">${esc(t(enrolledNotice))}</p>`:''}<p class="muted">${esc(t('device.enrolledHint'))}</p><div id="enrolled-list">${enrolledRows()}</div>`;
}
function loadEnrolledDevices(){
  if(enrolledDevices||enrolledError||!token){return;}
  fetchEnrolled({credential:token}).then(({installations})=>{enrolledDevices=installations;}).catch(e=>{enrolledError=e.message;}).finally(()=>{const host=$('#enrolled-list');if(host)host.innerHTML=enrolledRows();});
}
/* JOIN-503: revoke is a real server-side fact, not a UI state. After it, this page keeps NO credential for that
   installation (the session it was using is gone too, when it revoked itself), so the next thing the user sees is
   the pairing path - not a client that quietly keeps working. */
async function revokeDevice(installationId){
  enrolledNotice='';
  try{
    const revoked=await revokeEnrolled({credential:token,installationId});
    enrolledNotice='device.revoked';
    const mine=city?.enrolledDevice;
    if(mine&&mine.installationId===installationId){
      // It revoked itself. Drop the local session and say so, rather than leaving a dead credential in place.
      forgetSession();token='';sessionStorage.removeItem('city-token');++generation;clearTimeout(timer);ws?.close();
      $('#pair').hidden=false;$('#content').hidden=true;go('Home');status('OFFLINE');
      enrolledDevices=null;enrolledError='';
      return;
    }
    enrolledDevices=null;enrolledError='';render();
  }catch(err){enrolledNotice='';enrolledError=err.message;render();}
}
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
 const nextSchedulerContext=token+'|'+(city?.cityId??'');if(nextSchedulerContext!==schedulerContext){schedulerContext=nextSchedulerContext;schedulerEpoch++;schedulerPending.clear();}
 const previousNameForm=$('#city-name-form');
 const nameSelection=document.activeElement?.id==='city-name'?{start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd}:null;
 const focused=document.activeElement;
 const typing=focused?.id==='swap-code'?{start:focused.selectionStart,end:focused.selectionEnd}:null;
 const oldPairCard=$('#pairing-card');
 // The pairing entry is refreshed on every render: it is rendered in two places (the first screen while
 // disconnected, the Pairing page while connected) and both have to track whether an invite is waiting to be
 // confirmed. Cheap and idempotent - it only fills an empty host and syncs one `hidden` flag.
 syncPairEntry();
 // JOIN-502: the onboarding block belongs to the DISCONNECTED panel, and it is injected here rather
 // than written into index.html so the shell document keeps its single responsibility and the two
 // surfaces cannot drift apart. It renders before a token exists, which is the state it is for. The
 // signature keeps a re-render from rebuilding the block mid-click: the buttons must not be replaced
 // under the pointer between mousedown and click.
 const host=$('#nearby-host');
 if(host){const signature=JSON.stringify([getLocale(),nearbyBusy,joinBusy,joinError,joinAsk,nearby,pairTarget?.key,nearbyError,nearbyReason,nearbyUnavailable,nearbyTransport]);if(host.dataset.rendered!==signature){host.dataset.rendered=signature;host.innerHTML=nearbySection();}}
 // The PC list sits ABOVE the entry controls and never replaces them: invite / code / QR / manual is the Owner's
 // port-page entry and stays exactly where it was. Same signature trick, for the same reason - a re-render must
 // not swap the buttons out from under the pointer mid-click.
 renderConnectSurface();
 $('#ask-form').hidden=$('#content').hidden;
 const cityLabel=city?.displayName||pairTarget?.displayName; if(cityLabel){document.title=cityLabel+' · Utopia';$('#city-display-name').textContent=cityLabel;}
 if(!city){$('#heading').textContent=t('heading.'+page.toLowerCase());if(terminal)terminal.render($('#view'));return;}
 $('#heading').textContent=t('heading.'+page.toLowerCase());$('#updated').textContent=t('status.lastSnapshot',{time:formatTime(city.updatedAt)});
 const tasks=city.tasks;
 if(page==='Home')$('#view').innerHTML=assistantSlot()+`<div class="grid" style="margin-top:14px"><section class="panel"><h2>${esc(t('section.runtimeNodes'))}</h2>${nodeRows()}</section><section class="panel"><h2>${esc(t('section.recentActivity'))}</h2>${events(city.events.slice(-4))}</section></div><section class="panel" style="margin-top:12px" id="home-rooms"><h2>${esc(t('section.homeRooms'))}</h2><p class="muted">${esc(t('home.rooms.hint'))}</p><div id="home-rooms-body"><p class="muted">${esc(t('terminal.loading'))}</p></div></section><section class="panel" style="margin-top:12px"><h2>${esc(t('section.recentTasks'))}</h2>${taskRows(tasks.slice(-5))}</section>`;
 if(page==='Home')homeRooms();
 if(page==='Services')renderServices($('#view'),city,connection==='ONLINE',api);
 if(page==='Settings')loadEnrolledDevices();
 // Terminal pages mount lazily: `terminal` is only created once a terminal page is shown,
 // which is why this must not depend on `terminal` already existing.
 if(TERMINAL_PAGES.includes(page)){if(!terminal)mountTerminal();if(terminal)terminal.render($('#view'),city,connection==='ONLINE',api,{page,go,api});}
 if(page==='Devices')$('#view').innerHTML=schedulerPanel(schedulerFeed,{isOnline:connection==='ONLINE',advanced:true,busyTasks:new Set(schedulerPending.keys())})+`<section class="panel">${nodeRows()}</section>`;
 if(page==='Tasks')$('#view').innerHTML=`<section class="panel"><h2>${esc(t('section.taskRegistry'))}</h2>${taskRows(tasks)}</section>`;
 if(page==='Activity')$('#view').innerHTML=`<section class="panel"><h2>${esc(t('section.eventTimeline',{count:city.events.length}))}</h2><button data-goto="Actions">${esc(t('nav.actions'))}</button>${events(city.events)}</section>`;
 if(page==='Settings')$('#view').innerHTML=`<section class="panel">${cityNameSection()}${deviceSection()}${languageSection()}<h2>${esc(t('section.connectionDiagnostics'))}</h2><p>${esc(t('settings.cityUrl'))}: ${esc(location.origin)}</p><details><summary>${esc(t('common.runDetails'))}</summary><div class="task-id">apiVersion = 0 · schemaVersion = 0</div></details><p class="muted">${esc(t('settings.tokenNote'))}</p><button id="disconnect">${esc(t('settings.changeToken'))}</button></section>`;
 if(previousNameForm&&nameSelection&&page==='Settings'){$('#city-name-form')?.replaceWith(previousNameForm);const input=$('#city-name');input.focus({preventScroll:true});input.setSelectionRange(nameSelection.start,nameSelection.end);}
 if(page==='Pairing'){
  $('#view').innerHTML=pairingView()+ownerJoinSection();
  const card=$('#pairing-card');
  if(oldPairCard&&oldPairCard.dataset.renderLocale===getLocale())card.replaceWith(oldPairCard);
  else card.dataset.renderLocale=getLocale();
  syncPairEntry();
  if(typing){const field=$('#swap-code');field?.focus({preventScroll:true});field?.setSelectionRange(typing.start,typing.end);}
  const ps=pairingState();if(ps.session&&$('#pairing-qr'))$('#pairing-qr').innerHTML=ps.session.qrSvg;
 }
 // INTEGRATION: JOIN-502's own `if(page==='Pairing')` line was removed here. The union kept BOTH, and the later
 // one both overwrote the view AND read the pre-JOIN-501 `pairing` variable, so the QR was never injected into the
 // page: every browser test hung waiting for `#pairing-qr svg`. The line above owns the Pairing page now, and the
 // owner's approval cards from JOIN-502 are added to it there rather than re-rendering the page a second time.
 const messageField=$('#member-message-text');const messageFocus=messageField===document.activeElement?{start:messageField.selectionStart,end:messageField.selectionEnd}:null;
 const detail=city.tasks.find(t=>t.id===selected);$('#detail').hidden=!detail;if(detail)$('#detail').innerHTML=`<h2>${esc(detail.type)}</h2><div class="task-id">${esc(detail.id)}</div><p>${badge(detail.state)} · ${esc(detail.assignedNodeId||t('status.waitingNode'))}</p><progress max="100" value="${detail.progress}"></progress><h3>${esc(t('section.checkpoint'))}</h3><pre>${esc(JSON.stringify(detail.lastCheckpoint,null,2))}</pre><h3>${esc(t('section.result'))}</h3><pre>${esc(JSON.stringify(detail.result||detail.error,null,2))}</pre>${!finished(detail)?`<button id="cancel">${esc(t('task.cancel'))}</button>`:''}<h3>${esc(t('section.taskEvents'))}</h3>${events(city.events.filter(e=>e.taskId===detail.id))}`;
 const device=city.nodes.find(n=>n.id===selectedNode);if(device){$('#detail').hidden=false;$('#detail').innerHTML=`<h2>${esc(device.displayName)}</h2><p>${nodeBadge(device)} · ${esc(device.metadata?.platform)} · ${esc(t('device.agent'))} ${esc(device.agentVersion||t('device.unknown'))}</p><p class="task-id">${esc(device.id)}</p><p>${esc(t('device.lastSeen'))} ${esc(age(device.lastHeartbeatAt))}</p>${metrics(device)}<h3>${esc(t('device.capabilities'))}</h3><p>${esc(device.capabilities.join(' / '))}</p><h3>${esc(t('device.currentTasks'))}</h3>${taskRows(tasks.filter(t=>t.assignedNodeId===device.id&&!finished(t)),t('device.noTasks'))}<h3>${esc(t('device.recentEvents'))}</h3>${events(city.events.filter(e=>e.payload?.nodeId===device.id||tasks.some(t=>t.id===e.taskId&&t.assignedNodeId===device.id)).slice(-12),true)||`<p class="muted">${esc(t('device.noEvents'))}</p>`}`;}
 const member=city.members?.find(m=>m.deviceId===(selectedMember||selectedNode));if(member){$('#detail').hidden=false;if(!selectedNode)$('#detail').innerHTML='';$('#detail').insertAdjacentHTML('beforeend',memberDetail(member));if(messageFocus){const field=$('#member-message-text');field?.focus({preventScroll:true});field?.setSelectionRange(messageFocus.start,messageFocus.end);}}

}
document.addEventListener('click',async e=>{const nav=e.target.closest('[data-page]'),task=e.target.closest('[data-task]'),node=e.target.closest('[data-node]'),locale=e.target.closest('[data-locale]'),goto=e.target.closest('[data-goto]'),room=e.target.closest('[data-home-room]'),schedAction=e.target.closest('[data-scheduler-action]');if(locale)setLocale(locale.dataset.locale);if(goto)go(goto.dataset.goto);if(nav)go(nav.dataset.page);if(room)go('Rooms');if(node){selectedMember=null;selectedNode=node.dataset.node;selected=null;render();$('#detail').scrollIntoView({behavior:'smooth'});}if(task){selectedMember=null;selectedNode=null;selected=task.dataset.task;render();$('#detail').scrollIntoView({behavior:'smooth'});}
// UXI-301: a scheduler action the user takes must REALLY RETURN to the backend, which is an acceptance
// item the independent review checks. The route comes from the shared ACTION_WIRING table, and the
// task id from the button, so the panel and this dispatcher cannot disagree about what is wired.
if(schedAction){const taskRef=schedAction.dataset.schedulerTask,route=schedAction.dataset.schedulerRoute,providerRef=schedAction.dataset.schedulerProvider,revision=schedAction.dataset.schedulerRevision;if(schedAction.disabled||connection!=='ONLINE'||schedulerPending.has(taskRef))return;const epoch=schedulerEpoch,credential=token,cityRef=city?.cityId,ticket={};schedulerPending.set(taskRef,ticket);render();const current=()=>epoch===schedulerEpoch&&credential===token&&cityRef===city?.cityId;try{if(route==='cancel'){await api('tasks/'+encodeURIComponent(taskRef)+'/cancel',{});}else if(route==='create'){await api('tasks',{type:'CHECKPOINT_DEMO'});}else if(route==='providerChoice'){if(!providerRef)throw new Error('no provider was offered to choose from');await api('tasks/'+encodeURIComponent(taskRef)+'/provider-choice',{providerRef});}else if(route==='switchDeclined'){await api('tasks/'+encodeURIComponent(taskRef)+'/switch-declined',{decision:'ALTERNATE_DEVICE',expectedUpdatedAt:revision});}if(current())await refresh();}catch(err){if(current())$('#error').textContent=err.message;}finally{if(current()&&schedulerPending.get(taskRef)===ticket){schedulerPending.delete(taskRef);render();}}}
if(e.target.id==='nearby-browse'||e.target.id==='swap-nearby-browse'){nearbyBrowse();}
if(e.target.id==='nearby-ble'||e.target.id==='swap-nearby-ble'){nearbyBrowse('ble');}
if(e.target.closest('[data-member]')&&!node){selectedMember=e.target.closest('[data-member]').dataset.member;selectedNode=null;selected=null;render();}
if(e.target.id==='member-sharing'){try{const member=city.members.find(m=>m.deviceId===ownMemberRef());await api('node/sharing',{id:member.nodeId,enabled:e.target.dataset.enabled==='true'});await refresh();}catch(error){$('#error').textContent=error.message;}}
if(e.target.dataset?.pairTarget){const target=nearbyCities(nearby??[]).find(row=>row.key===e.target.dataset.pairTarget);if(target?.endpoint&&target.cityRef&&!pairDrafts.pair.busy&&!pairDrafts.swap.busy){pairTarget=target;pendingInvite=null;render();const prefix=page==='Pairing'&&connection==='ONLINE'?'swap':'pair';$(`#${prefix}-code`)?.focus();$(`#${prefix}-code`)?.scrollIntoView({behavior:'smooth',block:'nearest'});}}
// THE PC LIST ACTIONS. One reusable browse, so the button inside the old section and the one on the list run the
// same code path; then the three things a row can do. `join` goes through the EXISTING JOIN-502 ask flow and
// `invite` through the EXISTING pairing session - this surface adds no new trust path of its own.
if(e.target.id==='connect-rescan'){autoProbed=true;nearbyBrowse();}
if(e.target.dataset?.connectAction){const kind=e.target.dataset.connectAction,ref=e.target.dataset.connectRef||null;
 if(kind==='useSelf'){const stored=(()=>{try{return sessionStorage.getItem('city-token')||'';}catch{return '';}})();if(stored){token=stored;$('#pair').hidden=true;$('#content').hidden=false;connect();}else{$('#error').textContent=t('connect.action.useSelf');}}
 else if(kind==='join'&&ref){const row=connectFacts().rows.find(r=>r.cityRef===ref);const target=nearbyCities(row?[row]:[])[0];if(target?.endpoint)askToJoin(target.endpoint,ref,row);else{joinError='join.errorUnreachable';render();}}
 else if(kind==='invite'){const row=connectFacts().rows.find(r=>r.cityRef===ref)||null;const ok=await invitePeer(row);$('#error').textContent=ok?'':t('connect.inviteFailed');}
}
// JOIN-502: the browse above reads the LOCAL City's LAN view; this ask goes to the City the browse
// found, which is a different origin - the reason it carries a claim secret instead of a credential.
if(e.target.dataset?.joinRequest){const ep=e.target.dataset.joinRequest;askToJoin(ep,e.target.dataset.joinRef||null,connectFacts().rows.find(r=>(r.cityRef||r.address)===e.target.dataset.joinRef||r.address===ep.replace(/^https?:\/\//,'').replace(/\/.*$/,''))||null);}// An owner decision returns to the backend, then the UI re-reads canonical state. It never mutates the
// local row: an approval the City did not record must not look approved on screen.
if(e.target.dataset?.joinApprove||e.target.dataset?.joinReject){const id=e.target.dataset.joinApprove||e.target.dataset.joinReject;const action=e.target.dataset.joinApprove?'approve':'reject';e.target.disabled=true;try{await api('join/requests/'+encodeURIComponent(id)+'/'+action,{});await refresh();}catch(err){$('#error').textContent=err.message;e.target.disabled=false;}}
if(e.target.id==='generate-pairing'){await generatePairing();}
// N3: the two halves of "pair with the other PC from what a person can actually hold".
if(e.target.id==='pair-code-connect'||e.target.id==='swap-code-connect'){await pairWithCode(null,e.target.id.startsWith('swap')?'swap':'pair');}
if(e.target.id==='pair-invite-accept'||e.target.id==='swap-invite-accept'){await acceptPendingInvite(e.target.id.startsWith('swap')?'swap':'pair');}
// The share block leads with a WEB link. Copying falls back to selecting the node when the clipboard API is absent,
// because a share button that does nothing in an insecure context is the same defect as no button.
if(e.target.id==='copy-invite'){const link=$('#pairing-link'),note=$('#copy-note');const url=link?link.getAttribute('href'):'';const done=ok=>{if(note)note.textContent=t(ok?'pairing.copied':'pairing.copyManual');};const fallback=()=>{try{const range=document.createRange();range.selectNodeContents(link);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);return document.execCommand('copy');}catch{return false;}};if(navigator.clipboard?.writeText&&url){navigator.clipboard.writeText(url).then(()=>done(true)).catch(()=>done(fallback()));}else done(fallback());}
if(e.target.id==='copy-raw'){const box=$('#pairing-invite'),note=$('#copy-note');const done=ok=>{if(note)note.textContent=t(ok?'pairing.copied':'pairing.copyManual');};const fallback=()=>{try{box.focus();box.select();return document.execCommand('copy');}catch{return false;}};if(navigator.clipboard?.writeText){navigator.clipboard.writeText(box.value).then(()=>done(true)).catch(()=>done(fallback()));}else done(fallback());}if(e.target.dataset?.revoke){await revokeDevice(e.target.dataset.revoke);}if(e.target.id==='cancel'){try{await api('tasks/'+selected+'/cancel',{});await refresh();}catch(err){$('#error').textContent=err.message;}}if(e.target.id==='disconnect'){clearPairing();token='';$('#token').value='';sessionStorage.removeItem('city-token');forgetSession();++generation;clearTimeout(timer);ws?.close();$('#pair').hidden=false;$('#content').hidden=true;go('Home');status('OFFLINE');}});
$('#connect').onclick=async()=>{const value=$('#token').value.trim();$('#token').value='';const invite=parseInvite(value);if(invite){try{const done=await exchangeInvite(invite);if(done?.navigating)return;if(!done?.credential)throw Error('the City returned no credential for that invite');token=done.credential;sessionStorage.setItem('city-token',token);$('#pair').hidden=true;$('#content').hidden=false;connect();}catch(err){$('#error').textContent=err.message;}return;}token=value;sessionStorage.setItem('city-token',token);connect();};
$('#ask-form').addEventListener('submit',e=>{e.preventDefault();ask($('#ask-text').value);});
$('#run').onclick=async()=>{try{$('#run').disabled=true;const target=$('#run-target')?.value||'';if(target){const created=await api('actions',{route:'CITY_TASK',target:'city.task',operation:'CHECKPOINT_DEMO',input:{targetDeviceRef:target},idempotencyKey:(crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+Math.random())});const id=created?.action?.backendRef?.taskId;if(!id)throw new Error(created?.action?.error?.message||'the City refused the targeted task');selectedNode=null;selected=id;}else{const task=await api('tasks',{type:'CHECKPOINT_DEMO'});selectedNode=null;selected=task.id;}await refresh();}catch(e){$('#error').textContent=e.message;}finally{$('#run').disabled=connection!=='ONLINE';}};
window.addEventListener('offline',()=>{disconnected();ws?.close();});window.addEventListener('online',connect);
setInterval(()=>{if(token&&ws?.readyState===1)refresh().catch(e=>{disconnected(e);ws.close();});},4000);
// JOIN-503: an enrolled client's session is re-minted from the session itself, well before it expires, so a
// long-lived window never falls off the end of its credential. Only a session is refreshed here - this page has
// no way to obtain a durable one, which is the property the whole task is for.
setInterval(()=>{if(!token||!token.startsWith('sess:'))return;refreshSession({credential:token}).then(fresh=>{if(!fresh)return;token=rememberSession(fresh.credential);}).catch(err=>{if(err?.code==='SESSION_UNKNOWN'||err?.code==='INSTALLATION_RETIRED'||err?.code==='INSTALLATION_QUARANTINED'){forgetSession();token='';disconnected(new Error(t('device.sessionEnded')));}});},60*60*1000);
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
// N3: A LINK FROM THE OTHER PC. This is the path that works on two plain Windows machines, so it is handled FIRST -
// and it does not connect by itself: the invite is put in front of the person who opened it with one button to
// accept, because a link that arrives by accident must not silently move this browser onto somebody else's City.
const bootQuery=new URLSearchParams(location.search);
const bootInviteLink=bootQuery.get('pair')??bootQuery.get('accept');
if(bootInviteLink){
 history.replaceState(null,'',location.pathname+location.hash);
 // The query string carried the one-time secret, so it is stripped from the address bar at once - the same
 // treatment the `#pair=` fragment already gets.
 try{beginPairingFromInvite(bootInviteLink);}catch(err){$('#error').textContent=err.message;}
}
if(bootInvite){
 try{
  const done=await exchangeInvite(bootInvite);
  if(done?.credential){token=done.credential;try{sessionStorage.setItem('city-token',token);}catch{}}
 }catch(err){$('#error').textContent=err.message;}
}
// The stored session is restored BEFORE the first render and reconciled against the City once the first snapshot arrives, so a code another device consumed while this page was away is not shown as ACTIVE.
pairing.restore();
if(bootShortPair){
 destroyLocalToken();forgetSession();
 const handoff=new URLSearchParams(bootShortPair),code=handoff.get('code')||'',expected=handoff.get('city'),method=handoff.get('method');
 pairDrafts.pair.value=code;
 // Retain the pin even after a refused exchange: retry must never adopt the City
 // that happens to occupy this address in place of the device the user selected.
 pairTarget={endpoint:location.origin,cityRef:expected,displayName:expected||location.host,transport:method==='ble'?'BLE_BOOTSTRAP':'LAN'};
 try{
  if(!expected||expected.length>128||!/^\d{6}$/.test(code)||!['mdns','ble'].includes(method))throw Object.assign(Error('Invalid pairing handoff'),{status:400});
  const done=await exchangeShortCode({code,cityRef:expected,method});
  token=done.credential;sessionStorage.setItem('city-token',token);pairDrafts.pair.value='';pairTarget=null;
 }catch(error){pairNote('pair',pairingErrorKey(error));}
 // The disconnected entry was already mounted before the boot exchange; sync its draft too.
 const field=$('#pair-code');if(field)field.value=pairDrafts.pair.value;
}
// JOIN-503: a fragment session is remembered for the REST OF THIS TAB only, and the fragment is cleared from the
// address bar immediately (the same treatment the token already gets) so a shoulder-surfer or a copied URL does
// not carry a credential. Nothing here is durable storage - that is the launcher's file, on the machine.
if(bootSession){rememberSession(bootSession);if(bootToken||bootInvite)history.replaceState(null,'',location.pathname+location.search);}
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
  await resumeJoin({hint,claim,cityRef:here,displayName:parsed.get('name')||webClientLabel()});
 }catch(err){console.error('join ask could not be delivered',err&&err.message);joinAsk=null;joinError=joinErrorKey(err);render();}
}
if(token)connect();else status('OFFLINE');
// A disconnected client looks for PCs on its own once, so the list is populated before the user asks. Bounded and
// idempotent (see autoProbeOnce); it never blocks the entry channel underneath, which works exactly as before.
autoProbeOnce();
if(token){$('#pair').hidden=true;$('#content').hidden=false;mountTerminal();}
if(pairing.ownerSessionId()!==null)reconcileRestoredPairing().catch(()=>{});
// The pairing entry is filled even when the disconnected screen has NO city record yet, which is exactly the state a
// first-time user is in: `render` bails out without a snapshot, so a card filled only from `render` would have been
// an empty section on the one screen that needs it most.
syncPairEntry();

document.addEventListener('submit',async event=>{
 if(event.target.id!=='city-name-form')return;
 event.preventDefault();const name=event.target.querySelector('#city-name').value;
 try{await api('city/name',{displayName:name},'PATCH');await refresh();}catch(error){$('#error').textContent=error.message;}
});

document.addEventListener('input',event=>{if(event.target.id==='member-message-text'){const ref=$('#member-detail')?.dataset.memberDetail;if(ref)memberDrafts.set(ref,event.target.value);}});
document.addEventListener('submit',async event=>{if(event.target.id!=='member-message-form')return;event.preventDefault();const targetDeviceId=$('#member-detail').dataset.memberDetail;try{await api('members/messages',{targetDeviceId,text:$('#member-message-text').value});memberDrafts.delete(targetDeviceId);await refresh();}catch(error){$('#error').textContent=error.message;}});
