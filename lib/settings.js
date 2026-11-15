/**
 * Settings contract for `dsh-windows-notify`.
 *
 * Four layers resolve into one live document, lowest first:
 *
 *   1. {@link DEFAULTS} - the shipped behaviour,
 *   2. the plugin's Loader `config:` block (profile-level defaults),
 *   3. `<dshHome>/windows-notify/settings.json` (what the DSH settings page writes).
 *
 * Everything is normalised on read, so a hand-edited file, a partial config
 * block, or an older document can never hand the notifier a malformed shape.
 *
 * @module dsh-windows-notify/settings
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** The notification kinds the plugin knows how to report, in settings-page order. */
export const EVENT_KINDS = ['completion', 'error', 'approval', 'planReview', 'userQuestion', 'signIn']

/** Bundled cue files shipped in `assets/`. */
export const BUNDLED_SOUNDS = ['complete', 'error', 'approval', 'confirm', 'question', 'login']

/**
 * Per-kind default: whether it notifies, and which cue it plays.
 * The six cues are deliberately distinguishable by ear - a soft two-tone for a
 * finished turn, a hard stop for a failure, a calendar chime for an approval
 * gate, a nudge for a plan review, mail for a question, and proximity for a
 * sign-in demand.
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  events: Object.freeze({
    completion: Object.freeze({ enabled: true, sound: 'bundled:complete' }),
    error: Object.freeze({ enabled: true, sound: 'bundled:error' }),
    approval: Object.freeze({ enabled: true, sound: 'bundled:approval' }),
    planReview: Object.freeze({ enabled: true, sound: 'bundled:confirm' }),
    userQuestion: Object.freeze({ enabled: true, sound: 'bundled:question' }),
    signIn: Object.freeze({ enabled: true, sound: 'bundled:login' })
  }),
  childAgents: false,
  // 0 means "stay on screen until dismissed" - the shipped default, because an
  // alert nobody saw is the same as no alert at all.
  popupSeconds: 0,
  timeoutMs: 90_000,
  eventLog: false
})

/** A `system:` sound id is a file name inside the system media directory. */
export const SYSTEM_MEDIA_DIR = 'C:\\Windows\\Media'

/**
 * The cue catalogue the settings page offers, so a deployment never has to
 * guess a reference. `bundled:` entries ship with the plugin; `system:` entries
 * are the Windows media cues, the ones Microsoft's own notifications use.
 */
export const SOUND_OPTIONS = Object.freeze([
  Object.freeze({ id: 'bundled:complete', group: 'bundled', label: { zh: '完成（柔和提示）', en: 'Finished (soft chime)' } }),
  Object.freeze({ id: 'bundled:error', group: 'bundled', label: { zh: '出错（低沉警报）', en: 'Failure (hard stop)' } }),
  Object.freeze({ id: 'bundled:approval', group: 'bundled', label: { zh: '审批（日历铃）', en: 'Approval (calendar)' } }),
  Object.freeze({ id: 'bundled:confirm', group: 'bundled', label: { zh: '确认（轻推）', en: 'Confirm (nudge)' } }),
  Object.freeze({ id: 'bundled:question', group: 'bundled', label: { zh: '提问（邮件提示）', en: 'Question (mail)' } }),
  Object.freeze({ id: 'bundled:login', group: 'bundled', label: { zh: '登录（邻近提示）', en: 'Sign-in (proximity)' } }),
  Object.freeze({ id: 'system:chimes.wav', group: 'system', label: { zh: '系统：chimes', en: 'System: chimes' } }),
  Object.freeze({ id: 'system:ding.wav', group: 'system', label: { zh: '系统：ding', en: 'System: ding' } }),
  Object.freeze({ id: 'system:notify.wav', group: 'system', label: { zh: '系统：notify', en: 'System: notify' } }),
  Object.freeze({ id: 'system:tada.wav', group: 'system', label: { zh: '系统：tada', en: 'System: tada' } }),
  Object.freeze({ id: 'system:Windows Notify System Generic.wav', group: 'system', label: { zh: '系统：通知（通用）', en: 'System: notification (generic)' } }),
  Object.freeze({ id: 'system:Windows Notify Email.wav', group: 'system', label: { zh: '系统：通知（邮件）', en: 'System: notification (email)' } }),
  Object.freeze({ id: 'system:Windows Notify Calendar.wav', group: 'system', label: { zh: '系统：通知（日历）', en: 'System: notification (calendar)' } }),
  Object.freeze({ id: 'system:Windows Critical Stop.wav', group: 'system', label: { zh: '系统：关键停止', en: 'System: critical stop' } }),
  Object.freeze({ id: 'system:Windows Exclamation.wav', group: 'system', label: { zh: '系统：感叹', en: 'System: exclamation' } }),
  Object.freeze({ id: 'system:Windows Message Nudge.wav', group: 'system', label: { zh: '系统：消息轻推', en: 'System: message nudge' } }),
  Object.freeze({ id: 'system:Windows Proximity Notification.wav', group: 'system', label: { zh: '系统：邻近通知', en: 'System: proximity' } }),
  Object.freeze({ id: 'none', group: 'none', label: { zh: '静音（只弹通知）', en: 'Silent (popup only)' } })
])

/**
 * Resolve the harness home the same way `@deepseek-ai/dsh-home-paths` does:
 * an explicit configured path, then `$DSH_HOME`, then `~/.dsh`. The Host process
 * does not inherit `$DSH_HOME` (only tool shells do), so the default must stand
 * on its own.
 * @param configured - optional `dshHome` from the plugin's own config.
 * @returns the harness home directory.
 */
export function resolveDshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** @returns the directory holding this plugin's runtime state. */
export function stateDir(dshHome) {
  return join(dshHome, 'windows-notify')
}

/** @returns the settings document path. */
export function settingsPath(dshHome) {
  return join(stateDir(dshHome), 'settings.json')
}

/** @returns the directory one-shot notification payloads are written to. */
export function payloadDir(dshHome) {
  return join(stateDir(dshHome), 'payloads')
}

/** @returns the optional append-only event log path. */
export function eventLogPath(dshHome) {
  return join(stateDir(dshHome), 'events.log')
}

/**
 * @returns the one-shot file a clicked popup writes to ask the Host to open a
 * conversation. A file is the transport because the click happens inside a
 * separate popup process that has no session of its own and no reason to know
 * the Host's listening port.
 */
export function focusPath(dshHome) {
  return join(stateDir(dshHome), 'focus.json')
}

/** Trim a value to a non-empty string, or return the fallback. */
function asText(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed
}

/**
 * A sound reference is one of four shapes; anything else is dropped rather than
 * handed to the popup, where it would silently disable the cue.
 * @param value - candidate sound reference.
 * @returns whether the popup can play it.
 */
export function isSoundReference(value) {
  if (typeof value !== 'string') return false
  if (value === 'none') return true
  if (value.startsWith('bundled:')) return BUNDLED_SOUNDS.includes(value.slice('bundled:'.length))
  if (value.startsWith('system:')) return value.slice('system:'.length).trim() !== ''
  if (isAbsolute(value) && value.toLowerCase().endsWith('.wav')) return true
  return false
}

/** Normalise one event's switch and cue. */
function normalizeEvent(raw, fallback) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const sound = asText(source.sound, '')
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    sound: isSoundReference(sound) ? sound : fallback.sound
  }
}

/** Shortest auto-dismiss the slider offers, in seconds. */
export const POPUP_SECONDS_MIN = 3

/** Longest auto-dismiss the slider offers, in seconds. */
export const POPUP_SECONDS_MAX = 30

/** The slider value that means "stay until dismissed". */
export const POPUP_ALWAYS = 0

/**
 * Coerce an arbitrary value into the settings contract.
 * @param raw - the candidate document or config object.
 * @returns a complete, valid settings object.
 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const rawEvents = source.events !== null && typeof source.events === 'object' ? source.events : {}
  const events = {}
  for (const kind of EVENT_KINDS) events[kind] = normalizeEvent(rawEvents[kind], DEFAULTS.events[kind])

  const timeout = Number(source.timeoutMs)
  const popupSeconds = Number(source.popupSeconds)
  // `0` is the "never auto-dismiss" position at the far right of the slider; a
  // positive value is an auto-dismiss delay. Anything else falls back.
  const popupValid = Number.isFinite(popupSeconds)
    && (popupSeconds === POPUP_ALWAYS
      || (popupSeconds >= POPUP_SECONDS_MIN && popupSeconds <= POPUP_SECONDS_MAX))

  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULTS.enabled,
    events,
    childAgents: typeof source.childAgents === 'boolean' ? source.childAgents : DEFAULTS.childAgents,
    dshHomeOverride: asText(source.dshHome, ''),
    popupSeconds: popupValid ? Math.round(popupSeconds) : DEFAULTS.popupSeconds,
    timeoutMs: Number.isFinite(timeout) && timeout >= 5_000 && timeout <= 300_000
      ? Math.round(timeout)
      : DEFAULTS.timeoutMs,
    eventLog: typeof source.eventLog === 'boolean' ? source.eventLog : DEFAULTS.eventLog
  }
}

/**
 * Read the persisted document. A missing or unreadable file yields the shipped
 * defaults rather than failing the plugin: a notifications plugin that cannot
 * start because its own settings are corrupt is worse than one with defaults.
 * @param logger - optional Cordis logger.
 * @param dshHome - resolved harness home.
 * @returns the normalised persisted document (not yet merged with config).
 */
export function loadPersisted(logger, dshHome) {
  const file = settingsPath(dshHome)
  try {
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    logger?.warn?.(`windows-notify: settings unreadable, using defaults: ${String(error)}`)
    return {}
  }
}

/**
 * Merge the layers into one live document.
 * @param persisted - whatever `settings.json` held.
 * @param configured - the Loader `config:` block.
 * @returns the effective settings.
 */
export function composeSettings(persisted, configured) {
  const base = normalizeSettings(configured ?? {})
  const stored = normalizeSettings(persisted ?? {})
  const events = {}
  for (const kind of EVENT_KINDS) {
    // The settings page always writes every key, so a persisted event replaces
    // the config one wholesale; a partial persisted event still falls back to
    // the config value field by field.
    const storedEvent = persisted?.events?.[kind]
    const hasStored = storedEvent !== null && typeof storedEvent === 'object'
    events[kind] = hasStored
      ? {
          enabled: typeof storedEvent.enabled === 'boolean' ? storedEvent.enabled : base.events[kind].enabled,
          sound: isSoundReference(storedEvent.sound) ? storedEvent.sound : base.events[kind].sound
        }
      : base.events[kind]
  }
  const hasStoredScalar = (key) => persisted !== null && typeof persisted === 'object' && persisted[key] !== undefined
  return {
    enabled: hasStoredScalar('enabled') ? stored.enabled : base.enabled,
    events,
    childAgents: hasStoredScalar('childAgents') ? stored.childAgents : base.childAgents,
    dshHomeOverride: hasStoredScalar('dshHome') ? stored.dshHomeOverride : base.dshHomeOverride,
    popupSeconds: hasStoredScalar('popupSeconds') ? stored.popupSeconds : base.popupSeconds,
    timeoutMs: hasStoredScalar('timeoutMs') ? stored.timeoutMs : base.timeoutMs,
    eventLog: hasStoredScalar('eventLog') ? stored.eventLog : base.eventLog
  }
}

/**
 * Resolve a sound reference to a concrete WAV path.
 * @param reference - one normalised `sound` value.
 * @param assetsDir - the plugin's bundled `assets` directory.
 * @returns the file path, or null when the cue is silent.
 */
export function resolveSound(reference, assetsDir) {
  if (typeof reference !== 'string' || reference === 'none') return null
  if (reference.startsWith('bundled:')) {
    const name = reference.slice('bundled:'.length)
    return BUNDLED_SOUNDS.includes(name) ? join(assetsDir, `${name}.wav`) : null
  }
  if (reference.startsWith('system:')) {
    const name = reference.slice('system:'.length).trim()
    if (name === '') return null
    return isAbsolute(name) ? name : join(SYSTEM_MEDIA_DIR, name)
  }
  return isAbsolute(reference) ? reference : null
}

/** Atomically persist the settings document. */
export async function savePersisted(document, dshHome) {
  const file = settingsPath(dshHome)
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/**
 * The settings projection the browser half consumes: the effective document,
 * plus everything the page needs to explain where it lives.
 * @param settings - effective settings.
 * @param dshHome - resolved harness home.
 * @param extras - live facts (bundled catalogue, popup path, host version).
 * @returns a JSON-safe view.
 */
export function publicSettings(settings, dshHome, extras = {}) {
  return {
    enabled: settings.enabled,
    events: settings.events,
    childAgents: settings.childAgents,
    popupSeconds: settings.popupSeconds,
    timeoutMs: settings.timeoutMs,
    eventLog: settings.eventLog,
    soundOptions: SOUND_OPTIONS,
    ...extras,
    settingsFile: settingsPath(dshHome),
    stateDir: stateDir(dshHome)
  }
}
