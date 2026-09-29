/**
 * UTOPIA · Research Institute — deterministic figure rendering.
 *
 * Renders the donor's deterministic SVG bar chart from recorded run metrics: no
 * model, no randomness, and the same input always produces the same bytes, so a
 * figure in a paper is traceable to the exact recorded runs it plots. Chart labels
 * stay bounded and user-controlled text is escaped so the result is valid SVG.
 *
 * Donor: Codex-Boss `src/shared/research-figures.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. Every name, default, bound, colour,
 * coordinate and string in this file is the donor's; nothing is added to the chart.
 *
 * What is deliberately NOT here: the donor's Electron-side manuscript assembler
 * (`electron/research/manuscript/manuscript-assembler.ts`), which writes figure
 * files into `manuscript/figures/`, and the LaTeX/PDF compiler
 * (`electron/research/manuscript/latex-compiler.ts`). This module returns the SVG
 * text; writing it to disk and compiling a document are out of scope.
 */

/** The donor's SVG text escape: the XML-significant characters, and nothing else. */
const SVG_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' };

function escapeSvgText(text) {
  return text.replace(/[<>&"']/g, (char) => SVG_ESCAPES[char]);
}

/**
 * The donor's deterministic SVG bar chart.
 *
 * @param {Array<{label: string, value: number}>} bars recorded metrics, in plot order
 * @param {{title?: string, width?: number, height?: number, yLabel?: string}} [options]
 * @returns {string} the SVG document, ending in a newline
 */
export function metricFigureSvg(bars, options = {}) {
  const width = options.width ?? 480;
  const height = options.height ?? 260;
  const title = (options.title ?? 'Metric').slice(0, 80);
  const yLabel = (options.yLabel ?? '').slice(0, 40);
  const margin = { top: 34, right: 16, bottom: 40, left: 64 };
  const plotW = Math.max(80, width - margin.left - margin.right);
  const plotH = Math.max(60, height - margin.top - margin.bottom);
  const values = bars.map((bar) => (Number.isFinite(bar.value) ? bar.value : 0));
  const max = Math.max(1, ...values);
  const visible = bars.slice(0, 40); // bounded rows
  const slot = plotW / Math.max(1, visible.length);
  const barWidth = Math.max(1, Math.min(48, slot * 0.6));

  const rows = visible
    .map((bar, index) => {
      const barHeight = Math.max(1, (bar.value / max) * plotH);
      const x = margin.left + index * slot + (slot - barWidth) / 2;
      const y = margin.top + plotH - barHeight;
      const label = escapeSvgText((bar.label ?? '').slice(0, 24));
      const value = Number.isFinite(bar.value) ? bar.value.toFixed(3) : 'n/a';
      return [
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="#3d7ea6"/>`,
        `<text x="${(x + barWidth / 2).toFixed(1)}" y="${(margin.top + plotH + 14).toFixed(1)}" font-size="9" text-anchor="middle" fill="#cfd8d0">${label}</text>`,
        `<text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="9" text-anchor="middle" fill="#e6e2c8">${value}</text>`,
      ].join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#141a12"/>`,
    `<text x="${margin.left}" y="20" font-size="13" fill="#e6e2c8">${escapeSvgText(title)}</text>`,
    `<text x="14" y="${(height / 2).toFixed(0)}" font-size="9" fill="#9fb3a2" transform="rotate(-90 14 ${(height / 2).toFixed(0)})" text-anchor="middle">${escapeSvgText(yLabel)}</text>`,
    rows,
    '</svg>',
    '',
  ].join('\n');
}

/**
 * Deterministic SVG figure for a paper figure id (real recorded metrics only).
 *
 * The donor's convenience wrapper: the figure is always named `runs.svg` and the
 * title is the only option it passes through.
 *
 * @param {string} title chart title
 * @param {Array<{label: string, value: number}>} values recorded metrics
 * @returns {{name: string, svg: string}}
 */
export function figureForRuns(title, values) {
  return { name: 'runs.svg', svg: metricFigureSvg(values, { title }) };
}
