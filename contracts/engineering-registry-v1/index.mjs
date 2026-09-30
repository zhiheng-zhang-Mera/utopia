// Public surface of the Engineering connector capability/probe/auth registry (EM-004).
//
// Discovery and fit only: what worker instances exist, what they can do, whether they are usable.
// It never stores credentials, never discovers remote trust and never schedules.
export * from './registry.mjs';

export const ENGINEERING_REGISTRY_CONTRACT = Object.freeze({
  id: 'engineering-connector-registry',
  version: 1,
  descriptor_and_instance_are_distinct: true,
  one_kind_many_instances: true,
  unknown_capability_default: 'UNKNOWN',
  stale_probe_is_visible: true,
  auth_inferable_from_a_live_process: false,
  capability_mismatch_is_a_typed_refusal: true,
  probe_failure_is_isolated: true,
  raw_credentials_in_records: false,
  chooses_remote_host: false,
  stores_secrets: false,
});
