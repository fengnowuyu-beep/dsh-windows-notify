// Raise two popups from the real notifier and dump what reached disk.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createNotifier } from '../lib/notifier.js'

const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const home = mkdtempSync(join(tmpdir(), 'dsh-wn-probe-'))

const notifier = createNotifier({
  assetsDir: join(scriptRoot, 'assets'),
  scriptPath: join(scriptRoot, 'scripts', 'notify.ps1'),
  launcherPath: join(scriptRoot, 'scripts', 'notify-launch.vbs'),
  payloadDir: join(home, 'payloads'),
  slotDir: join(home, 'slots'),
  ownerId: 'session-alpha',
  logger: console,
  getPopupSeconds: () => 0
})

console.log('start:', await notifier.start())

for (const [kind, accent, badge] of [['first', '#4C8DFF', 'ONE'], ['second', '#F2A93B', 'TWO']]) {
  notifier.notify({ kind, title: `probe ${kind}`, body: 'stacking probe', accent, badge, sound: 'none' })
}

await new Promise(resolve => setTimeout(resolve, 4000))

const payloadDir = join(home, 'payloads')
const slotDir = join(home, 'slots')
console.log('\npayload files:', existsSync(payloadDir) ? readdirSync(payloadDir) : '(none)')
for (const name of existsSync(payloadDir) ? readdirSync(payloadDir) : []) {
  const text = readFileSync(join(payloadDir, name), 'utf8').replace(/^\uFEFF/, '')
  const parsed = JSON.parse(text)
  console.log(`  ${name}: duration=${JSON.stringify(parsed.duration)} slotDir=${JSON.stringify(parsed.slotDir)} ownerId=${JSON.stringify(parsed.ownerId)}`)
}

console.log('\nslot files:', existsSync(slotDir) ? readdirSync(slotDir) : '(none)')
for (const name of existsSync(slotDir) ? readdirSync(slotDir) : []) {
  console.log(`  ${name} = ${readFileSync(join(slotDir, name), 'utf8').trim()}`)
}

notifier.dispose()
console.log('\ndone')
