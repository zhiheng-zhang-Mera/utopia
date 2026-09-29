/**
 * UTOPIA · Rooms · Knowledge Core Lab — knowledge core contracts and retrieval.
 *
 * Ported from the Codex-Boss donor `src/shared/knowledge.ts`
 * (zhiheng-zhang-Mera/Codex-Boss @ 8df428eaa437a409368401e95194e40266b83080).
 *
 * The core is pure: no I/O, no storage, no dependency. The donor's
 * `electron/knowledge/knowledge-store.ts` was deliberately NOT copied, because it
 * depends on the Boss commander durable-json layer.
 *
 * Port differences: TypeScript -> ESM JavaScript. Every algorithm is unchanged,
 * including the character budget, the trust ordering and the deterministic
 * tokeniser.
 */

/** Trust levels, in the order the donor defines them. */
export const TRUST_ORDER = {
  UNVERIFIED: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

/** Trust levels from strongest to weakest, used by the UI. */
export const TRUST_LEVELS = ['HIGH', 'MEDIUM', 'LOW', 'UNVERIFIED'];

/** Default retrieval budget in characters (plan §10: knowledge size != context size). */
export const DEFAULT_MAX_CHARS = 8000;

/** Does this entry satisfy the query? Expiry and not-yet-valid windows are honoured. */
export function entryMatches(query, entry, now = Date.now()) {
  if (query.domain && entry.domain !== query.domain) return false;
  if (query.shelf && entry.shelf !== query.shelf) return false;
  if (query.tags?.length && !query.tags.every((tag) => entry.tags.includes(tag))) return false;
  if (query.trustAtLeast && (TRUST_ORDER[entry.trust] ?? 0) < TRUST_ORDER[query.trustAtLeast]) return false;
  if (entry.validUntil && Date.parse(entry.validUntil) < now) return false;
  if (entry.validFrom && Date.parse(entry.validFrom) > now) return false;
  return true;
}

/** Order candidates by trust first, then recency. */
export function byTrustThenRecency(a, b) {
  return TRUST_ORDER[b.trust] - TRUST_ORDER[a.trust] || String(b.updatedAt).localeCompare(String(a.updatedAt));
}

/**
 * Deterministic retrieval honouring the character budget: a knowledge base may be
 * arbitrarily large but the assembled context stays bounded.
 */
export function retrieveWithinBudget(entries, query, now = Date.now()) {
  const candidates = entries
    .filter((entry) => entryMatches(query, entry, now))
    .sort(byTrustThenRecency);
  return applyBudget(candidates, query.maxChars ?? DEFAULT_MAX_CHARS);
}

/** Taxonomy of a knowledge base: the distinct domains, shelves and tags. */
export function taxonomyOf(entries) {
  return {
    domains: [...new Set(entries.map((entry) => entry.domain))].sort(),
    shelves: [...new Set(entries.map((entry) => entry.shelf))].sort(),
    tags: [...new Set(entries.flatMap((entry) => entry.tags))].sort(),
  };
}

/**
 * Deterministic domain router: given a goal and the catalog taxonomy, return the
 * query that routes to the most specific relevant domain plus its matching tags,
 * so context assembly retrieves knowledge for the domain the task lives in.
 */
export function routeKnowledgeQuery(goal, entries) {
  const taxonomy = taxonomyOf(entries);
  const goalTokens = tokenize(goal);
  const domainScores = taxonomy.domains.map((domain) => ({ domain, score: overlapScore(tokenize(domain), goalTokens) }));
  const bestDomain = domainScores.sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain))[0];
  const query = {};
  if (bestDomain && bestDomain.score > 0) {
    query.domain = bestDomain.domain;
    const domainTags = [...new Set(entries.filter((entry) => entry.domain === bestDomain.domain).flatMap((entry) => entry.tags))];
    const matched = domainTags
      .map((tag) => ({ tag, score: overlapScore(tokenize(tag), goalTokens) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    if (matched.length) query.tags = matched.slice(0, 3).map((item) => item.tag);
  }
  return query;
}

/** Relevance score for a goal: title 3x, tags 2x, domain 2x, content 1x. */
export function relevanceScore(entry, goal) {
  const tokens = tokenize(goal);
  return (
    overlapScore(tokenize(entry.title), tokens) * 3 +
    overlapScore(tokenize(entry.tags.join(' ')), tokens) * 2 +
    overlapScore(tokenize(entry.domain), tokens) * 2 +
    overlapScore(tokenize(entry.content), tokens)
  );
}

/**
 * Deterministic rerank: order candidates by relevance to the goal first, then
 * trust, then recency — still within the same character budget.
 */
export function retrieveReranked(entries, query, goal, now = Date.now()) {
  const candidates = entries
    .filter((entry) => entryMatches(query, entry, now))
    .sort((a, b) => {
      const delta = relevanceScore(b, goal) - relevanceScore(a, goal);
      if (delta !== 0) return delta;
      return byTrustThenRecency(a, b);
    });
  return applyBudget(candidates, query.maxChars ?? DEFAULT_MAX_CHARS);
}

function applyBudget(sorted, budget) {
  const result = [];
  let used = 0;
  for (const entry of sorted) {
    if (used + entry.content.length > budget && result.length > 0) break;
    result.push(entry);
    used += entry.content.length;
  }
  return result;
}

/** Deterministic tokeniser: letters and digits, longer than one character. */
export function tokenize(text) {
  return (String(text).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => token.length > 1);
}

function overlapScore(left, right) {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length;
}

/**
 * Conflict and supersession metadata for a set of entries, as required by the
 * incubator lab: which entries replace others, which ones share a conflict group,
 * and which claims have no live replacement.
 */
export function conflictReport(entries) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const supersedes = entries
    .filter((entry) => entry.supersedes)
    .map((entry) => ({ id: entry.id, supersedes: entry.supersedes, known: byId.has(entry.supersedes) }));
  const superseded = new Set(entries.map((entry) => entry.supersedes).filter(Boolean));
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.conflictGroup) continue;
    if (!groups.has(entry.conflictGroup)) groups.set(entry.conflictGroup, []);
    groups.get(entry.conflictGroup).push(entry.id);
  }
  const conflicts = [...groups.entries()]
    .map(([group, ids]) => ({ group, ids: ids.sort() }))
    .sort((a, b) => a.group.localeCompare(b.group));
  return {
    supersedes,
    superseded: [...superseded].sort(),
    live: entries.filter((entry) => !superseded.has(entry.id)).map((entry) => entry.id).sort(),
    conflicts,
    danglingSupersedes: supersedes.filter((item) => !item.known).map((item) => item.id),
    conflictingGroups: conflicts.filter((item) => item.ids.length > 1).map((item) => item.group),
  };
}
