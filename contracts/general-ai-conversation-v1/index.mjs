// GAI-006 — conversation + input bundle + streaming + cancellation.
export {
  CONVERSATION_CONTRACT_VERSION,
  CONVERSATION_STATES,
  TURN_STATES,
  TERMINAL_TURN_STATES,
  BINDING_STATES,
  STAGING_POLICIES,
  EVENT_KINDS,
  CANONICAL_STATE_SOURCE,
  CONVERSATION_CODES,
  DEFAULT_CONVERSATION_POLICY,
  ConversationError,
  createConversationRegistry,
  isDigest,
  isIsoInstant,
} from './conversation.mjs';
