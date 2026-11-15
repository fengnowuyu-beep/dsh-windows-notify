/**
 * dsh-windows-notify - browser half.
 *
 * One job: the settings page registered into `settings.section`. Everything the
 * page shows is owned by the Host half - the effective document, the paths, and
 * the cue catalogue - so the two halves cannot disagree: the page never decides
 * what a sound reference means, and it never plays a cue itself (audition and
 * test both round-trip through the Host, which is what makes them trustworthy).
 */
window.__ModuleLoader__.load({
  id: 'dsh-windows-notify',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const React = react.default ?? react
    const { createElement: h, useCallback, useEffect, useMemo, useState } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'windows-notify'

    /** Host route family mounted by the Node half. */
    const ROUTE = '/windows-notify/api'

    /** The kinds, in display order. Mirrors the Host's EVENT_KINDS. */
    const KINDS = ['completion', 'error', 'approval', 'planReview', 'userQuestion', 'signIn']

    /**
     * Post one method to the plugin's host route family.
     * @param method - one of settings.get | settings.update | preview | test.
     * @param payload - JSON body.
     * @returns the unwrapped response payload.
     */
    async function callApi(method, payload) {
      let response
      try {
        response = await fetch(`${ROUTE}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {})
        })
      } catch (error) {
        throw new Error(`无法连接宿主插件路由，请确认插件已随 Harness 启动。(${String(error?.message ?? error)})`)
      }
      let data
      try {
        data = await response.json()
      } catch {
        data = undefined
      }
      if (!response.ok || data?.ok !== true) {
        throw new Error(data?.error?.message ?? `HTTP ${response.status}`)
      }
      return data
    }

    /** Resolve a catalogue label for the active locale. */
    function labelOf(label, locale) {
      if (typeof label === 'string') return label
      if (label === null || typeof label !== 'object') return ''
      if (locale.startsWith('zh') && typeof label.zh === 'string') return label.zh
      return typeof label.en === 'string' ? label.en : Object.values(label)[0] ?? ''
    }

    /**
     * Show the conversation a clicked notification belongs to.
     *
     * The click happened in a popup process, so the Host relays it down the
     * event stream and this is where it becomes navigation: `uiWorkspace`
     * exists only while the workspace UI is composed, so it is looked up on
     * every request rather than captured.
     * @param ctx - the Cordis browser context.
     * @param rawData - the stream's JSON payload.
     * @returns whether navigation was attempted.
     */
    function openConversation(ctx, rawData) {
      let request
      try {
        request = JSON.parse(rawData)
      } catch {
        return false
      }
      const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
      if (sessionId === '') return false
      // Only the window the user is actually looking at follows the click; a
      // background or minimised page must not navigate behind their back.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false
      const workspace = ctx.get?.('uiWorkspace')
      if (workspace === undefined || workspace === null) return false
      try {
        workspace.openSession(sessionId)
        return true
      } catch (error) {
        console.warn('windows-notify: could not open the clicked conversation:', error)
        return false
      }
    }

    /** The shape the page edits; the Host returns the same shape. */
    function emptyDraft() {
      return { enabled: true, childAgents: false, popupSeconds: 0, eventLog: false, events: {} }
    }

    /** Shortest auto-dismiss the slider offers, in seconds. */
    const POPUP_SECONDS_MIN = 3

    /** Longest auto-dismiss the slider offers, in seconds (its far right is "stay"). */
    const POPUP_SECONDS_MAX = 29

    /** Slider position that means "stay until dismissed". */
    const POPUP_ALWAYS_UI = 31

    /**
     * Present a stored lifetime. `0` is the rightmost "never disappear"
     * position; `1`/`2` are only reachable from a hand-edited document and are
     * shown as "stay" rather than snapped, so nobody's file is silently rewritten.
     */
    function durationLabel(seconds, t) {
      const value = Number(seconds)
      if (!Number.isFinite(value) || value < POPUP_SECONDS_MIN) return t('durationAlways')
      return `${Math.round(value)}s`
    }

    /** Map a stored lifetime onto its slider position. */
    function durationSlider(seconds) {
      const value = Number(seconds)
      // The far-right position is the "stay" sentinel, so a value outside the
      // auto-dismiss band (including 30 itself) maps there rather than to a
      // timer.
      if (!Number.isFinite(value) || value < POPUP_SECONDS_MIN || value > POPUP_SECONDS_MAX) {
        return POPUP_ALWAYS_UI
      }
      return Math.round(value)
    }

    /** Map a slider position back onto a stored lifetime (`0` = always). */
    function durationValue(slider) {
      return slider >= POPUP_ALWAYS_UI ? 0 : slider
    }

    /**
     * The settings page.
     * @param props - `t` from the slot's locale seat, `engine` from inject.
     */
    function SettingsSection(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const engine = props.engine ?? {}
      const engineState = engine.subscribe !== undefined
        ? React.useSyncExternalStore(engine.subscribe, engine.getSnapshot)
        : { locale: 'zh', lastError: '' }
      const locale = typeof engineState.locale === 'string' ? engineState.locale : 'zh'

      const [view, setView] = useState(null)
      const [draft, setDraft] = useState(emptyDraft())
      const [loaded, setLoaded] = useState(false)
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState(null)

      const load = useCallback(async () => {
        try {
          const data = await callApi('settings.get')
          const settings = data.settings
          setView(settings)
          setDraft({
            enabled: settings.enabled !== false,
            childAgents: settings.childAgents === true,
            popupSeconds: Number.isFinite(Number(settings.popupSeconds)) ? Number(settings.popupSeconds) : 0,
            eventLog: settings.eventLog === true,
            events: settings.events ?? {}
          })
          setLoaded(true)
        } catch (error) {
          setMessage({ kind: 'bad', text: `${t('loadFailed')}${String(error?.message ?? error)}` })
          setLoaded(true)
        }
      }, [t])

      useEffect(() => { void load() }, [load])

      /** Merge one event's partial change into the draft. */
      const patchEvent = (kind, fields) => {
        setDraft((current) => ({
          ...current,
          events: { ...current.events, [kind]: { ...(current.events[kind] ?? {}), ...fields } }
        }))
      }

      const save = async () => {
        setBusy('save')
        setMessage(null)
        try {
          const data = await callApi('settings.update', { settings: draft })
          setView(data.settings)
          setDraft({
            enabled: data.settings.enabled !== false,
            childAgents: data.settings.childAgents === true,
            popupSeconds: Number.isFinite(Number(data.settings.popupSeconds)) ? Number(data.settings.popupSeconds) : 0,
            eventLog: data.settings.eventLog === true,
            events: data.settings.events ?? {}
          })
          setMessage({ kind: 'ok', text: t('saved') })
        } catch (error) {
          setMessage({ kind: 'bad', text: `${t('saveFailed')}${String(error?.message ?? error)}` })
        } finally {
          setBusy('')
        }
      }

      /** Play one cue through the Host without raising a popup. */
      const audition = async (sound) => {
        setMessage(null)
        try {
          const data = await callApi('preview', { sound })
          setMessage({ kind: data.played === true ? 'ok' : 'bad', text: data.played === true ? t('previewed') : t('previewFailed') })
        } catch (error) {
          setMessage({ kind: 'bad', text: `${t('previewFailed')}${String(error?.message ?? error)}` })
        }
      }

      /** Raise one real popup for a kind, so the user sees and hears it. */
      const testKind = async (kind) => {
        setMessage(null)
        try {
          const data = await callApi('test', { kind })
          if (data.raised === true) {
            setMessage({ kind: 'ok', text: data.popupReady === true ? t('testSent') : t('testSentNoHost') })
          } else {
            setMessage({ kind: 'bad', text: t('testFailed') })
          }
        } catch (error) {
          setMessage({ kind: 'bad', text: `${t('testFailed')}${String(error?.message ?? error)}` })
        }
      }

      const soundOptions = useMemo(() => {
        const options = Array.isArray(view?.soundOptions) ? view.soundOptions : []
        return options.map(option => ({
          value: option.id,
          label: labelOf(option.label, locale),
          group: option.group
        }))
      }, [view, locale])

      const styles = useMemo(() => makeStyles(), [])

      if (!loaded) return h('div', { style: styles.muted }, t('loading'))

      const rows = KINDS.map((kind) => {
        const event = draft.events[kind] ?? {}
        const current = event.sound ?? ''
        const known = soundOptions.some(option => option.value === current)
        return h('div', { key: kind, style: styles.card },
          h('div', { style: styles.rowTop },
            h('label', { style: styles.switchWrap },
              h('input', {
                type: 'checkbox',
                checked: event.enabled === true,
                onChange: (e) => patchEvent(kind, { enabled: e.target.checked })
              }),
              h('span', { style: styles.kindName }, t(`kind.${kind}`))
            ),
            h('button', {
              type: 'button',
              style: styles.smallButton,
              disabled: busy !== '',
              onClick: () => { void testKind(kind) }
            }, t('test'))
          ),
          h('div', { style: styles.hint }, t(`kind.${kind}Hint`)),
          h('div', { style: styles.rowBottom },
            h('span', { style: styles.fieldLabel }, t('sound')),
            h('select', {
              style: styles.select,
              value: current,
              onChange: (e) => patchEvent(kind, { sound: e.target.value })
            },
            !known && current !== ''
              ? h('option', { key: 'unknown', value: current }, `${current}${t('notInCatalogue')}`)
              : null,
            soundOptions.map(option => h('option', { key: option.value, value: option.value }, option.label))
            ),
            h('button', {
              type: 'button',
              style: styles.smallButton,
              disabled: current === '',
              onClick: () => { void audition(current) }
            }, t('audition'))
          )
        )
      })

      return h('div', null,
        h('div', { style: styles.header },
          h('div', null,
            h('div', { style: styles.title }, t('title')),
            h('div', { style: styles.hint }, t('subtitle'))
          ),
          h('label', { style: styles.switchWrap },
            h('input', {
              type: 'checkbox',
              checked: draft.enabled === true,
              onChange: (e) => setDraft(current => ({ ...current, enabled: e.target.checked }))
            }),
            h('span', { style: styles.kindName }, t('enabled'))
          )
        ),

        h('div', { style: draft.enabled === true ? styles.rows : styles.rowsDisabled }, ...rows),

        h('div', { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('advanced')),
          h('div', { style: styles.rowBottom },
            h('span', { style: styles.fieldLabel }, t('popupSeconds')),
            h('input', {
              type: 'range',
              min: POPUP_SECONDS_MIN,
              max: POPUP_ALWAYS_UI,
              step: 1,
              value: durationSlider(draft.popupSeconds),
              style: styles.range,
              onChange: (e) => setDraft(current => ({ ...current, popupSeconds: durationValue(Number(e.target.value)) }))
            }),
            h('span', { style: styles.value }, durationLabel(draft.popupSeconds, t))
          ),
          h('div', { style: styles.hint }, t('popupSecondsHint')),
          h('label', { style: styles.checkRow },
            h('input', {
              type: 'checkbox',
              checked: draft.childAgents === true,
              onChange: (e) => setDraft(current => ({ ...current, childAgents: e.target.checked }))
            }),
            h('span', null, t('childAgents'))
          ),
          h('div', { style: styles.hint }, t('childAgentsHint')),
          h('label', { style: styles.checkRow },
            h('input', {
              type: 'checkbox',
              checked: draft.eventLog === true,
              onChange: (e) => setDraft(current => ({ ...current, eventLog: e.target.checked }))
            }),
            h('span', null, t('eventLog'))
          ),
          h('div', { style: styles.hint }, t('eventLogHint'))
        ),

        h('div', { style: styles.footer },
          h('button', {
            type: 'button',
            style: styles.primary,
            disabled: busy !== '',
            onClick: () => { void save() }
          }, busy === 'save' ? t('saving') : t('save')),
          h('button', {
            type: 'button',
            style: styles.smallButton,
            disabled: busy !== '',
            onClick: () => { void testKind('completion') }
          }, t('testAll')),
          message === null ? null : h('span', { style: message.kind === 'ok' ? styles.ok : styles.bad }, message.text)
        ),

        h('div', { style: styles.meta },
          h('div', null, `${t('popupHost')}: ${view?.popupReady === true ? t('ready') : t('missing')}`),
          h('div', null, `${t('fired')}: ${String(view?.firedCount ?? 0)}`),
          // Zero listening pages means click-to-open has nowhere to land, which
          // is the one failure a refresh fixes.
          h('div', null, `${t('pageCount')}: ${String(view?.pageCount ?? 0)}`),
          h('div', null, `${t('settingsFile')}: ${view?.settingsFile ?? ''}`),
          h('div', null, `${t('version')}: ${view?.pluginVersion ?? ''}`),
          view?.lastError ? h('div', { style: styles.bad }, view.lastError) : null,
          engineState.lastError ? h('div', { style: styles.bad }, engineState.lastError) : null
        )
      )
    }

    /** Style tokens with fallbacks, so a theme without them still renders. */
    function makeStyles() {
      return {
        header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '10px' },
        title: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #F2F4F7)' },
        subtitle: { marginTop: '4px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
        rows: { display: 'flex', flexDirection: 'column', gap: '10px' },
        rowsDisabled: { display: 'flex', flexDirection: 'column', gap: '10px', opacity: 0.5, pointerEvents: 'none' },
        card: { border: '1px solid var(--dsw-alias-border-l1, #3A3F47)', borderRadius: 'var(--dsw-radius-lg, 10px)', padding: '10px 12px', background: 'var(--dsw-alias-bg-layer-1, transparent)' },
        rowTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
        rowBottom: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', flexWrap: 'wrap' },
        switchWrap: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
        kindName: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #F2F4F7)' },
        hint: { marginTop: '4px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
        fieldLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #C9CDD4)', minWidth: '34px' },
        select: { flex: '1 1 180px', minWidth: '0', padding: '5px 8px', fontSize: '12px', borderRadius: 'var(--dsw-radius-md, 8px)', border: '1px solid var(--dsw-alias-border-l1, #3A3F47)', background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'var(--dsw-alias-label-primary, #F2F4F7)' },
        smallButton: { appearance: 'none', border: '1px solid var(--dsw-alias-border-l1, #3A3F47)', background: 'transparent', color: 'var(--dsw-alias-label-secondary, #C9CDD4)', font: 'inherit', fontSize: '12px', padding: '4px 10px', borderRadius: 'var(--dsw-radius-md, 8px)', cursor: 'pointer' },
        primary: { appearance: 'none', border: 'none', background: 'var(--dsw-alias-brand-primary, #4C8DFF)', color: '#0E1116', font: 'inherit', fontSize: '12px', fontWeight: 600, padding: '6px 14px', borderRadius: 'var(--dsw-radius-md, 8px)', cursor: 'pointer' },
        section: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--dsw-alias-border-l1, #3A3F47)' },
        sectionTitle: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #F2F4F7)', marginBottom: '8px' },
        checkRow: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', fontSize: '13px', color: 'var(--dsw-alias-label-primary, #F2F4F7)' },
        range: { flex: '1 1 160px' },
        value: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #C9CDD4)', minWidth: '32px', textAlign: 'right' },
        footer: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '14px', flexWrap: 'wrap' },
        meta: { marginTop: '12px', fontSize: '12px', lineHeight: '19px', color: 'var(--dsw-alias-label-tertiary, #8A9199)', wordBreak: 'break-all' },
        muted: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
        ok: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary, #34C08B)' },
        bad: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #F0616D)' }
      }
    }

    /** Dictionary keys, kept in one list so the two languages cannot drift. */
    const zh = {
      nav: 'Windows 通知',
      title: 'Windows 通知与提示音',
      subtitle: 'DSH 在对话完成、出错、等待你操作时弹出系统通知，并播放对应提示音。',
      loading: '正在读取设置…',
      enabled: '总开关',
      sound: '提示音',
      test: '测试',
      audition: '试听',
      notInCatalogue: '（目录外）',
      advanced: '高级',
      popupSeconds: '提示持续时间',
      durationAlways: '不消失',
      popupSecondsHint: '通知停留多久后自动消失；滑块拉到最右边为「不消失」，需要手动点击关闭。默认不消失。',
      childAgents: '子代理（子任务 / 团队）也通知',
      childAgentsHint: '默认关闭：子代理一轮对话内可能完成多次，会刷屏。',
      eventLog: '记录事件日志',
      eventLogHint: '把每次通知追加写入 windows-notify/events.log，便于排查。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，立即生效。',
      saveFailed: '保存失败：',
      loadFailed: '读取设置失败：',
      previewed: '已播放试听音效。',
      previewFailed: '试听失败：',
      testSent: '已弹出测试通知，请看屏幕右下角。',
      testSentNoHost: '已发送，但弹窗宿主未就绪，可能不会显示。',
      testFailed: '测试失败：',
      testAll: '测试通知外观',
      popupHost: '弹窗宿主',
      ready: '就绪',
      missing: '缺失',
      fired: '已发送通知',
      pageCount: '监听页面',
      settingsFile: '设置文件',
      version: '版本',
      'kind.completion': '对话完成',
      'kind.completionHint': '一轮回复结束、Agent 回到空闲时弹出。',
      'kind.error': '出错',
      'kind.errorHint': '模型请求或本轮回复失败时弹出，正文带错误摘要。',
      'kind.approval': '等待审批',
      'kind.approvalHint': '工具操作需要你批准（审批请求）时弹出。',
      'kind.planReview': '等待确认：计划评审',
      'kind.planReviewHint': '退出计划模式的评审问题等待你确认时弹出。',
      'kind.userQuestion': '等待回答：向你提问',
      'kind.userQuestionHint': '模型用 ask_user_question 向你提问时弹出。',
      'kind.signIn': '需要登录账号',
      'kind.signInHint': 'DeepSeek 账号登录失效、需要重新登录时弹出。'
    }

    const en = {
      nav: 'Windows notifications',
      title: 'Windows notifications and cues',
      subtitle: 'DSH raises a desktop notification with its own cue when a turn finishes, a turn fails, or something is waiting for you.',
      loading: 'Reading settings…',
      enabled: 'Master switch',
      sound: 'Cue',
      test: 'Test',
      audition: 'Audition',
      notInCatalogue: ' (not in catalogue)',
      advanced: 'Advanced',
      popupSeconds: 'Notification duration',
      durationAlways: 'stay',
      popupSecondsHint: 'How long a notification stays before it disappears on its own; the far right of the slider means it stays until you close it. The default is "stay".',
      childAgents: 'Notify for child agents (subtasks / teams)',
      childAgentsHint: 'Off by default: a child can finish many times inside one parent turn.',
      eventLog: 'Write an event log',
      eventLogHint: 'Append every notification to windows-notify/events.log for troubleshooting.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved; it applies immediately.',
      saveFailed: 'Save failed: ',
      loadFailed: 'Could not read settings: ',
      previewed: 'Cue played.',
      previewFailed: 'Audition failed: ',
      testSent: 'Test notification raised - look at the bottom-right corner.',
      testSentNoHost: 'Sent, but the popup host is not ready, so it may not show.',
      testFailed: 'Test failed: ',
      testAll: 'Test the popup',
      popupHost: 'Popup host',
      ready: 'ready',
      missing: 'missing',
      fired: 'Notifications raised',
      pageCount: 'Listening pages',
      settingsFile: 'Settings file',
      version: 'Version',
      'kind.completion': 'Turn finished',
      'kind.completionHint': 'Fires when a turn ends and the agent returns to idle.',
      'kind.error': 'Failure',
      'kind.errorHint': 'Fires when a model request or the turn fails, with a short reason.',
      'kind.approval': 'Waiting for approval',
      'kind.approvalHint': 'Fires when a tool action needs your approval.',
      'kind.planReview': 'Waiting for plan review',
      'kind.planReviewHint': 'Fires when an exit-plan-mode review question waits for you.',
      'kind.userQuestion': 'Waiting for your answer',
      'kind.userQuestionHint': 'Fires when the model asks you a structured question.',
      'kind.signIn': 'Sign-in required',
      'kind.signInHint': 'Fires when the DeepSeek account needs signing in again.'
    }

    /** Cordis services this browser half needs. */
    const inject = ['slots', 'locale']

    /**
     * Mount the browser half.
     * @param ctx - the Cordis browser context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'windows-notify: dictionaries')

      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'windows-notify',
        order: 260,
        label: () => t('nav'),
        locale: NS
      }, SettingsSection)), 'windows-notify: settings page')

      // Click-to-open: a popup cannot reach this page, so the Host relays the
      // clicked conversation down this stream. EventSource reconnects on its
      // own, which also covers a Host that is still starting up.
      ctx.effect(() => {
        if (typeof EventSource !== 'function') return () => {}
        let source
        try {
          source = new EventSource(`${ROUTE}/events`)
        } catch {
          return () => {}
        }
        source.addEventListener('focus', (event) => {
          openConversation(ctx, event.data)
        })
        return () => {
          try { source.close() } catch { /* already closed */ }
        }
      }, 'windows-notify: click-to-open relay')
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    exports.__internals = {
      SettingsSection,
      KINDS,
      labelOf,
      openConversation,
      emptyDraft,
      durationLabel,
      durationSlider,
      durationValue,
      POPUP_ALWAYS_UI,
      POPUP_SECONDS_MIN,
      POPUP_SECONDS_MAX
    }

    return module.exports
  }
})
