import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanPlugin } from '../src/manifest.js'

const temporary: string[] = []
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }) })

function root(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hf-manifest-'))
  temporary.push(dir)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

const codes = (dir: string, source: 'claude-code' | 'codex' = 'claude-code'): string[] => scanPlugin(dir, { source }).plugin.warnings.map(warning => warning.code)

describe('manifest validity', () => {
  it('reports a broken plugin.json even when a valid package.json could stand in for it', () => {
    const dir = root({ '.claude-plugin/plugin.json': '{ "name": "x", ', 'package.json': JSON.stringify({ name: 'x', version: '1.0.0' }), 'skills/one/SKILL.md': '---\nname: one\ndescription: One\n---\nOne\n' })
    expect(codes(dir)).toContain('manifest-invalid')
  })

  it('reports a manifest that declares a schema it does not know', () => {
    const dir = root({ 'plugin.json': JSON.stringify({ $schema: 'https://example.invalid/plugin.schema.json', name: 'x' }), 'skills/one/SKILL.md': '---\nname: one\ndescription: One\n---\nOne\n' })
    expect(codes(dir, 'codex')).toContain('manifest-schema-unknown')
  })

  it('reports the unknown schema of a root manifest that a Codex overlay is merged over', () => {
    const dir = root({ 'plugin.json': JSON.stringify({ $schema: 'https://example.invalid/nope', name: 'x' }), '.codex-plugin/plugin.json': JSON.stringify({ name: 'x', license: 'MIT' }) })
    expect(codes(dir, 'codex')).toContain('manifest-schema-unknown')
  })

  it('accepts the portable schema and a manifest-less Claude layout without either warning', () => {
    const portable = root({ 'plugin.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'x' }) })
    expect(codes(portable, 'codex')).not.toContain('manifest-schema-unknown')
    const bare = root({ 'skills/one/SKILL.md': '---\nname: one\ndescription: One\n---\nOne\n' })
    expect(codes(bare)).toEqual([])
  })
})
