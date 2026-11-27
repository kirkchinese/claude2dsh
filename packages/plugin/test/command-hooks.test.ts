import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { scanPlugin, type CommandComponent } from '@kirkchinese/harness-forge-core'
import { commandDefinition, type CommandHost } from '../src/commands/definition.js'
import type { HookSource } from '../src/hooks/broker.js'

const root = mkdtempSync(join(tmpdir(), 'hf-command-hooks-'))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('command frontmatter hooks', () => {
  it('run for the rest of the session once the command is invoked, like a skill\'s', async () => {
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    mkdirSync(join(root, 'commands'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0', license: 'MIT' }))
    writeFileSync(join(root, 'commands', 'deploy.md'), '---\ndescription: Deploy\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: echo checked\n---\nDeploy $ARGUMENTS\n')
    const command = scanPlugin(root, { source: 'claude-code' }).plugin.components.find((component): component is CommandComponent => component.kind === 'command')!
    const added: HookSource[] = []
    const followups: unknown[] = []
    const hooks = { componentId: command.id, pluginId: 'demo', dialect: 'claude-code', pluginRoot: root, dataDir: root, table: new Map(), origin: 'skill' } as unknown as HookSource
    const host = {
      shell: {},
      hooks: () => ({ expandCommand: async () => ({ context: [] }), add: (source: HookSource) => { added.push(source); return () => {} } }),
      directory: async () => root,
      observe: () => {},
    } as unknown as CommandHost
    const definition = commandDefinition(command, 'demo-deploy', { pluginRoot: root, dataDir: root, hooks }, host)
    const result = await definition.handler({
      rawInput: 'staging',
      signal: new AbortController().signal,
      agent: { session: { header: { id: 'session-1' } }, followup: (message: unknown) => { followups.push(message) } },
    } as never)
    expect(result).toMatchObject({ kind: 'success' })
    expect(added).toEqual([expect.objectContaining({ componentId: command.id, origin: 'skill', sessionId: 'session-1' })])
    expect(followups).toHaveLength(1)
  })
})
