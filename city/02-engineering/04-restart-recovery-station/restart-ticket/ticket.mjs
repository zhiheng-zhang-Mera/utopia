/**
 * UTOPIA · Engineering District — restart ticket behaviour.
 *
 * The versioned, checksummed restart ticket: how its canonical digest is computed,
 * how one is built from a draft, and the verification ladder that decides whether a
 * parsed document may be acted on. Plus the digest helper and the supervisor
 * ledger's empty shape.
 *
 * Donor: `dsh-restart` `src/plugin/ticket-store.ts` (`ticketChecksum`, `buildTicket`,
 * `verifyTicket`, `emptyLedger`) and `src/plugin/atomic.ts` (`sha256`), frozen at
 * commit e20fb6cc43e27cedf6303471e5b8ee18e1383ecd.
 *
 * The rules that must never be softened:
 *   - every check is a refusal, never a repair. The donor says it in the header of
 *     the module it belonged to: "a ticket that does not verify is deleted ... because
 *     leaving a doubtful ticket where a supervisor might read it is the failure mode
 *     this whole module exists to prevent";
 *   - the ladder has exactly the donor's six rungs, in the donor's order — a missing
 *     document, then a non-object, then the schema version, then the checksum, then
 *     expiry, then the process id — and each rung returns its own fixed rejection
 *     code and detail string. No seventh rung is added: a document that is short or
 *     hand-edited fails the donor's checksum rung, which is already fail-closed;
 *   - the digest covers the canonical form of every field except `checksum` itself, so
 *     two tickets with the same fields in different key insertion orders hash the
 *     same, and a tampered field or a truncated document does not;
 *   - `canonicalJson` is imported from the sibling `../restart-protocol/canonical-json.mjs`,
 *     the port of the donor's `src/shared/protocol.ts`. The donor had one home for the
 *     function that defines a checksum and the port keeps one: two copies that ever
 *     drifted would make a ticket built by one module stop verifying in the other,
 *     silently;
 *   - time is a parameter (`nowMs`). The donor already took it, so there is no clock
 *     to inject and no hidden `Date.now()`.
 *
 * No filesystem: the donor's atomic write (temp file + fsync + rename) is deliberately
 * not ported. See DONOR.json `knownDifferences` for the contract that was left behind.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../restart-protocol/canonical-json.mjs';
import {
  TICKET_SCHEMA_VERSION,
  TICKET_FIELDS,
  TicketRejection,
  emptyLedger as emptyLedgerContract,
  restartTicket,
} from './contracts.mjs';

/**
 * The donor's `atomic.ts` header, carried here because the code it describes is not.
 *
 * Donor `src/plugin/atomic.ts` @ e20fb6cc43e27cedf6303471e5b8ee18e1383ecd:
 *
 *   "The restart path writes files that another process will act on: a stale or
 *    half-written ticket must never be mistaken for a live one. So every write here
 *    is temp-file + fsync + rename, every document carries a schema version, and the
 *    ticket carries a checksum over its own canonical form."
 *
 * The atomicity contract is therefore: a writer of a ticket must write to a sibling
 * temp file, `fsync` it so the bytes are durable, then `rename` it over the target, so
 * that a crash leaves either the old file or the new one and never a mixture. This
 * module ports only the checksum half — the digest that lets a reader prove a document
 * is whole — because the port has no filesystem. Every check below exists so that a
 * document which is *not* whole is refused rather than trusted.
 */
export const ATOMICITY_CONTRACT = Object.freeze({
  donorFile: 'src/plugin/atomic.ts',
  commit: 'e20fb6cc43e27cedf6303471e5b8ee18e1383ecd',
  sequence: Object.freeze(['write sibling temp file', 'fsync the temp file', 'rename over the target']),
  guarantee: 'a crash leaves either the old document or the new one, never a mixture',
  portedHere: false,
});

/**
 * `sha256:<hex>` digest of a UTF-8 string.
 *
 * Donor: `sha256` in `src/plugin/atomic.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd, unchanged — the `sha256:` prefix is part
 * of the digest's spelling and is never stripped.
 *
 * @param {string} text
 * @returns {string}
 */
export function sha256(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * Compute the checksum for a ticket.
 *
 * Donor: `ticketChecksum` in `src/plugin/ticket-store.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd. The digest covers the canonical form of
 * every field except `checksum` itself, so a supervisor can detect a tampered or
 * truncated document without any shared secret. This is integrity, not authentication:
 * the ticket lives in a directory only the harness user can write.
 *
 * @param {object} ticket a ticket, or a ticket's fields without `checksum`
 * @returns {string} `sha256:<hex>`
 */
export function ticketChecksum(ticket) {
  return sha256(canonicalJson(ticket));
}

/**
 * Build a complete ticket from a draft.
 *
 * Donor: `buildTicket` in `src/plugin/ticket-store.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd. `createdAt` is `nowMs`, `expiresAt` is
 * `nowMs + ttlMs`, the schema version is the current one, and the checksum is taken
 * over every other field. The draft's optional `ttlFromMs` is declared by the donor
 * and never read by it; it is not read here either.
 *
 * There is no precondition check beyond the donor's own: the two `new Date(...)
 * .toISOString()` calls throw `RangeError: Invalid time value` for a non-finite or
 * out-of-range instant, exactly as they do in the donor. The port adds no guard and
 * no `TypeError`, because any guard broadens the set of rejected drafts beyond the
 * set the donor rejects, and a migration must not change what a caller may pass.
 *
 * @param {object} draft the caller's fields
 * @returns {object} the ticket
 * @throws {RangeError} when `nowMs` or `nowMs + ttlMs` is not a valid instant
 */
export function buildTicket(draft) {
  const fields = {
    schemaVersion: TICKET_SCHEMA_VERSION,
    ticketId: draft.ticketId,
    requestId: draft.requestId,
    mode: draft.mode,
    reasonCode: draft.reasonCode,
    reasonSummary: draft.reasonSummary,
    pid: draft.pid,
    createdAt: new Date(draft.nowMs).toISOString(),
    expiresAt: new Date(draft.nowMs + draft.ttlMs).toISOString(),
    cleanShutdown: draft.cleanShutdown,
    checkpointId: draft.checkpointId,
  };
  return restartTicket(fields, ticketChecksum(fields));
}

/**
 * Verify a parsed ticket.
 *
 * Donor: `verifyTicket` in `src/plugin/ticket-store.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd. The ladder is the donor's, rung for rung,
 * in the donor's order, with the donor's rejection codes and detail strings, and
 * nothing else:
 *
 *   1. `null` or `undefined`                      -> `missing`         'no ticket file'
 *   2. not an object (`typeof candidate !== 'object'`) -> `malformed`  'ticket is not an object'
 *   3. `schemaVersion !== TICKET_SCHEMA_VERSION`  -> `schema_version`  'ticket schemaVersion <v> is not 1'
 *   4. `typeof checksum !== 'string' || checksum !== ticketChecksum(rest)` -> `checksum`  'ticket checksum does not match its contents'
 *   5. `!Number.isFinite(Date.parse(expiresAt)) || expiresAt <= nowMs`     -> `expired`   'ticket expired at <expiresAt>'
 *   6. `expectedPid !== undefined && ticket.pid !== expectedPid`           -> `wrong_pid` 'ticket targets pid <pid>, not <expectedPid>'
 *   otherwise                                     -> valid, detail 'ticket verified'
 *
 * Rung 4 hashes the fields the candidate actually carries — `const { checksum, ...rest }
 * = ticket` — so a document that is short, hand-edited or carries an extra field fails
 * `checksum` rather than being refused by a field-presence rule the donor does not have.
 * Rung 5 reports `String(candidate.expiresAt)`, so a missing `expiresAt` reads
 * `ticket expired at undefined`.
 *
 * @param {unknown} candidate the parsed document, or `null` when there was no file
 * @param {number} nowMs current time in epoch milliseconds, supplied by the caller
 * @param {number} [expectedPid] the process the ticket must target, when the caller cares
 * @returns {{valid: boolean, ticket: object | null, rejection: string | null, detail: string}}
 */
export function verifyTicket(candidate, nowMs, expectedPid) {
  if (candidate === null || candidate === undefined) {
    return { valid: false, ticket: null, rejection: TicketRejection.missing, detail: 'no ticket file' };
  }
  if (typeof candidate !== 'object') {
    return { valid: false, ticket: null, rejection: TicketRejection.malformed, detail: 'ticket is not an object' };
  }
  if (candidate.schemaVersion !== TICKET_SCHEMA_VERSION) {
    return {
      valid: false,
      ticket: null,
      rejection: TicketRejection.schema_version,
      detail: `ticket schemaVersion ${String(candidate.schemaVersion)} is not ${TICKET_SCHEMA_VERSION}`,
    };
  }
  const { checksum, ...rest } = candidate;
  if (typeof checksum !== 'string' || checksum !== ticketChecksum(rest)) {
    return {
      valid: false,
      ticket: null,
      rejection: TicketRejection.checksum,
      detail: 'ticket checksum does not match its contents',
    };
  }
  const expiresAt = Date.parse(candidate.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    return {
      valid: false,
      ticket: null,
      rejection: TicketRejection.expired,
      detail: `ticket expired at ${String(candidate.expiresAt)}`,
    };
  }
  if (expectedPid !== undefined && candidate.pid !== expectedPid) {
    return {
      valid: false,
      ticket: null,
      rejection: TicketRejection.wrong_pid,
      detail: `ticket targets pid ${candidate.pid}, not ${expectedPid}`,
    };
  }
  return { valid: true, ticket: candidate, rejection: null, detail: 'ticket verified' };
}

/**
 * A ledger with nothing recorded.
 *
 * Donor: `emptyLedger()` in `src/plugin/ticket-store.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd, re-exported from the contract module so
 * the shape has one home. Each call returns a fresh object with its own
 * `uncleanStarts` array, exactly as the donor's literal did.
 *
 * @returns {object} `{schemaVersion: 1, uncleanStarts: [], safeMode: false, safeModeReason: null, safeModeAt: null, relaunches: 0}`
 */
export function emptyLedger() {
  return emptyLedgerContract();
}

/**
 * The ticket field list, the schema version, the rejection vocabulary — and the
 * canonical form, re-exported from its single home so this module's public surface is
 * unchanged by the canonical form now living in the sibling `restart-protocol` module.
 */
export { TICKET_FIELDS, TICKET_SCHEMA_VERSION, TicketRejection, canonicalJson };
