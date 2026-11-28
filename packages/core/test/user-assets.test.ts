import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultDiscoveryRoots, discoverPlugins } from '../src/discover.js'
import { scanOpenCodeProject, scanOpenCodeUser } from '../src/dialects/opencode/scan.js'
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
      // A `/path` file rule in user settings anchors at ~/.claude.
      ruleRoot: claude,
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
    expect(installedClaudePlugins(home).plugins).toEqual([
      { key: 'demo@market', name: 'demo', marketplace: 'market', root: join(cache, '2.0.0'), version: '2.0.0', scope: 'user', enabled: false },
    ])
  })

  it('keeps each install\'s scope: the global view takes the user-scope install over a newer one of another project', () => {
    const home = tempHome()
    const cache = join(home, '.claude', 'plugins', 'cache', 'market', 'demo')
    claudePlugin(join(cache, '1.0.0'), 'demo')
    claudePlugin(join(cache, '2.0.0'), 'demo')
    const project = join(home, 'work', 'repo')
    write(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'demo@market': [
          { scope: 'user', installPath: join(cache, '1.0.0'), version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z' },
          { scope: 'project', projectPath: project, installPath: join(cache, '2.0.0'), version: '2.0.0', lastUpdated: '2026-03-01T00:00:00Z' },
        ],
        'only-here@market': [{ scope: 'local', projectPath: project, installPath: join(cache, '2.0.0'), version: '2.0.0' }],
      },
    }))
    // The project turns demo off for itself; that does not reach the user-scope install.
    write(join(project, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'demo@market': false } }))
    const managed = join(home, 'managed')
    expect(installedClaudePlugins(home, managed).plugins).toEqual([
      { key: 'demo@market', name: 'demo', marketplace: 'market', root: join(cache, '2.0.0'), version: '2.0.0', scope: 'project', projectPath: project, enabled: false },
      { key: 'demo@market', name: 'demo', marketplace: 'market', root: join(cache, '1.0.0'), version: '1.0.0', scope: 'user', enabled: true },
      { key: 'only-here@market', name: 'only-here', marketplace: 'market', root: join(cache, '2.0.0'), version: '2.0.0', scope: 'local', projectPath: project, enabled: true },
    ])
    const found = discoverPlugins([join(home, '.claude', 'plugins')], { home }).plugins.filter(plugin => plugin.origin === 'installed')
    expect(found.map(plugin => ({ root: plugin.root, enabled: plugin.enabled }))).toEqual([{ root: join(cache, '1.0.0'), enabled: true }])
  })

  it('resolves enabledPlugins in Claude Code\'s precedence for the global view: managed settings over user settings', () => {
    const home = tempHome()
    const cache = join(home, '.claude', 'plugins', 'cache', 'market')
    for (const name of ['blocked', 'forced', 'mine']) claudePlugin(join(cache, name, '1.0.0'), name)
    write(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: Object.fromEntries(['blocked', 'forced', 'mine'].map(name => [`${name}@market`, [{ scope: 'user', installPath: join(cache, name, '1.0.0') }]])),
    }))
    write(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'blocked@market': true, 'forced@market': false, 'mine@market': false } }))
    const managed = join(home, 'managed')
    write(join(managed, 'managed-settings.json'), JSON.stringify({ enabledPlugins: { 'blocked@market': false, 'forced@market': false } }))
    // Drop-in files merge after managed-settings.json, in name order.
    write(join(managed, 'managed-settings.d', '10-plugins.json'), JSON.stringify({ enabledPlugins: { 'forced@market': true } }))
    expect(Object.fromEntries(installedClaudePlugins(home, managed).plugins.map(plugin => [plugin.name, plugin.enabled]))).toEqual({ blocked: false, forced: true, mine: false })
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
    expect(named('settings')).toMatchObject([{ env: { APP: '1' }, permissions: { allow: ['Bash(npm test)'], deny: [], ask: [] }, ruleRoot: cwd }])
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

  it('discovers the user assets and the installed plugin once; marketplace offers are not plugins of the person\'s', () => {
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
    ])
    expect(result.plugins[1]).toMatchObject({ root: join(cache, '2.0.0'), enabled: true, marketplace: 'market' })
    // The marketplace is listed apart, to install from one plugin at a time.
    expect(result.marketplaces).toEqual([{ source: 'claude-code', name: 'market', root: market }])
  })

  it('lists only the Codex plugins config.toml installs, each read as Codex\'s, whatever manifests it carries', () => {
    const home = tempHome()
    const codex = join(home, '.codex')
    const cache = join(codex, 'plugins', 'cache')
    // Installed: two versions cached and a `latest` link; a Claude manifest beside the Codex one.
    const installed = join(cache, 'bundled', 'review')
    write(join(installed, '1.0.0', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'review', version: '1.0.0' }))
    write(join(installed, '2.0.0', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'review', version: '2.0.0' }))
    write(join(installed, '2.0.0', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'review', version: '2.0.0' }))
    write(join(installed, '2.0.0', 'skills', 'look', 'SKILL.md'), '---\nname: look\ndescription: d\n---\n\nLook.\n')
    const past = new Date('2026-01-01T00:00:00Z')
    utimesSync(join(installed, '1.0.0'), past, past)
    symlinkSync(join(installed, '2.0.0'), join(installed, 'latest'), 'junction')
    // Switched off in Codex, but installed: listed, not enabled.
    write(join(cache, 'bundled', 'quiet', '0.1.0', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'quiet' }))
    // Cached offers never installed: a portable root plugin.json with skills, and a plugin with every harness's manifest.
    write(join(cache, 'curated', 'canva', '17.0.3', 'plugin.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'canva' }))
    write(join(cache, 'curated', 'canva', '17.0.3', 'skills', 'design', 'SKILL.md'), '---\nname: design\ndescription: d\n---\n\nDesign.\n')
    claudePlugin(join(cache, 'ponytail', 'ponytail', '5.1.0'), 'ponytail')
    write(join(cache, 'ponytail', 'ponytail', '5.1.0', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'ponytail' }))
    const market = join(home, 'markets', 'bundled')
    write(join(market, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'bundled', plugins: [] }))
    write(join(codex, 'config.toml'), [
      '[marketplaces.bundled]', 'source_type = "local"', `source = ${JSON.stringify(market)}`, '',
      '[marketplaces.gone]', 'source_type = "local"', `source = ${JSON.stringify(join(home, 'missing'))}`, '',
      '[plugins."review@bundled"]', 'enabled = true', '',
      '[plugins."quiet@bundled"]', 'enabled = false', '',
      '[plugins."absent@bundled"]', 'enabled = true', '',
    ].join('\n'))
    const previous = process.env['CODEX_HOME']
    delete process.env['CODEX_HOME']
    try {
      const result = discoverPlugins([join(codex, 'plugins')], { home })
      expect(result.plugins.filter(plugin => plugin.origin === 'installed').map(plugin => [plugin.name, plugin.source, plugin.version ?? '', plugin.enabled])).toEqual([
        ['quiet', 'codex', '', false],
        ['review', 'codex', '2.0.0', true],
      ])
      expect(result.plugins.find(plugin => plugin.name === 'review')).toMatchObject({ root: join(installed, '2.0.0'), marketplace: 'bundled' })
      expect(result.plugins.map(plugin => plugin.name)).not.toContain('canva')
      expect(result.plugins.map(plugin => plugin.name)).not.toContain('ponytail')
      expect(result.marketplaces).toEqual([{ source: 'codex', name: 'bundled', root: market }])
    } finally {
      if (previous !== undefined) process.env['CODEX_HOME'] = previous
    }
  })

  it('lists the OpenCode plugin packages right inside its plugins folder, not those deeper down', () => {
    const home = tempHome()
    const plugins = join(home, '.config', 'opencode', 'plugins')
    const pkg = (root: string, name: string): void => {
      write(join(root, 'package.json'), JSON.stringify({ name, dependencies: { '@opencode-ai/plugin': '1.0.0' } }))
      write(join(root, 'index.ts'), 'export const plugin = async () => ({})\n')
    }
    pkg(join(plugins, 'loaded'), 'loaded')
    pkg(join(plugins, 'vendor', 'nested'), 'nested')
    const result = discoverPlugins([plugins], { home })
    expect(result.plugins.map(plugin => [plugin.name, plugin.source, plugin.origin])).toEqual([['loaded', 'opencode', 'installed']])
  })
  it('finds OpenCode plugin files, package folders and configured packages through one inventory, with fake homes', () => {
    const home = tempHome()
    const config = join(home, '.config', 'opencode')
    const entry = 'export const plugin = async () => ({})\n'
    // Files placed right in the plugins folders, V2's `plugins/` and V1's `plugin/`; a file deeper down is a package's own.
    write(join(config, 'plugins', 'concise.ts'), entry)
    write(join(config, 'plugin', 'legacy.js'), entry)
    write(join(config, 'plugins', 'notes.md'), 'not a plugin\n')
    // A package directory without package.json, as OpenCode's docs show it.
    write(join(config, 'plugins', 'acme-package', 'index.ts'), entry)
    write(join(config, 'plugins', 'acme-package', 'lib', 'deep.ts'), entry)
    // Configured: a local directory relative to the config file, an npm package in the config directory's
    // node_modules, a scoped one in OpenCode's cache, and one not installed.
    const local = join(home, 'shared', 'local-plugin')
    write(join(local, 'index.ts'), entry)
    const npm = (root: string, name: string): void => {
      write(join(root, 'package.json'), JSON.stringify({ name, main: 'dist/index.js' }))
      write(join(root, 'dist', 'index.js'), entry)
    }
    npm(join(config, 'node_modules', 'opencode-wakatime'), 'opencode-wakatime')
    npm(join(home, '.cache', 'opencode', 'node_modules', '@acme', 'opencode-plugin'), '@acme/opencode-plugin')
    write(join(config, 'opencode.jsonc'), `{
      // V1 key, with a tuple entry and a trailing comma
      "plugin": ["opencode-wakatime@1.2.0", ["@acme/opencode-plugin", { "strict": true }], "../../shared/local-plugin", "not-installed", "-opencode.fork-notice",],
    }`)
    const result = discoverPlugins(defaultDiscoveryRoots(home), { home })
    const opencode = result.plugins.filter(plugin => plugin.source === 'opencode')
    expect(opencode.map(plugin => [plugin.origin, plugin.root]).sort()).toEqual([
      ['installed', join(config, 'node_modules', 'opencode-wakatime')],
      ['installed', join(config, 'plugins', 'acme-package')],
      ['installed', join(home, '.cache', 'opencode', 'node_modules', '@acme', 'opencode-plugin')],
      ['installed', local],
      ['user', config],
    ].sort())
    expect(opencode.every(plugin => plugin.components.code === 1 || (plugin.origin === 'user' && plugin.components.code === 2))).toBe(true)
    const user = scanOpenCodeUser(home)!
    expect(user.components.map(component => component.kind === 'code' ? component.entryPath : '')).toEqual([join(config, 'plugins', 'concise.ts'), join(config, 'plugin', 'legacy.js')])
  })

  it('reads a project\'s .opencode/plugin(s) files and its configured local packages through the same inventory', () => {
    const home = tempHome()
    const project = join(home, 'work', 'app')
    write(join(project, 'opencode.json'), JSON.stringify({ plugins: ['./plugins/local', { package: 'opencode-elsewhere' }] }))
    write(join(project, 'plugins', 'local', 'index.ts'), 'export {}\n')
    write(join(project, '.opencode', 'plugin', 'old.ts'), 'export {}\n')
    write(join(project, '.opencode', 'plugins', 'new.mjs'), 'export {}\n')
    const plugin = scanOpenCodeProject(project).plugin
    expect(plugin.components.map(component => [component.kind, component.name]).sort()).toEqual([['code', 'local'], ['code', 'new'], ['code', 'old'], ['other', 'opencode-elsewhere']])
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
