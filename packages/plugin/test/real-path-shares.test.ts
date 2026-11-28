import { describe, expect, it } from 'vitest'
import { realPathOf, type RealPathSystem } from '../src/hooks/condition.js'
import { ruleVerdict } from '../src/hooks/permissions.js'
import { foreignTool } from '../src/hooks/vocabulary.js'

/**
 * A simulated Windows filesystem: `links` maps a path to its link or junction target, `long` maps a short (8.3)
 * path to the long one realpath reports, and every call is recorded so a test can tell nothing touched a share.
 */
function windows(links: Readonly<Record<string, string>>, long: Readonly<Record<string, string>> = {}): RealPathSystem & { calls: string[] } {
  const calls: string[] = []
  const touch = (call: string, path: string): void => {
    calls.push(`${call} ${path}`)
    if (path.startsWith('\\\\') || path.startsWith('//')) throw new Error(`touched a share: ${path}`)
  }
  return {
    platform: 'win32',
    calls,
    lstat(path) {
      touch('lstat', path)
      return { isSymbolicLink: () => Object.hasOwn(links, path) }
    },
    readlink(path) {
      touch('readlink', path)
      return links[path]!
    },
    realpath(path) {
      touch('realpath', path)
      for (const [short, full] of Object.entries(long)) if (path.startsWith(short)) return full + path.slice(short.length)
      return path
    },
  }
}

describe('realPathOf on Windows', () => {
  const cwd = 'C:\\work\\repo'
  it('makes no filesystem call for a path on a network share the working directory is not on', () => {
    for (const path of ['\\\\evil\\share\\x', '//evil/share/x', '\\\\?\\UNC\\evil\\share\\x', '\\\\.\\pipe\\x']) {
      const fs = windows({})
      expect(realPathOf(path, cwd, fs), path).toBeUndefined()
      expect(fs.calls, path).toEqual([])
    }
  })

  it('never calls realpath through a junction or a chain of links to a share', () => {
    const fs = windows({ 'C:\\work\\repo\\j': '\\\\evil\\share', 'C:\\work\\repo\\a': 'C:\\work\\repo\\b', 'C:\\work\\repo\\b': '//evil/share/x' })
    for (const path of ['C:\\work\\repo\\j\\x', 'C:\\work\\repo\\a\\y']) expect(realPathOf(path, cwd, fs), path).toBeUndefined()
    expect(fs.calls.filter(call => call.startsWith('realpath'))).toEqual([])
  })

  it('still resolves a local path with realpath, which expands a short name', () => {
    const fs = windows({}, { 'C:\\Users\\RUNNER~1': 'C:\\Users\\runneradmin' })
    expect(realPathOf('C:\\Users\\RUNNER~1\\x', cwd, fs)).toBe('C:\\Users\\runneradmin\\x')
    // A workspace on a share may resolve paths on that same share.
    expect(realPathOf('\\\\srv\\proj\\x', '\\\\srv\\proj', { ...windows({}), lstat: () => ({ isSymbolicLink: () => false }), realpath: path => path })).toBe('\\\\srv\\proj\\x')
  })

  // Rules read paths with the platform's own path functions, so this runs where they are Windows'.
  it.runIf(process.platform === 'win32')('answers a rule or a target on a new share as unknown: deny and ask match, allow does not', () => {
    {
      const context = { cwd, agentName: () => undefined, presetOf: () => undefined }
      const read = foreignTool('claude-code', 'read', { file_path: '\\\\evil\\share\\x' }, context)
      const bash = foreignTool('claude-code', 'bash', { command: 'cat < //evil/share/x' }, context)
      expect(ruleVerdict({ allow: ['Read(//evil/share/**)'], deny: [], ask: [] }, read, cwd)).toBeUndefined()
      expect(ruleVerdict({ allow: [], deny: ['Read(//other/**)'], ask: [] }, read, cwd)?.kind).toBe('deny')
      expect(ruleVerdict({ allow: ['Bash(cat *)', 'Read(//evil/share/**)'], deny: [], ask: [] }, bash, cwd)).toBeUndefined()
      // A deny rule naming a share denies a read on it.
      expect(ruleVerdict({ allow: [], deny: ['Read(//evil/share/**)'], ask: [] }, read, cwd)?.kind).toBe('deny')
    }
  })
})
