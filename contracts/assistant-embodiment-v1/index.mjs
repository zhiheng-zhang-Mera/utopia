// Public surface of the Butler Assistant embodiment contract (BA-003).
//
// Devices are embodiments of one logical assistant. Canonical physical-device identity belongs
// to Remote Fabric and is only *referenced* here; foreground binding is a device-interaction
// fact that is never task ownership, an execution lease or a background-worker state.
export * from './descriptors.mjs';
export * from './registry.mjs';

export const ASSISTANT_EMBODIMENT_CONTRACT = Object.freeze({
  id: 'assistant-embodiment',
  version: 1,
  one_logical_assistant_many_devices: true,
  foreground_assistants_per_device: 1,
  foreground_is_task_ownership: false,
  foreground_is_execution_lease: false,
  foreground_switch_moves_tasks: false,
  physical_device_identity_authority: 'REMOTE_FABRIC',
  butler_mints_device_identity: false,
  device_local_state_is_authoritative: false,
  restart_requires_revalidation: true,
});
