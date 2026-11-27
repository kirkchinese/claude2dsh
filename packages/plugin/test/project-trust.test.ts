import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SettingsComponent } from '@kirkchinese/harness-forge-core'
import type { Mounter, MountKind, MountRequest } from '../src/forge/contract.js'
import type { Ledger } from '../src/forge/ledger.js'
import { ProjectAssets, waitingParts } from '../src/forge/projects.js'
import { WAITING_FOR_TRUST, WorkspaceTrust } from '../src/forge/trust.js'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandComponent } from '@kirkchinese/harness-forge-core'
import { commandDefinition } from '../src/commands/definition.js'
import { createForeignShell } from '../src/hooks/shell.js'
import { ForeignSkillProvider } from '../src/skills/provider.js'

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(): { root: string; home: string; state: string } {
  // Canonical, as the workspace is (macOS's temporary directory is behind a symbolic link).
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'harness-forge-project-trust-')))
  temporary.push(base)
  const root = join(base, 'repo')
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, '.claude', 'commands'), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch pwned' }] }] } }))
  writeFileSync(join(root, '.claude', 'commands', 'plain.md'), 'Say hello to $ARGUMENTS\n')
  writeFileSync(join(root, '.claude', 'commands', 'shell.md'), 'Now: !`date`\n')
  mkdirSync(join(base, 'home'))
  return { root, home: join(base, 'home'), state: join(base, 'forge', 'state.json') }
}

/** A ledger whose mounters only record what they were asked to mount. */
function recordingLedger(mounted: string[]): Ledger {
  const mounter = (kind: MountKind): Mounter => ({
    async mount(request: MountRequest) {
      mounted.push(`${kind}:${request.component.name}`)
      return { outcome: { componentId: request.component.id, status: 'mounted', level: 'L2', evidence: 'runtime' }, disposer: async () => undefined }
    },
  })
  return { mounters: new Map<MountKind, Mounter>([['hooks', mounter('hooks')], ['command', mounter('command')], ['settings', mounter('settings')]]), allCommandNames: () => new Set<string>() } as unknown as Ledger
}

describe('project assets and workspace trust', () => {
  it('holds back hooks and shell commands until the workspace is trusted, then mounts them in the open session', async () => {
    const { root, home, state } = project()
    const mounted: string[] = []
    const trust = new WorkspaceTrust(state, home)
    const projects = new ProjectAssets(recordingLedger(mounted), join(home, 'data'), trust)
    const agent = { ctx: {}, session: { header: { id: 'session-1', cwd: root } } }
    await projects.prepare(agent, root)
    expect(mounted).toEqual(['command:plain'])
    expect(trust.state(root)).toMatchObject({ workspace: root, trusted: false, sources: [] })
    const waiting = waitingParts(root, trust.state(root))
    expect(waiting.map(part => `${part.kind}:${part.name}`).sort()).toEqual(['command:shell', 'hooks:settings'])
    expect(waiting.every(part => part.message === WAITING_FOR_TRUST)).toBe(true)
    const [listed] = await projects.workspaces()
    expect(listed).toMatchObject({ workspace: root, trusted: false })

    trust.set(join(root, '.claude'), true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mounted.sort()).toEqual(['command:plain', 'command:shell', 'hooks:settings'])
    expect(trust.state(root)).toMatchObject({ trusted: true, sources: ['forge'] })
    expect(waitingParts(root, trust.state(root))).toEqual([])
    await projects.dispose()
  })

  it('takes Claude Code\'s accepted trust dialog as trust', async () => {
    const { root, home, state } = project()
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }))
    const mounted: string[] = []
    const projects = new ProjectAssets(recordingLedger(mounted), join(home, 'data'), new WorkspaceTrust(state, home))
    await projects.prepare({ ctx: {}, session: { header: { id: 'session-2', cwd: root } } }, root)
    expect(mounted.sort()).toEqual(['command:plain', 'command:shell', 'hooks:settings'])
    await projects.dispose()
  })

  it('applies a project\'s deny and ask rules at once while its allow rules and env wait for trust, and withdraws the grants on revoke', async () => {
    const { root, home, state } = project()
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(*)'], deny: ['Bash(rm:*)'], ask: ['Edit'] },
      env: { NODE_OPTIONS: '--require x' },
      disableAllHooks: false,
    }))
    const applied: SettingsComponent[] = []
    const live = new Set<string>()
    const settings: Mounter = {
      async mount(request: MountRequest) {
        if (request.component.kind !== 'settings') throw new Error('not settings')
        applied.push(request.component)
        live.add(request.component.id)
        return { outcome: { componentId: request.component.id, status: 'mounted', level: 'L1b', evidence: 'source' }, disposer: async () => { live.delete(request.component.id) } }
      },
    }
    const ledger = recordingLedger([])
    ;(ledger.mounters as Map<MountKind, Mounter>).set('settings', settings)
    const trust = new WorkspaceTrust(state, home)
    const projects = new ProjectAssets(ledger, join(home, 'data'), trust)
    await projects.prepare({ ctx: {}, session: { header: { id: 'session-3', cwd: root } } }, root)
    // Untrusted: only the restrictions are in effect, and nothing reads the file for the rest.
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ files: [], env: {}, permissions: { allow: [], deny: ['Bash(rm:*)'], ask: ['Edit'] } })
    expect(applied[0]?.disableAllHooks).toBeUndefined()
    expect(waitingParts(root, trust.state(root)).map(part => part.kind).sort()).toEqual(['command', 'settings'])

    trust.set(root, true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(applied).toHaveLength(2)
    expect(applied[1]).toMatchObject({ env: { NODE_OPTIONS: '--require x' }, permissions: { allow: ['Bash(*)'], deny: ['Bash(rm:*)'] }, disableAllHooks: false })
    expect(live.size).toBe(1)

    // Revoked: the grants go, the restrictions stay.
    trust.set(root, false)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(applied).toHaveLength(3)
    expect(applied[2]).toMatchObject({ env: {}, permissions: { allow: [], deny: ['Bash(rm:*)'] } })
    expect(live.size).toBe(1)
    await projects.dispose()
  })

  it('withdraws hooks when trust is revoked and mounts them again when it is granted', async () => {
    const { root, home, state } = project()
    const mounted: string[] = []
    const live = new Set<string>()
    const hooks: Mounter = {
      async mount(request: MountRequest) {
        mounted.push(request.component.name)
        live.add(request.component.name)
        return { outcome: { componentId: request.component.id, status: 'mounted', level: 'L2', evidence: 'runtime' }, disposer: async () => { live.delete(request.component.name) } }
      },
    }
    const ledger = recordingLedger([])
    ;(ledger.mounters as Map<MountKind, Mounter>).set('hooks', hooks)
    const trust = new WorkspaceTrust(state, home)
    trust.set(root, true)
    const projects = new ProjectAssets(ledger, join(home, 'data'), trust)
    await projects.prepare({ ctx: {}, session: { header: { id: 'session-4', cwd: root } } }, root)
    expect([...live]).toEqual(['settings'])
    trust.set(root, false)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect([...live]).toEqual([])
    trust.set(root, true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect([...live]).toEqual(['settings'])
    await projects.dispose()
  })

  it('keeps "Not now" per workspace in trust.json, lists decisions, and ends it when trusted', () => {
    const { root, home, state } = project()
    const trust = new WorkspaceTrust(state, home)
    expect(trust.state(root).dismissed).toBe(false)
    expect(trust.dismiss(join(root, '.claude'), true)).toMatchObject({ workspace: root, trusted: false, dismissed: true })
    expect(new WorkspaceTrust(state, home).state(root).dismissed).toBe(true)
    expect(JSON.parse(readFileSync(join(dirname(state), 'trust.json'), 'utf8'))).toMatchObject({ dismissed: { [root]: { dismissedAt: expect.any(String) } } })
    expect(trust.list().map(record => [record.workspace, record.trusted, record.dismissed])).toEqual([[root, false, true]])
    trust.set(root, true)
    expect(trust.list().map(record => [record.workspace, record.trusted, record.dismissed])).toEqual([[root, true, false]])
    trust.set(root, false)
    expect(trust.list()).toEqual([])
    trust.dismiss(root, true)
    trust.dismiss(root, false)
    expect(trust.state(root).dismissed).toBe(false)
  })

  it('checks trust on the content it renders: a project skill or command changed after mounting runs no shell line while untrusted', async () => {
    const { root, home, state } = project()
    const trust = new WorkspaceTrust(state, home)
    const check = (dir: string) => trust.state(dir)
    const shell = createForeignShell()
    // Mounted while it had no shell line (nothing to wait for), then edited.
    const skillDir = join(root, '.claude', 'skills', 'sneaky')
    mkdirSync(skillDir, { recursive: true })
    const bodyPath = join(skillDir, 'SKILL.md')
    writeFileSync(bodyPath, '---\nname: sneaky\ndescription: d\n---\nPlain\n')
    const provider = new ForeignSkillProvider(shell, undefined, undefined, check)
    provider.addSkill(bodyPath, { pluginRoot: join(root, '.claude'), projectRoot: root, scope: 'project' })
    writeFileSync(bodyPath, '---\nname: sneaky\ndescription: d\n---\nNow: !`touch SKILL_RAN`\n')
    const [candidate] = await provider.list({ cwd: root } as never)
    const loaded = await provider.get(candidate!, { cwd: root } as never)
    expect(loaded?.content).toContain(`this shell command was not run: the workspace ${root} is not trusted`)
    expect(await provider.renderFor(bodyPath, '', root, undefined)).toContain('was not run')
    expect(existsSync(join(root, 'SKILL_RAN'))).toBe(false)

    const component = { id: 'c', kind: 'command', name: 'cmd', body: 'Now: !`touch COMMAND_RAN`', frontmatter: {} } as unknown as CommandComponent
    const followups: UserMessage[] = []
    const run = async (): Promise<string> => {
      followups.length = 0
      await commandDefinition(component, 'cmd', { pluginRoot: join(root, '.claude'), dataDir: join(home, 'data'), scope: 'project', projectRoot: root }, {
        shell,
        hooks: () => undefined,
        directory: async () => root,
        observe: () => undefined,
        trust: check,
      }).handler({ rawInput: '', agent: { followup(message: UserMessage) { followups.push(message) }, session: { header: { id: 's' } } }, attachments: [], signal: new AbortController().signal } as never)
      return followups[0]?.content.map(block => block.type === 'text' ? block.text : '').join('') ?? ''
    }
    expect(await run()).toContain('this shell command was not run')
    expect(existsSync(join(root, 'COMMAND_RAN'))).toBe(false)
    // Trusted now: the same content runs.
    trust.set(root, true)
    expect(await run()).toBe('Now:')
    expect(existsSync(join(root, 'COMMAND_RAN'))).toBe(true)
    expect(await provider.renderFor(bodyPath, '', root, undefined)).toBe('Now:')
    expect(existsSync(join(root, 'SKILL_RAN'))).toBe(true)
  })

  it('serializes trust changes: revoking while a part mounts leaves nothing that needs trust live, and setTrust waits until done', async () => {
    const { root, home, state } = project()
    const live = new Set<string>()
    let gate: Promise<void> = Promise.resolve()
    let open: () => void = () => undefined
    const hooks: Mounter = {
      async mount(request: MountRequest) {
        await gate
        live.add(request.component.name)
        return { outcome: { componentId: request.component.id, status: 'mounted', level: 'L2', evidence: 'runtime' }, disposer: async () => { live.delete(request.component.name) } }
      },
    }
    const ledger = recordingLedger([])
    ;(ledger.mounters as Map<MountKind, Mounter>).set('hooks', hooks)
    const trust = new WorkspaceTrust(state, home)
    const projects = new ProjectAssets(ledger, join(home, 'data'), trust)
    await projects.prepare({ ctx: {}, session: { header: { id: 'session-race', cwd: root } } }, root)
    gate = new Promise((resolve) => { open = resolve })
    const granting = projects.setTrust(root, true)
    await new Promise(resolve => setTimeout(resolve, 10))
    // The hooks mount is in flight with the grant; the person revokes before it lands.
    const revoking = projects.setTrust(root, false)
    open()
    await Promise.all([granting, revoking])
    expect([...live]).toEqual([])
    expect(waitingParts(root, trust.state(root)).map(part => part.kind)).toContain('hooks')
    // Granting again is done when the call returns.
    gate = Promise.resolve()
    await projects.setTrust(root, true)
    expect([...live]).toEqual(['settings'])
    await projects.dispose()
  })

  it('decides what to mount by the trust that holds after withdrawing: a revoke during the withdrawal starts nothing that needs trust', async () => {
    const { root, home, state } = project()
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'], deny: ['Bash(rm:*)'] }, env: { NODE_OPTIONS: '--require x' } }))
    const mounted: string[] = []
    const ledger = recordingLedger(mounted)
    let withdrawing: Promise<void> = Promise.resolve()
    let finish: () => void = () => undefined
    ;(ledger.mounters as Map<MountKind, Mounter>).set('settings', {
      async mount(request: MountRequest) {
        const component = request.component as SettingsComponent
        mounted.push(Object.keys(component.env).length > 0 ? 'settings:granted' : 'settings:restricted')
        return { outcome: { componentId: component.id, status: 'mounted', level: 'L1b', evidence: 'source' }, disposer: () => withdrawing }
      },
    })
    const trust = new WorkspaceTrust(state, home)
    const projects = new ProjectAssets(ledger, join(home, 'data'), trust)
    await projects.prepare({ ctx: {}, session: { header: { id: 'session-stale', cwd: root } } }, root)
    expect(mounted.sort()).toEqual(['command:plain', 'settings:restricted'])
    withdrawing = new Promise((resolve) => { finish = resolve })
    // Granting withdraws the restricted settings first; the person revokes while that withdrawal runs.
    trust.set(root, true)
    await new Promise(resolve => setTimeout(resolve, 10))
    trust.set(root, false)
    finish()
    await projects.setTrust(root, false)
    expect(mounted).not.toContain('settings:granted')
    expect(mounted).not.toContain('command:shell')
    await projects.dispose()
  })

  it('does not replace or drop a part whose withdrawal failed: it shows as failed to switch off and is retried', async () => {
    const { root, home, state } = project()
    let fail = false
    let mounts = 0
    let disposals = 0
    const hooks: Mounter = {
      async mount(request: MountRequest) {
        mounts += 1
        return { outcome: { componentId: request.component.id, status: 'mounted', level: 'L2', evidence: 'runtime' }, disposer: async () => { disposals += 1; if (fail) throw new Error('busy') } }
      },
    }
    const ledger = recordingLedger([])
    ;(ledger.mounters as Map<MountKind, Mounter>).set('hooks', hooks)
    const trust = new WorkspaceTrust(state, home)
    trust.set(root, true)
    const faults: unknown[] = []
    const projects = new ProjectAssets(ledger, join(home, 'data'), trust, error => faults.push(error))
    const agent = { ctx: {}, session: { header: { id: 'session-stuck', cwd: root } } }
    await projects.prepare(agent, root)
    expect(mounts).toBe(1)
    fail = true
    await projects.setTrust(root, false)
    const [mount] = (projects as unknown as { settled: Map<string, Array<{ outcomes: Array<{ componentId: string; status: string; message?: string }> }>> }).settled.get('session-stuck')!
    expect(mount!.outcomes.find(outcome => outcome.componentId.endsWith(':hooks:settings'))).toMatchObject({ status: 'failed', message: 'failed to switch off: busy' })
    // Granting again does not mount a second registration over the one still live.
    await projects.setTrust(root, true)
    expect(mounts).toBe(1)
    // The session ends while the withdrawal still fails: it is kept, and withdrawn on the next try.
    await projects.release('session-stuck')
    const before = disposals
    fail = false
    await projects.dispose()
    expect(disposals).toBe(before + 1)
    expect(faults.length).toBeGreaterThan(0)
  })

  it('reports a revoke whose withdrawal failed as still live, and revoking again retries', async () => {
    const { root, home, state } = project()
    let fail = true
    const hooks: Mounter = {
      async mount(request: MountRequest) {
        return { outcome: { componentId: request.component.id, status: 'mounted', level: 'L2', evidence: 'runtime' }, disposer: async () => { if (fail) throw new Error('busy') } }
      },
    }
    const ledger = recordingLedger([])
    ;(ledger.mounters as Map<MountKind, Mounter>).set('hooks', hooks)
    const trust = new WorkspaceTrust(state, home)
    trust.set(root, true)
    const projects = new ProjectAssets(ledger, join(home, 'data'), trust)
    await projects.prepare({ ctx: {}, session: { header: { id: 'session-revoke', cwd: root } } }, root)
    const revoked = await projects.setTrust(root, false)
    expect(revoked.decision).toMatchObject({ workspace: root, trusted: false })
    expect(revoked.stillLive).toEqual([{ componentId: expect.stringMatching(/:hooks:settings$/u), reason: 'busy' }])
    fail = false
    expect((await projects.setTrust(root, false)).stillLive).toEqual([])
    await projects.dispose()
  })
})
