import {requireThat as ok,finite,strings,copy,freeze,text} from './validation.mjs';
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

/**
 * PCF-706 acceptance: "concurrent requests competing for one allowance cannot exceed it".
 *
 * `assertPolicy` answers "may THIS request spend this much" against the whole budget, and it must stay a pure resolver -
 * it has no memory and re-derives from the authority facts on every call, so two concurrent requests each asking for the
 * full allowance are both authorised by it. Aggregate non-exceedance therefore needs a LEDGER, and that is what this is:
 * an explicit, bounded, in-process single-writer record of what has already been claimed.
 *
 * It is deliberately NOT a distributed claim: the workbook does not want a second source of authority, so the ledger
 * holds no identity, credential or task truth, and it says out loud that its scope is one process. A caller that needs
 * cross-process agreement must use the canonical CAS store, not this.
 */
export function createAllowanceLedger({budget, maxClaims = 64, unit = 'minor'} = {}) {
  ok(finite(budget) && Number.isSafeInteger(maxClaims) && maxClaims >= 1 && maxClaims <= 1024 && text(unit), 'ALLOWANCE_LEDGER_CONFIG');
  const claims = new Map();
  let spent = 0;
  const refuse = (reason, detail, extra = {}) => freeze({claimed: false, reason, detail, budget, spent, remaining: budget - spent, ...extra});
  return freeze({
    /** Claim `fee` for one request. Idempotent per requestId, and it never lets the total pass the allowance. */
    claim({requestId, fee, taskId = null, now} = {}) {
      ok(text(requestId) && finite(fee), 'ALLOWANCE_CLAIM_INVALID');
      ok(finite(now), 'ALLOWANCE_CLOCK_REQUIRED');
      const prior = claims.get(requestId);
      // A duplicate claim is the SAME claim: it must not double-charge, and it must not silently change amount.
      if (prior) {
        if (prior.fee !== fee) return refuse('ALLOWANCE_CLAIM_CONFLICT', 'the same request id already claimed a different amount', {requestId, priorFee: prior.fee});
        return freeze({claimed: true, reason: null, duplicate: true, requestId, fee, taskId: prior.taskId, budget, spent, remaining: budget - spent});
      }
      if (claims.size >= maxClaims) return refuse('ALLOWANCE_LEDGER_FULL', 'the bounded claim table is full', {requestId, maxClaims});
      if (fee > 0 && budget <= 0) return refuse('ALLOWANCE_NOT_AUTHORISED', 'no spend is authorised for this allowance', {requestId, fee});
      if (spent + fee > budget) return refuse('ALLOWANCE_EXCEEDED', 'this claim would take the total past the allowance', {requestId, fee, wouldBe: spent + fee});
      claims.set(requestId, freeze({requestId, fee, taskId, claimedAt: now}));
      spent += fee;
      return freeze({claimed: true, reason: null, duplicate: false, requestId, fee, taskId, budget, spent, remaining: budget - spent,
        unit, scope: 'SINGLE_PROCESS_SINGLE_WRITER'});
    },
    /** Release a claim (a cancelled or refused request does not consume the allowance). */
    release({requestId} = {}) {
      ok(text(requestId), 'ALLOWANCE_CLAIM_INVALID');
      const prior = claims.get(requestId);
      if (!prior) return refuse('ALLOWANCE_CLAIM_UNKNOWN', 'no claim was made under this request id', {requestId});
      claims.delete(requestId);
      spent -= prior.fee;
      return freeze({released: true, reason: null, requestId, refunded: prior.fee, budget, spent, remaining: budget - spent});
    },
    snapshot: () => freeze({budget, spent, remaining: budget - spent, unit, claims: claims.size, maxClaims,
      scope: 'SINGLE_PROCESS_SINGLE_WRITER', holdsTaskTruth: false}),
  });
}
