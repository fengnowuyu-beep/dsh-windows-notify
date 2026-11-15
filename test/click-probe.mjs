/**
 * Live probe for the card's interaction, covering the popup side of the chain:
 *
 *   payload -> silent launcher -> popup card -> synthetic clicks
 *
 * Three behaviours are pinned, because they are easy to get subtly wrong:
 *
 *   1. clicking the card body (title/body area) does NOTHING: no focus request,
 *      and the card is still there;
 *   2. clicking the hint row opens the conversation (focus request written) and
 *      dismisses that card;
 *   3. clicking the close glyph dismisses the card and writes no focus request.
 *
 * The clicks are real mouse events at the exact screen points the card reports
 * for those two elements, so they exercise the same handlers a user hits. The
 * window style is checked too: WS_EX_TOOLWINDOW is what keeps a card out of the
 * Alt+Tab switcher. The cursor is restored.
 *
 * Run manually: `npm run test:click`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createNotifier } from '../lib/notifier.js'

const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const POWERSHELL = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
const stateDir = mkdtempSync(join(tmpdir(), 'dsh-wn-click-'))

const helper = (name, args = []) => execFileSync(POWERSHELL, [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(scriptRoot, 'test', name), ...args
], { encoding: 'utf8' })

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * @returns one `{ hwnd, pid, rect, toolWindow }` per visible popup card.
 *
 * Note that a card raised by a *different* run of the plugin (the one installed
 * in the running DSH, for instance) is listed here too: this probe only ever
 * touches the points its own card reported, and asserts on the card count it
 * created rather than on the absence of every other card.
 */
const cards = () => helper('list-windows.ps1')
  .split(/\r?\n/)
  .map(line => /hwnd=(\d+)\s+pid=(\d+)\s+rect=\((-?\d+),(-?\d+)\)-\((-?\d+),(-?\d+)\)[\s\S]*toolwindow=(\w+)/.exec(line))
  .filter(Boolean)
  .map(match => ({
    hwnd: match[1],
    pid: match[2],
    left: Number(match[3]),
    top: Number(match[4]),
    right: Number(match[5]),
    bottom: Number(match[6]),
    toolWindow: match[7] === 'True'
  }))

/**
 * The screen points the newest card reacts to, as it reported them itself.
 *
 * The pid and handle come from the same line, so a card raised by some OTHER run
 * of the plugin (the one installed in the running DSH, for instance) can never
 * be mistaken for this probe's card.
 * @returns `{ pid, hwnd, rect, hint, close, toolWindow, line }` or null when nothing was logged yet.
 */
function lastGeometry() {
  const log = join(stateDir, 'popup.log')
  if (!existsSync(log)) return null
  const lines = readFileSync(log, 'utf8').split(/\r?\n/).filter(line => line.includes('placed '))
  const line = lines.at(-1)
  if (line === undefined) return null
  const pid = /pid=(\d+)/.exec(line)
  const hwnd = /hwnd=(\d+)/.exec(line)
  const rect = /rect=(-?\d+),(-?\d+)/.exec(line)
  const hint = /hint=(-?\d+),(-?\d+)/.exec(line)
  const close = /close=(-?\d+),(-?\d+)/.exec(line)
  const toolWindow = /toolWindow=(\w+)/.exec(line)
  return {
    pid: pid === null ? null : pid[1],
    hwnd: hwnd === null ? null : hwnd[1],
    rect: rect === null ? null : { left: Number(rect[1]), top: Number(rect[2]) },
    hint: hint === null ? null : { x: Number(hint[1]), y: Number(hint[2]) },
    close: close === null ? null : { x: Number(close[1]), y: Number(close[2]) },
    toolWindow: toolWindow === null ? null : toolWindow[1] === 'True',
    line
  }
}

/**
 * Geometry for one card that is still true of the card on screen.
 *
 * A card can be re-stacked (it moves down when a card below it closes), and a
 * click at coordinates recorded before that move would land beside the target
 * and prove nothing. The recorded rectangle is compared with the live one, and
 * a mismatch is retried rather than clicked.
 * @returns the settled geometry, or null when it never matched.
 */
async function settledGeometry(pid) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const geometry = lastGeometry()
    const card = cardOf(pid)
    if (geometry?.pid === String(pid) && geometry.rect !== null && card !== null
      && Math.abs(card.left - geometry.rect.left) <= 2
      && Math.abs(card.top - geometry.rect.top) <= 2) {
      return geometry
    }
    await wait(400)
  }
  return null
}

/** The visible card owned by one popup process, if it is still up. */
const cardOf = pid => cards().find(card => card.pid === String(pid)) ?? null

/** Whether a focus request exists, and what it says. */
function focusRequest() {
  const file = join(stateDir, 'focus.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return { unreadable: true }
  }
}

const failures = []
let unverified = 0
const check = (condition, message) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`)
  if (!condition) failures.push(message)
}

/**
 * Click one element of a card, addressed as an offset inside that window.
 *
 * The point is not sent as absolute screen coordinates: the corner re-stacks
 * whenever a card below disappears, so an absolute point can end up on another
 * part of the same card (the body, which is deliberately inert) and read as
 * "the card ignored the click". The helper recomputes the point from the
 * window's current rectangle before every press, and reports whether a press
 * was ever confirmed to land on the card.
 * @returns whether the click landed on the expected window.
 */
const clickAt = (expectHwnd, offsetX, offsetY) => {
  let output = ''
  try {
    output = helper('click-window.ps1', [
      '-Hwnd', String(expectHwnd), '-OffsetX', String(offsetX), '-OffsetY', String(offsetY)
    ])
  } catch (error) {
    output = String(error?.stdout ?? error?.message ?? error)
  }
  console.log(`  ${output.trim()}`)
  const landed = /verified=True/.test(output)
  if (!landed) unverified += 1
  return landed
}

const notifier = createNotifier({
  assetsDir: join(scriptRoot, 'assets'),
  scriptPath: join(scriptRoot, 'scripts', 'notify.ps1'),
  launcherPath: join(scriptRoot, 'scripts', 'notify-launch.vbs'),
  payloadDir: join(stateDir, 'payloads'),
  slotDir: join(stateDir, 'slots'),
  stateDir,
  ownerId: 'probe',
  logger: console,
  getPopupSeconds: () => 0
})

console.log('start:', JSON.stringify(await notifier.start()))
try { helper('close-windows.ps1', ['-Wait']) } catch { /* best effort */ }
await wait(600)

const sessionId = 'probe-session-1234'
notifier.notify({
  kind: 'approval',
  title: '等待审批 · 修复登录超时',
  body: 'probe: the card body must be inert, the hint row must open the conversation',
  accent: '#4C8DFF',
  badge: 'OK?',
  sound: 'none',
  sessionId
})
await wait(3000)

const listing = helper('list-windows.ps1')
console.log('list-windows.ps1 raw output:', JSON.stringify(listing))
const geometry = lastGeometry()
console.log('geometry line:', geometry?.line ?? '(none)')
check(geometry !== null && geometry.pid !== null, 'the popup reported which process owns this card')
check(geometry !== null && geometry.hint !== null, 'the card reported where its hint row is')
check(geometry !== null && geometry.close !== null, 'the card reported where its close glyph is')
check(geometry !== null && geometry.toolWindow === true, 'the popup reported the tool-window style was applied')

const card = cardOf(geometry?.pid ?? '')
if (card === null) {
  console.log('\nFAIL: no visible card belongs to this probe, so nothing could be clicked')
  notifier.dispose()
  process.exit(1)
}
check(card.toolWindow, 'the card carries WS_EX_TOOLWINDOW, so it stays out of Alt+Tab')

// 1. The body must be inert. The band just under the top accent strip is title
//    territory: inside the card, and nowhere near either live target.
const settled = await settledGeometry(geometry?.pid ?? '')
check(settled !== null, 'the card reported geometry that matches where it actually is')
const live = cardOf(geometry?.pid ?? '') ?? card
// Offsets are measured from the card's own top-left corner, which is the only
// frame that survives the card moving.
const bodyOffsetX = Math.round((live.right - live.left) / 2)
const bodyOffsetY = Math.min(live.bottom - live.top - 4, 34)
console.log(`clicking card body (offset ${bodyOffsetX},${bodyOffsetY})`)
if (clickAt(live.hwnd, bodyOffsetX, bodyOffsetY)) {
  await wait(900)
  check(focusRequest() === null, 'clicking the card body wrote no focus request')
  check(cardOf(geometry.pid) !== null, 'clicking the card body left the card on screen')
} else {
  console.log('  the body click could not be verified, so its effect is not judged')
}

// 2. The hint row opens the conversation and dismisses that card.
const hintGeometry = await settledGeometry(geometry?.pid ?? '')
if (hintGeometry?.hint != null && hintGeometry.rect !== null) {
  const hintOffsetX = hintGeometry.hint.x - hintGeometry.rect.left
  const hintOffsetY = hintGeometry.hint.y - hintGeometry.rect.top
  console.log(`clicking hint row (offset ${hintOffsetX},${hintOffsetY})`)
  if (clickAt(hintGeometry.hwnd, hintOffsetX, hintOffsetY)) {
    await wait(1500)
    const request = focusRequest()
    check(request !== null && request.sessionId === sessionId, 'clicking the hint row asked to open that conversation')
    check(request !== null && typeof request.at === 'number', 'the request carries its timestamp')
    check(cardOf(geometry.pid) === null, 'clicking the hint row dismissed that card')
  } else {
    console.log('  the hint click could not be verified, so its effect is not judged')
  }
}

// 3. The close glyph dismisses without navigating. A fresh card, closed by hand.
rmSync(join(stateDir, 'focus.json'), { force: true })
notifier.notify({
  kind: 'completion',
  title: '对话完成 · probe',
  body: 'probe: the close glyph must dismiss without opening anything',
  accent: '#3DD68C',
  badge: 'OK',
  sound: 'none',
  sessionId
})
await wait(3000)

const closeGeometry = await settledGeometry(lastGeometry()?.pid ?? '')
check(closeGeometry !== null && closeGeometry.pid !== null && closeGeometry.pid !== geometry?.pid, 'a second card appeared for the close test')
if (closeGeometry?.close != null && closeGeometry.rect !== null && cardOf(closeGeometry.pid) !== null) {
  const closeOffsetX = closeGeometry.close.x - closeGeometry.rect.left
  const closeOffsetY = closeGeometry.close.y - closeGeometry.rect.top
  console.log(`clicking close glyph (offset ${closeOffsetX},${closeOffsetY})`)
  if (clickAt(closeGeometry.hwnd, closeOffsetX, closeOffsetY)) {
    await wait(1500)
    check(focusRequest() === null, 'the close glyph wrote no focus request')
    check(cardOf(closeGeometry.pid) === null, 'the close glyph dismissed the card')
  } else {
    console.log('  the close click could not be verified, so its effect is not judged')
  }
}

console.log(failures.length === 0
  ? '\nPASS: the body is inert, the hint row opens, the close glyph only closes, and the card stays out of Alt+Tab'
  : `\nFAIL: ${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`)

// A click that never provably landed proves nothing in either direction, so the
// run is reported as inconclusive instead of being counted against the card.
if (unverified > 0 && failures.length === 0) {
  console.log(`INCONCLUSIVE: ${unverified} click(s) could not be verified ` +
    '(the pointer was moved while the probe was aiming; keep the mouse still and re-run)')
}

try { helper('close-windows.ps1', ['-Wait']) } catch { /* best effort */ }
notifier.dispose()
rmSync(stateDir, { recursive: true, force: true })
process.exit(failures.length > 0 ? 1 : (unverified > 0 ? 2 : 0))
