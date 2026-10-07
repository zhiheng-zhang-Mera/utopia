// Minimize structured observations; never collect prompt/reasoning/authentication payloads.
//
// Redaction is PATTERN-based, and that is a stated limitation rather than a guarantee: a secret whose shape is not
// listed below still reaches the report. Four shapes were added after an acceptance probe carried an AWS-style key
// id through `ownership.city_owner` and `status` into report.json/report.md in plain text - the earlier rule set
// covered GitHub tokens, `password=` pairs and JWTs but not the AWS/GCP/Slack/Stripe prefixes or PEM bodies, which
// are exactly what a health check is most likely to meet in a real tree.
export function redactText(value) {
  return value.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY_ID]')
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED_GOOGLE_API_KEY]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, '[REDACTED_STRIPE_KEY]')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]{12,}/g, '[REDACTED_CREDENTIAL]')
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
