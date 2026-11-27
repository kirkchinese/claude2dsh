import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverPlugins } from '../src/discover.js'
import { installedClaudePlugins, scanClaudeProjectAssets, scanClaudeUserAssets } from '../src/dialects/claude-code/user-assets.js'

const temporary: string[] = []

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-home-'))
  temporary.push(root)
  return root
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

function claudePlugin(root: string, name: string): void {
  write(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }))
  write(join(root, 'skills', `${name}-skill`, 'SKILL.md'), `---\nname: ${name}-skill\ndescription: d\n---\n\nBody.\n`)
}

describe('Claude Code user assets', () => {
  it('reads skills (linked ones too), commands, agents, output styles, settings, settings hooks and user MCP servers', () => {
    const home = tempHome()
    const claude = join(home, '.claude')
    write(join(claude, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Mine\n---\n\nMine.\n')
    const elsewhere = join(home, 'shared', 'linked')
    write(join(elsewhere, 'SKILL.md'), '---\nname: linked\ndescription: Linked\n---\n\nLinked.\n')
    symlinkSync(elsewhere, join(claude, 'skills', 'linked'), 'junction')
    write(join(claude, 'commands', 'deploy.md'), '---\ndescription: Deploy\n---\nDeploy $ARGUMENTS\n')
    write(join(claude, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews\n---\nYou review.\n')
    write(join(claude, 'output-styles', 'terse.md'), '---\nname: Terse\ndescription: Short\n---\nBe short.\n')
    write(join(claude, 'settings.json'), JSON.stringify({
      env: { API_BASE: 'https://example.test', LEVEL: 'high' },
      permissions: { allow: ['Bash(npm run *)'], deny: ['Bash(rm *)'], ask: ['Bash(git push *)'] },
      outputStyle: 'Terse',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
    }))
    write(join(home, '.claude.json'), JSON.stringify({ mcpServers: { codegraph: { type: 'stdio', command: 'codegraph', args: ['serve'] } }, projects: {} }))

    const plugin = scanClaudeUserAssets(home)
    expect(plugin?.id).toBe('claude-code:user')
    expect(plugin?.manifest['scope']).toBe('user')
    const byKind = (kind: string): string[] => (plugin?.components ?? []).filter(component => component.kind === kind).map(component => component.name).sort()
    expect(byKind('skill')).toEqual(['linked', 'mine'])
    expect(byKind('command')).toEqual(['deploy'])
    expect(byKind('agent')).toEqual(['reviewer'])
    expect(byKind('ui')).toEqual(['output-style-terse'])
    expect(byKind('mcp')).toEqual(['codegraph'])
    const settings = plugin?.components.find(component => component.kind === 'settings')
    expect(settings).toMatchObject({
      env: { API_BASE: 'https://example.test', LEVEL: 'high' },
      permissions: { allow: ['Bash(npm run *)'], deny: ['Bash(rm *)'], ask: ['Bash(git push *)'] },
      outputStyle: 'Terse',
    })
    const hooks = plugin?.components.find(component => component.kind === 'hooks')
    expect(hooks).toMatchObject({ events: ['PreToolUse'], handlerTypes: ['command'], metadata: { origin: 'settings' } })
    // User assets need no license decision.
    expect(plugin?.license).toBeUndefined()
  })

  it('returns nothing for an empty ~/.claude', () => {
    const home = tempHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    expect(scanClaudeUserAssets(home)).toBeUndefined()
  })

  it('lists installed plugins from installed_plugins.json with the enabled state and the newest existing version', () => {
    const home = tempHome()
    const cache = join(home, '.claude', 'plugins', 'cache', 'market', 'demo')
    claudePlugin(join(cache, '1.0.0'), 'demo')
    claudePlugin(join(cache, '2.0.0'), 'demo')
    write(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'demo@market': [
          { scope: 'user', installPath: join(cache, '1.0.0'), version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z' },
          { scope: 'user', installPath: join(cache, '2.0.0'), version: '2.0.0', lastUpdated: '2026-02-01T00:00:00Z' },
        ],
        'gone@market': [{ scope: 'user', installPath: join(cache, 'missing'), version: '1.0.0' }],
      },
    }))
    write(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'demo@market': false } }))
    expect(installedClaudePlugins(home)).toEqual([
      { key: 'demo@market', name: 'demo', marketplace: 'market', root: join(cache, '2.0.0'), version: '2.0.0', scope: 'user', enabled: false },
    ])
  })

  it('reads a project\'s assets from its directory and parents, settings from the directory alone, and project plus local MCP', () => {
    const home = tempHome()
    const repo = join(home, 'work', 'repo')
    const cwd = join(repo, 'packages', 'app')
    write(join(repo, '.claude', 'commands', 'git', 'log.md'), '---\ndescription: Log\n---\nShow the log\n')
    write(join(repo, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Repo reviewer\n---\nRepo reviewer.\n')
    write(join(repo, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm *)'] } }))
    write(join(cwd, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: App reviewer\n---\nApp reviewer.\n')
    write(join(cwd, '.claude', 'skills', 'app-skill', 'SKILL.md'), '---\nname: app-skill\ndescription: App\n---\n\nApp skill.\n')
    write(join(cwd, '.claude', 'settings.json'), JSON.stringify({ env: { APP: '1' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } }))
    write(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }))
    write(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'db-mcp' }, shared: { command: 'from-project' } } }))
    write(join(home, '.claude.json'), JSON.stringify({ projects: { [cwd.replace(/\\/gu, '/')]: { mcpServers: { shared: { command: 'from-local' } } } } }))

    const project = scanClaudeProjectAssets(cwd, home)
    expect(project?.manifest).toMatchObject({ scope: 'project', projectRoot: cwd })
    const named = (kind: string) => (project?.components ?? []).filter(component => component.kind === kind)
    expect(named('skill').map(component => component.name)).toEqual(['app-skill'])
    // DSH command names cannot hold `:`; the Claude name `git:log` is kept for hook matchers.
    expect(named('command').map(component => [component.name, (component as { invocationName?: string }).invocationName])).toEqual([['git-log', 'git:log']])
    // The nearest directory's agent wins.
    expect(named('agent').map(component => component.description)).toEqual(['App reviewer'])
    // Settings come from the session's directory only, not from the repository root.
    expect(named('settings')).toMatchObject([{ env: { APP: '1' }, permissions: { allow: ['Bash(npm test)'], deny: [], ask: [] } }])
    expect(named('hooks').map(component => component.name)).toEqual(['settings'])
    // A local server replaces the project server of the same name.
    expect(named('mcp').map(component => [component.name, (component as { command?: string }).command])).toEqual([['db', 'db-mcp'], ['shared', 'from-local']])
  })

  it('treats ~/.claude as user assets, not project assets, in the home directory', () => {
    const home = tempHome()
    write(join(home, '.claude', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Mine\n---\n\nMine.\n')
    expect(scanClaudeProjectAssets(home, home)).toBeUndefined()
    write(join(home, '.claude.json'), JSON.stringify({ projects: { [home]: { mcpServers: { ruflo: { command: 'ruflo' } } } } }))
    expect(scanClaudeProjectAssets(home, home)?.components.map(component => component.name)).toEqual(['ruflo'])
  })

  it('discovers the user assets, the installed plugin once and uninstalled marketplace offers', () => {
    const home = tempHome()
    const plugins = join(home, '.claude', 'plugins')
    write(join(home, '.claude', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Mine\n---\n\nMine.\n')
    const cache = join(plugins, 'cache', 'market', 'demo')
    claudePlugin(join(cache, '1.0.0'), 'demo')
    claudePlugin(join(cache, '2.0.0'), 'demo')
    write(join(plugins, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { 'demo@market': [{ scope: 'user', installPath: join(cache, '2.0.0'), version: '2.0.0' }] },
    }))
    const market = join(plugins, 'marketplaces', 'market')
    write(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'market', plugins: [{ name: 'demo', source: './plugins/demo' }, { name: 'extra', source: './plugins/extra' }] }))
    claudePlugin(join(market, 'plugins', 'demo'), 'demo')
    claudePlugin(join(market, 'plugins', 'extra'), 'extra')
    write(join(plugins, 'known_marketplaces.json'), JSON.stringify({ market: { source: { source: 'github', repo: 'x/market' }, installLocation: market } }))

    const result = discoverPlugins([plugins], { home })
    expect(result.plugins.map(plugin => [plugin.name, plugin.origin, plugin.version ?? ''])).toEqual([
      ['user', 'user', ''],
      ['demo', 'installed', '1.0.0'],
      ['extra', 'marketplace', '1.0.0'],
    ])
    expect(result.plugins[1]).toMatchObject({ root: join(cache, '2.0.0'), enabled: true, marketplace: 'market' })
  })
  it('discovers the user\'s assets when ~/.claude/plugins does not exist', () => {
    const home = tempHome()
    write(join(home, '.claude', 'skills', 'note', 'SKILL.md'), '---\nname: note\ndescription: Note\n---\n\nNote.\n')
    const plugins = join(home, '.claude', 'plugins')

    const result = discoverPlugins([plugins], { home })
    expect(result.plugins.map(plugin => [plugin.name, plugin.origin])).toEqual([['user', 'user']])
    expect(result.plugins[0]?.components.skill).toBe(1)
    expect(result.missingRoots).toEqual([plugins])
  })
})
