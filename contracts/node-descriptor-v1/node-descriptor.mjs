/**
 * UTOPIA · Node Role / Capability / Resource Descriptor Contract v1 (WBC-602).
 *
 * WHY THIS EXISTS. The execution backend seam (WBC-601) lets Utopia answer "which kind of resource placed this
 * run". This contract answers the complementary question: **what is each node actually able to do, and with
 * what resources** — so a future scheduler can choose an execution endpoint by capability, role and resource
 * instead of by a machine name that happens to be `Alien-Win` or `Mech-Win`.
 *
 * THIS CONTRACT DOES NOT SCHEDULE ANYTHING. It has no clock, no storage, no network and no loop. It projects
 * facts that already exist in the City's canonical node record into a stable, documented shape, and it
 * translates a record that predates this contract into a *conservative* descriptor.
 *
 * THE THREE RULES THAT MAKE IT BACKWARD-COMPATIBLE RATHER THAN A MIGRATION:
 *
 *  1. **Additive and optional.** No new field is required. A node record written before this contract existed
 *     translates into a descriptor; nothing has to be rewritten, and no field is ever deleted.
 *  2. **Unknown is not zero.** A missing resource measurement is `UNKNOWN`, never `0` and never `unavailable`.
 *     Conflating "we do not know how much memory this node has" with "this node has no memory" is the single
 *     most likely way an additive resource model turns into a scheduling regression.
 *  3. **Role is not inferred into authority.** A descriptor may *project* its roles, but a node only ever gains
 *     an execution role because it was registered as an execution node. The control surface in this City
 *     (Android / a browser) is classified `CONTROL_SURFACE` and can never be projected as a worker by adding a
 *     resource or capability field — the negative control this task's review is asked to attack.
 *
 * NOT AUTHORITY. Nothing in this descriptor may be used as a trust or identity source. Identity remains the
 * City's own registry (`devicePrincipalId`), and a resource report is a *claim by the node about itself*.
 * The workbook forbids turning a resource report into authority, so this module never validates identity and
 * never makes a routing decision.
 */

export const NODE_DESCRIPTOR_CONTRACT_VERSION = 1;

/**
 * The role vocabulary. A node may hold several roles; roles are what a node *is*, not what it may be trusted
 * with. `VALIDATION_NODE` is separate from `EXECUTION_NODE` because "this device can run work" and "this device
 * is an acceptable platform-validation endpoint" are different questions that MESH-301's strict targeting had
 * to keep apart.
 */
export const NODE_ROLES = Object.freeze([
  'EXECUTION_NODE',
  'CONTROL_SURFACE',
  'VALIDATION_NODE',
  'SERVER_NODE',
  'STORAGE_NODE',
  'ACCELERATOR_NODE',
]);

/**
 * The roles a node may be projected into *without being told*. Deliberately narrow: the legacy default is the
 * role the existing product already treats a registered City node as, and nothing more.
 */
export const DEFAULT_LEGACY_ROLES = Object.freeze(['EXECUTION_NODE']);

/** Resource kinds this contract can describe. Anything else is preserved as `UNKNOWN` kind, never invented. */
export const RESOURCE_KINDS = Object.freeze(['cpu', 'memory', 'disk', 'gpu', 'network']);

/** Presence of one fact. `UNKNOWN` means not reported; `UNSUPPORTED` means the node says it has none. */
export const PRESENCE = Object.freeze(['KNOWN', 'UNKNOWN', 'UNSUPPORTED']);

/** Typed refusals. A malformed descriptor is data, not an exception escaping to a surface. */
export const NODE_DESCRIPTOR_CODES = Object.freeze([
  'INVALID_DESCRIPTOR', 'INVALID_ROLE', 'INVALID_RESOURCE', 'INVALID_REQUIREMENTS', 'INCOMPATIBLE_CONTRACT',
]);

export class NodeDescriptorError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'NodeDescriptorError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'INCOMPATIBLE_CONTRACT' ? 409 : 400;
    Object.assign(this, extra);
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;

const freeze = value => {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};

/** A measurement that may legitimately be absent. Absent is `UNKNOWN`, and `UNKNOWN` is not `0`. */
export function measurement(value, { unit = 'count', at = null } = {}) {
  if (value === null || value === undefined) {
    return freeze({ presence: 'UNKNOWN', value: null, unit, at, reason: 'NOT_REPORTED' });
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return freeze({ presence: 'UNKNOWN', value: null, unit, at, reason: 'MALFORMED_MEASUREMENT' });
  }
  return freeze({ presence: 'KNOWN', value, unit, at, reason: null });
}

/** A node explicitly reporting that it has none of something. Distinct from not reporting. */
export const absent = ({ unit = 'count', at = null } = {}) => freeze({ presence: 'UNSUPPORTED', value: null, unit, at, reason: 'NODE_REPORTS_NONE' });

/** The resource block: every kind is always present, so a reader never has to guess a missing key. */
export function resourceBlock({
  cpu = null, memory = null, disk = null, gpu = null, network = null, observedAt = null,
} = {}) {
  return freeze({
    cpu: isPlainObject(cpu) ? freeze({ cores: measurement(cpu.cores, { at: observedAt }), loadPercent: measurement(cpu.loadPercent, { unit: 'percent', at: observedAt }) }) : freeze({ cores: measurement(null), loadPercent: measurement(null, { unit: 'percent' }) }),
    memory: isPlainObject(memory) ? freeze({ totalBytes: measurement(memory.totalBytes, { unit: 'bytes', at: observedAt }), usedBytes: measurement(memory.usedBytes, { unit: 'bytes', at: observedAt }), freeBytes: measurement(memory.freeBytes, { unit: 'bytes', at: observedAt }) }) : freeze({ totalBytes: measurement(null, { unit: 'bytes' }), usedBytes: measurement(null, { unit: 'bytes' }), freeBytes: measurement(null, { unit: 'bytes' }) }),
    disk: isPlainObject(disk) ? freeze({ totalBytes: measurement(disk.totalBytes, { unit: 'bytes', at: observedAt }), usedBytes: measurement(disk.usedBytes, { unit: 'bytes', at: observedAt }), freeBytes: measurement(disk.freeBytes, { unit: 'bytes', at: observedAt }) }) : freeze({ totalBytes: measurement(null, { unit: 'bytes' }), usedBytes: measurement(null, { unit: 'bytes' }), freeBytes: measurement(null, { unit: 'bytes' }) }),
    // `null` here is an explicit UNSUPPORTED, not an unknown: the product does not model GPU or accelerator
    // resources yet, and saying so is more honest than reporting a measurement nobody took.
    gpu: gpu === null || gpu === undefined ? absent({ unit: 'devices', at: observedAt }) : measurement(gpu.count ?? null, { unit: 'devices', at: observedAt }),
    network: isPlainObject(network) ? freeze({ reachable: network.reachable === true, metered: network.metered === null || network.metered === undefined ? null : network.metered === true }) : freeze({ reachable: false, metered: null }),
    observedAt,
  });
}

/**
 * The descriptor.
 *
 * `roleSource` is the part of this shape that stops a projection from becoming a claim: `DECLARED` means the
 * node registered these roles itself, `LEGACY_DEFAULT` means this contract supplied them because the record
 * predates it, and `CONTROL_SURFACE_ONLY` means the entity is not an execution resource at all.
 */
export function nodeDescriptor({
  nodeId, displayName = null, platform = null, agentVersion = null,
  roles = DEFAULT_LEGACY_ROLES, roleSource = 'LEGACY_DEFAULT', capabilities = [],
  resources = {}, availability = null, health = null, trustRef = null, observedAt = null,
  isExecutionResource = true,
} = {}) {
  if (!isText(nodeId)) throw new NodeDescriptorError('INVALID_DESCRIPTOR', 'nodeId is required');
  const roleList = [...new Set(Array.isArray(roles) && roles.length > 0 ? roles : DEFAULT_LEGACY_ROLES)];
  for (const role of roleList) {
    if (!NODE_ROLES.includes(role)) throw new NodeDescriptorError('INVALID_ROLE', `unknown role ${String(role)}; known roles: ${NODE_ROLES.join(', ')}`);
  }
  if (!['DECLARED', 'LEGACY_DEFAULT', 'CONTROL_SURFACE_ONLY'].includes(roleSource)) {
    throw new NodeDescriptorError('INVALID_DESCRIPTOR', `roleSource must be DECLARED, LEGACY_DEFAULT or CONTROL_SURFACE_ONLY, got ${String(roleSource)}`);
  }
  // A control surface may never be an execution resource, whatever else it declares. This is enforced HERE
  // rather than trusted to callers, because this is the negative control the workbook asks the reviewer to
  // attack: no combination of resource or capability fields may promote a control surface into a worker.
  if (!isExecutionResource && roleList.includes('EXECUTION_NODE')) {
    throw new NodeDescriptorError('INVALID_ROLE', `a non-execution entity may not hold EXECUTION_NODE (node ${nodeId})`);
  }
  return freeze({
    contractVersion: NODE_DESCRIPTOR_CONTRACT_VERSION,
    nodeId,
    displayName: displayName ?? nodeId,
    platform: platform ?? null,
    agentVersion: agentVersion ?? null,
    roles: freeze(roleList.slice().sort()),
    roleSource,
    isExecutionResource: isExecutionResource === true,
    capabilities: freeze([...(Array.isArray(capabilities) ? capabilities : [])].filter(isText).map(value => value.trim()).sort()),
    resources: resourceBlock({ ...resources, observedAt: resources?.observedAt ?? observedAt }),
    availability: availability ?? freeze({ state: 'UNKNOWN', acceptingWork: false, reason: 'NOT_OBSERVED' }),
    health: health ?? freeze({ state: 'UNKNOWN', reason: 'NOT_OBSERVED' }),
    // A reference, never a copy: identity lives in the City's registry and is not restated here as authority.
    trustRef: trustRef ?? freeze({ authority: 'CITY_NODE_REGISTRY', devicePrincipalId: null, descriptorIsNotAuthority: true }),
  });
}

/** True when this descriptor may be considered as an execution endpoint at all. */
export const isExecutionEndpoint = descriptor => descriptor?.isExecutionResource === true
  && (descriptor.roles ?? []).includes('EXECUTION_NODE');

/**
 * Project the City's own liveness/acceptance facts into the availability half of a descriptor. Supplied as
 * data so this module keeps its single opinion-free property: it is told the verdict, it does not derive it.
 */
export function availabilityFrom({ acceptingWork = false, state = 'UNKNOWN', reason = null, sharingEnabled = true } = {}) {
  return freeze({ state, acceptingWork: acceptingWork === true, sharingEnabled: sharingEnabled !== false, reason });
}

/**
 * LEGACY TRANSLATION. The whole point of this function is that a node record written before this contract —
 * with nothing but `id`, `displayName`, `metadata.platform`, `capabilities` and maybe `telemetry` — produces a
 * usable descriptor, and that **every derived value says where it came from**.
 *
 * What it will NOT do: infer a role from a capability, infer a platform from a hostname, or turn a missing
 * measurement into a zero. A node that never declared roles is `EXECUTION_NODE` by `LEGACY_DEFAULT` for exactly
 * one reason — that is what the existing product already treats a registered City node as — and the field says
 * so, so a reader can tell a declared role from a defaulted one.
 */
export function describeLegacyNode(record, { availability = null } = {}) {
  if (!isPlainObject(record) || !isText(record.id)) throw new NodeDescriptorError('INVALID_DESCRIPTOR', 'a legacy node record needs an id');
  const declaredRoles = Array.isArray(record.roles) ? record.roles.filter(isText) : [];
  const telemetry = isPlainObject(record.telemetry) ? record.telemetry : null;
  const resources = telemetry === null ? {} : {
    cpu: { cores: telemetry.cpuCores ?? null, loadPercent: telemetry.cpu?.usagePercent ?? null },
    memory: telemetry.memory && typeof telemetry.memory === 'object'
      ? { totalBytes: telemetry.memory.totalBytes ?? null, usedBytes: telemetry.memory.usedBytes ?? null, freeBytes: telemetry.memory.freeBytes ?? null }
      : {},
    // `disk.freeBytes` is part of the telemetry contract; `usedBytes` may be null there, so both are passed
    // through unchanged and the measurement factory decides KNOWN vs UNKNOWN per field.
    disk: telemetry.disk && typeof telemetry.disk === 'object'
      ? { totalBytes: telemetry.disk.totalBytes ?? null, usedBytes: telemetry.disk.usedBytes ?? null, freeBytes: telemetry.disk.freeBytes ?? null }
      : {},
    network: { reachable: record.online === true, metered: null },
    observedAt: typeof telemetry.observedAt === 'string' ? telemetry.observedAt : null,
  };
  return nodeDescriptor({
    nodeId: record.id,
    displayName: typeof record.displayName === 'string' ? record.displayName : record.id,
    platform: typeof record.metadata?.platform === 'string' ? record.metadata.platform : null,
    agentVersion: typeof record.agentVersion === 'string' ? record.agentVersion : null,
    roles: declaredRoles.length > 0 ? declaredRoles : DEFAULT_LEGACY_ROLES,
    roleSource: declaredRoles.length > 0 ? 'DECLARED' : 'LEGACY_DEFAULT',
    capabilities: Array.isArray(record.capabilities) ? record.capabilities : [],
    resources,
    availability: availability ?? availabilityFrom({
      acceptingWork: record.online === true && record.sharingEnabled !== false,
      state: record.online === true ? 'ONLINE' : 'OFFLINE',
      reason: record.online === true ? (record.sharingEnabled === false ? 'SHARING_DISABLED_BY_OWNER' : null) : 'ENDPOINT_OFFLINE',
      sharingEnabled: record.sharingEnabled !== false,
    }),
    health: freeze({ state: record.online === true ? 'HEALTHY' : 'UNREACHABLE', reason: null }),
    trustRef: freeze({ authority: 'CITY_NODE_REGISTRY', devicePrincipalId: record.devicePrincipalId ?? null, descriptorIsNotAuthority: true }),
  });
}

/**
 * The control surfaces attached to a City (Web, Android). They are NOT nodes and this function deliberately
 * does not make them nodes: it produces the descriptor for an entity the City already knows is a control
 * surface, with `isExecutionResource: false`, so the role truth required by the workbook
 * (Android = CONTROL_SURFACE) is expressible without registering Android as a worker.
 */
export function describeControlSurface({ clientRef, clientLabel = null, kind = 'WEB_CONTROL', platform = null } = {}) {
  if (!isText(clientRef)) throw new NodeDescriptorError('INVALID_DESCRIPTOR', 'clientRef is required');
  return nodeDescriptor({
    nodeId: clientRef,
    displayName: clientLabel ?? clientRef,
    platform,
    roles: ['CONTROL_SURFACE'],
    roleSource: 'CONTROL_SURFACE_ONLY',
    capabilities: [],
    resources: {},
    availability: freeze({ state: 'ATTACHED', acceptingWork: false, sharingEnabled: false, reason: null }),
    health: freeze({ state: 'HEALTHY', reason: null }),
    trustRef: freeze({ authority: 'CITY_SURFACE_REGISTRY', devicePrincipalId: null, descriptorIsNotAuthority: true }),
    isExecutionResource: false,
    kind,
  });
}

/** Android is a control surface and nothing else, whatever it advertises. */
export const describeAndroidControlSurface = ({ clientRef, clientLabel = null } = {}) =>
  describeControlSurface({ clientRef, clientLabel, kind: 'ANDROID_CONTROL', platform: 'android' });

/**
 * TaskRequirements — the optional request-side half. Absent fields mean "no requirement", never "requirement
 * unsatisfied": a legacy task carries none of this and must keep executing under the existing behaviour.
 */
export function taskRequirements({
  requiredCapabilities = [], preferredCapabilities = [], platformConstraints = [],
  resourceMinima = {}, acceleratorRequired = false, executionPreference = null,
} = {}) {
  const minima = {};
  for (const [kind, value] of Object.entries(isPlainObject(resourceMinima) ? resourceMinima : {})) {
    if (!Number.isFinite(value) || value < 0) throw new NodeDescriptorError('INVALID_REQUIREMENTS', `resourceMinima.${kind} must be a non-negative finite number`);
    minima[kind] = value;
  }
  return freeze({
    contractVersion: NODE_DESCRIPTOR_CONTRACT_VERSION,
    requiredCapabilities: freeze([...new Set(requiredCapabilities)].sort()),
    preferredCapabilities: freeze([...new Set(preferredCapabilities)].sort()),
    platformConstraints: freeze([...new Set(platformConstraints)].sort()),
    resourceMinima: freeze(minima),
    acceleratorRequired: acceleratorRequired === true,
    executionPreference: executionPreference ?? null,
    // Stated so a reader cannot mistake an empty requirement object for a satisfied one of unknown size.
    requirementsAreOptional: true,
  });
}

/** A legacy task's requirements: none. Provided as a named value so callers do not invent one. */
export const NO_TASK_REQUIREMENTS = taskRequirements();

/**
 * A descriptive (NOT scheduling) comparison between a task's requirements and a node's descriptor. It exists so
 * the review's "unknown resource must not be judged unavailable" case has one place to be checked. It returns
 * a reason list; it never selects a node and never mutates anything.
 */
export function explainRequirementFit(requirements, descriptor) {
  const req = requirements ?? NO_TASK_REQUIREMENTS;
  const reasons = [];
  const missing = req.requiredCapabilities.filter(capability => !descriptor.capabilities.includes(capability));
  if (missing.length > 0) reasons.push(`MISSING_CAPABILITY:${missing.join(',')}`);
  if (!descriptor.isExecutionResource) reasons.push('NOT_AN_EXECUTION_RESOURCE');
  for (const [kind, minimum] of Object.entries(req.resourceMinima)) {
    const node = descriptor.resources?.[kind];
    if (node === undefined) { reasons.push(`RESOURCE_UNKNOWN:${kind}`); continue; }
    const measured = node.totalBytes ?? node.cores;
    // Unknown capacity is NOT a failure here: it is reported as unknown so a caller can decide, and so a
    // missing telemetry field can never be read as "this node is too small".
    if (measured === undefined || measured === null || measured.presence !== 'KNOWN') { reasons.push(`RESOURCE_UNKNOWN:${kind}`); continue; }
    if (measured.value < minimum) reasons.push(`RESOURCE_BELOW_MINIMUM:${kind}`);
  }
  if (req.acceleratorRequired && descriptor.resources?.gpu?.presence !== 'KNOWN') reasons.push('ACCELERATOR_UNKNOWN');
  return freeze({ fits: reasons.length === 0, reasons: freeze(reasons), decided: false, schedulingAuthority: 'NONE' });
}

/** Assert a descriptor's shape. Used by tests and by the gateway's read projection, never to gate routing. */
export function assertNodeDescriptor(descriptor) {
  if (!isPlainObject(descriptor)) throw new NodeDescriptorError('INVALID_DESCRIPTOR', 'descriptor must be an object');
  if (descriptor.contractVersion !== NODE_DESCRIPTOR_CONTRACT_VERSION) {
    throw new NodeDescriptorError('INCOMPATIBLE_CONTRACT', `descriptor contractVersion must be ${NODE_DESCRIPTOR_CONTRACT_VERSION}, got ${String(descriptor.contractVersion)}`);
  }
  if (!isText(descriptor.nodeId)) throw new NodeDescriptorError('INVALID_DESCRIPTOR', 'descriptor.nodeId is required');
  for (const role of descriptor.roles ?? []) {
    if (!NODE_ROLES.includes(role)) throw new NodeDescriptorError('INVALID_ROLE', `unknown role ${String(role)}`);
  }
  if (descriptor.isExecutionResource === true && !(descriptor.roles ?? []).includes('EXECUTION_NODE')) {
    throw new NodeDescriptorError('INVALID_DESCRIPTOR', 'an execution resource must hold EXECUTION_NODE');
  }
  if (descriptor.isExecutionResource === false && (descriptor.roles ?? []).includes('EXECUTION_NODE')) {
    throw new NodeDescriptorError('INVALID_ROLE', 'a non-execution entity may not hold EXECUTION_NODE');
  }
  for (const kind of RESOURCE_KINDS) {
    if (!isPlainObject(descriptor.resources?.[kind]) && kind !== 'network') {
      throw new NodeDescriptorError('INVALID_RESOURCE', `descriptor.resources.${kind} must be present`);
    }
  }
  return descriptor;
}
