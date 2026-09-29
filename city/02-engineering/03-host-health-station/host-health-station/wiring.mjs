/**
 * UTOPIA · City · Host Health Station — provider wiring.
 *
 * Ported from the non-binding half of the donor `dsh-health-scheduler`
 * `src/dsh/plugin.ts` @ 985e2b7 (`registerBuiltInProviders`); see DONOR.json for
 * the porting ledger.
 *
 * The donor built its provider graph inside the plugin body, which meant the
 * only place the config-to-provider projection existed was a function that also
 * wanted a harness context. It never touched `ctx`; it is pure composition, so
 * it is ported as its own module and takes the registry it should fill.
 *
 * Two details are carried over exactly because they are easy to "fix" wrongly:
 *
 *   - the **memory** provider is fed the **hardware** helper command. The donor
 *     documents this as deliberate: there is no separate `memory.helperCommand`,
 *     and both providers run the same command and each keeps the metrics it
 *     recognises.
 *   - the **`ProcessTreeReader`** is constructed only when `extraPids` is
 *     non-empty, and refreshes every `2 × sampling.intervalMs`.
 *
 * Nothing here is an OS read. The providers it builds are real, but every
 * external seam they use (the helper command, the stats file, the runtime feed,
 * the process list) is injected or configured, so the graph can be built and
 * driven with synthetic telemetry and no `node:os` reading at all.
 *
 * @module host-health-station/wiring
 */

import {
  EMPTY_RUNTIME_FEED,
  HardwareProvider,
  MemoryProvider,
  ProcessTreeReader,
  RuntimeProvider,
  StatsFileSource,
  buildStatsBackedProviders,
} from './providers.mjs';

/**
 * Build the provider graph a configuration enables, in the donor's fixed order.
 *
 * @param {object} config - a resolved configuration.
 * @param {object} environment - the provider environment; injected, never defaulted here.
 * @param {{runtimeFeed?: object}} [options] - the runtime feed seam, so a caller
 *   can supply event-loop latency, worker/thread counts and IPC timeout readings.
 * @returns {{ids: string[], providers: object[]}} the enabled provider ids in
 *   registration order (`hardware`, `memory`, `runtime`, `workers`,
 *   `computer-use`, `ui`, `context`, minus anything disabled) and the providers.
 */
export function buildBuiltInProviders(config, environment, options = {}) {
  const providers = [];
  const ids = [];
  const disabled = new Set(config.disabledProviders);
  if (!disabled.has('hardware')) {
    providers.push(new HardwareProvider(environment, config.providerOptions.hardware));
    ids.push('hardware');
  }
  if (!disabled.has('memory')) {
    providers.push(new MemoryProvider(environment, config.providerOptions.memory, {
      command: config.providerOptions.hardware.helperCommand,
      timeoutMs: config.providerOptions.hardware.helperTimeoutMs,
    }, config.providerOptions.memory.extraPids.length === 0
      ? null
      : new ProcessTreeReader({
        extraPids: config.providerOptions.memory.extraPids,
        refreshMs: config.sampling.intervalMs * 2,
      })));
    ids.push('memory');
  }
  if (!disabled.has('runtime')) {
    providers.push(new RuntimeProvider(environment, config.providerOptions.runtime, options.runtimeFeed ?? EMPTY_RUNTIME_FEED));
    ids.push('runtime');
  }
  const source = new StatsFileSource(config.providerOptions.statsFile.paths, config.providerOptions.statsFile.staleAfterMs);
  for (const provider of buildStatsBackedProviders(source, environment, {
    commands: config.providerOptions.statsFile.commands.map((command) => command.argv),
  })) {
    if (disabled.has(provider.id))
      continue;
    providers.push(provider);
    ids.push(provider.id);
  }
  return { ids, providers };
}

/**
 * Build and register the provider graph on a sink.
 *
 * @param {{registerProvider: Function}} sink - a `HealthScheduler` (or anything
 *   with the same single method).
 * @param {object} config - a resolved configuration.
 * @param {object} environment - the provider environment.
 * @param {{runtimeFeed?: object}} [options] - the runtime feed seam.
 * @returns {string[]} the registered provider ids, in registration order.
 */
export function registerBuiltInProviders(sink, config, environment, options = {}) {
  const { ids, providers } = buildBuiltInProviders(config, environment, options);
  for (const provider of providers)
    sink.registerProvider(provider);
  return ids;
}
