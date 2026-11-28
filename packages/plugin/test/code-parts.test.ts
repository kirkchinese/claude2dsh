import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { assess, scanPlugin } from '@kirkchinese/harness-forge-core'
import { partOf } from '../src/workbench/overview.js'
import { adaptable, codePartsOf } from '../src/forge/remote/code-parts.js'
import { codeNotice, type NoticeLine } from '../src/client/code-notice.js'
import type { Key } from '../src/client/shared.js'
import english from '../src/client/locale/en.json' with { type: 'json' }
import chinese from '../src/client/locale/zh.json' with { type: 'json' }

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

/** A Claude Code plugin made of the given files. */
function plugin(files: Record<string, string>): ReturnType<typeof scanPlugin>['plugin'] {
  const root = mkdtempSync(join(tmpdir(), 'hf-code-parts-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return scanPlugin(root, { source: 'claude-code' }).plugin
}

const codeOf = (files: Record<string, string>) => {
  const scanned = plugin(files)
  return codePartsOf(scanned, assess(scanned).gaps)
}

/** What the confirmation hands the warning: the code parts, the parts list with its reasons, and whether an adapter could fill a gap. */
const planOf = (files: Record<string, string>) => {
  const scanned = plugin(files)
  const gaps = assess(scanned).gaps
  return {
    codeParts: codePartsOf(scanned, gaps),
    parts: scanned.components.map((component) => {
      const reasons = partOf(component, gaps, undefined, undefined).reasons
      return { kind: component.kind, name: component.name, ...(reasons.length > 0 ? { reasons } : {}) }
    }),
    adaptable: adaptable(gaps),
    total: scanned.components.length,
  }
}

/** claude-hud's shape: its only code is the status line script, which DSH cannot show. */
const hud = { '.claude-plugin/plugin.json': JSON.stringify({ name: 'claude-hud', license: 'MIT' }), 'install.mjs': "// points Claude Code's statusLine at the HUD in ~/.claude/settings.json\nexport {}\n" }
/** claude-hud as it ships: its `hud` skill has a shell line DSH runs, and its status line is a gap. */
const realHud = { ...hud, 'skills/hud/SKILL.md': '---\nname: hud\ndescription: HUD setup\n---\n\nNode: !`node --version`\n' }
/** hookify: four hook events, four commands, an agent and a skill, all of which work in DSH. */
const hookify = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'hookify' }),
  'hooks/hooks.json': JSON.stringify({ hooks: Object.fromEntries(['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit'].map(event => [event, [{ hooks: [{ type: 'command', command: `python3 "\${CLAUDE_PLUGIN_ROOT}/hooks/${event}.py"` }] }]])) }),
  ...Object.fromEntries(['help', 'list', 'hookify', 'configure'].map(name => [`commands/${name}.md`, `---\ndescription: ${name}\n---\n\nDo ${name}.\n`])),
  'agents/conversation-analyzer.md': '---\nname: conversation-analyzer\ndescription: finds behaviours to prevent\ntools: ["Read", "Grep"]\n---\n\nAnalyze.\n',
  'skills/writing-rules/SKILL.md': '---\nname: writing-rules\ndescription: writing rules\n---\n\nWrite rules.\n',
}
/** Hooks, an MCP server and a command with a shell line, all of which DSH runs. */
const tools = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'tools' }),
  'hooks/hooks.json': JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node check.js' }] }], SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] } }),
  '.mcp.json': JSON.stringify({ mcpServers: { db: { command: 'node', args: ['server.js', '--port', '0'] } } }),
  'commands/status.md': '---\ndescription: status\n---\n\nState: !`git status --short`\n',
}
/** Skills only: text the agent reads, no code. */
const skills = { '.claude-plugin/plugin.json': JSON.stringify({ name: 'notes' }), 'skills/notes/SKILL.md': '---\nname: notes\ndescription: notes skill\n---\n\nTake notes.\n' }

describe('the parts a confirmation says run code', () => {
  it('lists claude-hud\'s status line script as a gap that runs nothing in DSH', () => {
    expect(codeOf(hud)).toEqual([{ kind: 'ui', name: 'statusline', what: 'script', detail: 'install.mjs', runs: false, reasons: [{ code: 'no-equivalent-ui', detail: '' }] }])
  })

  it('lists hooks with their events, an MCP server with its command, and shell lines, which run in DSH', () => {
    const parts = codeOf(tools)
    expect(parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'hooks', what: 'hooks', detail: 'PreToolUse, SessionStart', runs: true }),
      expect.objectContaining({ kind: 'mcp', name: 'db', what: 'mcp', detail: 'node server.js --port 0', runs: true }),
      expect.objectContaining({ kind: 'command', name: 'status', what: 'shell', detail: 'git status --short', runs: true }),
    ]))
    expect(parts).toHaveLength(3)
  })

  it('lists nothing for a skills-only plugin', () => {
    expect(codeOf(skills)).toEqual([])
  })
})

describe('the confirmation\'s code warning', () => {
  const en = (key: Key): string => (english as Record<string, string>)[key] ?? key
  const zh = (key: Key): string => (chinese as Record<string, string>)[key] ?? key
  const texts = (lines: readonly NoticeLine[]): string[] => lines.map(line => line.text)
  const warned = (lines: readonly NoticeLine[]): string[] => lines.filter(line => line.runs).map(line => line.text)

  it('says claude-hud\'s skill runs a shell line, in the warning colour, and its status line is a gap, in the normal colour', () => {
    const plan = planOf(realHud)
    const lines = codeNotice(plan, en)
    expect(warned(lines)).toEqual([
      'These parts run code with your permissions once installed: hud.',
      'hud (Skill) — shell lines node --version: runs in DSH once installed.',
    ])
    // The parts list above already gives the status line's reason: the warning does not repeat it.
    expect(texts(lines)).toContain('statusline (Interface) — script install.mjs: a gap, runs nothing in DSH.')
    expect(texts(lines).join('\n')).not.toContain('an adapter has to draw it')
    // The status line is a gap an adapter can fill.
    expect(texts(lines)).toContain(english.confirmCodeAdapter)
    expect(lines.find(line => line.text === english.confirmCodeAdapter)?.runs).toBe(false)
    expect(lines.at(-1)).toEqual({ text: english.confirmTrust, runs: false })
    expect(texts(codeNotice(plan, zh))[0]).toBe('这些部分安装后会以你的权限运行代码：hud。')
  })

  it('gives the reason when no parts list shows it', () => {
    const lines = codeNotice({ codeParts: codeOf(hud), adaptable: true }, en)
    expect(texts(lines)).toContain('statusline (Interface) — script install.mjs: a gap, runs nothing in DSH. DSH has no place to show this; an adapter has to draw it.')
    expect(texts(lines)[0]).toBe('Nothing in this plugin runs code in DSH until you build an adapter for statusline.')
    expect(warned(lines)).toEqual([])
  })

  it('says hookify\'s hooks run, and nothing of adapters: all 7 of its parts work', () => {
    const plan = planOf(hookify)
    expect(plan.total).toBe(7)
    expect(plan.adaptable).toBe(false)
    const lines = codeNotice(plan, en)
    expect(warned(lines)).toEqual([
      'These parts run code with your permissions once installed: hooks.',
      'hooks (Hooks) — hooks on PostToolUse, PreToolUse, Stop, UserPromptSubmit: runs in DSH once installed.',
    ])
    expect(texts(lines)).not.toContain(english.confirmCodeAdapter)
    expect(texts(lines).join('\n')).not.toContain('a gap')
    expect(lines.at(-1)).toEqual({ text: english.confirmTrust, runs: false })
  })

  it('says a skills-only plugin runs no code, in the normal colour and without the adapter sentence', () => {
    const plan = planOf(skills)
    expect(plan.adaptable).toBe(false)
    expect(codeNotice(plan, en)).toEqual([
      { text: 'Nothing in this plugin runs code; it adds only text the agent reads.', runs: false },
      { text: 'Install plugins only from a source you trust.', runs: false },
    ])
  })

  it('does not promise an adapter for a gap no adapter can fill', () => {
    const gap = { kind: 'mcp', name: 'remote', what: 'mcp' as const, detail: 'ws://example', runs: false }
    const lines = texts(codeNotice({ codeParts: [gap], adaptable: false }, en))
    expect(lines[0]).toBe('None of the parts that hold code run in DSH: remote.')
    expect(lines).not.toContain(english.confirmCodeAdapter)
  })

  it('names what runs once installed', () => {
    const lines = codeNotice({ codeParts: codeOf(tools), adaptable: false }, en)
    expect(texts(lines)[0]).toMatch(/^These parts run code with your permissions once installed: /u)
    expect(warned(lines)).toContain('hooks (Hooks) — hooks on PreToolUse, SessionStart: runs in DSH once installed.')
    expect(warned(lines)).toContain('db (MCP server) — command node server.js --port 0: runs in DSH once installed.')
    expect(warned(lines)).toContain('status (Command) — shell lines git status --short: runs in DSH once installed.')
    expect(texts(codeNotice({ codeParts: codeOf(tools), adaptable: false }, zh))[0]).toMatch(/^这些部分安装后会以你的权限运行代码：/u)
  })
})
