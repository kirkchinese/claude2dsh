import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { agentMemoryDir, AgentProfiles, agentRuntimeFields, memoryInstructions } from '../src/agents/profiles.js'
import { createForeignShell, type ForeignShell } from '../src/hooks/shell.js'
import { McpAuthStore } from '../src/mcp/auth.js'

const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-profile-'))
  temporary.push(root)
  return root
}

/** Poll `done` until it holds; a passing run finishes in a few polls, the deadline only bounds a failing one. */
async function until(done: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

interface Listener { (...args: unknown[]): unknown }

function host(services: Record<string, unknown>): { ctx: Context; emit(event: string, ...args: unknown[]): Promise<unknown> } {
  const listeners = new Map<string, Listener[]>()
  const ctx = {
    get: (name: string) => services[name],
    on(name: string, listener: Listener) {
      listeners.set(name, [...listeners.get(name) ?? [], listener])
      return () => {}
    },
  } as unknown as Context
  return { ctx, emit: async (event, ...args) => listeners.get(event)?.[0]?.(...args) }
}

function child(preset: string, cwd: string) {
  const injected: Array<{ content: Array<{ text: string }>; source: { kind: string } }> = []
  const selected: Array<Record<string, unknown>> = []
  let current: Record<string, unknown> = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }
  return {
    ctx: {},
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    model: { current: () => current, select: (route: Record<string, unknown>) => { selected.push(route); current = route } },
    selected,
    session: { header: { id: 'child-1', cwd, delegationDepth: 1, parentSession: 'root' }, preset },
    injected,
    inject: (message: never) => { injected.push(message) },
    followup: () => {},
  }
}

const projections = { presetForSession: (session: { preset?: string }) => session.preset ?? null }
const llm = {
  listProviders: () => [{ id: 'deepseek-official' }],
  listModels: async () => [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }, { id: 'deepseek-pro', name: 'DeepSeek Pro' }],
  resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }),
}

describe('agent frontmatter', () => {
  it('reads the run-time fields as the sub-agents reference defines them', () => {
    expect(agentRuntimeFields({
      model: 'inherit',
      effort: 'HIGH',
      skills: ['api-conventions', 'api-conventions', 'errors'],
      mcpServers: [{ playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] } }, 'github'],
      maxTurns: 5,
      memory: 'project',
      isolation: 'worktree',
      initialPrompt: 'Start with a review.',
    })).toEqual({
      effort: 'high',
      skills: ['api-conventions', 'errors'],
      mcpServers: [{ name: 'playwright', config: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] } }, { name: 'github' }],
      maxTurns: 5,
      memory: 'project',
      isolation: 'worktree',
      initialPrompt: 'Start with a review.',
    })
  })

  it('places memory by scope and starts the agent with the first 200 lines of MEMORY.md', () => {
    expect(agentMemoryDir('user', 'reviewer', '/work', '/home/u')).toBe(join('/home/u', '.claude', 'agent-memory', 'reviewer'))
    expect(agentMemoryDir('project', 'reviewer', '/work')).toBe(join('/work', '.claude', 'agent-memory', 'reviewer'))
    expect(agentMemoryDir('local', 'reviewer', '/work')).toBe(join('/work', '.claude', 'agent-memory-local', 'reviewer'))
    const dir = temp()
    expect(memoryInstructions(dir)).toContain('MEMORY.md does not exist yet.')
    writeFileSync(join(dir, 'MEMORY.md'), Array.from({ length: 250 }, (_, index) => `- note ${String(index)}`).join('\n'))
    const text = memoryInstructions(dir)
    expect(text).toContain('- note 199')
    expect(text).not.toContain('- note 200')
    expect(text).toMatch(/curate it so the index fits/u)
  })

  it('preloads skills, memory and the model route when the agent starts, and stops it at maxTurns', async () => {
    const cwd = temp()
    const skills = {
      get: async (name: string) => name === 'api-conventions'
        ? { name, provider: 'harness-forge', content: 'Use REST nouns.', invocation: { modelInvocable: true } }
        : name === 'manual-only' ? { name, provider: 'harness-forge', content: 'x', invocation: { modelInvocable: false } } : undefined,
    }
    const lab = host({ agentPresets: projections, skills, llm })
    const profiles = new AgentProfiles(lab.ctx, createForeignShell(), temp(), () => ({ auth: new McpAuthStore(tmpdir()), onState: () => {} }))
    profiles.install()
    profiles.register({ presetId: 'demo-api', name: 'api', pluginId: 'claude-code:demo', frontmatter: { skills: 'api-conventions manual-only', memory: 'project', model: 'DeepSeek Pro', effort: 'xhigh', maxTurns: 2 }, vars: { pluginRoot: cwd, dataDir: cwd } })
    const agent = child('demo-api', cwd)
    await lab.emit('agent/created', { agent })
    const texts = agent.injected.map(message => message.content[0]?.text ?? '')
    expect(texts[0]).toContain('Use REST nouns.')
    expect(texts[1]).toContain(join(cwd, '.claude', 'agent-memory', 'api'))
    expect(existsSync(join(cwd, '.claude', 'agent-memory', 'api'))).toBe(true)
    expect(agent.selected.at(-1)).toEqual({ provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high' })
    const enter = async () => ({ kind: 'enter', messages: [] })
    expect(await lab.emit('agent/pre-step', { agent }, enter)).toEqual({ kind: 'enter', messages: [] })
    expect(await lab.emit('agent/pre-step', { agent }, enter)).toEqual({ kind: 'enter', messages: [] })
    expect(await lab.emit('agent/pre-step', { agent }, enter)).toEqual({ kind: 'reject' })
  })

  it('runs an isolated agent in a fresh worktree and removes it when the agent changed nothing', async () => {
    const repo = temp()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
    git('init', '-q')
    writeFileSync(join(repo, 'a.txt'), 'a')
    git('add', '-A')
    git('-c', 'user.email=lab@example.com', '-c', 'user.name=lab', 'commit', '-q', '-m', 'init')
    const lab = host({ agentPresets: projections })
    // The disposal runs on its own after `agent/disposed`: count the finished `git status` checks, and the
    // branch deletions that end a removal (after the worktree folder is gone), to know when it is done.
    const real = createForeignShell()
    let statuses = 0
    let branchesDeleted = 0
    const shell: ForeignShell = { ...real, runExec: async (file, args, options) => {
      try {
        return await real.runExec(file, args, options)
      } finally {
        if (args[0] === 'status') statuses += 1
        if (args[0] === 'branch' && args[1] === '-D') branchesDeleted += 1
      }
    } }
    const profiles = new AgentProfiles(lab.ctx, shell, temp(), () => ({ auth: new McpAuthStore(tmpdir()), onState: () => {} }))
    profiles.install()
    profiles.register({ presetId: 'demo-iso', name: 'iso', pluginId: 'claude-code:demo', frontmatter: { isolation: 'worktree' }, vars: { pluginRoot: repo, dataDir: repo } })
    expect(profiles.isolated('demo-iso')).toBe(true)
    expect(profiles.isolated('other')).toBe(false)
    const worktree = await profiles.worktree(repo)
    expect(worktree).toBeDefined()
    expect(existsSync(join(worktree!, 'a.txt'))).toBe(true)
    await lab.emit('agent/disposed', { agent: child('demo-iso', worktree!) })
    await until(() => !existsSync(worktree!) && branchesDeleted === 1, 'the unchanged worktree and its branch to be removed')
    expect(statuses).toBe(1)
    // A worktree with changes stays.
    const kept = await profiles.worktree(repo)
    writeFileSync(join(kept!, 'b.txt'), 'b')
    await lab.emit('agent/disposed', { agent: child('demo-iso', kept!) })
    // The changed worktree is left alone once its status check came back with changes: nothing more follows.
    await until(() => statuses === 2, 'the changed worktree to be checked')
    await new Promise(resolve => setImmediate(resolve))
    expect(existsSync(join(kept!, 'b.txt'))).toBe(true)
  }, 30_000)
})
