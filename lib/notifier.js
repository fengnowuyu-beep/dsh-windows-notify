/**
 * The Host-side notifier: turns one semantic notification into one popup
 * process.
 *
 * Delivery is deliberately process-isolated. Windows offers exactly two
 * reasonable ways to raise a desktop notification from a Node process - a WinRT
 * toast, or a helper process that draws its own window - and on a Windows 10
 * deployment the toast only renders for AppUserModelIDs the shell already
 * knows (an unpackaged plugin's own AUMID never reaches the notification
 * settings, so `ToastNotificationManager.Show()` is accepted, logged by the
 * notification platform, and then never displayed). The popup host is therefore
 * the reliable channel: `scripts/notify.ps1` draws a corner card and plays the
 * cue.
 *
 * Launching goes through `scripts/notify-launch.vbs` under `wscript.exe`,
 * which has no console of its own and starts the popup host with a hidden
 * window, so a notification never flashes a console box. The payload travels as
 * a UTF-8 file path rather than as inline text because PowerShell 5.1 mangles
 * non-ASCII command-line arguments.
 *
 * @module dsh-windows-notify/notifier
 */

import { existsSync, rmSync, statSync } from 'node:fs'
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { resolveSound } from './settings.js'

/** How many popups may be drawing/sounding at once before new ones queue. */
const MAX_CONCURRENT = 2

/** The card width, in device-independent units. */
const POPUP_WIDTH = 384

/** A payload older than this is stale output from a crashed run. */
const STALE_PAYLOAD_MS = 60 * 60 * 1000

/** How long the launcher may take before the slot is released anyway. */
const LAUNCH_TIMEOUT_MS = 20_000

/** Write one JSON document atomically. */
async function writeAtomic(file, text) {
  const temporary = `${file}.tmp`
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, file)
}

/**
 * Build the UTF-8 payload `notify.ps1` reads. The BOM is deliberate: Windows
 * PowerShell 5.1 decodes the file as UTF-8 only when it is present, which is
 * what keeps Chinese titles and bodies intact.
 * @param notification - one catalog-built notification.
 * @param options - `{ soundPath, seconds, slotDir, ownerId }`.
 * @returns the payload text.
 */
export function buildPayload(notification, options) {
  const seconds = Number(options.seconds)
  const payload = {
    title: notification.title,
    body: notification.body,
    accent: notification.accent,
    glyph: notification.badge,
    sound: options.soundPath ?? '',
    // `0` is the far-right slider position: no auto-dismiss timer at all.
    duration: Number.isFinite(seconds) && seconds > 0 ? seconds : 'always',
    // Slot bookkeeping lets several never-dismissing cards share the corner
    // instead of stacking on top of each other.
    slotDir: options.slotDir ?? '',
    width: POPUP_WIDTH
  }
  if (typeof options.ownerId === 'string' && options.ownerId !== '') payload.ownerId = options.ownerId
  return `\uFEFF${JSON.stringify(payload)}`
}

/** @returns the `wscript.exe` path. */
function wscriptPath() {
  const root = process.env.SystemRoot
  if (typeof root === 'string' && root !== '') return join(root, 'System32', 'wscript.exe')
  return 'wscript.exe'
}

/**
 * Create the notifier.
 * @param options - paths, logger, popup lifetime provider and an exit hook.
 * @returns the notifier surface the plugin uses.
 */
export function createNotifier(options) {
  const {
    assetsDir,
    scriptPath,
    launcherPath,
    payloadDir,
    slotDir,
    ownerId,
    logger,
    getPopupSeconds = () => 0,
    onExit = () => {}
  } = options

  /** @type {Set<import('node:child_process').ChildProcess>} */
  const live = new Set()
  /** @type {Array<() => void>} */
  const queue = []
  let active = 0
  let disposed = false
  let queued = 0

  /** Delete payload files left behind by an earlier crash. */
  const sweep = async () => {
    try {
      if (!existsSync(payloadDir)) return
      const cutoff = Date.now() - STALE_PAYLOAD_MS
      for (const name of await readdir(payloadDir)) {
        if (!name.endsWith('.json')) continue
        try {
          const target = join(payloadDir, name)
          if (statSync(target).mtimeMs < cutoff) rmSync(target, { force: true })
        } catch {
          // A concurrently removed file is not an error.
        }
      }
    } catch (error) {
      logger?.debug?.(`windows-notify: payload sweep skipped: ${String(error)}`)
    }
  }

  const pump = () => {
    while (active < MAX_CONCURRENT && queue.length > 0) {
      const next = queue.shift()
      active += 1
      next()
    }
  }

  /** Release one concurrency slot. */
  const release = () => {
    active = Math.max(0, active - 1)
    pump()
  }

  /** Run the silent launcher for one written payload file. */
  const spawnPopup = (payloadFile) => {
    if (disposed) {
      release()
      return
    }
    let child
    try {
      child = spawn(wscriptPath(), [launcherPath, payloadFile, scriptPath], {
        windowsHide: true,
        stdio: 'ignore',
        detached: false
      })
    } catch (error) {
      logger?.warn?.(`windows-notify: could not launch the popup host: ${String(error)}`)
      try { rmSync(payloadFile, { force: true }) } catch { /* best effort */ }
      release()
      return
    }
    const timer = setTimeout(() => {
      live.delete(child)
      logger?.warn?.('windows-notify: the popup launcher did not report an exit in time')
      release()
    }, LAUNCH_TIMEOUT_MS)
    timer.unref?.()

    live.add(child)
    child.once('error', (error) => {
      clearTimeout(timer)
      logger?.warn?.(`windows-notify: popup launcher failed to start: ${String(error)}`)
      try { rmSync(payloadFile, { force: true }) } catch { /* best effort */ }
      live.delete(child)
      release()
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      live.delete(child)
      onExit(code, payloadFile)
      // The payload deliberately survives the launcher: it only starts the
      // popup, which reads the file as it comes up. The next start (and the
      // periodic sweep) removes anything left behind.
      release()
    })
  }

  /**
   * Raise one notification.
   * @param notification - a catalog-built notification.
   * @returns whether a popup was queued.
   */
  const notify = (notification) => {
    if (disposed || notification === null || notification === undefined) return false
    const soundPath = resolveSound(notification.sound, assetsDir)
    const payload = buildPayload(notification, {
      soundPath: soundPath !== null && existsSync(soundPath) ? soundPath : null,
      seconds: getPopupSeconds(),
      slotDir,
      // Slot ownership is per conversation, not per process: two sessions must
      // be able to keep a card each, while one session's newer card replaces
      // its own older one instead of piling up.
      ownerId: typeof notification.ownerId === 'string' && notification.ownerId !== ''
        ? notification.ownerId
        : ownerId
    })
    queued += 1
    const file = join(
      payloadDir,
      `payload-${process.pid}-${Date.now()}-${(queued % 10_000).toString(36)}.json`
    )
    queue.push(() => {
      void (async () => {
        try {
          await mkdir(payloadDir, { recursive: true })
          await writeAtomic(file, payload)
        } catch (error) {
          logger?.warn?.(`windows-notify: could not write the popup payload: ${String(error)}`)
          release()
          return
        }
        spawnPopup(file)
      })()
    })
    pump()
    return true
  }

  /**
   * Check the popup pieces, sweep stale payloads, and report readiness.
   * @returns `{ script, launcher, ready }` - whether a notification can be raised.
   */
  const start = async () => {
    await mkdir(payloadDir, { recursive: true })
    if (typeof slotDir === 'string' && slotDir !== '') await mkdir(slotDir, { recursive: true })
    await sweep()
    const ready = existsSync(scriptPath) && existsSync(launcherPath)
    if (!ready) {
      logger?.warn?.(`windows-notify: popup host missing (script=${scriptPath}, launcher=${launcherPath})`)
    }
    return { script: scriptPath, launcher: launcherPath, ready }
  }

  /** Stop everything: drop queued popups and kill the live launchers. */
  const dispose = () => {
    disposed = true
    queue.length = 0
    for (const child of live) {
      try { child.kill() } catch { /* already gone */ }
    }
    live.clear()
  }

  return {
    notify,
    start,
    dispose,
    sweep,
    pending: () => active + queue.length,
    scriptPath,
    launcherPath,
    isReady: () => existsSync(scriptPath) && existsSync(launcherPath)
  }
}
