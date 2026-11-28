/**
 * Claude Code's instruction files in the system prompt, for what DSH's own
 * instruction loader (`@deepseek-ai/dsh-agent-instructions`) does not read:
 * `~/.claude/CLAUDE.md`, `.claude/CLAUDE.md`, the `@path` imports of every
 * `CLAUDE.md`, and Codex's global `AGENTS.md`. DSH reads `AGENTS.md`,
 * `CLAUDE.md` and their `.local.md` overlays from its project root down, so
 * those are not repeated here. The whole part yields when the Recollect plugin
 * (service `recollect`) runs: it owns instruction injection then.
 * @module @kirkchinese/harness-forge
 */
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { codexHome, loadInstructions, renderInstructions, type InstructionFile } from '@kirkchinese/harness-forge-core'
import { dshService } from '../dsh/host.js'
import type { ContextApi, ContextStatus } from '../forge/contract.js'
import type { HarnessForge } from '../forge/service.js'
import { messageOf } from '../shared/util.js'

/** The files DSH injects verbatim from its project root down to the working directory. */
const HOST_LOADS = ['CLAUDE.md', 'CLAUDE.local.md'] as const

/** The prompt text one workspace's files make: DSH's own loader caps each chain at this much too. */
const MAX_BYTES = 65_536

/** The DSH service whose presence makes this part yield. */
const YIELDS_TO = 'recollect' as const

interface WorkingDirectoryLike {
  readonly defaultDirectory?: string
  get(session: unknown): string | undefined
}

/** What a system-prompt assembly offers the section: the agent (or its scope) whose session is being prompted. */
interface Assembly {
  readonly agent?: { readonly session?: unknown }
  readonly scope?: { readonly session?: unknown }
}

export class ContextInstructions {
  private readonly reported = new Set<string>()

  constructor(private readonly ctx: Context, private readonly forge: HarnessForge) {}

  /** The plugin that owns instruction injection when it runs, else undefined. */
  yieldingTo(): string | undefined {
    return dshService(this.ctx, YIELDS_TO) === undefined ? undefined : YIELDS_TO
  }

  /** A mounted Codex user import carries the global instructions already; they are not added twice. */
  private codexMounted(): boolean {
    return this.forge.list().some(record => record.source === 'codex' && (record.outcomes ?? []).some(outcome => outcome.status === 'mounted' && outcome.componentId.endsWith(':other:agents-md')))
  }

  private load(cwd: string): { files: readonly InstructionFile[]; hostFiles: readonly { path: string; bytes: number }[]; stopped?: string } {
    const home = homedir()
    return loadInstructions({ cwd, home, codexHome: codexHome(home), hostLoads: HOST_LOADS, skipCodex: this.codexMounted() })
  }

  /** What the instructions of `cwd` are, for the workbench. */
  status(cwd: string | undefined): ContextStatus {
    const yielding = this.yieldingTo()
    if (yielding !== undefined) return { active: false, yieldingTo: yielding, files: [] }
    const directory = cwd ?? (dshService(this.ctx, 'workingDirectory') as WorkingDirectoryLike | undefined)?.defaultDirectory ?? process.cwd()
    const { files, hostFiles, stopped } = this.load(directory)
    return { active: true, files: files.map(file => ({ path: file.path, bytes: file.bytes })), hostFiles, ...(stopped !== undefined ? { stopped } : {}) }
  }

  /** The prompt text for one assembly: empty while yielding, and when a failure keeps it from being read. */
  text(assembly: Assembly): string {
    if (this.yieldingTo() !== undefined) return ''
    const directory = this.directoryOf(assembly)
    try {
      const { files, stopped } = this.load(directory)
      return renderInstructions(files, MAX_BYTES, stopped).text
    } catch (error: unknown) {
      // Once per directory: a step runs this again and again.
      if (!this.reported.has(directory)) {
        this.reported.add(directory)
        this.forge.fault('context', new Error(`instruction files of ${directory} could not be read: ${messageOf(error)}`))
      }
      return ''
    }
  }

  private directoryOf(assembly: Assembly): string {
    const service = dshService(this.ctx, 'workingDirectory') as WorkingDirectoryLike | undefined
    const session = assembly.agent?.session ?? assembly.scope?.session
    return (session === undefined ? undefined : service?.get(session)) ?? service?.defaultDirectory ?? process.cwd()
  }

  /** Add the section to every system prompt. Returns the disposer. */
  install(): () => void {
    const prompt = dshService(this.ctx, 'systemPrompt') as {
      section(section: { name: string; order: number; text: (context: Assembly) => string; interpolate?: boolean }): () => void
      getSectionOrder(name: string): number
    } | undefined
    if (prompt === undefined) return () => {}
    return prompt.section({
      name: 'harness-forge:instructions',
      order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') - 3,
      interpolate: false,
      text: assembly => this.text(assembly),
    })
  }

  api(): ContextApi {
    return { status: cwd => this.status(cwd) }
  }
}
