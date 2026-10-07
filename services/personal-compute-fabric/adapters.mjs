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
export const createSystemAdapter = ({os = {totalmem, freemem, cpus, loadavg, platform, arch, hostname}, statfsFn = statfs, diskPath = '.'} = {}) => {
  let previousCpuTimes=null;
  return ({
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
    const load = os.platform?.()==='win32'?null:os.loadavg?.();
    if(os.platform?.()==='win32'){
      // Node loadavg is a fixed zero on Windows, not a measurement. Read a
      // genuine CPU-time interval; warmup, resets and zero-length windows
      // remain unavailable. No timer or privileged/vendor interface is needed.
      const fields=['user','nice','sys','irq','idle'];
      const current=Array.isArray(cores)&&cores.length>0&&cores.every(core=>fields.every(key=>isPositive(core?.times?.[key])))?cores.map(core=>fields.map(key=>core.times[key])):null;
      if(current&&previousCpuTimes&&current.length===previousCpuTimes.length){
        const deltas=current.map((values,index)=>values.map((value,key)=>value-previousCpuTimes[index][key]));
        const total=deltas.flat().reduce((sum,value)=>sum+value,0);
        const idle=deltas.reduce((sum,values)=>sum+values[4],0);
        if(deltas.every(values=>values.every(value=>value>=0))&&Number.isFinite(total)&&total>0){
          sample.cpu={value:(total-idle)/total,unit:'ratio',observedAt:receivedAt,source:this.id+':cpu-time'};
        }
      }
      previousCpuTimes=current;
      if(!sample.cpu)notes.push('cpu unavailable: CPU-time interval missing, unchanged or reset');
    }else if (Array.isArray(cores) && cores.length > 0 && Array.isArray(load) && isPositive(load[0])) {
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
};

/**
 * QUEUE HAS NO DEFAULT SOURCE, ON PURPOSE. "The queue" only means something once somebody says what is queued, so this
 * factory requires an explicit `source` and is UNAVAILABLE without one - which makes `queue` report UNSUPPORTED rather
 * than a fabricated 0. A collector that guessed "queue: 0" would tell a placement decision the device is idle.
 */
export const createQueueAdapter = ({source, id = 'queue-source'} = {}) => ({
  id,
  kind: ADAPTER_KINDS.OPTIONAL,
  dimensions: ['queue'],
  unsupported: [],
  available: () => typeof source === 'function',
  async sample(receivedAt) {
    if (typeof source !== 'function') return {sample: {}, notes: ['no queue source declared']};
    const value = await source();
    if (!Number.isFinite(value) || value < 0) return {sample: {}, notes: [`queue source returned ${JSON.stringify(value)}`]};
    return {sample: {queue: {value, unit: 'count', observedAt: receivedAt, source: id}}, notes: []};
  },
});

/**
 * OCCUPANCY IS THE RUNTIME'S OWN RESPONSIVENESS, read from the event-loop delay histogram the platform provides. It is
 * measured, not inferred; when the platform cannot provide it the dimension stays unsupported instead of being
 * reported as 0 ms, because 0 ms means "perfectly responsive" - a claim, not a gap.
 */
export const createRuntimeOccupancyAdapter = ({perf, id = 'node-event-loop'} = {}) => {
  const histogram = perf?.monitorEventLoopDelay ? perf.monitorEventLoopDelay({resolution: 10}) : null;
  let enabled = false;
  // Enabled eagerly: a histogram reads NaN until it has been running, and a dimension whose window has not started yet
  // must be reported unsupported rather than as 0 ms (which would claim perfect responsiveness).
  if (histogram?.enable) { try { histogram.enable(); enabled = true; } catch { /* left disabled; available() then answers false */ } }
  return {
    id,
    kind: ADAPTER_KINDS.SYSTEM,
    dimensions: ['occupancy'],
    unsupported: [],
    available: () => Boolean(histogram) && Number.isFinite(histogram.mean),
    async sample(receivedAt) {
      if (!histogram) return {sample: {}, notes: ['event-loop delay histogram unavailable on this runtime']};
      if (!enabled && histogram.enable) { try { histogram.enable(); enabled = true; } catch { /* report the gap instead */ } }
      const meanMs = histogram.mean / 1e6; // nanoseconds -> milliseconds
      if (!Number.isFinite(meanMs) || meanMs < 0) return {sample: {}, notes: [`event-loop delay not readable yet: ${meanMs}`]};
      return {sample: {occupancy: {value: meanMs, unit: 'milliseconds', observedAt: receivedAt, source: id}}, notes: []};
    },
    stop: () => { if (enabled && histogram?.disable) { histogram.disable(); enabled = false; } },
  };
};

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
