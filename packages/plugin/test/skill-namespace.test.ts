import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { ForeignSkillProvider } from '../src/skills/provider.js'

/** Temporary folders made by these tests, removed once all of them have run. */
const temporary: string[] = []
afterAll(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

const saved = { DSH_HOME: process.env['DSH_HOME'], DSH_AGENTS_HOME: process.env['DSH_AGENTS_HOME'] }
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function skill(root: string, name: string, body = `Body of ${name}.`): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`)
}

describe('plugin skills beside the person\'s own', () => {
  it('lists a plugin skill a native skill of the same name would hide as <plugin>-<skill>', async () => {
    const base = tempDir('hf-skill-ns-')
    process.env['DSH_HOME'] = join(base, 'dsh')
    process.env['DSH_AGENTS_HOME'] = join(base, 'agents')
    skill(join(base, 'agents', 'skills'), 'handoff')
    const pluginSkills = join(base, 'plugin', 'skills')
    skill(pluginSkills, 'handoff', 'The plugin\'s own handoff.')
    skill(pluginSkills, 'review')
    const provider = new ForeignSkillProvider()
    provider.addRoots([pluginSkills], { pluginRoot: join(base, 'plugin'), pluginName: 'Development Skills' })
    const names = (await provider.list({ cwd: join(base, 'work') } as never)).map(candidate => candidate.name).sort()
    expect(names).toEqual(['development-skills-handoff', 'review'])
  })

  it('leaves out a plugin skill that is the very skill DSH already lists', async () => {
    const base = tempDir('hf-skill-same-')
    process.env['DSH_HOME'] = join(base, 'dsh')
    process.env['DSH_AGENTS_HOME'] = join(base, 'agents')
    skill(join(base, 'agents', 'skills'), 'wiki-query')
    const userSkills = join(base, 'claude', 'skills')
    skill(userSkills, 'wiki-query')
    const provider = new ForeignSkillProvider()
    provider.addRoots([userSkills], { pluginName: 'user' })
    expect((await provider.list({ cwd: base } as never)).map(candidate => candidate.name)).toEqual([])
  })
})