/**
 * Donor helper, copied verbatim from DS-Hns `tests/unit/helpers/off-volume-temp.cjs`
 * @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b.
 *
 * Only the module-system lines were rewritten (CommonJS `require` -> ESM `import`,
 * `module.exports` -> `export`). The body is byte-identical. It is copied because
 * `engineering-cross-volume-cleanup.test.mjs` cannot express "off volume" without
 * it, and rewriting that suite to inline it would have changed the suite itself.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function createOffVolumeTempRoot(workRoot) {
  const workDevice = fs.statSync(workRoot).dev
  const candidates = [
    os.tmpdir(),
    path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Temp')
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).dev !== workDevice) {
        fs.mkdirSync(candidate, { recursive: true })
        return candidate
      }
    } catch {
      // A missing candidate is not a usable alternate volume.
    }
  }

  throw new Error(`cross-volume tests require a temp root on a volume separate from ${workRoot}`)
}
