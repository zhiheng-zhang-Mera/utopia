// Canonical, dependency-free serialization helpers for Engineering Manager contracts.
// No filesystem, network or clock access.
import { createHash } from 'node:crypto';

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Deterministic JSON: object keys are sorted so the same logical envelope always
// produces the same digest on every host, process and retry.
export function canonicalJson(value) {
 if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
 if (isPlainObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
 return JSON.stringify(value ?? null);
}

export function digestOf(value) {
 return 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function isDigest(value) {
 return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function isText(value) {
 return typeof value === 'string' && value.trim().length > 0;
}

export function isPlainObjectValue(value) {
 return isPlainObject(value);
}
