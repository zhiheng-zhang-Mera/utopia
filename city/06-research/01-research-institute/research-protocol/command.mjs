/**
 * UTOPIA · Research Institute — structured research command spec.
 *
 * Every research execution is `spawn(executable, args)` with explicit purpose / cwd /
 * timeout / environment — never `shell: true` with a model-generated string.
 * Executables are validated against an allow-list, so a research model can only run
 * tools the workspace authorizes.
 *
 * Ported from the Codex-Boss donor `src/shared/research-command.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. Pure and inert: this module validates
 * and describes a command; it never spawns one, reads the filesystem or touches the
 * environment.
 *
 * Rules that must not be softened:
 *   - the executable must be a bare path/name: the donor's `/\s|[\r\n]/` test is the
 *     whole refusal, and a program that merely is not on the allow-list is still a
 *     VALID spec (`validateCommandSpec` does not call `executableAllowed`);
 *   - the allow-list test strips a leading path and a Windows `.exe`/`.cmd`/`.bat`
 *     suffix, then compares lower-cased.
 */

import { ALLOWED_EXECUTABLES, researchCommandSpec } from './contracts.mjs';

export { ALLOWED_EXECUTABLES, RESEARCH_PURPOSES, researchCommandSpec } from './contracts.mjs';

/** Executable families a research run may spawn (base names). */
const ALLOWED = new Set(ALLOWED_EXECUTABLES);

/**
 * Validate a research command spec. The single gate: every refusal carries the
 * donor's exact message.
 *
 * @throws {Error} see `researchCommandSpec` (contracts.mjs)
 */
export function validateCommandSpec(spec) {
  researchCommandSpec(spec);
}

/** True when the executable basename is in the allow-list (Windows tolerates .exe). */
export function executableAllowed(executable) {
  const base = executable.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '');
  return ALLOWED.has(base.toLocaleLowerCase());
}
