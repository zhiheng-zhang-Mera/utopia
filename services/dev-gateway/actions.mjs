/**
 * UTOPIA · Gateway — the canonical user-facing Action.
 *
 * The three user planes (Rooms, Capability Bridge, City Control tasks) keep their own
 * owners, ids, data models and lifecycles. This module adds **one** record over them so
 * Web and Android can show one honest progress/result/history surface.
 *
 * Hard rules this file exists to enforce:
 *   - Action is an adapter, never replacement truth. Every Action carries the real
 *     backend ids, so nothing downstream has to guess what actually ran.
 *   - a backend refusal stays REFUSED, a policy refusal stays REFUSED, an unreachable
 *     target stays UNAVAILABLE, and SUCCEEDED is only ever written from a real backend
 *     success response. Nothing is synthesised from cached state.
 *   - repeating an idempotency key returns the same Action and never executes twice.
 *
 * There is no BOSS or HNS route in this phase, by binding Owner ruling.
 */

import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { MAX_FILE_BYTES } from '../../contracts/capability-bridge-v1/protocol.mjs';
import { TRUST_ORDER } from '../../city/09-planning-knowledge/01-knowledge-service/knowledge-core/retrieval/knowledge-core.mjs';
// MESH-301 Step 3: the strict target-device intent. Read here so an OFFLINE/BOUND target produces a typed
// Action refusal in the user's own vocabulary instead of a bare City error.
import { readTargetIntent } from './targeting.mjs';

/** The exhaustive status vocabulary. No other value may be written. */
export const ACTION_STATUSES = [
  'QUEUED',
  'RUNNING',
  'WAITING_CONFIRMATION',
  'SUCCEEDED',
  'FAILED',
  'REFUSED',
  'CANCELLED',
  'UNAVAILABLE',
];

/**
 * Routes, exhaustive. `BOSS`/`HNS` are deliberately absent: a historical product name is not a
 * user-level route. `GENERAL_AI` is reserved by GAI-001 as the general-AI route; no executor is
 * attached to it in this phase, so it answers with a typed UNAVAILABLE rather than being
 * mistaken for a City task.
 */
export const ACTION_ROUTES = ['ROOM', 'CAPABILITY', 'CITY_TASK', 'GENERAL_AI'];

const ROOM_HUB_ERROR_CODES = new Set(['ROOM_HUB_UNREACHABLE', 'ROOM_HUB_TIMEOUT', 'ROOM_NOT_FOUND']);

/**
 * Statuses an Action may never leave.
 *
 * This is the rule `contracts/general-ai-gateway-v1` states in `nextActionStatus`, and it is
 * repeated here deliberately rather than imported: the gateway is the product surface, and a
 * service must not take a build dependency on one programme's contract module. `UNAVAILABLE` is
 * final *for this attempt* — the documented retry is a new Action with a new key — so it is
 * included even though the contract keeps it out of its own terminal vocabulary.
 */
export const FINAL_ACTION_STATUSES = Object.freeze(['SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED', 'UNAVAILABLE']);

/**
 * Decide the status a reconciled observation may write.
 *
 * Exported because it is the whole rule, and it had no test at all: `reconcile` is reachable only
 * through a CITY_TASK Action backed by a live City task, which no test in this repository set up,
 * so a terminal Action could be silently re-opened by the next read. A late observation is
 * evidence, not a new outcome: the recorded status stands and the observation is returned as
 * `refused` so the caller can keep it in provenance instead of writing it.
 *
 * @param {string} currentStatus the status already recorded for the Action
 * @param {string} observedStatus the status the City task state maps to now
 * @returns {{status: string, refused: string|null}}
 */
export function reconcileStatus(currentStatus, observedStatus) {
  if (observedStatus === currentStatus) return { status: currentStatus, refused: null };
  if (FINAL_ACTION_STATUSES.includes(currentStatus)) return { status: currentStatus, refused: observedStatus };
  return { status: observedStatus, refused: null };
}

function invalid(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

function text(value, field, { max = 500, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw invalid('INVALID_INPUT', `${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw invalid('INVALID_INPUT', `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed && required) throw invalid('INVALID_INPUT', `${field} is required`);
  if (trimmed.length > max) throw invalid('INVALID_INPUT', `${field} must be at most ${max} characters`);
  return trimmed;
}

/* ------------------------------------------------------------------ *
 * Local file access, bounded. Used by the routes that read a real file
 * from the host the gateway runs on. Never unbounded, never a shell.
 * ------------------------------------------------------------------ */

async function readLocalFile(pathValue, { binary = false } = {}) {
  const requested = text(pathValue, 'path', { max: 1000 });
  const absolute = resolve(requested);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw Object.assign(invalid('FILE_NOT_FOUND', `no readable file at ${absolute}`), { status: 404 });
  }
  if (!info.isFile()) throw invalid('NOT_A_FILE', `${absolute} is not a regular file`);
  if (info.size > MAX_FILE_BYTES) {
    throw invalid('INPUT_TOO_LARGE', `file is ${info.size} bytes; the limit is ${MAX_FILE_BYTES}`);
  }
  const bytes = await readFile(absolute);
  return { absolute, name: basename(absolute), bytes, size: info.size, binary };
}

/* ------------------------------------------------------------------ *
 * ROOM operations.
 *
 * Every one of these calls the room's own HTTP API over loopback. The
 * room keeps owning its data; the gateway only decides *which* call the
 * user's words mean.
 * ------------------------------------------------------------------ */

export const ROOM_OPERATIONS = {
  'checklist.add-item': {
    room: 'checklist',
    label: 'Checklist — add an item',
    description: 'Adds one open item to a checklist (creating a list only when none exists yet).',
    example: 'add buy milk to my checklist',
    mutating: true,
    sideEffect: false,
    async run({ rooms }, input) {
      const itemText = text(input.itemText ?? input.text, 'itemText', { max: 500 });
      const lists = await rooms.call('checklist', { path: '/checklists' });
      const existing = (lists?.checklists ?? [])
        .slice()
        .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
      let list = existing[0] ?? null;
      let createdList = false;
      if (!list) {
        const made = await rooms.call('checklist', {
          method: 'POST',
          path: '/checklists',
          body: { title: text(input.checklistTitle ?? 'Quick list', 'checklistTitle', { max: 160 }) },
        });
        list = made.checklist;
        createdList = true;
      }
      const added = await rooms.call('checklist', {
        method: 'POST',
        path: `/checklists/${encodeURIComponent(list.id)}/items`,
        body: { text: itemText },
      });
      return {
        backendRef: { kind: 'ROOM', id: 'checklist', roomId: 'checklist', operationId: 'checklist.add-item', recordId: added.item.id, checklistId: list.id },
        resultSummary: `Added “${itemText}” to ${list.title}${createdList ? ' (new list)' : ''}.`,
        resultRef: { kind: 'ROOM_RECORD', id: added.item.id, digest: null },
        raw: { checklistId: list.id, itemId: added.item.id, createdList },
      };
    },
  },

  'bookmarks.add-bookmark': {
    room: 'bookmarks',
    label: 'Bookmark Room — save a link',
    description: 'Saves one URL with an optional title into the local Bookmark Room.',
    example: 'save this link https://example.com',
    mutating: true,
    sideEffect: false,
    async run({ rooms }, input) {
      const url = text(input.url, 'url', { max: 2000 });
      // The room default is an empty title; sending an explicit empty string is refused,
      // so the key is omitted entirely rather than sent blank.
      const body = { url, note: '' };
      const title = input.title === undefined ? '' : text(input.title, 'title', { max: 160, required: false });
      if (title) body.title = title;
      const made = await rooms.call('bookmarks', { method: 'POST', path: '/bookmarks', body });
      const bookmark = made.bookmark ?? made;
      return {
        backendRef: { kind: 'ROOM', id: 'bookmarks', roomId: 'bookmarks', operationId: 'bookmarks.add-bookmark', recordId: bookmark.id },
        resultSummary: `Saved bookmark ${bookmark.url ?? url}.`,
        resultRef: { kind: 'ROOM_RECORD', id: bookmark.id, digest: null },
        raw: { bookmarkId: bookmark.id },
      };
    },
  },

  'hash.hash-file': {
    room: 'hash',
    label: 'Hash Room — hash a file',
    description: 'Reads a local text file and asks the Hash Room for its SHA-256 over the file’s UTF-8 text.',
    example: 'hash C:\\temp\\notes.txt',
    mutating: false,
    sideEffect: false,
    async run({ rooms, readLocalFile: readFileImpl }, input) {
      const file = await readFileImpl(input.path);
      const textContent = file.bytes.toString('utf8');
      if (textContent.includes('\u0000')) {
        throw invalid('NOT_A_TEXT_FILE', `${file.absolute} looks binary; the Hash Room hashes text, not bytes`);
      }
      const digest = await rooms.call('hash', { method: 'POST', path: '/digest', body: { text: textContent, algorithm: 'sha256' } });
      return {
        backendRef: { kind: 'ROOM', id: 'hash', roomId: 'hash', operationId: 'hash.hash-file', file: file.name },
        resultSummary: `sha256(${file.name} as UTF-8 text) = ${digest.digest} over ${digest.byteLength} bytes.`,
        resultRef: { kind: 'ROOM_RESULT', id: digest.digest, digest: digest.digest },
        raw: { algorithm: digest.algorithm, digest: digest.digest, byteLength: digest.byteLength, file: file.absolute },
      };
    },
  },

  'knowledge.add-entry': {
    room: 'knowledge',
    label: 'Knowledge Room — add an entry',
    description: 'Adds one titled knowledge entry with optional tags to the local Knowledge Room.',
    example: 'note that the gateway listens on 4310',
    mutating: true,
    sideEffect: false,
    async run({ rooms }, input) {
      const title = text(input.title, 'title', { max: 200 });
      const body = text(input.body ?? '', 'body', { max: 20000, required: false });
      const tags = Array.isArray(input.tags) ? input.tags.slice(0, 20).map((t) => text(t, 'tag', { max: 40 })) : [];
      const made = await rooms.call('knowledge', { method: 'POST', path: '/entries', body: { title, body, tags } });
      return {
        backendRef: { kind: 'ROOM', id: 'knowledge', roomId: 'knowledge', operationId: 'knowledge.add-entry', recordId: made.entry.id },
        resultSummary: `Added knowledge entry “${title}”.`,
        resultRef: { kind: 'ROOM_RECORD', id: made.entry.id, digest: null },
        raw: { entryId: made.entry.id },
      };
    },
  },

  'knowledge.search': {
    room: 'knowledge',
    label: 'Knowledge Room — search entries',
    description: 'Searches the local Knowledge Room only (no City capability involved).',
    example: 'search my knowledge for gateway port',
    mutating: false,
    sideEffect: false,
    async run({ rooms }, input) {
      const query = text(input.query, 'query', { max: 500 });
      const found = await rooms.call('knowledge', { path: `/entries?q=${encodeURIComponent(query)}` });
      return {
        backendRef: { kind: 'ROOM', id: 'knowledge', roomId: 'knowledge', operationId: 'knowledge.search', query },
        resultSummary: `Knowledge Room matched ${(found?.entries ?? []).length} entry(ies) for “${query}”.`,
        resultRef: { kind: 'ROOM_QUERY', id: `knowledge:${query}`, digest: null },
        raw: { total: found?.total ?? 0, entries: (found?.entries ?? []).slice(0, 20) },
      };
    },
  },
};

/* ------------------------------------------------------------------ *
 * CAPABILITY operations.
 *
 * `buildInput` turns the Action's own bounded input into the real
 * adapter input. Nothing here invents a capability: the id and the
 * operation id are the ones the City registry already publishes.
 * ------------------------------------------------------------------ */

export const CAPABILITY_OPERATIONS = {
  'planning.document.intake': {
    read: {
      label: 'Document Intake — read a document',
      description: 'Reads a bounded local document through the City Document Intake capability.',
      example: 'read document C:\\temp\\report.docx',
      mutating: false,
      sideEffect: false,
      async buildInput({ readLocalFile: readFileImpl }, input) {
        const file = await readFileImpl(input.path);
        return { base64: file.bytes.toString('base64'), fileName: file.name };
      },
    },
  },
  'planning.knowledge.query': {
    query: {
      label: 'Knowledge Query — ask a question',
      description: 'Runs the City Knowledge Query capability over the local Knowledge Room entries.',
      example: 'search knowledge for gateway port',
      mutating: false,
      sideEffect: false,
      async buildInput({ rooms }, input) {
        const query = text(input.query, 'query', { max: 500 });
        const found = await rooms.call('knowledge', { path: '/entries' });
        const entries = (found?.entries ?? [])
          .filter((entry) => typeof entry.id === 'string' && typeof entry.title === 'string')
          .map((entry) => ({
            id: entry.id,
            title: entry.title,
            content: String(entry.body ?? ''),
            tags: Array.isArray(entry.tags) ? entry.tags : [],
            trust: 'UNVERIFIED',
            ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
          }))
          // The adapter refuses an entry whose trust is not in the core's order.
          .filter((entry) => entry.trust in TRUST_ORDER);
        return { query, entries };
      },
    },
  },
  'research.evidence.review': {
    review: {
      label: 'Evidence Review — review a bundle',
      description: 'Reviews an evidence bundle through the City Evidence Review capability.',
      example: 'review evidence',
      mutating: false,
      sideEffect: false,
      async buildInput(_context, input) {
        if (input.sample === true) return { sample: true };
        if (input.task && Array.isArray(input.artifacts)) {
          return { task: input.task, artifacts: input.artifacts, disputes: Array.isArray(input.disputes) ? input.disputes : [] };
        }
        // The capability's own honest refusal path, rather than a fabricated bundle.
        throw invalid('TASK_REQUIRED', 'evidence review needs a task and artifacts, or "sample": true');
      },
    },
  },
  'presentation.theme.lab': {
    generate: {
      label: 'Theme Lab — generate a theme',
      description: 'Generates a theme in the City Theme Lab sandbox.',
      example: 'generate a theme for a research dashboard',
      mutating: false,
      sideEffect: false,
      async buildInput(_context, input) {
        return { prompt: text(input.prompt, 'prompt', { max: 2000 }) };
      },
    },
    build: {
      label: 'Theme Lab — build a theme package',
      description: 'Builds theme artifacts. Writes product artifacts, so it needs confirmation.',
      example: 'build a theme for a research dashboard',
      mutating: true,
      sideEffect: true,
      async buildInput(_context, input) {
        return { prompt: text(input.prompt, 'prompt', { max: 2000 }) };
      },
    },
  },
  'engineering.skill.inspect': {
    validate: {
      label: 'Skill Inspect — validate skill text',
      description: 'Validates a skill definition without installing anything.',
      example: 'validate skill text',
      mutating: false,
      sideEffect: false,
      async buildInput(_context, input) {
        return { text: text(input.text, 'text', { max: 200000 }) };
      },
    },
  },
};

/** City Control task types. Kept identical to the control protocol's own list. */
export const CITY_TASK_TYPES = ['WAIT', 'CREATE_TEMP_ARTIFACT', 'HASH_TEMP_ARTIFACT', 'DELETE_TEMP_ARTIFACT', 'CHECKPOINT_DEMO'];

const TASK_STATUS_MAP = {
  QUEUED: 'QUEUED',
  ASSIGNED: 'RUNNING',
  RUNNING: 'RUNNING',
  COMPLETED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

const TASK_PROGRESS = { QUEUED: 5, ASSIGNED: 10, COMPLETED: 100 };

/**
 * Create the Action store/facade.
 *
 * `cityTasks` is the City Control adapter supplied by the gateway:
 *   { create(type, {targetDeviceRef}) -> task, get(id) -> task|null, nodes() -> node[],
 *     targetVerdict(targetDeviceRef) -> {state, nodeId, node, reason, claimable},
 *     terminal: string[], availability() -> {available, reason} }
 */
export function createActions({ store, rooms, bridge, cityTasks, host = 'utopia-host', now = () => new Date().toISOString() }) {
  const context = { rooms, readLocalFile: (value) => readLocalFile(value) };

  function persist(action) {
    store.put('actions', action);
    return action;
  }

  function withHistory(action, status, note) {
    return {
      ...action,
      status,
      updatedAt: now(),
      provenance: { ...action.provenance, history: [...action.provenance.history, { at: now(), status, note }] },
    };
  }

  /** Re-read a CITY_TASK action's truth from the real task, never from cache. */
  function reconcile(action) {
    if (action.route !== 'CITY_TASK' || !action.backendRef.taskId) return action;
    const task = cityTasks.get(action.backendRef.taskId);
    if (!task) return action;
    const observedStatus = TASK_STATUS_MAP[task.state] ?? action.status;
    const progress = task.state === 'RUNNING' ? Math.max(action.progress, Number(task.progress) || 0) : TASK_PROGRESS[task.state] ?? action.progress;
    const error = task.state === 'FAILED' ? { code: task.errorCode ?? 'TASK_FAILED', message: String(task.error ?? 'task failed') } : null;
    const resultRef = task.state === 'COMPLETED'
      ? { kind: 'CITY_TASK_RESULT', id: task.id, digest: null, summary: `City task ${task.type} completed.` }
      : null;
    // A reconciled status must obey the same status machine as every other update. Without this
    // guard a later read silently re-opened a finished Action: SUCCEEDED became CANCELLED or
    // FAILED once the City task moved on, and REFUSED/UNAVAILABLE became SUCCEEDED. A late
    // observation is evidence, not a new outcome, so it is kept in provenance and the Action's
    // recorded status is left alone.
    const decision = reconcileStatus(action.status, observedStatus);
    const status = decision.status;
    const refusedObservation = decision.refused;
    if (status === action.status && progress === action.progress && action.provenance.cityTaskState === task.state && refusedObservation === null) return action;
    return persist({
      ...action,
      status,
      progress,
      error,
      resultRef,
      updatedAt: now(),
      provenance: {
        ...action.provenance,
        // Keep the observed City Control state in step with the task, so provenance does not
        // keep claiming QUEUED after the task has completed.
        cityTaskState: task.state,
        lateObservations: refusedObservation === null
          ? (action.provenance.lateObservations ?? [])
          : [...(action.provenance.lateObservations ?? []), { at: now(), observedStatus: refusedObservation, keptStatus: action.status }],
        history: [...action.provenance.history, {
          at: now(),
          status,
          note: refusedObservation === null
            ? `observed City task state ${task.state}`
            : `ignored late City task state ${task.state} (${refusedObservation}); ${action.status} is final`,
        }],
      },
    });
  }

  function findByIdempotencyKey(key) {
    if (!key) return null;
    return store.list('actions').find((action) => action.idempotencyKey === key) ?? null;
  }

  /** Order-independent fingerprint of the request an idempotency key is bound to. */
  function fingerprintOf({ route, target, operation, input }) {
    const stable = (value) => {
      if (Array.isArray(value)) return value.map(stable);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
      }
      return value;
    };
    return JSON.stringify(stable({ route, target, operation: operation ?? '', input: input ?? {} }));
  }

  async function runRoom(request, action) {
    const operation = ROOM_OPERATIONS[request.operation];
    if (!operation) {
      return persist(withHistory({ ...action, error: { code: 'ROOM_OPERATION_UNSUPPORTED', message: `no supported room operation ${request.operation}` } }, 'REFUSED', 'unsupported room operation'));
    }
    try {
      const outcome = await operation.run(context, request.input ?? {});
      return persist({
        ...action,
        status: 'SUCCEEDED',
        progress: 100,
        backendRef: { ...action.backendRef, ...outcome.backendRef },
        resultRef: { ...outcome.resultRef, summary: outcome.resultSummary },
        error: null,
        updatedAt: now(),
        provenance: {
          ...action.provenance,
          ...outcome.backendRef,
          history: [...action.provenance.history, { at: now(), status: 'SUCCEEDED', note: outcome.resultSummary }],
        },
        backendResult: outcome.raw,
      });
    } catch (error) {
      const refused = error.code === 'ROOM_NOT_FOUND' || error.code === 'ROOM_OPERATION_UNSUPPORTED';
      const unavailable = ROOM_HUB_ERROR_CODES.has(error.code);
      const status = refused ? 'REFUSED' : unavailable ? 'UNAVAILABLE' : 'FAILED';
      const failure = { code: error.code ?? 'ROOM_ERROR', message: error.message };
      return persist(withHistory({ ...action, progress: status === 'SUCCEEDED' ? 100 : 0, error: failure }, status, failure.message));
    }
  }

  async function runCapability(request, action) {
    const operation = CAPABILITY_OPERATIONS[request.target]?.[request.operation];
    if (!operation) {
      return persist(withHistory({ ...action, error: { code: 'OPERATION_BLOCKED', message: `no supported operation ${request.operation} on ${request.target}` } }, 'REFUSED', 'unsupported capability operation'));
    }
    let input;
    try {
      input = await operation.buildInput(context, request.input ?? {});
    } catch (error) {
      const failure = { code: error.code ?? 'INVALID_INPUT', message: error.message };
      return persist(withHistory({ ...action, error: failure }, 'REFUSED', failure.message));
    }
    try {
      const invocation = await bridge.invoke(request.target, { operationId: request.operation, input });
      const succeeded = invocation.status === 'COMPLETED';
      const failure = succeeded ? null : { code: invocation.errorCode ?? 'CAPABILITY_FAILED', message: `capability ${request.target} ${invocation.status}` };
      const resultRef = succeeded
        ? { kind: 'CAPABILITY_RESULT', id: invocation.invocationId, digest: invocation.resultDigest, summary: `${request.target}:${request.operation} completed.` }
        : null;
      return persist({
        ...action,
        status: succeeded ? 'SUCCEEDED' : 'FAILED',
        progress: succeeded ? 100 : 0,
        backendRef: { ...action.backendRef, invocationId: invocation.invocationId },
        resultRef,
        error: failure,
        updatedAt: now(),
        provenance: {
          ...action.provenance,
          invocationId: invocation.invocationId,
          resultDigest: invocation.resultDigest,
          history: [...action.provenance.history, { at: now(), status: succeeded ? 'SUCCEEDED' : 'FAILED', note: failure ? failure.message : 'capability returned a result' }],
        },
      });
    } catch (error) {
      const code = error.code ?? 'CAPABILITY_ERROR';
      // The bridge's own vocabulary maps to the Action vocabulary without inventing success.
      const status = code === 'CAPABILITY_NOT_FOUND' || code === 'OPERATION_BLOCKED' || code === 'INVALID_INPUT'
        ? 'REFUSED'
        : code === 'BRIDGE_PENDING' || code === 'BUSY' || code === 'CAPABILITY_UNAVAILABLE'
          ? 'UNAVAILABLE'
          : 'FAILED';
      const failure = { code, message: error.message };
      return persist(withHistory({ ...action, error: failure }, status, failure.message));
    }
  }

  function runCityTask(request, action) {
    const type = request.operation;
    if (!CITY_TASK_TYPES.includes(type)) {
      return persist(withHistory({ ...action, error: { code: 'UNSUPPORTED_TASK_TYPE', message: `unsupported City task type ${type}` } }, 'REFUSED', 'unsupported City task type'));
    }
    // MESH-301 Step 3. The strict target travels in `input`, exactly as every other route's parameters do, so
    // the EXISTING idempotency fingerprint - which already hashes `input` - covers it. Replaying a key with the
    // same target replays the same Action (no second execution); reusing a key with a DIFFERENT target is
    // refused by `IDEMPOTENCY_KEY_REUSED`. The duplicate-submit boundary is therefore inherited from the
    // contract rather than reinvented beside it, and no wire field is added to a frozen route.
    const intent = readTargetIntent(request?.input?.targetDeviceRef);
    if (intent.ok === false) {
      const failure = { code: intent.code, message: intent.message };
      return persist(withHistory({ ...action, error: failure, progress: 0 }, 'REFUSED', failure.message));
    }
    let verdict = null;
    if (intent.present) {
      // The target verdict is asked for BEFORE the fleet availability gate: "no such device" and "no device
      // can take work right now" are different truths and the more precise one has to win the refusal.
      verdict = cityTasks.targetVerdict(intent.value);
      if (verdict.state === 'UNKNOWN') {
        const failure = { code: 'TARGET_DEVICE_UNKNOWN', message: `no City node identity "${intent.value}" is known to this City` };
        return persist(withHistory({ ...action, error: failure, progress: 0 }, 'REFUSED', failure.message));
      }
      // A target that is OFFLINE or INELIGIBLE is NOT a refusal and NOT a reassignment: the task is created and
      // WAITS for the device the user named. The fleet-wide availability gate is deliberately NOT applied here,
      // because for a strict task the fleet is not what decides - the named device is. Skipping creation would
      // make "queue this for Mech while Mech is away" impossible, and rerouting it would be the silent fallback
      // the workbook forbids.
    } else {
      const availability = cityTasks.availability();
      if (!availability.available) {
        return persist(withHistory({ ...action, error: { code: 'NODE_UNAVAILABLE', message: availability.reason }, progress: 0 }, 'UNAVAILABLE', availability.reason));
      }
    }
    let task;
    try {
      task = cityTasks.create(type, { targetDeviceRef: intent.present ? intent.value : null });
    } catch (error) {
      const code = error.code ?? 'CITY_TASK_REFUSED';
      const failure = { code, message: error.message };
      return persist(withHistory({ ...action, error: failure, progress: 0 }, 'REFUSED', failure.message));
    }
    const targeted = typeof task.targetDeviceRef === 'string' && task.targetDeviceRef.length > 0;
    const note = targeted
      ? `City task ${task.id} created as ${type}, strictly targeted at ${task.targetDeviceRef} (target state ${task.targetStateAtCreation}); it may be claimed by that device only.`
      : `City task ${task.id} created as ${type}.`;
    return persist({
      ...action,
      status: TASK_STATUS_MAP[task.state] ?? 'QUEUED',
      progress: TASK_PROGRESS[task.state] ?? 5,
      backendRef: { ...action.backendRef, taskId: task.id, targetDeviceRef: targeted ? task.targetDeviceRef : null },
      updatedAt: now(),
      provenance: {
        ...action.provenance,
        taskId: task.id,
        cityTaskState: task.state,
        targetDeviceRef: targeted ? task.targetDeviceRef : null,
        targetStateAtCreation: targeted ? task.targetStateAtCreation : null,
        history: [...action.provenance.history, { at: now(), status: TASK_STATUS_MAP[task.state] ?? 'QUEUED', note }],
      },
    });
  }

  /**
   * The GENERAL_AI route is reserved but has no executor in this phase. It must not fall through
   * to the City-task branch (that would represent a general-AI request as a City task) and it
   * must not report success: the honest answer is a typed UNAVAILABLE.
   */
  function runGeneralAi(action) {
    return persist(withHistory({
      ...action,
      error: {
        code: 'GENERAL_AI_NOT_ATTACHED',
        message: 'the GENERAL_AI route is reserved; no general-AI executor is attached to this gateway yet',
      },
      progress: 0,
    }, 'UNAVAILABLE', 'GENERAL_AI route reserved; execution is not implemented in this phase'));
  }

  /** Create (or replay) one Action. This is the only entry point. */
  async function create(request) {
    const idempotencyKey = typeof request?.idempotencyKey === 'string' && request.idempotencyKey.length <= 200 ? request.idempotencyKey : null;

    const intent = text(request?.intent ?? '', 'intent', { max: 1000, required: false });
    const route = String(request?.route ?? '');
    if (!ACTION_ROUTES.includes(route)) throw invalid('INVALID_ROUTE', `route must be one of ${ACTION_ROUTES.join(', ')}`);
    const target = text(request?.target ?? '', 'target', { max: 200 });
    const operation = text(request?.operation ?? '', 'operation', { max: 120 });
    const fingerprint = fingerprintOf({ route, target, operation, input: request?.input });

    const replay = findByIdempotencyKey(idempotencyKey);
    if (replay) {
      // A key identifies ONE request. Silently returning the first Action for a different
      // request would let a caller believe a different thing happened than really did.
      if (replay.requestFingerprint && replay.requestFingerprint !== fingerprint) {
        throw invalid(
          'IDEMPOTENCY_KEY_REUSED',
          `idempotencyKey ${idempotencyKey} is already bound to ${replay.route} ${replay.target?.id ?? '?'}${replay.target?.operation ? `:${replay.target.operation}` : ''}; use a new key for a different request`,
        );
      }
      return { action: reconcile(replay), replayed: true };
    }

    const actionId = `A-${randomUUID()}`;
    let action = {
      id: actionId,
      actionId,
      requestedIntent: intent,
      route,
      backendRef: route === 'ROOM'
        ? { kind: 'ROOM', id: target, roomId: target, operationId: operation }
        : route === 'CAPABILITY'
          ? { kind: 'CAPABILITY', id: target, capabilityId: target, operationId: operation }
          : route === 'GENERAL_AI'
            // Typed provider/model/account/conversation references; all null until a channel
            // (GAI-002+) resolves them. Never a City task.
            ? { kind: 'GENERAL_AI', id: target, providerRef: null, modelRef: null, accountRef: null, conversationId: null, operationId: operation }
            : { kind: 'CITY_TASK', id: 'city.task', taskId: null, operationId: operation },
      target: { id: target, label: labelFor(route, target, operation), operation },
      status: 'QUEUED',
      progress: 0,
      resultRef: null,
      error: null,
      idempotencyKey,
      requestFingerprint: fingerprint,
      provenance: {
        source: 'utopia.dev-gateway',
        host,
        route,
        roomId: route === 'ROOM' ? target : null,
        capabilityId: route === 'CAPABILITY' ? target : null,
        taskId: null,
        invocationId: null,
        history: [{ at: now(), status: 'QUEUED', note: `routed to ${route} ${target}${operation ? `:${operation}` : ''}` }],
      },
      createdAt: now(),
      updatedAt: now(),
    };
    persist(action);
    action = persist(withHistory(action, 'RUNNING', 'executing'));
    if (route === 'ROOM') return { action: await runRoom({ target, operation, input: request.input ?? {} }, action), replayed: false };
    if (route === 'CAPABILITY') return { action: await runCapability({ target, operation, input: request.input ?? {} }, action), replayed: false };
    if (route === 'GENERAL_AI') return { action: runGeneralAi(action), replayed: false };
    return { action: runCityTask({ operation, input: request.input ?? {} }, action), replayed: false };
  }

  function labelFor(route, target, operation) {
    if (route === 'ROOM') return ROOM_OPERATIONS[operation]?.label ?? target;
    if (route === 'CAPABILITY') return CAPABILITY_OPERATIONS[target]?.[operation]?.label ?? target;
    if (route === 'GENERAL_AI') return `General AI ${target}${operation ? `:${operation}` : ''}`;
    return `City task — ${operation}`;
  }

  function list(limit) {
    const size = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 200) : 50;
    const all = store.list('actions').map(reconcile);
    return all.slice().reverse().slice(0, size);
  }

  function get(actionId) {
    const found = store.get('actions', actionId);
    return found ? reconcile(found) : null;
  }

  return { create, list, get, labelFor, ROOM_OPERATIONS, CAPABILITY_OPERATIONS, CITY_TASK_TYPES };
}
