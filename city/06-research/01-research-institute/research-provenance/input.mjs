/**
 * UTOPIA · Research Institute — human-defined research input.
 *
 * The 0-touch entry point: a human supplies a falsifiable research question, an
 * authorized workspace and a budget (optionally a hypothesis, constraints, provider
 * policy and reviewers), and this module turns it into the research IR a run starts
 * from. `researchQuestion` is the immutable user anchor — the IR's
 * `researchQuestions[0]` is set from it, and every later stage must preserve it.
 *
 * Naming: ids and folders are derived from the research question — never from
 * timestamps — so artifacts stay stable and readable.
 *
 * Ported from the Codex-Boss donor `src/shared/research-input.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. The donor's
 * `import type { ResearchIR } from "./research-ir"` was a type-only edge and
 * therefore carried no runtime dependency; the IR this module *produces* is
 * declared here as the exact subset assigned below (see `ResearchIRShape`), and
 * nothing is imported from the sibling `research-protocol` module, so the donor set
 * stays three pure files.
 *
 * The donor reads a clock and generates ids:
 *   - `now` is a required parameter here. The donor defaulted it to
 *     `new Date().toISOString()`; a pure module may not read a clock, so the caller
 *     must supply the timestamp. It is written to `createdAt` and `updatedAt`
 *     unchanged.
 *   - the id entropy source is injectable (`hexDigit`). The donor used
 *     `Math.floor(Math.random() * 16)`; the default here is `crypto.randomInt(16)`,
 *     which is uniform over the same 0–15 range, and the loop, the hex length and
 *     the id shape are the donor's.
 */

import { randomInt } from 'node:crypto';
import { validateHumanResearchInput } from './contracts.mjs';

export { PROVIDER_POLICIES, humanResearchInput, validateHumanResearchInput } from './contracts.mjs';

/**
 * The research IR subset this module produces.
 *
 * `humanResearchToIR` is the producer, not a consumer, so there is no boundary to
 * validate against: the shape below is what the donor's object literal assigns, and
 * a caller that wants the full IR contract (the sibling `research-protocol` module's
 * `ResearchIR`) can treat this value as that shape without this module importing it.
 *
 * @typedef {object} ResearchIRShape
 * @property {number} schemaVersion   always 1
 * @property {string} id
 * @property {string} goal            the trimmed research question
 * @property {object} scope
 * @property {string} state           'SCOPING' at start
 * @property {string[]} researchQuestions  `[question]` — the immutable human anchor
 * @property {string[]} hypotheses
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/** One hex digit from the injectable entropy source (uniform over 0–15). */
function randomHexDigit() {
  return randomInt(16).toString(16);
}

/** ASCII folder/id slug from the research question (no timestamps). */
function slugOf(question, maxTokens = 6) {
  const tokens = question.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return (tokens.slice(0, maxTokens).join('-') || 'research').slice(0, 60);
}

/**
 * Run id: `<question-slug>-<random hex>` (never time-based).
 *
 * `entropy` is the donor's parameter (default 6, so 12 hex characters) and
 * `hexDigit` is the injection point for the entropy source.
 *
 * @param {string} question
 * @param {number} [entropy]
 * @param {() => string} [hexDigit]
 * @returns {string}
 */
export function researchIdFor(question, entropy = 6, hexDigit = randomHexDigit) {
  let hex = '';
  for (let index = 0; index < entropy * 2; index += 1) hex += hexDigit();
  return `${slugOf(question)}-${hex}`;
}

/**
 * Builds the research IR a research run starts from.
 *
 * The input is validated first (the donor's exact rules and messages) and the
 * question is trimmed into `goal` and the immutable `researchQuestions[0]`; the
 * declared defaults are the donor's: `reviewers` `['research:auto']`,
 * `providerPolicy` 'AUTO', `autonomy` 'AUTOPILOT', `allowedDomains` `[]`, state
 * 'SCOPING', and `maxRuntimeMinutes` present only when the budget supplied it.
 *
 * @param {object} input   a validated human-defined research input
 * @param {string} now     the timestamp written to createdAt/updatedAt (injected)
 * @param {() => string} [hexDigit]  the id entropy source
 * @returns {ResearchIRShape}
 * @throws {Error} exactly what validateHumanResearchInput throws
 */
export function humanResearchToIR(input, now, hexDigit = randomHexDigit) {
  validateHumanResearchInput(input);
  const question = input.researchQuestion.trim();
  return {
    schemaVersion: 1,
    id: input.id ?? researchIdFor(question, 6, hexDigit),
    goal: question,
    scope: {
      workspace: input.workspace.trim(),
      allowedDomains: [],
      reviewers: input.reviewers ?? ['research:auto'],
      autonomy: 'AUTOPILOT',
      providerPolicy: input.providerPolicy ?? 'AUTO',
      budget: {
        maxSteps: input.budget.maxSteps,
        maxExperiments: input.budget.maxExperiments,
        maxProviderCalls: input.budget.maxProviderCalls,
        ...(input.budget.maxRuntimeMinutes !== undefined ? { maxRuntimeMinutes: input.budget.maxRuntimeMinutes } : {}),
      },
    },
    state: 'SCOPING',
    researchQuestions: [question], // the immutable human anchor
    hypotheses: input.hypothesis ? [input.hypothesis.trim()] : [],
    createdAt: now,
    updatedAt: now,
  };
}
