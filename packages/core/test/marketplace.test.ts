import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readMarketplace, MarketplaceError } from '../src/marketplace.js'
import { errorInfo } from '../src/contracts.js'

const temporary: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-market-'))
  temporary.push(root)
  return root
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('readMarketplace', () => {
  it('reads a Claude marketplace with relative, github and npm sources', () => {
    const root = tempRoot()
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'demo-market',
      description: 'Demo',
      owner: { name: 'Demo' },
      plugins: [
        { name: 'local-plugin', source: './plugins/local', category: 'core' },
        { name: 'github-plugin', source: { source: 'github', repo: 'acme/tools', sha: 'a'.repeat(40) } },
        { name: 'npm-plugin', source: { source: 'npm', package: '@acme/plugin', version: '1.2.3' } },
      ],
    }), 'utf8')

    const index = readMarketplace(root)
    expect(index.name).toBe('demo-market')
    expect(index.owner).toBe('Demo')
    expect(index.entries).toHaveLength(3)
    expect(index.entries[0]?.source).toMatchObject({ kind: 'path', path: join(root, 'plugins', 'local') })
    expect(index.entries[1]?.source).toMatchObject({ kind: 'git', url: 'https://github.com/acme/tools.git' })
    expect(index.entries[2]?.source).toMatchObject({ kind: 'npm', package: '@acme/plugin' })
  })

  it('reads a Codex marketplace with a local object source', () => {
    const root = tempRoot()
    mkdirSync(join(root, '.agents', 'plugins'), { recursive: true })
    writeFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
      name: 'codex-market',
      plugins: [
        { name: 'repo-helper', source: { source: 'local', path: './plugins/repo-helper' } },
      ],
    }), 'utf8')
    const index = readMarketplace(root)
    expect(index.entries[0]?.source).toMatchObject({ kind: 'path', path: join(root, 'plugins', 'repo-helper') })
  })

  it('keeps the marketplace error code for route callers', () => {
    expect(errorInfo(new MarketplaceError('manifest-not-found', 'missing')).code).toBe('manifest-not-found')
  })

  it('reports an escaping path instead of returning it', () => {
    const root = tempRoot()
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'escape-market',
      plugins: [{ name: 'escape', source: '../outside' }],
    }), 'utf8')
    const index = readMarketplace(root)
    expect(index.entries).toHaveLength(0)
    expect(index.warnings.some(warning => warning.includes('escapes'))).toBe(true)
  })
})
