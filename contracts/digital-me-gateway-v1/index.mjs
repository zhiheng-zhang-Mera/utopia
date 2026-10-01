// Public surface of the Digital-Me context gateway (BA-005).
//
// Authorized scoped reads with least-data semantics; canonical user identity is read-only, scoped by
// memory namespace and audience, and knowledge is never disclosure authority.
export * from './gateway.mjs';

export const DIGITAL_ME_GATEWAY_CONTRACT = Object.freeze({
  id: 'digital-me-gateway',
  version: 1,
  canonical_user_identity_writable_by_assistants: false,
  assistant_persona_in_digital_me: false,
  least_data_by_default: true,
  denial_leaks_partially: false,
  knowledge_is_disclosure_authority: false,
  device_ephemeral_is_durable: false,
  cross_assistant_private_memory_visible: false,
  bulk_dump_by_default: false,
});
