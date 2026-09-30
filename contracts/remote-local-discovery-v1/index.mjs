// Public surface of the local discovery / LAN direct-path contract (RF-003).
//
// Discovery is an entry point, never trust: it produces candidates, normalizes them into one
// logical-device abstraction and resolves them into the common pairing path.
export * from './discovery.mjs';

export const LOCAL_DISCOVERY_CONTRACT = Object.freeze({
  id: 'remote-local-discovery',
  version: 1,
  discovery_grants_trust: false,
  discovery_is_a_trust_flow: false,
  requires_manual_ip_entry: false,
  identity_is_network_derived: false,
  mac_is_authority: false,
  duplicate_advertisements_create_devices: false,
  bounded_scanning: true,
  untrusted_candidate_may_invoke: false,
  direct_path_requires_trust_and_fingerprint: true,
});
