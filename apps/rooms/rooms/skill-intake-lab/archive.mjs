/**
 * UTOPIA · Rooms · Skill Intake Lab — minimal dependency-free tar reader.
 *
 * Ported from the HNS donor `app/extensions/mega/skills/tar.js`
 * (zhiheng-zhang-Mera/DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b).
 *
 * Safety is the point of this module, not convenience:
 *   - every entry path is normalized and refused if it escapes the destination;
 *   - absolute paths and `..` segments are rejected outright;
 *   - symlinks, hardlinks and device nodes are never materialized;
 *   - total extracted bytes and entry count are capped.
 *
 * Port differences: CommonJS -> ESM. The incubator room does not install skills,
 * so `extractTar` is intentionally not carried over — entries are inspected in
 * memory and never written, which removes the filesystem from this module's job.
 */

import zlib from 'node:zlib';

export const BLOCK_SIZE = 512;
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 4096;

/** Read the NUL-terminated string field at `offset`. */
export function readString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8').trim();
}

/** Read a NUL/space-terminated octal field. */
export function readOctal(buffer, offset, length) {
  const text = readString(buffer, offset, length).replace(/\0/g, '').trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/** Verify the tar header checksum, returning it when valid. */
export function readChecksum(block) {
  const stored = readOctal(block, 148, 8);
  if (!stored) return null;
  let sum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : block[index];
  }
  return sum === stored ? stored : null;
}

function isHeaderBlock(block) {
  if (block.length < BLOCK_SIZE) return false;
  return readChecksum(block) !== null;
}

function isZeroBlock(block) {
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    if (block[index] !== 0) return false;
  }
  return true;
}

const TYPE_FILE = new Set(['0', '\0', '', '7']);
const TYPE_DIRECTORY = new Set(['5']);
const TYPE_PAX = new Set(['x', 'g']);
const TYPE_LONG_NAME = new Set(['L']);
const TYPE_UNSUPPORTED = new Set(['1', '2', '3', '4', '6']);

/** Decompress a gzip buffer, tolerating an already-uncompressed tar. */
export function maybeGunzip(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return zlib.gunzipSync(buffer);
  }
  return buffer;
}

/** Normalize an archive entry path; returns null when it must be refused. */
export function safeRelativePath(raw) {
  let text = String(raw || '').replace(/\\/g, '/');
  text = text.replace(/^\.\//, '');
  if (!text) return null;
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) return null;
  const segments = [];
  for (const segment of text.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  if (!segments.length) return null;
  return segments.join('/');
}

/** Parse a pax extended header record set. */
export function parsePax(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const match = line.match(/^(\d+) ([^=]+)=(.*)$/);
    if (match) out[match[2]] = match[3];
  }
  return { path: out.path || null, linkpath: out.linkpath || null };
}

/**
 * Iterate the entries of a tar buffer.
 * @returns {Array<{path: string, type: 'file'|'directory'|'unsupported'|'other', mode: number, size: number, data: Buffer, linkName: string|null}>}
 */
export function readEntries(buffer, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const entries = [];
  let offset = 0;
  let longName = null;
  let paxPath = null;

  while (offset + BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK_SIZE);
    if (isZeroBlock(header)) break;
    if (!isHeaderBlock(header)) throw new Error(`unsupported tar structure at byte ${offset}`);
    const typeFlag = String.fromCharCode(header[156]) || '0';
    const size = readOctal(header, 124, 12);
    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (size < 0 || dataEnd > buffer.length) throw new Error('truncated tar entry');
    const data = buffer.subarray(dataStart, dataEnd);

    if (TYPE_LONG_NAME.has(typeFlag)) {
      longName = data.subarray(0, Math.max(0, data.indexOf(0) === -1 ? data.length : data.indexOf(0))).toString('utf8');
      offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
      continue;
    }
    if (TYPE_PAX.has(typeFlag)) {
      const parsed = parsePax(data.toString('utf8'));
      if (parsed.path) paxPath = parsed.path;
      offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
      continue;
    }

    const rawName = paxPath || longName || readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${rawName}` : rawName;
    longName = null;
    paxPath = null;

    const normalized = safeRelativePath(fullName);
    if (normalized) {
      entries.push({
        path: normalized,
        type: TYPE_DIRECTORY.has(typeFlag) ? 'directory' : TYPE_FILE.has(typeFlag) ? 'file' : TYPE_UNSUPPORTED.has(typeFlag) ? 'unsupported' : 'other',
        mode: readOctal(header, 100, 8) & 0o777,
        size,
        data: dataStart < dataEnd ? Buffer.from(data) : Buffer.alloc(0),
        linkName: readString(header, 157, 100) || null,
      });
    }
    offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (entries.length > maxEntries) throw new Error(`tar archive exceeds ${maxEntries} entries`);
  }
  return entries;
}

/** List an archive's entry paths without touching the filesystem. */
export function listEntries(buffer, options) {
  return readEntries(maybeGunzip(buffer), options).map((entry) => ({ path: entry.path, type: entry.type, size: entry.size }));
}

/**
 * Inspect an archive: what it contains, what would be refused, and whether a
 * `SKILL.md` document inside it is acceptable. Nothing is extracted or written.
 *
 * @param {object} options
 * @param {Buffer} options.buffer
 * @param {number} [options.stripComponents=0]
 * @param {number} [options.maxBytes]
 * @param {(relativePath: string) => boolean} [options.select]
 * @param {(text: string) => object} [options.parseDocument]  injectable for tests
 */
export function inspectArchive({
  buffer,
  stripComponents = 0,
  maxBytes = DEFAULT_MAX_BYTES,
  select = null,
  parseDocument = null,
} = {}) {
  const tar = maybeGunzip(buffer);
  const entries = readEntries(tar);
  const accepted = [];
  const refused = [];
  let totalBytes = 0;
  let skillDocumentPath = null;
  let skillResult = null;

  const atCap = (size) => {
    const next = totalBytes + size;
    if (next > maxBytes) throw new Error(`archive exceeds ${Math.round(maxBytes / 1024 / 1024)} MB`);
    totalBytes = next;
  };

  for (const entry of entries) {
    const relative = entry.path.split('/').slice(stripComponents).join('/');
    if (!relative) continue;
    if (entry.type === 'unsupported') {
      refused.push({ path: entry.path, reason: 'unsupported entry type (link or device)' });
      continue;
    }
    if (select && !select(relative, entry)) continue;
    if (entry.type === 'directory') {
      accepted.push({ path: relative, type: 'directory', size: 0 });
      continue;
    }
    atCap(entry.size);
    accepted.push({ path: relative, type: entry.type, size: entry.size });
    if (!skillDocumentPath && /(^|\/)SKILL\.md$/i.test(relative)) {
      skillDocumentPath = relative;
      skillResult = parseDocument ? parseDocument(entry.data.toString('utf8')) : null;
    }
  }

  return {
    entries: entries.length,
    accepted,
    refused,
    acceptedCount: accepted.length,
    refusedCount: refused.length,
    fileCount: accepted.filter((item) => item.type === 'file').length,
    directoryCount: accepted.filter((item) => item.type === 'directory').length,
    bytes: totalBytes,
    skillDocumentPath,
    skill: skillResult,
  };
}
