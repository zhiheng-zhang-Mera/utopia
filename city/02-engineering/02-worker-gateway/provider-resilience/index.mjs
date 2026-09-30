/**
 * UTOPIA · Worker Gateway — provider-resilience export site.
 *
 * One place to import the module from. Everything is a port of Codex-Boss
 * `electron/commander/circuit-breaker.ts` and `src/shared/provider-outcome.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 *   contracts.mjs        closed vocabularies and validated value shapes,
 *                        including the semantic-outcome vocabulary and shapes
 *                        ported from the donor `src/shared/provider-outcome.ts`
 *   circuit-breaker.mjs  the pure per-runtime provider health breaker
 *   provider-outcome.mjs the runtime-versus-semantic outcome separation itself
 *
 * Only `contracts.mjs` and `circuit-breaker.mjs` are star-exported: the semantic
 * names arrive through `contracts.mjs`, so exporting `provider-outcome.mjs` here
 * as well would publish the same bindings twice. Import `provider-outcome.mjs`
 * directly when the evaluator is all you need.
 *
 * There is no runtime here: no file, no clock of its own, no network, no
 * dispatch. A caller injects the state and the time and persists the snapshot.
 */

export * from './contracts.mjs';
export * from './circuit-breaker.mjs';
