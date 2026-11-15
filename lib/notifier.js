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

import { existsSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

import { OPEN_HINT } from './catalog.js'
import { resolveSound } from './settings.js'

/** How many popups may be drawing/sounding at once before new ones queue. */
const MAX_CONCURRENT = 2

/** The card width, in device-independent units. */
const POPUP_WIDTH = 384

/** A payload older than this is stale output from a crashed run. */
const STALE_PAYLOAD_MS = 60 * 60 * 1000

/** Default window owner the popup activates when a card is clicked. */
const DEFAULT_FOCUS_APP = 'DeepSeek Harness'

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
 * @param options - `{ soundPath, seconds, slotDir, ownerId, stateDir, focusApp }`.
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
  // The popup logs what it placed, which elements are live and how far it got
  // with its window styles. Without this the script's log lines had nowhere to
  // go, and a card that never appeared left no trace at all.
  if (typeof options.logFile === 'string' && options.logFile !== '') payload.logFile = options.logFile
  // A card for a conversation is clickable: the popup brings the DSH window
  // forward and drops a focus request the Host relays to the open GUI page.
  if (typeof notification.sessionId === 'string' && notification.sessionId !== '') {
    payload.sessionId = notification.sessionId
    payload.stateDir = options.stateDir ?? ''
    payload.focusApp = options.focusApp ?? DEFAULT_FOCUS_APP
    // Non-ASCII text stays on this side of the boundary; see OPEN_HINT.
    payload.openHint = OPEN_HINT
  }
  return `\uFEFF${JSON.stringify(payload)}`
}

/** @returns the `wscript.exe` path. */
function wscriptPath() {
  const root = process.env.SystemRoot
  if (typeof root === 'string' && root !== '') return join(root, 'System32', 'wscript.exe')
  return 'wscript.exe'
}

/** @returns the Windows PowerShell path, used by the card maintenance script. */
function powershellPath() {
  const root = process.env.SystemRoot
  if (typeof root === 'string' && root !== '') {
    return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  }
  return 'powershell.exe'
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
    stateDir,
    ownerId,
    focusApp,
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
        : ownerId,
      stateDir,
      focusApp,
      logFile: typeof stateDir === 'string' && stateDir !== '' ? join(stateDir, 'popup.log') : ''
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
   * Give cards that are already on screen the tool-window style.
   *
   * A card raised by an older popup host never got `WS_EX_TOOLWINDOW`, so
   * Alt+Tab still offers it. Cards are long-lived by default (the shipped
   * lifetime is "stay until dismissed"), so the old ones outlive the fix and
   * have to be adopted rather than replaced.
   *
   * The script's output goes to a file rather than a pipe: a confined process
   * may not open the pipes a piped stdio needs, and this is housekeeping that
   * must never be the reason activation fails.
   * @returns `{ found, adopted }` as the maintenance script reported it.
   */
  const adoptExistingCards = async () => {
    const maintenance = join(dirname(scriptPath), 'card-windows.ps1')
    if (!existsSync(maintenance)) return { found: 0, adopted: 0, skipped: true }
    const reportFile = join(payloadDir, 'card-adoption.log')
    // Callable on its own, not only after `start()`: the report file lives in
    // the payload directory, so that directory has to exist first.
    try {
      await mkdir(payloadDir, { recursive: true })
    } catch (error) {
      logger?.debug?.(`windows-notify: card adoption skipped: ${String(error)}`)
      return { found: 0, adopted: 0, skipped: true }
    }

    const finished = await new Promise((resolve) => {
      let settled = false
      const finish = (outcome) => {
        if (settled) return
        settled = true
        resolve(outcome)
      }
      let out
      try {
        out = openSync(reportFile, 'w')
      } catch (error) {
        logger?.debug?.(`windows-notify: card adoption skipped: ${String(error)}`)
        resolve({ code: null, reason: `report file unavailable: ${String(error)}` })
        return
      }
      let child
      try {
        child = spawn(powershellPath(), [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', maintenance, '-Action', 'Adopt'
        ], { windowsHide: true, stdio: ['ignore', out, 'ignore'] })
      } catch (error) {
        logger?.debug?.(`windows-notify: card adoption unavailable: ${String(error)}`)
        resolve({ code: null, reason: `spawn threw: ${String(error)}` })
        return
      }
      const timer = setTimeout(() => finish({ code: null, reason: 'timed out' }), 15_000)
      timer.unref?.()
      child.once('exit', (code) => {
        clearTimeout(timer)
        finish({ code, reason: 'exited' })
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        finish({ code: null, reason: `spawn failed: ${String(error)}` })
      })
    })

    let output = ''
    try {
      output = readFileSync(reportFile, 'utf8')
    } catch {
      output = ''
    }
    const found = Number(/cards found:\s*(\d+)/.exec(output)?.[1] ?? 0)
    const adopted = Number(/adopted:\s*(\d+)/.exec(output)?.[1] ?? 0)
    if (found > 0) {
      logger?.info?.(`windows-notify: adopted ${adopted}/${found} card(s) already on screen`)
    } else if (finished.reason !== 'exited' || finished.code !== 0) {
      logger?.debug?.(`windows-notify: card adoption reported nothing (${finished.reason}, code ${String(finished.code)})`)
    }
    return { found, adopted, code: finished.code, reason: finished.reason }
  }

  /**
   * Check the popup pieces, sweep stale payloads, adopt existing cards, and
   * report readiness.
   * @returns `{ script, launcher, ready }` - whether a notification can be raised.
   */
  const start = async () => {
    await mkdir(payloadDir, { recursive: true })
    if (typeof slotDir === 'string' && slotDir !== '') await mkdir(slotDir, { recursive: true })
    await sweep()
    const ready = existsSync(scriptPath) && existsSync(launcherPath)
    if (!ready) {
      logger?.warn?.(`windows-notify: popup host missing (script=${scriptPath}, launcher=${launcherPath})`)
    } else {
      void adoptExistingCards().catch(() => {})
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
    adoptExistingCards,
    isReady: () => existsSync(scriptPath) && existsSync(launcherPath)
  }
}
