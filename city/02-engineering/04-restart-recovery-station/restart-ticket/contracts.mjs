/**
 * UTOPIA · Engineering District — restart ticket contracts.
 *
 * The value shapes a restart ticket is made of: the ticket, draft, verification and
 * supervisor-ledger field lists, the closed `TicketRejection` vocabulary, and the two
 * factories that copy a ticket into existence. Nothing here touches a disk, a clock,
 * a process table or a digest.
 *
 * Donor: `dsh-restart` `src/plugin/ticket-store.ts` and `src/shared/protocol.ts`,
 * frozen at commit e20fb6cc43e27cedf6303471e5b8ee18e1383ecd. The donor declared these
 * shapes as TypeScript interfaces; here they are data, because the port has no compiler.
 *
 * Vocabulary:
 *   RestartTicket     the versioned, checksummed document the supervisor reads
 *   TicketDraft       what a caller supplies; the builder fills in schema version,
 *                     timestamps and checksum
 *   TicketVerification  the result of the verification ladder in `./ticket.mjs`
 *   TicketRejection   the closed vocabulary of reasons a ticket is refused
 *   SupervisorLedger  the supervisor's durable record of unclean starts and safe mode
 *
 * The factories copy; they do not judge. `restartTicket` copies the twelve fields it is
 * given, unfrozen and unmodified, and `ticketFromDocument` refuses a document whose
 * stored checksum does not cover the fields it received. Neither one adds, drops,
 * defaults or repairs a field: whatever reaches `./ticket.mjs` is judged by the donor's
 * six-rung ladder and by nothing else.
 */

/**
 * On-disk schema version of a restart ticket.
 *
 * Donor: `src/shared/protocol.ts` `TICKET_SCHEMA_VERSION` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd. Declared here because the ticket schema
 * version belongs to the ticket contract.
 */
export const TICKET_SCHEMA_VERSION = 1;

/**
 * Restart scope.
 *
 * Declared but not enforced by the donor: `ticket-store.ts` copied `draft.mode` and
 * compared nothing, and the ladder never looks at `mode`, so the port keeps the
 * vocabulary without inventing a mode gate.
 */
export const RESTART_MODES = Object.freeze(['application', 'system']);

/**
 * Why a ticket was rejected by the verifier.
 *
 * Donor: `TicketRejection` in `src/plugin/ticket-store.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd — the same six values, no additions.
 *
 *   missing         there was no ticket at all
 *   schema_version  the document says it is a version this code does not speak
 *   malformed       it is not an object
 *   checksum        the digest does not cover the fields that were received
 *   expired         the ticket is void because its instant has passed
 *   wrong_pid       the ticket targets a different process than the one asked about
 */
export const TicketRejection = Object.freeze({
  missing: 'missing',
  schema_version: 'schema_version',
  malformed: 'malformed',
  checksum: 'checksum',
  expired: 'expired',
  wrong_pid: 'wrong_pid',
});

/** Every rejection code, in the order the ladder can produce them. */
export const TICKET_REJECTIONS = Object.freeze([
  TicketRejection.missing,
  TicketRejection.schema_version,
  TicketRejection.malformed,
  TicketRejection.checksum,
  TicketRejection.expired,
  TicketRejection.wrong_pid,
]);

/**
 * The twelve fields of a `RestartTicket`, in the donor's declaration order.
 *
 * Donor: `RestartTicket` in `src/shared/protocol.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd. This describes the document the donor
 * writes; it is not a filter the verifier applies. The ladder accepts any object with
 * the current schema version and a checksum over the fields it received.
 */
export const TICKET_FIELDS = Object.freeze([
  'schemaVersion',
  'ticketId',
  'requestId',
  'mode',
  'reasonCode',
  'reasonSummary',
  'pid',
  'createdAt',
  'expiresAt',
  'cleanShutdown',
  'checkpointId',
  'checksum',
]);

/**
 * The fields a caller supplies to the builder.
 *
 * Donor: `TicketDraft` in `src/plugin/ticket-store.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd. `ttlFromMs` is optional in the donor and
 * is never read by it; the port declares it and ignores it in exactly the same way.
 */
export const TICKET_DRAFT_FIELDS = Object.freeze([
  'ticketId',
  'requestId',
  'mode',
  'reasonCode',
  'reasonSummary',
  'pid',
  'ttlMs',
  'cleanShutdown',
  'checkpointId',
  'nowMs',
]);

/** The optional draft field the donor declares and does not read. */
export const TICKET_DRAFT_OPTIONAL_FIELDS = Object.freeze(['ttlFromMs']);

/**
 * The four fields of a `TicketVerification`.
 *
 * Donor: `TicketVerification` in `src/plugin/ticket-store.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd.
 */
export const TICKET_VERIFICATION_FIELDS = Object.freeze(['valid', 'ticket', 'rejection', 'detail']);

/**
 * The six fields of a `SupervisorLedger`, in the donor's declaration order.
 *
 * Donor: `SupervisorLedger` in `src/shared/protocol.ts` and `emptyLedger()` in
 * `src/plugin/ticket-store.ts` @ e20fb6cc43e27cedf6303471e5b8ee18e1383ecd.
 */
export const LEDGER_FIELDS = Object.freeze([
  'schemaVersion',
  'uncleanStarts',
  'safeMode',
  'safeModeReason',
  'safeModeAt',
  'relaunches',
]);

/** The schema version `emptyLedger()` writes. The donor hard-codes 1. */
export const LEDGER_SCHEMA_VERSION = 1;

/**
 * The donor's empty supervisor ledger.
 *
 * Donor: `emptyLedger()` in `src/plugin/ticket-store.ts` @
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd — the same six fields with the same values,
 * schema version 1 hard-coded as a literal. The returned object is mutable and
 * unfrozen, exactly as the donor's is, and each call gets its own `uncleanStarts`.
 */
export function emptyLedger() {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    uncleanStarts: [],
    safeMode: false,
    safeModeReason: null,
    safeModeAt: null,
    relaunches: 0,
  };
}

/**
 * Copy a ticket's fields into a new object, unfrozen.
 *
 * The donor's `buildTicket` returned an object literal; the port returns the same
 * fields in the same order. No field is defaulted, coerced, added or dropped, so a
 * checksum taken over this object is the checksum the donor would have taken.
 *
 * @param {object} fields the ticket's fields without `checksum`
 * @param {string} checksum the checksum the fields were built with
 * @returns {object} the ticket
 */
export function restartTicket(fields = {}, checksum = fields.checksum) {
  return {
    schemaVersion: TICKET_SCHEMA_VERSION,
    ticketId: fields.ticketId,
    requestId: fields.requestId,
    mode: fields.mode,
    reasonCode: fields.reasonCode,
    reasonSummary: fields.reasonSummary,
    pid: fields.pid,
    createdAt: fields.createdAt,
    expiresAt: fields.expiresAt,
    cleanShutdown: fields.cleanShutdown,
    checkpointId: fields.checkpointId,
    checksum,
  };
}

/**
 * Copy a parsed document into a ticket, refusing one whose checksum does not cover it.
 *
 * The copy-on-construct factory for an untrusted document. It refuses a document whose
 * stored checksum does not cover the fields it received, rather than repairing it, and
 * it applies no other judgement: a document missing a field, carrying an extra field or
 * holding a mistyped field is copied field for field, so the caller's verifier reaches
 * the donor's own verdict for it. Nothing is added, dropped or reordered — the returned
 * object has the document's own keys, which is what makes it safe to hand on.
 *
 * The digest is passed in because this module does not own it: the donor computed the
 * checksum in `ticket-store.ts` from `sha256` in `src/plugin/atomic.ts`, and
 * `./index.mjs` binds the two here.
 *
 * @param {{fields?: object, checksum?: string, ticketChecksum?: (fields: object) => string}} input
 * @returns {object} the ticket, with the document's own fields
 * @throws {TypeError} when the stored checksum is not a string covering the fields
 */
export function ticketFromDocument(input = {}) {
  const fields = input.fields ?? {};
  const checksum = input.checksum ?? fields.checksum;
  const ticketChecksum = input.ticketChecksum;
  if (typeof checksum !== 'string' || (typeof ticketChecksum === 'function' && ticketChecksum(fields) !== checksum)) {
    throw new TypeError('ticket checksum does not match its contents');
  }
  return { ...fields, checksum };
}

