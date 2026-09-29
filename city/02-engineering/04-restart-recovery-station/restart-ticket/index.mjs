/**
 * UTOPIA · Engineering District — restart-recovery station · restart ticket.
 *
 * One export site for the whole module: the ticket and supervisor-ledger contracts,
 * the canonical checksum, the builder, the verification ladder and the digest helper.
 *
 * Donor: `dsh-restart` `src/plugin/ticket-store.ts`, `src/plugin/atomic.ts` and
 * `src/shared/protocol.ts`, frozen at commit
 * e20fb6cc43e27cedf6303471e5b8ee18e1383ecd. Pure value handling — no filesystem, no
 * clock, no environment. Time arrives as the `nowMs` parameter of `buildTicket` and
 * `verifyTicket`.
 */

export {
  LEDGER_FIELDS,
  LEDGER_SCHEMA_VERSION,
  RESTART_MODES,
  TICKET_DRAFT_FIELDS,
  TICKET_DRAFT_OPTIONAL_FIELDS,
  TICKET_FIELDS,
  TICKET_REJECTIONS,
  TICKET_SCHEMA_VERSION,
  TICKET_VERIFICATION_FIELDS,
  TicketRejection,
  emptyLedger,
  restartTicket,
  ticketFromDocument,
} from './contracts.mjs';

export {
  ATOMICITY_CONTRACT,
  buildTicket,
  sha256,
  ticketChecksum,
  verifyTicket,
} from './ticket.mjs';

// The canonical form keeps its single home in the sibling port of the donor's
// `src/shared/protocol.ts`, and is re-exported here so this module's surface is
// unchanged: `ticket.mjs` imports it from the same place to compute checksums.
export { canonicalJson } from '../restart-protocol/canonical-json.mjs';

import { ticketFromDocument } from './contracts.mjs';
import { ticketChecksum } from './ticket.mjs';

/**
 * Rebuild a ticket from a parsed document, refusing one whose stored checksum does not
 * cover the fields it received.
 *
 * The digest is bound here rather than imported by `./contracts.mjs`, so the contract
 * module stays free of behaviour and keeps a single direction of dependency:
 * `contracts.mjs` describes, `ticket.mjs` acts, `index.mjs` joins them. Nothing is
 * repaired on the way through: a short, extra-fielded or mistyped document is copied
 * as it arrived and judged only by `verifyTicket`'s donor ladder.
 *
 * @param {{fields: object, checksum: string}} document
 * @returns {object} the ticket
 * @throws {TypeError} when the stored checksum does not cover the fields
 */
export function ticketFromParsed(document) {
  return ticketFromDocument({ ...document, ticketChecksum });
}
