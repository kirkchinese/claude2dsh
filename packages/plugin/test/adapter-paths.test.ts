import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { hardCodedPaths, pathsDetail, type PathFinding } from '../src/porting/adapter-paths.js'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

/** The rules broken by an adapter with these source files, as `file:line rule`. */
function broken(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'hf-adapter-paths-'))
  roots.push(dir)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return hardCodedPaths(dir).map((item: PathFinding) => `${item.file}:${item.line} ${item.rule}`)
}

/**
 * What the claude-hud statusline adapter of a live "Fill with AI" run wrote
 * (dsh-adapters/run4, `candidateRoots` and its helper): the path is built from
 * parts and listed through a local helper, so no line spells `~/.dsh` or a
 * listing of `profiles`.
 */
const RUN4 = `import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function directories(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(isDirectoryEntry).map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

async function candidateRoots() {
  const roots = new Set();
  const home = os.homedir();
  const profileDirs = await directories(path.join(home, '.dsh', 'profiles'));
  for (const profile of profileDirs) {
    const remote = path.join(profile, '.harness-forge', 'data', 'remote', 'plugins');
    for (const holder of await directories(remote)) roots.add(path.join(holder, 'claude-hud'));
  }
  const oldRemote = path.join(home, '.dsh', '.harness-forge', 'data', 'remote', 'plugins');
  for (const holder of await directories(oldRemote)) roots.add(path.join(holder, 'claude-hud'));
  return [...roots];
}
`

describe('the paths check', () => {
  it('fails the run4 adapter: a DSH home built from the home directory, and a listing of the profiles through a helper', () => {
    expect(broken({ 'index.js': RUN4 })).toEqual([
      'index.js:17 dsh-home',
      'index.js:17 running-profile',
      'index.js:17 profiles-listing',
      'index.js:22 dsh-home',
    ])
  })

  it('names the file, line and rule, and how to fix it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-adapter-paths-'))
    roots.push(dir)
    writeFileSync(join(dir, 'index.js'), RUN4)
    const detail = pathsDetail(hardCodedPaths(dir))
    expect(detail).toContain("index.js:17 [dsh-home] builds the DSH home from the home directory ('.dsh') but the adapter never reads $DSH_HOME")
    expect(detail).toContain('index.js:17 [running-profile] builds a path in profiles/ but the adapter never takes the running profile from profileContext, $DSH_PROFILE or $DSH_PROFILE_DIR')
    expect(detail).toContain('index.js:17 [profiles-listing] lists the profiles directory (directories, which calls readdir)')
  })

  it('catches the same paths spelled other ways', () => {
    expect(broken({ 'a.mjs': "import { homedir } from 'node:os'\nconst dsh = `${homedir()}/.dsh`\nconst all = readdirSync(`${dsh}/profiles`)\n" }))
      .toEqual(['a.mjs:2 dsh-home', 'a.mjs:3 running-profile', 'a.mjs:3 profiles-listing'])
    expect(broken({ 'b.cjs': "const DSH = '.dsh'\nconst root = path.resolve(os.homedir(), DSH, 'profiles')\nfs.promises.readdir(root).then(use)\n" }))
      .toEqual(['b.cjs:1 dsh-home', 'b.cjs:2 running-profile', 'b.cjs:3 profiles-listing'])
    expect(broken({ 'c.ts': "const base = homedir() + '/.dsh'\nconst dir = base + '/profiles/'\nconst list = async (d: string) => (await opendir(d))\nawait list(dir)\n" }))
      .toEqual(['c.ts:1 dsh-home', 'c.ts:2 running-profile', 'c.ts:4 profiles-listing'])
    // A glob over the profiles lists them too, even with a running profile at hand.
    expect(broken({ 'd.js': "const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')\nconst me = process.env.DSH_PROFILE_DIR\nglob(join(home, 'profiles', '*', 'state.json'))\n" }))
      .toEqual(['d.js:3 profiles-listing'])
    // A literal home of one user is never right, $DSH_HOME or not.
    expect(broken({ 'e.tsx': "const home = process.env.DSH_HOME || 'C:\\\\Users\\\\kim\\\\.dsh'\n" })).toEqual(['e.tsx:1 dsh-home'])
    expect(broken({ 'f.js': "const home = '~/.dsh'\n", 'node_modules/x/index.js': "const ignored = '~/.dsh'\n" })).toEqual(['f.js:1 dsh-home'])
  })

  it('passes an adapter that takes the profile from profileContext', () => {
    expect(broken({ 'index.js': "export function apply(ctx) {\n  const profile = ctx.get('profileContext')\n  if (profile) readdirSync(join(profile.dir, '.harness-forge'))\n}\n" })).toEqual([])
  })

  it('passes an adapter that takes the profile from $DSH_PROFILE_DIR', () => {
    expect(broken({ 'index.js': "const dir = process.env.DSH_PROFILE_DIR\nfor (const name of await fs.readdir(path.join(dir, 'cache'))) use(name)\n" })).toEqual([])
  })

  it('passes the brief\'s documented fallback: $DSH_HOME, else ~/.dsh, and $DSH_PROFILE', () => {
    expect(broken({
      'index.js': [
        "import os from 'node:os'",
        "const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')",
        "const profile = path.join(home, 'profiles', process.env.DSH_PROFILE)",
        "const files = await fs.readdir(path.join(profile, 'cache'))",
        "const label = `${home}/profiles/${process.env.DSH_PROFILE}`",
        "console.log('reads ~/.dsh unless DSH_HOME is set; see https://example.com/profiles/')",
      ].join('\n'),
    })).toEqual([])
  })
})
