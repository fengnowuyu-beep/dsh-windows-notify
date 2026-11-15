/**
 * Live integration test: drives the real engine through the real handlers and
 * lets it raise real popups, so catalogue -> payload -> launcher -> popup host
 * is exercised end to end on this machine.
 *
 * Run manually (`npm run test:live`). It draws on screen and leaves cards up
 * while the configured lifetime is "stay", so it closes them at the end.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WindowsNotify } from '../lib/index.js'

const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const root = mkdtempSync(join(tmpdir(), 'dsh-wn-live-'))
const POWERSHELL = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

const runHelper = (name) => execFileSync(POWERSHELL, [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(scriptRoot, 'test', name)
], { encoding: 'utf8' })

/** @returns one line per visible popup window. */
const listPopups = () => runHelper('list-windows.ps1')
  .split(/\r?\n/)
  .filter(line => line.trim().startsWith('hwnd='))

/** Ask every visible popup to close, and wait until the corner is really empty. */
const closePopups = () => {
  try {
    runHelper('close-windows.ps1', ['-Wait'])
  } catch {
    // Best effort.
  }
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const engine = new WindowsNotify({
  logger: { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m), debug: () => {} },
  config: { dshHome: root, popupSeconds: 0 },
  scriptRoot
})
engine.ctx = { get: () => undefined }

/** A fake agent whose log carries a conversation title and a closed turn. */
const agent = (id, title) => ({
  id,
  session: {
    id,
    header: { id },
    snapshotEvents: () => [
      { type: 'session/title', seq: 1, time: Date.now(), data: { title, messageSeqs: [], source: { kind: 'user' } } },
      { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } }
    ]
  }
})

console.log('popup host ready:', JSON.stringify(await engine.start()))
closePopups()
await wait(500)

console.log('\n-- 1. two cards, default lifetime "stay" --')
engine.onApprovalRequest({
  agent: agent('abcdefgh-1111', '修复登录超时'),
  toolName: 'write',
  callId: 'call-1',
  displayReason: { en: 'Write lib/index.js' }
})
await wait(2500)
engine.onUserQuestions({
  agent: agent('abcdefgh-2222', '重构通知模块'),
  questions: [{ question: 'Approve this plan?', intent: { kind: 'plan-review' } }]
})
await wait(3000)

const stacked = listPopups()
console.log(`visible cards: ${stacked.length} (expected 2, one per session)`)
for (const line of stacked) console.log('  ' + line)
const tops = stacked.map(line => Number(/rect=\(\d+,(\d+)\)/.exec(line)?.[1] ?? 0))
console.log('distinct vertical positions:', [...new Set(tops)].sort((a, b) => a - b).join(', '))

console.log('\n-- 2. the same session replaces its own card instead of stacking --')
const beforeReplace = listPopups().length
engine.fire('error', { sessionId: 'abcdefgh-1111', title: '出错 · 修复登录超时', detail: 'rate-limit' })
await wait(2500)
const afterReplace = listPopups().length
console.log(`cards before: ${beforeReplace}, after: ${afterReplace} (expected: unchanged)`)

console.log('\n-- 3. an auto-dismiss lifetime still disappears --')
engine.settings = { ...engine.settings, popupSeconds: 4 }
engine.fire('completion', { sessionId: 'abcdefgh-3333', title: '对话完成 · 短时通知' })
await wait(2000)
const during = listPopups().length
await wait(4500)
const after = listPopups().length
console.log(`cards while the timer runs: ${during}, after it lapsed: ${after}`)

console.log('\n-- cleanup --')
closePopups()
engine.dispose()
rmSync(root, { recursive: true, force: true })
console.log('done')
