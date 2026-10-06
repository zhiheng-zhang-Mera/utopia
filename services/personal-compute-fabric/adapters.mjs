// PCF-701 adapters: where the numbers come from, and what happens when a source does not exist.
//
// Every adapter declares WHICH dimensions it can supply. The registry merges the adapters that are actually available
// and lists every declared dimension that no available adapter covers as UNSUPPORTED - never as zero. That is the
// workbook's rule ("GPU/VRAM, network quality, battery/thermal are optional adapters; their absence must not block
// basic collection") implemented so that absence is a stated fact rather than an empty object.
//
// The reference adapter uses only the platform APIs Node exposes (`node:os`, optionally `fs.statfs`). It deliberately
// does NOT shell out to vendor tools: reading a GPU or a battery through an unvetted command would be a new
// privileged surface, and this task is a contract plus a collector, not a hardware inventory.
import {totalmem, freemem, cpus, loadavg, platform, arch, hostname} from 'node:os';
import {statfs} from 'node:fs/promises';

export const ADAPTER_KINDS = Object.freeze({SYSTEM: 'SYSTEM', OPTIONAL: 'OPTIONAL'});

/** The dimensions this reference adapter can honestly supply on a Node runtime. */
export const SYSTEM_DIMENSIONS = Object.freeze(['cpu', 'memory', 'memory.total', 'memory.free', 'disk', 'disk.total', 'disk.free']);

/** Dimensions that need hardware this adapter does not talk to: they are declared, and therefore reported, as
 *  UNSUPPORTED rather than omitted. An omitted dimension and an unsupported one look the same to a consumer, and the
 *  workbook needs them to differ. */
export const UNSUPPORTED_ON_THIS_ADAPTER = Object.freeze(['vram', 'battery', 'thermal', 'networkRtt', 'networkThroughput']);

const isPositive = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * @param os       injectable platform surface (defaults to node:os) so a test can drive edge values.
 * @param statfsFn injectable filesystem statistics; when it is unavailable or throws, disk is UNSUPPORTED, not 0.
 */
export const createSystemAdapter = ({os = {totalmem, freemem, cpus, loadavg, platform, arch, hostname}, statfsFn = statfs, diskPath = '.'} = {}) => ({
  id: 'node-system',
  kind: ADAPTER_KINDS.SYSTEM,
  dimensions: [...SYSTEM_DIMENSIONS],
  unsupported: [...UNSUPPORTED_ON_THIS_ADAPTER],
  /** Never throws: a failing read becomes an ABSENT field plus a reason the caller can record. */
  async sample(receivedAt = Date.now()) {
    const sample = {};
    const notes = [];
    const total = os.totalmem?.();
    const free = os.freemem?.();
    if (isPositive(total)) sample.memory = {facets: {total}, unit: 'bytes', observedAt: receivedAt, source: this.id};
    else notes.push('memory.total unavailable');
    if (isPositive(free)) {
      sample.memory = {...(sample.memory ?? {unit: 'bytes', observedAt: receivedAt, source: this.id}), facets: {...(sample.memory?.facets ?? {}), free}};
    } else notes.push('memory.free unavailable');
    if (sample.memory) sample.memory.value = undefined; // facets only: no single "memory" number is claimed
    const cores = os.cpus?.();
    const load = os.loadavg?.();
    if (Array.isArray(cores) && cores.length > 0 && Array.isArray(load) && isPositive(load[0])) {
      // 1-minute load divided by core count, clamped at 1: a ratio of DEMAND, not a fabricated utilisation percentage.
      sample.cpu = {value: Math.min(load[0] / cores.length, 1), unit: 'ratio', observedAt: receivedAt, source: this.id};
    } else notes.push('cpu unavailable');
    try {
      const stats = await statfsFn(diskPath);
      const blockSize = stats.bsize ?? stats.bsize === 0 ? stats.bsize : null;
      if (isPositive(stats.bsize) && isPositive(stats.blocks)) {
        sample.disk = {facets: {total: stats.blocks * stats.bsize, free: (stats.bavail ?? stats.bfree) * stats.bsize}, unit: 'bytes', observedAt: receivedAt, source: this.id};
      } else notes.push('disk statistics empty');
    } catch (error) {
      notes.push(`disk unavailable: ${error?.code ?? error?.message ?? 'unknown'}`);
    }
    return {sample, notes};
  },
});

/**
 * @param adapters available adapters; an adapter whose `available()` answers false is not sampled but its dimensions
 *                 are still reported as unsupported, so the gap keeps its name.
 */
export const createAdapterRegistry = ({adapters = [], now = () => Date.now()} = {}) => {
  const declared = new Set();
  for (const adapter of adapters) for (const dimension of adapter.dimensions ?? []) declared.add(dimension);
  return Object.freeze({
    adapters: () => adapters.map(adapter => ({id: adapter.id, kind: adapter.kind ?? ADAPTER_KINDS.OPTIONAL, dimensions: [...(adapter.dimensions ?? [])], unsupported: [...(adapter.unsupported ?? [])]})),
    declaredDimensions: () => [...declared].sort(),
    /** Merges every AVAILABLE adapter's sample. Conflicting providers of the same facet are reported, not merged
     *  silently: two adapters disagreeing about one number is a fact the caller must see. */
    async collect() {
      const receivedAt = now();
      const sample = {};
      const unsupported = new Set();
      const notes = [];
      const conflicts = [];
      for (const adapter of adapters) {
        const available = typeof adapter.available === 'function' ? await adapter.available() : true;
        for (const dimension of adapter.unsupported ?? []) unsupported.add(dimension);
        if (!available) {
          for (const dimension of adapter.dimensions ?? []) unsupported.add(dimension);
          notes.push(`${adapter.id} unavailable`);
          continue;
        }
        const produced = await adapter.sample(receivedAt);
        const producedSample = produced?.sample ?? produced ?? {};
        for (const note of produced?.notes ?? []) notes.push(`${adapter.id}: ${note}`);
        for (const [key, value] of Object.entries(producedSample)) {
          if (key in sample) { conflicts.push({key, adapters: [adapter.id]}); continue; }
          sample[key] = value;
        }
        for (const dimension of adapter.dimensions ?? []) {
          const covered = dimension in producedSample || (dimension.includes('.') && dimension.split('.')[0] in producedSample);
          if (!covered) unsupported.add(dimension);
        }
      }
      return {sample, unsupported: [...unsupported].sort(), notes, conflicts, receivedAt};
    },
  });
};
