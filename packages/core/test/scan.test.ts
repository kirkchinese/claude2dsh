import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanPlugin } from '../src/manifest.js'
import { kebabCase, uniqueName } from '../src/naming.js'
import { parseSkillFrontmatter } from '../src/frontmatter.js'

const temporary: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-core-'))
  temporary.push(root)
  return root
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('scanPlugin', () => {
  it('reads a portable Agent Plugins package', () => {
    const root = tempRoot()
    write(join(root, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'portable-demo',
      version: '1.2.3',
      license: 'MIT',
    }))
    write(join(root, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code\n---\n\nReview it.\n')
    write(join(root, 'mcp.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        docs: { type: 'stdio', command: './bin/docs', args: ['--stdio'] },
        remote: { type: 'streamable-http', url: 'https://example.com/mcp' },
      },
    }))

    const { plugin } = scanPlugin(root, { source: 'codex' })
    expect(plugin.name).toBe('portable-demo')
    expect(plugin.version).toBe('1.2.3')
    expect(plugin.ref.manifestKind).toBe('agent-plugins')
    expect(plugin.components.filter(component => component.kind === 'skill')).toHaveLength(1)
    expect(plugin.components.filter(component => component.kind === 'mcp')).toHaveLength(2)
    expect(plugin.license).toBe('MIT')
  })

  it('reads a Claude Code plugin with commands, agents, hooks and mods', () => {
    const root = tempRoot()
    write(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'claude-demo',
      version: '0.4.0',
      license: 'MIT',
      skills: ['./extra-skills'],
    }))
    write(join(root, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code\n---\n\nReview.\n')
    write(join(root, 'extra-skills', 'extra', 'SKILL.md'), '---\nname: extra\ndescription: Extra\n---\n\nExtra.\n')
    write(join(root, 'commands', 'db', 'migrate.md'), '---\ndescription: Migrate\nargument-hint: "[name]"\n---\n\nRun $ARGUMENTS\n')
    write(join(root, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviewer\ntools: Read, Grep\n---\n\nYou review.\n')
    write(join(root, 'hooks', 'hooks.json'), JSON.stringify({
      modules: ['./register.js'],
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo no' }] }],
      },
    }))
    write(join(root, 'hooks', 'register.js'), 'export function register() {}\n')
    write(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { db: { command: 'node', args: ['server.js'] } },
    }))

    const { plugin } = scanPlugin(root, { source: 'claude-code' })
    expect(plugin.ref.manifestKind).toBe('claude-code')
    expect(plugin.components.filter(component => component.kind === 'skill')).toHaveLength(2)
    expect(plugin.components.filter(component => component.kind === 'command')).toHaveLength(1)
    expect(plugin.components.filter(component => component.kind === 'agent')).toHaveLength(1)
    expect(plugin.components.filter(component => component.kind === 'mcp')).toHaveLength(1)
    const hooks = plugin.components.find(component => component.kind === 'hooks')
    expect(hooks?.kind).toBe('hooks')
    if (hooks?.kind === 'hooks') {
      expect(hooks.events).toEqual(['PreToolUse', 'SessionStart'])
      expect(hooks.modules).toHaveLength(1)
    }
    expect(plugin.components.filter(component => component.kind === 'code')).toHaveLength(1)
  })

  it('reads a Codex compatibility manifest and hooks', () => {
    const root = tempRoot()
    write(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'codex-demo',
      version: '0.1.0',
      skills: './skills/',
      hooks: './hooks/hooks.json',
    }))
    write(join(root, 'skills', 'ship', 'SKILL.md'), '---\nname: ship\ndescription: Ship it\n---\n\nShip.\n')
    write(join(root, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] },
    }))

    const { plugin } = scanPlugin(root, { source: 'codex' })
    expect(plugin.ref.manifestKind).toBe('codex')
    expect(plugin.components.filter(component => component.kind === 'skill')).toHaveLength(1)
    expect(plugin.components.filter(component => component.kind === 'hooks')).toHaveLength(1)
  })

  it('does not let a Codex overlay shadow an explicit Claude manifest', () => {
    const root = tempRoot()
    write(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'dual', commands: { one: { content: 'one' } } }))
    write(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'dual-codex', hooks: './hooks/hooks.json' }))
    write(join(root, 'SKILL.md'), '---\nname: root-skill\ndescription: Root\n---\n\nRoot.\n')
    const { plugin } = scanPlugin(root, { source: 'claude-code' })
    expect(plugin.ref.manifestKind).toBe('claude-code')
    expect(plugin.name).toBe('dual')
    expect(plugin.components.some(component => component.kind === 'command')).toBe(true)
  })

  it('accepts a declared SKILL.md file path', () => {
    const root = tempRoot()
    write(join(root, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'file-skill',
      skills: ['./custom/one/SKILL.md'],
    }))
    write(join(root, 'custom', 'one', 'SKILL.md'), '---\nname: one\ndescription: One\n---\n\nOne.\n')
    const { plugin } = scanPlugin(root, { source: 'agent-plugins' })
    expect(plugin.components.filter(component => component.kind === 'skill')).toHaveLength(1)
  })

  it('recognizes BSD-2 before the generic BSD sentence', () => {
    const root = tempRoot()
    write(join(root, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'bsd2',
    }))
    write(join(root, 'LICENSE'), 'BSD 2-Clause License\n\nRedistribution and use in source and binary forms\n')
    expect(scanPlugin(root, { source: 'agent-plugins' }).plugin.license).toBe('BSD-2-Clause')
  })

  it('keeps CJK names addressable', () => {
    const root = tempRoot()
    write(join(root, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: '中文插件',
    }))
    const { plugin } = scanPlugin(root, { source: 'agent-plugins' })
    expect(plugin.id).not.toContain('unnamed')
    expect(plugin.id).toMatch(/^agent-plugins:n-[a-f0-9]{8}$/u)
  })

  it('deduplicates the same MCP server declared twice', () => {
    const root = tempRoot()
    write(join(root, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'mcp-dedupe',
      mcpServers: { demo: { type: 'stdio', command: 'node', args: ['server.mjs'] } },
    }))
    write(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { demo: { type: 'stdio', command: 'node', args: ['server.mjs'] } },
    }))
    const { plugin } = scanPlugin(root, { source: 'agent-plugins' })
    expect(plugin.components.filter(component => component.kind === 'mcp')).toHaveLength(1)
  })

  it('reads a license file when the manifest omits one', () => {
    const root = tempRoot()
    write(join(root, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'licensed',
    }))
    write(join(root, 'LICENSE'), 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n')
    const { plugin } = scanPlugin(root, { source: 'agent-plugins' })
    expect(plugin.license).toBe('MIT')
  })

  it('merges a Codex overlay with a portable root manifest', () => {
    const root = tempRoot()
    write(join(root, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'portable-codex',
      version: '1.0.0',
    }))
    write(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'codex-overlay',
      version: '1.1.0',
      hooks: './hooks/hooks.json',
      mcpServers: './mcp.json',
    }))
    write(join(root, 'skills', 'ship', 'SKILL.md'), '---\nname: ship\ndescription: Ship it\n---\n\nShip.\n')
    write(join(root, 'mcp.json'), JSON.stringify({
      mcpServers: { demo: { type: 'stdio', command: 'node', args: ['server.js'] } },
    }))
    write(join(root, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] },
    }))

    const { plugin } = scanPlugin(root, { source: 'codex' })
    expect(plugin.name).toBe('codex-overlay')
    expect(plugin.version).toBe('1.1.0')
    expect(plugin.ref.manifestKind).toBe('codex')
    expect(plugin.components.filter(component => component.kind === 'skill')).toHaveLength(1)
    expect(plugin.components.filter(component => component.kind === 'hooks')).toHaveLength(1)
    expect(plugin.components.filter(component => component.kind === 'mcp')).toHaveLength(1)
  })

  it('reports path escapes instead of reading outside the root', () => {
    const root = tempRoot()
    write(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'escape-demo',
      commands: '../outside',
    }))
    const { plugin } = scanPlugin(root, { source: 'claude-code' })
    expect(plugin.warnings.some(warning => warning.code === 'path-escape')).toBe(true)
  })
})

describe('naming and frontmatter', () => {
  it('normalizes names deterministically', () => {
    expect(kebabCase('My Plugin: Review')).toBe('my-plugin-review')
    expect(uniqueName('same', new Set(['same']), 'plugin-a')).toMatch(/^same-[0-9a-f]{8}$/u)
  })

  it('normalizes skill frontmatter', () => {
    const parsed = parseSkillFrontmatter({
      name: 'Review',
      description: 'Review code',
      'allowed-tools': 'Read Grep',
      'disable-model-invocation': 'yes',
    }, 'fallback')
    expect(parsed.frontmatter.name).toBe('review')
    expect(parsed.frontmatter.allowedTools).toEqual(['Read', 'Grep'])
    expect(parsed.frontmatter.modelInvocable).toBe(false)
    expect(parsed.frontmatter.userInvocable).toBe(true)
  })
})
