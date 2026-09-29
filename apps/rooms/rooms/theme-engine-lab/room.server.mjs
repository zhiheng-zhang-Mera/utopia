/**
 * UTOPIA · Rooms · Room 12 — Theme Engine Lab (server).
 *
 * Incubator for the DS-Hns theme engine core: parse and normalise colours, report
 * contrast/readability, synthesise deterministic palettes and encode a PNG swatch
 * that the user can download. Nothing is applied to the Alien Web UI and no
 * runtime file is written.
 *
 * Donor: zhiheng-zhang-Mera/DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b
 *        app/extensions/mega/theme/color.js, app/extensions/mega/theme/png.js
 */

import { createRouter, sendJson } from '../../shared/http.mjs';
import { RoomValidationError } from '../../shared/room-kit.mjs';
import {
  bestOn,
  contrastRatio,
  distance,
  flatten,
  isLight,
  mix,
  parseColor,
  readability,
  rgbToHsl,
  shade,
  toHex,
  toRgba,
} from './color.mjs';
import {
  MAX_DIMENSION,
  buildSwatch,
  canvasToPng,
  decodePng,
  encodePng,
  readPngHeader,
} from './png.mjs';

function requireObject(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RoomValidationError('payload must be a JSON object');
  }
  return payload;
}

function requireColor(value, field) {
  const parsed = toRgba(value);
  if (!parsed) throw new RoomValidationError(`${field} must be a hex or rgb()/rgba() colour`);
  return parsed;
}

/** Full colour report used by the room UI. */
export function describeColor(value) {
  const parsed = toRgba(value);
  if (!parsed) return null;
  const hex = toHex(parsed);
  const hsl = rgbToHsl(parsed);
  return {
    input: typeof value === 'string' ? value : { ...value },
    hex,
    hexWithAlpha: parsed.a >= 1 ? hex : `${hex}${Math.round(parsed.a * 255).toString(16).padStart(2, '0')}`,
    rgba: parsed,
    alpha: parsed.a,
    hsl: hsl ? { h: Math.round(hsl.h * 100) / 100, s: Math.round(hsl.s * 1000) / 1000, l: Math.round(hsl.l * 1000) / 1000 } : null,
    luminance: Math.round((flatten(parsed) ? (0.2126 * (parsed.r / 255) + 0.7152 * (parsed.g / 255) + 0.0722 * (parsed.b / 255)) : 0) * 10000) / 10000,
    isLight: isLight(parsed),
  };
}

/** Create the Theme Engine Lab route handler (no durable store). */
export function createThemeEngineRoom() {
  const route = createRouter([
    {
      method: 'GET',
      pattern: '/capabilities',
      handle: async ({ res }) => {
        sendJson(res, 200, {
          room: 'theme-engine-lab',
          appliesToAlienWeb: false,
          donor: {
            repository: 'zhiheng-zhang-Mera/DS-Hns',
            commit: 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b',
            sourcePaths: ['app/extensions/mega/theme/color.js', 'app/extensions/mega/theme/png.js'],
          },
          limits: { maxDimension: MAX_DIMENSION },
          accepts: ['hex', 'rgb()', 'rgba()', 'transparent'],
          outputs: ['normalised colour', 'contrast/readability', 'palette', 'PNG swatch'],
        });
      },
    },
    {
      method: 'POST',
      pattern: '/color/parse',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        if (!('color' in payload)) throw new RoomValidationError('color is required');
        const described = describeColor(payload.color);
        if (!described) {
          sendJson(res, 200, { ok: false, reason: `not a supported colour: ${JSON.stringify(payload.color)}` });
          return;
        }
        sendJson(res, 200, { ok: true, color: described });
      },
    },
    {
      method: 'POST',
      pattern: '/color/contrast',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const foreground = requireColor(payload.foreground, 'foreground');
        const background = requireColor(payload.background, 'background');
        const ratio = contrastRatio(foreground, background);
        sendJson(res, 200, {
          foreground: toHex(foreground),
          background: toHex(background),
          ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
          readability: readability(foreground, background),
          betterLabel: bestOn(background, [foreground, toHex(foreground) === '#ffffff' ? '#000000' : '#ffffff']),
          distance: Math.round(distance(foreground, background) * 100) / 100,
        });
      },
    },
    {
      method: 'POST',
      pattern: '/palette/build',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const base = requireColor(payload.base, 'base');
        const steps = Number.isInteger(payload.steps) ? payload.steps : 5;
        if (steps < 2 || steps > 9) throw new RoomValidationError('steps must be between 2 and 9');
        const accent = payload.accent === undefined ? null : requireColor(payload.accent, 'accent');
        const surface = payload.surface === undefined ? { r: 255, g: 255, b: 255, a: 1 } : requireColor(payload.surface, 'surface');

        const stops = [];
        for (let index = 0; index < steps; index += 1) {
          // spread the ramp between -0.28 and +0.3 lightness so a mid-tone base
          // never collapses into pure black or pure white
          const t = steps === 1 ? 0.5 : index / (steps - 1);
          const amount = -0.28 + t * 0.58;
          stops.push({ role: `base-${index + 1}`, hex: shade(base, amount) });
        }
        const foreground = toHex(base);
        const onSurface = readability(foreground, toHex(surface));
        sendJson(res, 200, {
          base: toHex(base),
          accent: accent ? toHex(accent) : null,
          surface: toHex(surface),
          steps,
          stops,
          mixWithSurface: mix(base, surface, 0.5),
          readabilityOnSurface: onSurface,
          suggestedLabelOnBase: bestOn(base, ['#ffffff', '#000000']),
        });
      },
    },
    {
      method: 'POST',
      pattern: '/png/swatch',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const width = Number.isInteger(payload.width) ? payload.width : 240;
        const height = Number.isInteger(payload.height) ? payload.height : 120;
        const raw = payload.colors;
        if (!Array.isArray(raw) || raw.length === 0) throw new RoomValidationError('colors must be a non-empty array');
        if (raw.length > 32) throw new RoomValidationError('at most 32 colours can be rendered');
        const colors = raw.map((entry, index) => requireColor(entry, `colors[${index}]`));

        let canvas;
        try {
          canvas = buildSwatch({ colors, width, height });
        } catch (error) {
          throw new RoomValidationError(String(error?.message ?? error));
        }
        const png = canvasToPng(canvas);
        const header = readPngHeader(png);
        // decode our own output: the encoder and decoder are independent on purpose
        const decoded = decodePng(png);
        const firstPixel = [decoded.data[0], decoded.data[1], decoded.data[2], decoded.data[3]];
        sendJson(res, 200, {
          ok: true,
          width: canvas.width,
          height: canvas.height,
          bytes: png.length,
          base64: png.toString('base64'),
          header,
          decoded: { width: decoded.width, height: decoded.height, colorType: decoded.colorType, firstPixel },
          colors: colors.map((color) => toHex(color)),
        });
      },
    },
    {
      method: 'POST',
      pattern: '/png/inspect',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        if (typeof payload.base64 !== 'string' || payload.base64.trim() === '') {
          throw new RoomValidationError('base64 must be a PNG payload');
        }
        const normalized = payload.base64.replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
          throw new RoomValidationError('base64 is not valid base64');
        }
        const buffer = Buffer.from(normalized, 'base64');
        if (buffer.length === 0) throw new RoomValidationError('base64 decoded to zero bytes');
        const header = readPngHeader(buffer);
        if (!header) {
          sendJson(res, 200, { ok: false, reason: 'not a PNG (bad signature or missing IHDR)' });
          return;
        }
        try {
          const decoded = decodePng(buffer);
          const column = Math.floor(decoded.width / 2) * 4;
          const middlePixel = [decoded.data[column], decoded.data[column + 1], decoded.data[column + 2], decoded.data[column + 3]];
          sendJson(res, 200, {
            ok: true,
            header,
            decoded: { width: decoded.width, height: decoded.height, colorType: decoded.colorType },
            middlePixel,
            bytes: buffer.length,
          });
        } catch (error) {
          sendJson(res, 200, { ok: false, reason: String(error?.message ?? error), header, bytes: buffer.length });
        }
      },
    },
  ]);

  return { id: 'theme-engine-lab', handle: (context) => route(context), persistent: false };
}

/** Re-exported for tests so they exercise the same entry points as the room. */
export { encodePng, parseColor };
