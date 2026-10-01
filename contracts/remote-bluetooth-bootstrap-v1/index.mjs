// Public surface of the Bluetooth bootstrap + IP handoff contract (RF-004).
//
// Bluetooth carries a pointer to an invitation, never trust: it converges on the one pairing/trust
// protocol, and the IP handoff requires an established trust record with the fingerprint re-verified on
// the new path. A MAC address is never consulted.
export * from './bootstrap.mjs';

export const REMOTE_BLUETOOTH_BOOTSTRAP_CONTRACT = Object.freeze({
  id: 'remote-bluetooth-bootstrap',
  version: 1,
  bootstrap_only: true,
  carries_trust: false,
  mac_is_authority: false,
  converges_on_one_trust_protocol: true,
  ip_handoff_requires_trust: true,
  ip_handoff_reverifies_fingerprint: true,
  bounded_scanning: true,
  nonce_is_single_use: true,
});
