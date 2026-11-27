/**
 * Workspace trust, as Claude Code keeps it: a project's parts that run code or
 * reach the network (hooks, MCP servers, `!` shell lines of commands and
 * skills, settings that grant tools or set the environment, code plugins) stay
 * off until the person trusts the workspace. Plain skills, agents and commands
 * need no trust.
 *
 * - The workspace of a directory is its Git repository's root (a worktree's
 *   main checkout), else the directory itself; symbolic links are resolved.
 * - Claude Code's trust: `~/.claude.json` `projects[<workspace>].hasTrustDialogAccepted`.
 *   Outside a repository a trusted parent directory covers its subdirectories
 *   (but the home directory and the filesystem root cover only themselves);
 *   a repository needs its own entry.
 * - Codex's trust: `~/.codex/config.toml` `[projects."<workspace>"] trust_level = "trusted"`.
 * - A project `.mcp.json` server also needs Claude Code's approval
 *   (`enabledMcpjsonServers` or `enableAllProjectMcpServers`) when only
 *   Claude Code's trust covers the workspace; `disabledMcpjsonServers`
 *   always rejects it.
 * @module @kirkchinese/harness-forge-core
 */
import { lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { codexHome, readCodexConfig } from './dialects/codex/user-assets.js'
import { isDirectory, isFile, isPlainObject, readJsonObject, readText, realOrLexical, stringArrayField } from './paths.js'
import type { ForeignComponent, SettingsComponent } from './types.js'

/** Where a workspace's trust comes from. */
export type TrustSource = 'claude-code' | 'codex' | 'forge'

function samePath(left: string, right: string): boolean {
  const normalize = (path: string): string => {
    const value = resolve(path).replace(/[\\/]+$/u, '')
    return process.platform === 'win32' ? value.toLowerCase() : value
  }
  return normalize(left) === normalize(right)
}

/** Whether a directory recorded in a config file is `path`, symbolic links resolved on both sides (macOS's `/var` is `/private/var`). */
function sameDirectory(recorded: string, path: string): boolean {
  return samePath(recorded, path) || samePath(realOrLexical(recorded), realOrLexical(path))
}

/** The Git repository root that holds `dir` (a linked worktree's main checkout), or undefined outside one. */
export function repositoryRootOf(dir: string): string | undefined {
  for (let current = realOrLexical(dir); ; current = dirname(current)) {
    const marker = join(current, '.git')
    if (isDirectory(marker)) return current
    if (isFile(marker)) return (isSymbolicLink(marker) ? undefined : linkedMainCheckout(marker)) ?? current
    if (dirname(current) === current) return undefined
  }
}

/**
 * The main checkout of a linked worktree whose `.git` file is `marker`, or
 * undefined. The `.git` file is the checkout's own (anyone can write one), so
 * the claim counts only when the main repository's `.git/worktrees/<name>/gitdir`
 * points back at this very `.git` file: the backlink's directory is
 * canonicalised, its final `.git` is not, so a symbolic link elsewhere cannot
 * stand in for the marker (a symbolic-link marker never claims a main checkout).
 */
function linkedMainCheckout(marker: string): string | undefined {
  const target = /^gitdir:\s*(.+?)\s*$/mu.exec(readText(marker) ?? '')?.[1]
  if (target === undefined) return undefined
  const gitdir = realOrLexical(resolve(dirname(marker), target))
  const main = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/u.exec(gitdir)?.[1]
  if (main === undefined || main.length === 0 || !isDirectory(join(main, '.git'))) return undefined
  const back = readText(join(gitdir, 'gitdir'))?.trim()
  if (back === undefined || back.length === 0) return undefined
  const backPath = resolve(gitdir, back)
  if (basename(backPath) !== '.git') return undefined
  return samePath(join(realOrLexical(dirname(backPath)), '.git'), marker) ? realOrLexical(main) : undefined
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** The workspace a session in `cwd` belongs to: its repository's root, else `cwd` itself, symbolic links resolved. */
export function workspaceRootOf(cwd: string): string {
  return repositoryRootOf(cwd) ?? realOrLexical(cwd)
}

/**
 * The directories whose trust covers a workspace: itself, and outside a
 * repository each parent below the home directory (Claude Code: trusting a
 * folder covers its subdirectories, apart from a repository nested in it).
 */
export function trustKeys(workspace: string, home = homedir()): string[] {
  const keys = [workspace]
  const realHome = realOrLexical(home)
  const isHome = (path: string): boolean => samePath(path, home) || samePath(path, realHome)
  if (repositoryRootOf(workspace) !== undefined || isHome(workspace)) return keys
  // The home directory and the filesystem root cover only themselves.
  for (let current = dirname(workspace); dirname(current) !== current && !isHome(current); current = dirname(current)) keys.push(current)
  return keys
}

/** Claude Code's record for a directory in `~/.claude.json`, if any. */
function claudeProject(home: string, path: string): Record<string, unknown> | undefined {
  const config = readJsonObject(join(home, '.claude.json'))
  const projects = isPlainObject(config?.['projects']) ? config['projects'] : {}
  const entry = Object.entries(projects).find(([key]) => sameDirectory(key, path))?.[1]
  return isPlainObject(entry) ? entry : undefined
}

/** Whether the person accepted Claude Code's trust dialog for the workspace (or a parent that covers it). */
export function claudeCodeTrusts(workspace: string, home = homedir()): boolean {
  return trustKeys(workspace, home).some(key => claudeProject(home, key)?.['hasTrustDialogAccepted'] === true)
}

/** Whether the person approved imports from outside the project for Claude Code instruction files of this workspace. */
export function claudeExternalImportsApproved(workspace: string, home = homedir()): boolean {
  return claudeProject(home, workspace)?.['hasClaudeMdExternalIncludesApproved'] === true
}

/** Whether Codex marks the workspace (or a parent that covers it) trusted. */
export function codexTrusts(workspace: string, home = homedir()): boolean {
  const projects = readCodexConfig(codexHome(home))['projects']
  if (!isPlainObject(projects)) return false
  return trustKeys(workspace, home).some(key => Object.entries(projects).some(([path, entry]) => sameDirectory(path, key) && isPlainObject(entry) && entry['trust_level'] === 'trusted'))
}

/**
 * What Claude Code says about one project `.mcp.json` server: `disabled` by
 * any `disabledMcpjsonServers`, `approved` by `enabledMcpjsonServers` or
 * `enableAllProjectMcpServers` (the project's own settings count only once
 * the workspace is trusted), else `pending`.
 */
export function claudeMcpApproval(name: string, workspace: string, cwd: string, trusted: boolean, home = homedir()): 'approved' | 'disabled' | 'pending' {
  const sources: Record<string, unknown>[] = []
  for (const path of new Set([workspace, realOrLexical(cwd)])) {
    const entry = claudeProject(home, path)
    if (entry !== undefined) sources.push(entry)
  }
  const user = readJsonObject(join(home, '.claude', 'settings.json'))
  if (user !== undefined) sources.push(user)
  const project = ['settings.json', 'settings.local.json'].map(file => readJsonObject(join(realOrLexical(cwd), '.claude', file))).filter((value): value is Record<string, unknown> => value !== undefined)
  // A rejection counts from anywhere; the project's own approvals only once it is trusted.
  if ([...sources, ...project].some(source => stringArrayField(source, 'disabledMcpjsonServers').includes(name))) return 'disabled'
  if (trusted) sources.push(...project)
  return sources.some(source => source['enableAllProjectMcpServers'] === true || stringArrayField(source, 'enabledMcpjsonServers').includes(name)) ? 'approved' : 'pending'
}

/** Whether a command or skill body has a `` !`cmd` `` or ```` ```! ```` shell line. */
export function hasShellDirective(body: string): boolean {
  return /^```!\s*$|(?:^|\s)!`[^`\n]+`/mu.test(body)
}

/**
 * The part of a settings component that only reduces privilege, which holds
 * in an untrusted workspace: `deny` and `ask` rules, `disableAllHooks: true`
 * and the output style. `allow` rules, `env` and `disableAllHooks: false`
 * wait for trust; the settings files are not read through it. Undefined when
 * nothing restrictive remains.
 */
export function restrictiveSettings(component: SettingsComponent): SettingsComponent | undefined {
  const { permissions, env: _env, disableAllHooks, files: _files, ...rest } = component
  const restricted: SettingsComponent = {
    ...rest,
    files: [],
    permissions: { allow: [], deny: permissions.deny, ask: permissions.ask },
    env: {},
    ...(disableAllHooks === true ? { disableAllHooks } : {}),
  }
  const kept = restricted.permissions.deny.length + restricted.permissions.ask.length > 0 || restricted.disableAllHooks === true || restricted.outputStyle !== undefined
  return kept ? restricted : undefined
}

/**
 * Why a project part needs the workspace trusted before it runs, or
 * undefined when it can load untrusted (it runs nothing and grants nothing).
 */
export function trustRequirement(component: ForeignComponent): string | undefined {
  switch (component.kind) {
    case 'hooks': return 'runs hook commands'
    case 'mcp': return component.metadata?.['scope'] === 'local' ? undefined : 'starts or connects to an MCP server'
    case 'settings':
      // Only what grants waits: `deny` and `ask` rules and `disableAllHooks: true` restrict, so they never do (see `restrictiveSettings`).
      return component.permissions.allow.length > 0 || Object.keys(component.env).length > 0 || component.disableAllHooks === false ? 'grants tools, sets the environment or turns hooks back on' : undefined
    case 'code': return 'runs plugin code'
    case 'command':
    case 'skill': {
      const raw: Readonly<Record<string, unknown>> = component.kind === 'skill' ? component.frontmatter.raw : component.frontmatter
      if (raw['hooks'] !== undefined) return 'declares hooks'
      if (raw['allowed-tools'] !== undefined || raw['allowedTools'] !== undefined) return 'pre-approves tools'
      const body = component.kind === 'command' ? component.body : readText(component.bodyPath) ?? ''
      return hasShellDirective(body) ? 'runs shell commands' : undefined
    }
    case 'agent':
      return component.frontmatter['hooks'] !== undefined || component.frontmatter['mcpServers'] !== undefined ? 'declares hooks or MCP servers' : undefined
    case 'ui': return component.surface === 'output-style' ? undefined : 'runs a command'
    case 'other': return component.originalKind === 'codex-instructions' ? undefined : 'runs a command'
    default: return 'runs code'
  }
}
