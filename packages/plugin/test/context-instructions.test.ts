import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ContextInstructions } from '../src/context/instructions.js'
import type { HarnessForge } from '../src/forge/service.js'

let root: string
const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'], CODEX_HOME: process.env['CODEX_HOME'] }

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-forge-context-')))
  process.env['HOME'] = join(root, 'home')
  process.env['USERPROFILE'] = join(root, 'home')
  delete process.env['CODEX_HOME']
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

function write(path: string, text: string): string {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
  return full
}

/** A Cordis stand-in with the system prompt and working-directory services, and the shared service's `list` and `fault`. */
function host(options: { recollect?: boolean; cwdOf?: (session: unknown) => string | undefined; codexMounted?: boolean } = {}) {
  let provider: ((context: unknown) => string) | undefined
  const faults: string[] = []
  const services: Record<string, unknown> = {
    systemPrompt: { getSectionOrder: () => 10200, section: (section: { text: (context: unknown) => string }) => { provider = section.text; return () => { provider = undefined } } },
    workingDirectory: { defaultDirectory: join(root, 'default'), get: options.cwdOf ?? (() => undefined) },
    ...options.recollect === true ? { recollect: {} } : {},
  }
  const ctx = { get: (name: string) => services[name] } as unknown as Context
  const forge = {
    list: () => options.codexMounted === true ? [{ source: 'codex', outcomes: [{ componentId: 'codex:user:other:agents-md', status: 'mounted' }] }] : [],
    fault: (_row: string, error: Error) => { faults.push(error.message) },
  } as unknown as HarnessForge
  const instructions = new ContextInstructions(ctx, forge)
  const dispose = instructions.install()
  return { instructions, faults, dispose, prompt: (session: unknown = { id: 's' }) => provider?.({ agent: { session } }) ?? '<no section>' }
}

describe('context instructions', () => {
  it('adds the user\'s CLAUDE.md, .claude/CLAUDE.md and imports of the session\'s workspace, but not the files DSH reads itself', () => {
    write('home/.claude/CLAUDE.md', 'USER-RULE')
    write('work/.git/HEAD', '')
    write('work/CLAUDE.md', 'DSH-READS-THIS @notes.md')
    write('work/.claude/CLAUDE.md', 'DOT-RULE')
    write('work/notes.md', 'IMPORTED-NOTE')
    const { prompt, instructions } = host({ cwdOf: () => join(root, 'work') })
    const text = prompt()
    expect(text).toContain('USER-RULE')
    expect(text).toContain('DOT-RULE')
    expect(text).toContain('IMPORTED-NOTE')
    expect(text).not.toContain('DSH-READS-THIS')
    const status = instructions.status(join(root, 'work'))
    expect(status.active).toBe(true)
    expect(status.files.map(file => file.path)).toEqual([join(root, 'home/.claude/CLAUDE.md'), join(root, 'work/notes.md'), join(root, 'work/.claude/CLAUDE.md')])
    expect(status.hostFiles?.map(file => file.path)).toEqual([join(root, 'work/CLAUDE.md')])
  })

  it('follows each session\'s own directory', () => {
    write('a/.git/HEAD', '')
    write('a/.claude/CLAUDE.md', 'ONLY-A')
    write('b/.git/HEAD', '')
    write('b/.claude/CLAUDE.md', 'ONLY-B')
    const { prompt } = host({ cwdOf: session => join(root, (session as { id: string }).id) })
    expect(prompt({ id: 'a' })).toContain('ONLY-A')
    expect(prompt({ id: 'a' })).not.toContain('ONLY-B')
    expect(prompt({ id: 'b' })).toContain('ONLY-B')
  })

  it('adds Codex\'s global instructions unless a Codex import already mounts them', () => {
    write('home/.codex/AGENTS.md', 'CODEX-GLOBAL')
    expect(host().prompt()).toContain('CODEX-GLOBAL')
    expect(host({ codexMounted: true }).prompt()).toBe('')
  })

  it('yields entirely while Recollect runs, and says so', () => {
    write('home/.claude/CLAUDE.md', 'USER-RULE')
    const { prompt, instructions } = host({ recollect: true })
    expect(prompt()).toBe('')
    expect(instructions.status(undefined)).toEqual({ active: false, yieldingTo: 'recollect', files: [] })
  })

  it('reports the default workspace without a directory', () => {
    write('default/.claude/CLAUDE.md', 'DEFAULT-RULE')
    const status = host().instructions.status(undefined)
    expect(status.files).toEqual([{ path: join(root, 'default/.claude/CLAUDE.md'), bytes: 12 }])
  })

  it('adds nothing, and nothing fails, when there are no files', () => {
    const { prompt, faults } = host()
    expect(prompt()).toBe('')
    expect(faults).toEqual([])
  })

  it('is gone with the disposer', () => {
    write('home/.claude/CLAUDE.md', 'USER-RULE')
    const { prompt, dispose } = host()
    expect(prompt()).toContain('USER-RULE')
    dispose()
    expect(prompt()).toBe('<no section>')
  })
})
