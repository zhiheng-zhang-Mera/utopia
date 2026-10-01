// Public surface of the General AI Gateway contract layer (GAI-001).
//
// Provider-neutral and transport-neutral: nothing here names a concrete AI product, and no
// envelope carries raw credential bytes. `GENERAL_AI` is the user-level route reserved for
// this programme; `BOSS` is a historical tombstone and is not a route.
export * from './contracts.mjs';
export * from './routing.mjs';

export const GENERAL_AI_GATEWAY_CONTRACT = Object.freeze({
  id: 'general-ai-gateway',
  version: 1,
  user_level_route: 'GENERAL_AI',
  legacy_routes_preserved: Object.freeze(['ROOM', 'CAPABILITY', 'CITY_TASK']),
  forbidden_route: 'BOSS',
  default_channel: 'WEB',
  api_channel_requires_user_consent: true,
  budget_approval_substitutes_for_consent: false,
  jev_is_advisory_only: true,
  interaction_device_may_differ_from_execution_device: true,
  raw_secrets_in_canonical_state: false,
});
