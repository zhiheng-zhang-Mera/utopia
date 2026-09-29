/**
 * D2 — Theme Engine Lab focused tests, including donor parity.
 *
 * Colour and PNG vectors follow the DS-Hns donor modules
 * (`app/extensions/mega/theme/color.js`, `png.js` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b): the ported core is proved by
 * round-tripping PNG output through the donor's independent decoder and by the
 * exact colour conversions the donor performs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestHub } from './harness.mjs';
import {
  CONTRAST_BODY_MIN,
  bestOn,
  clamp,
  contrastRatio,
  distance,
  flatten,
  isHex,
  isLight,
  mix,
  parseColor,
  readability,
  rgbToHsl,
  hslToRgb,
  shade,
  toHex,
  toRgba,
} from '../rooms/theme-engine-lab/color.mjs';
import {
  MAX_DIMENSION,
  SIGNATURE,
  buildSwatch,
  canvasToDataUri,
  canvasToPng,
  createCanvas,
  decodePng,
  encodePng,
  fill,
  readPngHeader,
} from '../rooms/theme-engine-lab/png.mjs';

const API = '/local-rooms/v1/theme-engine-lab';
const DONOR_COMMIT = 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b';

test('colour parsing matches the donor grammar', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('#2f8f7a'), { r: 47, g: 143, b: 122, a: 1 });
  assert.deepEqual(parseColor('#2f8f7a80'), { r: 47, g: 143, b: 122, a: 128 / 255 });
  assert.deepEqual(parseColor('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor('rgb(100% 0% 0%)'), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });

  for (const invalid of ['', 'red', '#12', '#12345', 'rgb(1,2)', 'not a colour', null, undefined, 42, {}]) {
    assert.equal(parseColor(invalid), null, String(invalid));
  }
  assert.equal(isHex('#abc'), true);
  assert.equal(isHex('abc'), false);
  assert.equal(clamp(5, 0, 3), 3);
});

test('colour conversion and alpha compositing match the donor', () => {
  assert.equal(toHex('#2f8f7a'), '#2f8f7a');
  assert.equal(toHex({ r: 300, g: -5, b: 12.6 }), '#ff000d', 'channels are clamped and rounded');
  assert.equal(toHex('nonsense'), null);
  assert.deepEqual(toRgba({ r: 10, g: 20, b: 30 }), { r: 10, g: 20, b: 30, a: 1 });
  assert.equal(toRgba({ r: 'x', g: 0, b: 0 }), null);

  assert.deepEqual(flatten('#ffffff'), { r: 255, g: 255, b: 255, a: 1 });
  const half = flatten('rgba(0, 0, 0, 0.5)', '#ffffff');
  assert.deepEqual(half, { r: 127.5, g: 127.5, b: 127.5, a: 1 });
  assert.equal(flatten('nope'), null);

  const hsl = rgbToHsl('#2f8f7a');
  assert.ok(hsl.h > 160 && hsl.h < 175, `hue is green-cyan, got ${hsl.h}`);
  const back = hslToRgb(hsl);
  assert.ok(Math.abs(back.r - 47) <= 1 && Math.abs(back.g - 143) <= 1 && Math.abs(back.b - 122) <= 1, JSON.stringify(back));
  assert.deepEqual(hslToRgb({ h: 0, s: 0, l: 0.5 }), { r: 128, g: 128, b: 128, a: 1 });
});

test('contrast, readability and shading match the donor thresholds', () => {
  assert.equal(Math.round(contrastRatio('#ffffff', '#000000')), 21);
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21, 'order does not matter');
  const ratio = contrastRatio('#2f8f7a', '#ffffff');
  assert.ok(ratio > 3 && ratio < 6, `mid-tone on white, got ${ratio}`);

  assert.equal(readability('#000000', '#ffffff').level, 'AAA');
  assert.equal(readability('#ffffff', '#ffffff').level, 'fail');
  const onTeal = readability('#ffffff', '#2f8f7a');
  assert.ok(onTeal.ratio > 3 && onTeal.ratio < 4.5, `white on the teal mid-tone is large-text only, got ${onTeal.ratio}`);
  assert.equal(onTeal.passesLarge, true);
  assert.equal(onTeal.passesBody, false);
  assert.equal(readability('nonsense', '#fff').level, 'unknown');
  assert.equal(CONTRAST_BODY_MIN, 4.5);

  assert.equal(isLight('#ffffff'), true);
  assert.equal(isLight('#000000'), false);
  assert.equal(bestOn('#2f8f7a', ['#ffffff', '#000000']), '#000000', 'black contrasts better on a mid-tone');
  assert.equal(bestOn('#ffffff', ['#ffffff', '#000000']), '#000000');

  assert.equal(shade('#000000', -0.5), '#000000', 'shading cannot go below black');
  assert.equal(shade('#ffffff', 0.5), '#ffffff', 'shading cannot go above white');
  assert.match(shade('#2f8f7a', 0.1), /^#[0-9a-f]{6}$/);
  assert.equal(shade('nope', 0.1), null);

  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#000000', '#ffffff', 0), '#ffffff', 'weight 0 keeps the other colour');
  assert.equal(mix('nope', '#ffffff'), null);
  assert.ok(distance('#000000', '#ffffff') > distance('#000000', '#333333'));
  assert.equal(distance('nope', '#fff'), null);
});

test('PNG encoding round-trips through the independent decoder', () => {
  const canvas = createCanvas(4, 3);
  fill(canvas, { r: 47, g: 143, b: 122 });
  const png = canvasToPng(canvas);
  assert.ok(png.subarray(0, 8).equals(SIGNATURE), 'PNG signature');

  const header = readPngHeader(png);
  assert.deepEqual({ width: header.width, height: header.height, colorType: header.colorType }, { width: 4, height: 3, colorType: 6 });
  assert.equal(readPngHeader(Buffer.from('not a png')), null);

  const decoded = decodePng(png);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 3);
  assert.deepEqual([decoded.data[0], decoded.data[1], decoded.data[2], decoded.data[3]], [47, 143, 122, 255]);
  assert.equal(canvasToDataUri(canvas).startsWith('data:image/png;base64,'), true);

  const rgb = encodePng({ width: 2, height: 1, data: Buffer.from([1, 2, 3, 4, 5, 6]), channels: 3 });
  assert.equal(readPngHeader(rgb).colorType, 2, 'three-channel output is colour type 2');
  assert.deepEqual([...decodePng(rgb).data], [1, 2, 3, 255, 4, 5, 6, 255]);
});

test('PNG encoding rejects impossible images instead of producing them', () => {
  assert.throws(() => encodePng({ width: 0, height: 10, data: Buffer.alloc(4) }), /invalid PNG width/);
  assert.throws(() => encodePng({ width: 10, height: -1, data: Buffer.alloc(4) }), /invalid PNG height/);
  assert.throws(() => encodePng({ width: 2, height: 2, data: Buffer.alloc(4), channels: 2 }), /invalid PNG channel count/);
  assert.throws(() => encodePng({ width: 4, height: 4, data: Buffer.alloc(4) }), /pixel buffer too small/);
  assert.throws(() => buildSwatch({ colors: [], width: 10, height: 10 }), /at least one colour/);
  assert.throws(() => buildSwatch({ colors: [{ r: 0, g: 0, b: 0, a: 1 }], width: MAX_DIMENSION + 1, height: 10 }), /invalid image width/);
  assert.throws(() => decodePng(Buffer.from('nope')), /bad signature/);
});

test('the swatch builder is deterministic and honours alpha', () => {
  const colors = [
    { r: 255, g: 0, b: 0, a: 1 },
    { r: 0, g: 0, b: 255, a: 1 },
  ];
  const first = canvasToPng(buildSwatch({ colors, width: 4, height: 2 }));
  const second = canvasToPng(buildSwatch({ colors, width: 4, height: 2 }));
  assert.ok(first.equals(second), 'the same palette produces the same bytes');

  const decoded = decodePng(first);
  assert.deepEqual([decoded.data[0], decoded.data[1], decoded.data[2], decoded.data[3]], [255, 0, 0, 255], 'left half is the first colour');
  const rightColumn = 3 * 4;
  assert.deepEqual([decoded.data[rightColumn], decoded.data[rightColumn + 1], decoded.data[rightColumn + 2]], [0, 0, 255]);

  const translucent = canvasToPng(buildSwatch({ colors: [{ r: 0, g: 0, b: 0, a: 0.5 }], width: 1, height: 1 }));
  const alpha = decodePng(translucent).data[3];
  assert.ok(alpha > 120 && alpha < 136, `half alpha encodes as ~128, got ${alpha}`);
});

test('the room exposes colour, contrast, palette and PNG flows over HTTP', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const capabilities = await hub.api('GET', `${API}/capabilities`);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.payload.appliesToAlienWeb, false);
  assert.equal(capabilities.payload.donor.commit, DONOR_COMMIT);
  assert.deepEqual(capabilities.payload.donor.sourcePaths, [
    'app/extensions/mega/theme/color.js',
    'app/extensions/mega/theme/png.js',
  ]);

  const parsed = await hub.api('POST', `${API}/color/parse`, { color: '#2f8f7a' });
  assert.equal(parsed.payload.ok, true);
  assert.equal(parsed.payload.color.hex, '#2f8f7a');
  assert.equal(parsed.payload.color.isLight, false);
  const rejected = await hub.api('POST', `${API}/color/parse`, { color: 'sort of green' });
  assert.equal(rejected.payload.ok, false);
  assert.match(rejected.payload.reason, /not a supported colour/);
  assert.equal((await hub.api('POST', `${API}/color/parse`, {})).status, 400);

  const contrast = await hub.api('POST', `${API}/color/contrast`, { foreground: '#ffffff', background: '#2f8f7a' });
  assert.equal(contrast.payload.readability.passesLarge, true);
  assert.equal(contrast.payload.foreground, '#ffffff');
  assert.equal((await hub.api('POST', `${API}/color/contrast`, { foreground: 'x', background: '#fff' })).status, 400);

  const palette = await hub.api('POST', `${API}/palette/build`, { base: '#2f8f7a', accent: '#c8eea1', steps: 5 });
  assert.equal(palette.payload.stops.length, 5);
  assert.equal(palette.payload.accent, '#c8eea1');
  assert.equal(palette.payload.stops[0].hex, shade('#2f8f7a', -0.28));
  assert.equal(palette.payload.stops[4].hex, shade('#2f8f7a', 0.3));
  assert.ok(!palette.payload.stops.some((stop) => ['#000000', '#ffffff'].includes(stop.hex)), 'a mid-tone ramp stays inside the gamut');
  assert.equal((await hub.api('POST', `${API}/palette/build`, { base: '#2f8f7a', steps: 99 })).status, 400);

  const swatch = await hub.api('POST', `${API}/png/swatch`, { colors: ['#2f8f7a', '#c8eea1'], width: 40, height: 20 });
  assert.equal(swatch.payload.ok, true);
  assert.equal(swatch.payload.header.width, 40);
  assert.equal(swatch.payload.decoded.width, 40, 'the encoder output is decoded back');
  assert.ok(swatch.payload.bytes > 60);
  assert.deepEqual(swatch.payload.decoded.firstPixel, [47, 143, 122, 255]);
  const decoded = decodePng(Buffer.from(swatch.payload.base64, 'base64'));
  assert.equal(decoded.height, 20);
  assert.deepEqual(swatch.payload.colors, ['#2f8f7a', '#c8eea1']);

  const inspected = await hub.api('POST', `${API}/png/inspect`, { base64: swatch.payload.base64 });
  assert.equal(inspected.payload.ok, true);
  assert.equal(inspected.payload.decoded.width, 40);
  const notPng = await hub.api('POST', `${API}/png/inspect`, { base64: Buffer.from('hello').toString('base64') });
  assert.equal(notPng.payload.ok, false);
  assert.match(notPng.payload.reason, /not a PNG/);
  assert.equal((await hub.api('POST', `${API}/png/inspect`, { base64: 'not base64!!' })).status, 400);
  assert.equal((await hub.api('POST', `${API}/png/swatch`, { colors: [] })).status, 400);
  assert.equal((await hub.api('POST', `${API}/png/swatch`, { colors: ['#fff'], width: 5000 })).status, 400);
});

test('the room never writes a runtime file and stays independent of the donor checkout', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await hub.api('POST', `${API}/png/swatch`, { colors: ['#000000'], width: 8, height: 8 });
  const files = await readdir(hub.runtimeDir);
  assert.deepEqual(files, [], 'the lab has no durable file');

  const roomDir = join(import.meta.dirname, '..', 'rooms', 'theme-engine-lab');
  for (const file of ['color.mjs', 'png.mjs', 'room.server.mjs']) {
    const source = await readFile(join(roomDir, file), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ['require(', "from 'app/", "from 'node_modules", 'from "app/']) {
      assert.ok(!code.includes(forbidden), `${file} must not depend on the donor checkout (${forbidden})`);
    }
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
    }
  }
});
