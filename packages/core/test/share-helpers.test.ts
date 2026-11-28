import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A simulated Windows tree, standing in for `node:fs` under the core file helpers: `C:\tree` holds a plain file, a
 * symbolic link file and a junction to `\\evil\share`; `\\srv\proj` is a share whose own files may be read. Every
 * call is recorded, and a call on `\\evil` fails the test outright.
 */
const fake = vi.hoisted(() => {
  const files: Record<string, string> = { 'C:\\tree\\plain.json': '{"a":1}', '\\\\srv\\proj\\file.json': '{"b":2}' }
  const dirs = new Set(['C:\\', 'C:\\tree', 'C:\\tree\\ok', '\\\\srv\\proj\\'])
  const links: Record<string, string> = { 'C:\\tree\\link.json': '\\\\evil\\share\\x.json', 'C:\\tree\\junction': '\\\\evil\\share\\dir', '\\\\srv\\proj\\out': '\\\\evil\\share' }
  const calls: string[] = []
  const norm = (path: string): string => path.replace(/\//gu, '\\')
  const touched: string[] = []
  // `lstat` and `readlink` read a link itself; every other call follows links, as Windows does.
  const touch = (call: string, path: string): string => {
    const at = norm(path)
    calls.push(`${call} ${at}`)
    const follows = call !== 'lstat' && call !== 'readlink'
    const through = Object.entries(links).find(([link]) => at === link || at.startsWith(`${link}\\`))
    const lands = follows && through !== undefined ? through[1] + at.slice(through[0].length) : at
    if (lands.toLowerCase().startsWith('\\\\evil')) {
      touched.push(`${call} ${at}`)
      throw new Error(`touched a share: ${call} ${at}`)
    }
    return at
  }
  const missing = (): never => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
  const stat = (path: string) => {
    const at = touch('stat', path)
    if (Object.hasOwn(files, at)) return { isFile: () => true, isDirectory: () => false }
    if (dirs.has(at)) return { isFile: () => false, isDirectory: () => true }
    return missing()
  }
  return {
    calls,
    touched,
    lstatSync: (path: string) => {
      const at = touch('lstat', path)
      if (Object.hasOwn(links, at)) return { isSymbolicLink: () => true }
      return Object.hasOwn(files, at) || dirs.has(at) || dirs.has(`${at}\\`) ? { isSymbolicLink: () => false } : missing()
    },
    readlinkSync: (path: string) => links[touch('readlink', path)] ?? missing(),
    statSync: stat,
    readFileSync: (path: string) => files[touch('read', path)] ?? missing(),
    realpathSync: (path: string) => touch('realpath', path),
    readdirSync: (path: string) => {
      const at = touch('readdir', path)
      if (at !== 'C:\\tree') return missing()
      return [
        { name: 'ok', isDirectory: () => true, isSymbolicLink: () => false },
        { name: 'junction', isDirectory: () => false, isSymbolicLink: () => true },
        { name: 'plain.json', isDirectory: () => false, isSymbolicLink: () => false },
      ]
    },
  }
})
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  const realpathSync = Object.assign(fake.realpathSync, { native: fake.realpathSync })
  return { ...fs, default: fs, lstatSync: fake.lstatSync, readlinkSync: fake.readlinkSync, statSync: fake.statSync, readFileSync: fake.readFileSync, realpathSync, readdirSync: fake.readdirSync }
})

const { childDirectories, isDirectory, isFile, readJson, readJsonObject, readJsonRecord, readRecordText, readText, realOrLexical } = await import('../src/paths.js')

describe('the core file helpers on Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() => {
    fake.calls.length = 0
    fake.touched.length = 0
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
  })

  it('refuse a link file or a junction to a network share, as an unreadable file', () => {
    for (const path of ['C:\\tree\\link.json', 'C:\\tree\\junction\\x.json', '\\\\srv\\proj\\out\\y.json']) {
      expect(readText(path), path).toBeUndefined()
      expect(readJson(path), path).toBeUndefined()
      expect(readJsonObject(path), path).toBeUndefined()
      expect(isFile(path), path).toBe(false)
      expect(readRecordText(path).problem, path).toMatch(/leads to a network share/u)
      expect(readJsonRecord(path).problem, path).toMatch(/leads to a network share/u)
    }
    expect(isDirectory('C:\\tree\\junction')).toBe(false)
    expect(realOrLexical('C:\\tree\\link.json')).not.toMatch(/evil/u)
    expect(childDirectories('C:\\tree')).toEqual(['ok'])
    // No call that follows links ever reached the share.
    expect(fake.touched).toEqual([])
  })

  it('still read local files, and a share\'s own files when its links stay on it', () => {
    expect(readJsonObject('C:\\tree\\plain.json')).toEqual({ a: 1 })
    expect(isFile('C:\\tree\\plain.json')).toBe(true)
    expect(isDirectory('C:\\tree\\ok')).toBe(true)
    expect(readJsonRecord('\\\\srv\\proj\\file.json').value).toEqual({ b: 2 })
  })
})

describe('the core file helpers elsewhere', () => {
  // Simulated Linux, so it runs on every runner: on a real Windows one the guard rightly walks the path.
  it('make no extra call off Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      fake.calls.length = 0
      readText('/tree/x')
      isFile('/tree/x')
      expect(fake.calls.filter(call => call.startsWith('lstat') || call.startsWith('readlink'))).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })
})
