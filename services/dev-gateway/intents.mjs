/**
 * UTOPIA · Gateway — deterministic Ask / Do router.
 *
 * The user should not have to choose Rooms vs Services vs Tasks before saying what they
 * want. This module maps bounded, explicit patterns onto targets that already exist.
 *
 * It is deliberately **not** a language model and must never become one in this phase:
 *   - every rule is a literal pattern with a literal target, readable in this file;
 *   - a rule that is not here simply does not match, and the user gets the manual picker;
 *   - when more than one target is genuinely plausible the router refuses to guess and
 *     returns 2–3 concrete candidates instead;
 *   - a target with a meaningful external side effect cannot execute without an explicit
 *     confirmation, whatever the wording was.
 *
 * Adding a capability to the product therefore means adding a rule here or using the
 * manual picker — it never means "ask a model".
 */

import { ROOM_OPERATIONS, CAPABILITY_OPERATIONS, CITY_TASK_TYPES } from './actions.mjs';
import {ownerControlTargets} from './owner-control-intents.mjs';

/** Every target the manual picker can offer, with its own truth. */
export function buildTargets({ roomState, capabilities, cityAvailability, roomsAvailable, ownerControls }) {
  const targets = [];

  for (const [operation, meta] of Object.entries(ROOM_OPERATIONS)) {
    targets.push({
      route: 'ROOM',
      target: meta.room,
      operation,
      label: meta.label,
      description: meta.description,
      example: meta.example,
      mutating: meta.mutating,
      sideEffect: meta.sideEffect,
      available: Boolean(roomsAvailable),
      unavailableReason: roomsAvailable ? null : (roomState?.reason ?? 'Room Hub is not available'),
    });
  }

  for (const [capabilityId, operations] of Object.entries(CAPABILITY_OPERATIONS)) {
    const descriptor = (capabilities ?? []).find((entry) => entry.capabilityId === capabilityId) ?? null;
    for (const [operation, meta] of Object.entries(operations)) {
      const available = descriptor?.bridgeState === 'AVAILABLE';
      targets.push({
        route: 'CAPABILITY',
        target: capabilityId,
        operation,
        label: meta.label,
        description: meta.description,
        example: meta.example,
        mutating: meta.mutating,
        sideEffect: meta.sideEffect,
        available,
        unavailableReason: available ? null : `City capability ${capabilityId} is ${descriptor?.bridgeState ?? 'NOT_REGISTERED'}`,
      });
    }
  }

  for (const type of CITY_TASK_TYPES) {
    targets.push({
      route: 'CITY_TASK',
      target: 'city.task',
      operation: type,
      label: `City task — ${type}`,
      description: 'Runs an already supported safe City Control task on an eligible node. Executes outside Utopia, so it needs confirmation.',
      example: `run a safe task of type ${type}`,
      mutating: true,
      sideEffect: true,
      available: Boolean(cityAvailability?.available),
      unavailableReason: cityAvailability?.available ? null : (cityAvailability?.reason ?? 'no eligible node'),
    });
  }

  if(ownerControls)targets.push(...ownerControlTargets(ownerControls));
  return targets;
}

const stripLead = (value) => String(value ?? '').trim().replace(/^[\s:：-]+/, '').replace(/^["'“”]|["'“”]$/g, '').trim();

/**
 * Ordered rules. The first rule that matches decides; a rule may return more than one
 * candidate, and that is exactly how ambiguity is produced rather than guessed away.
 */
export const RULES = [
  {
    id: 'hash-file',
    test(text) {
      const match = /^(?:please\s+)?(?:hash|sha-?256|checksum)\s+(?:this\s+|the\s+)?(?:file\s+)?(.+)$/i.exec(text)
        ?? /^(?:请)?(?:计算)?(?:哈希|校验和)\s*(?:文件)?\s*(.+)$/.exec(text);
      if (!match) return null;
      const path = stripLead(match[1]);
      if (!path) return null;
      return [{ route: 'ROOM', target: 'hash', operation: 'hash.hash-file', input: { path } }];
    },
  },
  {
    id: 'save-bookmark',
    test(text) {
      const match = /^(?:please\s+)?(?:save|add|bookmark)\s+(?:this\s+|the\s+)?(?:link|url|bookmark|page)\s+(\S+)$/i.exec(text)
        ?? /^(?:请)?(?:保存|收藏|添加)\s*(?:这个|该)?\s*(?:链接|网址|书签)\s*(\S+)$/.exec(text);
      if (!match) return null;
      return [{ route: 'ROOM', target: 'bookmarks', operation: 'bookmarks.add-bookmark', input: { url: stripLead(match[1]) } }];
    },
  },
  {
    id: 'add-to-checklist',
    test(text) {
      const match = /^(?:please\s+)?(?:add|put|append)\s+(.+?)\s+(?:to|onto|on)\s+(?:my\s+|the\s+|a\s+)?(?:checklist|list)\s*$/i.exec(text)
        ?? /^(?:请)?(?:把|将)?\s*(.+?)\s*(?:加入|加到|添加到|记到|放到)\s*(?:我的|这个|该)?\s*(?:清单|列表)\s*$/.exec(text);
      if (!match) return null;
      const itemText = stripLead(match[1]);
      if (!itemText) return null;
      return [{ route: 'ROOM', target: 'checklist', operation: 'checklist.add-item', input: { itemText } }];
    },
  },
  {
    id: 'read-document',
    test(text) {
      const match = /^(?:please\s+)?(?:read|import|ingest|parse|open)\s+(?:this\s+|the\s+|a\s+)?(?:document|file|pdf|docx|xlsx|text\s*file)\s+(.+)$/i.exec(text)
        ?? /^(?:请)?(?:读取|导入|解析|打开)\s*(?:这个|该)?\s*(?:文档|文件)\s*(.+)$/.exec(text);
      if (!match) return null;
      const path = stripLead(match[1]);
      if (!path) return null;
      return [{ route: 'CAPABILITY', target: 'planning.document.intake', operation: 'read', input: { path } }];
    },
  },
  {
    id: 'note-knowledge',
    test(text) {
      const match = /^(?:please\s+)?(?:note|remember|note\s+down|save)\s+that\s+(.+)$/i.exec(text)
        ?? /^(?:请)?(?:记录|记下|备注)\s*(?:一下)?\s*[:：]?\s*(.+)$/.exec(text);
      if (!match) return null;
      const body = stripLead(match[1]);
      if (!body) return null;
      return [{
        route: 'ROOM',
        target: 'knowledge',
        operation: 'knowledge.add-entry',
        input: { title: body.length > 60 ? `${body.slice(0, 57)}…` : body, body, tags: ['from-ask'] },
      }];
    },
  },
  {
    id: 'review-evidence',
    test(text) {
      if (!/^(?:please\s+)?(?:review|check|inspect|audit)\s+(?:the\s+|this\s+|an?\s+)?evidence\b/i.test(text)
        && !/^(?:请)?(?:审查|检查|复核|审计)\s*(?:一下)?\s*证据/.test(text)) return null;
      return [{ route: 'CAPABILITY', target: 'research.evidence.review', operation: 'review', input: { sample: true } }];
    },
  },
  {
    id: 'generate-theme',
    test(text) {
      const match = /^(?:please\s+)?(?:generate|create|make|design)\s+(?:a\s+|an\s+)?theme\s*(?:for|about|with|:)?\s*(.*)$/i.exec(text)
        ?? /^(?:请)?(?:生成|创建|设计)\s*(?:一个|个)?\s*主题\s*(?:用于|关于|：|:)?\s*(.*)$/.exec(text);
      if (!match) return null;
      const prompt = stripLead(match[1]) || 'a calm local dashboard theme';
      return [{ route: 'CAPABILITY', target: 'presentation.theme.lab', operation: 'generate', input: { prompt } }];
    },
  },
  {
    id: 'run-city-task',
    test(text) {
      const match = /^(?:please\s+)?(?:run|execute|start)\s+(?:a\s+)?(?:safe\s+)?(?:city\s+)?task\s*(?:of\s+type\s+)?([A-Za-z_]+)?\s*$/i.exec(text)
        ?? /^(?:请)?(?:运行|执行|启动)\s*(?:一个|个)?\s*(?:安全的?)?\s*(?:城市)?任务\s*(?:类型)?\s*([A-Za-z_]+)?\s*$/.exec(text);
      if (!match) return null;
      const requested = String(match[1] ?? '').toUpperCase();
      const type = CITY_TASK_TYPES.includes(requested) ? requested : 'WAIT';
      return [{ route: 'CITY_TASK', target: 'city.task', operation: type, input: {} }];
    },
  },
  {
    /**
     * Knowledge lookup is genuinely reachable through two different owners: the local
     * Knowledge Room and the City Knowledge Query capability. The router reports both
     * rather than silently preferring one.
     */
    id: 'knowledge-lookup',
    test(text) {
      const match = /^(?:please\s+)?(?:search|query|look\s*up|find|look\s+for)\s+(?:in\s+)?(?:my\s+|the\s+)?knowledge\s*(?:base)?\s*(?:for|about|:)?\s*(.+)$/i.exec(text)
        ?? /^(?:please\s+)?(?:search|query|look\s*up|find)\s+(?:for\s+)?(.+)$/i.exec(text)
        ?? /^(?:请)?(?:搜索|查询|检索)\s*(.+)$/.exec(text);
      if (!match) return null;
      const query = stripLead(match[1]);
      if (!query) return null;
      return [
        { route: 'ROOM', target: 'knowledge', operation: 'knowledge.search', input: { query } },
        { route: 'CAPABILITY', target: 'planning.knowledge.query', operation: 'query', input: { query } },
      ];
    },
  },
];

const ASK_OUTCOME = {
  SUCCEEDED: 'COMPLETED',
  FAILED: 'FAILED',
  REFUSED: 'REFUSED',
  UNAVAILABLE: 'UNAVAILABLE',
  CANCELLED: 'CANCELLED',
  QUEUED: 'RESOLVED',
  RUNNING: 'RESOLVED',
  WAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
};

/** Human text that never overstates what happened. */
function describe(ask, action) {
  if (action?.error) return `${action.error.code}: ${action.error.message}`;
  if (action?.resultRef?.summary) return action.resultRef.summary;
  if (action?.status === 'RUNNING' || action?.status === 'QUEUED') return `Started ${action.target.label}; still ${action.status.toLowerCase()}.`;
  return `${action?.target?.label ?? 'target'} finished as ${action?.status ?? 'unknown'}.`;
}

/** Run the ordered rules and return full, truthful candidates (with their extracted input). */
function resolveRules(text, targets) {
  for (const rule of RULES) {
    const produced = rule.test(text);
    if (!produced || produced.length === 0) continue;
    return produced
      .map((candidate) => {
        const known = matchTarget(targets, candidate);
        return known ? { ...known, input: candidate.input ?? {}, matchedBy: rule.id } : null;
      })
      .filter(Boolean);
  }
  return [];
}

/**
 * Resolve and, when it is safe to do so, execute one Ask / Do request.
 *
 * `selection` and `confirm` come from the client after the user chose a candidate or
 * confirmed a side effect. Nothing side-effecting runs on the first pass.
 */
export async function handleAsk({ text, selection, confirm, idempotencyKey }, { actions, targets, roomState }) {
  const wanted = String(text ?? '').trim();
  if (!wanted) {
    return {
      text: wanted,
      status: 'UNMATCHED',
      route: null,
      target: null,
      operation: null,
      candidates: targets,
      confirmation: null,
      action: null,
      message: 'Say what you want to do. No routing rule matched an empty request.',
      router: 'DETERMINISTIC_RULES',
      deterministic: true,
      llm: false,
    };
  }

  // The user already chose: execute that exact target. The *input* still comes from the
  // server's own rule extraction, so the client's choice selects a route but never
  // smuggles in an input the rules did not produce.
  if (selection && typeof selection === 'object') {
    const chosen = matchTarget(targets, selection);
    if (!chosen) {
      return {
        text: wanted,
        status: 'UNMATCHED',
        route: null,
        target: null,
        operation: null,
        candidates: targets,
        confirmation: null,
        action: null,
        message: `No such target: ${selection.route ?? '?'} ${selection.target ?? '?'}${selection.operation ? `:${selection.operation}` : ''}.`,
        router: 'DETERMINISTIC_RULES',
        deterministic: true,
        llm: false,
      };
    }
    const fromRule = resolveRules(wanted, targets).find(
      (candidate) => candidate.route === chosen.route && candidate.target === chosen.target && candidate.operation === chosen.operation,
    );
    const resolved = { ...chosen, input: fromRule?.input ?? selection.input ?? {} };
    if (resolved.sideEffect && confirm !== true) {
      return {
        text: wanted,
        status: 'AWAITING_CONFIRMATION',
        route: resolved.route,
        target: resolved.target,
        operation: resolved.operation,
        candidates: [],
        confirmation: { ...resolved, reason: resolved.description },
        action: null,
        message: `${resolved.label} has a real effect outside Utopia. Confirm before it runs.`,
        router: 'DETERMINISTIC_RULES',
        deterministic: true,
        llm: false,
      };
    }
    return execute({ actions, wanted, chosen: resolved, idempotencyKey });
  }

  // First pass: deterministic resolution only.
  const candidates = resolveRules(wanted, targets);

  if (candidates.length === 0) {
    return {
      text: wanted,
      status: 'UNMATCHED',
      route: null,
      target: null,
      operation: null,
      candidates: targets,
      confirmation: null,
      action: null,
      message: 'No deterministic rule matched. Pick a target below — nothing was executed.',
      router: 'DETERMINISTIC_RULES',
      deterministic: true,
      llm: false,
    };
  }

  if (candidates.length > 1) {
    return {
      text: wanted,
      status: 'AMBIGUOUS',
      route: null,
      target: null,
      operation: null,
      candidates,
      confirmation: null,
      action: null,
      message: `${candidates.length} targets could do this. Choose one — nothing was executed.`,
      router: 'DETERMINISTIC_RULES',
      deterministic: true,
      llm: false,
    };
  }

  const chosen = candidates[0];
  if (chosen.sideEffect && confirm !== true) {
    return {
      text: wanted,
      status: 'AWAITING_CONFIRMATION',
      route: chosen.route,
      target: chosen.target,
      operation: chosen.operation,
      candidates: [],
      confirmation: { ...chosen, reason: chosen.description },
      action: null,
      message: `${chosen.label} has a real effect outside Utopia. Confirm before it runs.`,
      router: 'DETERMINISTIC_RULES',
      deterministic: true,
      llm: false,
    };
  }
  return execute({ actions, wanted, chosen, idempotencyKey });
}

async function execute({ actions, wanted, chosen, idempotencyKey }) {
  const { action } = await actions.create({
    intent: wanted,
    route: chosen.route,
    target: chosen.target,
    operation: chosen.operation,
    input: chosen.input ?? {},
    idempotencyKey: idempotencyKey ?? null,
  });
  const status = ASK_OUTCOME[action.status] ?? 'FAILED';
  return {
    text: wanted,
    status,
    route: action.route,
    target: action.target.id,
    operation: action.target.operation,
    candidates: [],
    confirmation: null,
    action,
    message: describe(wanted, action),
    router: 'DETERMINISTIC_RULES',
    deterministic: true,
    llm: false,
  };
}

/** Find the full, truthful target record for a candidate or selection. */
export function matchTarget(targets, wanted) {
  const route = wanted?.route;
  const target = wanted?.target;
  const operation = wanted?.operation;
  const found = targets.find((entry) => entry.route === route && entry.target === target && (!operation || entry.operation === operation));
  if (!found) return null;
  return { ...found, input: wanted.input ?? undefined };
}
