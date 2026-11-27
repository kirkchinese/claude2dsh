import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultDiscoveryRoots,
  detectDialect,
  detectSource,
  dialectIds,
  discoverPlugins,
  registerDialect,
  scanPlugin,
  scanRoot,
  type Dialect,
} from '../src/index.js'

const temporary: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-dialects-'))
  temporary.push(root)
  return root
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function skill(folder: string, name: string): void {
  write(join(folder, name, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill\n---\n\nDo ${name}.\n`)
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('dialect registry', () => {
  it('registers the built-in dialects in detection order', () => {
    expect(dialectIds()).toEqual(['claude-code', 'codex', 'opencode', 'agent-plugins', 'agent-skills'])
  })

  it('prefers a manifest over a bare layout, and a layout over the common formats', () => {
    const root = tempRoot()
    const both = join(root, 'both')
    write(join(both, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'both' }))
    skill(join(both, 'skills'), 'one')
    expect(detectSource(both)).toBe('codex')
    const layout = join(root, 'layout')
    write(join(layout, 'plugin.json'), JSON.stringify({ name: 'layout' }))
    skill(join(layout, 'skills'), 'one')
    expect(detectSource(layout)).toBe('claude-code')
    expect(detectSource(join(root, 'empty'))).toBe('agent-plugins')
  })

  it('lets a community dialect claim a folder through the same interface', () => {
    const root = tempRoot()
    write(join(root, 'ext', 'toy-extension.json'), JSON.stringify({ name: 'toy' }))
    const toy: Dialect = {
      id: 'toy',
      label: 'Toy',
      markers: [{ tier: 'manifest', test: directory => detectToy(directory) }],
      scan: root => scanPlugin(root, { source: 'toy', name: 'toy' }).plugin,
      discoveryRoots: home => [join(home, '.toy', 'extensions')],
    }
    const unregister = registerDialect(toy)
    try {
      expect(dialectIds()).toContain('toy')
      expect(detectDialect(join(root, 'ext'))?.id).toBe('toy')
      expect(defaultDiscoveryRoots(root)).toContain(join(root, '.toy', 'extensions'))
      const found = discoverPlugins([root], { home: root })
      expect(found.plugins.map(plugin => [plugin.name, plugin.source])).toEqual([['toy', 'toy']])
      expect(() => registerDialect(toy)).toThrow(/already registered/u)
    } finally {
      unregister()
    }
    expect(dialectIds()).not.toContain('toy')
  })

  it('reads a source no dialect registers with the shared scanner', () => {
    const root = tempRoot()
    skill(join(root, 'skills'), 'one')
    expect(scanRoot(root, 'foreign').source).toBe('foreign')
  })
})

describe('agent-skills dialect', () => {
  it('reads a listed folder of SKILL.md skills and its MCP servers as one plugin', () => {
    const root = tempRoot()
    const folder = join(root, 'team-skills')
    skill(folder, 'review')
    skill(folder, 'release')
    write(join(folder, 'README.md'), '# Team skills\n')
    write(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'docs-server' } } }))

    expect(detectSource(folder)).toBe('agent-skills')
    const plugin = scanRoot(folder)
    expect(plugin).toMatchObject({ id: 'agent-skills:team-skills', source: 'agent-skills', name: 'team-skills' })
    expect(plugin.ref.manifestKind).toBe('agent-skills')
    expect(plugin.components.map(component => [component.kind, component.name]).sort()).toEqual([['mcp', 'docs'], ['skill', 'release'], ['skill', 'review']])
  })

  it('names a harness skills folder after its harness', () => {
    const root = tempRoot()
    const folder = join(root, '.gemini', 'skills')
    skill(folder, 'audit')
    expect(scanRoot(folder).name).toBe('gemini-skills')
    expect(defaultDiscoveryRoots(root)).toContain(folder)
    expect(defaultDiscoveryRoots(root)).not.toContain(join(root, '.agents', 'skills'))
  })

  it('is found only on a listed folder, never while walking below one', () => {
    const root = tempRoot()
    const listed = join(root, 'skills-folder')
    skill(listed, 'one')
    skill(join(root, 'projects', 'nested-skills'), 'two')

    expect(discoverPlugins([listed], { home: root }).plugins.map(plugin => [plugin.name, plugin.source])).toEqual([['skills-folder', 'agent-skills']])
    expect(discoverPlugins([join(root, 'projects')], { home: root }).plugins).toEqual([])
  })
})

function detectToy(directory: string): boolean {
  return existsSync(join(directory, 'toy-extension.json'))
}
