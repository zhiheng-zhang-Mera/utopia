/**
 * UTOPIA · City · Worker Gateway — provider adapter.
 *
 * city/02-engineering/02-worker-gateway/provider-adapter ports the Codex-Boss
 * runtime-adapter surface at commit
 * 8df428eaa437a409368401e95194e40266b83080: the runtime contracts of
 * `electron/runtimes/runtime.ts`, the refusal adapter of
 * `electron/runtimes/unsupported-runtime.ts`, the hook-backed web adapter of
 * `electron/runtimes/web/provider-runtime-adapter.ts` and the provider lifecycle
 * state of `src/shared/provider-state.ts`. See DONOR.json for the ported vectors.
 *
 * One import site: `contracts.mjs` for the shapes and vocabularies, `runtime.mjs`
 * for availability, refusal and adapter behaviour, `provider-state.mjs` for the
 * lifecycle records.
 *
 * Not ported here, deliberately: no runtime registry, no scheduler, no provider
 * automation, no network call, no persistence and no clock. A caller injects
 * hooks and time; this module decides nothing it was not told.
 */

export * from './contracts.mjs';
export * from './runtime.mjs';
export * from './provider-state.mjs';
