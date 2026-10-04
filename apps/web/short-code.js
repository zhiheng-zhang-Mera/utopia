/** A code is always exchanged at its City's own origin. No credential crosses origins. */
export function codeHandoff({ endpoint, cityRef, code, method = 'mdns' }) {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !cityRef || !/^\d{6}$/.test(code) || !['mdns','ble'].includes(method)) throw new Error('Invalid pairing target');
  return url.origin + '/#short-pair=' + encodeURIComponent(new URLSearchParams({ city: cityRef, code, method }).toString());
}

export async function exchangeShortCode({ code, cityRef = null, method = 'mdns', fetchImpl = globalThis.fetch }) {
  if (!/^\d{6}$/.test(code) || !['mdns','ble'].includes(method)) throw Object.assign(Error('Invalid short code'), { status: 400 });
  const headers = { 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' };
  const read = async (path, options = {}) => {
    const response = await fetchImpl(path, { headers, signal: AbortSignal.timeout(8000), ...options });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(Error(body?.error || 'Pairing refused'), { status: response.status });
    if (body?.apiVersion !== 0 || body?.schemaVersion !== 0) throw Error('Protocol mismatch');
    return body;
  };
  const info = await read('/api/v0/pairing/info');
  const d = info.descriptor;
  if (!d?.cityId || cityRef && cityRef !== d.cityId) throw Object.assign(Error('City identity mismatch'), { status: 409 });
  if (info.sessionState === 'LOCKED') throw Object.assign(Error('Pairing session locked'), { status: 429 });
  if (!info.activeSession || !d.pairingSessionId) throw Object.assign(Error('Pairing session expired or used'), { status: 410 });
  const result = await read('/api/v0/pairing/exchange', { method: 'POST', body: JSON.stringify({ cityId: d.cityId, sessionId: d.pairingSessionId, method, shortCode: code }) });
  if (!result.credential || result.cityId !== d.cityId) throw Error('Invalid pairing response');
  return result;
}
