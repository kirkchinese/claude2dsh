import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanOpenCodeProject, stripJsonc } from '../src/dialects/opencode/scan.js'

const temporary: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-opencode-'))
  temporary.push(root)
  return root
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('OpenCode scanner', () => {
  it('strips comments without touching strings', () => {
    expect(stripJsonc('{ // comment\n "a": "http://x//y", /* block */ "b": 1, }')).toBe('{ \n "a": "http://x//y",  "b": 1 }')
    expect(stripJsonc('{"a":"tail,}","b":"x, ]"}')).toBe('{"a":"tail,}","b":"x, ]"}')
  })

  it('scans skills, commands, MCP and a local plugin', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'opencode.jsonc'), '{\n // config\n "plugin": ["./plugins/demo"],\n "mcp": { "demo": { "type": "local", "command": "node", "args": ["server.js"] } }\n}', 'utf8')
    mkdirSync(join(root, '.opencode', 'skills', 'demo'), { recursive: true })
    writeFileSync(join(root, '.opencode', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n\nDemo.\n', 'utf8')
    mkdirSync(join(root, '.opencode', 'commands'), { recursive: true })
    writeFileSync(join(root, '.opencode', 'commands', 'greet.md'), '---\ndescription: Greet\n---\n\nHello $ARGUMENTS\n', 'utf8')
    mkdirSync(join(root, 'plugins', 'demo'), { recursive: true })
    writeFileSync(join(root, 'plugins', 'demo', 'index.ts'), 'export default {}\n', 'utf8')

    const { plugin } = scanOpenCodeProject(root)
    expect(plugin.source).toBe('opencode')
    expect(plugin.components.filter(component => component.kind === 'skill')).toHaveLength(1)
    expect(plugin.components.filter(component => component.kind === 'command')).toHaveLength(1)
    expect(plugin.components.filter(component => component.kind === 'mcp')).toHaveLength(1)
    expect(plugin.components.filter(component => component.kind === 'code')).toHaveLength(1)
  })
})
