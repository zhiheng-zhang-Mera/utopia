/**
 * UTOPIA · Rooms — Text Workshop transformations.
 *
 * Pure functions over strings: no I/O, no persistence, no dependencies.
 * The same module is used by the room's HTTP endpoint and its tests.
 */

/** Character count, optionally excluding whitespace. */
export function characterCount(text, { ignoreWhitespace = false } = {}) {
  const value = String(text ?? '');
  return ignoreWhitespace ? value.replace(/\s/g, '').length : [...value].length;
}

/** Word count: whitespace-separated tokens with content. */
export function wordCount(text) {
  const value = String(text ?? '').trim();
  return value ? value.split(/\s+/).length : 0;
}

/** Line count; an empty string has zero lines. */
export function lineCount(text) {
  const value = String(text ?? '');
  return value === '' ? 0 : value.replace(/\r\n?/g, '\n').split('\n').length;
}

/** One-line summary used by the room UI. */
export function summarize(text) {
  return {
    characters: characterCount(text),
    charactersNoWhitespace: characterCount(text, { ignoreWhitespace: true }),
    words: wordCount(text),
    lines: lineCount(text),
  };
}

/** Collapse runs of spaces/tabs and trim each line. */
export function normalizeWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n');
}

/** Remove every line that is empty or whitespace-only. */
export function removeBlankLines(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .join('\n');
}

/** Sort lines ascending, case-insensitively, with a stable original-index tiebreak. */
export function sortLines(text, { descending = false } = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const decorated = lines.map((line, index) => ({ line, index }));
  decorated.sort((a, b) => {
    const left = a.line.toLowerCase();
    const right = b.line.toLowerCase();
    if (left === right) return a.index - b.index;
    return left < right ? -1 : 1;
  });
  if (descending) decorated.reverse();
  return decorated.map((item) => item.line).join('\n');
}

/** Remove duplicate lines, keeping the first occurrence in place. */
export function dedupeLines(text, { caseInsensitive = false } = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const key = caseInsensitive ? line.toLowerCase() : line;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.join('\n');
}

/** Uppercase / lowercase / title-case helpers. */
export function changeCase(text, mode) {
  const value = String(text ?? '');
  if (mode === 'upper') return value.toUpperCase();
  if (mode === 'lower') return value.toLowerCase();
  if (mode === 'title') {
    return value.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  }
  throw new Error(`unsupported case mode ${mode}`);
}

/** Apply a named transformation; unknown operations throw. */
export function applyOperation(text, operation, options = {}) {
  switch (operation) {
    case 'trim':
      return String(text ?? '').trim();
    case 'normalize-whitespace':
      return normalizeWhitespace(text);
    case 'remove-blank-lines':
      return removeBlankLines(text);
    case 'sort-lines':
      return sortLines(text, options);
    case 'dedupe-lines':
      return dedupeLines(text, options);
    case 'upper':
    case 'lower':
    case 'title':
      return changeCase(text, operation);
    default:
      throw new Error(`unsupported operation ${operation}`);
  }
}

/**
 * Line diff for two texts: a compact longest-common-subsequence diff.
 * Returns rows of { type: 'same' | 'added' | 'removed', text }.
 */
export function diffLines(left, right) {
  const a = String(left ?? '').replace(/\r\n?/g, '\n').split('\n');
  const b = String(right ?? '').replace(/\r\n?/g, '\n').split('\n');
  const rows = a.length;
  const cols = b.length;
  const table = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ type: 'removed', text: a[i] });
      i += 1;
    } else {
      out.push({ type: 'added', text: b[j] });
      j += 1;
    }
  }
  while (i < rows) {
    out.push({ type: 'removed', text: a[i] });
    i += 1;
  }
  while (j < cols) {
    out.push({ type: 'added', text: b[j] });
    j += 1;
  }
  return out;
}
