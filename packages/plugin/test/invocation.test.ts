import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { toolList } from '@kirkchinese/harness-forge-core'
import { directivesOf, expandRule, Invocations, type InvocationSpec } from '../src/shared/invocation.js'
import { gestureArguments } from '../src/skills/row.js'

const spec = (frontmatter: Record<string, unknown>): InvocationSpec => ({
  name: 'deploy',
  kind: 'skill',
  pluginId: 'claude-code:demo',
  componentId: 'claude-code:demo:skill:deploy',
  frontmatter,
  places: { skillDir: '/skills/deploy', pluginRoot: '/plugins/demo', dataDir: '/data/demo' },
})

interface Route { provider: string; model: string; reasoningEffort?: string }

interface FakeAgent {
  readonly options: { provider: string; model: string }
  /** The route selection, as DSH's `agent.model`; `selected` records each selection. */
  readonly model: { current(): Route; select(route: Route): void; readonly selected: Route[] }
  readonly session: { header: { id: string; cwd: string }; snapshotEvents(): unknown[]; seq: number }
  readonly followups: unknown[]
  followup(message: unknown): void
}

function fakeAgent(id = 's1'): FakeAgent {
  const followups: unknown[] = []
  const selected: Route[] = []
  let current: Route = { provider: 'deepseek-official', model: 'deepseek-flash' }
  return {
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    model: { current: () => current, select: (route) => { selected.push(route); current = route }, selected },
    session: { header: { id, cwd: '/work' }, snapshotEvents: () => [], seq: 0 },
    followups,
    followup: (message) => { followups.push(message) },
  }
}

function host(services: Record<string, unknown> = {}): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

const llm = {
  listProviders: () => [{ id: 'deepseek-official' }, { id: 'openai-codex' }],
  listModels: async (provider: string) => provider === 'deepseek-official'
    ? [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }, { id: 'deepseek-pro', name: 'DeepSeek Pro' }]
    : [{ id: 'gpt-6-sol', name: 'GPT-6 Sol' }],
  resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] } }),
}

describe('invocation frontmatter', () => {
  it('reads allowed-tools as rules, keeping separators inside parentheses', () => {
    expect(toolList('Bash(git add *) Bash(git commit *), Read')).toEqual(['Bash(git add *)', 'Bash(git commit *)', 'Read'])
    expect(directivesOf({ 'allowed-tools': 'Bash(npm test) Read', 'disallowed-tools': ['AskUserQuestion'], model: 'inherit', effort: 'HIGH', context: 'fork', agent: 'Explore', background: false }))
      .toEqual({ allowedTools: ['Bash(npm test)', 'Read'], disallowedTools: ['AskUserQuestion'], effort: 'high', fork: { agent: 'Explore', background: false } })
    expect(directivesOf({ context: 'fork' }).fork).toEqual({ background: true })
  })

  it('expands path variables inside rules', () => {
    expect(expandRule('Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)', { skillDir: 'C:\\skills\\chart', projectDir: '/work' })).toBe('Bash(C:/skills/chart/scripts/render.sh *)')
    expect(expandRule('Read(${CLAUDE_PROJECT_DIR}/docs/**)', { projectDir: '/work' })).toBe('Read(/work/docs/**)')
  })

  it('grants allowed-tools and refuses disallowed-tools for the turn, until the next user message', async () => {
    const invocations = new Invocations(host(), () => undefined, async () => '/work')
    const agent = fakeAgent()
    await invocations.activate(agent as never, spec({ 'allowed-tools': 'Bash(${CLAUDE_SKILL_DIR}/run.sh *)', 'disallowed-tools': 'WebFetch' }), new AbortController().signal)
    expect(invocations.rules('s1')).toEqual({ allow: ['Bash(/skills/deploy/run.sh *)'], deny: ['WebFetch'] })
    expect(invocations.active('s1')).toEqual(['deploy'])
    invocations.clear('s1')
    expect(invocations.rules('s1')).toEqual({ allow: [], deny: [] })
  })

  it('switches the turn to a model DSH serves, maps effort by name or rank, and keeps the session model for a Claude alias', async () => {
    const invocations = new Invocations(host({ llm }), () => undefined, async () => '/work')
    const signal = new AbortController().signal
    const routed = async (id: string, frontmatter: Record<string, unknown>): Promise<Route | undefined> => {
      const agent = fakeAgent(id)
      await invocations.activate(agent as never, spec(frontmatter), signal)
      return agent.model.selected.at(-1)
    }
    expect(await routed('a', { model: 'DeepSeek Pro', effort: 'high' })).toEqual({ provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high' })
    expect(await routed('b', { model: 'openai-codex/gpt-6-sol' })).toEqual({ provider: 'openai-codex', model: 'gpt-6-sol' })
    // `xhigh` is not offered; by rank it is the strongest of three.
    expect(await routed('c', { effort: 'xhigh' })).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
    // A model name does not say which model is stronger: an unmapped alias stays on the session's model.
    expect(await routed('d', { model: 'opus' })).toBeUndefined()
  })

  it('runs a context: fork skill in a delegated agent, waiting or in the background', async () => {
    const started: Array<Record<string, unknown>> = []
    const subagents = {
      async startActivation(request: Record<string, unknown>) {
        started.push(request)
        return { childId: 'child', result: Promise.resolve({ output: [{ type: 'text', text: 'researched' }] }), dispose: async () => {} }
      },
    }
    const invocations = new Invocations(host({ subagents }), name => name === 'reviewer' ? 'demo-reviewer' : undefined, async () => '/work')
    const agent = fakeAgent()
    const signal = new AbortController().signal
    const waited = await invocations.fork(agent as never, spec({}), directivesOf({ context: 'fork', agent: 'reviewer', background: false }), 'Research X', signal)
    expect(waited).toBe('researched')
    expect(started[0]).toMatchObject({ provider: 'spawn', parent: agent, prompt: [{ type: 'text', text: 'Research X' }], agentPreset: 'demo-reviewer' })
    // The forked agent, not the parent, carries the skill's tool grants.
    const restricted = await invocations.fork(agent as never, spec({ 'disallowed-tools': 'Write', 'allowed-tools': 'Read' }), directivesOf({ context: 'fork', background: false, 'disallowed-tools': 'Write', 'allowed-tools': 'Read' }), 'Check Z', signal)
    expect(restricted).toBe('researched')
    expect(invocations.rules('child')).toEqual({ allow: ['Read'], deny: ['Write'] })
    expect(invocations.rules('s1')).toEqual({ allow: [], deny: [] })
    const note = await invocations.fork(agent as never, spec({}), directivesOf({ context: 'fork', agent: 'Explore' }), 'Explore Y', signal)
    expect(note).toMatch(/running in a forked Explore agent in the background/u)
    expect(started[1]).not.toHaveProperty('agentPreset')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(JSON.stringify(agent.followups[0])).toContain('<skill-result name=\\"deploy\\">\\nresearched')
  })

  it('reads the arguments of a /name gesture', () => {
    expect(gestureArguments('/deploy staging --force', 'deploy')).toBe('staging --force')
    expect(gestureArguments('please /deploy "prod eu"\nthanks', 'deploy')).toBe('"prod eu"')
    expect(gestureArguments('/deploy-all x', 'deploy')).toBe('')
    expect(gestureArguments('/evolve-loop theme=speed', 'evolve-loop')).toBe('theme=speed')
  })
})


/** An agent of DSH 0.2.2: each step reads its route from `agent.model` before `agent/pre-step` runs. */
function agent022(id: string): FakeAgent & { model: { current(): { provider: string; model: string; reasoningEffort?: string }; select(next: { provider: string; model: string; reasoningEffort?: string }): void }; step(): string } {
  let route: { provider: string; model: string; reasoningEffort?: string } = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }
  const base = fakeAgent(id)
  return Object.assign(base, {
    // Selecting appends `model/selection`, which DSH refuses while it publishes another event (a session/event listener).
    model: { current: () => route, select: (next: typeof route) => { if (publishing) throw new Error('session append cannot reenter while another append is being published'); route = next } },
    step: () => `${route.model}/${route.reasoningEffort ?? '-'}`,
  })
}

/** Whether the test is inside a session/event dispatch. */
let publishing = false
/** A session/event listener call as DSH makes it: inside the publication. */
function duringPublication(listener: () => void): void {
  publishing = true
  try { listener() } finally { publishing = false }
}

describe('turn routes on DSH 0.2.2', () => {
  it('a typed line\'s route is selected before its turn\'s first step and put back when that turn ends', async () => {
    const invocations = new Invocations(host({ llm }), () => undefined, async () => '/work')
    const agent = agent022('t1')
    const signal = new AbortController().signal
    // The line is dispatched while the session is idle: the route is in place before the turn starts.
    await invocations.preselect(agent as never, spec({ model: 'DeepSeek Pro', effort: 'high' }), signal)
    invocations.turnEnded('t1')
    expect(agent.step()).toBe('deepseek-pro/high')
    invocations.turnStarted('t1')
    // DSH reads the route for the first step before agent/pre-step, where the queued spec is activated.
    expect(agent.step()).toBe('deepseek-pro/high')
    await invocations.activate(agent as never, spec({ model: 'DeepSeek Pro', effort: 'high' }), signal)
    duringPublication(() => { invocations.turnEnded('t1') })
    await Promise.resolve()
    expect(agent.step()).toBe('deepseek-flash/low')
  })

  it('a model-invoked skill\'s route takes the turn\'s next steps and ends with the turn', async () => {
    const invocations = new Invocations(host({ llm }), () => undefined, async () => '/work')
    const agent = agent022('t2')
    invocations.turnStarted('t2')
    await invocations.activate(agent as never, spec({ effort: 'high' }), new AbortController().signal)
    expect(agent.step()).toBe('deepseek-flash/high')
    duringPublication(() => { invocations.turnEnded('t2') })
    await Promise.resolve()
    expect(agent.step()).toBe('deepseek-flash/low')
  })

  it('a typed line answered without a turn puts its route back at once', async () => {
    const invocations = new Invocations(host({ llm }), () => undefined, async () => '/work')
    const agent = agent022('t3')
    await invocations.preselect(agent as never, spec({ effort: 'high' }), new AbortController().signal)
    invocations.release('t3')
    expect(agent.step()).toBe('deepseek-flash/low')
  })
})
