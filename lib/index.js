/**
 * dsh-windows-notify - Host half.
 *
 * Raises a Windows desktop notification (corner card + its own cue) when DSH
 * finishes a turn, fails, or starts waiting for the human - an approval, a plan
 * review, a structured question - or when the account needs signing in again.
 *
 * Design notes worth knowing before editing:
 *
 *  - **Completion is derived, not announced.** DSH publishes `agent/status`
 *    (`idle` / `running`) but no `turn ended` event, so a notification is only
 *    raised for a session this process actually watched run in, and only when
 *    the session log's newest event is a `turn/end` that has not been reported
 *    yet. That keeps a freshly created idle agent, a replayed log and an
 *    abandoned turn from firing a false "finished".
 *  - **Waiting is a waterfall, not a notification.** `approval/request` and
 *    `user-questions/request` are waterfall seams: a listener must return an
 *    outcome or delegate with `next()`. This plugin never decides anything - it
 *    observes and calls `next()`.
 *  - **Duplicates are real.** The loop emits `agent/error` again for every retry
 *    and on teardown, so every kind is de-duplicated per session on a cooldown.
 *
 * @module dsh-windows-notify
 */

import { readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildNotification, clip, describeError, pickDisplayReason, sessionLabel } from './catalog.js'
import { createNotifier } from './notifier.js'
import {
  EVENT_KINDS,
  composeSettings,
  eventLogPath,
  focusPath,
  loadPersisted,
  normalizeSettings,
  payloadDir,
  publicSettings,
  resolveDshHome,
  resolveSound,
  savePersisted,
  stateDir,
  settingsPath
} from './settings.js'

/**
 * Fallback popup lifetime, in seconds; `0` - the shipped value - means the card
 * stays until it is dismissed.
 */
const DEFAULT_POPUP_SECONDS = 0

/** Cordis services this Host half needs before it can mount its routes. */
export const inject = ['webServer']

/** The plugin's own version, surfaced to the settings page for support. */
export const PLUGIN_VERSION = '1.4.0'

/** Route family mounted on the Host webserver. */
export const ROUTE_PREFIX = '/windows-notify/api'

/**
 * The routes the browser half may POST to. `events` is a GET stream and is
 * handled before this list is consulted.
 */
const ROUTE_KEYS = ['settings.get', 'settings.update', 'preview', 'test', 'focus', 'status']

/** How long the same kind stays quiet for one session, in milliseconds. */
const COOLDOWNS = Object.freeze({
  completion: 4_000,
  error: 30_000,
  approval: 45_000,
  planReview: 45_000,
  userQuestion: 45_000,
  signIn: 60_000
})

/** Cap on remembered bookkeeping entries, so a long-lived Host cannot grow. */
const MAX_TRACKED = 512

/**
 * Bound a `Map` used as a small cache: dropping the oldest insertion keeps the
 * bookkeeping proportional to live work rather than to uptime.
 * @param map - the map to bound.
 */
function boundMap(map) {
  while (map.size > MAX_TRACKED) {
    const oldest = map.keys().next()
    if (oldest.done === true) return
    map.delete(oldest.value)
  }
}

/** One HTTP-level failure carrying its status. */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Write one JSON response. */
function writeJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

/** Loopback-only request fence, mirroring the /api gateway's posture. */
function isTrusted(request) {
  const remote = request?.socket?.remoteAddress
  if (typeof remote === 'string' && !isLoopbackAddress(remote)) return false
  const host = request?.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** Whether one address is loopback. */
function isLoopbackAddress(address) {
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  const candidate = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized
  const parts = candidate.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether one hostname names loopback. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  return isLoopbackAddress(hostname)
}

/** Read a JSON body with a hard size cap. */
async function readJsonBody(request, limit = 512_000) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'payload-too-large', 'request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad-json', 'request body is not valid JSON')
  }
}

/**
 * The live notification engine. Exposed for the offline test suite; the Loader
 * only needs {@link apply}.
 */
export class WindowsNotify {
  /**
   * @param options - resolved paths, the logger and the Loader config block.
   */
  constructor(options) {
    this.logger = options.logger
    this.config = options.config ?? {}
    this.dshHome = resolveDshHome(this.config.dshHome)
    this.scriptRoot = options.scriptRoot
    this.assetsDir = join(options.scriptRoot, 'assets')
    this.scriptPath = join(options.scriptRoot, 'scripts', 'notify.ps1')
    this.launcherPath = join(options.scriptRoot, 'scripts', 'notify-launch.vbs')
    this.payloadDir = payloadDir(this.dshHome)
    this.settingsFile = settingsPath(this.dshHome)
    this.stateDir = stateDir(this.dshHome)
    this.slotDir = join(this.stateDir, 'slots')
    this.eventLogFile = eventLogPath(this.dshHome)
    this.focusFile = focusPath(this.dshHome)
    /**
     * DSH's own Cordis context, captured in {@link apply}. Reading the session
     * title needs the `sessionTitle` service, which is optional: the log fold
     * below covers a composition that mounts titles by a different owner.
     */
    this.ctx = undefined

    this.persisted = loadPersisted(this.logger, this.dshHome)
    this.settings = composeSettings(this.persisted, this.config)

    /** Sessions this process has actually watched run. */
    this.ranThisProcess = new Set()
    /** Last `turn/end` sequence already reported, per session. */
    this.notifiedTurnEnd = new Map()
    /** Last fire time per `sessionId\0kind`. */
    this.lastFired = new Map()
    /** Audited approval requests still waiting for an answer, by call id. */
    this.pendingApprovals = new Map()
    /** Conversation name per session, so a burst of notifications folds once. */
    this.titleCache = new Map()
    /** Open Server-Sent-Events responses of GUI pages, for click-to-open. */
    this.eventClients = new Set()
    /** Wall clock of the last focus request this Host relayed. */
    this.lastFocusAt = 0
    /** The most recent focus request, replayed to a page that connects late. */
    this.pendingFocus = undefined
    /** How many notifications this Host has raised. */
    this.fired = 0
    /** The most recent failure the notifier reported, for the settings page. */
    this.lastError = ''

    // `createNotifier` is injectable so the offline test suite can assert what
    // would be raised without ever drawing a window.
    const makeNotifier = options.createNotifier ?? createNotifier
    this.notifier = makeNotifier({
      assetsDir: this.assetsDir,
      scriptPath: this.scriptPath,
      launcherPath: this.launcherPath,
      payloadDir: this.payloadDir,
      slotDir: this.slotDir,
      stateDir: this.stateDir,
      ownerId: `dsh-${process.pid}`,
      logger: this.logger,
      getPopupSeconds: () => this.popupSeconds
    })
  }

  /** @returns the popup lifetime in seconds; 0 means "stay until dismissed". */
  get popupSeconds() {
    const configured = Number(this.settings.popupSeconds)
    return Number.isFinite(configured) ? configured : DEFAULT_POPUP_SECONDS
  }

  /**
   * The conversation name shown in a notification header.
   *
   * `session/title` is the durable source of truth: the title service folds it,
   * and the log fold is the fallback for a composition that does not mount that
   * service. A session with no title yet (nothing eligible was said) falls back
   * to the sender's short id, so a header always carries something identifying.
   * @param session - the session whose name is wanted.
   * @param sessionId - its id, used for the fallback and the cache key.
   * @returns the display name, whitespace-collapsed and bounded.
   */
  conversationName(session, sessionId) {
    const key = String(sessionId)
    const cached = this.titleCache.get(key)
    if (cached !== undefined) return cached

    let title = ''
    try {
      const snapshot = this.ctx?.get?.('sessionTitle')?.get?.(session)
      if (typeof snapshot?.title === 'string') title = snapshot.title
    } catch (error) {
      this.logger?.debug?.(`windows-notify: title service read failed: ${String(error)}`)
    }
    if (title === '') {
      try {
        const events = session?.snapshotEvents ? session.snapshotEvents() : undefined
        if (Array.isArray(events)) {
          for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index]
            if (event?.type !== 'session/title') continue
            if (typeof event.data?.title === 'string') title = event.data.title
            break
          }
        }
      } catch (error) {
        this.logger?.debug?.(`windows-notify: title fold failed: ${String(error)}`)
      }
    }

    const name = clip(title, 40) === '' ? sessionLabel(sessionId) : clip(title, 40)
    this.titleCache.set(key, name)
    boundMap(this.titleCache)
    return name
  }

  /**
   * Whether this notification kind should skip one agent.
   * Child agents (subagents, team members) inherit the parent's stream and can
   * finish many times per parent turn, so they are opt-in.
   */
  skipAgent(agent) {
    if (this.settings.childAgents) return false
    const session = agent?.session
    const header = session?.header
    if (header === undefined || header === null) return false
    if (typeof header.parentSession === 'string' && header.parentSession !== '') return true
    if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
    return false
  }

  /** Append one line to the optional event log. */
  audit(entry) {
    if (this.settings.eventLog !== true) return
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`
    void appendFile(this.eventLogFile, line, 'utf8').catch(() => {})
  }

  /** Whether `kind` may fire for `sessionId` right now, and record it if so. */
  allow(kind, sessionId) {
    const key = `${String(sessionId)}\u0000${kind}`
    const now = Date.now()
    const previous = this.lastFired.get(key)
    if (previous !== undefined && now - previous < COOLDOWNS[kind]) return false
    this.lastFired.set(key, now)
    boundMap(this.lastFired)
    return true
  }

  /**
   * Present one notification.
   * @param kind - catalogue key.
   * @param context - `{ sessionId, title, detail }`.
   * @returns whether a popup was queued.
   */
  fire(kind, context = {}) {
    const notification = buildNotification(kind, this.settings, context)
    if (notification === null) return false
    const sessionId = typeof context.sessionId === 'string' ? context.sessionId : ''
    // The popup slot belongs to one conversation, so several sessions each keep
    // a card while a session's own next notification replaces its last one.
    notification.ownerId = sessionId !== '' ? `session:${sessionId}` : 'dsh'
    // A card for a real conversation is clickable: it opens that conversation.
    if (sessionId !== '' && sessionId !== 'account') notification.sessionId = sessionId
    const queued = this.notifier.notify(notification)
    if (queued) {
      this.fired += 1
      this.audit({ event: 'notify', kind, sessionId, sound: notification.sound })
    }
    return queued
  }

  /**
   * Relay one click-to-open request to every connected GUI page.
   *
   * The click happens inside a separate popup process, so the request travels
   * by file: the popup writes `focus.json`, the Host notices it here and pushes
   * it down the SSE route the plugin's browser half subscribes to. A page that
   * connects moments later still receives the most recent request.
   * @param request - `{ sessionId, title }`.
   * @returns how many pages were told.
   */
  broadcastFocus(request) {
    const payload = `event: focus\ndata: ${JSON.stringify(request)}\n\n`
    let delivered = 0
    for (const client of this.eventClients) {
      try {
        client.write(payload)
        delivered += 1
      } catch (error) {
        this.logger?.debug?.(`windows-notify: focus relay to a page failed: ${String(error)}`)
        this.eventClients.delete(client)
      }
    }
    this.pendingFocus = { ...request, at: Date.now() }
    this.audit({ event: 'focus', sessionId: request.sessionId ?? '', delivered })
    return delivered
  }

  /**
   * Read the popup's focus request, if the file changed since the last look.
   * A request older than a minute is ignored: it cannot belong to a click the
   * user just made, and replaying it would yank the GUI on startup.
   * @returns the accepted request, or undefined.
   */
  readFocusRequest() {
    let raw
    try {
      raw = readFileSync(this.focusFile, 'utf8')
    } catch {
      return undefined
    }
    let parsed
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    } catch {
      return undefined
    }
    const at = Number(parsed?.at)
    if (!Number.isFinite(at) || at <= this.lastFocusAt) return undefined
    this.lastFocusAt = at
    if (Date.now() - at > 60_000) return undefined
    if (typeof parsed?.sessionId !== 'string' || parsed.sessionId === '') return undefined
    return { sessionId: parsed.sessionId, title: clip(parsed.title ?? '', 60) }
  }

  /**
   * Poll the focus file while any page is listening.
   * @returns a disposer that stops the watcher.
   */
  watchFocusRequests() {
    const timer = setInterval(() => {
      if (this.eventClients.size === 0) return
      const request = this.readFocusRequest()
      if (request !== undefined) this.broadcastFocus(request)
    }, 400)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  /**
   * Attach one GUI page's event stream.
   * @param response - the open SSE response.
   * @returns a disposer that detaches it.
   */
  attachEvents(response) {
    this.eventClients.add(response)
    const pending = this.pendingFocus
    if (pending !== undefined && Date.now() - pending.at < 8_000) {
      try {
        response.write(`event: focus\ndata: ${JSON.stringify({ sessionId: pending.sessionId, title: pending.title })}\n\n`)
      } catch {
        // The page went away between writeHead and this write.
      }
    }
    const keepAlive = setInterval(() => {
      try {
        response.write(': keep-alive\n\n')
      } catch {
        clearInterval(keepAlive)
        this.eventClients.delete(response)
      }
    }, 25_000)
    keepAlive.unref?.()
    return () => {
      clearInterval(keepAlive)
      this.eventClients.delete(response)
    }
  }

  /**
   * Watch one agent's status transitions. Registered for every agent (including
   * children, which are filtered here so a settings change applies live).
   * @param payload - the `agent/status` payload.
   */
  onStatus(payload) {
    const agent = payload?.agent
    const session = agent?.session
    const sessionId = typeof agent?.id === 'string' ? agent.id : undefined
    if (sessionId === undefined) return

    if (payload.status === 'running') {
      this.ranThisProcess.add(sessionId)
      boundMap(this.ranThisProcess)
      return
    }
    if (payload.status !== 'idle') return
    if (!this.ranThisProcess.has(sessionId)) return
    if (this.skipAgent(agent)) return

    // A turn is only finished when the log's newest event closes one, and each
    // closed turn is reported at most once.
    let events
    try {
      events = session?.snapshotEvents ? session.snapshotEvents() : undefined
    } catch {
      events = undefined
    }
    if (!Array.isArray(events) || events.length === 0) return
    const last = events[events.length - 1]
    if (last?.type !== 'turn/end') return
    const seq = typeof last.seq === 'number' ? last.seq : -1
    if (this.notifiedTurnEnd.get(sessionId) === seq) return
    this.notifiedTurnEnd.set(sessionId, seq)
    boundMap(this.notifiedTurnEnd)
    if (!this.allow('completion', sessionId)) return

    this.fire('completion', {
      sessionId,
      title: `对话完成 · ${this.conversationName(session, sessionId)}`
    })
  }

  /**
   * Watch failures. The loop emits this once per failed attempt, and again from
   * teardown, so the cooldown is what keeps one broken turn to one popup.
   * @param payload - the `agent/error` payload.
   */
  onError(payload) {
    const agent = payload?.agent
    const sessionId = typeof agent?.id === 'string' ? agent.id : undefined
    if (sessionId === undefined) return
    if (this.skipAgent(agent)) return
    if (!this.allow('error', sessionId)) return
    const detail = describeError(payload?.error)
    this.fire('error', {
      sessionId,
      title: `出错 · ${this.conversationName(agent?.session, sessionId)}`,
      detail: detail === '' ? '' : detail
    })
  }

  /**
   * Watch a request for approval. The request is a waterfall payload; this
   * listener never answers it.
   * @param request - the approval request.
   */
  onApprovalRequest(request) {
    const agent = request?.agent
    const sessionId = typeof agent?.id === 'string' ? agent.id : undefined
    if (sessionId === undefined) return
    if (this.skipAgent(agent)) return

    const callId = typeof request?.callId === 'string' ? request.callId : undefined
    if (callId !== undefined) {
      this.pendingApprovals.set(callId, { sessionId, at: Date.now() })
      boundMap(this.pendingApprovals)
    }
    if (!this.allow('approval', sessionId)) return

    const tool = typeof request?.toolName === 'string' && request.toolName !== ''
      ? request.toolName
      : '工具操作'
    const reason = pickDisplayReason(request?.displayReason)
      || (typeof request?.reason === 'string' ? request.reason : '')
    this.fire('approval', {
      sessionId,
      title: `等待审批 · ${this.conversationName(agent?.session, sessionId)}`,
      detail: reason === '' ? `${tool} 正在等待你的批准。` : `${tool}：${reason}`
    })
  }

  /**
   * Watch a structured question. Plan review is the one tagged intent; every
   * other question is reported as a plain question.
   * @param request - the user-questions request.
   */
  onUserQuestions(request) {
    const agent = request?.agent
    const sessionId = typeof agent?.id === 'string' ? agent.id : undefined
    const questions = Array.isArray(request?.questions) ? request.questions : []
    const isPlanReview = questions.some(question => question?.intent?.kind === 'plan-review')

    if (sessionId !== undefined && this.skipAgent(agent)) return
    const kind = isPlanReview ? 'planReview' : 'userQuestion'
    if (sessionId === undefined) return
    if (!this.allow(kind, sessionId)) return

    const first = questions[0]
    const prompt = typeof first?.question === 'string'
      ? first.question
      : typeof first?.header === 'string' ? first.header : ''
    const count = questions.length
    this.fire(kind, {
      sessionId,
      title: `${isPlanReview ? '等待确认：计划评审' : '等待你的回答'} · ${this.conversationName(agent?.session, sessionId)}`,
      detail: prompt === ''
        ? (count > 1 ? `${count} 个问题在等待你的回答。` : '')
        : (count > 1 ? `${prompt}（共 ${count} 个问题）` : prompt)
    })
  }

  /** Watch the account's sign-in demand. */
  onSignInRequired() {
    if (!this.allow('signIn', 'account')) return
    this.fire('signIn', { sessionId: 'account' })
  }

  /** @returns the projection of this plugin's live state for the settings page. */
  describe() {
    return {
      ...publicSettings(this.settings, this.dshHome, {
        pluginVersion: PLUGIN_VERSION,
        popupScript: this.scriptPath,
        popupLauncher: this.launcherPath,
        popupReady: this.notifier.isReady(),
        pendingPopups: this.notifier.pending(),
        firedCount: this.fired,
        trackedSessions: this.ranThisProcess.size,
        // Click-to-open diagnostics: how many GUI pages are listening and when
        // the last click was relayed.
        pageCount: this.eventClients.size,
        lastFocusAt: this.lastFocusAt,
        focusFile: this.focusFile,
        lastError: this.lastError
      }),
      eventsOrder: EVENT_KINDS
    }
  }

  /** Persist a settings patch coming from the settings page. */
  async update(patch) {
    const requested = patch !== null && typeof patch === 'object' ? patch : {}
    const merged = {
      enabled: requested.enabled ?? this.settings.enabled,
      childAgents: requested.childAgents ?? this.settings.childAgents,
      popupSeconds: requested.popupSeconds ?? this.settings.popupSeconds,
      timeoutMs: requested.timeoutMs ?? this.settings.timeoutMs,
      eventLog: requested.eventLog ?? this.settings.eventLog,
      events: {}
    }
    for (const kind of EVENT_KINDS) {
      const current = this.settings.events[kind]
      const next = requested.events?.[kind]
      merged.events[kind] = {
        enabled: typeof next?.enabled === 'boolean' ? next.enabled : current.enabled,
        sound: typeof next?.sound === 'string' && next.sound !== '' ? next.sound : current.sound
      }
    }
    const normalized = normalizeSettings(merged)
    this.persisted = {
      enabled: normalized.enabled,
      childAgents: normalized.childAgents,
      popupSeconds: normalized.popupSeconds,
      timeoutMs: normalized.timeoutMs,
      eventLog: normalized.eventLog,
      events: normalized.events
    }
    await savePersisted(this.persisted, this.dshHome)
    this.settings = composeSettings(this.persisted, this.config)
    return this.settings
  }

  /**
   * Play one cue without raising a popup, so the settings page can compare
   * sounds quickly.
   * @param sound - a sound reference.
   * @returns whether a cue was played.
   */
  async preview(sound) {
    const reference = typeof sound === 'string' && sound !== ''
      ? sound
      : this.settings.events.completion.sound
    const resolved = resolveSound(reference, this.assetsDir)
    if (resolved === null) return false
    const notification = {
      kind: 'preview',
      title: '提示音试听',
      body: resolved,
      accent: '#4C8DFF',
      badge: 'TONE',
      sound: reference
    }
    return this.notifier.notify(notification)
  }

  /** Raise one real popup for a kind, for the settings page's test button. */
  test(kind) {
    const target = EVENT_KINDS.includes(kind) ? kind : 'completion'
    // The header shows a real conversation name in this shape, so the preview
    // matches what a notification will actually look like.
    const samples = {
      completion: { title: '对话完成 · 修复登录超时', detail: 'DSH 已完成本轮回复，等待你的下一步指令。' },
      error: { title: '出错 · 修复登录超时', detail: 'rate-limit: provider returned HTTP 429' },
      approval: { title: '等待审批 · 修复登录超时', detail: 'Write：写文件 dsh-windows-notify/lib/index.js' },
      planReview: { title: '等待确认：计划评审 · 重构通知模块', detail: 'Approve the plan to leave plan mode?' },
      userQuestion: { title: '等待你的回答 · 重构通知模块', detail: '要用哪种提示音方案？（共 2 个问题）' },
      signIn: { title: '需要登录 DeepSeek 账号', detail: '账号登录已失效，请在 DSH 中重新登录。' }
    }[target]
    // The self-test bypasses the cooldown and both switches deliberately:
    // pressing the button must always produce a popup, even for a kind the user
    // has switched off, so they can hear what they would be turning on.
    const forced = {
      ...this.settings,
      enabled: true,
      events: { ...this.settings.events, [target]: { ...this.settings.events[target], enabled: true } }
    }
    const notification = buildNotification(target, forced, {
      sessionId: 'test',
      title: samples.title,
      detail: samples.detail
    })
    if (notification === null) return false
    return this.notifier.notify(notification)
  }

  /** Start the notifier (sweep stale payloads, confirm the popup host exists). */
  async start() {
    const readiness = await this.notifier.start()
    if (readiness.ready !== true) {
      this.lastError = `弹窗宿主缺失：${this.scriptPath} / ${this.launcherPath}`
      this.logger?.warn?.(`windows-notify: ${this.lastError}`)
    }
    return readiness
  }

  /** Release every child process and every open event stream. */
  dispose() {
    this.notifier.dispose()
    for (const client of this.eventClients) {
      try { client.end() } catch { /* the page already went away */ }
    }
    this.eventClients.clear()
    this.ranThisProcess.clear()
    this.notifiedTurnEnd.clear()
    this.lastFired.clear()
    this.pendingApprovals.clear()
    this.titleCache.clear()
  }
}

/**
 * Mount the Host half.
 * @param ctx - the Cordis host context (provides `webServer`).
 * @param config - optional Loader config (`enabled`, `dshHome`, event defaults).
 */
export function apply(ctx, config) {
  if (config?.enabled === false) {
    ctx.logger?.info?.('windows-notify: disabled by config')
    return
  }

  const logger = ctx.logger ?? console
  const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const engine = new WindowsNotify({ logger, config, scriptRoot })
  // The title service is reached through the app context, so it is optional by
  // construction: a composition without it still notifies, using the log fold.
  engine.ctx = ctx

  ctx.effect(() => () => engine.dispose(), 'windows-notify: popup processes')
  ctx.effect(() => {
    void engine.start()
  }, 'windows-notify: popup host')

  // Event wiring. Agent-scoped events arrive for every scoped context, so the
  // filters live in the handlers, not in the registration.
  ctx.on('agent/status', payload => engine.onStatus(payload))
  ctx.on('agent/error', payload => engine.onError(payload))
  ctx.on('api-session/error', (sessionId, message) => {
    if (!engine.allow('error', sessionId)) return
    // This event carries only the id, so the live agent is resolved to reach
    // the conversation name; without one the short id stands in.
    const agent = ctx.get?.('agents')?.get?.(sessionId)
    engine.fire('error', {
      sessionId,
      title: `出错 · ${engine.conversationName(agent?.session, sessionId)}`,
      detail: describeError(message)
    })
  })
  ctx.on('approval/request', (request, next) => {
    try {
      engine.onApprovalRequest(request)
    } catch (error) {
      logger.warn?.(`windows-notify: approval observation failed: ${String(error)}`)
    }
    return next()
  })
  ctx.on('user-questions/request', (request, next) => {
    try {
      engine.onUserQuestions(request)
    } catch (error) {
      logger.warn?.(`windows-notify: question observation failed: ${String(error)}`)
    }
    return next()
  })
  ctx.on('deepseek-account/model-sign-in-required', () => {
    try {
      engine.onSignInRequired()
    } catch (error) {
      logger.warn?.(`windows-notify: sign-in observation failed: ${String(error)}`)
    }
  })

  // The settings page's transport, plus the event stream the page keeps open so
  // a clicked notification can reopen its conversation.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      if (!isTrusted(request)) {
        writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(`${ROUTE_PREFIX}/`)
        ? pathname.slice(ROUTE_PREFIX.length + 1)
        : undefined

      if (method === 'events') {
        if (request.method !== 'GET') {
          writeJson(response, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          // SSE is fenced to this origin, and the proxy-style header keeps
          // intermediaries from buffering the stream.
          'x-accel-buffering': 'no'
        })
        response.write(': connected\n\n')
        const detach = engine.attachEvents(response)
        request.on('close', detach)
        response.on('close', detach)
        return
      }

      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      if (method === undefined || !ROUTE_KEYS.includes(method)) {
        writeJson(response, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${String(method)}"` } })
        return
      }
      try {
        const payload = await readJsonBody(request)
        switch (method) {
          case 'settings.get':
            writeJson(response, 200, { ok: true, settings: engine.describe() })
            return
          case 'settings.update': {
            const next = await engine.update(payload?.settings ?? payload)
            writeJson(response, 200, { ok: true, settings: { ...engine.describe(), ...publicSettings(next, engine.dshHome) } })
            return
          }
          case 'preview': {
            const played = await engine.preview(payload?.sound)
            writeJson(response, 200, { ok: true, played })
            return
          }
          case 'test': {
            const raised = engine.test(payload?.kind)
            writeJson(response, 200, { ok: true, raised, popupReady: engine.notifier.isReady() })
            return
          }
          case 'focus': {
            // A popup may POST instead of writing the file; both paths land in
            // the same relay, so a click works whichever transport is available.
            const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
            if (sessionId === '') {
              writeJson(response, 400, { ok: false, error: { code: 'bad-request', message: 'sessionId is required' } })
              return
            }
            const delivered = engine.broadcastFocus({ sessionId, title: clip(payload?.title ?? '', 60) })
            writeJson(response, 200, { ok: true, delivered })
            return
          }
          case 'status':
            writeJson(response, 200, { ok: true, settings: engine.describe() })
            return
          default:
            writeJson(response, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
        }
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        const code = error instanceof HttpError ? error.code : 'internal-error'
        const message = error instanceof Error ? error.message : String(error)
        if (status >= 500) logger.warn?.(`windows-notify: ${method} failed: ${message}`)
        writeJson(response, status, { ok: false, error: { code, message } })
      }
    }
  }), 'windows-notify: settings routes')

  // Watch for clicked cards while a page is listening.
  ctx.effect(() => engine.watchFocusRequests(), 'windows-notify: focus requests')

  logger.info?.(`windows-notify: mounted ${ROUTE_PREFIX} (state: ${engine.stateDir})`)
}

/**
 * A closed-over inspector for `dsh-tool-cordis` and the offline test suite: the
 * Cordis tool passes no value, so this returns its caller's snapshot with every
 * method bound to a short-lived engine. It is deliberately side-effect free -
 * no route, no listener, no child process.
 * @param ctx - any context of the app.
 * @returns the inspectable projection.
 */
export const inspector = (ctx) => {
  const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const engine = new WindowsNotify({
    logger: ctx?.logger ?? console,
    config: {},
    scriptRoot
  })
  return {
    version: PLUGIN_VERSION,
    stateDir: engine.stateDir,
    settingsFile: engine.settingsFile,
    popupScript: engine.scriptPath,
    popupLauncher: engine.launcherPath,
    popupReady: engine.notifier.isReady(),
    assetsDir: engine.assetsDir,
    events: EVENT_KINDS,
    settings: normalizeSettings(engine.settings),
    describe: () => engine.describe(),
    preview: sound => engine.preview(sound),
    test: kind => engine.test(kind)
  }
}
