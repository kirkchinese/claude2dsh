import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { matches, selects } from '../src/mods/chain.js'
import { ModsEngine, type EngineHost } from '../src/mods/engine.js'
import { createExpect, ExpectationError } from '../src/mods/expect.js'
import { claudeInstructionFiles } from '../src/mods/service/turns.js'
import { runPluginTests } from './mods-testing.js'

const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('mods kit expect', () => {
  const failures: ExpectationError[] = []
  const check = createExpect(error => { failures.push(error) }) as (value: unknown) => Record<string, (...args: unknown[]) => void> & { not: Record<string, (...args: unknown[]) => void> }

  it('passes what holds and throws what does not, both ways', () => {
    const cases: Array<[string, unknown, unknown[], boolean]> = [
      ['toBe', 1, [1], true], ['toBe', 1, [2], false],
      ['toEqual', { a: 1, b: undefined }, [{ a: 1 }], true], ['toEqual', [1, 2], [[2, 1]], false],
      ['toMatchObject', { a: 1, b: { c: 2, d: 3 } }, [{ b: { c: 2 } }], true], ['toMatchObject', { a: 1 }, [{ a: 2 }], false],
      ['toContain', 'hello', ['ell'], true], ['toContain', [1, 2], [3], false],
      ['toHaveLength', [1, 2], [2], true], ['toHaveLength', 'abc', [2], false],
      ['toBeUndefined', undefined, [], true], ['toBeDefined', undefined, [], false],
      ['toBeNull', null, [], true], ['toEndWith', 'file.ts', ['.ts'], true], ['toStartWith', 'file.ts', ['x'], false],
      ['toBeGreaterThan', 3, [2], true], ['toBeLessThanOrEqual', 3, [2], false],
      ['toMatch', 'abc', [/b/u], true], ['toMatch', 'abc', [/z/u], false],
      ['toHaveProperty', { a: { b: 1 } }, ['a.b', 1], true], ['toHaveProperty', { a: {} }, ['a.b'], false],
    ]
    for (const [matcher, value, args, holds] of cases) {
      const run = (): void => { check(value)[matcher]!(...args) }
      if (holds) expect(run, `${matcher} ${JSON.stringify(value)}`).not.toThrow()
      else expect(run, `${matcher} ${JSON.stringify(value)}`).toThrow(ExpectationError)
      const negated = (): void => { check(value).not[matcher]!(...args) }
      if (holds) expect(negated).toThrow(ExpectationError)
      else expect(negated).not.toThrow()
    }
    expect(failures.length).toBe(cases.length)
  })
})

describe('mods chain', () => {
  it('selects by name, namespace, star and negation, telemetry outside the star', () => {
    expect(selects('tool.call', 'tool.call')).toBe(true)
    expect(selects('classic.*', 'classic.Stop')).toBe(true)
    expect(selects('*', 'telemetry.log')).toBe(false)
    expect(selects('!tool.*', 'tool.call')).toBe(false)
    expect(selects('!tool.*', 'prompt.submit')).toBe(true)
  })

  it('matches scalars, RegExps, any-of arrays, partial objects, and elements of array values', () => {
    expect(matches({ tool: 'Bash' }, { tool: 'Bash', command: 'ls' })).toBe(true)
    expect(matches({ tool: ['Edit', 'Write'] }, { tool: 'Read' })).toBe(false)
    expect(matches({ tool: /^mcp__github__/u }, { tool: 'mcp__github__issues' })).toBe(true)
    expect(matches({ instructionFiles: { kind: ['project', 'local'] } }, { instructionFiles: [{ kind: 'managed' }, { kind: 'local' }] })).toBe(true)
    expect(matches({ isReadOnly: false }, { tool: 'Bash' })).toBe(false)
  })
})

function host(answer: (event: string, e: unknown) => unknown): EngineHost & { lines: string[] } {
  const lines: string[] = []
  return { lines, core: (event, e) => answer(event, e), report: (line) => { lines.push(line) } }
}

describe('mods engine', () => {
  it('nests hooks by tier, runs beneath again on each next, and skips a hook that throws before next', async () => {
    const seen: string[] = []
    const engine = new ModsEngine(host((_event, e) => ({ result: `core saw ${(e as { command: string }).command}` })))
    await engine.load([
      { name: 'late', tier: 'builtin', register: (on: any) => { on('tool.call', ($: unknown, e: any, next: any) => { seen.push(`late ${String(e.command)}`); return next(e) }) } },
      { name: 'guard', tier: 'prepend', register: (on: any) => { on('tool.call', async ($: unknown, e: any, next: any) => { await next(e); return next({ ...e, command: 'retry' }) }) } },
      { name: 'broken', tier: 'user', register: (on: any) => { on('tool.call', () => { throw new Error('boom') }) } },
    ])
    const result = await engine.raise('tool.call', { tool: 'Bash', command: 'ls', tool_use_id: 't1' })
    expect(result).toEqual({ result: 'core saw retry' })
    expect(seen).toEqual(['late ls', 'late retry'])
    expect(engine.registered.map(hook => hook.mod.name)).toEqual(['guard', 'broken', 'late'])
  })

  it('refuses a rewrite of a pinned field, and the hook that tried is skipped', async () => {
    const asked: unknown[] = []
    const engine = new ModsEngine(host((event, e) => {
      if (event !== 'tool.check') return { allow: true }
      asked.push((e as { input: unknown }).input)
      return { decision: 'ask' }
    }))
    await engine.load([{ name: 'rewriting', register: (on: any) => { on('tool.check', async ($: unknown, e: any, next: any) => { await next({ ...e, input: { command: 'ls' } }); return { decision: 'allow' } }) } }])
    expect(await engine.raise('tool.check', { tool: 'Bash', input: { command: 'rm -rf x' } })).toEqual({ decision: 'ask' })
    expect(asked).toEqual([{ command: 'rm -rf x' }])
  })

  it('turns a deny on a $ call into a HooksError for the caller, and requires { value } or { deny } of op hooks', async () => {
    const engine = new ModsEngine(host((event) => (event === 'fs.read' ? { deny: 'not here' } : { result: 'ok' })))
    let caught: unknown
    await engine.load([{ name: 'reader', register: (on: any) => { on('tool.call', async ($: any, e: any, next: any) => { caught = await $.fs.read('/x').catch((error: unknown) => error); return next(e) }) } }])
    await engine.raise('tool.call', { tool: 'Read', file_path: '/x' })
    expect(String(caught)).toBe('HooksError: reader: $.fs.read: not here')
  })
})

describe('mods test kit', () => {
  it('reports a failing test as failed and a passing one as passed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hf-mods-kit-'))
    temporary.push(root)
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    mkdirSync(join(root, 'hooks'), { recursive: true })
    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tally' }))
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
    writeFileSync(join(root, 'hooks', 'register.ts'), `
let calls = 0
export function register(on: any) {
  on('tool.call', async ($: any, e: any, next: any) => { calls += 1; return next(e) })
  on('command.run', { command: 'tally' }, () => ({ text: 'calls: ' + calls }))
}
`)
    writeFileSync(join(root, 'tests', 'tally.test.ts'), `
import { expect, test } from 'claude-code/testing'
test('counts', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect((await $.command.run({ command: 'tally', args: '' })).text).toBe('calls: 1')
})
test('a wrong count fails', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect((await $.command.run({ command: 'tally', args: '' })).text).toBe('calls: 7')
})
test('an unanswered call names its event', async ($) => {
  await $.tool.call({ tool: 'Bash', command: 'ls' })
})
`)
    const [file] = await runPluginTests(root)
    expect(file?.tests.map(test => [test.name, test.ok])).toEqual([['counts', true], ['a wrong count fails', false], ['an unanswered call names its event', false]])
    expect(file?.tests[2]?.error).toContain('no implementation for tool.call')
  }, 30_000)
})

describe('mods instruction files', () => {
  it('are found as core finds them: from the repository root down, never above it', () => {
    const root = mkdtempSync(join(tmpdir(), 'hf-mods-instructions-'))
    temporary.push(root)
    const write = (path: string, text: string): void => {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    write('CLAUDE.md', 'above the repository')
    write('home/.claude/CLAUDE.md', 'user')
    write('home/work/repo/.git/HEAD', 'ref: refs/heads/main\n')
    write('home/work/CLAUDE.md', 'above the repository, below home')
    write('home/work/repo/CLAUDE.md', 'repository\n@notes.md')
    write('home/work/repo/notes.md', 'notes')
    write('home/work/repo/sub/.claude/CLAUDE.md', 'sub')
    write('home/work/repo/sub/CLAUDE.local.md', 'sub local')

    const files = claudeInstructionFiles(join(root, 'home/work/repo/sub'), join(root, 'home'))
    expect(files.map(file => [file.path.slice(root.length + 1), file.kind, file.content])).toEqual([
      ['home/.claude/CLAUDE.md', 'user', 'user'],
      ['home/work/repo/CLAUDE.md', 'project', 'repository\n@notes.md'],
      ['home/work/repo/notes.md', 'import', 'notes'],
      ['home/work/repo/sub/.claude/CLAUDE.md', 'project', 'sub'],
      ['home/work/repo/sub/CLAUDE.local.md', 'local', 'sub local'],
    ])
  })

  it('stop at the working directory outside a repository and outside the home directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'hf-mods-instructions-'))
    temporary.push(root)
    mkdirSync(join(root, 'work', 'proj'), { recursive: true })
    writeFileSync(join(root, 'CLAUDE.md'), 'filesystem root level')
    writeFileSync(join(root, 'work', 'CLAUDE.md'), 'parent')
    writeFileSync(join(root, 'work', 'proj', 'CLAUDE.md'), 'proj')

    expect(claudeInstructionFiles(join(root, 'work', 'proj'), join(root, 'elsewhere')).map(file => file.content)).toEqual(['proj'])
  })
})
