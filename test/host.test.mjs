/**
 * Offline test suite for the Host half.
 *
 * Everything here runs without drawing a window: the notifier is replaced by a
 * recorder, so the assertions are about *what* the plugin decided to raise, not
 * about how a popup looks. Run with `node test/host.test.mjs`.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, inspector, WindowsNotify } from '../lib/index.js'
import { buildNotification, clip, describeError, pickDisplayReason, sessionLabel } from '../lib/catalog.js'
import { buildPayload, createNotifier } from '../lib/notifier.js'
import {
  composeSettings,
  DEFAULTS,
  EVENT_KINDS,
  isSoundReference,
  loadPersisted,
  normalizeSettings,
  resolveSound,
  savePersisted,
  settingsPath
} from '../lib/settings.js'

const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-windows-notify-test-'))

/** A throwaway harness home for one test. */
const tempHome = (prefix = 'dsh-wn-') => mkdtempSync(join(tmpdir(), prefix))

let passed = 0
const test = (name, body) => {
  try {
    const result = body()
    if (result instanceof Promise) throw new Error('async test body must be awaited')
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
const testAsync = async (name, body) => {
  try {
    await body()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

/** A notifier double that records instead of drawing. */
function recorder() {
  const raised = []
  return {
    raised,
    api: {
      notify: (notification) => {
        raised.push(notification)
        return true
      },
      start: async () => ({ ready: true }),
      dispose: () => {},
      sweep: async () => {},
      pending: () => 0,
      scriptPath: 'script',
      launcherPath: 'launcher',
      isReady: () => true
    }
  }
}

/** Build an engine bound to a throwaway home with the recording notifier. */
function makeEngine(config = {}, home = mkdtempSync(join(tmpdir(), 'dsh-wn-')), services = {}) {
  const rec = recorder()
  const engine = new WindowsNotify({
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    config: { dshHome: home, ...config },
    scriptRoot,
    createNotifier: () => rec.api
  })
  // `apply()` hands the engine its real context; the tests hand it a lookup.
  engine.ctx = { get: (key) => services[key] }
  return { engine, rec, home, services }
}

/**
 * A minimal fake session/agent pair for the status, error and title paths.
 * @param events - the session log the status and title folds read.
 * @param header - extra session header fields (child-agent markers).
 * @param title - when set, appended to the log as a `session/title` event.
 */
function fakeAgent(id, events = [], header = {}, title = '') {
  // The title event is prepended so the log still ends with the event under
  // test (the completion path reads the newest entry to decide a turn closed).
  const log = title === ''
    ? events
    : [{ type: 'session/title', seq: 1, time: Date.now(), data: { title, messageSeqs: [], source: { kind: 'user' } } }, ...events]
  return {
    id,
    session: {
      id,
      header: { id, ...header },
      snapshotEvents: () => log
    }
  }
}

console.log('# settings')

test('normalizeSettings fills every field from a partial object', () => {
  const settings = normalizeSettings({ enabled: false, events: { error: { enabled: false } } })
  assert.equal(settings.enabled, false)
  assert.equal(settings.events.error.enabled, false)
  assert.equal(settings.events.error.sound, DEFAULTS.events.error.sound)
  assert.equal(settings.events.completion.sound, 'bundled:complete')
  // The shipped lifetime is "stay until dismissed".
  assert.equal(settings.popupSeconds, 0)
  assert.equal(settings.timeoutMs, 90_000)
  assert.deepEqual(Object.keys(settings.events).sort(), [...EVENT_KINDS].sort())
})

test('normalizeSettings keeps a real lifetime and the "never disappear" value', () => {
  assert.equal(normalizeSettings({ popupSeconds: 12 }).popupSeconds, 12)
  assert.equal(normalizeSettings({ popupSeconds: 3 }).popupSeconds, 3)
  assert.equal(normalizeSettings({ popupSeconds: 30 }).popupSeconds, 30)
  assert.equal(normalizeSettings({ popupSeconds: 0 }).popupSeconds, 0)
  // Out-of-band values fall back to the shipped default rather than clamping.
  assert.equal(normalizeSettings({ popupSeconds: -5 }).popupSeconds, 0)
  assert.equal(normalizeSettings({ popupSeconds: 1 }).popupSeconds, 0)
  assert.equal(normalizeSettings({ popupSeconds: 999 }).popupSeconds, 0)
  assert.equal(normalizeSettings({ popupSeconds: 'long' }).popupSeconds, 0)
})

test('normalizeSettings rejects malformed values instead of trusting them', () => {
  const settings = normalizeSettings({
    enabled: 'yes',
    popupSeconds: 999,
    timeoutMs: 10,
    events: { completion: { sound: { evil: true } } }
  })
  assert.equal(settings.enabled, true)
  assert.equal(settings.popupSeconds, 0)
  assert.equal(settings.timeoutMs, 90_000)
  assert.equal(settings.events.completion.sound, 'bundled:complete')
})

test('isSoundReference accepts the four documented shapes only', () => {
  assert.equal(isSoundReference('none'), true)
  assert.equal(isSoundReference('bundled:error'), true)
  assert.equal(isSoundReference('bundled:nope'), false)
  assert.equal(isSoundReference('system:chimes.wav'), true)
  assert.equal(isSoundReference('C:\\Windows\\Media\\chimes.wav'), true)
  assert.equal(isSoundReference('relative/chimes.wav'), false)
  assert.equal(isSoundReference(42), false)
})

test('resolveSound maps references onto concrete files', () => {
  const assets = join(scriptRoot, 'assets')
  assert.equal(resolveSound('bundled:complete', assets), join(assets, 'complete.wav'))
  assert.equal(resolveSound('bundled:error', assets), join(assets, 'error.wav'))
  assert.equal(resolveSound('none', assets), null)
  assert.equal(resolveSound('bundled:missing', assets), null)
  assert.equal(resolveSound('system:chimes.wav', assets), join('C:\\Windows\\Media', 'chimes.wav'))
  assert.equal(resolveSound('D:\\cues\\mine.wav', assets), 'D:\\cues\\mine.wav')
})

test('composeSettings lets the persisted document win over config', () => {
  const settings = composeSettings(
    { enabled: false, events: { error: { enabled: false, sound: 'none' } } },
    { enabled: true, events: { error: { enabled: true, sound: 'bundled:error' } } }
  )
  assert.equal(settings.enabled, false)
  assert.equal(settings.events.error.enabled, false)
  assert.equal(settings.events.error.sound, 'none')
  // A kind the document never mentions keeps the configured value.
  assert.equal(settings.events.completion.sound, 'bundled:complete')
})

test('composeSettings falls back field by field for a partial persisted event', () => {
  const settings = composeSettings(
    { events: { error: { enabled: false } } },
    { events: { error: { enabled: true, sound: 'system:chimes.wav' } } }
  )
  assert.equal(settings.events.error.enabled, false)
  assert.equal(settings.events.error.sound, 'system:chimes.wav')
})

await testAsync('savePersisted/loadPersisted round-trips through the document', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-wn-store-'))
  await savePersisted({ enabled: false, popupSeconds: 12, events: { error: { enabled: false } } }, home)
  const back = loadPersisted(undefined, home)
  assert.equal(back.enabled, false)
  assert.equal(back.popupSeconds, 12)
  assert.equal(settingsPath(home).endsWith('settings.json'), true)
  rmSync(home, { recursive: true, force: true })
})

console.log('# catalogue')

test('clip collapses whitespace and truncates with an ellipsis', () => {
  assert.equal(clip('  a\n b  '), 'a b')
  assert.equal(clip('x'.repeat(10), 5), `xxxx${'\u2026'}`)
})

test('sessionLabel shortens ids and survives junk', () => {
  assert.equal(sessionLabel('abcdefgh-1234'), 'abcdefgh')
  assert.equal(sessionLabel(undefined), 'DSH')
})

test('describeError reads Error, code+message, and plain values', () => {
  assert.equal(describeError(new Error('boom')), 'boom')
  assert.equal(describeError({ code: 'rate-limit', message: 'slow down' }), 'rate-limit: slow down')
  assert.equal(describeError({ code: 'only-code' }), 'only-code')
  assert.equal(describeError('plain'), 'plain')
  assert.equal(describeError(undefined), '')
})

test('pickDisplayReason prefers English then any locale', () => {
  assert.equal(pickDisplayReason({ en: 'Write a file', 'zh-CN': '写文件' }), 'Write a file')
  assert.equal(pickDisplayReason({ 'zh-CN': '写文件' }), '写文件')
  assert.equal(pickDisplayReason(undefined), '')
})

test('buildNotification honours the master and per-kind switches', () => {
  const on = normalizeSettings({})
  const built = buildNotification('error', on, { sessionId: 'abcdefgh', detail: 'boom' })
  assert.equal(built.title, '出错 · abcdefgh')
  assert.equal(built.body, 'boom')
  assert.equal(built.accent, '#F0616D')
  assert.equal(built.sound, 'bundled:error')

  assert.equal(buildNotification('error', normalizeSettings({ enabled: false }), {}), null)
  assert.equal(
    buildNotification('error', normalizeSettings({ events: { error: { enabled: false } } }), {}),
    null
  )
})

test('buildNotification falls back to the kind default body', () => {
  const built = buildNotification('completion', normalizeSettings({}), { sessionId: 'abcdefgh' })
  assert.equal(built.body, 'DSH 已完成本轮回复，等待你的下一步指令。')
})

console.log('# payload')

test('buildPayload emits UTF-8 with a BOM so PowerShell 5.1 decodes Chinese', () => {
  const text = buildPayload(
    { title: '对话完成', body: '正文', accent: '#34C08B', badge: 'OK', sound: 'bundled:complete' },
    { soundPath: 'C:\\x.wav', seconds: 7, slotDir: 'C:\\slots', ownerId: 'dsh-123' }
  )
  assert.equal(text.charCodeAt(0), 0xFEFF)
  const parsed = JSON.parse(text.slice(1))
  assert.equal(parsed.title, '对话完成')
  assert.equal(parsed.body, '正文')
  assert.equal(parsed.glyph, 'OK')
  assert.equal(parsed.duration, 7)
  assert.equal(parsed.slotDir, 'C:\\slots')
  assert.equal(parsed.ownerId, 'dsh-123')
  assert.equal(parsed.width, 384)
  assert.equal(parsed.sound, 'C:\\x.wav')
})

test('buildPayload marks the "never disappear" lifetime explicitly', () => {
  const always = JSON.parse(buildPayload(
    { title: 't', body: 'b', accent: '#fff', badge: 'x', sound: 'bundled:complete' },
    { soundPath: null, seconds: 0 }
  ).slice(1))
  assert.equal(always.duration, 'always')
  // A missing lifetime behaves the same as 0 rather than defaulting to a timer.
  const missing = JSON.parse(buildPayload(
    { title: 't', body: 'b', accent: '#fff', badge: 'x', sound: 'bundled:complete' },
    { soundPath: null }
  ).slice(1))
  assert.equal(missing.duration, 'always')
})

test('buildPayload omits a sound when the cue is silent', () => {
  const parsed = JSON.parse(buildPayload(
    { title: 't', body: 'b', accent: '#fff', badge: 'x', sound: 'none' },
    { soundPath: null, seconds: 7 }
  ).slice(1))
  assert.equal(parsed.sound, '')
})

test('buildPayload carries the click-to-open target only for a conversation', () => {
  const withSession = JSON.parse(buildPayload(
    { title: 't', body: 'b', accent: '#fff', badge: 'x', sound: 'none', sessionId: 'session-abc' },
    { soundPath: null, seconds: 0, stateDir: 'C:\\state' }
  ).slice(1))
  assert.equal(withSession.sessionId, 'session-abc')
  assert.equal(withSession.stateDir, 'C:\\state')
  assert.equal(withSession.focusApp, 'DeepSeek Harness')

  // A card with nothing to open (the sign-in notice) must stay a plain notice.
  const withoutSession = JSON.parse(buildPayload(
    { title: 't', body: 'b', accent: '#fff', badge: 'x', sound: 'none' },
    { soundPath: null, seconds: 0, stateDir: 'C:\\state' }
  ).slice(1))
  assert.equal('sessionId' in withoutSession, false)
  assert.equal('stateDir' in withoutSession, false)
})

test('buildPayload can point the popup at its own log', () => {
  // The popup has always had log lines, but nothing ever handed it a path, so a
  // card that failed to appear left no trace. The probe also reads the element
  // geometry it reports, which is how a click can be aimed at a real target.
  const payload = JSON.parse(buildPayload(
    { title: 't', body: 'b', accent: '#fff', badge: 'x', sound: 'none' },
    { soundPath: null, seconds: 0, stateDir: 'C:\\state', logFile: 'C:\\state\\popup.log' }
  ).slice(1))
  assert.equal(payload.logFile, 'C:\\state\\popup.log')

  // An older Host that sends no log path stays valid: no empty field is written.
  const withoutLog = JSON.parse(buildPayload(
    { title: 't', body: 'b', accent: '#fff', badge: 'x', sound: 'none' },
    { soundPath: null, seconds: 0, stateDir: 'C:\\state' }
  ).slice(1))
  assert.equal('logFile' in withoutLog, false)
})

console.log('# conversation names')

test('the title service is preferred over the log fold', () => {
  const session = fakeAgent('t1', [], {}, '日志里的名字').session
  const { engine } = makeEngine({}, mkdtempSync(join(tmpdir(), 'dsh-wn-title-')), {
    sessionTitle: { get: (candidate) => (candidate === session ? { title: '服务里的名字' } : undefined) }
  })
  assert.equal(engine.conversationName(session, 't1'), '服务里的名字')
})

test('the log fold answers when no title service is composed', () => {
  const { engine } = makeEngine()
  const session = fakeAgent('t2', [], {}, '日志里的名字').session
  assert.equal(engine.conversationName(session, 't2'), '日志里的名字')
})

test('a broken title service degrades to the log instead of throwing', () => {
  const session = fakeAgent('t3', [], {}, '兜底名字').session
  const { engine } = makeEngine({}, mkdtempSync(join(tmpdir(), 'dsh-wn-title-')), {
    sessionTitle: { get: () => { throw new Error('service exploded') } }
  })
  assert.equal(engine.conversationName(session, 't3'), '兜底名字')
})

test('a long conversation name is clipped and whitespace collapsed', () => {
  const long = 'x'.repeat(80)
  const { engine } = makeEngine()
  const session = fakeAgent('t4', [], {}, `  第一行\n第二行 ${long}`).session
  const name = engine.conversationName(session, 't4')
  assert.equal(name.length <= 40, true)
  assert.equal(name.includes('\n'), false)
})

test('a title with no session id at all still names something', () => {
  const { engine } = makeEngine()
  assert.equal(engine.conversationName(undefined, 'zz'), 'zz')
})

test('each notification carries its conversation as the popup slot owner', () => {
  const { engine, rec } = makeEngine()
  const agent = fakeAgent('abcdefgh-1234', [{ type: 'turn/end', seq: 4 }], {}, '修复登录超时')
  engine.onStatus({ agent, status: 'running' })
  engine.onStatus({ agent, status: 'idle' })
  // The slot owner is the conversation, not the Host process: two sessions must
  // be able to keep a card each.
  assert.equal(rec.raised[0].ownerId, 'session:abcdefgh-1234')
  // ...and the card knows which conversation to open when clicked.
  assert.equal(rec.raised[0].sessionId, 'abcdefgh-1234')
  engine.onSignInRequired()
  assert.equal(rec.raised[1].ownerId, 'session:account')
  // The sign-in notice has no conversation, so clicking it cannot navigate.
  assert.equal(rec.raised[1].sessionId, undefined)
})

console.log('# engine')

test('a turn that never ran here cannot fire a completion', () => {
  const { engine, rec } = makeEngine()
  const agent = fakeAgent('s1', [{ type: 'turn/end', seq: 4 }])
  engine.onStatus({ agent, status: 'idle' })
  assert.equal(rec.raised.length, 0)
})

test('a finished turn raises exactly one completion, named after the conversation', () => {
  const { engine, rec } = makeEngine()
  const agent = fakeAgent('s1', [{ type: 'turn/end', seq: 4 }], {}, '修复登录超时')
  engine.onStatus({ agent, status: 'running' })
  engine.onStatus({ agent, status: 'idle' })
  assert.equal(rec.raised.length, 1)
  assert.equal(rec.raised[0].kind, 'completion')
  assert.equal(rec.raised[0].title, '对话完成 · 修复登录超时')
  // The sender's id must not leak into the header once a title exists.
  assert.equal(rec.raised[0].title.includes('s1'), false)
  // Repeating the same closed turn is not a new notification.
  engine.onStatus({ agent, status: 'idle' })
  assert.equal(rec.raised.length, 1)
})

test('a conversation with no title yet falls back to the short session id', () => {
  const { engine, rec } = makeEngine()
  const agent = fakeAgent('abcdefgh-1234', [{ type: 'turn/end', seq: 4 }])
  engine.onStatus({ agent, status: 'running' })
  engine.onStatus({ agent, status: 'idle' })
  assert.equal(rec.raised[0].title, '对话完成 · abcdefgh')
})

test('an idle agent whose log does not end in turn/end stays quiet', () => {
  const { engine, rec } = makeEngine()
  const agent = fakeAgent('s2', [{ type: 'step/start', seq: 2 }])
  engine.onStatus({ agent, status: 'running' })
  engine.onStatus({ agent, status: 'idle' })
  assert.equal(rec.raised.length, 0)
})

test('a later turn in the same session notifies again once the cooldown lapses', () => {
  const { engine, rec } = makeEngine()
  const events = [{ type: 'turn/end', seq: 4 }]
  const agent = fakeAgent('s3', events)
  engine.onStatus({ agent, status: 'running' })
  engine.onStatus({ agent, status: 'idle' })
  assert.equal(rec.raised.length, 1)

  const nextTurn = () => {
    events.push({ type: 'turn/end', seq: events.length * 5 })
    engine.onStatus({ agent, status: 'running' })
    engine.onStatus({ agent, status: 'idle' })
  }

  nextTurn()
  // Still inside the completion cooldown: the second turn is suppressed.
  assert.equal(rec.raised.length, 1)

  // Age the cooldown entry, then close another turn.
  engine.lastFired.set('s3\u0000completion', Date.now() - 10_000)
  nextTurn()
  assert.equal(rec.raised.length, 2)
})

test('child agents are skipped unless enabled', () => {
  const child = fakeAgent('c1', [{ type: 'turn/end', seq: 1 }], { parentSession: 'parent', delegationDepth: 1 })
  const off = makeEngine({ childAgents: false })
  off.engine.onStatus({ agent: child, status: 'running' })
  off.engine.onStatus({ agent: child, status: 'idle' })
  assert.equal(off.rec.raised.length, 0)

  const on = makeEngine({ childAgents: true })
  on.engine.onStatus({ agent: child, status: 'running' })
  on.engine.onStatus({ agent: child, status: 'idle' })
  assert.equal(on.rec.raised.length, 1)
})

test('one failing turn produces one error notification', () => {
  const { engine, rec } = makeEngine()
  const agent = fakeAgent('s4', [])
  engine.onError({ agent, turn: 1, step: 1, error: new Error('provider exploded') })
  engine.onError({ agent, turn: 1, step: 1, error: new Error('provider exploded') })
  assert.equal(rec.raised.length, 1)
  assert.equal(rec.raised[0].kind, 'error')
  assert.equal(rec.raised[0].body, 'provider exploded')
})

test('an approval request raises the approval kind and never answers it', () => {
  const { engine, rec } = makeEngine()
  const agent = fakeAgent('s5', [])
  engine.onApprovalRequest({
    agent,
    toolName: 'write',
    callId: 'call-1',
    displayReason: { en: 'Write lib/index.js', 'zh-CN': '写入 lib/index.js' }
  })
  assert.equal(rec.raised.length, 1)
  assert.equal(rec.raised[0].kind, 'approval')
  assert.equal(rec.raised[0].body, 'write：Write lib/index.js')
  assert.equal(engine.pendingApprovals.has('call-1'), true)
})

test('a plan-review question is distinguished from a plain question', () => {
  const plan = makeEngine()
  plan.engine.onUserQuestions({
    agent: fakeAgent('s6', []),
    questions: [{ question: 'Approve this plan?', intent: { kind: 'plan-review' } }]
  })
  assert.equal(plan.rec.raised[0].kind, 'planReview')
  assert.equal(plan.rec.raised[0].body, 'Approve this plan?')

  const plain = makeEngine()
  plain.engine.onUserQuestions({
    agent: fakeAgent('s7', []),
    questions: [{ question: 'Which colour?' }, { question: 'Which size?' }]
  })
  assert.equal(plain.rec.raised[0].kind, 'userQuestion')
  assert.equal(plain.rec.raised[0].body, 'Which colour?（共 2 个问题）')
})

test('each kind can be switched off independently', () => {
  const { engine, rec } = makeEngine({ events: { completion: { enabled: false } } })
  const agent = fakeAgent('s8', [{ type: 'turn/end', seq: 1 }])
  engine.onStatus({ agent, status: 'running' })
  engine.onStatus({ agent, status: 'idle' })
  engine.onError({ agent, error: 'nope' })
  assert.equal(rec.raised.length, 1)
  assert.equal(rec.raised[0].kind, 'error')
})

test('sign-in demand is de-duplicated on its own key', () => {
  const { engine, rec } = makeEngine()
  engine.onSignInRequired()
  engine.onSignInRequired()
  assert.equal(rec.raised.length, 1)
  assert.equal(rec.raised[0].kind, 'signIn')
})

test('describe reports the paths the settings page shows', () => {
  const { engine, home } = makeEngine()
  const view = engine.describe()
  assert.equal(view.pluginVersion, '1.4.0')
  assert.equal(view.stateDir, join(home, 'windows-notify'))
  assert.equal(view.popupScript.endsWith(join('scripts', 'notify.ps1')), true)
  assert.equal(view.popupLauncher.endsWith(join('scripts', 'notify-launch.vbs')), true)
  assert.deepEqual(view.eventsOrder, EVENT_KINDS)
})

await testAsync('update persists a patch and applies it live', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-wn-update-'))
  const { engine, rec } = makeEngine({}, home)
  await engine.update({
    enabled: true,
    childAgents: true,
    popupSeconds: 15,
    events: { error: { enabled: false, sound: 'none' } }
  })
  assert.equal(engine.settings.childAgents, true)
  assert.equal(engine.popupSeconds, 15)
  assert.equal(engine.settings.events.error.enabled, false)
  const stored = JSON.parse(
    (await import('node:fs')).readFileSync(settingsPath(home), 'utf8')
  )
  assert.equal(stored.popupSeconds, 15)
  assert.equal(stored.events.error.sound, 'none')
  engine.onError({ agent: fakeAgent('s9', []), error: 'ignored' })
  assert.equal(rec.raised.length, 0)
  rmSync(home, { recursive: true, force: true })
})

test('test() bypasses the switch and the cooldown deliberately', () => {
  const { engine, rec } = makeEngine({ events: { error: { enabled: false } } })
  assert.equal(engine.test('error'), true)
  assert.equal(engine.test('error'), true)
  assert.equal(rec.raised.length, 2)
  assert.equal(rec.raised[0].kind, 'error')
})

test('an unknown test kind falls back to completion', () => {
  const { engine, rec } = makeEngine()
  engine.test('nonsense')
  assert.equal(rec.raised[0].kind, 'completion')
})

test('dispose clears the bookkeeping', () => {
  const { engine } = makeEngine()
  engine.onStatus({ agent: fakeAgent('s10', []), status: 'running' })
  assert.equal(engine.ranThisProcess.size, 1)
  engine.dispose()
  assert.equal(engine.ranThisProcess.size, 0)
  assert.equal(engine.lastFired.size, 0)
})

await testAsync('preview plays a cue without raising a popup', async () => {
  const { engine, rec } = makeEngine()
  const played = await engine.preview('bundled:confirm')
  assert.equal(played, true)
  assert.equal(rec.raised.length, 1)
  assert.equal(rec.raised[0].badge, 'TONE')
  assert.equal(rec.raised[0].sound, 'bundled:confirm')
})

console.log('# click-to-open')

/** A stand-in for one open SSE response. */
function fakePage() {
  return {
    written: [],
    write(chunk) {
      this.written.push(chunk)
      return true
    },
    end() {
      this.ended = true
    }
  }
}

/** Write a focus request the way the clicked popup does. */
function writeFocusFile(home, sessionId, at = Date.now(), title = '修复登录超时') {
  const file = join(home, 'windows-notify', 'focus.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ sessionId, title, at })}\n`, 'utf8')
  return file
}

test('a focus request reaches every connected page', () => {
  const { engine } = makeEngine()
  const first = fakePage()
  const second = fakePage()
  engine.attachEvents(first)
  engine.attachEvents(second)

  const delivered = engine.broadcastFocus({ sessionId: 'session-abc', title: '修复登录超时' })
  assert.equal(delivered, 2)
  for (const page of [first, second]) {
    const frame = page.written.join('')
    assert.equal(frame.startsWith('event: focus\ndata: '), true)
    assert.equal(frame.endsWith('\n\n'), true)
    const payload = JSON.parse(frame.slice(frame.indexOf('data: ') + 6).trim())
    assert.equal(payload.sessionId, 'session-abc')
  }
})

test('a page that connects late still receives the newest request', () => {
  const { engine } = makeEngine()
  engine.broadcastFocus({ sessionId: 'session-late', title: '' })
  const page = fakePage()
  engine.attachEvents(page)
  assert.equal(page.written.join('').includes('session-late'), true)
})

test('an expired request is not replayed to a new page', () => {
  const { engine } = makeEngine()
  engine.broadcastFocus({ sessionId: 'session-old', title: '' })
  engine.pendingFocus.at = Date.now() - 60_000
  const page = fakePage()
  engine.attachEvents(page)
  assert.equal(page.written.join('').includes('session-old'), false)
})

test('the popup focus file is read once and only while it is fresh', () => {
  const home = tempHome('dsh-wn-focus-')
  const { engine } = makeEngine({}, home)
  const at = Date.now()
  writeFocusFile(home, 'session-file', at, '修复登录超时')

  assert.deepEqual(engine.readFocusRequest(), { sessionId: 'session-file', title: '修复登录超时' })
  // The same request is never relayed twice.
  assert.equal(engine.readFocusRequest(), undefined)

  // A stale request (a crashed popup's leftovers) is ignored.
  writeFocusFile(home, 'session-stale', at + 1_000)
  engine.lastFocusAt = 0
  const realNow = Date.now
  Date.now = () => at + 120_000
  try {
    assert.equal(engine.readFocusRequest(), undefined)
  } finally {
    Date.now = realNow
  }
  rmSync(home, { recursive: true, force: true })
})

test('a malformed focus file is ignored rather than thrown', () => {
  const home = tempHome('dsh-wn-focus-')
  const { engine } = makeEngine({}, home)
  const file = join(home, 'windows-notify', 'focus.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '{ not json', 'utf8')
  assert.equal(engine.readFocusRequest(), undefined)
  rmSync(home, { recursive: true, force: true })
})

test('detaching a page stops the relay to it', () => {
  const { engine } = makeEngine()
  const page = fakePage()
  const detach = engine.attachEvents(page)
  detach()
  const delivered = engine.broadcastFocus({ sessionId: 'session-gone', title: '' })
  assert.equal(delivered, 0)
})

console.log('# plugin wiring')

test('the popup scripts stay ASCII-only', () => {
  // Windows PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI, so a
  // non-ASCII literal in a popup script becomes mojibake whose glyphs the font
  // renders as blank. Non-ASCII copy belongs in the payload, which is decoded
  // explicitly as UTF-8.
  for (const name of ['notify.ps1', 'notify-launch.vbs', 'card-windows.ps1']) {
    const bytes = readFileSync(join(scriptRoot, 'scripts', name))
    const offenders = []
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] > 0x7f) offenders.push(index)
    }
    assert.equal(offenders.length, 0, `${name} has non-ASCII bytes at ${offenders.slice(0, 5).join(',')}`)
  }
})

await testAsync('the notifier can adopt cards that are already on screen', async () => {
  // Cards outlive the code that raised them (the shipped lifetime is "stay"),
  // so a build that adds the tool-window style has to reach back and fix the
  // cards already up, or they keep showing in Alt+Tab until they are closed.
  // The maintenance script really runs here: a wrong path or a helper that no
  // longer exists silently turns adoption into a no-op, which is exactly the
  // failure this catches.
  const notifier = createNotifier({
    assetsDir: join(scriptRoot, 'assets'),
    scriptPath: join(scriptRoot, 'scripts', 'notify.ps1'),
    launcherPath: join(scriptRoot, 'scripts', 'notify-launch.vbs'),
    payloadDir: join(sandbox, 'notifier-payloads'),
    slotDir: join(sandbox, 'notifier-slots'),
    stateDir: sandbox,
    ownerId: 'test',
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    getPopupSeconds: () => 0
  })
  assert.equal(typeof notifier.adoptExistingCards, 'function')
  assert.equal(existsSync(join(scriptRoot, 'scripts', 'card-windows.ps1')), true)

  const result = await notifier.adoptExistingCards()
  assert.equal(result.reason, 'exited', `adoption did not run: ${JSON.stringify(result)}`)
  assert.equal(result.code, 0, `adoption exited with ${String(result.code)}`)
  // How many cards were adopted depends on the desktop, so only the run itself
  // is asserted; `found`/`adopted` are reported for troubleshooting.
  assert.equal(typeof result.found, 'number')
  assert.equal(typeof result.adopted, 'number')
  notifier.dispose()
})

test('apply() registers every listener and the settings routes', () => {
  const listeners = new Map()
  const routes = []
  const effects = []
  const fakeCtx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    on: (name, handler) => listeners.set(name, handler),
    effect: (factory, label) => {
      effects.push(label)
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      }
    }
  }
  apply(fakeCtx, { dshHome: sandbox })
  for (const name of [
    'agent/status',
    'agent/error',
    'api-session/error',
    'approval/request',
    'user-questions/request',
    'deepseek-account/model-sign-in-required'
  ]) {
    assert.equal(typeof listeners.get(name), 'function', `missing listener ${name}`)
  }
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/windows-notify/api')
  // Popup disposal, popup-host start, settings+event routes, and the focus
  // watcher.
  assert.equal(effects.length, 4)
})

await testAsync('the approval and question listeners delegate with next()', async () => {
  const listeners = new Map()
  apply({
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    on: (name, handler) => listeners.set(name, handler),
    effect: (factory) => {
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    webServer: { register: () => () => {} }
  }, { dshHome: sandbox })

  let called = 0
  const next = async () => {
    called += 1
    return 'unavailable'
  }
  const approval = listeners.get('approval/request')({ agent: fakeAgent('w1', []), toolName: 'bash' }, next)
  assert.equal(approval instanceof Promise, true)
  assert.equal(await approval, 'unavailable')
  const question = listeners.get('user-questions/request')({ agent: fakeAgent('w2', []), questions: [] }, next)
  assert.equal(await question, 'unavailable')
  assert.equal(called, 2)
})

test('inspector() is side-effect free and reports the six kinds', () => {
  const view = inspector({ logger: { info: () => {}, warn: () => {}, debug: () => {} } })
  assert.equal(view.version, '1.4.0')
  assert.deepEqual(view.events, EVENT_KINDS)
  assert.equal(view.popupReady, true)
  assert.equal(typeof view.describe, 'function')
})

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${passed} test(s) passed${process.exitCode === 1 ? ', with failures' : ''}`)
