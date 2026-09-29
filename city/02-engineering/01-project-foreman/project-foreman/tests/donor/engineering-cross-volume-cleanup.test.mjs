/**
 * Donor suite, copied verbatim from DS-Hns
 * `tests/unit/engineering-cross-volume-cleanup.test.js`
 * @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b.
 *
 * Rewritten lines, and nothing else:
 *   * `require('node:*')` -> `import`; `require('../../app/engineering/cross-volume-cleanup.cjs')`
 *     -> `import ... from '../../cross-volume-cleanup.mjs'`; the helper is
 *     `./off-volume-temp.mjs` (its own verbatim copy, module-system lines only)
 *   * `WORK_ROOT` is a `mkdtemp` under `node:os.tmpdir()` with a `test.after`
 *     cleanup, instead of the donor repository root, because this port's tests must
 *     never run against the repository tree. The donor likewise only ever *read*
 *     that root (as the work volume to prove scratch lives off it); every path it
 *     writes is under the off-volume temp root. The scratch semantics asserted here
 *     are unchanged.
 *   * `__dirname` disappeared with the old WORK_ROOT expression.
 *
 * ONE TEST WAS EXCLUDED, not weakened:
 *   'successful supervisor completion runs the durable cross-volume cleanup gate'
 * It requires `app/engineering/supervisor.cjs`, which is not in this port's scope
 * and has no target file here, so the test cannot run at all.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { createCrossVolumeTempRegistry } from '../../cross-volume-cleanup.mjs'
import { createOffVolumeTempRoot } from './off-volume-temp.mjs'

const WORK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-volume-work-root-'))

/**
 * The off-volume temp root, resolved without throwing at module scope.
 *
 * The donor helper requires a temp directory on a volume *separate* from the work
 * root. A single-volume CI runner cannot provide one (observed: GitHub Actions
 * `windows-latest`), and resolving it at module scope made that environment a hard
 * load failure for the entire file. Resolving it here turns it into a named reason
 * each test skips on: the subject of this suite IS cross-volume scratch ownership,
 * so with one volume there is nothing faithful to assert. The tests' own bodies and
 * assertions are unmodified.
 */
let OFF_VOLUME_TEMP = null
let OFF_VOLUME_UNAVAILABLE = null
try {
  OFF_VOLUME_TEMP = createOffVolumeTempRoot(WORK_ROOT)
} catch (error) {
  OFF_VOLUME_UNAVAILABLE = String(error && error.message ? error.message : error)
}

/** Skip a test when this host has no volume separate from the work root. */
const requireOffVolume = (t) => {
  if (OFF_VOLUME_TEMP !== null) return false
  t.skip(OFF_VOLUME_UNAVAILABLE || 'no volume separate from the work root is available')
  return true
}

test.after(() => {
  try { fs.rmSync(WORK_ROOT, { recursive: true, force: true }) } catch { /* disposable temp root */ }
})

test('a Windows volume-GUID alias is accepted as the same non-reparse work root', (t) => {
  if (requireOffVolume(t)) return
  if (process.platform !== 'win32' || !fs.existsSync('D:\\')) return t.skip('Windows D: is unavailable')
  const mountvol = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'mountvol.exe')
  const result = spawnSync(mountvol, ['D:\\', '/L'], { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) return t.skip(`volume root lookup is unavailable: ${result.error?.code || result.status}`)
  const volumeRoot = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => /^\\\\\?\\Volume\{[0-9a-f-]+\}\\$/i.test(line))
  if (!volumeRoot) return t.skip('D: has no queryable volume GUID path')
  const relative = path.relative('D:\\', WORK_ROOT)
  const aliasWorkRoot = path.win32.join(volumeRoot, relative)
  assert.equal(fs.statSync(aliasWorkRoot).isDirectory(), true)
  const store = createCrossVolumeTempRegistry({ episodeId: 'volume-guid-alias', workRoot: aliasWorkRoot })
  assert.equal(store.initializationError, null, JSON.stringify(store.initializationError))
})

function externalPath(label, extension = '') {
  return path.join(OFF_VOLUME_TEMP, `codex-cross-volume-${label}-${process.pid}-${crypto.randomUUID()}${extension}`)
}

function registry(episodeId = 'cleanup-fixture', onChange = () => {}) {
  return createCrossVolumeTempRegistry({ episodeId, workRoot: WORK_ROOT, onChange })
}

test('a task-owned off-volume directory is registered with an ownership marker and removed only at terminal cleanup', (t) => {
 if (requireOffVolume(t)) return
  const root = externalPath('directory')
  const changes = []
  const store = registry('cleanup-directory', (entries) => changes.push(entries))
  try {
    const created = store.createTaskDirectory({ path: root, purposeClass: 'build' })
    assert.equal(created.ok, true, JSON.stringify(created))
    assert.equal(fs.existsSync(path.join(root, '.dshns-episode-owner.json')), true)
    const output = store.createRegisteredFile({ path: path.join(root, 'build.tmp'), purposeClass: 'build', content: 'owned output' })
    assert.equal(output.ok, true, JSON.stringify(output))
    assert.equal(changes.length >= 1, true)

    const interrupted = store.cleanupTerminal({ terminal: false, reason: 'unclean_exit' })
    assert.equal(interrupted.ok, true)
    assert.equal(fs.existsSync(root), true, 'recoverable interruptions must preserve scratch')

    const cleaned = store.cleanupTerminal({ terminal: true, reason: 'completed' })
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned))
    assert.equal(cleaned.residuals.length, 0)
    assert.equal(fs.existsSync(root), false)
    assert.equal(store.list()[0].cleanupState, 'DELETED')
  } finally {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a pre-existing directory sentinel cannot be registered or deleted', (t) => {
 if (requireOffVolume(t)) return
  const root = externalPath('sentinel')
  fs.mkdirSync(root)
  const sentinel = path.join(root, 'keep.txt')
  fs.writeFileSync(sentinel, 'pre-existing user data', 'utf8')
  const store = registry('cleanup-sentinel')
  try {
    const refused = store.createTaskDirectory({ path: root, purposeClass: 'cache' })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'TEMP_PATH_ALREADY_EXISTS')
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'pre-existing user data')
    assert.deepEqual(store.list(), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a mismatched ownership marker blocks cleanup and reports the exact residual', (t) => {
 if (requireOffVolume(t)) return
  const root = externalPath('marker')
  const store = registry('cleanup-marker')
  try {
    assert.equal(store.createTaskDirectory({ path: root, purposeClass: 'test' }).ok, true)
    fs.writeFileSync(path.join(root, '.dshns-episode-owner.json'), JSON.stringify({ episodeId: 'someone-else' }), 'utf8')
    const result = store.cleanupTerminal({ terminal: true, reason: 'completed' })
    assert.equal(result.ok, false)
    assert.equal(result.residuals.length, 1)
    assert.equal(result.residuals[0].path, root)
    assert.equal(store.list()[0].cleanupState, 'CLEANUP_BLOCKED')
    assert.equal(fs.existsSync(root), true)
  } finally {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an unregistered foreign file inside an owned directory blocks recursive cleanup', (t) => {
 if (requireOffVolume(t)) return
  const root = externalPath('foreign-child')
  const store = registry('cleanup-foreign-child')
  try {
    assert.equal(store.createTaskDirectory({ path: root, purposeClass: 'build' }).ok, true)
    fs.writeFileSync(path.join(root, 'foreign.keep'), 'do not delete this', 'utf8')
    const result = store.cleanupTerminal({ terminal: true, reason: 'completed' })
    assert.equal(result.ok, false)
    assert.equal(result.residuals[0].path, root)
    assert.equal(fs.readFileSync(path.join(root, 'foreign.keep'), 'utf8'), 'do not delete this')
    assert.equal(store.list()[0].cleanupState, 'CLEANUP_BLOCKED')
  } finally {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a task-owned file is removed exactly without deleting its containing directory', (t) => {
 if (requireOffVolume(t)) return
  const parent = externalPath('file-parent')
  const file = path.join(parent, 'single.log')
  fs.mkdirSync(parent)
  const parentSentinel = path.join(parent, 'keep.txt')
  fs.writeFileSync(parentSentinel, 'keep', 'utf8')
  const store = registry('cleanup-file')
  try {
    const created = store.createRegisteredFile({ path: file, purposeClass: 'log', content: 'episode output' })
    assert.equal(created.ok, true, JSON.stringify(created))
    const cleaned = store.cleanupTerminal({ terminal: true, reason: 'cancelled' })
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned))
    assert.equal(fs.existsSync(file), false)
    assert.equal(fs.readFileSync(parentSentinel, 'utf8'), 'keep')
  } finally {
    if (fs.existsSync(parent)) fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('a symlink/reparse entry inside a registered root blocks recursive deletion', (t) => {
  if (requireOffVolume(t)) return
  const root = externalPath('reparse')
  const store = registry('cleanup-reparse')
  const target = externalPath('reparse-target')
  try {
    assert.equal(store.createTaskDirectory({ path: root, purposeClass: 'unpack' }).ok, true)
    fs.mkdirSync(target)
    try {
      fs.symlinkSync(target, path.join(root, 'escape'), 'junction')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`junction creation is unavailable: ${error.code}`)
      throw error
    }
    const result = store.cleanupTerminal({ terminal: true, reason: 'completed' })
    assert.equal(result.ok, false)
    assert.equal(store.list()[0].cleanupState, 'CLEANUP_BLOCKED')
    assert.equal(fs.existsSync(root), true)
    assert.equal(fs.existsSync(target), true)
  } finally {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
  }
})

test('a locked registered child preserves its parent marker and cleanup debt retries after the handle closes', async (t) => {
  if (requireOffVolume(t)) return
  if (process.platform !== 'win32') return t.skip('the file-share lock adapter is Windows-specific')
  const root = externalPath('locked-parent')
  const helper = externalPath('lock-helper', '.ps1')
  const ready = `${helper}.ready`
  const store = registry(`cleanup-lock-${process.pid}-${crypto.randomUUID()}`)
  let child = null
  try {
    assert.equal(store.createTaskDirectory({ path: root, purposeClass: 'test' }).ok, true)
    const target = path.join(root, 'locked.tmp')
    assert.equal(store.createRegisteredFile({ path: target, purposeClass: 'test', content: 'locked task file' }).ok, true)
    const marker = path.join(root, '.dshns-episode-owner.json')
    const markerBytes = fs.readFileSync(marker)
    const script = [
      'param([string]$Target, [string]$Ready, [int]$HoldMs)',
      '$stream = [System.IO.File]::Open($Target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)',
      '[System.IO.File]::WriteAllText($Ready, "ready")',
      'Start-Sleep -Milliseconds $HoldMs',
      '$stream.Dispose()'
    ].join('\r\n') + '\r\n'
    fs.writeFileSync(helper, script, { flag: 'wx' })
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', helper, '-Target', target, '-Ready', ready, '-HoldMs', '1500'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 8_000
      const poll = () => {
        if (fs.existsSync(ready)) return resolve()
        if (child.exitCode !== null || child.signalCode !== null) return reject(new Error('lock helper exited before acquiring the file'))
        if (Date.now() > deadline) return reject(new Error('lock helper did not acquire the file before the deadline'))
        setTimeout(poll, 25)
      }
      poll()
    })

    const blocked = store.cleanupTerminal({ terminal: true, reason: 'locked-file-test' })
    assert.equal(blocked.ok, false)
    assert.equal(fs.existsSync(marker), true, 'a failed recursive delete must preserve the owner marker')
    assert.deepEqual(fs.readFileSync(marker), markerBytes)
    assert.equal(fs.existsSync(target), true)

    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve))
    const retried = store.retryCleanupDebt()
    assert.equal(retried.ok, true, JSON.stringify(retried))
    assert.equal(retried.residuals.length, 0)
    assert.equal(fs.existsSync(root), false)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill()
      await exited
    }
    for (const file of [helper, ready]) if (fs.existsSync(file)) fs.unlinkSync(file)
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
  }
})
