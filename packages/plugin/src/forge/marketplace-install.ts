/**
 * Git marketplace source fetcher. It is deliberately narrow: clone a URL,
 * optionally pin a ref/SHA, cache by content key, and return a local plugin
 * root. No arbitrary command sources and no lifecycle scripts are executed.
 * @module @kirkchinese/harness-forge
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  isInside,
  HarnessError,
  type MarketplaceSource,
} from '@kirkchinese/harness-forge-core'
import { messageOf } from '../shared/util.js'

const run = promisify(execFile)

/** Fetch one git marketplace source and return the plugin root inside it. */
export async function fetchGitSource(source: MarketplaceSource, cacheRoot: string): Promise<string> {
  if (source.kind !== 'git' || source.url === undefined) {
    throw new HarnessError('marketplace-failed', 'not a git marketplace source')
  }
  const url = source.url
  if (!/^(?:https:\/\/|file:\/\/|ssh:\/\/|git@)/u.test(url)) {
    throw new HarnessError('marketplace-failed', `unsupported git URL: ${url}`)
  }
  const key = createHash('sha256')
    .update(url)
    .update('\0')
    .update(source.ref ?? '')
    .update('\0')
    .update(source.sha ?? '')
    .digest('hex')
    .slice(0, 24)
  const target = join(cacheRoot, key)
  if (!existsSync(target)) {
    mkdirSync(cacheRoot, { recursive: true })
    const temporary = `${target}.tmp-${String(process.pid)}`
    rmSync(temporary, { recursive: true, force: true })
    try {
      const args = ['clone', '--depth', '1']
      if (source.ref !== undefined && source.sha === undefined) args.push('--branch', source.ref)
      args.push(url, temporary)
      await run('git', args, { timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
      if (source.sha !== undefined) {
        await run('git', ['-C', temporary, 'fetch', '--depth', '1', 'origin', source.sha], { timeout: 120_000, windowsHide: true })
        await run('git', ['-C', temporary, 'checkout', '--detach', 'FETCH_HEAD'], { timeout: 60_000, windowsHide: true })
      }
      writeFileSync(join(temporary, '.harness-forge-source.json'), `${JSON.stringify({ url, ref: source.ref, sha: source.sha, fetchedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
      rmSync(target, { recursive: true, force: true })
      renameSync(temporary, target)
    } catch (error: unknown) {
      rmSync(temporary, { recursive: true, force: true })
      throw new HarnessError('marketplace-failed', `git clone failed: ${messageOf(error)}`, {
        cause: error,
        suggestion: 'Check the repository URL, ref/SHA, and network access.',
      })
    }
  }
  const pluginRoot = source.subpath === undefined ? target : resolve(target, source.subpath)
  if (!isInside(target, pluginRoot)) {
    throw new HarnessError('path-escape', `marketplace subpath escapes the repository: ${source.subpath ?? ''}`)
  }
  return pluginRoot
}

