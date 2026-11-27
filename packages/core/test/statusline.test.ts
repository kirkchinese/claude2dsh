import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeStatusLineProvider, scanClaudeUserAssets, scanPlugin } from '../src/index.js'

describe('status lines', () => {
  it('names the user\'s statusLine setting as a status-line surface', () => {
    const home = mkdtempSync(join(tmpdir(), 'hf-statusline-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'node ~/hud.mjs' } }))
    const ui = scanClaudeUserAssets(home)?.components.find(component => component.kind === 'ui')
    expect(ui).toMatchObject({ kind: 'ui', surface: 'statusline', name: 'statusline-settings', description: 'status line: node ~/hud.mjs' })
  })

  it('names a plugin whose installer writes statusLine into settings.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'hf-hud-'))
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'hud' }))
    writeFileSync(join(root, 'install.mjs'), "// points Claude Code's statusLine at the HUD in ~/.claude/settings.json\nexport {}\n")
    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, 'tests', 'other.mjs'), '// statusLine settings.json\n')
    const ui = scanPlugin(root, { source: 'claude-code' }).plugin.components.filter(component => component.kind === 'ui')
    expect(ui).toEqual([expect.objectContaining({ name: 'statusline', surface: 'statusline', path: 'install.mjs' })])
  })

  it('attributes direct and interpreted commands through the root, install records or cache identity', () => {
    const home = mkdtempSync(join(tmpdir(), 'hf-hud-owner-'))
    const plugins = join(home, '.claude', 'plugins')
    const root = join(plugins, 'cache', 'market', 'hud', '2.0')
    const oldCache = join(plugins, 'cache', 'market', 'hud', '1.0')
    const oldInstall = join(home, 'old hud')
    const unrelated = join(plugins, 'cache', 'market', 'hud-extra', '1.0')
    for (const dir of [root, oldCache, oldInstall, unrelated]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'hud.mjs'), '')
    }
    mkdirSync(join(root, '.claude-plugin'))
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'hud' }))
    writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: { 'hud@market': [{ installPath: root }, { installPath: oldInstall }] } }))
    const plugin = scanPlugin(root, { source: 'claude-code' }).plugin
    for (const command of [`"${join(root, 'hud.mjs')}"`, 'node "$HOME/old hud/hud.mjs"', `node "${join(oldCache, 'hud.mjs')}"`]) {
      expect(claudeStatusLineProvider(command, [plugin], home)).toMatchObject({ plugin, component: { id: 'claude-code:hud:ui:statusline', surface: 'statusline' } })
    }
    expect(claudeStatusLineProvider(`node "${join(unrelated, 'hud.mjs')}"`, [plugin], home)).toBeUndefined()
    expect(claudeStatusLineProvider(`echo "${join(root, 'hud.mjs')}"`, [plugin], home)).toBeUndefined()
    expect(claudeStatusLineProvider(`node "${join(root, 'hud.mjs')}"`, [], home)).toBeUndefined()
  })

  it('does not take a plugin that never writes settings for a status line', () => {
    const root = mkdtempSync(join(tmpdir(), 'hf-plain-'))
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'plain' }))
    writeFileSync(join(root, 'tool.mjs'), '// mentions statusLine only\n')
    expect(scanPlugin(root, { source: 'claude-code' }).plugin.components.filter(component => component.kind === 'ui')).toEqual([])
  })
})