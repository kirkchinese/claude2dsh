import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Paths plugin and hook configurations name, on a simulated Windows (see core's test of the same name). */
const fake = vi.hoisted(() => {
  const touched: string[] = []
  const check = (call: string, path: string): void => {
    if (/^(?:\\\\|\/\/)evil/iu.test(path)) {
      touched.push(`${call} ${path}`)
      throw new Error(`touched a share: ${call} ${path}`)
    }
  }
  const missing = (): never => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
  const dirs = new Set(['C:\\', 'C:\\plugin', 'C:\\work'])
  return {
    touched,
    lstatSync: (path: string) => { check('lstat', path); return dirs.has(path) ? { isSymbolicLink: () => false } : missing() },
    readlinkSync: (path: string) => { check('readlink', path); return missing() },
    statSync: (path: string) => { check('stat', path); return dirs.has(path) ? { isFile: () => false, isDirectory: () => true } : missing() },
    existsSync: (path: string) => { try { check('exists', path); return dirs.has(path) } catch { return false } },
  }
})
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  const mocked = { ...fs, lstatSync: fake.lstatSync, readlinkSync: fake.readlinkSync, statSync: fake.statSync, existsSync: fake.existsSync }
  return { ...mocked, default: mocked }
})
vi.mock('node:path', async (original) => {
  const path = await original<typeof import('node:path')>()
  return { ...path.win32, default: path.win32, win32: path.win32, posix: path.posix }
})

const { findProgram, mcpClientConfig } = await import('../src/mcp/mount.js')
const { fileChangedTargets } = await import('../src/hooks/broker/session-events.js')

describe('paths a plugin or hook configuration names, on Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() => {
    fake.touched.length = 0
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
  })

  it('never look for an MCP server\'s program on a share its plugin is not on', () => {
    for (const program of ['\\\\evil\\share\\server.exe', '//evil/share/server.exe']) expect(findProgram(program, 'C:\\plugin', { PATH: '' }), program).toBeUndefined()
    expect(fake.touched).toEqual([])
  })

  it('refuse an MCP server\'s working directory on a share its plugin is not on', () => {
    const component = { id: 'codex:p:mcp:s', kind: 'mcp', name: 's', transport: 'stdio', command: 'node', cwd: '\\\\evil\\share' } as never
    expect(() => mcpClientConfig(component, 's', { pluginRoot: 'C:\\plugin', dataDir: 'C:\\data' })).toThrow(/network share/u)
    expect(fake.touched).toEqual([])
  })

  it('never watch a file a FileChanged matcher names on a share the working directory is not on', () => {
    expect(fileChangedTargets('\\\\evil\\share\\x.txt|notes.md|//evil/share/y', 'C:\\work')).toEqual(['C:\\work\\notes.md'])
    expect(fake.touched).toEqual([])
  })
})
