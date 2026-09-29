/**
 * UTOPIA · Rooms · Skill Discovery Lab — skill catalog.
 *
 * Ported from the HNS donor `app/extensions/mega/skills/skill-catalog.js`
 * (zhiheng-zhang-Mera/DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b).
 *
 * Two sources, deliberately separate:
 *
 *   curated   a small reviewed list that always resolves to a real GitHub
 *             location, so the offline baseline is a first-class feature rather
 *             than a fallback;
 *   live      an optional GitHub Code Search for `filename:SKILL.md`, which is
 *             strictly additive: a failure is reported as "failed" and the
 *             curated results stand.
 *
 * Port differences: CommonJS -> ESM; the live search takes an injectable
 * `fetchJson`; the donor's `renderBundledSkill` stays here as
 * `renderCatalogSkill` so a bundled entry can be previewed without a second
 * SKILL.md renderer existing anywhere else.
 */

import { parseSkillText, renderSkillDocument } from './format-bridge.mjs';

export const GITHUB_API = 'https://api.github.com';
export const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Curated sources. Each entry points at a repository (or a subtree of one) and
 * describes the collection; a resolver expands it into individual skills.
 * `name`/`summary`/`tags` are for search only — the skill's own frontmatter is
 * always authoritative.
 */
export const CURATED_COLLECTIONS = [
  {
    id: 'anthropic-skills',
    name: 'Anthropic Agent Skills',
    owner: 'anthropics',
    repo: 'skills',
    subpath: 'skills',
    summary: 'Official Agent Skills collection: document handling (docx/pdf/pptx/xlsx), art and design, skill authoring rules.',
    tags: ['official', 'documents', 'design', 'writing', 'collection'],
    locale: 'en',
  },
  {
    id: 'anthropic-skills-public',
    name: 'Anthropic Skills (repository root)',
    owner: 'anthropics',
    repo: 'skills',
    subpath: null,
    summary: 'The same repository viewed from its root, so the collection still resolves after a layout change.',
    tags: ['official', 'fallback', 'collection'],
    locale: 'en',
    alternate: true,
  },
];

/**
 * Bundled starter skills: written locally, previewable with no network at all.
 * They are catalog entries with a body, not installed skills.
 */
export const BUNDLED_SKILLS = [
  {
    id: 'bundled-commit-message',
    name: 'commit-message',
    summary: 'Write a commit message in the repository\u2019s existing style: read recent log, summarise the diff, output one ready-to-use message.',
    tags: ['git', 'workflow', 'offline'],
    category: 'engineering',
    body: [
      'Read the repository\'s recent commit history before writing anything, so the new message matches the',
      'project\'s existing voice and structure.',
      '',
      '1. `git log --oneline -20` to learn the conventions in use (prefixes, tense, language).',
      '2. `git status` and `git diff --stat` to see what actually changed.',
      '3. Summarise the change in one subject line under 72 characters, then add a body only when the "why" is',
      '   not obvious from the subject.',
      '',
      'Never invent a change that is not in the diff. Never mention files that were not touched.',
    ].join('\n'),
  },
  {
    id: 'bundled-code-review',
    name: 'code-review',
    summary: 'Review a change structurally: correctness, boundaries, failure paths, readability — ordered by severity with actionable advice.',
    tags: ['review', 'quality', 'offline'],
    category: 'engineering',
    body: [
      'Review the change, not the author. Report findings ordered by severity and make every finding actionable.',
      '',
      '- **Correctness** — does it do what it claims? Are there off-by-one, null, empty-collection or encoding',
      '  cases? Does it handle concurrent access where that is possible?',
      '- **Failure paths** — what happens on error, timeout, partial write or malformed input? Is anything',
      '  swallowed silently?',
      '- **Readability** — could a new maintainer follow it? Are names accurate? Is the comment explaining the',
      '  "why" rather than restating the code?',
      '- **Tests** — is the new behaviour covered, including the case the fix was written for?',
      '',
      'State explicitly when you found nothing in a category; do not pad the review.',
    ].join('\n'),
  },
  {
    id: 'bundled-repo-tour',
    name: 'repo-tour',
    summary: 'Orient yourself in an unfamiliar repository: entry points, build, tests, directory responsibilities and a checklist to execute.',
    tags: ['onboarding', 'navigation', 'offline'],
    category: 'engineering',
    body: [
      'Orient yourself in an unfamiliar repository before changing anything.',
      '',
      '1. Find the entry points: package manifest, build scripts, test command, and the top-level entry file.',
      '2. Read the README and any contribution guide; note the conventions they state.',
      '3. Map the directory tree to responsibilities — one line per top-level directory.',
      '4. Identify the test command and run it once to see the baseline state.',
      '5. Note what you could not determine, and what would have to be true for it to matter.',
      '',
      'Produce the result as a short checklist a new contributor can execute top to bottom.',
    ].join('\n'),
  },
  {
    id: 'bundled-skill-author',
    name: 'skill-author',
    summary: 'Author or review a SKILL.md: name grammar, required frontmatter, whenToUse, invocation flags and a body that is instructions rather than payload.',
    tags: ['skills', 'writing', 'offline'],
    category: 'engineering',
    body: [
      'A skill is instructions, not a payload. Keep the document small and specific.',
      '',
      '1. `name` must be lowercase kebab-case and match the directory or file name.',
      '2. `description` must say what the skill does in one sentence — it is what a reader sees first.',
      '3. Add `whenToUse` when the trigger is not obvious from the description.',
      '4. Use `disable-model-invocation` or `user-invocable` only when a surface really must be closed.',
      '5. The body is the procedure: numbered steps, each one executable, with no invented commands.',
      '',
      'Validate the result before sharing it; a skill that does not parse is a skill nobody can load.',
    ].join('\n'),
  },
];

/**
 * Build a catalog over the curated and bundled entries.
 * @param {{fetchJson?: Function|null, searchLimit?: number, log?: Function}} [options]
 */
export function createCatalog({ fetchJson = null, searchLimit = DEFAULT_SEARCH_LIMIT, log = () => {} } = {}) {
  const curated = CURATED_COLLECTIONS.map((entry) => ({ ...entry, origin: 'curated', installable: true }));
  const bundled = BUNDLED_SKILLS.map((entry) => ({
    ...entry,
    origin: 'bundled',
    installable: true,
    install: { kind: 'bundled', id: entry.id },
  }));

  /** Every entry the UI can show with no network access. */
  function offlineEntries() {
    return [...bundled, ...curated];
  }

  function score(entry, terms) {
    if (!terms.length) return 1;
    const haystack = [entry.name, entry.summary, entry.repo, entry.owner, ...(entry.tags || []), entry.category]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    let total = 0;
    for (const term of terms) {
      if (!haystack.includes(term)) return 0;
      // A name or tag hit is worth more than a summary hit.
      if (String(entry.name).toLowerCase().includes(term)) total += 3;
      else if ((entry.tags || []).some((tag) => tag.toLowerCase().includes(term))) total += 2;
      else total += 1;
    }
    return total;
  }

  /**
   * Search the catalog.
   * @param {{query?: string, includeLive?: boolean, tags?: string[]}} [options]
   */
  async function search({ query = '', includeLive = false, tags = [] } = {}) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const required = (tags || []).map((tag) => String(tag).toLowerCase());
    const filter = (entry) => required.every((tag) => (entry.tags || []).map((item) => item.toLowerCase()).includes(tag));

    const local = offlineEntries()
      .filter(filter)
      .map((entry) => ({ entry, rank: score(entry, terms) }))
      .filter((item) => item.rank > 0)
      .sort((a, b) => b.rank - a.rank || a.entry.name.localeCompare(b.entry.name))
      .map((item) => item.entry);

    const result = {
      ok: true,
      query: String(query || ''),
      offline: { entries: local, total: local.length },
      live: null,
      liveStatus: includeLive ? 'skipped' : 'not-requested',
      notices: [],
    };

    if (!includeLive) return result;

    if (typeof fetchJson !== 'function') {
      result.liveStatus = 'unavailable';
      result.notices.push('no GitHub access configured; showing bundled and curated sources only');
      return result;
    }

    try {
      const entries = await liveSearch({ query: String(query || ''), limit: searchLimit });
      result.live = entries;
      result.liveStatus = 'ok';
      if (entries.length === 0) result.notices.push('GitHub returned no SKILL.md results');
    } catch (error) {
      // A live search failure is informational: the curated list still answers.
      result.liveStatus = 'failed';
      result.notices.push(`GitHub search unavailable: ${String(error?.message || error)}`);
      log(`skill catalog live search failed: ${error?.message || error}`);
    }
    return result;
  }

  /** GitHub Code Search for `filename:SKILL.md`, one entry per repository hit. */
  async function liveSearch({ query = '', limit = DEFAULT_SEARCH_LIMIT } = {}) {
    const terms = query.trim() ? `${query.trim()} filename:SKILL.md` : 'filename:SKILL.md';
    const params = new URLSearchParams({ q: terms, per_page: String(Math.min(50, Math.max(1, limit))) });
    const payload = await fetchJson(`${GITHUB_API}/search/code?${params.toString()}`);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const seen = new Set();
    const entries = [];
    for (const item of items) {
      const repository = item?.repository || {};
      const owner = repository.owner?.login;
      const repo = repository.name;
      if (!owner || !repo) continue;
      const key = `${owner}/${repo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const filePath = String(item.path || '');
      const subpath = filePath.replace(/\/?SKILL\.md$/i, '') || null;
      entries.push({
        id: `live-${owner}-${repo}`,
        name: repo,
        owner,
        repo,
        subpath,
        summary: repository.description || `SKILL.md on GitHub: ${owner}/${repo}`,
        tags: ['github', 'search'],
        origin: 'live',
        installable: true,
        stars: Number(repository.stargazers_count) || 0,
        updatedAt: repository.updated_at || null,
        url: repository.html_url || `https://github.com/${owner}/${repo}`,
      });
    }
    return entries;
  }

  /** Look up one curated or bundled entry by id. */
  function get(id) {
    return offlineEntries().find((entry) => entry.id === id) || null;
  }

  /** Tags present in the offline catalog, for filter chips. */
  function tags() {
    const counts = new Map();
    for (const entry of offlineEntries()) {
      for (const tag of entry.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  return { search, liveSearch, get, tags, offlineEntries, CURATED_COLLECTIONS, BUNDLED_SKILLS: bundled };
}

/** Render a bundled catalog entry as a `SKILL.md` document (preview only). */
export function renderCatalogSkill(entry) {
  if (!entry || typeof entry.name !== 'string') return null;
  const document = renderSkillDocument({
    name: entry.name,
    description: entry.summary,
    whenToUse: `use when the task involves ${entry.category || 'this area'}`,
    metadata: { source: 'utopia bundled skill catalog', category: entry.category || 'general', tags: (entry.tags || []).join(', ') },
    body: entry.body,
  });
  // A bundled entry that does not validate is not offered at all.
  return parseSkillText(document).ok ? document : null;
}
