/**
 * What each harness has installed, and whether that could be read in full: a plugin missing from a record that could
 * not be read (malformed, cut off mid-write) may only be unreadable, so it must never read as uninstalled.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { harnessInstalls } from '../src/harness-installs.js'
import { installedClaudePlugins } from '../src/dialects/claude-code/user-assets.js'

const temporary: string[] = []
afterAll(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hf-installs-'))
  temporary.push(home)
  vi.stubEnv('CODEX_HOME', join(home, '.codex'))
})
afterEach(() => { vi.unstubAllEnvs() })

const read = () => harnessInstalls(home)

/** A plugin folder with a manifest. */
function plugin(root: string, manifest: string): string {
  write(join(root, manifest, 'plugin.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
  return root
}

describe('a harness record read in full or not', () => {
  it('Claude Code: a malformed or truncated index, or settings, is an incomplete read; a missing or empty one a complete read', () => {
    const index = join(home, '.claude', 'plugins', 'installed_plugins.json')
    const root = plugin(join(home, '.claude', 'plugins', 'cache', 'm', 'p', '1.0.0'), '.claude-plugin')
    const whole = JSON.stringify({ version: 2, plugins: { 'p@m': [{ scope: 'user', installPath: root }] } })

    expect(read().uncertain.has('claude-code')).toBe(false)
    write(index, JSON.stringify({ version: 2, plugins: {} }))
    expect(read()).toMatchObject({ installs: [] })
    expect(read().uncertain.has('claude-code')).toBe(false)

    for (const broken of ['{', whole.slice(0, whole.length - 7)]) {
      write(index, broken)
      expect(read().uncertain.has('claude-code'), broken).toBe(true)
      expect(read().unread.find(item => item.harness === 'claude-code')?.message).toContain('installed_plugins.json')
    }

    write(index, whole)
    expect(read().installs).toMatchObject([{ harness: 'claude-code', key: 'p@m', root }])
    expect(read().uncertain.has('claude-code')).toBe(false)
    // Whether it is switched off cannot be told from settings that do not parse.
    write(join(home, '.claude', 'settings.json'), '{"enabledPlugins": {"p@m": fal')
    expect(read().uncertain.has('claude-code')).toBe(true)
    write(join(home, '.claude', 'settings.json'), '')
    expect(read().uncertain.has('claude-code')).toBe(true)
    write(join(home, '.claude', 'settings.json'), '{}')
    expect(read().uncertain.has('claude-code')).toBe(false)
    // Managed settings decide too: the reader takes their folder, so the machine's own does not count here.
    const managed = join(home, 'managed')
    expect(installedClaudePlugins(home, managed).unread).toEqual([])
    write(join(managed, 'managed-settings.json'), '{')
    expect(installedClaudePlugins(home, managed).unread[0]).toContain('managed-settings.json')
  })

  it('Claude Code: an install whose recorded folder is gone is still installed, not followable now', () => {
    write(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'p@m': [{ scope: 'user', installPath: join(home, 'gone') }] } }))
    const current = read()
    expect(current.installs).toEqual([])
    expect(current.unresolved).toMatchObject([{ harness: 'claude-code', key: 'p@m' }])
    expect(current.uncertain.has('claude-code')).toBe(false)
  })

  it('Codex: a malformed or truncated config.toml is an incomplete read; a missing or empty one a complete read', () => {
    const config = join(home, '.codex', 'config.toml')
    const root = plugin(join(home, '.codex', 'plugins', 'cache', 'm', 'p', '1.0.0'), '.codex-plugin')
    expect(read().uncertain.has('codex')).toBe(false)
    write(config, '')
    expect(read().uncertain.has('codex')).toBe(false)
    for (const broken of ['[plugins."p@m"', '[plugins."p@m"]\nenabled = ']) {
      write(config, broken)
      expect(read().uncertain.has('codex'), broken).toBe(true)
      expect(read().unread.find(item => item.harness === 'codex')?.message).toContain('config.toml')
    }
    write(config, '[plugins."p@m"]\nenabled = true\n')
    expect(read().installs).toMatchObject([{ harness: 'codex', key: 'p@m', root }])
    expect(read().uncertain.has('codex')).toBe(false)
  })

  it('Codex: a listed plugin without a cached version is still installed, not followable now', () => {
    write(join(home, '.codex', 'config.toml'), '[plugins."p@m"]\nenabled = true\n')
    const current = read()
    expect(current.installs).toEqual([])
    expect(current.unresolved).toMatchObject([{ harness: 'codex', key: 'p@m' }])
  })

  it('OpenCode: a malformed or truncated opencode.json is an incomplete read; a missing or empty one a complete read', () => {
    const config = join(home, '.config', 'opencode', 'opencode.json')
    const root = join(home, '.cache', 'opencode', 'node_modules', 'oc-plugin')
    write(join(root, 'package.json'), JSON.stringify({ name: 'oc-plugin', main: 'index.js' }))
    write(join(root, 'index.js'), 'export const id = "oc-plugin"\nexport default async () => ({})\n')
    const whole = JSON.stringify({ plugin: ['oc-plugin'] })
    expect(read().uncertain.has('opencode')).toBe(false)
    write(config, '{}')
    expect(read().uncertain.has('opencode')).toBe(false)
    for (const broken of ['{', whole.slice(0, whole.length - 3)]) {
      write(config, broken)
      expect(read().uncertain.has('opencode'), broken).toBe(true)
      expect(read().unread.find(item => item.harness === 'opencode')?.message).toContain('opencode.json')
    }
    write(config, whole)
    expect(read().installs).toMatchObject([{ harness: 'opencode', key: root }])
    expect(read().uncertain.has('opencode')).toBe(false)
  })

  it('OpenCode: a configured package not on disk is still configured, not followable now', () => {
    write(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ plugin: ['oc-plugin'] }))
    const current = read()
    expect(current.installs).toEqual([])
    expect(current.unresolved.map(item => item.key)).toContain(join(home, '.cache', 'opencode', 'node_modules', 'oc-plugin'))
    expect(current.uncertain.has('opencode')).toBe(false)
  })
})
