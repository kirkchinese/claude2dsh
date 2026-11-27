import { describe, expect, it } from 'vitest'
import { dependencyProblem, describeSpec, DEFAULT_MARKETPLACES, githubOf, githubTarball, gitTransport, isValidRef, marketplaceProblem, npmPage, pageOfSpec, parseMarketplace, parseRemoteInput, specIdentity, specOfSource, type MarketplaceSource } from '../src/index.js'

describe('parseRemoteInput', () => {
  it('reads GitHub shorthand with a ref or a subdirectory', () => {
    expect(parseRemoteInput('anthropics/claude-plugins-official')).toEqual({ kind: 'git', url: 'https://github.com/anthropics/claude-plugins-official.git', github: { owner: 'anthropics', repo: 'claude-plugins-official' } })
    expect(parseRemoteInput('acme/tools@v2')).toMatchObject({ kind: 'git', ref: 'v2' })
    expect(parseRemoteInput('acme/tools#main')).toMatchObject({ kind: 'git', ref: 'main' })
    expect(parseRemoteInput('github:acme/tools')).toMatchObject({ kind: 'git', github: { owner: 'acme', repo: 'tools' } })
    expect(parseRemoteInput('openai/plugins/plugins/figma')).toMatchObject({ kind: 'git', github: { owner: 'openai', repo: 'plugins' }, subpath: 'plugins/figma' })
    expect(parseRemoteInput(`acme/tools@${'a'.repeat(40)}`)).toMatchObject({ kind: 'git', sha: 'a'.repeat(40) })
  })

  it('reads GitHub web URLs, including a tree path and a link to a manifest', () => {
    expect(parseRemoteInput('https://github.com/acme/tools')).toMatchObject({ kind: 'git', url: 'https://github.com/acme/tools.git' })
    expect(parseRemoteInput('https://github.com/acme/tools.git')).toMatchObject({ kind: 'git', github: { repo: 'tools' } })
    expect(parseRemoteInput('https://github.com/acme/mono/tree/main/plugins/fmt')).toMatchObject({ kind: 'git', ref: 'main', subpath: 'plugins/fmt' })
    const manifest = parseRemoteInput('https://github.com/acme/market/blob/main/.claude-plugin/marketplace.json')
    expect(manifest).toMatchObject({ kind: 'git', ref: 'main' })
    expect((manifest as { subpath?: string }).subpath).toBeUndefined()
    expect(parseRemoteInput('git@github.com:acme/tools.git#dev')).toMatchObject({ kind: 'git', github: { owner: 'acme', repo: 'tools' }, ref: 'dev' })
  })

  it('reads other git URLs, hosted marketplace.json files, npm packages and local paths', () => {
    expect(parseRemoteInput('https://gitlab.example.com/team/plugins.git#v1')).toEqual({ kind: 'git', url: 'https://gitlab.example.com/team/plugins.git', ref: 'v1' })
    expect(parseRemoteInput('file:///srv/market')).toEqual({ kind: 'git', url: 'file:///srv/market' })
    expect(parseRemoteInput('git@gitlab.com:team/x.git')).toMatchObject({ kind: 'git', url: 'git@gitlab.com:team/x.git' })
    expect(parseRemoteInput('https://example.com/plugins/marketplace.json')).toEqual({ kind: 'json', url: 'https://example.com/plugins/marketplace.json' })
    expect(parseRemoteInput('opencode-wakatime')).toEqual({ kind: 'npm', package: 'opencode-wakatime' })
    expect(parseRemoteInput('opencode-wakatime@1.2.0')).toEqual({ kind: 'npm', package: 'opencode-wakatime', version: '1.2.0' })
    expect(parseRemoteInput('@acme/opencode-plugin@^2')).toEqual({ kind: 'npm', package: '@acme/opencode-plugin', version: '^2' })
    expect(parseRemoteInput('npm:acme')).toEqual({ kind: 'npm', package: 'acme' })
    expect(parseRemoteInput('https://www.npmjs.com/package/@acme/thing')).toEqual({ kind: 'npm', package: '@acme/thing' })
    expect(parseRemoteInput('/home/me/market')).toEqual({ kind: 'local', path: '/home/me/market' })
    expect(parseRemoteInput('./market')).toEqual({ kind: 'local', path: './market' })
    expect(parseRemoteInput('~/.claude/plugins/marketplaces/x')).toMatchObject({ kind: 'local' })
    expect(parseRemoteInput('C:\\plugins\\x')).toMatchObject({ kind: 'local' })
  })

  it('refuses what names nothing', () => {
    expect(() => parseRemoteInput('   ')).toThrow(/nothing to fetch/u)
    expect(() => parseRemoteInput('Not A Package!')).toThrow(/not a repository/u)
    expect(() => parseRemoteInput('https://github.com/acme')).toThrow(/GitHub repository/u)
  })

  it('refuses URLs and refs git could read as options, and npm versions that are not registry lookups', () => {
    expect(() => parseRemoteInput('-oProxyCommand=x@host:repo')).toThrow()
    expect(() => parseRemoteInput('acme/tools@--upload-pack=touch')).toThrow(/branch, tag or commit/u)
    expect(() => parseRemoteInput('https://gitlab.example.com/a/b.git#-x')).toThrow(/branch, tag or commit/u)
    expect(() => parseRemoteInput('acme/tools#a..b')).toThrow(/branch, tag or commit/u)
    expect(() => parseRemoteInput('acme/tools/../x')).toThrow(/leaves the repository/u)
    expect(parseRemoteInput('left-pad@github:evil/x').kind).not.toBe('npm')
    expect(parseRemoteInput('left-pad@file:../x').kind).not.toBe('npm')
    expect(() => parseRemoteInput('npm:left-pad@file:../x')).toThrow(/npm package/u)
    expect(parseRemoteInput('left-pad@>=1.0.0 <2')).toEqual({ kind: 'npm', package: 'left-pad', version: '>=1.0.0 <2' })
  })
})

describe('git refs and transports', () => {
  it('accepts what git check-ref-format accepts, and nothing that starts with a dash', () => {
    for (const ok of ['main', 'v1.2.3', 'release/2026-11', 'refs/tags/v1', 'feature/x+y', 'user@thing']) expect(isValidRef(ok)).toBe(true)
    for (const bad of ['-x', '--upload-pack=x', 'a..b', 'a/', '/a', 'a.', 'a.lock', 'a/.b', 'a@{1}', 'a b', 'a:b', 'a~1', 'a^', 'a*', 'a\\b', '', '@', 'a//b']) expect(isValidRef(bad)).toBe(false)
  })

  it('names the transport of a URL', () => {
    expect(gitTransport('HTTPS://github.com/a/b')).toBe('https')
    expect(gitTransport('git@github.com:a/b.git')).toBe('ssh')
    expect(gitTransport('file:///x')).toBe('file')
    expect(gitTransport('ext::sh -c touch% /tmp/x')).toBeUndefined()
    expect(gitTransport('fd::3')).toBeUndefined()
    expect(gitTransport('/srv/repo')).toBeUndefined()
  })
})

describe('marketplace entry sources', () => {
  const root = '/market'
  const index = parseMarketplace({
    name: 'demo',
    metadata: { pluginRoot: './plugins', description: 'From metadata' },
    plugins: [
      { name: 'bare', source: 'bare' },
      { name: 'sub', source: { source: 'git-subdir', url: 'acme/mono', path: './tools/sub', ref: 'v1', sha: 'b'.repeat(40) } },
      { name: 'url', source: { source: 'url', url: 'https://gitlab.example.com/x/y.git' } },
      { name: 'pkg', source: { source: 'npm', package: '@acme/p', version: '^1', registry: 'https://npm.example.com' } },
      { name: 'zip', source: { source: 'archive', url: 'https://example.com/p.zip', sha256: 'C'.repeat(64) } },
      { name: 'cmd', source: { source: 'command', command: 'echo /tmp' } },
      { name: 'escape', source: { source: 'git-subdir', url: 'acme/mono', path: '../x' } },
      { name: 'skills', source: './', strict: false, skills: ['./skills/a'] },
    ],
  }, root)

  it('resolves each source form', () => {
    const by = new Map(index.entries.map(entry => [entry.name, entry]))
    expect(index.description).toBe('From metadata')
    expect(by.get('bare')?.source).toMatchObject({ kind: 'path', path: '/market/plugins/bare' })
    expect(specOfSource(by.get('sub')!.source)).toEqual({ kind: 'git', url: 'https://github.com/acme/mono.git', github: { owner: 'acme', repo: 'mono' }, ref: 'v1', sha: 'b'.repeat(40), subpath: 'tools/sub' })
    expect(specOfSource(by.get('url')!.source)).toEqual({ kind: 'git', url: 'https://gitlab.example.com/x/y.git' })
    expect(specOfSource(by.get('pkg')!.source)).toEqual({ kind: 'npm', package: '@acme/p', version: '^1', registry: 'https://npm.example.com' })
    expect(specOfSource(by.get('zip')!.source)).toEqual({ kind: 'archive', url: 'https://example.com/p.zip', sha256: 'c'.repeat(64) })
    expect(specOfSource(by.get('cmd')!.source)).toBeUndefined()
    expect(by.has('escape')).toBe(false)
    expect(index.warnings.some(warning => warning.includes('escapes'))).toBe(true)
    expect(by.get('skills')?.fields['skills']).toEqual(['./skills/a'])
  })

  it('cannot resolve relative entries of a marketplace.json fetched by URL', () => {
    const hosted = parseMarketplace({ name: 'hosted', plugins: [{ name: 'local', source: './x' }, { name: 'gh', source: { source: 'github', repo: 'a/b' } }] }, '/none', 'https://example.com/m.json', { filesAvailable: false })
    expect(hosted.entries[0]?.source.kind).toBe('unknown')
    expect(hosted.entries[1]?.source.kind).toBe('git')
    expect(hosted.warnings[0]).toMatch(/fetched by URL/u)
  })
})

describe('what a marketplace may name', () => {
  const git = (raw: Record<string, unknown>): MarketplaceSource => ({ kind: 'git', url: String(raw['url']), ...(raw['ref'] !== undefined ? { ref: String(raw['ref']) } : {}), ...(raw['sha'] !== undefined ? { sha: String(raw['sha']) } : {}), ...(raw['subpath'] !== undefined ? { subpath: String(raw['subpath']) } : {}), raw })
  const problem = (source: MarketplaceSource): string | undefined => {
    const spec = specOfSource(source)
    return spec === undefined ? 'unsupported' : marketplaceProblem(spec)
  }

  it('allows https git URLs, pinned or by a well-formed ref', () => {
    expect(problem(git({ url: 'https://gitlab.example.com/x/y.git', ref: 'v1' }))).toBeUndefined()
    expect(problem(git({ url: 'HTTPS://gitlab.example.com/x/y.git', sha: 'a'.repeat(40) }))).toBeUndefined()
  })

  it('refuses other transports, option-like refs, short SHAs, credentials and paths out of the repository', () => {
    expect(problem(git({ url: 'file:///etc' }))).toMatch(/only https/u)
    expect(problem(git({ url: 'ssh://git@host/x.git' }))).toMatch(/only https/u)
    expect(problem(git({ url: 'git@github.com:a/b.git' }))).toBeUndefined()
    expect(problem(git({ url: 'git@gitlab.com:a/b.git' }))).toMatch(/only https/u)
    expect(problem(git({ url: 'http://example.com/x.git' }))).toMatch(/only https/u)
    expect(problem(git({ url: 'ext::sh -c id' }))).toBeDefined()
    expect(problem(git({ url: 'ext::sh%20-c%20id' }))).toMatch(/only https/u)
    expect(problem(git({ url: '-oProxyCommand=id@h:x' }))).toBeDefined()
    expect(problem(git({ url: 'https://example.com/x.git', ref: '--upload-pack=id' }))).toMatch(/git accepts/u)
    expect(problem(git({ url: 'https://example.com/x.git', sha: 'abc123' }))).toMatch(/full 40-character/u)
    expect(problem(git({ url: 'https://u:p@example.com/x.git' }))).toMatch(/credentials/u)
    expect(problem(git({ url: 'https://example.com/x.git', subpath: '../x' }))).toMatch(/leaves/u)
  })

  it('keeps a full SHA given in the URL fragment as the pin', () => {
    const sha = 'c'.repeat(40)
    expect(specOfSource(git({ url: `https://gitlab.example.com/x/y.git#${sha}` }))).toMatchObject({ sha })
    expect(specOfSource(git({ url: `https://github.com/a/b.git#${sha}` }))).toMatchObject({ sha, github: { owner: 'a', repo: 'b' } })
  })

  it('allows only registry lookups for npm, and https registries and archives', () => {
    expect(marketplaceProblem({ kind: 'npm', package: 'x', version: 'github:a/b' })).toMatch(/not an npm version/u)
    expect(marketplaceProblem({ kind: 'npm', package: 'x', registry: 'http://10.0.0.1/' })).toMatch(/https npm registry/u)
    expect(marketplaceProblem({ kind: 'archive', url: 'http://example.com/a.zip' })).toMatch(/https/u)
    expect(marketplaceProblem({ kind: 'local', path: '/etc' })).toBeDefined()
  })

  it('refuses npm dependencies that are not registry lookups', () => {
    for (const ok of ['^1.2.0', '1.x', 'latest', '>=1 <2', '*', '', 'npm:other@^2', 'npm:@scope/x']) expect(dependencyProblem('d', ok)).toBeUndefined()
    for (const bad of ['git+https://github.com/a/b.git', 'github:a/b', 'a/b', 'file:../x', 'link:../x', 'workspace:*', 'https://example.com/x.tgz', 'npm:x@github:a/b']) expect(dependencyProblem('d', bad)).toMatch(/registry only/u)
  })

  it('keys sources by their full identity', () => {
    expect(specIdentity(parseRemoteInput('acme/mono/tools/a@v1'))).toBe('git:https://github.com/acme/mono.git//tools/a')
    expect(specIdentity({ kind: 'npm', package: '@a/b', registry: 'https://r.example/' })).toBe('npm:https://r.example/:@a/b')
  })
})

describe('source helpers', () => {
  it('names sources and their pages', () => {
    const spec = parseRemoteInput('acme/mono/tree-x@main')
    expect(describeSpec(spec)).toBe('github.com/acme/mono#main (tree-x)')
    expect(pageOfSpec(spec)).toBe('https://github.com/acme/mono/tree/main/tree-x')
    expect(npmPage('https://registry.npmjs.org', '@acme/p', '1.0.0')).toBe('https://www.npmjs.com/package/@acme/p/v/1.0.0')
    expect(npmPage('https://npm.example.com/r', '@acme/p', '1.0.0')).toBe('https://npm.example.com/r/@acme%2Fp')
    expect(githubOf('https://github.com/a/b.git')).toEqual({ owner: 'a', repo: 'b' })
    expect(githubOf('https://gitlab.com/a/b.git')).toBeUndefined()
    expect(githubTarball('a', 'b', 'feature/x')).toBe('https://codeload.github.com/a/b/tar.gz/feature/x')
  })

  it('lists only documented default marketplaces, each with its documentation', () => {
    expect(DEFAULT_MARKETPLACES.map(item => item.input)).toEqual(['anthropics/claude-plugins-official', 'anthropics/claude-plugins-community', 'anthropics/skills', 'anthropics/knowledge-work-plugins', 'openai/plugins'])
    for (const item of DEFAULT_MARKETPLACES) expect(item.docs).toMatch(/^https:\/\/(code\.claude\.com|developers\.openai\.com)\//u)
  })
})
