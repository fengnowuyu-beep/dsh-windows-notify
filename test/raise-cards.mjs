/**
 * Raise one or more real cards and keep the process alive so other probes can
 * inspect them. Used by the interaction and geometry probes.
 *
 *   node test/raise-cards.mjs [count=1] [seconds=25] [stateDir]
 *
 * Cards are raised through the same notifier the Host uses, so they carry a
 * payload the popup host reads exactly as it does in production.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createNotifier } from '../lib/notifier.js'

const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const count = Number(process.argv[2] ?? 1)
const seconds = Number(process.argv[3] ?? 25)
const stateDir = process.argv[4] ?? mkdtempSync(join(tmpdir(), 'dsh-wn-raise-'))

const notifier = createNotifier({
  assetsDir: join(scriptRoot, 'assets'),
  scriptPath: join(scriptRoot, 'scripts', 'notify.ps1'),
  launcherPath: join(scriptRoot, 'scripts', 'notify-launch.vbs'),
  payloadDir: join(stateDir, 'payloads'),
  slotDir: join(stateDir, 'slots'),
  stateDir,
  ownerId: `raise-${process.pid}`,
  logger: { info: () => {}, warn: (m) => console.log('[warn]', m), debug: () => {} },
  getPopupSeconds: () => 0
})

console.log('stateDir:', stateDir)
await notifier.start()

const accents = ['#4C8DFF', '#F2A93B', '#34C08B', '#7C6BF5']
for (let index = 0; index < count; index += 1) {
  notifier.notify({
    kind: 'completion',
    title: `raised card ${index + 1}/${count}`,
    body: 'raised by test/raise-cards.mjs',
    accent: accents[index % accents.length],
    badge: String(index + 1),
    sound: 'none',
    sessionId: `raised-session-${index + 1}`,
    ownerId: `raised-session-${index + 1}`
  })
  await new Promise(resolve => setTimeout(resolve, 700))
}

console.log(`${count} card(s) raised; staying up for ${seconds}s`)
setTimeout(() => process.exit(0), seconds * 1000)
