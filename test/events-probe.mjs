/**
 * Live probe for the click-to-open transport:
 *
 *   a real HTTP server running the plugin's own route handler
 *     + a real Server-Sent-Events client
 *     + a focus request written exactly like the popup writes it
 *   => the browser half would receive `event: focus` with the conversation id.
 *
 * This exercises the wire without needing the GUI: the page side of the same
 * stream is an `EventSource` on the same URL.
 *
 * Run manually: `npm run test:events`.
 */
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../lib/index.js'

const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const home = mkdtempSync(join(tmpdir(), 'dsh-wn-events-'))

/** Capture the plugin's registered route handler. */
const routes = []
const effects = []
const fakeCtx = {
  logger: { info: () => {}, warn: (m) => console.log('[warn]', m), debug: () => {} },
  get: () => undefined,
  on: () => {},
  effect: (factory) => {
    const disposer = factory()
    effects.push(disposer)
    return typeof disposer === 'function' ? disposer : () => {}
  },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {}
    }
  }
}

apply(fakeCtx, { dshHome: home })
if (routes.length !== 1) throw new Error(`expected one route, got ${routes.length}`)

const server = createServer((request, response) => {
  void routes[0].handler(request, response)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
console.log('plugin route served on 127.0.0.1:' + port)

const controller = new AbortController()
const stream = await fetch(`http://127.0.0.1:${port}/windows-notify/api/events`, {
  headers: { accept: 'text/event-stream' },
  signal: controller.signal
})
console.log('stream status:', stream.status, stream.headers.get('content-type'))
if (stream.status !== 200) {
  console.error('FAIL: the event stream was refused')
  process.exit(1)
}

const reader = stream.body.getReader()
const decoder = new TextDecoder()
let received = ''
const collect = (async () => {
  while (true) {
    const { value, done } = await reader.read()
    if (done) return
    received += decoder.decode(value, { stream: true })
    if (received.includes('event: focus')) return
  }
})()

// Give the Host a moment to register the page, then write the request the way a
// clicked card does (atomic write-then-rename).
await new Promise(resolve => setTimeout(resolve, 700))
const stateDir = join(home, 'windows-notify')
mkdirSync(stateDir, { recursive: true })
const request = { sessionId: 'session-sse-42', title: '修复登录超时', at: Date.now() }
writeFileSync(join(stateDir, 'focus.json.tmp'), JSON.stringify(request), 'utf8')
const { renameSync } = await import('node:fs')
renameSync(join(stateDir, 'focus.json.tmp'), join(stateDir, 'focus.json'))
console.log('focus request written')

const timedOut = await Promise.race([
  collect.then(() => false),
  new Promise(resolve => setTimeout(() => resolve(true), 5000))
])

const frame = received.split('\n\n').find(part => part.startsWith('event: focus')) ?? ''
let payload = null
try {
  payload = JSON.parse(frame.slice(frame.indexOf('data: ') + 6))
} catch { payload = null }

console.log('stream contained:', JSON.stringify(received.slice(0, 160)))
console.log('focus payload:', JSON.stringify(payload))

const passed = !timedOut
  && payload !== null
  && payload.sessionId === 'session-sse-42'

console.log(passed
  ? '\nPASS: a clicked card\'s request reaches the page over the event stream'
  : '\nFAIL: the page never received the focus event')

controller.abort()
for (const disposer of effects) {
  try { disposer() } catch { /* already disposed */ }
}
await new Promise(resolve => server.close(resolve))
rmSync(home, { recursive: true, force: true })
process.exit(passed ? 0 : 1)
