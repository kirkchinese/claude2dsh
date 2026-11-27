import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeCodeTrusts, claudeMcpApproval, codexTrusts, hasShellDirective, mcpComponents, repositoryRootOf, restrictiveSettings, trustRequirement, workspaceRootOf, type ForeignComponent } from '../src/index.js'

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function world(layout: Record<string, string>): { root: string; home: string } {
  // Canonical, as the workspace root is (macOS's temporary directory is behind a symbolic link).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-forge-trust-')))
  temporary.push(root)
  for (const [path, text] of Object.entries(layout)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return { root, home: join(root, 'home') }
}

const claudeJson = (home: string, projects: Record<string, unknown>): void => {
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects }))
}

describe('workspace root', () => {
  it('is the repository root, a worktree\'s main checkout (only when the main repository points back at it), else the directory', () => {
    const { root } = world({
      'main/.git/HEAD': '',
      'main/a/x': '',
      'main/.git/worktrees/wt/HEAD': '',
      'wt/.git': 'gitdir: ../main/.git/worktrees/wt\n',
      'evil/.git': 'gitdir: ../main/.git/worktrees/wt\n',
      'stray/.git': 'gitdir: ../main/.git/worktrees/nothing\n',
      'loose/x': '',
    })
    writeFileSync(join(root, 'main/.git/worktrees/wt/gitdir'), `${join(root, 'wt', '.git')}\n`)
    expect(workspaceRootOf(join(root, 'main/a'))).toBe(join(root, 'main'))
    expect(repositoryRootOf(join(root, 'wt'))).toBe(join(root, 'main'))
    // A `.git` file that claims another checkout's worktree entry, or one that does not exist, is its own repository.
    expect(repositoryRootOf(join(root, 'evil'))).toBe(join(root, 'evil'))
    expect(repositoryRootOf(join(root, 'stray'))).toBe(join(root, 'stray'))
    expect(workspaceRootOf(join(root, 'loose'))).toBe(join(root, 'loose'))
  })

  it('does not let a symbolic-link `.git` borrow a legitimate worktree\'s marker', () => {
    const { root } = world({ 'main/.git/HEAD': '', 'main/.git/worktrees/wt/HEAD': '', 'wt/.git': 'gitdir: ../main/.git/worktrees/wt\n', 'mimic/x': '' })
    writeFileSync(join(root, 'main/.git/worktrees/wt/gitdir'), `${join(root, 'wt', '.git')}\n`)
    symlinkSync(join(root, 'wt', '.git'), join(root, 'mimic', '.git'))
    expect(repositoryRootOf(join(root, 'wt'))).toBe(join(root, 'main'))
    expect(repositoryRootOf(join(root, 'mimic'))).toBe(join(root, 'mimic'))
  })
})

describe('Claude Code trust', () => {
  it('reads hasTrustDialogAccepted of the workspace', () => {
    const { root, home } = world({ 'home/proj/.git/HEAD': '', 'home/other/.git/HEAD': '' })
    claudeJson(home, { [join(home, 'proj')]: { hasTrustDialogAccepted: true }, [join(home, 'other')]: { hasTrustDialogAccepted: false } })
    expect(claudeCodeTrusts(join(home, 'proj'), home)).toBe(true)
    expect(claudeCodeTrusts(join(home, 'other'), home)).toBe(false)
    expect(claudeCodeTrusts(join(root, 'nowhere'), home)).toBe(false)
  })

  it('lets a trusted parent cover a plain folder, but not a repository, and not from the home directory', () => {
    const { home } = world({ 'home/work/notes/x': '', 'home/work/repo/.git/HEAD': '', 'home/loose/x': '' })
    claudeJson(home, { [join(home, 'work')]: { hasTrustDialogAccepted: true }, [home]: { hasTrustDialogAccepted: true } })
    expect(claudeCodeTrusts(join(home, 'work/notes'), home)).toBe(true)
    expect(claudeCodeTrusts(join(home, 'work/repo'), home)).toBe(false)
    expect(claudeCodeTrusts(join(home, 'loose'), home)).toBe(false)
  })

  it('reads Codex\'s trusted projects', () => {
    const { home } = world({ 'home/.codex/config.toml': '', 'home/proj/.git/HEAD': '' })
    writeFileSync(join(home, '.codex/config.toml'), `[projects.${JSON.stringify(join(home, 'proj'))}]\ntrust_level = "trusted"\n`)
    const previous = process.env['CODEX_HOME']
    delete process.env['CODEX_HOME']
    try {
      expect(codexTrusts(join(home, 'proj'), home)).toBe(true)
      expect(codexTrusts(join(home, 'elsewhere'), home)).toBe(false)
    } finally {
      if (previous !== undefined) process.env['CODEX_HOME'] = previous
    }
  })

  it('approves a project MCP server only from the person\'s own settings until trusted; a rejection always counts', () => {
    const { home } = world({
      'home/proj/.git/HEAD': '',
      'home/proj/.claude/settings.json': JSON.stringify({ enableAllProjectMcpServers: true, disabledMcpjsonServers: ['bad'] }),
      'home/.claude/settings.json': JSON.stringify({ enabledMcpjsonServers: ['mine'] }),
    })
    const proj = join(home, 'proj')
    expect(claudeMcpApproval('any', proj, proj, false, home)).toBe('pending')
    expect(claudeMcpApproval('any', proj, proj, true, home)).toBe('approved')
    expect(claudeMcpApproval('mine', proj, proj, false, home)).toBe('approved')
    expect(claudeMcpApproval('bad', proj, proj, true, home)).toBe('disabled')
    claudeJson(home, { [proj]: { enabledMcpjsonServers: ['listed'] } })
    expect(claudeMcpApproval('listed', proj, proj, false, home)).toBe('approved')
  })
})

describe('what needs trust', () => {
  it('finds shell lines', () => {
    expect(hasShellDirective('Status: !`git status`')).toBe(true)
    expect(hasShellDirective('```!\nls\n```')).toBe(true)
    expect(hasShellDirective('KEY=!`cmd` and `code`')).toBe(false)
  })

  it('holds back what runs or grants, not plain prompts', () => {
    const base = { id: 'x', name: 'x' }
    const command = (body: string, frontmatter: Record<string, unknown> = {}): ForeignComponent => ({ ...base, kind: 'command', bodyPath: '', body, frontmatter })
    expect(trustRequirement(command('Say hi $ARGUMENTS'))).toBeUndefined()
    expect(trustRequirement(command('Now: !`date`'))).toBe('runs shell commands')
    expect(trustRequirement(command('hi', { 'allowed-tools': 'Bash' }))).toBe('pre-approves tools')
    expect(trustRequirement({ ...base, kind: 'agent', bodyPath: '', body: '', frontmatter: {} })).toBeUndefined()
    expect(trustRequirement({ ...base, kind: 'hooks', configPath: '', events: [], handlerTypes: [], modules: [] })).toBe('runs hook commands')
    const [project] = mcpComponents('p', { s: { command: 'x' } }, 'project')
    const [local] = mcpComponents('p', { s: { command: 'x' } }, 'local')
    expect(trustRequirement(project!)).toBeDefined()
    expect(trustRequirement(local!)).toBeUndefined()
    expect(trustRequirement({ ...base, kind: 'settings', files: [], permissions: { allow: [], deny: ['Bash'], ask: [] }, env: {} })).toBeUndefined()
    expect(trustRequirement({ ...base, kind: 'settings', files: [], permissions: { allow: [], deny: [], ask: [] }, env: { NODE_OPTIONS: '--require x' } })).toBeDefined()
    expect(trustRequirement({ ...base, kind: 'settings', files: [], permissions: { allow: [], deny: [], ask: [] }, env: {}, disableAllHooks: false })).toBeDefined()
    expect(trustRequirement({ ...base, kind: 'settings', files: [], permissions: { allow: [], deny: [], ask: [] }, env: {}, disableAllHooks: true })).toBeUndefined()
  })

  it('keeps only what reduces privilege of a settings component', () => {
    const settings = { id: 'x', name: 'x', kind: 'settings' as const, files: ['/p/.claude/settings.json'], env: { A: '1' } }
    const mixed = restrictiveSettings({ ...settings, permissions: { allow: ['Bash(*)'], deny: ['Bash(rm:*)'], ask: ['Edit'] }, disableAllHooks: true })
    expect(mixed).toMatchObject({ files: [], env: {}, permissions: { allow: [], deny: ['Bash(rm:*)'], ask: ['Edit'] }, disableAllHooks: true })
    expect(restrictiveSettings({ ...settings, permissions: { allow: ['Bash(*)'], deny: [], ask: [] } })).toBeUndefined()
    expect(restrictiveSettings({ ...settings, permissions: { allow: [], deny: ['Bash'], ask: [] }, disableAllHooks: false })?.disableAllHooks).toBeUndefined()
  })
})
