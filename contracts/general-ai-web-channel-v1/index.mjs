// Public surface of the General AI Web channel (GAI-003).
//
// Web is the default channel: sessions bind to persistent provider/account profile handles resolved
// through the neutral SecureHandleStorePort, channel state is reported honestly, and raw browser state
// never enters City state.
export * from './web-channel.mjs';

export const GENERAL_AI_WEB_CHANNEL_CONTRACT = Object.freeze({
  id: 'general-ai-web-channel',
  version: 1,
  default_channel: 'WEB',
  execution_bound_to_ephemeral_windows: false,
  profile_handle_store: 'neutral 00-Foundation SecureHandleStorePort',
  raw_cookies_in_city_state: false,
  provider_page_knowledge_location: 'BELOW_THE_ADAPTER',
  reimplements_remote_mouse_logic: false,
  partial_reported_as_final: false,
  restart_restore_requires_resolvable_handle: true,
  real_provider_acceptance: 'PROGRAMME_INTEGRATION_GATE',
});
