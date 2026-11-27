/**
 * The ledger with the skills, commands, agents, hooks and MCP rows started on
 * a minimal host, for tests that install plugins without DSH.
 */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessForge } from '../src/forge/service.js'
import { startAgents } from '../src/agents/row.js'
import { startCommands } from '../src/commands/row.js'
import { startHooks } from '../src/hooks/row.js'
import { startMcp } from '../src/mcp/row.js'
import { startSkills } from '../src/skills/row.js'
import type { ForeignSkillProvider } from '../src/skills/provider.js'
import { Workbench } from '../src/workbench/workbench.js'

type Host = { get(name: string): unknown }

export class TestHarness {
  readonly forge: HarnessForge
  readonly workbench: Workbench
  private readonly stops: Array<() => unknown>
  /** The skills row's provider, as DSH's skill registry holds it. */
  skillProvider: ForeignSkillProvider | undefined

  constructor(host: Host, statePath: string, dataRoot: string) {
    const ctx = {
      get: (name: string) => host.get(name),
      on: () => () => {},
      effect: <T>(run: () => T): T => run(),
      inject: () => ({ dispose() {} }),
      skills: { registerProvider: (create: (control: { signal: AbortSignal; invalidate(): void }) => unknown) => { this.skillProvider = create({ signal: new AbortController().signal, invalidate() {} }) as ForeignSkillProvider; return () => {} } },
    } as unknown as Context
    this.forge = new HarnessForge(ctx, statePath, dataRoot)
    this.workbench = new Workbench(this.forge)
    this.stops = [startSkills(ctx, this.forge, {}), startCommands(ctx, this.forge), startAgents(ctx, this.forge), startHooks(ctx, this.forge), startMcp(ctx, this.forge)]
  }

  get skills(): { listRoots(): readonly string[] } {
    return { listRoots: () => this.workbench.listSkillRoots() }
  }

  start(preload: readonly string[] = []): Promise<void> { return this.forge.start(preload) }
  install(root: string, source?: string) { return this.forge.install(root, source) }
  uninstall(id: string) { return this.forge.uninstall(id) }
  undo(receipt: string) { return this.forge.undo(receipt) }
  list() { return this.forge.list() }
  listSkillRoots() { return this.workbench.listSkillRoots() }
  capabilities() { return this.workbench.capabilities() }
  saveSettings(input: Parameters<Workbench['saveSettings']>[0]) { return this.workbench.saveSettings(input) }
  retryFailed(): void { this.forge.ledger.reapply() }

  /** Stop the skills row alone, as when the person turns it off. */
  async stopSkills(): Promise<void> {
    await this.stops[0]?.()
    this.stops[0] = () => {}
  }

  async dispose(): Promise<void> {
    await this.forge.dispose()
    for (const stop of this.stops.splice(0)) await stop()
  }
}
