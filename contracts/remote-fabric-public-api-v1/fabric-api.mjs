// Fabric policy boundary + public API (RF-010).
//
// The frozen public boundary. Upper layers (Butler embodiments, Utopia Rooms, City tasks, General AI
// endpoints) call exactly these ports and never learn whether the bytes went over LAN, Bluetooth, a
// NAT-traversed pair or a relay:
//
//   discover() pair() connect() resolveDevice() listCapabilities() invoke() subscribe() openStream()
//   getPresence() revokeDevice() disconnect()
//
// Two rules are structural rather than advisory:
//
//   PERMISSION  is the intersection of Owner/User policy, caller/assistant policy, device capability and the
//               task/action grant. A valid authenticated session, a trusted-device status, presence or a
//               foreground name is never a permission source, so a policy denial stays a denial even on a
//               perfect session.
//   OWNERSHIP   stays outside. Fabric holds no City task graph and no Assistant durable state; it exposes
//               canonical device/presence/capability references so upper layers cannot invent competing
//               physical-device namespaces, and it never decides assistant or task ownership.
//
// The transport is injected as an adapter: a mock and a real adapter satisfy the same public API, which is
// how the contract tests prove the boundary is replacement-safe.
//
// Pure module: the transport adapter, the policy port and the clock are injected; no network or ambient state.
export const FABRIC_API_VERSION = 1;

/** The frozen public surface. Adding a port here is a version change, not an implementation detail. */
export const PUBLIC_PORTS = Object.freeze([
  'discover', 'pair', 'connect', 'resolveDevice', 'listCapabilities', 'invoke', 'subscribe', 'openStream',
  'getPresence', 'revokeDevice', 'disconnect',
]);

export const POLICY_AXES = Object.freeze(['OWNER_USER', 'CALLER_ASSISTANT', 'DEVICE_CAPABILITY', 'TASK_ACTION_GRANT']);
export const RESOURCE_CLASSES = Object.freeze(['CAMERA', 'MICROPHONE', 'SCREEN', 'LOCATION', 'FILES', 'INPUT']);
export const FOREGROUND_REQUIREMENTS = Object.freeze(['NOT_REQUIRED', 'REQUIRES_FOREGROUND', 'EXCLUSIVE_FOREGROUND']);
export const EXCLUSIVITY_KINDS = Object.freeze(['EXCLUSIVE', 'SHARED', 'BACKGROUND_CAPABLE']);
export const DENIAL_REASONS = Object.freeze([
  'NO_OWNDER_USER_GRANT', 'CALLER_NOT_PERMITTED', 'DEVICE_CAPABILITY_MISSING', 'TASK_ACTION_GRANT_MISSING',
  'SESSION_IS_NOT_PERMISSION', 'PRESENCE_IS_NOT_PERMISSION', 'FOREGROUND_NOT_OWNED', 'RESOURCE_BUSY',
  'FOREGROUND_CONFIRMATION_REQUIRED', 'DEVICE_REVOKED',
]);

export const FABRIC_CODES = Object.freeze([
  'INVALID_REQUEST', 'INVALID_CLOCK', 'INVALID_ADAPTER', 'INVALID_POLICY', 'UNKNOWN_DEVICE',
  'UNKNOWN_CAPABILITY', 'POLICY_DENIED', 'CAPABILITY_NOT_ADVERTISED', 'FOREGROUND_CONFLICT',
  'USER_CONFIRMATION_REQUIRED', 'DEVICE_REVOKED', 'TRANSPORT_FAILED', 'NOT_SUPPORTED_BY_VERSION',
  'FABRIC_DOES_NOT_OWN_TASK_TRUTH', 'FABRIC_DOES_NOT_OWN_ASSISTANT_STATE', 'COMPETING_IDENTITY_NAMESPACE',
]);

const CONFLICT_CODES = new Set(['POLICY_DENIED', 'FOREGROUND_CONFLICT', 'USER_CONFIRMATION_REQUIRED', 'DEVICE_REVOKED', 'CAPABILITY_NOT_ADVERTISED']);

export class FabricError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'FabricError';
    this.code = code;
    this.detail = detail ?? null;
    this.status = code === 'UNKNOWN_DEVICE' || code === 'UNKNOWN_CAPABILITY' ? 404 : CONFLICT_CODES.has(code) ? 409 : 400;
    Object.assign(this, extra);
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => (value === undefined ? undefined : structuredClone(value));
const freeze = value => {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};
export const isIsoInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

/** The transport adapter contract: a mock and a real adapter must both satisfy exactly this. */
export const TRANSPORT_ADAPTER = Object.freeze({
  interface: 'FabricTransportAdapter',
  version: 1,
  methods: Object.freeze(['discover', 'connect', 'invoke', 'subscribe', 'openStream', 'disconnect']),
  upper_layers_may_depend_on_concrete_transport: false,
  exposes_transport_specifics: false,
});

export const ADAPTER_BOUNDARIES = Object.freeze({
  UTOPIA_ACTION_ROOM: Object.freeze({ consumes: Object.freeze(['resolveDevice', 'invoke', 'getPresence']), owns_task_orchestration: false, owns_permission_decision: false }),
  BUTLER_EMBODIMENT_BUS: Object.freeze({ consumes: Object.freeze(['resolveDevice', 'getPresence', 'subscribe']), owns_embodiment_state: false, owns_task_ownership: false }),
  GAI_ENDPOINT: Object.freeze({ consumes: Object.freeze(['listCapabilities', 'invoke']), owns_provider_registry: false }),
  ENGINEERING_CONNECTOR: Object.freeze({ consumes: Object.freeze(['resolveDevice', 'listCapabilities', 'openStream']), owns_connector_registry: false }),
});

/**
 * The policy intersection. Every axis must be granted; a session, presence or foreground binding contributes
 * nothing on its own, and that is stated in the result rather than merely implemented.
 */
export function intersectPolicy({ ownerUser = null, callerAssistant = null, deviceCapability = null, taskActionGrant = null, session = null, presence = null } = {}) {
  const axes = {
    OWNER_USER: ownerUser === true,
    CALLER_ASSISTANT: callerAssistant === true,
    DEVICE_CAPABILITY: deviceCapability === true,
    TASK_ACTION_GRANT: taskActionGrant === true,
  };
  const denied = POLICY_AXES.filter(axis => axes[axis] !== true);
  return freeze({
    contract_version: FABRIC_API_VERSION,
    granted: denied.length === 0,
    axes: freeze(axes),
    denied_axes: freeze(denied),
    evaluated_axes: freeze([...POLICY_AXES]),
    session_state: session,
    presence_state: presence,
    session_is_permission: false,
    presence_is_permission: false,
    trusted_device_is_permission: false,
    foreground_is_permission: false,
    permission_is_intersectional: true,
    denial_reason: denied.length === 0 ? null : `MISSING_${denied[0]}`,
  });
}

export const DEFAULT_FABRIC_POLICY = Object.freeze({
  policy_ref: 'policy:rf-fabric-default',
  api_version: FABRIC_API_VERSION,
  require_foreground_for: Object.freeze(['CAMERA', 'MICROPHONE', 'SCREEN']),
  exclusive_foreground_for: Object.freeze(['CAMERA', 'MICROPHONE']),
});

export function createFabricApi({ transport, policy = null, clock = () => new Date().toISOString() } = {}) {
  if (!isPlainObject(transport) || typeof transport.discover !== 'function' || typeof transport.connect !== 'function') {
    throw new FabricError('INVALID_ADAPTER', 'a FabricTransportAdapter with discover() and connect() is required');
  }
  if (typeof clock !== 'function') throw new FabricError('INVALID_CLOCK', 'clock must be a function returning an ISO-8601 UTC instant');
  if (policy !== null && typeof policy.evaluate !== 'function') throw new FabricError('INVALID_POLICY', 'a policy port must expose evaluate()');
  const config = { ...DEFAULT_FABRIC_POLICY, ...(isPlainObject(policy?.config) ? policy.config : {}) };
  const sessions = new Map();
  const subscriptions = new Map();
  const streams = new Map();
  const revoked = new Set();
  const foregroundOwners = new Map();
  const journal = [];
  let counter = 0;

  const now = () => {
    const produced = clock();
    if (!isIsoInstant(produced)) throw new FabricError('INVALID_CLOCK', 'clock() must return an ISO-8601 UTC instant');
    return produced;
  };

  const note = (event, at, detail = {}) => {
    journal.push(freeze({ event, at, ...detail }));
    return journal.length - 1;
  };

  const evaluatePolicy = request => {
    const raw = policy === null
      ? { owner_user: true, caller_assistant: true, device_capability: true, task_action_grant: true }
      : policy.evaluate(clone(request));
    return intersectPolicy({
      ownerUser: raw?.owner_user === true,
      callerAssistant: raw?.caller_assistant === true,
      deviceCapability: raw?.device_capability === true,
      taskActionGrant: raw?.task_action_grant === true,
      session: request.session?.state ?? null,
      presence: request.presence_state ?? null,
    });
  };

  const requireDevice = device_ref => {
    if (!isText(device_ref)) throw new FabricError('INVALID_REQUEST', 'device_ref is required');
    if (revoked.has(device_ref)) {
      throw new FabricError('DEVICE_REVOKED', `device ${device_ref} was revoked`, { device_ref, revoked: true, session_would_not_help: true });
    }
    return device_ref;
  };

  const api = {
    apiVersion: () => FABRIC_API_VERSION,
    publicPorts: () => freeze([...PUBLIC_PORTS]),
    transportAdapter: () => TRANSPORT_ADAPTER,
    adapterBoundaries: () => ADAPTER_BOUNDARIES,
    policyConfig: () => freeze(clone(config)),
    intersectPolicy,

    /** Discovery returns canonical references; it carries no transport detail and no permission. */
    discover({ query = {}, at: when } = {}) {
      const at = when ?? now();
      const found = transport.discover({ query: clone(query) });
      note('DISCOVERED', at, { count: Array.isArray(found) ? found.length : 0 });
      return freeze({
        contract_version: FABRIC_API_VERSION,
        devices: freeze((Array.isArray(found) ? found : []).map(device => freeze({
          device_ref: device.device_ref,
          installation_ref: device.installation_ref ?? null,
          canonical_device_identity: device.device_ref,
          presence_state: device.presence_state ?? 'UNKNOWN',
          revocable: true,
        }))),
        transport_specifics_exposed: false,
        permission_granted: false,
        discovery_implies_trust: false,
        at,
      });
    },

    pair({ device_ref, invitation_ref = null, at: when } = {}) {
      const at = when ?? now();
      requireDevice(device_ref);
      if (typeof transport.pair !== 'function') throw new FabricError('NOT_SUPPORTED_BY_VERSION', 'this adapter does not implement pair()');
      const result = transport.pair({ device_ref, invitation_ref });
      note('PAIRED', at, { device_ref });
      return freeze({
        contract_version: FABRIC_API_VERSION,
        device_ref,
        trust_state: result?.trust_state ?? 'TRUSTED',
        pairing_ref: result?.pairing_ref ?? null,
        grants_permission: false,
        grants_task_ownership: false,
        at,
      });
    },

    /** Connect returns a session. A session is connectivity, never permission. */
    connect({ device_ref, capability_id = null, at: when } = {}) {
      const at = when ?? now();
      requireDevice(device_ref);
      const result = transport.connect({ device_ref, capability_id });
      counter += 1;
      const session_ref = result?.session_ref ?? `session:${counter}`;
      const session = {
        session_ref,
        device_ref,
        state: 'AUTHENTICATED',
        authenticated: true,
        encrypted: true,
        opened_at: at,
      };
      sessions.set(session_ref, session);
      note('CONNECTED', at, { device_ref, session_ref });
      return freeze({
        contract_version: FABRIC_API_VERSION,
        ...clone(session),
        transport_class: 'HIDDEN_FROM_CALLER',
        session_is_permission: false,
        session_grants_capability: false,
        at,
      });
    },

    /** Canonical identity resolution: upper layers must not invent their own device namespace. */
    resolveDevice({ device_ref, competing_namespace = null, at: when } = {}) {
      const at = when ?? now();
      if (competing_namespace !== null) {
        throw new FabricError('COMPETING_IDENTITY_NAMESPACE', 'upper layers must reference the canonical RF device identity rather than minting their own', {
          device_ref, competing_namespace, canonical_namespace: 'REMOTE_FABRIC_DEVICE',
        });
      }
      requireDevice(device_ref);
      return freeze({
        contract_version: FABRIC_API_VERSION,
        device_ref,
        canonical_device_identity: device_ref,
        canonical_namespace: 'REMOTE_FABRIC_DEVICE',
        installation_ref: null,
        identity_is_network_derived: false,
        address_is_identity: false,
        at,
      });
    },

    listCapabilities({ device_ref, at: when } = {}) {
      const at = when ?? now();
      requireDevice(device_ref);
      const capabilities = typeof transport.listCapabilities === 'function' ? transport.listCapabilities({ device_ref }) : [];
      note('CAPABILITIES_LISTED', at, { device_ref, count: Array.isArray(capabilities) ? capabilities.length : 0 });
      return freeze({
        contract_version: FABRIC_API_VERSION,
        device_ref,
        capabilities: freeze((Array.isArray(capabilities) ? capabilities : []).map(capability => freeze({
          capability_id: capability.capability_id,
          capability_version: capability.capability_version ?? 1,
          advertises_execution_metadata: true,
          advertisement_is_permission: false,
        }))),
        capability_is_availability_metadata: true,
        permission_granted: false,
        at,
      });
    },

    /**
     * Invoke is where the two rules meet: an advertised capability needs the policy intersection and, for a
     * foreground-sensitive resource, the device-local foreground/confirmation requirement.
     */
    invoke({ device_ref, capability_id, capability_version = 1, resource_class = null, session_ref = null, action_ref = null, arguments_ref = null, at: when } = {}) {
      const at = when ?? now();
      requireDevice(device_ref);
      if (!isText(capability_id)) throw new FabricError('INVALID_REQUEST', 'capability_id is required');
      const advertised = typeof transport.listCapabilities === 'function' ? (transport.listCapabilities({ device_ref }) ?? []) : [];
      const match = advertised.find(capability => capability.capability_id === capability_id);
      if (!match) {
        throw new FabricError('CAPABILITY_NOT_ADVERTISED', `${device_ref} does not advertise ${capability_id}`, { device_ref, capability_id, advertised: false, executed: false });
      }
      if (match.capability_version !== undefined && match.capability_version !== capability_version) {
        throw new FabricError('NOT_SUPPORTED_BY_VERSION', `capability ${capability_id} is advertised at version ${match.capability_version}`, {
          device_ref, capability_id, requested_version: capability_version, advertised_version: match.capability_version, coerced: false,
        });
      }
      const session = session_ref === null ? null : sessions.get(session_ref) ?? null;
      const presence = typeof transport.getPresence === 'function' ? transport.getPresence({ device_ref }) : null;
      const decision = evaluatePolicy({
        device_ref, capability_id, resource_class, action_ref,
        session, presence_state: presence?.state ?? null,
      });
      if (!decision.granted) {
        note('POLICY_DENIED', at, { device_ref, capability_id, denied: decision.denied_axes.join(',') });
        throw new FabricError('POLICY_DENIED', `the policy intersection denied ${capability_id}`, {
          device_ref, capability_id, denied_axes: decision.denied_axes, decision,
          session_valid: session !== null && session.authenticated === true,
          denied_despite_valid_session: session !== null && session.authenticated === true,
          executed: false,
        });
      }

      // Foreground-sensitive resources: device-local policy may demand foreground ownership or confirmation.
      if (resource_class !== null && config.require_foreground_for.includes(resource_class)) {
        const exclusive = config.exclusive_foreground_for.includes(resource_class);
        const owner = foregroundOwners.get(device_ref) ?? null;
        if (exclusive && owner !== null && owner !== action_ref) {
          throw new FabricError('FOREGROUND_CONFLICT', `${device_ref} grants exclusive foreground to ${owner}`, {
            device_ref, resource_class, foreground_owner: owner, requested_by: action_ref, fabric_decides_ownership: false,
          });
        }
        if (match.requires_user_confirmation === true) {
          throw new FabricError('USER_CONFIRMATION_REQUIRED', `${capability_id} requires local user confirmation on ${device_ref}`, {
            device_ref, capability_id, resource_class, confirmation_required: true, delivered_locally: true, executed: false,
          });
        }
        if (owner === null && action_ref !== null) {
          foregroundOwners.set(device_ref, action_ref);
          if (exclusive) foregroundOwners.set(device_ref, action_ref);
        }
      }

      const result = transport.invoke({ device_ref, capability_id, capability_version, session_ref, action_ref, arguments_ref });
      note('INVOKED', at, { device_ref, capability_id });
      return freeze({
        contract_version: FABRIC_API_VERSION,
        device_ref,
        capability_id,
        capability_version,
        invocation_ref: result?.invocation_ref ?? null,
        result_ref: result?.result_ref ?? null,
        transport_specifics_exposed: false,
        policy_granted: true,
        session_is_permission: false,
        fabric_owns_task_ownership: false,
        fabric_owns_assistant_state: false,
        at,
      });
    },

    /** Release an exclusive foreground claim held under the device-local policy. */
    releaseForeground({ device_ref, action_ref = null, at: when } = {}) {
      const at = when ?? now();
      requireDevice(device_ref);
      const owner = foregroundOwners.get(device_ref) ?? null;
      if (owner === null) return freeze({ contract_version: FABRIC_API_VERSION, device_ref, released: false, reason: 'NOT_HELD', at });
      if (action_ref !== null && owner !== action_ref) {
        throw new FabricError('FOREGROUND_CONFLICT', `${device_ref} foreground is held by ${owner}`, { device_ref, foreground_owner: owner });
      }
      foregroundOwners.delete(device_ref);
      note('FOREGROUND_RELEASED', at, { device_ref });
      return freeze({ contract_version: FABRIC_API_VERSION, device_ref, released: true, previous_owner: owner, at });
    },

    subscribe({ device_ref, topic, from_sequence = 1, at: when } = {}) {
      const at = when ?? now();
      requireDevice(device_ref);
      if (!isText(topic)) throw new FabricError('INVALID_REQUEST', 'topic is required');
      counter += 1;
      const subscription_ref = `subscription:${counter}`;
      subscriptions.set(subscription_ref, { subscription_ref, device_ref, topic, from_sequence, created_at: at });
      if (typeof transport.subscribe === 'function') transport.subscribe({ device_ref, topic, from_sequence });
      note('SUBSCRIBED', at, { device_ref, topic });
      return freeze({
        contract_version: FABRIC_API_VERSION,
        subscription_ref,
        device_ref,
        topic,
        from_sequence,
        is_rpc: false,
        reconnectable: true,
        at,
      });
    },

    openStream({ device_ref, capability_id, stream_kind = 'TOKEN', window = 4, session_ref = null, at: when } = {}) {
      const at = when ?? now();
      requireDevice(device_ref);
      if (!isText(capability_id)) throw new FabricError('INVALID_REQUEST', 'capability_id is required');
      const decision = evaluatePolicy({ device_ref, capability_id, resource_class: null, session: session_ref === null ? null : sessions.get(session_ref) ?? null });
      if (!decision.granted) {
        throw new FabricError('POLICY_DENIED', `the policy intersection denied a stream for ${capability_id}`, { device_ref, capability_id, denied_axes: decision.denied_axes, decision, executed: false });
      }
      counter += 1;
      const stream_ref = `stream:${counter}`;
      streams.set(stream_ref, { stream_ref, device_ref, capability_id, stream_kind, window, state: 'OPEN', created_at: at });
      if (typeof transport.openStream === 'function') transport.openStream({ device_ref, capability_id, stream_kind, window });
      note('STREAM_OPENED', at, { device_ref, capability_id });
      return freeze({
        contract_version: FABRIC_API_VERSION,
        stream_ref,
        device_ref,
        capability_id,
        stream_kind,
        state: 'OPEN',
        is_rpc: false,
        transport_specifics_exposed: false,
        at,
      });
    },

    /** Presence is reachability metadata and is explicitly not permission. */
    getPresence({ device_ref, at: when } = {}) {
      const at = when ?? now();
      requireDevice(device_ref);
      const presence = typeof transport.getPresence === 'function' ? transport.getPresence({ device_ref }) : null;
      return freeze({
        contract_version: FABRIC_API_VERSION,
        device_ref,
        state: presence?.state ?? 'UNKNOWN',
        last_seen_at: presence?.last_seen_at ?? null,
        reachable: ['ONLINE', 'BUSY', 'DEGRADED'].includes(presence?.state ?? 'UNKNOWN'),
        presence_is_permission: false,
        presence_is_task_ownership: false,
        at,
      });
    },

    revokeDevice({ device_ref, reason = 'USER_REVOKED', at: when } = {}) {
      const at = when ?? now();
      if (!isText(device_ref)) throw new FabricError('INVALID_REQUEST', 'device_ref is required');
      revoked.add(device_ref);
      for (const [session_ref, session] of sessions) if (session.device_ref === device_ref) sessions.delete(session_ref);
      for (const [stream_ref, stream] of streams) if (stream.device_ref === device_ref) stream.state = 'REVOKED';
      if (typeof transport.disconnect === 'function') transport.disconnect({ device_ref });
      note('DEVICE_REVOKED', at, { device_ref, reason });
      return freeze({
        contract_version: FABRIC_API_VERSION,
        device_ref,
        revoked: true,
        reason,
        sessions_closed: true,
        presence_cleared: true,
        permission_granted: false,
        requires_revocation_not_just_disconnect: true,
        at,
      });
    },

    disconnect({ device_ref, session_ref = null, at: when } = {}) {
      const at = when ?? now();
      requireDevice(device_ref);
      if (session_ref !== null) sessions.delete(session_ref);
      else for (const [key, session] of sessions) if (session.device_ref === device_ref) sessions.delete(key);
      if (typeof transport.disconnect === 'function') transport.disconnect({ device_ref });
      note('DISCONNECTED', at, { device_ref });
      return freeze({
        contract_version: FABRIC_API_VERSION,
        device_ref,
        disconnected: true,
        device_still_trusted: true,
        trust_revoked: false,
        task_ownership_changed: false,
        at,
      });
    },

    /** The boundary statement upper layers can assert against. */
    boundary() {
      return freeze({
        contract_version: FABRIC_API_VERSION,
        public_ports: freeze([...PUBLIC_PORTS]),
        policy_axes: freeze([...POLICY_AXES]),
        fabric_owns_task_truth: false,
        fabric_owns_assistant_state: false,
        fabric_decides_assistant_ownership: false,
        fabric_decides_task_ownership: false,
        fabric_chooses_best_device: false,
        fabric_reasons_or_plans: false,
        session_is_permission: false,
        presence_is_permission: false,
        foreground_is_permission: false,
        trusted_device_is_permission: false,
        canonical_device_namespace: 'REMOTE_FABRIC_DEVICE',
        upper_layers_must_reference_canonical_identity: true,
        transport_specifics_exposed: false,
        adapter_boundaries: ADAPTER_BOUNDARIES,
      });
    },

    /** Fabric refuses to become a task or assistant store. */
    storeTaskGraph() {
      throw new FabricError('FABRIC_DOES_NOT_OWN_TASK_TRUTH', 'the City task graph belongs to Shared Task Core, not to the Fabric', { stored: false, owned_by: 'SHARED_TASK_CORE' });
    },

    storeAssistantState() {
      throw new FabricError('FABRIC_DOES_NOT_OWN_ASSISTANT_STATE', 'Assistant durable state belongs to the Assistant brain, not to the Fabric', { stored: false, owned_by: 'ASSISTANT_CORE' });
    },

    /** Integration seams recorded, not implemented: no sibling branch is imported here. */
    integrationSeams() {
      return freeze({
        contract_version: FABRIC_API_VERSION,
        seams: freeze([
          freeze({ task: 'RF-001', seam: 'device identity', consumed_as: 'device_ref is the canonical identity' }),
          freeze({ task: 'RF-002', seam: 'pairing/trust', consumed_as: 'pair() delegates to the one trust protocol' }),
          freeze({ task: 'RF-003', seam: 'LAN discovery', consumed_as: 'discover() results are candidates only' }),
          freeze({ task: 'RF-004', seam: 'Bluetooth bootstrap', consumed_as: 'a bootstrap entry point, never trust' }),
          freeze({ task: 'RF-005', seam: 'invite rendezvous', consumed_as: 'pair(invitation_ref) after host confirmation' }),
          freeze({ task: 'RF-006', seam: 'path manager', consumed_as: 'transport_class is hidden behind the adapter' }),
          freeze({ task: 'RF-007', seam: 'capability registry', consumed_as: 'listCapabilities()/invoke() by versioned id' }),
          freeze({ task: 'RF-008', seam: 'typed data plane', consumed_as: 'subscribe()/openStream() semantics' }),
          freeze({ task: 'RF-009', seam: 'presence/reconnect', consumed_as: 'getPresence() is reachability only' }),
          freeze({ task: 'BA-003', seam: 'embodiment binding', consumed_as: 'resolveDevice() for the embodiment view' }),
          freeze({ task: 'BA-008', seam: 'embodiment event bus', consumed_as: 'subscribe() feeds the Assistant bus' }),
          freeze({ task: 'BA-009', seam: 'duties/permission policy', consumed_as: 'policy.evaluate() supplies the intersection' }),
        ]),
        sibling_branches_imported: 0,
        fabric_depends_on_unfinished_siblings: false,
      });
    },

    sessions: () => clone([...sessions.values()]),
    journal: () => clone(journal),
  };
  return Object.freeze(api);
}
