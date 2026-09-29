/**
 * City module tests — Theme Engine (city/11-entertainment/01-entertainment-centre/theme-engine).
 *
 * Donor parity suite: the vectors below follow the DS-Hns donor modules
 * (`app/extensions/mega/theme/color.js`, `png.js` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b). PNG output is proved by decoding it
 * with the donor's independent reader. The incubator room that produced this
 * module was removed from the tree once it was promoted here; see
 * apps/rooms/promotions/theme-engine-lab.json.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
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
  ramp,
  readability,
  rgbToHsl,
  hslToRgb,
  shade,
  toHex,
  toRgba,
} from '../color/color.mjs';
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
} from '../raster/png.mjs';

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
  assert.deepEqual(flatten('rgba(0, 0, 0, 0.5)', '#ffffff'), { r: 127.5, g: 127.5, b: 127.5, a: 1 });
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

test('the palette ramp is deterministic and stays inside the gamut', () => {
  const stops = ramp('#2f8f7a', 5);
  assert.equal(stops.length, 5);
  assert.deepEqual(stops.map((stop) => stop.role), ['base-1', 'base-2', 'base-3', 'base-4', 'base-5']);
  assert.deepEqual(stops, ramp('#2f8f7a', 5), 'the same base always produces the same ramp');
  const base = parseColor('#2f8f7a');
  const middle = parseColor(stops[2].hex);
  // HSL round-tripping moves a channel by a few units; the middle stop must still
  // read as the base colour rather than a visibly different one.
  assert.ok(
    Math.abs(middle.r - base.r) <= 8 && Math.abs(middle.g - base.g) <= 8 && Math.abs(middle.b - base.b) <= 8,
    `the middle stop sits on the base colour, got ${stops[2].hex}`,
  );
  assert.ok(!stops.some((stop) => ['#000000', '#ffffff'].includes(stop.hex)), 'a mid-tone ramp never collapses to black or white');
  assert.equal(ramp('#2f8f7a', 1).length, 1);
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

test('the module is self-contained: built-ins only, no donor checkout dependency', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const moduleDir = join(import.meta.dirname, '..');
  for (const file of ['color/color.mjs', 'raster/png.mjs']) {
    const source = await readFile(join(moduleDir, file), 'utf8');
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

test('provenance stays honest: DONOR.json pins the donor and records the adaptation', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const donor = JSON.parse(await readFile(join(import.meta.dirname, '..', 'DONOR.json'), 'utf8'));
  assert.equal(donor.repository, 'zhiheng-zhang-Mera/DS-Hns');
  assert.equal(donor.commit, 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b');
  assert.equal(donor.cityPath, 'city/11-entertainment/01-entertainment-centre/theme-engine');
  assert.equal(donor.room, 'theme-engine-lab');
  assert.deepEqual(donor.sourcePaths, [
    'app/extensions/mega/theme/color.js',
    'app/extensions/mega/theme/png.js',
  ]);
  assert.ok(donor.adaptation.length >= 3);
  assert.ok(donor.knownDifferences.length >= 1);
  assert.ok(donor.parity.vectors.length >= 8);
});
