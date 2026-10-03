/**
 * UTOPIA · shareable invite tokens.
 *
 * A pairing credential on its own is opaque: it authenticates against whichever City you already point at, and it
 * cannot tell a client WHICH City it belongs to. That is fine for "type the token of the City you are already
 * looking at", and useless for "paste this and land on my City".
 *
 * The invite is therefore the SAME `utopia://pair?...` payload the pairing QR already carries - host, cityId,
 * one-time session, expiry and secret - so it is self-describing, it reuses the exchange contract that already
 * exists, and nothing new has to be invented to share a City.
 *
 * This lives in its own module rather than inside app.js for one concrete reason: app.js touches `document` and
 * cannot be imported by a test, so while this parsing lived there the only way to exercise it was to drive a
 * browser. A type confusion in the caller (passing the parsed object back in, which stringifies to
 * "[object Object]") then shipped all the way to a live end-to-end run. Pure functions, tested directly.
 */

/** Parse an invite string, or return null if this is not one. Never throws on junk input. */
export function parseInvite(value){
  if(typeof value!=='string')return null;
  const text=value.trim();
  if(!text.startsWith('utopia://pair'))return null;
  const q=text.indexOf('?');
  if(q===-1)return null;
  let params;
  try{params=new URLSearchParams(text.slice(q+1));}catch{return null;}
  const host=params.get('host');
  if(!host)return null;
  return {invite:text,host,cityId:params.get('city'),sessionId:params.get('session'),secret:params.get('secret'),expires:params.get('expires')};
}

/** True when the value looks like an invite rather than a bare credential. */
export function isInvite(value){return parseInvite(value)!==null;}

/** The origin an invite would switch a client to, normalised, or null. */
export function inviteOrigin(value){
  const parsed=parseInvite(value);
  return parsed?parsed.host.replace(/\/+$/,''):null;
}

/** Would following this invite leave the City the client is on? `here` is a location.origin. */
export function inviteLeaves(value,here){
  const there=inviteOrigin(value);
  return there!==null&&there!==String(here??'').replace(/\/+$/,'');
}
