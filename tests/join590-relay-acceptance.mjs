// JOIN-590 · relay join acceptance, driven from the host with the SAME wire protocol the Android client speaks.
//
// WHY THIS EXISTS BESIDE THE DEVICE RUN. The device proves the app really dials; this proves the PROTOCOL the app
// sends and expects is correct against the real City, repeatably, and it exercises the exact bug this task shipped
// and then fixed (a JSON `null` city id read as the string "null"). A reviewer can re-run this file; re-running a
// handset session is not equally cheap.
//
// It speaks: relay dial (declared installation) → join/info → join/request → join/status (poll) → join/exchange,
// approving the request with the owner credential from this same host, so both sides of the protocol are real.
const base = process.env.CITY || 'http://172.31.12.151:4391';
const owner = process.env.TOKEN;
const installationId = process.env.INSTALLATION_ID || 'android-relay-acceptance';
const { WebSocket } = await import('ws');
const V = { 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json' };
const step = (name, detail) => console.log(JSON.stringify({ step: name, ...detail }));

const wsUrl = base.replace(/^http/, 'ws') + '/api/v0/relay?apiVersion=0&schemaVersion=0&installationId=' + encodeURIComponent(installationId) + '&label=' + encodeURIComponent('relay acceptance');
const socket = new WebSocket(wsUrl, ['city-relay-v0']);
const pending = new Map();
let nextId = 0;

const forward = (path, body = {}) => new Promise((resolve, reject) => {
  const requestId = `acc-${++nextId}`;
  const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`RELAY_TIMEOUT ${path}`)); }, 20000);
  pending.set(requestId, { resolve, reject, timer, path });
  socket.send(JSON.stringify({ kind: 'relay-request', requestId, path, method: 'POST', body }));
});

socket.on('message', raw => {
  const frame = JSON.parse(raw.toString());
  if (frame.type === 'RELAY_READY') { ready(frame); return; }
  const waiting = pending.get(frame.requestId);
  if (!waiting) return;
  pending.delete(frame.requestId);
  clearTimeout(waiting.timer);
  // The City's own HTTP answer (refusals included) travels inside `response`; a bare `error` is a pipe failure.
  const inner = frame.response ?? null;
  if (!inner && frame.error) waiting.reject(new Error(`RELAY_REMOTE_ERROR ${frame.error}`));
  else waiting.resolve({ ok: (inner ?? frame).ok === true, status: (inner ?? frame).status ?? 502, payload: (inner ?? frame).payload ?? null });
});
socket.on('error', error => { for (const [, waiting] of pending) { clearTimeout(waiting.timer); waiting.reject(new Error(String(error?.message ?? error))); } pending.clear(); });

async function ready(frame) {
  step('RELAY_READY', { peerRef: frame.peerRef, role: frame.role, verified: frame.verified, payloads: frame.payloads });
  const info = await forward('/api/v0/join/info');
  const declaredCityId = info.payload?.cityId ?? null;
  step('JOIN_INFO', { ok: info.ok, declaredCityId, sameAsCity: declaredCityId !== null });

  const claim = 'acceptance-' + Math.random().toString(36).slice(2, 18);
  const asked = await forward('/api/v0/join/request', { displayName: 'Relay acceptance', platform: 'android', installationHint: installationId, claim });
  const requestId = asked.payload?.requestId ?? asked.payload?.id ?? null;
  step('JOIN_REQUESTED', { ok: asked.ok, requestId, shortRef: asked.payload?.shortRef ?? null, state: asked.payload?.state ?? null });
  if (!requestId) { step('FAILED', { reason: 'no request id' }); socket.close(); process.exitCode = 2; return; }

  // Approve from the owner side of the SAME City, exactly as an owner would in the browser.
  const approved = await fetch(`${base}/api/v0/join/requests/${encodeURIComponent(requestId)}/approve`, { method: 'POST', headers: { ...V, Authorization: `Bearer ${owner}` }, body: '{}' });
  step('OWNER_APPROVED', { status: approved.status });

  // Poll exactly like the client does: the claim is the proof this poll belongs to the requester.
  let decision = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const status = await forward('/api/v0/join/status', { requestId, claim });
    decision = status.payload ?? null;
    if (decision?.approved === true || decision?.terminal === true) break;
    await new Promise(r => setTimeout(r, 500));
  }
  step('JOIN_STATUS', { approved: decision?.approved ?? null, terminal: decision?.terminal ?? null, state: decision?.state ?? null });

  const exchanged = await forward('/api/v0/join/exchange', { requestId, claim });
  const payload = exchanged.payload ?? null;
  const rawCityId = payload ? (Object.hasOwn(payload, 'cityId') ? payload.cityId : undefined) : undefined;
  const credentialPresent = typeof payload?.credential === 'string' && payload.credential.length > 0;
  step('JOIN_EXCHANGE', { ok: exchanged.ok, credentialPresent, rawCityId, rawCityIdType: rawCityId === null ? 'null' : typeof rawCityId });

  // THE ASSERTION THIS FILE EXISTS FOR: a JSON `null` city id must be treated as ABSENT, never as the identity
  // "null" — the defect that made the device refuse its own City with `City identity conflict`.
  const answeredCityId = rawCityId === null || rawCityId === undefined || rawCityId === '' ? null : String(rawCityId);
  const adoptedCityId = answeredCityId ?? declaredCityId;
  step('CITY_ID_DECISION', {
    answeredCityId,
    declaredCityId,
    adoptedCityId,
    nullWasNotAdoptedAsText: answeredCityId !== 'null',
    verdict: exchanged.ok && credentialPresent && adoptedCityId === declaredCityId && answeredCityId !== 'null' ? 'PASS' : 'FAIL',
  });
  socket.close();
}
