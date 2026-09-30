// Public surface of the General AI provider/model/account registry (GAI-002).
//
// Discovery state only: what exists, what each subject supports, how fresh that answer is, and
// which handles the neutral SecureHandleStorePort owns. It never logs in, executes or chooses.
export * from './records.mjs';
export * from './registry.mjs';

export const GAI_REGISTRY_CONTRACT = Object.freeze({
  id: 'general-ai-registry',
  version: 1,
  channels: Object.freeze(['WEB', 'API']),
  unknown_capability_default: 'UNKNOWN',
  stale_capability_reads_as: 'UNKNOWN',
  multiple_accounts_per_provider: true,
  account_identity_is_provider_identity: false,
  raw_secrets_in_records: false,
  handle_store_owner: 'neutral 00-Foundation SecureHandleStorePort',
  general_ai_owns_credential_store: false,
  selects_provider_for_a_task: false,
  logs_in: false,
  executes_requests: false,
});
