/**
 * UTOPIA · Research Institute — research manuscript module.
 *
 * One export site for the two donor files this module carries:
 *   - `src/shared/research-figures.ts`    → `./figures.mjs`
 *   - `src/shared/research-manuscript.ts` → `./manuscript.mjs`
 * both @ 8df428eaa437a409368401e95194e40266b83080, plus the frozen vocabulary and
 * the copy-on-construct shape factories in `./contracts.mjs`.
 *
 * The LaTeX/PDF compiler (`electron/research/manuscript/latex-compiler.ts`) and the
 * Electron manuscript assembler (`electron/research/manuscript/manuscript-
 * assembler.ts`) are deliberately not ported: this module returns document text and
 * value objects only, and never writes, compiles or fetches anything.
 */

export * from './contracts.mjs';
export * from './figures.mjs';
export * from './manuscript.mjs';
