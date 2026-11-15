/**
 * Live probe for the corner's stacking behaviour:
 *
 *   1. two cards sit in the corner at two heights;
 *   2. they are both out of the Alt+Tab switcher (WS_EX_TOOLWINDOW);
 *   3. when the LOWER card goes away - hard-killed, leaving a stale slot file -
 *      the remaining card comes DOWN into the free space instead of floating
 *      where it was;
 *   4. the same happens when the lower card is closed through its own process.
 *
 * A live DSH keeps raising its own notifications while this runs, and those
 * cards share the corner. Everything here is therefore measured from the cards
 * THIS probe raised (the ones that logged to its own popup log) - a real card
 * mistaken for the probe's lower card would compute the expected position from
 * somebody else's geometry.
 *
 * Run manually: `npm run test:stack`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createNotifier } from '../lib/notifier.js'

const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const POWERSHELL = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
const stateDir = mkdtempSync(join(tmpdir(), 'dsh-wn-stack-'))
const logFile = join(stateDir, 'popup.log')

const helper = (name, args = []) => execFileSync(POWERSHELL, [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(scriptRoot, 'test', name), ...args
], { encoding: 'utf8' })

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** Every card on screen, including the ones the running DSH just raised. */
const allCards = () => helper('list-windows.ps1')
  .split(/\r?\n/)
  .map(line => /hwnd=(\d+) pid=(\d+) rect=\((-?\d+),(-?\d+)\)-\((-?\d+),(-?\d+)\)[\s\S]*toolwindow=(\w+)/.exec(line))
  .filter(Boolean)
  .map(match => ({
    hwnd: match[1],
    pid: match[2],
    left: Number(match[3]),
    top: Number(match[4]),
    bottom: Number(match[6]),
    toolWindow: match[7] === 'True'
  }))

/**
 * The pids this probe raised, in the order their cards were placed.
 * @returns the pids recorded in this probe's own popup log.
 */
const ownPids = () => {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.includes('placed '))
    .map(line => /pid=(\d+)/.exec(line)?.[1])
    .filter(Boolean)
}

/** @returns the card with that pid, or undefined. */
const cardByPid = (pid) => allCards().find(card => card.pid === String(pid))

/** @returns the pid of the most recently placed card, or undefined. */
const newestPid = () => ownPids().at(-1)

const failures = []
const check = (condition, message) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`)
  if (!condition) failures.push(message)
}

const notifier = createNotifier({
  assetsDir: join(scriptRoot, 'assets'),
  scriptPath: join(scriptRoot, 'scripts', 'notify.ps1'),
  launcherPath: join(scriptRoot, 'scripts', 'notify-launch.vbs'),
  payloadDir: join(stateDir, 'payloads'),
  slotDir: join(stateDir, 'slots'),
  stateDir,
  ownerId: 'stack-probe',
  logger: { info: () => {}, warn: (m) => console.log('[warn]', m), debug: () => {} },
  getPopupSeconds: () => 0
})

/** Raise one card and return it as the listing sees it. */
const raise = async (index) => {
  notifier.notify({
    kind: 'completion',
    title: `stack probe ${index}`,
    body: 'test/stack-probe.mjs',
    accent: '#4C8DFF',
    badge: String(index),
    sound: 'none',
    sessionId: `stack-probe-${index}`,
    ownerId: `stack-probe-${index}`
  })
  await wait(3000)
  return cardByPid(newestPid())
}

console.log('stateDir:', stateDir)
await notifier.start()
try { helper('close-windows.ps1', ['-Wait']) } catch { /* best effort */ }
await wait(600)

// ---------------------------------------------------------------- two cards
const first = await raise(1)
const second = await raise(2)

check(first !== undefined && second !== undefined, 'the probe has two cards on screen')
if (first === undefined || second === undefined) {
  console.log('FAIL: the probe could not raise its own cards')
  notifier.dispose()
  process.exit(1)
}
check(first.pid !== second.pid, 'the two cards are different processes')
check(first.toolWindow && second.toolWindow, 'both cards carry WS_EX_TOOLWINDOW (out of Alt+Tab and the taskbar)')
check(first.top !== second.top, `the two cards occupy different heights (${first.top} vs ${second.top})`)

const bottom = first.top > second.top ? first : second
const upper = first.top > second.top ? second : first
check(upper.top < bottom.top, 'the newer card sits above the older one')

/**
 * Where the bottom-most slot puts a card of this height.
 *
 * A card's y depends on its OWN height, so comparing two different cards' tops
 * is meaningless: the bottom slot is `workAreaBottom - height - 24`, and the
 * bottom card's own bottom edge is `workAreaBottom - 24`.
 */
const bottomSlotTop = (reference, height) => reference.bottom - height

// ------------------------------------------------- hard-killed lower card
console.log(`hard-killing the lower card (hwnd=${bottom.hwnd})`)
helper('close-window.ps1', ['-Hwnd', bottom.hwnd])
await wait(3000)

const lowerGone = cardByPid(bottom.pid)
check(lowerGone === undefined, 'the killed card is gone')
const survived = cardByPid(upper.pid)
check(survived !== undefined, 'the upper card is still on screen')
const expectedAfterKill = bottomSlotTop(bottom, upper.bottom - upper.top)
check(survived?.top === expectedAfterKill,
  `the upper card came DOWN into the freed space (top ${survived?.top}, expected ${expectedAfterKill})`)

// ------------------------------------------- lower card closed normally
console.log('raising a second generation to close one through its own process')
const survivor = cardByPid(upper.pid)
const third = await raise(3)
check(third !== undefined, 'a third card appeared for the graceful test')

if (survivor !== undefined && third !== undefined) {
  const lower = survivor.top > third.top ? survivor : third
  const higher = survivor.top > third.top ? third : survivor
  console.log(`closing the lower card (hwnd=${lower.hwnd})`)
  helper('close-window.ps1', ['-Hwnd', lower.hwnd])
  await wait(3000)
  const leftover = cardByPid(higher.pid)
  check(leftover !== undefined, 'the higher card survived the graceful close')
  const expectedTop = bottomSlotTop(lower, higher.bottom - higher.top)
  check(leftover?.top === expectedTop,
    `the higher card came DOWN after the graceful close (top ${leftover?.top}, expected ${expectedTop})`)
}

console.log(failures.length === 0
  ? '\nPASS: cards stack, stay out of Alt+Tab, and collapse when one below goes away'
  : `\nFAIL: ${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`)

try { helper('close-windows.ps1', ['-Wait']) } catch { /* best effort */ }
notifier.dispose()
rmSync(stateDir, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 1)
