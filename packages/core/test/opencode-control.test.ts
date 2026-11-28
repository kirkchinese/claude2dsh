/**
 * Which OpenCode plugins OpenCode runs, as its `plugins` (V2) or `plugin` (V1) entries control them
 * (https://opencode.ai/docs/plugins/#control): discovery reports the ones it switches off as off, and one entry
 * that cannot be resolved is a warning, not the end of discovery.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultDiscoveryRoots, discoverPlugins, type DiscoveredPlugin } from '../src/discover.js'
import { scanOpenCodeProject, scanOpenCodeUser } from '../src/dialects/opencode/scan.js'
import { registerDialect } from '../src/dialects/registry.js'
import { networkShareOf, reachesNewShare } from '../src/paths.js'

const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** A plugin entry declaring its id the way OpenCode reads it, from the server part's `Plugin.define`. */
const defined = (id: string): string => `import { Plugin } from "@opencode/plugin"\n\nexport default Plugin.define({\n  id: "${id}",\n  async setup() {},\n})\n`

/**
 * A home with OpenCode's global config directory holding a plugin file (`acme.notes`), and an installed npm
 * package (`opencode-wakatime`, id `wakatime`), configured by `entries` under `key`.
 */
function home(entries: readonly unknown[], key: 'plugins' | 'plugin' = 'plugins'): { home: string; config: string; file: string; pkg: string } {
  const home = mkdtempSync(join(tmpdir(), 'harness-forge-opencode-control-'))
  temporary.push(home)
  const config = join(home, '.config', 'opencode')
  const file = join(config, 'plugins', 'notes.ts')
  write(file, defined('acme.notes'))
  const pkg = join(config, 'node_modules', 'opencode-wakatime')
  write(join(pkg, 'package.json'), JSON.stringify({ name: 'opencode-wakatime', main: 'index.js' }))
  write(join(pkg, 'index.js'), defined('wakatime'))
  write(join(config, 'opencode.json'), JSON.stringify({ [key]: ['opencode-wakatime', ...entries] }))
  return { home, config, file, pkg }
}

function opencode(home: string): { plugins: DiscoveredPlugin[]; warnings: readonly { readonly source: string; readonly message: string }[] } {
  const result = discoverPlugins(defaultDiscoveryRoots(home), { home })
  return { plugins: result.plugins.filter(plugin => plugin.source === 'opencode'), warnings: result.warnings }
}

/** Whether the plugin at `root` is listed as on (it must be listed). */
function state(plugins: readonly DiscoveredPlugin[], root: string): boolean {
  const plugin = plugins.find(found => found.root === root)
  if (plugin === undefined) throw new Error(`${root} is not listed`)
  return plugin.enabled !== false
}

describe('OpenCode plugin control entries', () => {
  for (const key of ['plugins', 'plugin'] as const) {
    it(`"-*" after the plugins switches every one off, listed as off (\`${key}\`)`, () => {
      const { home: dir, config, pkg } = home(['-*'], key)
      const { plugins } = opencode(dir)
      expect(state(plugins, pkg)).toBe(false)
      expect(state(plugins, config)).toBe(false)
      // Still listed, with what they hold.
      expect(plugins.find(plugin => plugin.root === config)?.components.code).toBe(1)
    })
  }

  it('applies entries in order: a plugin configured after "-*" is on, the plugins folder\'s file stays off', () => {
    const { home: dir, config, pkg } = home([])
    write(join(config, 'opencode.json'), JSON.stringify({ plugins: ['-*', 'opencode-wakatime'] }))
    const { plugins } = opencode(dir)
    expect(state(plugins, pkg)).toBe(true)
    expect(state(plugins, config)).toBe(false)
  })

  it('"*" switches every plugin on again', () => {
    const { home: dir, config, pkg } = home(['-*', '*'])
    const { plugins } = opencode(dir)
    expect(state(plugins, pkg)).toBe(true)
    expect(state(plugins, config)).toBe(true)
  })

  it('"-<id>" switches off the plugin with that id only, and a later "<id>" switches it on again', () => {
    const off = home(['-wakatime'])
    expect(state(opencode(off.home).plugins, off.pkg)).toBe(false)
    expect(state(opencode(off.home).plugins, off.config)).toBe(true)
    const again = home(['-wakatime', 'wakatime'])
    expect(state(opencode(again.home).plugins, again.pkg)).toBe(true)
  })

  it('"-<prefix>.*" switches off the ids with that prefix; a plugin file it switches off is left out of the person\'s own', () => {
    const { home: dir, config, file, pkg } = home(['-acme.*'])
    write(join(config, 'plugins', 'kept.ts'), defined('other.kept'))
    const { plugins } = opencode(dir)
    expect(state(plugins, pkg)).toBe(true)
    // Some of the person's files run: the plugin is on, and holds those only.
    expect(state(plugins, config)).toBe(true)
    const user = scanOpenCodeUser(dir)!
    expect(user.components.map(component => component.kind === 'code' ? component.entryPath : '')).toEqual([join(config, 'plugins', 'kept.ts')])
    expect(user.warnings.map(warning => warning.message).join('\n')).toContain(file)
  })

  it('reads the global config before a project\'s: the global "-*" switches off a project\'s plugins too, and the project\'s "*" back on', () => {
    const { home: dir } = home(['-*'])
    // `~/.opencode` is the `.opencode` of a session in the home folder: OpenCode reads it after the global config.
    const local = join(dir, '.opencode', 'plugins', 'local')
    write(join(local, 'index.ts'), defined('local'))
    expect(state(opencode(dir).plugins, local)).toBe(false)
    write(join(dir, '.opencode', 'opencode.json'), JSON.stringify({ plugins: ['*'] }))
    expect(state(opencode(dir).plugins, local)).toBe(true)
  })

  it('leaves the plugins a project\'s config switches off out of the project', () => {
    const project = mkdtempSync(join(tmpdir(), 'harness-forge-opencode-project-'))
    temporary.push(project)
    write(join(project, '.opencode', 'plugins', 'on.ts'), defined('on'))
    write(join(project, '.opencode', 'plugins', 'off.ts'), defined('off'))
    write(join(project, 'opencode.json'), JSON.stringify({ plugins: ['-off'] }))
    const { plugin, warnings } = scanOpenCodeProject(project)
    expect(plugin.components.filter(component => component.kind === 'code').map(component => component.name)).toEqual(['on'])
    expect(warnings.join('\n')).toContain(join(project, '.opencode', 'plugins', 'off.ts'))
  })
})

describe('an OpenCode plugin entry that cannot be resolved', () => {
  /** Skipped, named in a warning, and the other harnesses' plugins and the package beside it still found. */
  function expectSkipped(spec: string): void {
    const { home: dir, pkg } = home([spec])
    write(join(dir, '.claude', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Mine\n---\n\nMine.\n')
    const result = discoverPlugins(defaultDiscoveryRoots(dir), { home: dir })
    expect(result.plugins.some(plugin => plugin.source === 'claude-code')).toBe(true)
    expect(state(result.plugins.filter(plugin => plugin.source === 'opencode'), pkg)).toBe(true)
    expect(result.warnings).toEqual([expect.objectContaining({ source: 'opencode', message: expect.stringContaining(spec) })])
  }

  // An encoded slash is no path on any platform: `fileURLToPath` refuses it on POSIX and on Windows alike.
  it('is skipped with a warning naming it; the other plugins, of every harness, are still found', () => {
    expectSkipped('file:///a%2Fb')
  })

  // A file URL with a host is no path outside Windows, and on Windows a share it would sign in to: skipped everywhere.
  it('is a file URL with a host, on every platform', () => {
    expectSkipped('file://remotehost/plugin')
  })

  it('is any harness\'s: a record that throws costs that harness\'s plugins only, with a warning', () => {
    const { home: dir, pkg } = home([])
    const folder = join(dir, 'broken-harness')
    const unregister = registerDialect({
      id: 'broken', label: 'Broken', markers: [], scan: () => { throw new Error('unused') },
      discoveryRoots: () => [folder],
      harnessPlugins: { roots: () => [folder], list: () => { throw new Error('record unreadable') } },
    })
    try {
      const result = discoverPlugins(defaultDiscoveryRoots(dir), { home: dir })
      expect(state(result.plugins.filter(plugin => plugin.source === 'opencode'), pkg)).toBe(true)
      expect(result.warnings).toEqual([expect.objectContaining({ source: 'broken', message: expect.stringContaining('record unreadable') })])
    } finally {
      unregister()
    }
  })
})

describe('a path on a network share', () => {
  it('is told on Windows, in each spelling, and is never one elsewhere', () => {
    for (const path of ['\\\\host\\share\\plugin', '//host/share/plugin', '\\\\?\\UNC\\host\\share\\plugin', '\\\\HOST\\Share']) {
      expect(networkShareOf(path, 'win32'), path).toBe('\\\\host\\share')
    }
    expect(networkShareOf('\\\\.\\pipe\\x', 'win32')).toBe('\\\\.\\pipe\\x')
    expect(networkShareOf('C:\\Users\\me\\plugin', 'win32')).toBeUndefined()
    expect(networkShareOf('\\\\?\\C:\\Users\\me', 'win32')).toBeUndefined()
    expect(networkShareOf('//host/share/plugin', 'linux')).toBeUndefined()
  })

  it('is refused only when the configuration is not on that share already', () => {
    expect(reachesNewShare('\\\\evil\\x\\plugin', 'C:\\Users\\me\\.config\\opencode', 'win32')).toBe(true)
    expect(reachesNewShare('\\\\corp\\home\\me\\plugins\\a', '\\\\corp\\home\\me\\.config\\opencode', 'win32')).toBe(false)
    expect(reachesNewShare('\\\\other\\home\\a', '\\\\corp\\home\\me', 'win32')).toBe(true)
    expect(reachesNewShare('/home/me/plugins/a', '/home/me/.config/opencode', 'linux')).toBe(false)
  })
})
