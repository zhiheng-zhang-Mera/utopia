/**
 * UTOPIA · City · City Core — fleet routing public surface.
 *
 * `city/00-foundation/01-city-core/fleet-routing` implements the fleet node model,
 * deterministic first-fit routing, dropout handling, capability-aware eligibility, node
 * self-inspection and the adaptive expected-utility scorer, ported from the Codex-Boss
 * donor @ 8df428eaa437a409368401e95194e40266b83080. See DONOR.json.
 *
 * Two donor functions were named `nodeStateFor`; they stay distinct here:
 * `fleetNodeStateFor` (heartbeat age) and `probeNodeStateFor` (self-inspection).
 */

export * from './contracts.mjs';
export * from './fleet.mjs';
export * from './capability-routing.mjs';
export * from './adaptive-routing.mjs';
