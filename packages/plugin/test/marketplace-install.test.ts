import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchGitSource } from '../src/forge/marketplace-install.js'

const temporary: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-git-'))
  temporary.push(root)
  return root
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRepo(): { root: string; url: string; sha: string } {
  const root = tempRoot()
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'git-demo' }), 'utf8')
  mkdirSync(join(root, 'skills', 'one'), { recursive: true })
  writeFileSync(join(root, 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: One\n---\n\nOne.\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root })
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  return { root, url: pathToFileURL(root).href, sha }
}

// Each case runs real git (init, commit, clone): seconds, not milliseconds, on a busy machine.
describe('fetchGitSource', { timeout: 60_000 }, () => {
  it('clones and pins a git marketplace source into a cache', async () => {
    const repo = makeRepo()
    const cache = tempRoot()
    const root = await fetchGitSource({ kind: 'git', url: repo.url, sha: repo.sha, raw: {} }, cache)
    expect(existsSync(join(root, 'plugin.json'))).toBe(true)
    expect(existsSync(join(root, '.harness-forge-source.json'))).toBe(true)
    const second = await fetchGitSource({ kind: 'git', url: repo.url, sha: repo.sha, raw: {} }, cache)
    expect(second).toBe(root)
  })

  it('rejects a subpath escape', async () => {
    const repo = makeRepo()
    await expect(fetchGitSource(
      { kind: 'git', url: repo.url, sha: repo.sha, subpath: '../outside', raw: {} },
      tempRoot(),
    )).rejects.toThrow(/escapes/u)
  })
})
