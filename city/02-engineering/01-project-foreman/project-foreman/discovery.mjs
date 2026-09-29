/**
 * UTOPIA · City · Project Foreman — project discovery.
 *
 * Discovery answers three questions before any code is touched:
 *
 *   what kind of project is this?      (adapters)
 *   what does *this* project require?  (instruction precedence)
 *   what command does each operation run, and how sure are we? (the command table)
 *
 * The precedence is not negotiable:
 *
 *   Execution Contract  >  repository instructions  >  project configuration  >  runtime defaults
 *
 * A contract that names `npm test` wins over a `Makefile` that says `make check`.
 * A repository that says "run `scripts/verify.ps1` before committing" is read
 * before the runtime's own convention. Where a command is *inferred* rather than
 * declared, the inference and its evidence are both recorded, because an inferred
 * command the runtime cannot explain is a command nobody can trust.
 *
 * Donor provenance: DS-Hns `app/engineering/discovery.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b, ported from CommonJS to ESM.
 *
 * Two seams are injected rather than imported, which is what keeps this module
 * testable without a repository on disk: the adapter set (`options.adapters`) and
 * the repository snapshot reader (`options.snapshot`). When the caller supplies
 * neither, the module falls back to its own filesystem-backed reader — see
 * `repository.mjs` and `adapters.mjs` for those, which live beside this file.
 *
 * @module project-foreman/discovery
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

/**
 * The operation vocabulary, taken from the adapter module when it is present.
 *
 * The vocabulary is the closed list of operations a plan step may attach, so it
 * is published here as a constant as well as by `adapters.mjs`: `plan.mjs` needs
 * it to validate a step, and the operation list is part of the plan contract, not
 * of any particular ecosystem adapter. The fallback below is the donor's own list
 * (DS-Hns `app/engineering/adapters/index.cjs`), verified equal to the adapter
 * module's export when that module is importable.
 */
export const OPERATIONS = Object.freeze(['install', 'build', 'test', 'focusedTest', 'lint', 'format', 'typecheck', 'package', 'run']);

/** How confident the runtime is in a discovered command. */
export const CONFIDENCE = Object.freeze({
  DECLARED: 'declared',
  CONVENTION: 'convention',
  INFERRED: 'inferred',
});

const require = createRequire(import.meta.url);

/**
 * Load the adapter module, or `null` when this tree does not carry one yet.
 *
 * The loader is deliberately lazy and total: `plan.mjs` imports this module for
 * its operation vocabulary alone, so a missing adapter set must not be able to
 * make the step vocabulary unimportable. A caller that asks for detection with no
 * adapters available gets the same empty detection list the donor produces when
 * every adapter abstains — not an invented project type.
 */
function loadAdapters() {
  try {
    return require('./adapters.mjs');
  } catch {
    return null;
  }
}

/** The adapter set to ask: the caller's, or the tree's, or none. */
function adaptersFor(options = {}) {
  if (Array.isArray(options.adapters) && options.adapters.length) return options.adapters;
  const module = loadAdapters();
  if (module && typeof module.defaultAdapters === 'function') {
    try {
      const list = module.defaultAdapters();
      if (Array.isArray(list) && list.length) return list;
    } catch {
      // An adapter set that cannot even be built is an empty adapter set.
    }
  }
  return [];
}

/**
 * The repository snapshot reader.
 *
 * `repository.mjs` lives beside this file; when it is absent the module reports
 * that it cannot read a repository rather than pretending it read an empty one.
 */
function loadRepository() {
  try {
    return require('./repository.mjs');
  } catch {
    return null;
  }
}

/** Read the repository's instruction files, or refuse honestly. */
function repositorySnapshot(input) {
  const repository = loadRepository();
  if (!repository || typeof repository.snapshot !== 'function') {
    throw new Error('repository discovery is unavailable: repository.mjs is not present in this module');
  }
  return repository.snapshot(input);
}

/** The instruction file names the runtime is required to have read. */
function instructionFiles() {
  const repository = loadRepository();
  return Array.isArray(repository?.INSTRUCTION_FILES) ? repository.INSTRUCTION_FILES : [];
}

/**
 * Detect the project type.
 *
 * Every adapter is asked, the best score wins, and the runner-up is kept so the
 * record shows what else the repository looked like.
 *
 * @param {string} root
 * @param {object} [options]
 * @param {object[]} [options.adapters]
 * @returns {{adapter: object, id: string, language: string, evidence: unknown, others: object[]}}
 */
export function detectProject(root, options = {}) {
  const adapters = adaptersFor(options);
  const detections = [];
  for (const adapter of adapters) {
    let result = null;
    try {
      result = adapter.detect(root);
    } catch {
      // An adapter that throws is an adapter that found nothing. It must not be
      // able to stop the others from being asked.
      result = null;
    }
    if (result) detections.push({ id: adapter.id, score: result.score, evidence: result.evidence, adapter, language: adapter.language });
  }
  detections.sort((a, b) => b.score - a.score);
  const best = detections[0] || { id: 'generic', language: 'unknown', evidence: 'nothing to detect', adapter: adapters[adapters.length - 1] ?? null };
  return {
    id: best.id,
    language: best.language,
    evidence: best.evidence,
    adapter: best.adapter,
    // The runner-up is context, not a fallback: the runtime does not switch
    // adapters mid-episode because a command failed.
    others: detections.slice(1).map((entry) => ({ id: entry.id, score: entry.score, evidence: entry.evidence })),
  };
}

/**
 * The precedence of repository instruction files.
 *
 * Lower wins. Anything under `docs/` is read after the root files, and anything
 * else last, so a repository cannot promote an arbitrary file above `AGENTS.md`.
 */
export const INSTRUCTION_PRIORITY = Object.freeze({
  'AGENTS.md': 1,
  'CLAUDE.md': 2,
  'CONTRIBUTING.md': 3,
  'README.md': 4,
  README: 4,
  'CODE_OF_CONDUCT.md': 5,
});

/**
 * Read the repository's engineering instructions, in precedence order.
 *
 * Each entry keeps the snapshot's own bounded excerpt: the runtime's context is
 * not a place to paste a repository.
 */
export function discoverInstructions(root, snapshot = null) {
  const source = snapshot || repositorySnapshot({ root });
  return source.instructions
    .map((entry) => ({ ...entry, priority: INSTRUCTION_PRIORITY[entry.file] || (entry.file.startsWith('docs/') ? 6 : 7) }))
    .sort((a, b) => a.priority - b.priority || a.file.localeCompare(b.file))
    .map((entry) => ({ ...entry, kind: 'repository-instruction', source: 'repository' }));
}

/** Normalize a command into the one shape the supervisor executes. */
export function normalizeCommand(input, operation, origin) {
  if (typeof input === 'string') {
    return {
      operation,
      command: input,
      cwd: null,
      acceptsFocus: operation === 'focusedTest',
      longRunning: false,
      confidence: origin === 'contract' ? CONFIDENCE.DECLARED : CONFIDENCE.CONVENTION,
      evidence: `${origin} declares ${operation}`,
      origin,
    };
  }
  return {
    operation,
    command: String(input.command || ''),
    cwd: input.cwd ? String(input.cwd) : null,
    acceptsFocus: input.acceptsFocus === true,
    longRunning: input.longRunning === true,
    confidence: origin === 'contract' ? CONFIDENCE.DECLARED : input.confidence || CONFIDENCE.DECLARED,
    evidence: input.evidence || `${origin} declares ${operation}`,
    origin,
  };
}

/**
 * Build the command table for one repository.
 *
 * @param {object} input
 * @param {string} input.root
 * @param {object} [input.project] output of `detectProject`
 * @param {object} [input.contract] the execution contract's `engineering` block
 * @returns {{operations: object, sources: object, project: object, adapterId: string}}
 */
export function discoverCommands(input = {}) {
  const root = input.root;
  const project = input.project || detectProject(root);
  let adapterCommands = {};
  try {
    adapterCommands = project.adapter.commands(root) || {};
  } catch {
    adapterCommands = {};
  }
  const declared = input.contract && typeof input.contract === 'object' ? input.contract : {};
  const operations = {};
  const sources = {};
  for (const name of OPERATIONS) {
    const fromContract = declared[name];
    if (fromContract) {
      operations[name] = normalizeCommand(fromContract, name, 'contract');
      sources[name] = 'contract';
      continue;
    }
    const fromAdapter = adapterCommands[name];
    if (fromAdapter) {
      operations[name] = normalizeCommand(fromAdapter, name, 'project');
      sources[name] = fromAdapter.confidence || CONFIDENCE.DECLARED;
    }
  }
  return {
    project: { id: project.id, language: project.language, evidence: project.evidence, others: project.others },
    operations,
    sources,
    /** The adapter's own id, for the episode record. */
    adapterId: project.id,
  };
}

/**
 * Full discovery: the repository snapshot, the project, the instructions and the
 * command table, in one object the episode carries.
 */
export function discover(root, options = {}) {
  const snapshot = options.snapshot || repositorySnapshot({ root, now: options.now });
  const project = detectProject(root, options);
  const commands = discoverCommands({
    root,
    project,
    contract: options.contract ? options.contract.commands || options.contract : null,
  });
  return {
    root,
    snapshot,
    project: commands.project,
    instructions: discoverInstructions(root, snapshot),
    commands: commands.operations,
    commandSources: commands.sources,
    /** Every command the repository declares, whether or not the loop needs it. */
    ci: snapshot.ci,
    packageScripts: snapshot.packageScripts,
    /** Where the evidence for each command came from, for the record. */
    evidence: {
      project: project.evidence,
      otherProjects: project.others,
      manifests: snapshot.manifests,
      instructions: snapshot.instructions.map((entry) => entry.file),
      ci: snapshot.ci,
    },
  };
}

/** The instruction files the runtime is required to have read, for the record. */
export function requiredInstructions(root) {
  return instructionFiles().filter((name) => fs.existsSync(path.join(root, name)));
}
