/**
 * UTOPIA · City · Skill Intake — skill source format.
 *
 * Ported from the HNS donor `app/extensions/mega/skills/skill-format.js`
 * (zhiheng-zhang-Mera/DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b).
 * The parser semantics are kept identical on purpose: a skill the intake accepts
 * must be one the harness would actually load, and anything it rejects must be
 * something the harness would silently skip.
 *
 * What changed in the port:
 * - CommonJS -> ESM, and the filesystem helpers (`readSkillFile`, `scanSkillRoot`,
 *   `resolveInstalled`) were dropped: this module is a pure text transform with no
 *   disk access and no dependency on the HNS installation directory.
 */

/** The harness's public skill-name grammar. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Directories that are never treated as skills. */
export const RESERVED_DIRS = Object.freeze(['.system', '.git', 'node_modules']);

/** Maximum accepted `SKILL.md` size; a skill is instructions, not a payload. */
export const MAX_SKILL_BYTES = 512 * 1024;

/** YAML boolean forms the harness accepts (case-insensitive). */
export const TRUE_FORMS = new Set(['true', 'yes', 'on', '1']);
export const FALSE_FORMS = new Set(['false', 'no', 'off', '0']);

/** Is this a valid skill name? */
export function isSkillName(value) {
  return typeof value === 'string' && SKILL_NAME.test(value);
}

/** Slug a free-form value into the skill-name grammar. */
export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Split `---` frontmatter from the body.
 * A file without a leading `---` block is not a skill, and an unterminated block
 * is a parse failure rather than a guess.
 * @returns {{data: Record<string, unknown>, body: string}|null}
 */
export function parseFrontmatter(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return null;
  return { data: parseSimpleYaml(match[1]), body: text.slice(match[0].length) };
}

/**
 * Parse the small YAML subset a skill frontmatter uses: `key: value` pairs with
 * optional quoting, plus one level of nested maps (`metadata:`).
 */
export function parseSimpleYaml(text) {
  const data = {};
  let currentKey = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.match(/^ */)[0].length;
    const line = rawLine.trim();
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value === '') {
      currentKey = indent === 0 ? key : currentKey;
      if (indent === 0 && !(key in data)) data[key] = {};
      continue;
    }
    value = unquote(value);
    if (!/^['"]/.test(line.slice(separator + 1).trim()) && value.includes(' #')) {
      value = value.slice(0, value.indexOf(' #')).trim();
    }
    if (indent > 0 && currentKey && typeof data[currentKey] === 'object' && data[currentKey] !== null) {
      data[currentKey][key] = value;
      continue;
    }
    data[key] = value;
  }
  return data;
}

function unquote(value) {
  const text = String(value);
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = text.slice(1, -1);
      return first === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n') : inner.replace(/''/g, "'");
    }
  }
  return text;
}

/** Read an optional boolean frontmatter key. */
export function parseBooleanField(data, key) {
  if (!(key in data)) return { ok: true, value: undefined };
  const raw = data[key];
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  const text = String(raw).trim().toLowerCase();
  if (TRUE_FORMS.has(text)) return { ok: true, value: true };
  if (FALSE_FORMS.has(text)) return { ok: true, value: false };
  return { ok: false, reason: `"${key}" must be a boolean, got ${JSON.stringify(raw)}` };
}

/** Validate parsed frontmatter against the harness's rules. */
export function validateFrontmatter(data) {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'missing YAML frontmatter' };
  const name = typeof data.name === 'string' ? data.name.trim() : undefined;
  const description = typeof data.description === 'string' ? data.description.trim() : undefined;
  if (!name) return { ok: false, reason: 'frontmatter requires "name"' };
  if (!description) return { ok: false, reason: 'frontmatter requires "description"' };
  if (!isSkillName(name)) {
    return { ok: false, reason: `invalid skill name "${name}": use lowercase kebab-case (a-z, 0-9, single dashes)` };
  }
  const modelInvocation = parseBooleanField(data, 'disable-model-invocation');
  if (!modelInvocation.ok) return { ok: false, reason: modelInvocation.reason };
  const userInvocation = parseBooleanField(data, 'user-invocable');
  if (!userInvocation.ok) return { ok: false, reason: userInvocation.reason };

  return {
    ok: true,
    skill: {
      name,
      description,
      whenToUse: typeof data.whenToUse === 'string' ? data.whenToUse.trim() : null,
      metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
      modelInvocable: modelInvocation.value === undefined ? true : !modelInvocation.value,
      userInvocable: userInvocation.value === undefined ? true : userInvocation.value,
    },
  };
}

/** Parse a skill document's text into a validated record. */
export function parseSkillText(raw) {
  const text = String(raw ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_BYTES) {
    return { ok: false, reason: `file exceeds ${Math.round(MAX_SKILL_BYTES / 1024)} KB` };
  }
  let parsed = null;
  try {
    parsed = parseFrontmatter(text);
  } catch (error) {
    return { ok: false, reason: `invalid YAML frontmatter: ${error?.message || error}` };
  }
  if (!parsed) return { ok: false, reason: 'missing YAML frontmatter' };
  const validated = validateFrontmatter(parsed.data);
  if (!validated.ok) return validated;
  return { ok: true, skill: { ...validated.skill, body: String(parsed.body || '').trim() } };
}

/** Serialize a record back into a `SKILL.md` document. */
export function renderSkillDocument({ name, description, whenToUse = null, metadata = {}, modelInvocable = true, userInvocable = true, body = '' }) {
  const lines = ['---', `name: ${name}`, `description: ${quoteYaml(description)}`];
  if (whenToUse) lines.push(`whenToUse: ${quoteYaml(whenToUse)}`);
  const keys = Object.keys(metadata || {});
  if (keys.length) {
    lines.push('metadata:');
    for (const key of keys) lines.push(`  ${key}: ${quoteYaml(String(metadata[key]))}`);
  }
  if (modelInvocable === false) lines.push('disable-model-invocation: true');
  if (userInvocable === false) lines.push('user-invocable: false');
  lines.push('---', '', String(body || '').trim(), '');
  return lines.join('\n');
}

/** Quote a YAML value whenever it could be misread as structure or a comment. */
export function quoteYaml(value) {
  const text = String(value ?? '');
  if (/^[\w][\w .,:;/()+-]*$/.test(text) && !text.includes(' #') && !text.endsWith(':')) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/**
 * Pick a skill name for an incoming source, preferring the source's own
 * frontmatter name so the skill is addressable the way the harness resolves it.
 */
export function chooseName({ frontmatterName = null, dirName = null, explicit = null } = {}) {
  for (const candidate of [explicit, frontmatterName, dirName]) {
    if (candidate && isSkillName(candidate)) return candidate;
  }
  const slug = slugify(explicit || frontmatterName || dirName || '');
  return isSkillName(slug) ? slug : null;
}

/**
 * Analyze a pasted or uploaded skill document without installing anything.
 * @returns {{accepted: boolean, skill: object|null, reason: string|null, bytes: number, name: string|null}}
 */
export function analyzeSkillDocument(raw) {
  const text = String(raw ?? '');
  const bytes = Buffer.byteLength(text, 'utf8');
  const parsed = parseSkillText(text);
  if (!parsed.ok) {
    return { accepted: false, skill: null, reason: parsed.reason, bytes, name: null };
  }
  const name = chooseName({
    frontmatterName: parsed.skill.name,
    explicit: null,
    dirName: null,
  });
  if (!name) {
    return { accepted: false, skill: null, reason: 'the document does not yield a valid skill name', bytes, name: null };
  }
  if (name !== parsed.skill.name) {
    return {
      accepted: false,
      skill: null,
      reason: `the document's frontmatter name "${parsed.skill.name}" is not a valid skill name`,
      bytes,
      name: null,
    };
  }
  return { accepted: true, skill: parsed.skill, reason: null, bytes, name };
}
