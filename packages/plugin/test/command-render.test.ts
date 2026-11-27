import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { TestHarness } from './harness.js'

const plugin = join(process.cwd(), 'test', 'fixtures', 'status-plugin')
const temporary: string[] = []

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('an installed Claude Code command', () => {
  it('renders with its plugin root and shell context, and keeps its own description', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-forge-command-'))
    temporary.push(root)
    const definitions: CommandDefinition[] = []
    const commands = { register(definition: CommandDefinition) { if (definition.name !== 'output-style') definitions.push(definition); return () => {} } }
    const service = new TestHarness({ get: (name: string) => name === 'commands' ? commands : undefined } as never, join(root, 'state.json'), join(root, 'data'))
    await service.install(plugin, 'claude-code')
    const status = definitions.find(definition => definition.name === 'statusdemo-status')
    expect(status).toBeDefined()
    expect(status?.description).toBe('Show the demo status')
    const followups: UserMessage[] = []
    await status!.handler({
      rawInput: 'now',
      agent: { followup(message: UserMessage) { followups.push(message) }, session: { header: { id: 'session-fixture' } } },
      attachments: [],
      signal: new AbortController().signal,
    } as never)
    const text = followups[0]?.content.map(block => block.type === 'text' ? block.text : '').join('') ?? ''
    expect(text).toContain('Shell says: shell-context-ok')
    expect(text).toContain('Arguments: now')
    expect(text).not.toContain('${CLAUDE_PLUGIN_ROOT}')
    expect(text).not.toMatch(/!`[^`]+`/u)
    expect(text).toMatch(/Plugin root: .*status-plugin/u)
  })
})
