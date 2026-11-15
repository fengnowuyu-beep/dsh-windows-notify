/**
 * Offline test for the browser half.
 *
 * The client bundle is a plain script that registers itself on
 * `window.__ModuleLoader__`, so it can be loaded here with a small loader
 * double: no DOM, no bundler, no browser. That keeps the settings page's real
 * contract (which keys it registers, which methods it calls) under test.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** Minimal React double: enough for the slot to be registered and rendered. */
const reactDouble = {
  default: {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot()
  }
}

let registration = null
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      registration = entry
    }
  }
}

// eslint-disable-next-line no-eval
new Function('window', clientSource)(globalThis.window)

let passed = 0
const test = (name, body) => {
  try {
    body()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

test('the bundle registers exactly one module with the expected id', () => {
  assert.notEqual(registration, null)
  assert.equal(registration.id, 'dsh-windows-notify')
  assert.equal(typeof registration.factory, 'function')
})

const exports = registration.factory((name) => {
  if (name === 'react') return reactDouble
  throw new Error(`unexpected require(${name})`)
})

test('the module exports the Cordis plugin face', () => {
  assert.equal(exports.NS, 'windows-notify')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale'])
  assert.equal(typeof exports.__internals.SettingsSection, 'function')
})

test('apply() registers the dictionaries and the settings section', () => {
  const dictionaries = []
  const injections = []
  const registrations = []
  const effects = []
  const fakeCtx = {
    locale: {
      bind: (ns) => (key) => `${ns}:${key}`,
      register: (ns, dicts) => {
        dictionaries.push({ ns, dicts })
        return () => {}
      }
    },
    slots: {
      inject: (name, callback) => {
        injections.push(name)
        callback()
        return () => {}
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      }
    },
    effect: (factory, label) => {
      effects.push(label)
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    }
  }

  exports.apply(fakeCtx)

  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].ns, 'windows-notify')
  assert.deepEqual(Object.keys(dictionaries[0].dicts).sort(), ['en', 'zh'])
  assert.deepEqual(injections, ['settings.section'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'settings.section')
  assert.equal(registrations[0].options.id, 'windows-notify')
  assert.equal(registrations[0].options.locale, 'windows-notify')
  assert.equal(typeof registrations[0].options.label(), 'string')
  // Dictionaries, the settings page, and the click-to-open relay. Node has no
  // EventSource, so the relay registers a no-op disposer here.
  assert.equal(effects.length, 3)
})

test('both dictionaries carry every kind key and the same key set', () => {
  const dictionaries = []
  const fakeCtx = {
    locale: { bind: () => (key) => key, register: (ns, dicts) => { dictionaries.push(dicts); return () => {} } },
    slots: { inject: (name, callback) => { callback(); return () => {} }, register: () => () => {} },
    effect: (factory) => { factory(); return () => {} }
  }
  exports.apply(fakeCtx)
  const [dicts] = dictionaries
  const zhKeys = Object.keys(dicts.zh).sort()
  const enKeys = Object.keys(dicts.en).sort()
  assert.deepEqual(zhKeys, enKeys)
  for (const kind of exports.__internals.KINDS) {
    assert.equal(typeof dicts.zh[`kind.${kind}`], 'string', `zh missing kind.${kind}`)
    assert.equal(typeof dicts.zh[`kind.${kind}Hint`], 'string', `zh missing kind.${kind}Hint`)
    assert.equal(typeof dicts.en[`kind.${kind}`], 'string', `en missing kind.${kind}`)
    assert.equal(typeof dicts.en[`kind.${kind}Hint`], 'string', `en missing kind.${kind}Hint`)
  }
})

test('labelOf picks the active language and degrades to any value', () => {
  const { labelOf } = exports.__internals
  assert.equal(labelOf({ zh: '完成', en: 'Finished' }, 'zh-CN'), '完成')
  assert.equal(labelOf({ zh: '完成', en: 'Finished' }, 'en-US'), 'Finished')
  assert.equal(labelOf('plain', 'zh'), 'plain')
  assert.equal(labelOf(null, 'zh'), '')
})

test('the settings section renders without a host (loading state is safe)', () => {
  const { SettingsSection } = exports.__internals
  // No `engine` prop and no fetched document: the page must still return a React
  // element rather than throwing, which is what keeps the settings shell intact.
  const tree = SettingsSection({ t: (key) => key })
  assert.equal(tree.type, 'div')
  assert.equal(typeof tree.props.style, 'object')
  assert.equal(tree.children.length >= 1, true)
})

test('the duration slider puts "stay" at its far right', () => {
  const { durationSlider, durationValue, durationLabel, POPUP_ALWAYS_UI } = exports.__internals
  // The default - and the value the stored document uses for "never disappear".
  assert.equal(durationSlider(0), POPUP_ALWAYS_UI)
  assert.equal(durationValue(POPUP_ALWAYS_UI), 0)
  // A real lifetime in the auto-dismiss band round-trips exactly.
  for (const seconds of [3, 7, 15, 29]) {
    assert.equal(durationValue(durationSlider(seconds)), seconds)
  }
  // 30 is the "stay" position, not a 30-second timer.
  assert.equal(durationSlider(30), POPUP_ALWAYS_UI)
  assert.equal(durationValue(durationSlider(30)), 0)
  // Hand-edited 1/2 second values are shown as "stay" rather than rewritten.
  assert.equal(durationSlider(1), POPUP_ALWAYS_UI)
  assert.equal(durationSlider(2), POPUP_ALWAYS_UI)
  assert.equal(durationSlider(600), POPUP_ALWAYS_UI)

  const t = (key) => key
  assert.equal(durationLabel(0, t), 'durationAlways')
  assert.equal(durationLabel(1, t), 'durationAlways')
  assert.equal(durationLabel(9, t), '9s')
})

test('the empty draft defaults to a card that stays', () => {
  assert.equal(exports.__internals.emptyDraft().popupSeconds, 0)
})

test('a clicked notification opens its conversation', () => {
  const { openConversation } = exports.__internals
  const opened = []
  const ctx = { get: (key) => (key === 'uiWorkspace' ? { openSession: (id) => opened.push(id) } : undefined) }

  assert.equal(openConversation(ctx, JSON.stringify({ sessionId: 'session-abc' })), true)
  assert.deepEqual(opened, ['session-abc'])
})

test('a click is ignored when there is nothing to open', () => {
  const { openConversation } = exports.__internals
  const opened = []
  const ctx = { get: () => ({ openSession: (id) => opened.push(id) }) }

  assert.equal(openConversation(ctx, '{ not json'), false)
  assert.equal(openConversation(ctx, JSON.stringify({})), false)
  assert.equal(openConversation(ctx, JSON.stringify({ sessionId: '' })), false)
  assert.deepEqual(opened, [])
})

test('a click is ignored while the page is hidden', () => {
  const { openConversation } = exports.__internals
  const opened = []
  const ctx = { get: () => ({ openSession: (id) => opened.push(id) }) }
  globalThis.document = { visibilityState: 'hidden' }
  try {
    assert.equal(openConversation(ctx, JSON.stringify({ sessionId: 'session-abc' })), false)
    assert.deepEqual(opened, [])
  } finally {
    delete globalThis.document
  }
})

test('a click without the workspace service is ignored, not thrown', () => {
  const { openConversation } = exports.__internals
  const ctx = { get: () => undefined }
  assert.equal(openConversation(ctx, JSON.stringify({ sessionId: 'session-abc' })), false)
})

console.log(`\n${passed} test(s) passed${process.exitCode === 1 ? ', with failures' : ''}`)
