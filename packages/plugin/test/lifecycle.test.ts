import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { RemoteMcp } from '../src/mcp/remote.js'
import { readState } from '../src/forge/state.js'
import { TestHarness } from './harness.js'

const temporary: string[] = []
const host = { get: () => undefined } as never

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-lifecycle-'))
  temporary.push(root)
  return root
}

function claudePlugin(root: string, name: string, files: Record<string, string>): string {
  const pluginRoot = join(root, 'plugin')
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
  writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '0.1.0', license: 'MIT' }), 'utf8')
  for (const [path, content] of Object.entries(files)) {
    const target = join(pluginRoot, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return pluginRoot
}

const skill = (name: string): string => `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${name}.\n`

/** The component id of the mounted part whose outcome names `name`. */
function partOf(service: TestHarness, name: string): string {
  const outcome = service.list()[0]?.outcomes?.find(candidate => candidate.message === name)
  if (outcome === undefined) throw new Error(`no part ${name}`)
  return outcome.componentId
}

async function listed(service: TestHarness, cwd: string): Promise<string[]> {
  const candidates = await service.skillProvider?.list({ cwd } as never) ?? []
  return candidates.map(candidate => candidate.name).sort()
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('skills share a directory', () => {
  it('serves only the mounted skills of a directory: a switched-off or new sibling stays out', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'siblings', { 'skills/lc-alpha/SKILL.md': skill('lc-alpha'), 'skills/lc-beta/SKILL.md': skill('lc-beta') })
    const service = new TestHarness(host, join(root, 'state.json'), join(root, 'data'))
    await service.install(pluginRoot, 'claude-code')
    expect(await listed(service, root)).toEqual(['lc-alpha', 'lc-beta'])

    expect(await service.forge.setPartEnabled(service.list()[0]!.id, partOf(service, 'lc-beta'), false)).toBe(true)
    expect(await listed(service, root)).toEqual(['lc-alpha'])

    // A skill added after the install was never reviewed: it is not served until imported again.
    mkdirSync(join(pluginRoot, 'skills', 'lc-gamma'))
    writeFileSync(join(pluginRoot, 'skills', 'lc-gamma', 'SKILL.md'), skill('lc-gamma'))
    expect(await listed(service, root)).toEqual(['lc-alpha'])
    expect(service.listSkillRoots()).toContain(join(pluginRoot, 'skills'))
    await service.dispose()
  })
})

describe('teardown without the source', () => {
  it('switches a part off when its source is gone', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'vanishing', { 'skills/lc-delta/SKILL.md': skill('lc-delta') })
    const service = new TestHarness(host, join(root, 'state.json'), join(root, 'data'))
    await service.install(pluginRoot, 'claude-code')
    const part = partOf(service, 'lc-delta')
    expect(service.forge.invocations.skill('lc-delta')).toBeDefined()

    rmSync(pluginRoot, { recursive: true, force: true })
    expect(await service.forge.setPartEnabled(service.list()[0]!.id, part, false)).toBe(true)
    expect(service.forge.invocations.skill('lc-delta')).toBeUndefined()
    expect(service.list()[0]?.outcomes?.find(outcome => outcome.componentId === part)?.message).toBe('switched off')
    await service.dispose()
  })

  it('withdraws a row\'s mounts when its source is gone', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'vanishing-row', { 'skills/lc-epsilon/SKILL.md': skill('lc-epsilon') })
    const service = new TestHarness(host, join(root, 'state.json'), join(root, 'data'))
    await service.install(pluginRoot, 'claude-code')
    const part = partOf(service, 'lc-epsilon')

    rmSync(pluginRoot, { recursive: true, force: true })
    await service.stopSkills()
    await service.forge.ledger.exclusive(async () => {})
    expect(service.forge.invocations.skill('lc-epsilon')).toBeUndefined()
    expect(service.list()[0]?.outcomes?.find(outcome => outcome.componentId === part)?.status).toBe('inactive')
    await service.dispose()
  })
})

describe('an install that cannot be recorded', () => {
  it('withdraws what it mounted', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'unrecorded', { 'skills/lc-zeta/SKILL.md': skill('lc-zeta') })
    // A file where the receipts directory belongs: the receipt cannot be written.
    writeFileSync(join(root, 'receipts'), 'not a directory')
    const service = new TestHarness(host, join(root, 'state.json'), join(root, 'data'))
    await expect(service.install(pluginRoot, 'claude-code')).rejects.toThrow()
    expect(service.list()).toEqual([])
    expect(service.forge.invocations.skill('lc-zeta')).toBeUndefined()
    expect(await listed(service, root)).toEqual([])
    await service.dispose()
  })

  it('keeps what it could not withdraw listed, unrecorded, and withdraws it on removal or the next install', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'stranded', { 'skills/lc-eta/SKILL.md': skill('lc-eta') })
    writeFileSync(join(root, 'receipts'), 'not a directory')
    const service = new TestHarness(host, join(root, 'state.json'), join(root, 'data'))
    const ledger = service.forge.ledger
    const skills = ledger.mounters.get('skill')!
    let fail = true
    ledger.mounters.set('skill', {
      ...skills,
      async mount(request) {
        const applied = await skills.mount(request)
        const dispose = applied.disposer
        return { ...applied, disposer: async () => { if (fail) throw new Error('busy'); await dispose?.() } }
      },
    })
    await expect(service.install(pluginRoot, 'claude-code')).rejects.toThrow()
    // Still live, so still listed with why; never written to the ledger.
    const [kept] = service.list()
    expect(kept?.outcomes?.map(outcome => outcome.message)).toEqual(['failed to clean up after a failed install: busy'])
    expect(service.forge.invocations.skill('lc-eta')).toBeDefined()
    ledger.persist()
    expect(readState(join(root, 'state.json')).plugins).toEqual([])
    // Installing again retries the withdrawal first; while it fails, nothing is replaced.
    await expect(service.install(pluginRoot, 'claude-code')).rejects.toThrow(/failed to clean up after a failed install: busy/u)
    expect(service.list()).toHaveLength(1)
    // Removing it retries too.
    fail = false
    expect(await service.forge.uninstall(kept!.id)).toBe(true)
    expect(service.list()).toEqual([])
    expect(service.forge.invocations.skill('lc-eta')).toBeUndefined()
    await service.dispose()
  })
})

describe('remote MCP sign-in', () => {
  /** A remote server waiting for sign-in, as the MCP row sees it. */
  function waitingServer(serverName: string, signedIn: string[], label: string): RemoteMcp & { disposed: boolean } {
    const server = {
      serverName,
      disposed: false,
      current: { kind: 'sign-in-required' as const, url: `https://example.test/${label}` },
      signIn: async () => { signedIn.push(label); return { kind: 'connected' as const, tools: [] } },
    }
    return server as unknown as RemoteMcp & { disposed: boolean }
  }

  it('keeps a session\'s project server apart from the process-wide one of the same name', async () => {
    const root = tempRoot()
    const service = new TestHarness(host, join(root, 'state.json'), join(root, 'data'))
    const mcp = service.forge.lookup('mcp')!
    const signedIn: string[] = []
    const global = waitingServer('docs', signedIn, 'global')
    const project = waitingServer('docs', signedIn, 'project')
    const other = waitingServer('wiki', signedIn, 'other-session')
    mcp.remoteHost('global-part').onState(global, global.current)
    mcp.remoteHost('project-part', { sessionId: 'session-a' }).onState(project, project.current)
    mcp.remoteHost('other-part', { sessionId: 'session-b' }).onState(other, other.current)

    expect(mcp.pendingSignIns('session-a').sort()).toEqual(['docs'])
    expect(mcp.pendingSignIns().sort()).toEqual(['docs', 'wiki'])
    expect(mcp.startSignIn('docs', 'session-a')).toBe('https://example.test/project')
    expect(mcp.startSignIn('docs', 'session-c')).toBe('https://example.test/global')
    expect(() => mcp.startSignIn('wiki', 'session-a')).toThrow(/not waiting/u)

    // A disposed server waits for nothing; the other of its name still does.
    project.disposed = true
    expect(mcp.startSignIn('docs', 'session-a')).toBe('https://example.test/global')
    global.disposed = true
    expect(mcp.pendingSignIns('session-a')).toEqual([])
    await service.dispose()
  })
})

describe('a command a plugin stops', () => {
  it('leaves no grant for the next turn', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'stopped', {
      'commands/guarded.md': '---\ndescription: Guarded\nallowed-tools: Bash(git status:*)\n---\n\nCheck $ARGUMENTS.\n',
    })
    const definitions: CommandDefinition[] = []
    const service = new TestHarness({ get: (name: string) => name === 'commands' ? { register(definition: CommandDefinition) { definitions.push(definition); return () => {} } } : undefined } as never, join(root, 'state.json'), join(root, 'data'))
    await service.install(pluginRoot, 'claude-code')
    const definition = definitions.find(candidate => candidate.name.endsWith('guarded'))!
    const followups: UserMessage[] = []
    const run = (): Promise<unknown> => Promise.resolve(definition.handler({
      rawInput: 'now',
      agent: { followup: (message: UserMessage) => { followups.push(message) }, session: { header: { id: 'session-stop' } } },
      attachments: [],
      signal: new AbortController().signal,
    } as never))

    const stop = service.forge.lookup('commands')!.setBeforeSubmit(async () => ({ stopped: 'handled elsewhere' }))
    await run()
    expect(followups).toEqual([])
    expect(service.forge.invocations.takeQueued('session-stop')).toEqual([])

    stop()
    const fail = service.forge.lookup('commands')!.setBeforeSubmit(async () => { throw new Error('interceptor broke') })
    await run()
    expect(service.forge.invocations.takeQueued('session-stop')).toEqual([])
    fail()

    await run()
    expect(followups).toHaveLength(1)
    expect(service.forge.invocations.takeQueued('session-stop').map(spec => spec.componentId)).toHaveLength(1)
    await service.dispose()
  })
})
