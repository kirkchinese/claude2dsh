import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { assess, scanPlugin } from '@kirkchinese/harness-forge-core'
import { CREATOR_PRESET, briefFor, briefTitle, partFiles, portRuntime, startCreatorSession } from '../src/porting/port-gap.js'
import { startPorter } from '../src/porting/row.js'
import { HarnessRemoteService } from '../src/workbench/remote.js'
import { PortSessions } from '../src/porting/port-sessions.js'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

/** A Claude Code plugin whose installer writes a status line, plus a dependency directory the brief skips. */
function hud(): string {
  const root = mkdtempSync(join(tmpdir(), 'hf-port-gap-'))
  roots.push(root)
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'claude-hud', license: 'MIT' }))
  writeFileSync(join(root, 'install.mjs'), "// points Claude Code's statusLine at the HUD in ~/.claude/settings.json\nexport {}\n")
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), '')
  return root
}

interface Calls { create: unknown[]; prompt: unknown[]; rename: unknown[] }

/** A context whose `sessionController` and `agentPresets` record what they are asked. */
function host(presets: ReadonlyArray<{ id: string; broken?: unknown }> | undefined = [{ id: 'default' }, { id: CREATOR_PRESET }], extra: Record<string, unknown> = {}): { ctx: never; calls: Calls } {
  const calls: Calls = { create: [], prompt: [], rename: [] }
  const services: Record<string, unknown> = {
    sessionController: {
      create: async (request: unknown) => { calls.create.push(request); return { sessionId: 'session-1', agentPreset: CREATOR_PRESET } },
      prompt: async (request: unknown) => { calls.prompt.push(request); return { accepted: true } },
      rename: async (request: unknown) => { calls.rename.push(request); return { title: 'x', seq: 1 } },
    },
    ...(presets !== undefined ? { agentPresets: { list: async () => presets } } : {}),
    ...extra,
  }
  return { ctx: { get: (name: string) => services[name] } as never, calls }
}

describe('porting a gap', () => {
  const root = hud()
  const plugin = scanPlugin(root, { source: 'claude-code' }).plugin
  const component = plugin.components.find(item => item.kind === 'ui')!
  const gaps = assess(plugin).gaps

  it('lists the part\'s files by absolute path, with the manifest and without dependencies', () => {
    expect(partFiles(plugin, component)).toEqual([join(root, 'install.mjs'), join(root, '.claude-plugin', 'plugin.json')])
  })

  it('writes the brief for a part, and names a part the plugin does not have', () => {
    expect(briefFor(plugin, gaps, component.id)).toContain('# Port "statusline" of claude-hud to DSH')
    expect(() => briefFor(plugin, gaps, 'claude-code:claude-hud:ui:nope')).toThrow('claude-hud has no part claude-code:claude-hud:ui:nope')
  })

  it('starts a creation-mode session in the given Workspace and sends it the brief', async () => {
    const { ctx, calls } = host()
    expect(await startCreatorSession(ctx, 'the brief', { workspaceId: 'w1' })).toEqual({ sessionId: 'session-1' })
    expect(calls.create).toEqual([{ workspaceId: 'w1', agentPreset: 'cordis' }])
    expect(calls.prompt).toEqual([{ requestId: expect.any(String), sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'the brief' }] }])
  })

  it('creates only the default adapters parent before starting the creation session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hf-creator-home-'))
    roots.push(home)
    vi.stubEnv(process.platform === 'win32' ? 'USERPROFILE' : 'HOME', home)
    try {
      const { ctx, calls } = host()
      await startCreatorSession(ctx, 'the brief')
      const cwd = join(home, 'dsh-adapters')
      expect(calls.create).toEqual([{ cwd, agentPreset: 'cordis' }])
      expect(readdirSync(cwd)).toEqual([])
    } finally { vi.unstubAllEnvs() }
  })

  it('puts the session of the adapters directory in a workspace named after the folder, so it is not Ungrouped', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hf-creator-home-'))
    roots.push(home)
    vi.stubEnv(process.platform === 'win32' ? 'USERPROFILE' : 'HOME', home)
    try {
      const made: string[] = []
      const workspaces = { create: async (path: string) => { made.push(path); return { id: 'workspace-adapters', path } } }
      const { ctx, calls } = host(undefined, { workspaceRegistry: workspaces })
      await startCreatorSession(ctx, 'the brief')
      await startCreatorSession(ctx, 'another brief')
      // The registry reuses the workspace of a path it knows; both sessions are made in it.
      expect(made).toEqual([join(home, 'dsh-adapters'), join(home, 'dsh-adapters')])
      expect(calls.create).toEqual([{ workspaceId: 'workspace-adapters', agentPreset: 'cordis' }, { workspaceId: 'workspace-adapters', agentPreset: 'cordis' }])
      // A registry that refuses leaves the session where the directory puts it.
      const refusing = host(undefined, { workspaceRegistry: { create: async () => { throw new Error('no') } } })
      await startCreatorSession(refusing.ctx, 'the brief')
      expect(refusing.calls.create).toEqual([{ cwd: join(home, 'dsh-adapters'), agentPreset: 'cordis' }])
    } finally { vi.unstubAllEnvs() }
  })

  it('names the session after the brief heading, without its Markdown marker', async () => {
    const { ctx, calls } = host()
    await startCreatorSession(ctx, '# Port "statusline" of claude-hud to DSH\n\nBody.', { cwd: root })
    expect(calls.rename).toEqual([{ sessionId: 'session-1', title: 'Port "statusline" of claude-hud to DSH' }])
    expect(briefTitle('no heading\nmore')).toBe('no heading')
  })

  it('refuses when the profile has no creation mode or no session controller', async () => {
    await expect(startCreatorSession(host([{ id: 'default' }]).ctx, 'b')).rejects.toThrow(/creation mode \(agent preset "cordis"\) is not in this DSH profile/u)
    await expect(startCreatorSession(host([{ id: CREATOR_PRESET, broken: { message: 'x' } }]).ctx, 'b')).rejects.toThrow(/is unavailable in this DSH profile/u)
    await expect(startCreatorSession({ get: () => undefined } as never, 'b')).rejects.toThrow(/composes no session controller/u)
  })

  it('tells the creator the profile and DSH home of this session, as DSH resolves them', async () => {
    vi.stubEnv('DSH_HOME', '/srv/dsh-home')
    try {
      const profileContext = { name: 'work', dir: '/srv/dsh-home/profiles/work' }
      expect(portRuntime(host(undefined, { profileContext }).ctx)).toEqual({ dshHome: '/srv/dsh-home', dshHomeFromEnv: true, profile: { name: 'work', dir: '/srv/dsh-home/profiles/work' } })
      const { ctx, calls } = host(undefined, { profileContext })
      const apis = new Map<string, unknown>()
      startPorter(ctx, { statePath: join(root, 'state', 'state.json'), provide: (name: string, api: unknown) => { apis.set(name, api); return () => undefined } } as never)
      const porter = apis.get('porter') as { brief(...args: unknown[]): string; port(...args: unknown[]): Promise<unknown> }
      expect(porter.brief(plugin, gaps, component.id)).toContain('Current profile: `work`, directory `/srv/dsh-home/profiles/work`')
      await porter.port(plugin, gaps, component.id, { cwd: '/work' })
      const sent = (calls.prompt[0] as { content: Array<{ text: string }> }).content[0]!.text
      expect(sent).toContain('DSH home: `/srv/dsh-home` (from `$DSH_HOME`)')
    } finally { vi.unstubAllEnvs() }
    vi.stubEnv('DSH_HOME', '')
    try {
      expect(portRuntime({ get: () => undefined } as never)).toEqual({ dshHome: join(homedir(), '.dsh'), dshHomeFromEnv: false })
    } finally { vi.unstubAllEnvs() }
  })

  it('serves harnessCompat.portBrief and portGap through the porter row', async () => {
    const { ctx, calls } = host()
    const apis = new Map<string, unknown>()
    const forge = {
      statePath: join(root, 'state', 'state.json'),
      provide: (name: string, api: unknown) => { apis.set(name, api); return () => { apis.delete(name) } },
      lookup: (name: string) => apis.get(name),
    }
    const stop = startPorter(ctx, forge as never)
    const remote = Object.create(HarnessRemoteService.prototype) as HarnessRemoteService
    Object.defineProperty(remote, 'forge', { value: forge })
    Object.defineProperty(remote, 'workbench', { value: { findPlugin: (id: string) => { if (id !== plugin.id) throw new Error(`no plugin ${id} is installed or discovered`); return { plugin, gaps } } } })

    const preview = await remote.portBrief({ pluginId: plugin.id, componentId: component.id, language: 'zh' }) as { markdown: string }
    expect(preview.markdown).toMatch(/^You are in DSH's creation mode/u)
    expect(preview.markdown).toContain('Talk to the user in Chinese')
    expect(preview.markdown).toContain('# Port "statusline" of claude-hud to DSH')
    expect(await remote.portGap({ pluginId: plugin.id, componentId: component.id, cwd: '/work', language: 'en' })).toEqual({ sessionId: 'session-1' })
    expect(calls.create).toEqual([{ cwd: '/work', agentPreset: 'cordis' }])
    // The first message is the protocol, then the brief; the session is named after the brief.
    const sent = (calls.prompt[0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(sent).toMatch(/^You are in DSH's creation mode[^]*## Protocol[^]*\n---\n\n# Port "statusline" of claude-hud to DSH/u)
    expect(sent).toContain('Talk to the user in English')
    expect(calls.rename).toEqual([{ sessionId: 'session-1', title: 'Port "statusline" of claude-hud to DSH' }])
    // The port session is recorded for the Gaps screen.
    expect(new PortSessions(forge.statePath).get(plugin.id, component.id)).toMatchObject({ sessionId: 'session-1', startedAt: expect.any(String) })

    await expect(remote.portGap({ pluginId: 'claude-code:gone', componentId: 'x' })).rejects.toMatchObject({ code: 'harness-forge/failed', message: 'no plugin claude-code:gone is installed or discovered', details: { operation: 'portGap' } })
    await expect(remote.portBrief({ pluginId: plugin.id })).rejects.toMatchObject({ message: 'componentId is required' })
    stop()
    // With the porter row off, porting is not offered.
    await expect(remote.portGap({ pluginId: plugin.id, componentId: component.id })).rejects.toMatchObject({ message: 'the Harness Forge porter row is off; turn it on in Plugin Manager' })
  })
})
