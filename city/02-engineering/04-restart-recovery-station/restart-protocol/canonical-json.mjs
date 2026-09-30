/**
 * UTOPIA · Engineering — restart-recovery-station — canonical JSON.
 *
 * Donor: dsh-restart `src/shared/protocol.ts` (`canonicalJson`) @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd. Ported verbatim: same branch order,
 * same key comparator, same separators, same `JSON.stringify(value) ?? 'null'`
 * fallback.
 *
 * Why it exists at all: a restart ticket carries a checksum computed over its own
 * canonical form, and the supervisor — a *different process* — recomputes it. If
 * either side sorted keys differently, or emitted `undefined` instead of dropping
 * it, a legitimate ticket would read as tampered. The ordering and separator
 * behaviour is therefore part of the contract, not an implementation detail.
 *
 * Determinism: this module reads no clock, no environment, no filesystem and no
 * randomness. It is pure over its input.
 */

/**
 * Canonical JSON with sorted keys, so a checksum is reproducible.
 *
 * - `null` and every non-object (including `undefined`, functions and symbols)
 *   go through `JSON.stringify`, falling back to the string `'null'` when
 *   `JSON.stringify` answers `undefined`. That is why `canonicalJson(undefined)`
 *   is `'null'` rather than a thrown error.
 * - Arrays recurse element-wise and keep their positions; a hole or `undefined`
 *   element becomes `null`.
 * - Objects drop `undefined` values and sort the remaining keys with the plain
 *   code-unit comparator `a < b ? -1 : a > b ? 1 : 0` — deliberately *not* a
 *   locale comparator and *not* numeric, so `{"10":1,"9":2}` stays `{"10":1,"9":2}`.
 * - Emissions use `:` and `,` with no whitespace: `{"key":<canonical>}`.
 *
 * @donor dsh-restart src/shared/protocol.ts `canonicalJson` @ e20fb6cc43e27cedf6303471e5b8ee18e1383ecd
 * @param {unknown} value - any JSON-representable value.
 * @returns {string} the canonical JSON text.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}
