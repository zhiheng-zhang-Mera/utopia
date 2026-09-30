/**
 * UTOPIA · City · Worker Gateway — worker runner, public surface.
 *
 * city/02-engineering/02-worker-gateway/worker-runner carries the real
 * provider/runner execution seam promoted by mission MB-003 (see DONOR.json and
 * Digital-City/mission-book/MB-003-worker-gateway.md).
 *
 * Ported from the DS-Hns donor `app/extensions/mega/scheduler/dsh-runner.js`
 * (zhiheng-zhang-Mera/DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b):
 * `contracts.mjs` owns the closed vocabularies, `runner.mjs` owns the seam.
 *
 * The donor's five exports are reached through `createRunner(seams)`:
 * `runner.startJob`, `runner.killTree`, `runner.childEnv`, `runner.dshBin` and
 * `runner.nodeExecutable`. The donor's module-level `DSH_BIN` const is
 * `runner.dshBin`, one install per injected app root.
 */

export * from './contracts.mjs';
export * from './runner.mjs';
