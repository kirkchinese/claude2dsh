import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adapterPackageName, assess, defaultAdapterDir, extensionPointsFor, gapsOf, openQuestionsFor, portBrief, scanPlugin } from '../src/index.js'

/** A Claude Code plugin with a status line its installer writes into settings.json. */
function hud(): string {
  const root = mkdtempSync(join(tmpdir(), 'hf-brief-'))
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'claude-hud', version: '1.2.0', description: 'A HUD', license: 'MIT' }))
  writeFileSync(join(root, 'install.mjs'), "// points Claude Code's statusLine at the HUD in ~/.claude/settings.json\nexport {}\n")
  return root
}

describe('the porting brief', () => {
  const root = hud()
  const plugin = scanPlugin(root, { source: 'claude-code' }).plugin
  const component = plugin.components.find(item => item.kind === 'ui')!
  const gaps = assess(plugin).gaps
  const brief = portBrief({ plugin, component, gaps, files: [join(root, 'install.mjs'), join(root, '.claude-plugin', 'plugin.json')] })

  it('names the adapter package unscoped after the plugin and the part', () => {
    expect(adapterPackageName(plugin, component)).toBe('dsh-adapter-claude-hud-statusline')
    expect(adapterPackageName({ name: 'Demo' }, { name: 'demo' })).toBe('dsh-adapter-demo')
  })

  it('describes the original with absolute paths to its files', () => {
    expect(brief).toContain('# Port "statusline" of claude-hud to DSH')
    expect(brief).toContain(`Root on disk: \`${root}\``)
    expect(brief).toContain(`statusline specification: \`${join(root, 'install.mjs')}\``)
    expect(brief).toContain(`- \`${join(root, '.claude-plugin', 'plugin.json')}\``)
    expect(brief).toContain('"name": "claude-hud"')
    expect(brief).toContain('License: MIT')
  })

  it('says why Harness Forge cannot run it, from the assessment', () => {
    const own = gapsOf(component, gaps)
    expect(own.length).toBeGreaterThan(0)
    for (const gap of own) expect(brief).toContain(gap.summary)
  })

  it('points at the nearest DSH extension points', () => {
    expect(extensionPointsFor(component, gapsOf(component, gaps)).join('\n')).toMatch(/ctx\.slots/u)
    expect(brief).toContain('## Nearest DSH extension points')
  })

  it('states acceptance criteria and the constraints of a local, optional-publication adapter', () => {
    expect(brief).toContain('## Acceptance criteria')
    expect(brief).toContain('"harnessForge": { "ports": [{ "plugin": "claude-hud", "component": "statusline" }] }')
    expect(brief).toContain('Package name `dsh-adapter-claude-hud-statusline`, unscoped')
    expect(brief).toContain('LOCAL plugin into the current profile only')
    expect(brief).toMatch(/publish nothing unless the user explicitly asks, and then only under the user's own npm scope/u)
    expect(brief).toContain("Respect the original's license (MIT)")
  })

  it('lists the questions the part leaves to the user, with defaults', () => {
    expect(defaultAdapterDir('dsh-adapter-claude-hud-statusline')).toBe('~/dsh-adapters/dsh-adapter-claude-hud-statusline')
    expect(brief).toContain('## Questions for the user')
    expect(brief).toContain("- Where the adapter's source lives. Default: `~/dsh-adapters/dsh-adapter-claude-hud-statusline`.")
    expect(openQuestionsFor(component, gaps)).toEqual(['Where the status line shows in the DSH Web UI. Default: just below the message input.'])
    expect(brief).toContain('`conversation.composer.dock` slot below the composer; confirm it at runtime after the user replies')
    const hooks = { id: 'h', kind: 'hooks', name: 'hooks', configPath: 'hooks.json', modules: [], events: [] } as never
    expect(openQuestionsFor(hooks, [{ id: 'g', componentId: 'h', kind: 'unsupported-event', summary: 'events DSH never raises: Notification', detail: '', suggestedAction: 'port' } as never]))
      .toEqual([expect.stringContaining('Which DSH event stands in for each event DSH never raises (events DSH never raises: Notification)')])
    expect(openQuestionsFor(hooks, [])).toEqual([])
  })

  it('asks the creator to verify with harness_verify_port and to author where the user agreed', () => {
    expect(brief).toContain(`\`harness_verify_port\` with \`{"pluginId":"${plugin.id}","componentId":"${component.id}"}\` answers \`"covered": true\`.`)
    expect(brief).toContain('Author it in the directory the user agreed to (default `~/dsh-adapters/dsh-adapter-claude-hud-statusline`)')
  })

  it('falls back to a detected license, and says when there is none', () => {
    const unlicensed = { ...plugin, license: undefined }
    expect(portBrief({ plugin: unlicensed, component, gaps, files: [], license: 'Apache-2.0' })).toContain('License: Apache-2.0')
    expect(portBrief({ plugin: unlicensed, component, gaps, files: [] })).toMatch(/License: unknown/u)
  })
})
