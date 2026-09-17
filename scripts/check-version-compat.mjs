#!/usr/bin/env node
// Compatibility gate: typecheck the plugin against one or more DSH source
// checkouts without installing them. Errors inside the DSH tree are ignored
// (its own dependencies are not installed); any error in a Claude2DSH file fails.
//
// Usage:
//   node scripts/check-version-compat.mjs <dsh-checkout> [<dsh-checkout> ...]
//   node scripts/check-version-compat.mjs --current        # newest checkout under the guidance root

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const scriptDir = dirname(new URL(import.meta.url).pathname)
const pluginRoot = resolve(scriptDir, '..')
const guidanceRoot = process.env.GUIDANCE_ROOT ?? join(process.env.HOME ?? '', 'dsh-agent-development-docs')

/** Newest `deepseek-harness-<version>` checkout in the guidance directory. */
function newestCheckout() {
  const entries = execFileSync('ls', [guidanceRoot], { encoding: 'utf8' }).split('\n')
    .filter((name) => /^deepseek-harness-\d/.test(name))
  const ranked = entries.map((name) => {
    const match = /^deepseek-harness-(\d+)\.(\d+)\.(\d+)(?:-(alpha|rc|beta)\.(\d+))?$/.exec(name)
    if (match === null) return undefined
    const [, major, minor, patch, stage, stageNumber] = match
    const stageRank = { alpha: 1, beta: 2, rc: 3 }[stage ?? ''] ?? 4
    return {
      name,
      rank: [Number(major), Number(minor), Number(patch), stageRank, stage === undefined ? 0 : Number(stageNumber)],
    }
  }).filter(Boolean)
  ranked.sort((left, right) => {
    for (let index = 0; index < left.rank.length; index++) {
      if (left.rank[index] !== right.rank[index]) return right.rank[index] - left.rank[index]
    }
    return 0
  })
  const newest = ranked[0]
  if (newest === undefined) throw new Error(`no deepseek-harness-<version> checkout under ${guidanceRoot}`)
  return join(guidanceRoot, newest.name)
}

const args = process.argv.slice(2)
const checkouts = args.includes('--current')
  ? [newestCheckout()]
  : args.filter((arg) => !arg.startsWith('--'))
if (checkouts.length === 0) {
  console.error('usage: check-version-compat.mjs <dsh-checkout> [...] | --current')
  process.exit(2)
}

const scratch = mkdtempSync(join(tmpdir(), 'claude2dsh-compat-'))
let failed = false
try {
  for (const checkoutArg of checkouts) {
    const checkout = resolve(checkoutArg)
    if (!existsSync(checkout)) {
      console.error(`FAIL ${checkout}: not a directory`)
      failed = true
      continue
    }
    const config = join(scratch, `tsconfig-${checkout.replaceAll('/', '_')}.json`)
    execFileSync('node', [join(scriptDir, 'make-compat-tsconfig.mjs'), checkout, config], { stdio: ['ignore', 'ignore', 'inherit'] })
    let output = ''
    try {
      output = execFileSync(join(pluginRoot, 'node_modules/.bin/tsc'), ['--project', config], { encoding: 'utf8' })
    } catch (error) {
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    }
    const version = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).version
    const own = output.split('\n').filter((line) => line.includes('error TS') && line.includes(pluginRoot))
    if (own.length === 0) {
      console.log(`COMPAT_OK ${version} (${checkout})`)
    } else {
      failed = true
      console.error(`COMPAT_FAIL ${version} (${checkout}): ${own.length} error(s) in Claude2DSH sources`)
      for (const line of own.slice(0, 40)) console.error(`  ${line.replace(`${pluginRoot}/`, '')}`)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
