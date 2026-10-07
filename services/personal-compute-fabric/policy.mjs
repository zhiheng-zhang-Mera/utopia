import {requireThat as ok,finite,strings,copy,freeze} from './validation.mjs';
const MODES=['ORIGIN_DEVICE_ONLY','TRUSTED_PERSONAL_FABRIC','APPROVED_CLOUD'];
export function resolveEffectivePolicy(request={},facts={},now){
  copy(request);copy(facts);ok(finite(now),'INVALID_CLOCK');
  const mode=request.mode??'ORIGIN_DEVICE_ONLY';ok(MODES.includes(mode),'INVALID_MODE');
  ok(Number.isSafeInteger(facts.version)&&facts.version>=0,'AUTHORITY_VERSION');
  ok(finite(facts.expiresAt)&&strings(facts.allowedDevices)&&strings(facts.dataScopes),'INVALID_AUTHORITY');
  if(mode==='APPROVED_CLOUD')ok(facts.cloudConsent===true&&finite(facts.budget)&&facts.budget>0,'CLOUD_NOT_APPROVED');
  const allowedDevices=mode==='ORIGIN_DEVICE_ONLY'?[facts.originDeviceId]:(request.allowedDevices??facts.allowedDevices);
  ok(strings(allowedDevices)&&allowedDevices.every(id=>facts.allowedDevices.includes(id)),'DEVICE_NOT_APPROVED');
  const dataScopes=request.dataScopes??facts.dataScopes;ok(strings(dataScopes)&&dataScopes.every(x=>facts.dataScopes.includes(x)),'SCOPE_NOT_APPROVED');
  const budget=request.budget??facts.budget??0;ok(finite(budget)&&budget<=(facts.budget??0),'BUDGET_NOT_APPROVED');
  const expiresAt=Math.min(request.expiresAt??facts.expiresAt,facts.expiresAt);ok(finite(expiresAt),'INVALID_EXPIRY');
  return freeze({version:facts.version,mode,authorized:facts.authorized===true,originDeviceId:facts.originDeviceId,allowedDevices:[...allowedDevices],dataScopes:[...dataScopes],sharingConsent:facts.sharingConsent===true,cloudConsent:facts.cloudConsent===true,budget,expiresAt});
}
export function assertPolicy(policy,{deviceId,dataScope,fee=0,cloud=false},now){
  ok(finite(now)&&policy.authorized===true&&now<policy.expiresAt,'AUTHORITY_EXPIRED_OR_REVOKED');
  ok(policy.allowedDevices.includes(deviceId),'DEVICE_NOT_APPROVED');ok(policy.dataScopes.includes(dataScope),'SCOPE_NOT_APPROVED');
  if(deviceId!==policy.originDeviceId)ok(policy.mode!=='ORIGIN_DEVICE_ONLY'&&policy.sharingConsent===true,'SHARING_NOT_APPROVED');
  ok(finite(fee)&&fee<=policy.budget,'BUDGET_NOT_APPROVED');
  if(cloud||fee>0)ok(policy.mode==='APPROVED_CLOUD'&&policy.cloudConsent===true&&policy.budget>0,'CLOUD_NOT_APPROVED');
  return true;
}
