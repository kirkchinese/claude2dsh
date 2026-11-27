/**
 * `pnpm e2e`: build and pack the plugin, install it into a throwaway DSH profile, run the smoke checks against a
 * real DSH with a scripted model, print a pass/fail table. Exits non-zero on any failure.
 * An optional argument filters the checks by name. `E2E_KEEP=1` keeps the sandbox for inspection; `E2E_LOGS=<dir>`
 * copies every session's requests, events and stderr there before the sandbox goes (CI uploads it on failure).
 */
import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { checks } from './checks.ts'
import { createProfile, createSandbox, killAll, packAll } from './dsh.ts'
import { renderTable, type Outcome } from './helpers.ts'

const filter = process.argv[2]
const sandbox = await createSandbox()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    killAll()
    sandbox.dispose()
    process.exit(130)
  })
}

const outcomes: Outcome[] = []
try {
  console.log(`DSH ${sandbox.dshVersion}; sandbox ${sandbox.root}`)
  const tarballs = await packAll(sandbox)
  await createProfile(sandbox, tarballs)
  for (const check of checks.filter(item => filter === undefined || item.name.includes(filter))) {
    const started = Date.now()
    try {
      outcomes.push({ name: check.name, ok: true, detail: await check.run(sandbox), ms: Date.now() - started })
    } catch (error: unknown) {
      outcomes.push({ name: check.name, ok: false, detail: (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ').slice(0, 300), ms: Date.now() - started })
    }
    const last = outcomes.at(-1)!
    console.log(`${last.ok ? 'ok  ' : 'FAIL'} ${last.name}`)
  }
} catch (error: unknown) {
  console.error(error)
  outcomes.push({ name: 'setup', ok: false, detail: error instanceof Error ? error.message.split('\n')[0]! : String(error), ms: 0 })
} finally {
  const logs = process.env['E2E_LOGS']
  if (logs !== undefined && existsSync(join(sandbox.root, 'logs'))) cpSync(join(sandbox.root, 'logs'), logs, { recursive: true })
  if (process.env['E2E_KEEP'] === '1') {
    killAll()
    console.log(`kept ${sandbox.root}`)
  } else {
    sandbox.dispose()
  }
}

console.log(`\n${renderTable(outcomes)}`)
process.exit(outcomes.length > 0 && outcomes.every(outcome => outcome.ok) ? 0 : 1)
