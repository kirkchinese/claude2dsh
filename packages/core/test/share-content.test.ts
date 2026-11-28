import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Paths a file's content names, on a simulated Windows: `node:path` is Windows' and `node:fs` a tree in which a
 * call that would touch `\\evil` is recorded (and fails), as Windows would sign in to that server.
 */
const fake = vi.hoisted(() => {
  const files: Record<string, string> = {
    // The review's probe: a local package whose entry fields name a share.
    'C:\\tree\\pkg\\package.json': JSON.stringify({ main: '\\\\evil\\share\\main.js', module: '//evil/share/module.js', exports: { '.': '\\\\evil\\share\\exports.js' } }),
    // A checkout's `.git` file claiming a worktree on a share.
    'C:\\repo\\.git': 'gitdir: \\\\evil\\share\\repo\\.git\\worktrees\\x',
    // A Codex agent role whose `config_file` is on a share.
    'C:\\proj\\.codex\\config.toml': '',
  }
  const dirs = new Set(['C:\\', 'C:\\tree', 'C:\\tree\\pkg', 'C:\\repo', 'C:\\repo\\sub', 'C:\\proj', 'C:\\proj\\.codex'])
  const touched: string[] = []
  const check = (call: string, path: string): string => {
    if (path.toLowerCase().startsWith('\\\\evil') || path.toLowerCase().startsWith('//evil')) {
      touched.push(`${call} ${path}`)
      throw new Error(`touched a share: ${call} ${path}`)
    }
    return path
  }
  const missing = (): never => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
  const stat = (path: string) => {
    const at = check('stat', path)
    if (Object.hasOwn(files, at)) return { isFile: () => true, isDirectory: () => false, mtimeMs: 0, size: files[at]!.length }
    if (dirs.has(at)) return { isFile: () => false, isDirectory: () => true, mtimeMs: 0, size: 0 }
    return missing()
  }
  return {
    touched,
    lstatSync: (path: string) => {
      const at = check('lstat', path)
      return Object.hasOwn(files, at) || dirs.has(at) ? { isSymbolicLink: () => false, isFile: () => Object.hasOwn(files, at) } : missing()
    },
    readlinkSync: (path: string) => missing() ?? check('readlink', path),
    statSync: stat,
    existsSync: (path: string) => { try { stat(path); return true } catch { return false } },
    readFileSync: (path: string) => files[check('read', path)] ?? missing(),
    realpathSync: (path: string) => { stat(path); return path },
    readdirSync: (path: string) => { check('readdir', path); return missing() },
  }
})
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  const realpathSync = Object.assign(fake.realpathSync, { native: fake.realpathSync })
  const mocked = { ...fs, lstatSync: fake.lstatSync, readlinkSync: fake.readlinkSync, statSync: fake.statSync, existsSync: fake.existsSync, readFileSync: fake.readFileSync, realpathSync, readdirSync: fake.readdirSync }
  return { ...mocked, default: mocked }
})
vi.mock('node:path', async (original) => {
  const path = await original<typeof import('node:path')>()
  return { ...path.win32, default: path.win32, win32: path.win32, posix: path.posix }
})

const { pluginEntryOf } = await import('../src/dialects/opencode/inventory.js')
const { workspaceRootOf } = await import('../src/trust.js')
const { codexAgentRoles } = await import('../src/dialects/codex/user-assets.js')

describe('paths a file names, on Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() => {
    fake.touched.length = 0
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
  })

  it('never touch a share an OpenCode package\'s main, module or exports names', () => {
    expect(pluginEntryOf('C:\\tree\\pkg')).toBeUndefined()
    expect(fake.touched).toEqual([])
  })

  it('never touch a share a checkout\'s .git file names as its worktree', () => {
    expect(workspaceRootOf('C:\\repo\\sub')).toBe('C:\\repo')
    expect(fake.touched).toEqual([])
  })

  it('never touch a share a Codex agent role names as its config_file', () => {
    expect(codexAgentRoles('codex:project', 'C:\\proj\\.codex', { agents: { reviewer: { config_file: '\\\\evil\\share\\role.toml', description: 'r' } } })).toHaveLength(1)
    expect(fake.touched).toEqual([])
  })
})
