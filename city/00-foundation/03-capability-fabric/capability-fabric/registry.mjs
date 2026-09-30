/**
 * UTOPIA · City Service Network — the capability provider registry.
 *
 * A consumer asks for a *capability*, never for a named adapter. Any provider
 * that advertises the capability will do, which is what makes a provider
 * replaceable rather than merely optional.
 *
 * What the registry guarantees:
 *
 *  * **Resolution is by capability, never by identity.** The only way to find a
 *    provider is to ask for the capability it advertises.
 *  * **A missing required capability is a refusal at gate time**, reported with
 *    the capability name and the asking consumer — not a crash mid-task.
 *  * **One capability may have several providers**, ordered by priority, so a
 *    specific provider wins over a general one without either knowing the other.
 *  * **A priority tie between two different owners is refused**, because which
 *    one won would then depend on registration order, and registration order is
 *    not a decision.
 *  * **Nothing is resolved silently.** Every lookup is recorded, including the
 *    misses, because "why did this consumer use the fallback?" and "why did this
 *    consumer not run?" are the same question.
 *
 * Donor provenance: DS-Hns `app/core/capability-registry/index.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973, ported from CommonJS to ESM. The
 * resolution, priority, conflict, revocation and miss-recording rules are the
 * donor's. Two deliberate adaptations are recorded here and in DONOR.json:
 *
 *  1. `register` reports {@link FABRIC_REASONS.DUPLICATE} when a *different*
 *     owner registers a capability id that is already owned, instead of
 *     silently accepting a second owner and then refusing the normal case at
 *     resolution time. The donor allowed it and refused later; refusing at
 *     registration names the mistake at the moment it is made. Re-registering
 *     by the *same* owner is an update and stays allowed, as in the donor.
 *  2. `revoke` removes one capability from one owner and returns the provider
 *     record it removed, so a caller can report *what* went away; the donor's
 *     `revokeOwner` returned only a list of names. Both are provided.
 */

import {
  DEFAULT_PRIORITY,
  FABRIC_REASONS,
  FabricError,
  MAX_LOOKUPS,
  capabilityDescriptor,
  capabilityRequirement,
} from './contracts.mjs';

/** A total order over providers: higher priority first, then lower identity. */
export function compareProviders(left, right) {
  if (left.priority !== right.priority) return right.priority - left.priority;
  return left.owner.localeCompare(right.owner);
}

/**
 * Sort capability ids so a report and a lock file are byte-stable.
 * Object key order is not a contract; a sorted array is.
 */
export function sortedCapabilityIds(providers) {
  return [...providers.keys()].sort();
}

/**
 * @param {object} [options]
 * @param {object} [options.events] a sink receiving `{type, detail}` facts
 * @param {() => number} [options.now]
 * @param {number} [options.maxLookups]
 */
export function createCapabilityRegistry(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const events = options.events ?? null;
  const maxLookups = Number.isSafeInteger(options.maxLookups) && options.maxLookups > 0 ? options.maxLookups : MAX_LOOKUPS;

  /** capabilityId -> provider record */
  const providers = new Map();
  /** capabilityId -> {owner, priority, at, reason} of the last revocation */
  const revocations = new Map();
  const lookups = [];

  const emit = (type, detail) => {
    if (events && typeof events.emit === 'function') events.emit(type, detail);
  };

  function ring(entry) {
    lookups.push(entry);
    if (lookups.length > maxLookups) lookups.splice(0, lookups.length - maxLookups);
    return entry;
  }

  function recordLookup(entry) {
    return ring(Object.freeze(entry));
  }

  /** A frozen copy, so a caller cannot mutate the registry through a read. */
  const copy = (provider) => Object.freeze({ ...provider, operations: Object.freeze([...provider.operations]) });

  /**
   * Advertise a capability.
   *
   * @returns {{ok: true, provider: object, providers: number} | {ok: false, reason: string, conflict?: object}}
   */
  function register(input) {
    let provider;
    try {
      provider = capabilityDescriptor(input);
    } catch (error) {
      if (error instanceof FabricError) return { ok: false, reason: error.message };
      throw error;
    }
    if (!provider.capabilityId) return { ok: false, reason: FABRIC_REASONS.NAMELESS };
    if (!provider.owner) return { ok: false, reason: FABRIC_REASONS.OWNERLESS };
    if (!provider.describes.trim()) return { ok: false, reason: FABRIC_REASONS.UNDESCRIBED };

    const existing = providers.get(provider.capabilityId);
    if (existing && existing.owner !== provider.owner) {
      return {
        ok: false,
        reason: `${FABRIC_REASONS.DUPLICATE}: ${provider.capabilityId} is already owned by ${existing.owner}`,
        conflict: { capabilityId: provider.capabilityId, owners: [existing.owner, provider.owner], priority: existing.priority },
      };
    }
    const replaced = existing !== undefined;
    const record = Object.freeze({ ...provider, registeredAt: new Date(now()).toISOString(), replaced });
    providers.set(provider.capabilityId, record);
    revocations.delete(provider.capabilityId);
    emit('capability.registered', {
      capabilityId: record.capabilityId,
      owner: record.owner,
      priority: record.priority,
      version: record.version,
      replaced,
    });
    return { ok: true, provider: record, providers: providers.size };
  }

  /**
   * Remove every capability one owner provided, in identity order.
   *
   * @returns {string[]} the capability ids that were removed
   */
  function revokeOwner(owner) {
    const revoked = [];
    for (const capabilityId of sortedCapabilityIds(providers)) {
      const provider = providers.get(capabilityId);
      if (provider.owner !== owner) continue;
      providers.delete(capabilityId);
      revocations.set(capabilityId, Object.freeze({ owner, priority: provider.priority, at: new Date(now()).toISOString(), reason: FABRIC_REASONS.REVOKED }));
      revoked.push(capabilityId);
      emit('capability.revoked', { capabilityId, owner, remaining: 0 });
    }
    return revoked;
  }

  /** Remove one capability, but only when `owner` is the one that provided it. */
  function revoke(capabilityId, owner) {
    const provider = providers.get(String(capabilityId ?? ''));
    if (!provider) return { ok: false, reason: FABRIC_REASONS.MISSING };
    if (owner !== undefined && provider.owner !== owner) {
      return { ok: false, reason: `${FABRIC_REASONS.DUPLICATE}: ${provider.capabilityId} is owned by ${provider.owner}` };
    }
    providers.delete(provider.capabilityId);
    revocations.set(provider.capabilityId, Object.freeze({ owner: provider.owner, priority: provider.priority, at: new Date(now()).toISOString(), reason: FABRIC_REASONS.REVOKED }));
    emit('capability.revoked', { capabilityId: provider.capabilityId, owner: provider.owner, remaining: 0 });
    return { ok: true, provider: copy(provider) };
  }

  /**
   * Resolve a capability to its winning provider record.
   *
   * A miss is `null` and is always recorded. A non-optional miss additionally
   * emits `capability.missing`, because an optional requirement that is absent
   * is a normal composition and a required one that is absent is a fault.
   */
  function resolve(input) {
    let requirement;
    try {
      requirement = typeof input === 'string' ? capabilityRequirement({ capabilityId: input }) : capabilityRequirement(input);
    } catch (error) {
      if (error instanceof FabricError) {
        recordLookup({ at: new Date(now()).toISOString(), capabilityId: String(input?.capabilityId ?? input ?? ''), by: null, ok: false, reason: error.message, optional: false });
        return null;
      }
      throw error;
    }
    const provider = providers.get(requirement.capabilityId);
    if (!provider) {
      const revocation = revocations.get(requirement.capabilityId);
      const reason = revocation ? FABRIC_REASONS.REVOKED : FABRIC_REASONS.MISSING;
      recordLookup({
        at: new Date(now()).toISOString(),
        capabilityId: requirement.capabilityId,
        by: requirement.by,
        ok: false,
        reason,
        optional: requirement.optional,
      });
      if (!requirement.optional) emit('capability.missing', { capabilityId: requirement.capabilityId, by: requirement.by, reason });
      return null;
    }
    recordLookup({
      at: new Date(now()).toISOString(),
      capabilityId: requirement.capabilityId,
      by: requirement.by,
      ok: true,
      owner: provider.owner,
      priority: provider.priority,
      alternatives: 0,
    });
    return copy(provider);
  }

  /** Every capability id this owner currently provides, in identity order. */
  function providedBy(owner) {
    return sortedCapabilityIds(providers).filter((capabilityId) => providers.get(capabilityId).owner === owner);
  }

  /** Which of these required capabilities nothing provides. */
  function missingRequired(requirements = []) {
    const list = Array.isArray(requirements) ? requirements : [requirements];
    return list
      .map((requirement) => (typeof requirement === 'string' ? requirement : requirement?.capabilityId))
      .filter((capabilityId) => typeof capabilityId === 'string' && capabilityId)
      .filter((capabilityId) => !providers.has(capabilityId));
  }

  /**
   * Record a miss that was decided without a lookup, so the reason a consumer
   * never ran is on the record even though nobody asked.
   */
  function recordMiss(capabilityId, by = null, source = 'requirement') {
    return recordLookup({ at: new Date(now()).toISOString(), capabilityId: String(capabilityId ?? ''), by, ok: false, reason: FABRIC_REASONS.MISSING, source });
  }

  return Object.freeze({
    register,
    revoke,
    revokeOwner,
    resolve,
    has: (capabilityId) => providers.has(String(capabilityId ?? '')),
    get: (capabilityId) => {
      const provider = providers.get(String(capabilityId ?? ''));
      return provider ? copy(provider) : null;
    },
    describe: (capabilityId) => {
      const provider = providers.get(String(capabilityId ?? ''));
      return provider ? copy(provider) : null;
    },
    list: () => sortedCapabilityIds(providers).map((capabilityId) => copy(providers.get(capabilityId))),
    capabilities: () => sortedCapabilityIds(providers),
    providedBy,
    missingRequired,
    recordMiss,
    /** Unresolved lookups: the evidence that a fallback was used. */
    misses: () => lookups.filter((entry) => entry.ok === false),
    lookups: () => [...lookups],
    revocations: () => sortedCapabilityIds(providers).length === 0 && revocations.size === 0
      ? []
      : [...revocations.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([capabilityId, record]) => Object.freeze({ capabilityId, ...record })),
    get size() {
      return providers.size;
    },
  });
}
