export function acceptanceStatus(liveStatus, checks) {
  if (!checks.every(value => value === true)) return 'FAIL';
  return liveStatus === 'ok' ? 'PASS' : 'BLOCKED_EXTERNAL';
}
