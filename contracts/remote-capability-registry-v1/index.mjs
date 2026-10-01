// RF-007 — versioned capability registry + addressing.
export {
  CAPABILITY_REGISTRY_CONTRACT_VERSION,
  AVAILABILITY_STATES,
  EXCLUSIVITY,
  LOSS_REASONS,
  CONSTRAINT_KEYS,
  CAPABILITY_ID_SHAPE,
  CAPABILITY_CODES,
  DEFAULT_EXECUTION,
  DEFAULT_CAPABILITY_POLICY,
  CapabilityError,
  createCapabilityRegistry,
  parseCapabilityId,
  isIsoInstant,
} from './capability-registry.mjs';
