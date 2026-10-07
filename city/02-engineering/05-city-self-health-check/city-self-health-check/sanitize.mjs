// Minimize structured observations; never collect prompt/reasoning/authentication payloads.
export function redactText(value) {
  return value.replace(/\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]{12,}/g, '[REDACTED_CREDENTIAL]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '[REDACTED_AUTH]')
    .replace(/\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret)\s*[:=]\s*["']?[^\s,"';&}]+/gi, '[REDACTED_SECRET]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[REDACTED_USERINFO]@')
    .replace(/([?&])(?:token|auth|key|password|secret)=[^&#\s]*/gi, '$1[REDACTED_QUERY]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]');
}
export function minimize(value, depth = 0) {
  if (depth > 30) return '[OMITTED_DEPTH]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(x => minimize(x, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:token|password|secret|credential|authorization|api[_-]?key|prompt|reasoning|chain_of_thought)$/i.test(key)).map(([key, item]) => [redactText(key), minimize(item, depth + 1)]));
  return value;
}
