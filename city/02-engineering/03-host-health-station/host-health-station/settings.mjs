/**
 * UTOPIA · City · Host Health Station — the settings seam.
 *
 * Ported from the non-binding half of the donor `dsh-health-scheduler`
 * `src/dsh/plugin.ts` @ 985e2b7 (the `registerSettings` body, `configSchema()`
 * and `SETTINGS_NAMESPACE`); see DONOR.json for the porting ledger.
 *
 * The donor registered a settings namespace with a host service and watched it
 * for changes. Registering and watching are host binding, so they are gone; what
 * remains is the part that had behaviour of its own and is worth keeping:
 *
 *   1. the declarative schema a settings UI renders, and
 *   2. the update path — re-resolve the whole document with the authoritative
 *      validator, then hand the resolved config to `scheduler.reconfigure`, and
 *      on failure keep the configuration already in force.
 *
 * Point 2 is the interesting one: the donor's rule is that a value the UI
 * accepts but the engine cannot act on is rejected loudly instead of silently
 * applied, and that a rejected update never leaves the engine half-configured.
 * `applySettingsUpdate` is that rule as a pure function, so it is testable
 * without a harness.
 *
 * @module host-health-station/settings
 */

import { ConfigError, resolveConfig } from './config.mjs';

/** Settings namespace the donor owned, kept so an operator's document still maps. */
export const SETTINGS_NAMESPACE = 'health-scheduler';

/**
 * The declarative settings schema.
 *
 * The shape is what a settings UI renders; the authoritative validation remains
 * `resolveConfig`, which `applySettingsUpdate` runs on every change. Keeping both
 * means a value the UI accepts but the engine cannot act on is rejected loudly
 * rather than silently applied.
 *
 * @returns {object} a JSON-Schema-shaped object with two known leaves.
 */
export function configSchema() {
  const fields = {
    enabled: { type: 'boolean', description: 'Master switch for sampling and actions.' },
    preset: {
      type: 'string',
      description: 'Base preset: conservative, balanced, aggressive or custom.',
    },
  };
  return { type: 'object', properties: fields, additionalProperties: true };
}

/** The schema as data, so a consumer does not have to call a function for it. */
export const CONFIG_SCHEMA = Object.freeze(configSchema());

/**
 * Apply one settings document to a scheduler.
 *
 * Resolution happens before anything is applied, so a bad document changes
 * nothing: the scheduler keeps the configuration and the history it had. This is
 * the donor's watch-callback behaviour with the host plumbing removed.
 *
 * @param {{reconfigure: Function, config?: object}} scheduler - the scheduler to
 *   reconfigure. Only `reconfigure` is called.
 * @param {object} next - the candidate document, from a settings service or a caller.
 * @param {{resolveConfig?: Function}} [options] - validator override, for tests.
 * @returns {{ok: boolean, config: object|null, error: Error|null}} a result
 *   record; never throws.
 */
export function applySettingsUpdate(scheduler, next, options = {}) {
  const resolve = options.resolveConfig ?? resolveConfig;
  let config;
  try {
    config = resolve(next);
  } catch (error) {
    const wrapped = error instanceof ConfigError ? error : new ConfigError('<root>', `failed to resolve: ${error.message}`);
    return { ok: false, config: null, error: wrapped };
  }
  try {
    scheduler.reconfigure(config);
  } catch (error) {
    const wrapped = error instanceof ConfigError ? error : new ConfigError('<root>', `failed to apply: ${error.message}`);
    return { ok: false, config: null, error: wrapped };
  }
  return { ok: true, config, error: null };
}

/**
 * Convenience wrapper for the common case: resolve a document and reconfigure.
 *
 * @param {{reconfigure: Function}} scheduler - the scheduler to reconfigure.
 * @param {object} next - the candidate document.
 * @returns {{ok: boolean, config: object|null, error: Error|null}} the same result
 *   record `applySettingsUpdate` returns.
 */
export function reconfigureFromSettings(scheduler, next) {
  return applySettingsUpdate(scheduler, next);
}
