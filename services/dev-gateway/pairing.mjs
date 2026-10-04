import {randomBytes,randomInt,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import QRCode from 'qrcode';
const hash=s=>createHash('sha256').update(String(s)).digest();
const error=(status,message)=>{throw Object.assign(new Error(message),{status});};
export class Pairing {
 constructor({cityId,endpoint,credential,clock=Date.now,ttlMs=300000,onChange=()=>{}}){Object.assign(this,{cityId,endpoint,credential,clock,ttlMs,onChange});this.session=null;}
 active(){const s=this.session;return !!s&&!s.usedAt&&this.clock()<s.expiresAt&&s.attempts<5;}
 descriptor(){const s=this.active()?this.session:null;const u=new URL(this.endpoint);return {descriptorVersion:1,cityId:this.cityId,displayName:'Utopia · Alien',endpoint:{scheme:u.protocol.slice(0,-1),host:u.hostname,port:Number(u.port||(u.protocol==='https:'?443:80))},apiVersion:0,schemaVersion:0,pairingSessionId:s?.id||null,expiresAt:s?new Date(s.expiresAt).toISOString():null};}
 info(){const d=this.descriptor(),s=this.session;const sessionState=!s?'IDLE':s.usedAt?'USED':this.clock()>=s.expiresAt?'EXPIRED':s.attempts>=5?'LOCKED':'ACTIVE';return {cityId:this.cityId,displayName:d.displayName,descriptor:d,activeSession:this.active(),expiresAt:d.expiresAt,shortCodeEnabled:this.active(),sessionState};}
 async create(){
  const secret=randomBytes(32).toString('base64url'),shortCode=String(randomInt(1000000)).padStart(6,'0'),createdAt=this.clock();
  const s={id:randomUUID(),secretHash:hash(secret),codeHash:hash(shortCode),createdAt,expiresAt:createdAt+this.ttlMs,usedAt:null,attempts:0};this.session=s;
  const descriptor=this.descriptor();const params=new URLSearchParams({v:'1',host:this.endpoint,city:this.cityId,session:s.id,expires:descriptor.expiresAt,secret});const qrPayload='utopia://pair?'+params;
  // THE SAME MATERIAL AS A PLAIN WEB LINK, because `utopia://` is a custom scheme: a person cannot paste it into a
  // browser's address bar and have anything happen. The web link is what "share this with the other PC" actually
  // needs, and the other machine opens it, sees the invite and accepts it in one click. `qrPayload` is NOT replaced -
  // the QR and the Android deep link keep working exactly as before.
  //
  // WHAT THIS COSTS, stated rather than glossed over: the one-time secret is now in a URL a server may log. It is
  // bounded by design - single use, short TTL, bound to one session id, and locked after five attempts - and the
  // alternative (a scheme nobody can paste) is why the sharing path was unusable on a plain Windows PC.
  const inviteUrl=this.endpoint+'/?pair='+encodeURIComponent(params.toString());
  const qrSvg=await QRCode.toString(qrPayload,{type:'svg',width:360,margin:4,errorCorrectionLevel:'M'});
  this.onChange(descriptor);
  return {descriptor,pairingSessionId:s.id,shortCode,createdAt:new Date(createdAt).toISOString(),expiresAt:descriptor.expiresAt,qrPayload,qrSvg,inviteUrl,inviteValue:params.toString()};
 }
 exchange(body){
  if(body?.cityId!==this.cityId)error(409,'City identity mismatch');
  if(!['qr','mdns','ble'].includes(body.method))error(400,'Unknown pairing method');
  const s=this.session;if(!s||body.sessionId!==s.id||s.usedAt||this.clock()>=s.expiresAt)error(410,'Pairing session expired, replaced or already used');
  if(s.attempts>=5)error(429,'Pairing session locked after failed attempts; refresh on Alien');
  const material=body.method==='qr'?body.secret:body.shortCode;
  const wanted=body.method==='qr'?s.secretHash:s.codeHash;
  if(typeof material!=='string'||material.length>256||!timingSafeEqual(hash(material),wanted)){s.attempts++;error(403,'Incorrect pairing secret or short code');}
  s.usedAt=this.clock();this.onChange(this.descriptor());
  return {cityId:this.cityId,endpoint:this.descriptor().endpoint,credential:this.credential};
 }
}
