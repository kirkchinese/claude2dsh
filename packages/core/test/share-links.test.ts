import { describe, expect, it } from 'vitest'
import { linksReachNewShare, SYMLINK_HOPS, type LinkReader } from '../src/paths.js'

/**
 * A simulated Windows filesystem: `links` maps a path to its link (or junction) target, `files` lists what
 * else exists, and every call is recorded, so a test can tell no call touched a share.
 */
function windows(links: Readonly<Record<string, string>>, files: readonly string[]): LinkReader & { calls: string[] } {
  const calls: string[] = []
  const exists = (path: string): boolean => Object.hasOwn(links, path) || files.some(file => file === path || file.startsWith(`${path}\\`))
  return {
    calls,
    lstat(path) {
      calls.push(`lstat ${path}`)
      if (path.startsWith('\\\\')) throw new Error(`touched a share: ${path}`)
      if (!exists(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { isSymbolicLink: () => Object.hasOwn(links, path) }
    },
    readlink(path) {
      calls.push(`readlink ${path}`)
      return links[path]!
    },
  }
}

describe('linksReachNewShare', () => {
  const base = 'C:\\work\\repo'
  it('finds a junction or link to a share, and a chain to one, with lstat and readlink only', () => {
    const fs = windows({ 'C:\\work\\repo\\j': '\\\\evil\\share', 'C:\\work\\repo\\a': 'C:\\work\\repo\\b', 'C:\\work\\repo\\b': '//evil/share/x', 'C:\\work\\repo\\u': '\\\\?\\UNC\\evil\\share' }, ['C:\\work\\repo\\x'])
    for (const path of ['C:\\work\\repo\\j\\x', 'C:\\work\\repo\\a\\y', 'C:\\work\\repo\\u']) expect(linksReachNewShare(path, base, 'win32', fs), path).toBe(true)
    expect(fs.calls.every(call => !call.includes('\\\\evil'))).toBe(true)
    expect(linksReachNewShare('C:\\work\\repo\\x', base, 'win32', fs)).toBe(false)
  })

  it('treats a path on a new share, a loop and too many links as reaching one, and makes no call for a share', () => {
    const fs = windows({ 'C:\\l1': 'C:\\l2', 'C:\\l2': 'C:\\l1' }, [])
    expect(linksReachNewShare('\\\\evil\\share\\x', base, 'win32', fs)).toBe(true)
    expect(linksReachNewShare('//evil/share/x', base, 'win32', fs)).toBe(true)
    expect(fs.calls).toEqual([])
    expect(linksReachNewShare('C:\\l1\\x', base, 'win32', fs)).toBe(true)
    const chain = Object.fromEntries(Array.from({ length: SYMLINK_HOPS + 1 }, (_, index) => [`C:\\c${String(index)}`, `C:\\c${String(index + 1)}`]))
    expect(linksReachNewShare('C:\\c0', base, 'win32', windows(chain, [`C:\\c${String(SYMLINK_HOPS + 1)}`]))).toBe(true)
  })

  it('lets a path stay on the share its base is on, and does nothing off Windows', () => {
    const fs = windows({}, [])
    expect(linksReachNewShare('\\\\srv\\proj\\x', '\\\\srv\\proj', 'win32', { ...fs, lstat: () => ({ isSymbolicLink: () => false }) })).toBe(false)
    const posix = windows({}, [])
    expect(linksReachNewShare('//evil/share/x', '/work', 'linux', posix)).toBe(false)
    expect(posix.calls).toEqual([])
  })
})
