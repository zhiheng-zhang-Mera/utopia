/**
 * UTOPIA · Rooms · Room 11 — Skill Intake Lab (server).
 *
 * Incubator for the DS-Hns skill intake core: parse and validate a `SKILL.md`
 * document and inspect a `.tar` / `.tar.gz` bundle for safety, WITHOUT installing
 * anything. The first wave deliberately does not install skills, and nothing is
 * written to disk: archives are inspected in memory.
 *
 * Donor: zhiheng-zhang-Mera/DS-Hns @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b
 *        app/extensions/mega/skills/skill-format.js, app/extensions/mega/skills/tar.js
 */

import { createRouter, sendJson } from '../../shared/http.mjs';
import { RoomValidationError } from '../../shared/room-kit.mjs';
import { MAX_SKILL_BYTES, analyzeSkillDocument, parseSkillText } from './format.mjs';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES, inspectArchive } from './archive.mjs';

/** Base64 payload cap: the hub's JSON body limit is 8 MB, base64 wastes 4/3 of it. */
export const MAX_ARCHIVE_BASE64_BYTES = 5 * 1024 * 1024;

function requireObject(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RoomValidationError('payload must be a JSON object');
  }
  return payload;
}

function decodeBase64(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RoomValidationError(`${field} must be a base64 string`);
  }
  const normalized = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new RoomValidationError(`${field} is not valid base64`);
  }
  const buffer = Buffer.from(normalized, 'base64');
  if (buffer.length === 0) throw new RoomValidationError(`${field} decoded to zero bytes`);
  if (buffer.length > MAX_ARCHIVE_BASE64_BYTES) {
    throw new RoomValidationError(`archive exceeds the ${Math.round(MAX_ARCHIVE_BASE64_BYTES / 1024 / 1024)} MB inspection limit`);
  }
  return buffer;
}

/** Create the Skill Intake Lab route handler (no durable store). */
export function createSkillIntakeRoom() {
  const route = createRouter([
    {
      method: 'GET',
      pattern: '/capabilities',
      handle: async ({ res }) => {
        sendJson(res, 200, {
          room: 'skill-intake-lab',
          installs: false,
          donor: {
            repository: 'zhiheng-zhang-Mera/DS-Hns',
            commit: 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b',
            sourcePaths: ['app/extensions/mega/skills/skill-format.js', 'app/extensions/mega/skills/tar.js'],
          },
          limits: {
            maxSkillBytes: MAX_SKILL_BYTES,
            maxArchiveBase64Bytes: MAX_ARCHIVE_BASE64_BYTES,
            defaultMaxBytes: DEFAULT_MAX_BYTES,
            defaultMaxEntries: DEFAULT_MAX_ENTRIES,
          },
          accepts: ['SKILL.md text', 'tar', 'tar.gz'],
        });
      },
    },
    {
      method: 'POST',
      pattern: '/skill/analyze',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        if (typeof payload.text !== 'string') throw new RoomValidationError('text must be a string');
        const result = analyzeSkillDocument(payload.text);
        const stripped = parseSkillText(payload.text);
        sendJson(res, 200, {
          accepted: result.accepted,
          reason: result.reason,
          bytes: result.bytes,
          name: result.name,
          skill: result.skill
            ? {
                name: result.skill.name,
                description: result.skill.description,
                whenToUse: result.skill.whenToUse,
                metadata: result.skill.metadata,
                modelInvocable: result.skill.modelInvocable,
                userInvocable: result.skill.userInvocable,
                bodyLines: result.skill.body ? result.skill.body.split('\n').length : 0,
                bodyPreview: result.skill.body.slice(0, 400),
              }
            : null,
          parsedButRejected: !stripped.ok ? stripped.reason : null,
        });
      },
    },
    {
      method: 'POST',
      pattern: '/archive/inspect',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const buffer = decodeBase64(payload.base64, 'base64');
        const stripComponents = Number.isInteger(payload.stripComponents) ? payload.stripComponents : 0;
        if (stripComponents < 0 || stripComponents > 8) {
          throw new RoomValidationError('stripComponents must be between 0 and 8');
        }
        const maxBytes = Number.isInteger(payload.maxBytes) ? payload.maxBytes : DEFAULT_MAX_BYTES;
        const maxEntries = Number.isInteger(payload.maxEntries) ? payload.maxEntries : DEFAULT_MAX_ENTRIES;
        if (maxBytes < 1 || maxEntries < 1) throw new RoomValidationError('maxBytes and maxEntries must be positive');

        let inspection;
        try {
          inspection = inspectArchive({
            buffer,
            stripComponents,
            maxBytes,
            parseDocument: (text) => analyzeSkillDocument(text),
          });
        } catch (error) {
          const message = String(error?.message ?? error);
          const limitHit = /exceeds/.test(message);
          sendJson(res, 200, {
            ok: false,
            reason: message,
            limit: limitHit ? 'SIZE_LIMIT' : 'STRUCTURE',
            archiveBytes: buffer.length,
            gzip: buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b,
          });
          return;
        }

        const acceptedSkill = inspection.skill?.accepted === true;
        sendJson(res, 200, {
          ok: true,
          gzip: buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b,
          archiveBytes: buffer.length,
          stripComponents,
          entries: inspection.entries,
          accepted: inspection.accepted,
          refused: inspection.refused,
          acceptedCount: inspection.acceptedCount,
          refusedCount: inspection.refusedCount,
          fileCount: inspection.fileCount,
          directoryCount: inspection.directoryCount,
          bytes: inspection.bytes,
          limits: { maxBytes, maxEntries },
          skillDocumentPath: inspection.skillDocumentPath,
          skill: inspection.skill,
          verdict: inspection.refusedCount > 0
            ? 'REJECTED_ENTRIES'
            : inspection.skillDocumentPath === null
              ? 'NO_SKILL_DOCUMENT'
              : acceptedSkill
                ? 'ACCEPTED'
                : 'INVALID_SKILL_DOCUMENT',
        });
      },
    },
    {
      method: 'POST',
      pattern: '/archive/list',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const buffer = decodeBase64(payload.base64, 'base64');
        const { listEntries } = await import('./archive.mjs');
        try {
          const entries = listEntries(buffer, Number.isInteger(payload.maxEntries) ? { maxEntries: payload.maxEntries } : undefined);
          sendJson(res, 200, { ok: true, total: entries.length, entries });
        } catch (error) {
          sendJson(res, 200, { ok: false, reason: String(error?.message ?? error), archiveBytes: buffer.length });
        }
      },
    },
  ]);

  return { id: 'skill-intake-lab', handle: (context) => route(context), persistent: false };
}
