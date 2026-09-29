/**
 * UTOPIA · City · Host Health Station — the decision log.
 *
 * Ported from the donor `dsh-health-scheduler` src/audit/decision-log.js @ 985e2b7;
 * see DONOR.json for the porting ledger. Behaviour is unchanged.
 *
 * The decision log.
 *
 * Two requirements from the design meet here: every action must be explainable
 * afterwards, and the plugin must not become an observability platform. So the
 * log keeps a bounded in-memory ring for the UI plus an optional append-only
 * JSONL file that rotates by size. It stores decisions and provider failures —
 * nothing else, and nothing per-sample.
 *
 * @module host-health-station/audit
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** Current on-disk schema version. */
export const LOG_SCHEMA_VERSION = 1;
/**
 * Bounded, append-only decision log.
 *
 * Writes are best-effort: a full disk or a read-only home must never stop the
 * scheduler from monitoring. Every I/O failure is reported through
 * {@link DecisionLog.lastError} instead of thrown.
 */
export class DecisionLog {
  records = [];
  options;
  sequence = 0;
  failures = 0;
  error = null;
  constructor(options) {
    this.options = options;
  }
  /** Path of the on-disk log, or `null` when memory-only. */
  get path() {
    return this.options.directory === null ? null : join(this.options.directory, 'decisions.jsonl');
  }
  /** Last I/O error, or `null`. */
  get lastError() {
    return this.error;
  }
  /** How many write attempts have failed since the plugin started. */
  get writeFailures() {
    return this.failures;
  }
  /** Next record id; monotonic per scheduler instance. */
  nextId() {
    this.sequence += 1;
    return this.sequence;
  }
  /** Append a record, keeping the in-memory ring bounded. */
  append(record) {
    this.records.push(record);
    const overflow = this.records.length - this.options.maxRecords;
    if (overflow > 0)
      this.records.splice(0, overflow);
    this.persist(record);
  }
  /** Most recent records, newest last. */
  recent(limit = this.options.maxRecords) {
    return limit >= this.records.length ? [...this.records] : this.records.slice(this.records.length - limit);
  }
  /** Oldest retained record, for diagnostics. */
  get size() {
    return this.records.length;
  }
  /** Forget everything in memory. The on-disk log is left alone. */
  clear() {
    this.records.length = 0;
  }
  /**
   * Read the on-disk log back, tolerating a truncated final line.
   *
   * @param limit - maximum records to return, newest last.
   */
  readPersisted(limit = 200) {
    const path = this.path;
    if (path === null || !existsSync(path))
      return [];
    try {
      const lines = readFileSync(path, 'utf8').split('\n');
      const out = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '')
          continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.kind === 'decision' && parsed.schemaVersion === LOG_SCHEMA_VERSION) {
            out.push(parsed.record);
          }
        }
        catch {
          // A half-written trailing line is expected after a hard kill; skip it.
        }
      }
      return out.length > limit ? out.slice(out.length - limit) : out;
    }
    catch (error) {
      this.error = error.message;
      return [];
    }
  }
  persist(record) {
    const path = this.path;
    if (path === null)
      return;
    try {
      const directory = dirname(path);
      if (!existsSync(directory))
        mkdirSync(directory, { recursive: true });
      this.rotateIfNeeded(path);
      const line = { schemaVersion: LOG_SCHEMA_VERSION, kind: 'decision', record };
      appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf8');
      this.error = null;
    }
    catch (error) {
      this.failures += 1;
      this.error = error.message;
    }
  }
  /** Move the log aside once it exceeds the configured size. */
  rotateIfNeeded(path) {
    if (!existsSync(path))
      return;
    const size = statSync(path).size;
    if (size < this.options.maxBytes)
      return;
    const stamp = new Date(this.options.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, '-');
    renameSync(path, `${path}.${stamp}.bak`);
    writeFileSync(path, '', 'utf8');
  }
}
