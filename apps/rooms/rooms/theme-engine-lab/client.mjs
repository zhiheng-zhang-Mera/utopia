/**
 * UTOPIA · Rooms · Room 12 — Theme Engine Lab (client).
 * Parse colours, check contrast, build a palette and download a generated PNG.
 * Nothing here is applied to the Alien Web UI.
 */

let kit;
let api;
let dom = {};

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const colorInput = kit.el('input', { type: 'text', id: 'te-color', value: '#2f8f7a' });
  const colorFeedback = kit.el('p', { class: 'feedback', id: 'te-color-feedback' });
  const swatch = kit.el('div', { id: 'te-swatch', style: 'width:100%;height:56px;border-radius:10px;border:1px solid #27333f;margin:6px 0' });
  const colorStats = kit.el('div', { class: 'stat-grid', id: 'te-color-stats' });
  const colorDetail = kit.el('div', { id: 'te-color-detail' });

  const fgInput = kit.el('input', { type: 'text', id: 'te-fg', value: '#ffffff' });
  const bgInput = kit.el('input', { type: 'text', id: 'te-bg', value: '#2f8f7a' });
  const contrastFeedback = kit.el('p', { class: 'feedback', id: 'te-contrast-feedback' });
  const contrastStats = kit.el('div', { class: 'stat-grid', id: 'te-contrast-stats' });

  const stepsInput = kit.el('input', { type: 'text', id: 'te-steps', value: '5' });
  const accentInput = kit.el('input', { type: 'text', id: 'te-accent', value: '#c8eea1' });
  const paletteFeedback = kit.el('p', { class: 'feedback', id: 'te-palette-feedback' });
  const paletteRow = kit.el('div', { class: 'row', id: 'te-palette', style: 'gap:4px' });

  const widthInput = kit.el('input', { type: 'text', id: 'te-width', value: '240' });
  const heightInput = kit.el('input', { type: 'text', id: 'te-height', value: '120' });
  const pngFeedback = kit.el('p', { class: 'feedback', id: 'te-png-feedback' });
  const pngPreview = kit.el('div', { id: 'te-png-preview' });
  const pngStats = kit.el('div', { class: 'stat-grid', id: 'te-png-stats' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Colour' }),
    kit.el('p', { class: 'muted small', text: 'Accepts #rgb, #rrggbb, #rrggbbaa, rgb() and rgba(). Nothing is applied to the Alien Web UI.' }),
    kit.el('label', { for: 'te-color', text: 'Colour' }),
    colorInput,
    kit.el('div', { class: 'row' }, [kit.el('button', { class: 'primary', type: 'button', text: 'Parse', id: 'te-parse' })]),
    colorFeedback,
    swatch,
    colorStats,
    colorDetail,
    kit.el('h2', { class: 'pane-title', style: 'margin-top:16px', text: 'Contrast' }),
    kit.el('div', { class: 'row' }, [
      kit.el('div', { class: 'grow' }, [kit.el('label', { for: 'te-fg', text: 'Foreground' }), fgInput]),
      kit.el('div', { class: 'grow' }, [kit.el('label', { for: 'te-bg', text: 'Background' }), bgInput]),
    ]),
    kit.el('div', { class: 'row' }, [kit.el('button', { class: 'primary', type: 'button', text: 'Measure contrast', id: 'te-contrast' })]),
    contrastFeedback,
    contrastStats,
  ]);

  const right = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Palette' }),
    kit.el('div', { class: 'row' }, [
      kit.el('div', { class: 'grow' }, [kit.el('label', { for: 'te-steps', text: 'Steps (2-9)' }), stepsInput]),
      kit.el('div', { class: 'grow' }, [kit.el('label', { for: 'te-accent', text: 'Accent (optional)' }), accentInput]),
    ]),
    kit.el('div', { class: 'row' }, [kit.el('button', { class: 'primary', type: 'button', text: 'Build palette', id: 'te-palette-build' })]),
    paletteFeedback,
    paletteRow,
    kit.el('h2', { class: 'pane-title', style: 'margin-top:16px', text: 'PNG swatch' }),
    kit.el('div', { class: 'row' }, [
      kit.el('div', { class: 'grow' }, [kit.el('label', { for: 'te-width', text: 'Width' }), widthInput]),
      kit.el('div', { class: 'grow' }, [kit.el('label', { for: 'te-height', text: 'Height' }), heightInput]),
    ]),
    kit.el('div', { class: 'row' }, [
      kit.el('button', { class: 'primary', type: 'button', text: 'Encode PNG', id: 'te-png' }),
      kit.el('button', { type: 'button', text: 'Download PNG', id: 'te-download' }),
    ]),
    pngFeedback,
    pngStats,
    pngPreview,
  ]);

  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));
  dom = { colorInput, colorFeedback, swatch, colorStats, colorDetail, fgInput, bgInput, contrastFeedback, contrastStats, stepsInput, accentInput, paletteFeedback, paletteRow, widthInput, heightInput, pngFeedback, pngPreview, pngStats };

  dom.lastPng = null;
  dom.paletteColors = [];

  document.getElementById('te-parse').addEventListener('click', parseCurrent);
  document.getElementById('te-contrast').addEventListener('click', measureContrast);
  document.getElementById('te-palette-build').addEventListener('click', buildPalette);
  document.getElementById('te-png').addEventListener('click', encodeSwatch);
  document.getElementById('te-download').addEventListener('click', () => {
    if (!dom.lastPng) {
      kit.createFeedback(dom.pngFeedback).set('encode a swatch first', 'warn');
      return;
    }
    const bytes = Uint8Array.from(atob(dom.lastPng.base64), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const anchor = kit.el('a', { href: url, download: 'theme-swatch.png' });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    kit.createFeedback(dom.pngFeedback).set('swatch downloaded');
  });

  await parseCurrent();
  return () => {};
}

function stat(label, value) {
  return kit.el('div', { class: 'stat' }, [kit.el('b', { text: String(value) }), kit.el('span', { text: label })]);
}

async function parseCurrent() {
  const value = dom.colorInput.value.trim();
  if (!value) {
    kit.createFeedback(dom.colorFeedback).set('enter a colour first', 'warn');
    return;
  }
  try {
    const result = await api.post('/color/parse', { color: value });
    if (result.ok === false) {
      dom.colorStats.textContent = '';
      dom.colorDetail.textContent = '';
      dom.swatch.style.background = 'transparent';
      kit.createFeedback(dom.colorFeedback).set(result.reason, 'error');
      return;
    }
    const color = result.color;
    dom.swatch.style.background = color.alpha < 1 ? `rgba(${color.rgba.r}, ${color.rgba.g}, ${color.rgba.b}, ${color.alpha})` : color.hex;
    dom.colorStats.textContent = '';
    dom.colorStats.append(
      stat('hex', color.hex),
      stat('alpha', color.alpha),
      stat('light', color.isLight ? 'yes' : 'no'),
      stat('hue', color.hsl ? `${color.hsl.h}°` : '—'),
    );
    dom.colorDetail.textContent = '';
    dom.colorDetail.append(
      kit.el('p', { class: 'mono', text: `rgba(${color.rgba.r}, ${color.rgba.g}, ${color.rgba.b}, ${color.rgba.a})` }),
      kit.el('p', { class: 'mono', text: `hsl(${color.hsl?.h ?? '—'}, ${color.hsl?.s ?? '—'}, ${color.hsl?.l ?? '—'})` }),
    );
    kit.createFeedback(dom.colorFeedback).set('colour normalised');
    dom.paletteBase = color.hex;
  } catch (error) {
    kit.createFeedback(dom.colorFeedback).error(error);
  }
}

async function measureContrast() {
  try {
    const result = await api.post('/color/contrast', { foreground: dom.fgInput.value.trim(), background: dom.bgInput.value.trim() });
    dom.contrastStats.textContent = '';
    dom.contrastStats.append(
      stat('ratio', result.ratio ?? '—'),
      stat('level', result.readability.level),
      stat('body text', result.readability.passesBody ? 'pass' : 'fail'),
      stat('large text', result.readability.passesLarge ? 'pass' : 'fail'),
    );
    kit.createFeedback(dom.contrastFeedback).set(
      `${result.foreground} on ${result.background} · distance ${result.distance}`,
      result.readability.passesBody ? 'ok' : 'warn',
    );
  } catch (error) {
    kit.createFeedback(dom.contrastFeedback).error(error);
  }
}

async function buildPalette() {
  try {
    const result = await api.post('/palette/build', {
      base: dom.colorInput.value.trim() || dom.paletteBase || '#2f8f7a',
      accent: dom.accentInput.value.trim() || null,
      steps: Number.parseInt(dom.stepsInput.value, 10) || 5,
    });
    dom.paletteColors = result.stops.map((stop) => stop.hex);
    if (result.accent) dom.paletteColors.push(result.accent);
    dom.paletteRow.textContent = '';
    for (const hex of dom.paletteColors) {
      dom.paletteRow.append(
        kit.el('div', { style: `flex:1;min-width:34px;height:44px;border-radius:8px;border:1px solid #27333f;background:${hex}`, title: hex }),
      );
    }
    kit.createFeedback(dom.paletteFeedback).set(
      `base ${result.base} · on surface ${result.readabilityOnSurface.level} (${result.readabilityOnSurface.ratio}) · label on base ${result.suggestedLabelOnBase}`,
    );
  } catch (error) {
    kit.createFeedback(dom.paletteFeedback).error(error);
  }
}

async function encodeSwatch() {
  const colors = dom.paletteColors.length > 0 ? dom.paletteColors : [dom.colorInput.value.trim() || '#2f8f7a'];
  try {
    const result = await api.post('/png/swatch', {
      colors,
      width: Number.parseInt(dom.widthInput.value, 10) || 240,
      height: Number.parseInt(dom.heightInput.value, 10) || 120,
    });
    dom.lastPng = result;
    dom.pngStats.textContent = '';
    dom.pngStats.append(
      stat('size', `${result.width}×${result.height}`),
      stat('bytes', result.bytes),
      stat('colour type', result.header?.colorType ?? '—'),
      stat('decoded', `${result.decoded.width}×${result.decoded.height}`),
    );
    dom.pngPreview.textContent = '';
    dom.pngPreview.append(
      kit.el('img', {
        id: 'te-png-img',
        alt: 'generated swatch',
        src: `data:image/png;base64,${result.base64}`,
        style: 'max-width:100%;border:1px solid #27333f;border-radius:8px;image-rendering:pixelated',
      }),
    );
    kit.createFeedback(dom.pngFeedback).set('PNG encoded and decoded back by an independent reader');
  } catch (error) {
    dom.lastPng = null;
    kit.createFeedback(dom.pngFeedback).error(error);
  }
}
