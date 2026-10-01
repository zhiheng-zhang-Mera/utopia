// Public surface of the Engineering attention bridge (EM-005).
//
// One logical question with several projections; canonical Attention state stays shared and this
// module owns no notification database.
export * from './attention.mjs';

export const ENGINEERING_ATTENTION_CONTRACT = Object.freeze({
  id: 'engineering-attention',
  version: 1,
  one_attention_id_one_question: true,
  current_interaction_device_always_included: true,
  recent_device_alert_count: Object.freeze([2, 3]),
  ranks_by_interaction_recency: true,
  ranks_by_uptime: false,
  first_acknowledgement_wins: true,
  duplicate_delivery_rings_again: false,
  quiet_policy_suppresses_sound_only: true,
  rings_for_informational_events_by_default: false,
  response_routes_to_originating_connector: true,
});
