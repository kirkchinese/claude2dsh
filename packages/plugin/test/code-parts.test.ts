import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { assess, scanPlugin } from '@kirkchinese/harness-forge-core'
import { codePartsOf } from '../src/forge/remote/code-parts.js'
import { codeNotice } from '../src/client/code-notice.js'
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

/** claude-hud's shape: its only code is the status line script, which DSH cannot show. */
const hud = { '.claude-plugin/plugin.json': JSON.stringify({ name: 'claude-hud', license: 'MIT' }), 'install.mjs': "// points Claude Code's statusLine at the HUD in ~/.claude/settings.json\nexport {}\n" }
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

  it('says nothing of claude-hud runs until an adapter is built, and that an adapter would run code', () => {
    const notice = codeNotice(codeOf(hud), en)
    expect(notice.kind).toBe('ok')
    expect(notice.lines[0]).toBe('Nothing in this plugin runs code in DSH until you build an adapter for statusline.')
    expect(notice.lines).toContain('statusline (Interface) — script install.mjs: a gap, runs nothing in DSH. DSH has no place to show this; an adapter has to draw it.')
    expect(notice.lines.join('\n')).toContain('An adapter you build later runs its own code with your permissions.')
    expect(notice.lines.join('\n')).not.toContain('A plugin runs with your permissions')
    const chineseNotice = codeNotice(codeOf(hud), zh).lines.join('\n')
    expect(chineseNotice).toContain('在你为 statusline 制作适配器之前，这个插件在 DSH 中不运行任何代码。')
    expect(chineseNotice).toContain('DSH 里没有地方显示它，需要一个适配器来绘制。')
  })

  it('names what runs once installed', () => {
    const notice = codeNotice(codeOf(tools), en)
    expect(notice.kind).toBe('error')
    expect(notice.lines[0]).toMatch(/^These parts run code with your permissions once installed: /u)
    expect(notice.lines[0]).toContain('hooks')
    expect(notice.lines[0]).toContain('db')
    expect(notice.lines[0]).toContain('status')
    expect(notice.lines).toContain('hooks (Hooks) — hooks on PreToolUse, SessionStart: runs in DSH once installed.')
    expect(notice.lines).toContain('db (MCP server) — command node server.js --port 0: runs in DSH once installed.')
    expect(notice.lines).toContain('status (Command) — shell lines git status --short: runs in DSH once installed.')
    expect(codeNotice(codeOf(tools), zh).lines[0]).toMatch(/^这些部分安装后会以你的权限运行代码：/u)
  })

  it('says a skills-only plugin runs no code', () => {
    const notice = codeNotice([], en)
    expect(notice).toEqual({ kind: 'ok', lines: ['Nothing in this plugin runs code; it adds only text the agent reads.', 'Install plugins only from a source you trust.'] })
  })
})
