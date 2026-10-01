// RF-010 — Fabric policy boundary + public API.
export {
  FABRIC_API_VERSION,
  PUBLIC_PORTS,
  POLICY_AXES,
  RESOURCE_CLASSES,
  FOREGROUND_REQUIREMENTS,
  EXCLUSIVITY_KINDS,
  DENIAL_REASONS,
  FABRIC_CODES,
  TRANSPORT_ADAPTER,
  ADAPTER_BOUNDARIES,
  DEFAULT_FABRIC_POLICY,
  FabricError,
  createFabricApi,
  intersectPolicy,
  isIsoInstant,
} from './fabric-api.mjs';
