import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importPaths, instructionDirectories, INSTRUCTION_READ_BYTES, INSTRUCTION_PATHS_TRIED, INSTRUCTION_SKIPS_LISTED, loadInstructions, MAX_IMPORT_DEPTH, renderInstructions } from '../src/index.js'

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A home directory and a project in it; `layout` maps paths (relative to the temp root) to text. */
function world(layout: Record<string, string>): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-instructions-'))
  temporary.push(root)
  for (const [path, text] of Object.entries(layout)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return { root, home: join(root, 'home') }
}

const names = (set: ReturnType<typeof loadInstructions>, root: string): string[] => set.files.map(file => file.path.slice(root.length + 1).replaceAll('\\', '/'))

describe('instruction directories', () => {
  it('runs from the repository root down to the working directory', () => {
    const { root, home } = world({ 'home/proj/.git/HEAD': '', 'home/proj/a/b/x': '' })
    const { directories, repository } = instructionDirectories(join(root, 'home/proj/a/b'), home)
    expect(repository).toBe(join(root, 'home/proj'))
    expect(directories).toEqual([join(root, 'home/proj'), join(root, 'home/proj/a'), join(root, 'home/proj/a/b')])
  })

  it('goes up to the home directory without a repository, and stays put outside it', () => {
    const { root, home } = world({ 'home/p/q/x': '', 'elsewhere/r/x': '' })
    expect(instructionDirectories(join(root, 'home/p/q'), home).directories).toEqual([home, join(home, 'p'), join(home, 'p/q')])
    expect(instructionDirectories(join(root, 'elsewhere/r'), home).directories).toEqual([join(root, 'elsewhere/r')])
  })
})

describe('loadInstructions', () => {
  it('reads the user file, then each directory\'s CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md, broad to specific', () => {
    const { root, home } = world({
      'home/.claude/CLAUDE.md': 'user',
      'home/proj/.git/HEAD': '',
      'home/proj/CLAUDE.md': 'root',
      'home/proj/.claude/CLAUDE.md': 'root dot',
      'home/proj/CLAUDE.local.md': 'root local',
      'home/proj/sub/CLAUDE.md': 'sub',
    })
    const set = loadInstructions({ cwd: join(root, 'home/proj/sub'), home })
    expect(names(set, root)).toEqual(['home/.claude/CLAUDE.md', 'home/proj/CLAUDE.md', 'home/proj/.claude/CLAUDE.md', 'home/proj/CLAUDE.local.md', 'home/proj/sub/CLAUDE.md'])
    expect(set.files.map(file => file.kind)).toEqual(['user', 'project', 'project', 'local', 'project'])
  })

  it('does not read above the repository root', () => {
    const { root, home } = world({ 'home/CLAUDE.md': 'home level', 'home/proj/.git/HEAD': '', 'home/proj/CLAUDE.md': 'proj' })
    expect(names(loadInstructions({ cwd: join(root, 'home/proj'), home }), root)).toEqual(['home/proj/CLAUDE.md'])
  })

  it('reads the files of the home directory only once when the user file is the home\'s .claude/CLAUDE.md', () => {
    const { root, home } = world({ 'home/.claude/CLAUDE.md': 'u', 'home/CLAUDE.md': 'h' })
    expect(names(loadInstructions({ cwd: home, home }), root)).toEqual(['home/.claude/CLAUDE.md', 'home/CLAUDE.md'])
  })

  it('leaves out what the host already injects but still follows its imports', () => {
    const { root, home } = world({
      'home/proj/.git/HEAD': '',
      'home/proj/CLAUDE.md': 'See @docs/rules.md',
      'home/proj/CLAUDE.local.md': 'local text',
      'home/proj/.claude/CLAUDE.md': 'dot',
      'home/proj/docs/rules.md': 'rules',
    })
    const set = loadInstructions({ cwd: join(root, 'home/proj'), home, hostLoads: ['CLAUDE.md', 'CLAUDE.local.md'] })
    expect(names(set, root)).toEqual(['home/proj/docs/rules.md', 'home/proj/.claude/CLAUDE.md'])
    expect(set.hostFiles.map(file => file.path.slice(root.length + 1))).toEqual([join('home/proj/CLAUDE.md'), join('home/proj/CLAUDE.local.md')])
    expect(set.files[0]).toMatchObject({ kind: 'import', importedBy: join(root, 'home/proj/CLAUDE.md') })
  })

  it('does not treat a file the host does not read as host-loaded (no repository: the host reads only the working directory)', () => {
    const { root, home } = world({ 'home/CLAUDE.md': 'home level', 'home/p/CLAUDE.md': 'p' })
    const set = loadInstructions({ cwd: join(root, 'home/p'), home, hostLoads: ['CLAUDE.md'] })
    expect(names(set, root)).toEqual(['home/CLAUDE.md'])
  })

  it('reads Codex\'s global instructions, preferring the override', () => {
    const { root, home } = world({ 'codex/AGENTS.md': 'plain', 'codex/AGENTS.override.md': 'override' })
    const set = loadInstructions({ cwd: join(root, 'x'), home, codexHome: join(root, 'codex') })
    expect(set.files).toMatchObject([{ kind: 'codex', content: 'override' }])
    expect(loadInstructions({ cwd: join(root, 'x'), home, codexHome: join(root, 'codex'), skipCodex: true }).files).toEqual([])
  })

  it('ignores empty files', () => {
    const { root, home } = world({ 'home/proj/.git/HEAD': '', 'home/proj/CLAUDE.md': '  \n' })
    expect(loadInstructions({ cwd: join(root, 'home/proj'), home }).files).toEqual([])
  })
})

describe('imports', () => {
  it('finds @paths outside code, and not e-mail addresses', () => {
    const text = ['See @a.md and @./b.md, also @~/c.md', 'mail me@example.com', '`@inline.md` here', '```', '@fenced.md', '```', '~~~~', '```', '@still-fenced.md', '~~~~', '@after.md', '@a\\ b.md#section'].join('\n')
    expect(importPaths(text)).toEqual(['a.md', './b.md,', '~/c.md', 'after.md', 'a b.md'])
  })

  it('expands relative, home-relative and nested imports after the importing file, each file once', () => {
    const { root, home } = world({
      'home/proj/.git/HEAD': '',
      'home/proj/CLAUDE.md': '@one.md\n@~/.claude/mine.md\n@one.md',
      'home/proj/one.md': '@sub/two.md',
      'home/proj/sub/two.md': 'two',
      'home/.claude/mine.md': 'mine',
    })
    // The person approved this project's external imports in Claude Code.
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [join(root, 'home/proj')]: { hasClaudeMdExternalIncludesApproved: true } } }))
    const set = loadInstructions({ cwd: join(root, 'home/proj'), home })
    expect(names(set, root)).toEqual(['home/proj/CLAUDE.md', 'home/proj/one.md', 'home/proj/sub/two.md', 'home/.claude/mine.md'])
  })

  it('survives import cycles', () => {
    const { root, home } = world({ 'home/proj/.git/HEAD': '', 'home/proj/CLAUDE.md': '@a.md', 'home/proj/a.md': '@b.md', 'home/proj/b.md': '@CLAUDE.md @a.md' })
    expect(names(loadInstructions({ cwd: join(root, 'home/proj'), home }), root)).toEqual(['home/proj/CLAUDE.md', 'home/proj/a.md', 'home/proj/b.md'])
  })

  it(`stops after ${String(MAX_IMPORT_DEPTH)} levels`, () => {
    const layout: Record<string, string> = { 'home/proj/.git/HEAD': '', 'home/proj/CLAUDE.md': '@f1.md' }
    for (let level = 1; level <= 8; level++) layout[`home/proj/f${String(level)}.md`] = `level ${String(level)} @f${String(level + 1)}.md`
    const { root, home } = world(layout)
    const set = loadInstructions({ cwd: join(root, 'home/proj'), home })
    expect(names(set, root)).toEqual(['home/proj/CLAUDE.md', ...[1, 2, 3, 4, 5].map(level => `home/proj/f${String(level)}.md`)])
    expect(set.skipped.some(item => item.reason.includes('deeper'))).toBe(true)
  })

  it('keeps imports of a project file inside the repository, ~/.claude included', () => {
    const { root, home } = world({
      'home/proj/.git/HEAD': '',
      'home/proj/CLAUDE.md': '@../secret.txt @~/.claude/ok.md',
      'home/secret.txt': 'secret',
      'home/.claude/ok.md': 'ok',
    })
    const set = loadInstructions({ cwd: join(root, 'home/proj'), home })
    expect(names(set, root)).toEqual(['home/proj/CLAUDE.md'])
    expect(set.skipped).toEqual([
      { path: join(root, 'home/secret.txt'), reason: 'an import outside the workspace' },
      { path: join(root, 'home/.claude/ok.md'), reason: 'an import outside the workspace' },
    ])
  })

  it('outside Git, keeps imports inside the working directory although files are found up to home', () => {
    const { root, home } = world({
      'home/CLAUDE.md': '@notes/private.md',
      'home/notes/private.md': 'private',
      'home/p/q/CLAUDE.md': '@../../secret.txt @inside.md',
      'home/p/q/inside.md': 'inside',
      'home/secret.txt': 'secret',
    })
    const set = loadInstructions({ cwd: join(root, 'home/p/q'), home })
    expect(names(set, root)).toEqual(['home/CLAUDE.md', 'home/p/q/CLAUDE.md', 'home/p/q/inside.md'])
    expect(set.skipped.map(item => item.path).sort()).toEqual([join(root, 'home/notes/private.md'), join(root, 'home/secret.txt')].sort())
  })

  it('checks the boundary after resolving a symlinked working directory', () => {
    const { root, home } = world({ 'real/proj/.git/HEAD': '', 'real/proj/CLAUDE.md': '@doc.md @../outside.md', 'real/proj/doc.md': 'doc', 'real/outside.md': 'out' })
    try {
      mkdirSync(home, { recursive: true })
      symlinkSync(join(root, 'real/proj'), join(home, 'proj'))
    } catch {
      return
    }
    const set = loadInstructions({ cwd: join(home, 'proj'), home })
    expect(set.files.map(file => file.content)).toEqual(['@doc.md @../outside.md', 'doc'])
  })

  it('lets the user\'s own file import from anywhere', () => {
    const { root, home } = world({ 'home/.claude/CLAUDE.md': '@../secret.txt', 'home/secret.txt': 'mine' })
    expect(names(loadInstructions({ cwd: join(root, 'x'), home }), root)).toEqual(['home/.claude/CLAUDE.md', 'home/secret.txt'])
  })

  it('reads "@notes.md." as notes.md', () => {
    const { root, home } = world({ 'home/proj/.git/HEAD': '', 'home/proj/CLAUDE.md': 'See @notes.md.', 'home/proj/notes.md': 'notes' })
    expect(names(loadInstructions({ cwd: join(root, 'home/proj'), home }), root)).toEqual(['home/proj/CLAUDE.md', 'home/proj/notes.md'])
  })

  it('does not follow a symlink out of the project', () => {
    const { root, home } = world({ 'home/proj/.git/HEAD': '', 'home/proj/CLAUDE.md': '@link.md', 'home/outside.md': 'outside' })
    try {
      symlinkSync(join(root, 'home/outside.md'), join(root, 'home/proj/link.md'))
    } catch {
      return
    }
    expect(names(loadInstructions({ cwd: join(root, 'home/proj'), home }), root)).toEqual(['home/proj/CLAUDE.md'])
  })

  it('stops reading at an aggregate budget of bytes and files, and says so', () => {
    // Many files, each one permitted and well under the per-file cap, together far over the budget.
    const count = INSTRUCTION_PATHS_TRIED + 50
    const size = Math.ceil((INSTRUCTION_READ_BYTES * 4) / count)
    const layout: Record<string, string> = { 'home/proj/.git/HEAD': '' }
    const chunk = 'x'.repeat(size)
    for (let index = 0; index < count; index++) layout[`home/proj/docs/f${String(index)}.md`] = chunk
    layout['home/proj/CLAUDE.md'] = Array.from({ length: count }, (_, index) => `@docs/f${String(index)}.md`).join('\n')
    const { root, home } = world(layout)
    const set = loadInstructions({ cwd: join(root, 'home/proj'), home })
    const read = set.files.reduce((sum, file) => sum + file.bytes, 0)
    expect(read).toBeLessThanOrEqual(INSTRUCTION_READ_BYTES)
    expect(set.files.length).toBeLessThan(count)
    expect(set.stopped).toMatch(/stopped reading/u)
    expect(renderInstructions(set.files, undefined, set.stopped).text).toContain(set.stopped)

    // Many small files: the number of files opened is bounded too.
    const small: Record<string, string> = { 'home/proj/.git/HEAD': '' }
    for (let index = 0; index < count; index++) small[`home/proj/docs/f${String(index)}.md`] = 'y'
    small['home/proj/CLAUDE.md'] = Array.from({ length: count }, (_, index) => `@docs/f${String(index)}.md`).join('\n')
    const many = world(small)
    const smallSet = loadInstructions({ cwd: join(many.root, 'home/proj'), home: many.home })
    expect(smallSet.files.length).toBeLessThanOrEqual(INSTRUCTION_PATHS_TRIED)
    expect(smallSet.stopped).toMatch(/stopped reading/u)
  })

  it('charges every path it tries against the budget, a missing import too, and tries none once it stopped', () => {
    const count = INSTRUCTION_PATHS_TRIED + 50
    const { root, home } = world({
      'home/proj/.git/HEAD': '',
      'home/proj/real.md': 'REAL',
      'home/proj/CLAUDE.md': [...Array.from({ length: count }, (_, index) => `@missing${String(index)}.md`), '@real.md'].join('\n'),
    })
    const set = loadInstructions({ cwd: join(root, 'home/proj'), home })
    expect(set.stopped).toMatch(/stopped reading/u)
    expect(set.files.map(file => file.content)).not.toContain('REAL')
  })

  it('charges the bytes of a binary file it read against the budget', () => {
    // Binary files just under the per-file cap, together over the budget, then a text import.
    const size = 1_000_000
    const count = Math.ceil(INSTRUCTION_READ_BYTES / size) + 1
    const layout: Record<string, string> = { 'home/proj/.git/HEAD': '', 'home/proj/real.md': 'REAL' }
    for (let index = 0; index < count; index++) layout[`home/proj/bin${String(index)}.md`] = '\0'.repeat(size)
    layout['home/proj/CLAUDE.md'] = [...Array.from({ length: count }, (_, index) => `@bin${String(index)}.md`), '@real.md'].join('\n')
    const { root, home } = world(layout)
    const set = loadInstructions({ cwd: join(root, 'home/proj'), home })
    expect(set.stopped).toMatch(/stopped reading/u)
    expect(set.files.map(file => file.content)).not.toContain('REAL')
  })

  it('refuses a project import of a network share before touching it (Windows would sign in to the server)', () => {
    const { root, home } = world({
      'home/proj/.git/HEAD': '',
      'home/proj/real.md': 'REAL',
      'home/proj/CLAUDE.md': '@//evil/share/x.md\n@\\\\evil\\share\\y.md\n@real.md',
    })
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    let set: ReturnType<typeof loadInstructions>
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      set = loadInstructions({ cwd: join(root, 'home/proj'), home })
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
    expect(set.files.map(file => file.content)).toContain('REAL')
    // A backslash path is no import at all (`importPaths`); the `//` form is refused unread.
    expect(set.skipped.map(entry => [entry.path, entry.reason])).toEqual([['//evil/share/x.md', 'an import outside the workspace']])
  })

  it('lists a bounded number of files it did not use', () => {
    const count = INSTRUCTION_SKIPS_LISTED * 4
    const layout: Record<string, string> = { 'home/proj/.git/HEAD': '' }
    for (let index = 0; index < count; index++) layout[`home/outside/f${String(index)}.md`] = 'z'
    layout['home/proj/CLAUDE.md'] = Array.from({ length: count }, (_, index) => `@../outside/f${String(index)}.md`).join('\n')
    const { root, home } = world(layout)
    const set = loadInstructions({ cwd: join(root, 'home/proj'), home })
    expect(set.skipped.length).toBe(INSTRUCTION_SKIPS_LISTED)
    expect(set.skippedUnlisted).toBe(count - INSTRUCTION_SKIPS_LISTED)
  })

  it('does not import AGENTS.md references (Codex has no imports)', () => {
    const { root, home } = world({ 'codex/AGENTS.md': '@other.md', 'codex/other.md': 'other' })
    const set = loadInstructions({ cwd: join(root, 'x'), home, codexHome: join(root, 'codex') })
    expect(set.files.map(file => file.kind)).toEqual(['codex'])
  })
})

describe('renderInstructions', () => {
  const file = (path: string, content: string, kind: 'project' | 'user' = 'project'): Parameters<typeof renderInstructions>[0][number] => ({ path, kind, content, bytes: Buffer.byteLength(content) })

  it('frames each file with its path and kind', () => {
    const rendered = renderInstructions([file('/h/.claude/CLAUDE.md', 'be brief', 'user'), file('/p/CLAUDE.md', 'use tabs')])
    expect(rendered.text).toContain("Contents of /h/.claude/CLAUDE.md (user's private global instructions for all projects):\n\nbe brief")
    expect(rendered.text).toContain('Contents of /p/CLAUDE.md (project instructions, checked into the codebase):\n\nuse tabs')
    expect(rendered.text.indexOf('be brief')).toBeLessThan(rendered.text.indexOf('use tabs'))
    expect(rendered.included.map(item => item.path)).toEqual(['/h/.claude/CLAUDE.md', '/p/CLAUDE.md'])
    expect(renderInstructions([]).text).toBe('')
  })

  it('leaves out the broadest files first and says so', () => {
    const rendered = renderInstructions([file('/a', 'a'.repeat(400)), file('/b', 'b'.repeat(400)), file('/c', 'c'.repeat(400))], 1500)
    expect(rendered.omitted).toEqual(['/a'])
    expect(rendered.truncated).toEqual([])
    expect(rendered.text).toContain('left out: /a')
    expect(rendered.text).not.toContain('aaaa')
    expect(rendered.text).toContain('bbbb')
  })

  it('cuts the most specific file when it alone is over the budget, on a character boundary', () => {
    const rendered = renderInstructions([file('/a', 'x'), file('/b', '你'.repeat(2000))], 800)
    expect(rendered.omitted).toEqual(['/a'])
    expect(rendered.truncated).toEqual(['/b'])
    expect(rendered.text).toContain('[truncated]')
    expect(rendered.text).not.toContain('\uFFFD')
    expect(Buffer.byteLength(rendered.text)).toBeLessThanOrEqual(900)
  })

  it('skips a project instruction file that is a symbolic link out of the workspace', () => {
    const { root, home } = world({ 'home/secret.txt': 'SECRET', 'home/proj/.git/HEAD': '', 'home/proj/docs/rules.md': 'RULES' })
    const proj = join(root, 'home/proj')
    mkdirSync(join(proj, '.claude'))
    symlinkSync(join(home, 'secret.txt'), join(proj, '.claude', 'CLAUDE.md'))
    symlinkSync(join(home, 'secret.txt'), join(proj, 'CLAUDE.local.md'))
    symlinkSync(join(proj, 'docs', 'rules.md'), join(proj, 'CLAUDE.md'))
    const set = loadInstructions({ cwd: proj, home })
    expect(JSON.stringify(set.files)).not.toContain('SECRET')
    expect(names(set, root)).toEqual(['home/proj/CLAUDE.md'])
    expect(set.skipped).toEqual([
      { path: join(proj, '.claude', 'CLAUDE.md'), reason: 'a link to a file outside the workspace' },
      { path: join(proj, 'CLAUDE.local.md'), reason: 'a link to a file outside the workspace' },
    ])
  })
})
