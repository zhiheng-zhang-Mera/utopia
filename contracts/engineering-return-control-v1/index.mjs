// Public surface of the remote Sub-worker return/control bridge (EM-007).
//
// The control plane follows the user; the execution plane may move. The remote host becomes the current
// executor only, never a new owner, and every artefact returns to the current authorised interaction
// surface through canonical state.
export * from './return-control.mjs';

export const ENGINEERING_RETURN_CONTROL_CONTRACT = Object.freeze({
  id: 'engineering-return-control',
  version: 1,
  control_plane: 'FOLLOWS_THE_USER',
  execution_plane: 'MAY_MOVE',
  remote_dispatch_requires_approved_proposal: true,
  remote_host_is_new_owner: false,
  owner_preserved: true,
  every_channel_returns: true,
  requires_remote_desktop_video: false,
  requires_walking_to_the_remote_host: false,
  hardware_bound_action_is_typed_blocker: true,
  own_node_trust: false,
  own_transport: false,
});
