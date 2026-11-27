import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SkillProvider } from '@deepseek-ai/dsh-skill'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import * as main from '../src/index.js'
import * as skills from '../src/skills/row.js'

const temporary: string[] = []
let isolatedHome: string | undefined

beforeAll(() => {
  isolatedHome = mkdtempSync(join(tmpdir(), 'harness-forge-home-'))
  process.env.DSH_HOME = isolatedHome
})

afterAll(() => {
  delete process.env.DSH_HOME
  if (isolatedHome !== undefined) rmSync(isolatedHome, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-plugin-'))
  temporary.push(root)
  return root
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The `harness-forge` row and the skills row on a bare Cordis context with a skill registry and a command registry. */
async function boot(skillRoots: string[]): Promise<{ provider: () => SkillProvider | undefined; command: (name: string) => CommandDefinition | undefined }> {
  let provider: SkillProvider | undefined
  const commands: CommandDefinition[] = []
  const root = new Context()
  root.provide('skills', {
    register: () => () => {},
    registerProvider: (create: (control: { signal: AbortSignal; invalidate(): void }) => SkillProvider) => {
      provider = create({ signal: new AbortController().signal, invalidate() {} })
      return () => {}
    },
  })
  root.provide('commands', { register: (definition: CommandDefinition) => { commands.push(definition); return () => {} } })
  await root.plugin(main as never, {} as never)
  await root.plugin(skills as never, { skillRoots } as never)
  return { provider: () => provider, command: name => commands.find(definition => definition.name === name) }
}

describe('harness-forge and skills rows', () => {
  it('registers a foreign skill provider and /harness command', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'demo'), { recursive: true })
    writeFileSync(join(root, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill\n---\n\nPINEAPPLE\n', 'utf8')

    const { provider, command } = await boot([root])
    expect(provider()).toBeDefined()
    const candidates = await provider()!.list({})
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.name).toBe('demo')
    expect(candidates[0]?.description).toBe('Demo skill')
    const loaded = await provider()!.get(candidates[0]!, {})
    expect(loaded?.content).toContain('PINEAPPLE')

    const harness = command('harness')
    expect(harness).toBeDefined()
    const result = await harness!.handler({ rawInput: 'roots' } as never)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain(root)
  })

  it('describes a skill without a description by its first line, and skips one with no text at all', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'plain'), { recursive: true })
    writeFileSync(join(root, 'plain', 'SKILL.md'), '---\nname: plain\n---\n\n# Tidy imports\n\nSort them.\n', 'utf8')
    mkdirSync(join(root, 'empty'), { recursive: true })
    writeFileSync(join(root, 'empty', 'SKILL.md'), '---\nname: empty\n---\n\n\n', 'utf8')
    const { provider } = await boot([root])
    // Claude Code uses the first non-empty line of the content.
    expect((await provider()!.list({})).map(skill => [skill.name, skill.description])).toEqual([['plain', 'Tidy imports']])
  })
})
