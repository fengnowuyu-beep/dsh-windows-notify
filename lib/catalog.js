/**
 * The notification catalogue: one entry per thing the plugin reports.
 *
 * Each entry owns its presentation (accent, badge, default copy) and reads its
 * switch and cue from the settings document, so the settings page, the event
 * wiring and the self-test route all agree on the same six kinds by
 * construction.
 *
 * @module dsh-windows-notify/catalog
 */

/** Accent colours, one per kind, so a glance identifies the notification. */
const ACCENTS = Object.freeze({
  completion: '#34C08B',
  error: '#F0616D',
  approval: '#4C8DFF',
  planReview: '#F2A93B',
  userQuestion: '#7C6BF5',
  signIn: '#E0699B'
})

/** Short text badges: pure ASCII so no font or encoding can spoil the header. */
const BADGES = Object.freeze({
  completion: 'OK',
  error: '!',
  approval: 'OK?',
  planReview: 'PLAN',
  userQuestion: '?',
  signIn: 'KEY'
})

/** Clip a value for one notification line, collapsing whitespace. */
export function clip(value, max = 220) {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

/** A short, human-scannable session label. */
export function sessionLabel(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return 'DSH'
  return sessionId.slice(0, 8)
}

/**
 * Describe one failure. Provider failures arrive as `{ code, message }` or an
 * `Error`; anything else is stringified. The message is clipped hard because a
 * notification banner is not a log.
 */
export function describeError(error) {
  if (error === null || error === undefined) return ''
  if (typeof error === 'string') return clip(error, 180)
  if (error instanceof Error) return clip(error.message, 180)
  if (typeof error === 'object') {
    const message = typeof error.message === 'string' ? error.message : ''
    const code = typeof error.code === 'string' ? error.code : ''
    if (message !== '' && code !== '') return clip(`${code}: ${message}`, 180)
    if (message !== '') return clip(message, 180)
    if (code !== '') return clip(code, 180)
  }
  return clip(String(error), 180)
}

/**
 * Pick the request's display text for the active backend locale, preferring the
 * English copy and falling back to the first language present.
 * @param displayReason - the approval request's localized reasons.
 * @returns the text to show, or ''.
 */
export function pickDisplayReason(displayReason) {
  if (displayReason === null || typeof displayReason !== 'object') return ''
  if (typeof displayReason.en === 'string' && displayReason.en !== '') return displayReason.en
  for (const value of Object.values(displayReason)) {
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/**
 * Build the popup payload for one notification.
 * @param kind - catalogue key.
 * @param settings - effective settings.
 * @param context - `{ sessionId, title, detail }` gathered by the caller.
 * @returns the popup payload, or null when the kind is switched off.
 */
export function buildNotification(kind, settings, context = {}) {
  const entry = CATALOG[kind]
  if (entry === undefined) return null
  const event = settings.events[kind]
  if (settings.enabled !== true || event?.enabled !== true) return null

  const session = sessionLabel(context.sessionId)
  const title = typeof context.title === 'string' && context.title !== ''
    ? context.title
    : `${entry.title} · ${session}`
  const detail = clip(context.detail ?? '', entry.detailMax ?? 220)

  return {
    kind,
    title: clip(title, 90),
    body: detail === '' ? entry.defaultBody(session) : detail,
    accent: ACCENTS[kind],
    badge: BADGES[kind],
    sound: settings.events[kind].sound
  }
}

/**
 * The six kinds. `defaultBody` is the copy used when the caller has nothing
 * better (a completion with no readable prompt text, for example).
 */
export const CATALOG = Object.freeze({
  completion: Object.freeze({
    key: 'completion',
    label: { zh: '对话完成', en: 'Turn finished' },
    description: {
      zh: '一轮回复结束、Agent 回到空闲时弹出。',
      en: 'Fires when a turn ends and the agent returns to idle.'
    },
    title: '对话完成',
    defaultBody: () => 'DSH 已完成本轮回复，等待你的下一步指令。'
  }),
  error: Object.freeze({
    key: 'error',
    label: { zh: '出错', en: 'Failure' },
    description: {
      zh: '模型请求或会话转向失败时弹出，正文带错误摘要。',
      en: 'Fires when a model request or the turn itself fails, with a short reason.'
    },
    title: '出错',
    defaultBody: () => 'DSH 在本次回复中遇到错误。'
  }),
  approval: Object.freeze({
    key: 'approval',
    label: { zh: '等待审批', en: 'Waiting for approval' },
    description: {
      zh: '工具操作需要你批准（审批请求）时弹出。',
      en: 'Fires when a tool action needs your approval before it can run.'
    },
    title: '等待审批',
    defaultBody: () => '有工具操作在等待你的批准。'
  }),
  planReview: Object.freeze({
    key: 'planReview',
    label: { zh: '等待确认：计划评审', en: 'Waiting for plan review' },
    description: {
      zh: '退出计划模式的评审问题等待你确认时弹出。',
      en: 'Fires when an exit-plan-mode review question is waiting for your decision.'
    },
    title: '等待确认：计划评审',
    defaultBody: () => '计划评审正在等待你的确认。'
  }),
  userQuestion: Object.freeze({
    key: 'userQuestion',
    label: { zh: '等待回答：向你提问', en: 'Waiting for your answer' },
    description: {
      zh: '模型用 ask_user_question 向你提问时弹出。',
      en: 'Fires when the model asks you a structured question.'
    },
    title: '等待你的回答',
    defaultBody: () => 'DSH 有一个问题在等你的回答。'
  }),
  signIn: Object.freeze({
    key: 'signIn',
    label: { zh: '需要登录账号', en: 'Sign-in required' },
    description: {
      zh: 'DeepSeek 账号登录失效、需要重新登录时弹出。',
      en: 'Fires when the DeepSeek account session needs you to sign in again.'
    },
    title: '需要登录 DeepSeek 账号',
    defaultBody: () => '账号登录已失效，请在 DSH 中重新登录。'
  })
})
